/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Tab completion and ⌘K in the editor window's own Settings (patches/530-editor-settings.patch,
 *  kanban design/settings direction B, task-9rj7k). They only act in the editor window, so they live in its ⌘,
 *  Settings under "Tab Completion and ⌘K", as four ordinary settings: on or off, the model (the models Dispatch
 *  offers, with their notes), the daily cap with today's spend, and the ⌘K model. The Agents window's Settings has a
 *  row that brings this up in the editor window.
 *
 *  Dispatch's settings stay the truth (the completions read them through the CLI, the status bar's switch writes
 *  them): each setting's default here is Dispatch's value, read through dispatch-bridge's `dispatch.editorSettings`
 *  when the window opens, every minute and when it comes to the front; a value changed here is saved there at once.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import * as DOM from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EDIT_MODEL, EDITOR_SETTING_KEYS, EDITOR_SETTINGS_QUERY, IEditorSettings, IModelOption, isSubscription, money, savePatch, settingValues, TAB_CAP, TAB_ENABLED, TAB_MODEL } from './dispatchEditorSettingsModel.js';

const COMMAND = 'dispatch.editorSettings';
const REFRESH_MS = 60_000;
export const OPEN_EDITOR_SETTINGS = 'dispatch.editorSettings.open';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

function node(s: IEditorSettings | undefined): IConfigurationNode {
	const models = (list: readonly IModelOption[] | undefined, current: string) => {
		const all = list?.length ? list : [{ id: current, label: current }];
		return {
			enum: all.map(m => m.id),
			enumItemLabels: all.map(m => m.label),
			enumDescriptions: all.map(m => m.hint || ''),
		};
	};
	const tabModel = s?.tab.model ?? 'deepseek-flash';
	const editModel = s?.edit_model ?? 'claude:sonnet';
	const spend = s
		? (s.tab.cap_usd > 0
			? localize('dispatchEditorSettings.todayCap', "Today: {0} of {1}, {2} completions. This month: {3}.", money(s.tab.today.usd), money(s.tab.cap_usd), s.tab.today.count, money(s.tab.month.usd))
			: localize('dispatchEditorSettings.today', "Today: {0}, {1} completions. This month: {2}.", money(s.tab.today.usd), s.tab.today.count, money(s.tab.month.usd)))
		: '';
	return {
		id: 'dispatchEditorSettings',
		order: 99,
		title: localize('dispatchEditorSettings.title', "Tab Completion and ⌘K"),
		type: 'object',
		scope: ConfigurationScope.APPLICATION,
		properties: {
			[TAB_ENABLED]: {
				type: 'boolean',
				default: s?.tab.enabled ?? true,
				order: 1,
				description: s && !isSubscription(tabModel) && s.tab.has_key === false
					? localize('dispatchEditorSettings.enabledNoKey', "Grey suggestions as you type; Tab accepts. DeepSeek needs an API key and neither Dispatch nor OpenCode has one on this Mac yet: add one in the Agents window's Settings › Network (Add a key to OpenCode), or pick Claude or Codex as the model to use your subscription instead.")
					: localize('dispatchEditorSettings.enabled', "Grey suggestions as you type; Tab accepts."),
			},
			[TAB_MODEL]: {
				type: 'string',
				default: tabModel,
				order: 2,
				...models(s?.tab_models, tabModel),
				description: localize('dispatchEditorSettings.model', "Who writes the suggestions. DeepSeek is fast and costs about $0.0005 a completion; Claude and Codex are slower and use your subscription."),
			},
			[TAB_CAP]: {
				type: 'number',
				default: s?.tab.cap_usd ?? 0,
				minimum: 0,
				maximum: 1000,
				order: 3,
				description: [localize('dispatchEditorSettings.cap', "Completions stop for the day once they cost this much, in US dollars. 0 is no cap. Only DeepSeek completions cost money."), spend].filter(Boolean).join(' '),
			},
			[EDIT_MODEL]: {
				type: 'string',
				default: editModel,
				order: 4,
				...models(s?.edit_models, editModel),
				description: localize('dispatchEditorSettings.rewrite', "Who rewrites the selection when you press ⌘K and say how."),
			},
		},
	};
}

/** Settled once the window has asked Dispatch for the first time (answered or not). */
let firstLoad: () => void;
const firstLoaded = new Promise<void>(resolve => firstLoad = resolve);

