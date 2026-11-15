/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the OpenCode row of the Agents window's Customizations, next to Claude's and Codex's.
 *  OpenCode's own settings, laid out like the Claude page: the default model (`model` in OpenCode's
 *  global config, ~/.config/opencode/opencode.json), Dispatch's OpenCode plugin, the providers OpenCode
 *  gets its models from (where each key comes from, never the key, and the allowance DeepSeek and Zhipu
 *  report), and the config file itself.
 *
 *  What OpenCode has comes from dispatch-bridge (`dispatch.opencodeStatus`, opencodeStatus.ts); the
 *  model counts and names from the OpenCode harness's own model list. The default model is one JSON
 *  edit of the config file, like the Claude page's, picked in the same grouped model menu the chat
 *  input has. Adding a provider is OpenCode's own `opencode auth login` in a terminal.
 *--------------------------------------------------------------------------------------------*/

import '../../../../../workbench/contrib/chat/browser/aiCustomization/media/agentGlobalConfigurationSettings.css';
import './media/claudeCustomizationSettings.css';
import './media/opencodeCustomizationSettings.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { parse, ParseError } from '../../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { AnchorAlignment } from '../../../../../base/common/layout.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, withActionWidgetDropdownMotion } from '../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { StateType } from '../../../../../platform/update/common/update.js';
import { aiCustomizationManagementSectionRegistry } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { openCodeIcon } from '../../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { fetchOpenCodeStatus, IOpenCodeProvider, IOpenCodeStatus, lastOpenCodeStatus, OPENCODE_ADD_PROVIDER_COMMAND, OPENCODE_INSTALL_PLUGIN_CLI, OPENCODE_INSTALL_PLUGIN_COMMAND, openCodePlan, openCodeQuotaLines, openCodeSourceText } from '../../../../../workbench/contrib/chat/browser/agentSessions/opencodeStatus.js';
import { buildModelPickerItems, getModelPickerAccessibilityProvider, ModelPickerSection } from '../../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerItems.js';
import { AICustomizationManagementSection } from '../../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IChatEntitlementService } from '../../../../../workbench/services/chat/common/chatEntitlementService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { withEngineVersion } from './engineVersionRow.js';

type PluginState = { kind: 'idle' } | { kind: 'installing' } | { kind: 'failed' };

/** "4 models", "1 model", "No models listed". */
export function openCodeModelCount(n: number): string {
	return n === 0 ? localize('opencodeSettings.noModels', "No models listed")
		: n === 1 ? localize('opencodeSettings.oneModel', "1 model")
			: localize('opencodeSettings.models', "{0} models", n);
}

/** A provider row's grey line: "ZHIPU_API_KEY from the environment · Lite plan · 4 models". */
export function openCodeProviderDescription(provider: IOpenCodeProvider, models: number | undefined): string {
	const plan = openCodePlan(provider);
	return [
		openCodeSourceText(provider.sources[0]),
		plan ? localize('opencodeSettings.plan', "{0} plan", plan) : undefined,
		models === undefined ? undefined : openCodeModelCount(models),
	].filter(Boolean).join(' · ');
}

