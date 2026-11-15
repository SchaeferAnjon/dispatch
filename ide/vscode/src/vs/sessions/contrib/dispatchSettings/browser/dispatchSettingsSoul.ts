/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Soul (kanban app/cli/soul.py, task-8cn69). How every agent talks and works, one text
 *  Claude Code, Codex and OpenCode all read at the start of a session: a switch, the text in VS Code's own editor,
 *  Save, Undo changes and Reset to default. Everything goes through `dispatch.soul` (dispatch-bridge), and the CLI
 *  syncs it into each agent's rules file after every change; nothing is kept here. Under it, everything else Dispatch
 *  puts into every agent (dispatchSettingsBuiltins.ts).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSettingsSoul.css';
import * as DOM from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { getSimpleEditorOptions } from '../../../../workbench/contrib/codeEditor/browser/simpleEditorOptions.js';
import { button, groupHead, note, pending, problem, row, rowsBlock, tag, toggle } from './dispatchSettingsDom.js';
import { settingsData } from './dispatchSettingsData.js';
import { DispatchBuiltinsSection } from './dispatchSettingsBuiltins.js';

const $ = DOM.$;
const ASK_MS = 60_000;

/** What `dispatch soul … --json` answers. */
export interface ISoulState {
	readonly ok?: boolean;
	readonly error?: string;
	readonly path: string;
	readonly on: boolean;
	readonly content: string;
	readonly default: string;
	readonly customized: boolean;
}

export interface ISoulPageHost {
	relayout(): void;
	alive(root: HTMLElement, store: DisposableStore): boolean;
	go(page: 'abilities'): void;
}

/** ~/… for a path in the home folder. */
export function soulPathLabel(path: string): string {
	const m = /^\/(Users|home)\/[^/]+\//.exec(path);
	return m ? '~/' + path.slice(m[0].length) : path;
}

export class DispatchSoulPage {

	constructor(
		private readonly host: ISoulPageHost,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) { }

	/** A change; its answer (the Soul as it is now) is what Settings shows from then on. */
	private async ask(op: string, text?: string): Promise<ISoulState | undefined> {
		try {
			const ans = await raceTimeout(this.commandService.executeCommand<ISoulState>('dispatch.soul', op, text), ASK_MS);
			if (ans?.ok && ans.path) {
				settingsData.set('soul', ans);
			}
			return ans;
		} catch {
			return undefined;
		}
	}

	render(page: HTMLElement, store: DisposableStore): void {
		// the person's Soul on top, then what comes with Dispatch
		const root = DOM.append(page, $('.dset-soul-own'));
		this.instantiationService.createInstance(DispatchBuiltinsSection, this.host).render(DOM.append(page, $('.dset-soul-builtins')), store);
		// as read last (Settings reads it with everything else kept on this Mac as it opens, design/settings-fast)
		const state = settingsData.get<ISoulState>('soul');
		if (state?.path) {
			this.draw(root, store, state);
			return;
		}
		// the first Settings on this Mac, before the first answer: drawn once it is in
		const wait = pending(root);
		const sub = settingsData.onDidChange(keys => {
			const now = settingsData.get<ISoulState>('soul');
			if (!keys.has('soul') || !now?.path || !this.host.alive(root, store)) {
				return;
			}
			sub.dispose();
			wait.remove();
			this.draw(root, store, now);
			this.host.relayout();
		});
		store.add(sub);
	}