class DispatchEditorSettings extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchEditorSettings';

	private current = node(undefined);
	private values: Record<string, unknown> | undefined;
	/** Values changed here that Dispatch has not confirmed yet, the newest per key: no answer from Dispatch overwrites them. */
	private readonly pending = new Map<string, unknown>();
	/** Saves go one after another, so the value Dispatch keeps is the last one set here. */
	private saving: Promise<void> = Promise.resolve();
	private loading = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		registry.registerConfiguration(this.current);
		this._register({ dispose: () => registry.deregisterConfigurations([this.current]) });
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (!this.values) {
				return;
			}
			for (const key of EDITOR_SETTING_KEYS) {
				if (e.affectsConfiguration(key)) {
					this.changed(key);
				}
			}
		}));
		const timer = mainWindow.setInterval(() => void this.load(), REFRESH_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
		this._register(DOM.addDisposableListener(mainWindow, DOM.EventType.FOCUS, () => void this.load()));
		void this.load(30).finally(() => firstLoad());
	}

	private async ask(op: 'get' | 'save', patch?: Record<string, unknown>, tries = 1): Promise<{ ok: boolean; result?: IEditorSettings; error?: string } | undefined> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.commandService.executeCommand<{ ok: boolean; result?: IEditorSettings; error?: string }>(COMMAND, op, patch);
			} catch (e) {
				// right after the window opens, dispatch-bridge may still be starting
				if (attempt >= tries || !/not found/i.test(String(e))) {
					this.logService.trace(`[dispatch editor settings] ${op}: ${e}`);
					return undefined;
				}
				await new Promise(resolve => mainWindow.setTimeout(resolve, 1000));
			}
		}
	}

	/** Dispatch's values become the settings' defaults; a value set here that Dispatch no longer has follows it. */
	private async load(tries = 1): Promise<void> {
		if (this.loading) {
			return;
		}
		this.loading = true;
		try {
			const answer = await this.ask('get', undefined, tries);
			if (answer?.ok && answer.result) {
				await this.apply(answer.result);
			}
		} finally {
			this.loading = false;
		}
	}

	private async apply(s: IEditorSettings): Promise<void> {
		// Dispatch's values first: the defaults moving below, and the values written back, then read as no change
		const values = settingValues(s);
		this.values = values;
		this.setNode(node(s));
		for (const key of EDITOR_SETTING_KEYS) {
			if (this.pending.has(key)) {
				continue; // changed here after this answer was asked for: that value is on its way to Dispatch
			}
			const mine = this.configurationService.inspect(key).userValue;
			if (mine !== undefined && mine !== values[key]) {
				await this.configurationService.updateValue(key, values[key], ConfigurationTarget.USER);
			}
		}
	}

	/** Only when something moved: new defaults or notes make the Settings editor search again and rebuild its list. */
	private setNode(next: IConfigurationNode): void {
		if (JSON.stringify(next) === JSON.stringify(this.current)) {
			return;
		}
		registry.updateConfigurations({ add: [next], remove: [this.current] });
		this.current = next;
	}

	/** A person changed it here (Dispatch's own value written back, or a default moving with it, is no change). */
	private changed(key: string): void {
		const value = this.configurationService.getValue(key);
		if (this.pending.has(key) ? this.pending.get(key) === value : this.values?.[key] === value) {
			return;
		}
		this.pending.set(key, value);
		this.saving = this.saving.then(() => this.save(key, value));
	}

	private async save(key: string, value: unknown): Promise<void> {
		if (this.pending.get(key) !== value) {
			return; // changed again while waiting: the newer value is saved instead
		}
		const patch = savePatch(key, value);
		const answer = patch ? await this.ask('save', patch) : undefined;
		if (this.pending.get(key) === value) {
			this.pending.delete(key);
		}
		if (answer?.ok && answer.result) {
			await this.apply(answer.result);
			return;
		}
		this.notificationService.error(localize('dispatchEditorSettings.saveFailed', "Could not save it in Dispatch: {0}", answer?.error ?? localize('dispatchEditorSettings.noBridge', "Dispatch did not answer.")));
		await this.load();
	}
}

registerWorkbenchContribution2(DispatchEditorSettings.ID, DispatchEditorSettings, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_EDITOR_SETTINGS,
			title: localize2('dispatchEditorSettings.open', "Open Tab Completion and ⌘K Settings"),
			category: localize2('dispatchEditorSettings.category', "Dispatch"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, query?: unknown): Promise<unknown> {
		const commandService = accessor.get(ICommandService);
		// Dispatch's values first (a few seconds at most): settings that arrive after the editor shows make it search again
		await raceTimeout(firstLoaded, 3000);
		return commandService.executeCommand('workbench.action.openSettings', typeof query === 'string' && query ? query : EDITOR_SETTINGS_QUERY);
	}
});
