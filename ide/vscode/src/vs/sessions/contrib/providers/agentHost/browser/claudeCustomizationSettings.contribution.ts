/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Claude row of the Agents window's Customizations, next to Codex's
 *  (codexCustomizationSettings.contribution.ts). It edits Claude Code's own global settings,
 *  ~/.claude/settings.json: the default model (`model`), the permission mode
 *  (`permissions.defaultMode`) and the allowed tools (`permissions.allow`). Every change is written
 *  at once with a JSON edit, so the rest of the file (hooks, env, comments, order) stays as it was;
 *  sessions started afterwards read it. Sub-agent effort is Dispatch's: the effort written into the
 *  sub-agent definitions in ~/.dispatch/agents that set none of their own (dispatch-bridge's
 *  dispatch.agentsEffort, `dispatch agents effort`); ~/.claude/agents links there.
 *--------------------------------------------------------------------------------------------*/

import '../../../../../workbench/contrib/chat/browser/aiCustomization/media/agentGlobalConfigurationSettings.css';
import './media/claudeCustomizationSettings.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { parse, ParseError } from '../../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { aiCustomizationManagementSectionRegistry } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';

/** The model picker: Claude Code's aliases, so a new model of the family needs no update here. */
const MODELS: { value: string; label: string }[] = [
	{ value: '', label: localize('claudeSettings.model.default', "Claude Code default") },
	{ value: 'fable', label: 'Fable' },
	{ value: 'opus', label: 'Opus' },
	{ value: 'sonnet', label: 'Sonnet' },
	{ value: 'haiku', label: 'Haiku' },
];

const PERMISSION_MODES: { value: string; label: string }[] = [
	// Dispatch IDE: the names Settings gives these levels (dispatchPermissionNames.ts, task-o2r5g)
	{ value: 'default', label: dispatchAlwaysAsk() },
	{ value: 'acceptEdits', label: dispatchAskRisky() },
	{ value: 'plan', label: localize('claudeSettings.mode.plan', "Plan only") },
	{ value: 'auto', label: localize('claudeSettings.mode.auto', "Auto") },
	{ value: 'dontAsk', label: localize('claudeSettings.mode.dontAsk', "Don't ask (deny what isn't allowed)") },
	{ value: 'bypassPermissions', label: dispatchFullAuto() },
];

const EFFORTS: { value: string; label: string }[] = [
	{ value: 'low', label: localize('claudeSettings.effort.low', "Low") },
	{ value: 'medium', label: localize('claudeSettings.effort.medium', "Medium") },
	{ value: 'high', label: localize('claudeSettings.effort.high', "High") },
	{ value: 'max', label: localize('claudeSettings.effort.max', "Max") },
];

interface IAgentsEffort {
	readonly default_effort: string;
	readonly agents?: readonly { name: string; effort: string; source: string }[];
}

/** One line: what the default is for, and which sub-agents set their own. */
export function subAgentEffortDescription(state: IAgentsEffort | undefined): string {
	const base = localize('claudeSettings.effortDescription', "For sub-agents that don't set their own effort.");
	const own = (state?.agents ?? []).filter(a => a.source === 'own').map(a => a.name);
	if (!own.length) {
		return base;
	}
	const names = own.length === 1 ? own[0]
		: own.length === 2 ? localize('claudeSettings.effortTwo', "{0} and {1}", own[0], own[1])
			: localize('claudeSettings.effortMany', "{0} and {1} more", own.slice(0, 2).join(', '), own.length - 2);
	return `${base} ${own.length === 1 ? localize('claudeSettings.effortOwnOne', "{0} sets its own.", names) : localize('claudeSettings.effortOwn', "{0} set their own.", names)}`;
}

/** The family a `model` value belongs to: `claude-fable-5-1[1m]` → fable. */
export function claudeModelFamily(model: unknown): string | undefined {
	if (typeof model !== 'string' || !model.trim()) {
		return undefined;
	}
	return /(fable|opus|sonnet|haiku)/i.exec(model)?.[1].toLowerCase();
}