	private draw(root: HTMLElement, store: DisposableStore, first: ISoulState): void {
		let saved = first.content;
		let customized = first.customized;

		// ---- on or off
		const top = rowsBlock(root, 'soul');
		const useLabel = localize('dispatchSoul.use', "Use Soul");
		const sw = row(top, { label: useLabel, detail: '' }, store);
		sw.row.dataset.soul = 'switch';
		const kind = DOM.append(sw.label, $('span.dset-soul-kind'));
		const showKind = () => {
			DOM.clearNode(kind);
			tag(kind, customized ? localize('dispatchSoul.changed', "Changed by you") : localize('dispatchSoul.default', "Default"));
			kind.dataset.kind = customized ? 'changed' : 'default';
		};
		const showDetail = (on: boolean) => {
			sw.detail.hidden = false;
			sw.detail.textContent = on
				? localize('dispatchSoul.onD', "Claude Code, Codex and OpenCode read it at the start of every new session.")
				: localize('dispatchSoul.offD', "Off: each agent talks and works in its own way. Your text below is kept.");
		};
		showKind();
		showDetail(first.on);
		toggle(sw.ctl, useLabel, first.on, async want => {
			const ans = await this.ask(want ? 'on' : 'off');
			if (!ans?.ok) {
				say(ans?.error || localize('dispatchSoul.switchFailed', "Soul could not be switched. Nothing changed."), true);
				return false;
			}
			showDetail(ans.on);
			editorBox.classList.toggle('off', !ans.on);
			say(ans.on
				? localize('dispatchSoul.nowOn', "Soul is on. New sessions of every agent use it.")
				: localize('dispatchSoul.nowOff', "Soul is off. New sessions use each agent's own tone."));
			return true;
		}, store);

		// ---- the text
		groupHead(root, localize('dispatchSoul.text', "What every agent reads"), Codicon.book, soulPathLabel(first.path));
		const editorBox = DOM.append(root, $('.dset-soul-editor'));
		editorBox.dataset.setting = 'soul-text';
		editorBox.classList.toggle('off', !first.on);
		const host = DOM.append(editorBox, $('.dset-soul-host'));
		const overflow = DOM.append(root, $('.dset-soul-overflow.monaco-editor'));
		store.add(toDisposable(() => overflow.remove()));
		// plain text: no syntax colours on a settings page (DESIGN.md: colour only for state)
		const model = store.add(this.modelService.createModel(saved, this.languageService.createById('plaintext'),
			URI.from({ scheme: 'dispatch-soul', path: '/SOUL.md', query: generateUuid() }), false));
		const editor = store.add(this.instantiationService.createInstance(CodeEditorWidget, host, {
			...getSimpleEditorOptions(this.configurationService),
			ariaLabel: localize('dispatchSoul.editorLabel', "Soul text"),
			wordWrap: 'on',
			lineNumbers: 'off',
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			automaticLayout: true,
			padding: { top: 12, bottom: 12 },
			scrollbar: { vertical: 'auto', horizontal: 'hidden', alwaysConsumeMouseWheel: false },
			overflowWidgetsDomNode: overflow,
		}, { isSimpleWidget: true }));
		editor.setModel(model);

		// ---- what can be done with it
		const actions = DOM.append(root, $('.dset-actions.dset-soul-actions'));
		const save = button(actions, localize('dispatchSoul.save', "Save"), () => doSave(), store, true);
		save.element.dataset.soul = 'save';
		const revert = button(actions, localize('dispatchSoul.revert', "Undo changes"), () => {
			model.setValue(saved);
			editor.focus();
			say('');
		}, store);
		revert.element.dataset.soul = 'revert';
		const reset = button(actions, localize('dispatchSoul.reset', "Reset to default"), () => doReset(), store);
		reset.element.dataset.soul = 'reset';
		const status = DOM.append(root, $('.dset-foot.dset-soul-status', { 'aria-live': 'polite' }));
		const err = problem(root, '');
		err.hidden = true;
		note(root, localize('dispatchSoul.whenBold', "Sessions already running keep the Soul they started with."),
			localize('dispatchSoul.when', "Every change also goes into each agent's own rules file. The text you replace is kept in ~/.dispatch/backups for 30 days."));

		const say = (text: string, bad = false) => {
			status.textContent = bad ? '' : text;
			err.textContent = bad ? text : '';
			err.hidden = !bad;
			this.host.relayout();
		};
		const showButtons = () => {
			const dirty = model.getValue() !== saved;
			save.enabled = dirty;
			revert.enabled = dirty;
			reset.enabled = customized || dirty;
			editorBox.classList.toggle('dirty', dirty);
		};
		store.add(model.onDidChangeContent(() => {
			showButtons();
			status.textContent = model.getValue() !== saved ? localize('dispatchSoul.unsaved', "Not saved yet.") : '';
		}));
		showButtons();

		let busy = false;
		const doSave = async () => {
			const text = model.getValue();
			if (busy || text === saved) {
				return;
			}
			if (!text.trim()) {
				say(localize('dispatchSoul.empty', "Soul cannot be empty. To stop using it, turn it off above."), true);
				return;
			}
			busy = true;
			save.enabled = false;
			const ans = await this.ask('save', text);
			busy = false;
			if (!this.host.alive(root, store)) {
				return;
			}
			if (!ans?.ok) {
				showButtons();
				say(ans?.error || localize('dispatchSoul.saveFailed', "Soul could not be saved. Your text is still here; try Save again."), true);
				return;
			}
			saved = ans.content;
			customized = ans.customized;
			if (model.getValue() === text && text !== saved) {
				model.setValue(saved);
			}
			showKind();
			showButtons();
			editor.focus();
			say(localize('dispatchSoul.saved', "Saved. New sessions of every agent use it."));
		};
		const doReset = async () => {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('dispatchSoul.resetQ', "Reset Soul to Dispatch's default?"),
				detail: localize('dispatchSoul.resetD', "Your text is replaced by the one Dispatch comes with. A copy of yours is kept in ~/.dispatch/backups for 30 days."),
				primaryButton: localize('dispatchSoul.resetYes', "&&Reset"),
			});
			if (!confirmed || !this.host.alive(root, store)) {
				return;
			}
			const ans = await this.ask('reset');
			if (!this.host.alive(root, store)) {
				return;
			}
			if (!ans?.ok) {
				say(ans?.error || localize('dispatchSoul.resetFailed', "Soul could not be reset. Nothing changed."), true);
				return;
			}
			saved = ans.content;
			customized = ans.customized;
			model.setValue(saved);
			showKind();
			showButtons();
			editor.focus();
			say(localize('dispatchSoul.resetDone', "Back to the default. New sessions of every agent use it."));
		};
		// ⌘S in the text saves it, as in any editor
		store.add(DOM.addDisposableListener(editorBox, DOM.EventType.KEY_DOWN, e => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
				DOM.EventHelper.stop(e, true);
				void doSave();
			}
		}));
	}
}