class OpenCodeSettingsWidget extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly watchDisposables = this._register(new DisposableStore());
	private readonly container: HTMLElement;
	private status: IOpenCodeStatus | undefined = lastOpenCodeStatus();
	private loaded = false;
	private watchedFiles = '';
	private configText: string | undefined;
	private configInvalid = false;
	private writing = Promise.resolve();
	private plugin: PluginState = { kind: 'idle' };
	private addingProvider = false;
	private focusTarget: (() => void) | undefined;
	private installPoll: ReturnType<typeof setInterval> | undefined;

	constructor(
		parent: HTMLElement,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
		this.container = DOM.append(parent, DOM.$('.agent-global-configuration-settings.claude-settings.opencode-settings'));
		this._register(this.languageModelsService.onDidChangeLanguageModels(vendor => {
			if (vendor === SessionType.AgentHostOpenCode) {
				this.render();
			}
		}));
		this._register(toDisposable(() => this.stopInstallPoll()));
		this.render();
		void this.refresh(5);
	}

	layout(): void { this.container.classList.toggle('narrow', this.container.clientWidth < 560); }
	focus(): void { this.focusTarget?.(); }

	/** What OpenCode has now (the bridge), then the config file the default model lives in. */
	private async refresh(attempts = 1): Promise<void> {
		const status = await fetchOpenCodeStatus(this.commandService, { attempts, isDisposed: () => this._store.isDisposed });
		if (this._store.isDisposed) {
			return;
		}
		this.loaded = true;
		if (status) {
			this.status = status;
		}
		this.watch();
		await this.readConfig();
		// not installed yet: the version row's Install runs in the background; look again until it is there
		if (this.status && !this.status.installed) {
			this.installPoll ??= setInterval(() => void this.refresh(), 5000);
		} else {
			this.stopInstallPoll();
		}
		this.render();
	}

	private stopInstallPoll(): void {
		if (this.installPoll) {
			clearInterval(this.installPoll);
			this.installPoll = undefined;
		}
	}

	/** The config file (the default model, the file button) and OpenCode's credentials (the providers). */
	private watch(): void {
		const config = this.status?.config.path;
		const auth = this.status?.auth_path;
		const key = `${config}\n${auth}`;
		if (key === this.watchedFiles) {
			return;
		}
		this.watchedFiles = key;
		this.watchDisposables.clear();
		const files = [config, auth].filter((f): f is string => !!f).map(f => URI.file(f));
		for (const file of files) {
			this.watchDisposables.add(this.fileService.watch(file));
		}
		this.watchDisposables.add(this.fileService.onDidFilesChange(e => {
			if (config && e.contains(URI.file(config))) {
				void this.readConfig().then(() => this.render());
				void this.refresh();
			} else if (auth && e.contains(URI.file(auth))) {
				void this.refresh();
			}
		}));
	}

	private configUri(): URI | undefined {
		return this.status?.config.path ? URI.file(this.status.config.path) : undefined;
	}

	private configName(): string {
		return this.status?.config.path ? basename(this.status.config.path) : 'opencode.json';
	}

	private async readConfig(): Promise<void> {
		const file = this.configUri();
		if (!file) {
			return;
		}
		try {
			this.configText = (await this.fileService.readFile(file)).value.toString();
		} catch (error) {
			this.configText = undefined;
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this.configInvalid = true;
				return;
			}
		}
		const errors: ParseError[] = [];
		const value = this.configText?.trim() ? parse(this.configText, errors, { allowTrailingComma: true }) : {};
		this.configInvalid = errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value);
	}

	/** The `model` the config file has, else the merged one OpenCode reports (another config file's). */
	private currentModel(): string | undefined {
		if (this.configText?.trim() && !this.configInvalid) {
			const value = parse(this.configText, [], { allowTrailingComma: true }) as { model?: unknown };
			if (typeof value?.model === 'string' && value.model.trim()) {
				return value.model.trim();
			}
		}
		return this.status?.default_model || undefined;
	}

	/** One JSON edit, written at once; edits queue so two quick changes both land. */
	private update(path: string[], value: unknown): Promise<void> {
		const file = this.configUri();
		if (!file) {
			return Promise.resolve();
		}
		this.writing = this.writing.then(async () => {
			await this.readConfig();
			if (this.configInvalid) {
				return;
			}
			const text = this.configText ?? '';
			const indent = /\n(\t| +)"/.exec(text)?.[1] ?? '  ';
			const base = text.trim() ? text : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
			const edits = setProperty(base, path, value, { insertSpaces: indent !== '\t', tabSize: indent === '\t' ? 4 : indent.length, eol: '\n' });
			const next = applyEdits(base, edits);
			await this.fileService.writeFile(file, VSBuffer.fromString(next));
			this.configText = next;
			this.render();
		}).catch(error => this.notificationService.error(localize('opencodeSettings.writeFailed', "Could not save {0}: {1}", file.fsPath, String(error))));
		return this.writing;
	}

	/** The OpenCode harness's models, in its order (the default model's provider first). */
	private models(): ILanguageModelChatMetadataAndIdentifier[] {
		const out: ILanguageModelChatMetadataAndIdentifier[] = [];
		for (const identifier of this.languageModelsService.getLanguageModelIds()) {
			const metadata = this.languageModelsService.lookupLanguageModel(identifier);
			if (metadata?.vendor === SessionType.AgentHostOpenCode) {
				out.push({ identifier, metadata });
			}
		}
		return out;
	}

	private render(): void {
		this.renderDisposables.clear();
		DOM.clearNode(this.container);
		this.focusTarget = undefined;
		const content = DOM.append(this.container, DOM.$('.agent-global-configuration-settings-content'));
		DOM.append(content, DOM.$('h1')).textContent = localize('opencodeSettings.title', "OpenCode");
		DOM.append(content, DOM.$('p.agent-global-configuration-settings-intro')).textContent = this.status && !this.status.installed
			? localize('opencodeSettings.introNotInstalled', "Its settings show up here once OpenCode is installed.")
			: localize('opencodeSettings.intro', "OpenCode's own settings in ~/.config/opencode/opencode.json. Changes are saved at once; new sessions use them.");

		// the first card: the version row (engineVersionRow.ts puts itself on top), then the defaults
		const defaults = DOM.append(content, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(defaults, DOM.$('h2')).textContent = localize('opencodeSettings.defaults', "Defaults");
		const card = DOM.append(defaults, DOM.$('.agent-global-configuration-settings-card'));
		const status = this.status;
		if (!status) {
			if (this.loaded) {
				// no bridge: the version row says it could not check; nothing else to show
				const note = DOM.append(content, DOM.$('.agent-global-configuration-settings-status'));
				DOM.append(note, DOM.$('span')).textContent = localize('opencodeSettings.noBridge', "Dispatch could not read OpenCode's settings. Reload the window and try again.");
			}
			return;
		}
		if (!status.installed) {
			return; // only the version row: "Not installed. Install it to start sessions." and Install
		}
		// Dispatch IDE (opencode-guarded-folders): why OpenCode may stop at start with no models, and what to do
		if (status.protected_text) {
			const note = DOM.append(defaults, DOM.$('.agent-global-configuration-settings-status.error.opencode-settings-guarded'));
			DOM.append(note, DOM.$(ThemeIcon.asCSSSelector(Codicon.warning)));
			DOM.append(note, DOM.$('span')).textContent = status.protected_text;
			defaults.insertBefore(note, card);
		}
		this.renderDefaultModel(card);
		this.renderPlugin(card);
		this.renderProviders(content, status);
		this.renderFile(content, status);
	}

	private row(card: HTMLElement, label: string): { row: HTMLElement; description: HTMLElement; action: HTMLElement } {
		const row = DOM.append(card, DOM.$('.agent-global-configuration-settings-row'));
		const labels = DOM.append(row, DOM.$('.agent-global-configuration-settings-labels'));
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-label')).textContent = label;
		const description = DOM.append(labels, DOM.$('.agent-global-configuration-settings-description'));
		const action = DOM.append(row, DOM.$('.agent-global-configuration-settings-action'));
		return { row, description, action };
	}

	private renderDefaultModel(card: HTMLElement): void {
		const { row, description, action } = this.row(card, localize('opencodeSettings.model', "Default model"));
		row.classList.add('opencode-settings-model-row');
		const models = this.models();
		const current = this.currentModel();
		const listed = current ? models.find(m => m.metadata.id === current) : undefined;
		const provider = listed?.metadata.modelGroup?.label;
		const name = this.configName();
		let buttonLabel: string;
		if (this.configInvalid) {
			description.textContent = localize('opencodeSettings.modelInvalid', "{0} isn't valid JSON. Fix it with Open {0} below.", name);
			buttonLabel = listed?.metadata.name ?? localize('opencodeSettings.modelUnavailable', "Unavailable");
		} else if (!current) {
			description.textContent = localize('opencodeSettings.modelUnset', "Not set: OpenCode picks its own. Pick one to write it to {0}.", name);
			buttonLabel = localize('opencodeSettings.modelDefault', "OpenCode default");
		} else if (listed) {
			description.textContent = provider
				? localize('opencodeSettings.modelNowProvider', "The model new sessions start with. Now: {0} · {1}", listed.metadata.name, provider)
				: localize('opencodeSettings.modelNow', "The model new sessions start with. Now: {0}", listed.metadata.name);
			buttonLabel = listed.metadata.name;
		} else if (models.length) {
			description.textContent = localize('opencodeSettings.modelMissing', "Not available now. Add its provider's key, or pick another model.");
			buttonLabel = current;
		} else {
			// the harness has not listed its models yet
			description.textContent = localize('opencodeSettings.modelNowRaw', "The model new sessions start with. Now: {0}", current);
			buttonLabel = current;
		}
		// closed, it is drawn like the page's selects (the Claude page's Default model); open, it is the
		// chat input's grouped, searchable model menu, which a select cannot be
		const control = DOM.append(action, DOM.$<HTMLButtonElement>('button.opencode-settings-model-select'));
		control.type = 'button';
		control.title = buttonLabel;
		control.setAttribute('aria-label', localize('opencodeSettings.modelAria', "Default model, {0}", buttonLabel));
		control.setAttribute('aria-haspopup', 'listbox');
		DOM.append(control, DOM.$('span.opencode-settings-model-name')).textContent = buttonLabel;
		control.append(renderIcon(Codicon.chevronDown));
		control.disabled = this.configInvalid || models.length === 0;
		this.renderDisposables.add(DOM.addDisposableListener(control, DOM.EventType.CLICK, () => this.showModelMenu(control, models, current)));
		this.focusTarget ??= () => control.focus();
	}

	/** The chat input's own model menu (current and recent on top, the rest by provider), "OpenCode default" first. */
	private showModelMenu(anchor: HTMLElement, models: ILanguageModelChatMetadataAndIdentifier[], current: string | undefined): void {
		if (this.actionWidgetService.isVisible) {
			this.actionWidgetService.hide();
			return;
		}
		const pick = (value: string | undefined) => {
			if (value !== current) {
				void this.update(['model'], value);
			}
		};
		const selected = current ? models.find(m => m.metadata.id === current) : undefined;
		const modelItems = buildModelPickerItems({
			models,
			selectedModelId: selected?.identifier,
			recentModelIds: this.languageModelsService.getRecentlyUsedModelIds(),
			pinnedModelIds: [],
			controlModels: {},
			currentVSCodeVersion: this.productService.version,
			updateStateType: StateType.Idle,
			manageSettingsUrl: undefined,
			manageModelsAction: undefined,
			chatEntitlementService: this.chatEntitlementService,
			languageModelsService: this.languageModelsService,
			openerService: this.openerService,
			presentation: {
				useGroupedModelPicker: true,
				showUnavailableFeatured: false,
				showFeatured: false,
				showAutoModel: false,
				restrictedMode: false,
				setupRequired: false,
				showManageModelsInSetupRequired: false,
				isUBB: false,
			},
			actions: {
				onSelect: model => pick(model.metadata.id),
				onTogglePin: undefined,
				onConfigure: undefined,
				onRequestTrust: undefined,
				onRequestSetup: undefined,
			},
		});
		const defaultLabel = localize('opencodeSettings.modelDefault', "OpenCode default");
		const defaultAction: IActionWidgetDropdownAction = {
			id: 'opencode.defaultModel.unset',
			enabled: true,
			checked: !current,
			class: undefined,
			tooltip: localize('opencodeSettings.modelDefaultTooltip', "Leave the choice to OpenCode"),
			label: defaultLabel,
			run: () => pick(undefined),
		};
		const items: IActionListItem<IActionWidgetDropdownAction>[] = [{
			item: defaultAction,
			kind: ActionListItemKind.Action,
			label: defaultLabel,
			group: { title: '', icon: ThemeIcon.fromId(!current ? Codicon.check.id : Codicon.blank.id) },
			hideIcon: false,
		}];
		if (modelItems.length) {
			items.push({ kind: ActionListItemKind.Separator }, ...modelItems);
		}
		const hovers = new DisposableStore();
		for (const item of items) {
			if (item.hover?.disposable) {
				hovers.add(item.hover.disposable);
			}
		}
		this.actionWidgetService.show<IActionWidgetDropdownAction>(
			'opencodeDefaultModel',
			false,
			items,
			{
				onSelect: action => {
					this.actionWidgetService.hide();
					action.run();
				},
				onHide: () => {
					hovers.dispose();
					if (anchor.isConnected) {
						anchor.focus();
					}
				},
			},
			anchor,
			undefined,
			[],
			getModelPickerAccessibilityProvider(true),
			withActionWidgetDropdownMotion({
				className: 'chat-model-picker-dropdown',
				showFilter: true,
				filterPlaceholder: localize('opencodeSettings.searchModels', "Search models"),
				focusFilterOnOpen: true,
				filterAsCombobox: true,
				collapsedByDefault: new Set([ModelPickerSection.Other]),
				minWidth: 280,
				anchorAlignment: AnchorAlignment.RIGHT,
			}),
		);
	}

	private renderPlugin(card: HTMLElement): void {
		const { row, description, action } = this.row(card, localize('opencodeSettings.plugin', "Dispatch plugin"));
		row.classList.add('engine-version-row');
		const plugin = this.status!.plugin;
		let button: string | undefined;
		if (this.plugin.kind === 'installing') {
			description.append(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')), ' ', localize('opencodeSettings.pluginInstalling', "Installing…"));
			button = localize('opencodeSettings.pluginInstalling', "Installing…");
		} else if (this.plugin.kind === 'failed') {
			description.append(localize('opencodeSettings.pluginFailed', "Install failed. Run"), ' ');
			DOM.append(description, DOM.$('code.engine-version-command')).textContent = OPENCODE_INSTALL_PLUGIN_CLI;
			description.append(localize('opencodeSettings.pluginInTerminal', " in a terminal."));
			button = localize('opencodeSettings.pluginInstall', "Install");
		} else if (plugin.installed && plugin.current) {
			description.textContent = localize('opencodeSettings.pluginInstalled', "Installed. OpenCode's to-do list shows up as the session's plan, and its shell commands are tied to the session.");
		} else if (plugin.installed) {
			description.textContent = localize('opencodeSettings.pluginOutdated', "Installed, but not the one this Dispatch comes with. Update it to keep the plan and the session in step.");
			button = localize('opencodeSettings.pluginUpdate', "Update");
		} else {
			description.textContent = localize('opencodeSettings.pluginMissing', "Not installed. Shows OpenCode's to-do list as the session's plan and ties its shell commands to the session.");
			button = localize('opencodeSettings.pluginInstall', "Install");
		}
		if (!button) {
			action.style.display = 'none';
			return;
		}
		const b = this.renderDisposables.add(new Button(action, { ...defaultButtonStyles, secondary: true }));
		b.label = button;
		b.enabled = this.plugin.kind !== 'installing';
		this.renderDisposables.add(b.onDidClick(() => void this.installPlugin()));
	}

	private async installPlugin(): Promise<void> {
		if (this.plugin.kind === 'installing') {
			return;
		}
		this.plugin = { kind: 'installing' };
		this.render();
		let ok = false;
		try {
			const answer = await this.commandService.executeCommand<{ path?: string; skipped?: string }>(OPENCODE_INSTALL_PLUGIN_COMMAND);
			ok = !!answer?.path && !answer.skipped;
		} catch {
			ok = false;
		}
		if (this._store.isDisposed) {
			return;
		}
		this.plugin = ok ? { kind: 'idle' } : { kind: 'failed' };
		if (ok) {
			await this.refresh();
		} else {
			this.render();
		}
	}

	private renderProviders(parent: HTMLElement, status: IOpenCodeStatus): void {
		const section = DOM.append(parent, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('opencodeSettings.providers', "Providers");
		DOM.append(section, DOM.$('p.agent-global-configuration-settings-section-description')).textContent = localize('opencodeSettings.providersDescription', "Where OpenCode gets its models. Keys stay in OpenCode's auth.json; this page never shows them.");
		const card = DOM.append(section, DOM.$('.agent-global-configuration-settings-card.opencode-settings-providers'));
		const models = this.models();
		const counts = new Map<string, number>();
		for (const m of models) {
			const provider = m.metadata.id.split('/')[0];
			counts.set(provider, (counts.get(provider) ?? 0) + 1);
		}
		const providers = [...status.providers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
		if (!providers.length) {
			DOM.append(card, DOM.$('.claude-settings-tools-empty')).textContent = localize('opencodeSettings.providersEmpty', "No providers yet. Add one to get models.");
		}
		for (const provider of providers) {
			const { row, description, action } = this.row(card, provider.name);
			row.classList.add('opencode-settings-provider');
			description.textContent = openCodeProviderDescription(provider, models.length ? counts.get(provider.id) ?? 0 : undefined);
			const sharesWith = provider.same_quota_as ? status.providers.find(p => p.id === provider.same_quota_as) : undefined;
			const lines = sharesWith
				? [localize('opencodeSettings.sharesLimits', "Shares limits with {0}", sharesWith.name)]
				: openCodeQuotaLines(provider);
			if (!lines.length) {
				action.remove();
				continue;
			}
			action.classList.add('opencode-settings-quota');
			for (const line of lines) {
				DOM.append(action, DOM.$('div')).textContent = line;
			}
		}
		const add = this.renderDisposables.add(new Button(section, { ...defaultButtonStyles, secondary: true }));
		add.element.classList.add('opencode-settings-add-provider');
		add.label = this.addingProvider ? localize('opencodeSettings.addingProvider', "Adding a provider in the terminal…") : localize('opencodeSettings.addProvider', "Add Provider…");
		add.enabled = !this.addingProvider;
		this.renderDisposables.add(add.onDidClick(() => void this.addProvider()));
	}

	private async addProvider(): Promise<void> {
		this.addingProvider = true;
		this.render();
		try {
			await this.commandService.executeCommand(OPENCODE_ADD_PROVIDER_COMMAND);
		} catch (error) {
			this.notificationService.error(localize('opencodeSettings.addProviderFailed', "Could not start `opencode auth login`: {0}", String(error)));
		}
		if (this._store.isDisposed) {
			return;
		}
		this.addingProvider = false;
		await this.refresh();
	}

	private renderFile(parent: HTMLElement, status: IOpenCodeStatus): void {
		const section = DOM.append(parent, DOM.$('.agent-global-configuration-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('opencodeSettings.file', "Configuration file");
		const exists = this.configText !== undefined || (status.config.exists && this.configInvalid);
		const text = localize('opencodeSettings.fileDescription', "Agents, permissions, MCP servers and everything else OpenCode reads live in the same file.");
		DOM.append(section, DOM.$('p.agent-global-configuration-settings-section-description')).textContent = exists
			? text
			: `${text} ${localize('opencodeSettings.fileMissing', "Not created yet; opening it creates an empty one.")}`;
		const button = this.renderDisposables.add(new Button(section, { ...defaultButtonStyles, secondary: true }));
		button.label = localize('opencodeSettings.open', "Open {0}", this.configName());
		this.renderDisposables.add(button.onDidClick(() => void this.openFile(exists)));
	}

	private async openFile(exists: boolean): Promise<void> {
		const file = this.configUri();
		if (!file) {
			return;
		}
		if (!exists) {
			try {
				await this.fileService.writeFile(file, VSBuffer.fromString('{\n  "$schema": "https://opencode.ai/config.json"\n}\n'));
			} catch (error) {
				this.notificationService.error(localize('opencodeSettings.createFailed', "Could not create {0}: {1}", file.fsPath, String(error)));
				return;
			}
		}
		await this.editorService.openEditor({ resource: file, options: { pinned: true } });
	}
}

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.HarnessSettings,
	label: localize('opencodeCustomizationSettings.navigationLabel', "OpenCode"),
	icon: openCodeIcon,
	description: localize('opencodeCustomizationSettings.navigationDescription', "Configure global behavior for this harness."),
	supportsHarness: harnessId => harnessId === SessionType.AgentHostOpenCode,
	create: (instantiationService, container) => withEngineVersion(instantiationService, container, 'opencode', instantiationService.createInstance(OpenCodeSettingsWidget, container)),
});