/** The `model` value for a pick: the alias, keeping the 1M context suffix the old value had. */
export function claudeModelValue(pick: string, previous: unknown): string | undefined {
	if (!pick) {
		return undefined;
	}
	const longContext = typeof previous === 'string' && /\[1m\]$/i.test(previous.trim()) && pick !== 'haiku';
	return longContext ? `${pick}[1m]` : pick;
}

interface IClaudeSettings {
	model?: unknown;
	permissions?: { defaultMode?: unknown; allow?: unknown };
}

class ClaudeSettingsWidget extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly container: HTMLElement;
	private readonly file: URI;
	private text = '';
	private settings: IClaudeSettings = {};
	private problem: string | undefined;
	private writing = Promise.resolve();
	private pendingTool = '';
	private focusTarget: (() => void) | undefined;
	private effort: IAgentsEffort | undefined;

	constructor(
		parent: HTMLElement,
		@IFileService private readonly fileService: IFileService,
		@IPathService pathService: IPathService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.container = DOM.append(parent, DOM.$('.agent-global-configuration-settings.claude-settings'));
		this.file = joinPath(pathService.userHome({ preferLocal: true }), '.claude', 'settings.json');
		this._register(this.fileService.watch(this.file));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.contains(this.file)) {
				void this.load();
			}
		}));
		void this.load();
		void this.loadEffort();
	}

	/** Sub-agent effort through dispatch-bridge; without the bridge the row says so and stays put. */
	private async loadEffort(level?: string): Promise<void> {
		try {
			const answer = await this.commandService.executeCommand<{ ok: boolean; result?: IAgentsEffort; error?: string }>('dispatch.agentsEffort', level);
			if (answer?.ok && answer.result) {
				this.effort = answer.result;
			} else if (level) {
				this.notificationService.error(localize('claudeSettings.effortFailed', "Could not save the sub-agent effort: {0}", answer?.error ?? ''));
			}
		} catch (error) {
			if (level) {
				this.notificationService.error(localize('claudeSettings.effortFailed', "Could not save the sub-agent effort: {0}", String(error)));
			}
		}
		this.render();
	}

	layout(): void { this.container.classList.toggle('narrow', this.container.clientWidth < 560); }
	focus(): void { this.focusTarget?.(); }

	private async load(): Promise<void> {
		try {
			this.text = (await this.fileService.readFile(this.file)).value.toString();
		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.problem = localize('claudeSettings.unreadable', "Could not read {0}: {1}", this.file.fsPath, String(error));
				this.render();
				return;
			}
			this.text = '';
		}
		const errors: ParseError[] = [];
		const value = this.text.trim() ? parse(this.text, errors, { allowTrailingComma: true }) : {};
		if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
			this.problem = localize('claudeSettings.invalid', "settings.json is not valid JSON right now. Open it and fix it, then this page follows.");
			this.settings = {};
		} else {
			this.problem = undefined;
			this.settings = value as IClaudeSettings;
		}
		this.render();
	}

	/** One JSON edit, written at once; edits queue so two quick changes both land. */
	private update(path: (string | number)[], value: unknown): Promise<void> {
		this.writing = this.writing.then(async () => {
			const indent = /\n(\t| +)"/.exec(this.text)?.[1] ?? '  ';
			const base = this.text.trim() ? this.text : '{}\n';
			const edits = setProperty(base, path, value, { insertSpaces: indent !== '\t', tabSize: indent === '\t' ? 4 : indent.length, eol: '\n' });
			const next = applyEdits(base, edits);
			await this.fileService.writeFile(this.file, VSBuffer.fromString(next));
			this.text = next;
			const errors: ParseError[] = [];
			this.settings = parse(next, errors, { allowTrailingComma: true }) as IClaudeSettings;
		}).catch(error => this.notificationService.error(localize('claudeSettings.writeFailed', "Could not save {0}: {1}", this.file.fsPath, String(error))));
		return this.writing;
	}

	private allowed(): string[] {
		const allow = this.settings.permissions?.allow;
		return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === 'string') : [];
	}

	private render(): void {
		this.renderDisposables.clear();
		DOM.clearNode(this.container);
		this.focusTarget = undefined;
		const content = DOM.append(this.container, DOM.$('.agent-global-configuration-settings-content'));
		DOM.append(content, DOM.$('h1')).textContent = localize('claudeSettings.title', "Claude");
		DOM.append(content, DOM.$('p.agent-global-configuration-settings-intro')).textContent = localize('claudeSettings.intro', "Claude Code's global settings in ~/.claude/settings.json. Changes are saved at once; new sessions use them.");
		if (this.problem) {
			const status = DOM.append(content, DOM.$('.agent-global-configuration-settings-status.error'));
			DOM.append(status, DOM.$(ThemeIcon.asCSSSelector(Codicon.warning)));
			DOM.append(status, DOM.$('span')).textContent = this.problem;
			this.renderFile(content);
			return;
		}

		const defaults = DOM.append(content, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(defaults, DOM.$('h2')).textContent = localize('claudeSettings.defaults', "Defaults");
		const card = DOM.append(defaults, DOM.$('.agent-global-configuration-settings-card'));

		const model = this.settings.model;
		const family = claudeModelFamily(model) ?? '';
		const modelOptions = [...MODELS];
		if (typeof model === 'string' && model.trim() && !family) {
			modelOptions.push({ value: model, label: model });
		}
		const modelIndex = Math.max(0, modelOptions.findIndex(o => o.value === (family || (typeof model === 'string' ? model : ''))));
		this.renderSelect(card, localize('claudeSettings.model', "Default model"), localize('claudeSettings.modelDescription', "The model new sessions start with. Now: {0}", typeof model === 'string' && model ? model : localize('claudeSettings.modelUnset', "not set")), modelOptions, modelIndex, pick => {
			if (pick === (family || model)) {
				return;
			}
			void this.update(['model'], claudeModelValue(pick, model));
		});

		const mode = this.settings.permissions?.defaultMode;
		const modeOptions = [...PERMISSION_MODES];
		if (typeof mode === 'string' && !modeOptions.some(o => o.value === mode)) {
			modeOptions.push({ value: mode, label: mode });
		}
		const modeIndex = Math.max(0, modeOptions.findIndex(o => o.value === (typeof mode === 'string' ? mode : 'default')));
		this.renderSelect(card, localize('claudeSettings.mode', "Permission mode"), localize('claudeSettings.modeDescription', "What Claude may do without asking you first."), modeOptions, modeIndex, pick => {
			if (pick === (typeof mode === 'string' ? mode : 'default')) {
				return;
			}
			void this.update(['permissions', 'defaultMode'], pick);
		});

		const effort = this.effort?.default_effort ?? 'high';
		this.renderSelect(card, localize('claudeSettings.effort', "Sub-agent effort"), subAgentEffortDescription(this.effort), EFFORTS, Math.max(0, EFFORTS.findIndex(o => o.value === effort)), pick => {
			if (pick === effort) {
				return;
			}
			void this.loadEffort(pick);
		});

		this.renderAllowed(content);
		this.renderFile(content);
	}

	private renderSelect(card: HTMLElement, label: string, description: string, options: { value: string; label: string }[], selected: number, onPick: (value: string) => void): void {
		const row = DOM.append(card, DOM.$('.agent-global-configuration-settings-row'));
		const labels = DOM.append(row, DOM.$('.agent-global-configuration-settings-labels'));
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-label')).textContent = label;
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-description')).textContent = description;
		const selectContainer = DOM.append(row, DOM.$('.agent-global-configuration-settings-select'));
		const select = this.renderDisposables.add(new SelectBox(options.map(o => ({ text: o.label })), selected, this.contextViewService, { ...defaultSelectBoxStyles }, { ariaLabel: label }));
		select.render(selectContainer);
		this.focusTarget ??= () => select.focus();
		this.renderDisposables.add(select.onDidSelect(e => onPick(options[e.index].value)));
	}

	private renderAllowed(parent: HTMLElement): void {
		const section = DOM.append(parent, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('claudeSettings.allowed', "Allowed tools");
		DOM.append(section, DOM.$('p.agent-global-configuration-settings-section-description')).textContent = localize('claudeSettings.allowedDescription', "Tools and commands Claude runs without asking, such as Read, WebSearch or Bash(npm test:*).");
		const card = DOM.append(section, DOM.$('.agent-global-configuration-settings-card.claude-settings-tools'));
		const allow = this.allowed();
		if (!allow.length) {
			DOM.append(card, DOM.$('.claude-settings-tools-empty')).textContent = localize('claudeSettings.allowedEmpty', "Nothing yet: Claude asks before every tool.");
		}
		for (const tool of allow) {
			const row = DOM.append(card, DOM.$('.claude-settings-tool'));
			DOM.append(row, DOM.$('span.claude-settings-tool-name')).textContent = tool;
			const remove = this.renderDisposables.add(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: localize('claudeSettings.remove', "Remove {0}", tool), ariaLabel: localize('claudeSettings.remove', "Remove {0}", tool) }));
			remove.element.classList.add('claude-settings-tool-remove');
			remove.label = `$(${Codicon.close.id})`;
			this.renderDisposables.add(remove.onDidClick(() => void this.update(['permissions', 'allow'], this.allowed().filter(t => t !== tool))));
		}
		const add = DOM.append(section, DOM.$('.claude-settings-tool-add'));
		const input = this.renderDisposables.add(new InputBox(add, this.contextViewService, { placeholder: localize('claudeSettings.addPlaceholder', "Tool or rule, e.g. Bash(git status:*)"), ariaLabel: localize('claudeSettings.addLabel', "Tool to allow"), inputBoxStyles: defaultInputBoxStyles }));
		input.value = this.pendingTool;
		this.renderDisposables.add(input.onDidChange(v => { this.pendingTool = v; button.enabled = !!v.trim(); }));
		const button = this.renderDisposables.add(new Button(add, { ...defaultButtonStyles, secondary: true }));
		button.label = localize('claudeSettings.add', "Add");
		button.enabled = !!this.pendingTool.trim();
		const submit = () => {
			const tool = input.value.trim();
			if (!tool) {
				return;
			}
			this.pendingTool = '';
			const list = this.allowed();
			if (!list.includes(tool)) {
				void this.update(['permissions', 'allow'], [...list, tool]).then(() => this.render());
			} else {
				input.value = '';
			}
		};
		this.renderDisposables.add(button.onDidClick(submit));
		this.renderDisposables.add(DOM.addDisposableListener(input.inputElement, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		}));
	}

	private renderFile(parent: HTMLElement): void {
		const section = DOM.append(parent, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('claudeSettings.file', "Configuration file");
		DOM.append(section, DOM.$('p.agent-global-configuration-settings-section-description')).textContent = localize('claudeSettings.fileDescription', "Hooks, environment and everything else Claude Code reads live in the same file.");
		const button = this.renderDisposables.add(new Button(section, { ...defaultButtonStyles, secondary: true }));
		button.label = localize('claudeSettings.open', "Open settings.json");
		this.renderDisposables.add(button.onDidClick(() => this.editorService.openEditor({ resource: this.file, options: { pinned: true } })));
	}
}

// Dispatch IDE (patches/515-customizations.patch): the Claude Code version and its Update button
// as the first row. The import sits here so that patch leaves the rest of this file alone.
import { withEngineVersion } from './engineVersionRow.js';
import { dispatchAlwaysAsk, dispatchAskRisky, dispatchFullAuto } from '../../../../../platform/agentHost/common/dispatchPermissionNames.js';

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.HarnessSettings,
	label: localize('claudeCustomizationSettings.navigationLabel', "Claude"),
	icon: Codicon.claude,
	description: localize('claudeCustomizationSettings.navigationDescription', "Configure global behavior for this harness."),
	supportsHarness: harnessId => harnessId === SessionType.AgentHostClaude,
	create: (instantiationService, container) => withEngineVersion(instantiationService, container, 'claude', instantiationService.createInstance(ClaudeSettingsWidget, container)),
});
