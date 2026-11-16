/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Keys (kanban task-d5ejn). Dispatch's key store, `dispatch env`
 *  (~/.config/dispatch/env, only the person can read it): agents get the names and what each is for at the start of
 *  a session and fetch a value with `dispatch env get NAME` when they need it, so a key saved here works for every
 *  agent from its next call on.
 *
 *  Each key is a row: its name, what it is for, the project it belongs to, the value hidden (the eye shows it for
 *  30 s, Copy puts it on the clipboard). Add key sits next to Search keys above the list, always in sight however many
 *  keys there are, and opens the form at the top of the list (task-5wvgj); Edit opens the same form under the row
 *  (the value left empty keeps the old one), Delete asks first. Every change shows the "Key saved" toast with Undo
 *  (dispatchSettingsKeysToast.ts), and the store before it is kept in ~/.dispatch/backups/<date>/.
 *
 *  Another part of the window can ask for a key (`dispatch.settings.open 'keys' { add, note }`, Point and talk's card):
 *  the page opens with the form filled in and the cursor in Value, or that key's Edit when it is there already.
 *
 *  Everything goes through dispatch-bridge's `dispatch.env` (ide-ext/src/keys.ts). A value is only ever in this page
 *  while it is shown or being typed: never in a log, a title, a toast or the page's text otherwise.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { InputBox, MessageType } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { dispatchProjectsRegistry, refreshDispatchProjectsRegistry } from '../../sessions/browser/dispatchProjectsModel.js';
import { button, empty, groupHead, icon, iconButton, note, pending, problem, row, rowsBlock, tag } from './dispatchSettingsDom.js';
import { settingsData } from './dispatchSettingsData.js';
import { IKeyEvent, IKeysAnswer, KEYS_COMMAND, onDidChangeDispatchKeys, closeKeysToast, showKeysToast } from './dispatchSettingsKeysToast.js';
import { type IKeyFormRequest, keyFormFor } from './dispatchSettingsModel.js';
import { takeKeyFormRequest } from './dispatchSettingsState.js';

const $ = DOM.$;
const ASK_MS = 30_000;
const SHOWN_MS = 30_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTS = '••••••••••••';

/** A row of `dispatch env list --json`: no value, only how long it is. */
export interface IKeyRow {
	readonly name: string;
	readonly note: string;
	readonly project: string;
	readonly length: number;
}

interface ISaveAnswer { readonly ok: boolean; readonly name: string; readonly note: string; readonly project: string; readonly changed: boolean; readonly created?: boolean; readonly change?: string }
interface IRemoveAnswer { readonly ok: boolean; readonly name: string; readonly note: string; readonly project: string; readonly change: string }

export interface IKeysPageHost {
	relayout(): void;
	alive(root: HTMLElement, store: DisposableStore): boolean;
}

/** A name as people paste it ("deepseek api key") made into one ("DEEPSEEK_API_KEY"). */
export function keyName(typed: string): string {
	return typed.trim().replace(/[\s\-.]+/g, '_').replace(/[^A-Za-z0-9_]/g, '').toUpperCase();
}

export class DispatchKeysPage {

	constructor(
		private readonly host: IKeysPageHost,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	private async ask<T>(op: string, payload: Record<string, unknown> = {}): Promise<IKeysAnswer<T>> {
		try {
			const ans = await raceTimeout(this.commandService.executeCommand<IKeysAnswer<T>>(KEYS_COMMAND, op, payload), ASK_MS);
			return ans ?? { ok: false, error: localize('dispatchKeys.noAnswer', "Dispatch did not answer. Check that Dispatch is installed, then try again.") };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	render(root: HTMLElement, store: DisposableStore): void {
		const head = groupHead(root, localize('dispatchKeys.head', "Your keys"), Codicon.key);
		const count = DOM.append(head, $('span.dset-gh-r'));
		// one line above the list: a search over the names, what each is for and its project (dozens of keys do not
		// fit on a screen), and Add key, in sight without scrolling to the end of them (task-5wvgj)
		const bar = DOM.append(root, $('.dset-keys-bar'));
		bar.hidden = true; // until the list is read: with no keys it stays hidden
		const search = DOM.append(bar, $('.dset-keys-search'));
		search.appendChild(icon(Codicon.search));
		const query = DOM.append(search, $<HTMLInputElement>('input', { type: 'search', placeholder: localize('dispatchKeys.search', "Search keys"), 'aria-label': localize('dispatchKeys.search', "Search keys") }));
		store.add(DOM.addDisposableListener(query, DOM.EventType.INPUT, () => draw()));
		const add = DOM.append(bar, $('button.dset-keys-add', { type: 'button' }));
		add.dataset.keys = 'add';
		add.appendChild(icon(Codicon.add));
		DOM.append(add, $('span', undefined, localize('dispatchKeys.addKey', "Add key")));
		store.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => editing === '' ? focusForm() : openForm('')));
		const block = rowsBlock(root, 'keys');
		block.classList.add('dset-keys');
		// the form for a new key: the list card's first part, so it opens where Add key is
		const top = DOM.append(block, $('.dset-keys-top'));
		const list = DOM.append(block, $('.dset-keys-list'));
		const status = DOM.append(root, $('.dset-foot.dset-keys-status', { 'aria-live': 'polite' }));
		const err = problem(root, '');
		err.hidden = true;
		note(root, localize('dispatchKeys.noteBold', "Agents use a key by its name."),
			localize('dispatchKeys.note', "They see only the names and what each is for, and fetch a value with dispatch env get when they need it, so a key saved here works from their next step on. The values stay in ~/.config/dispatch/env, which only you can read; a replaced or deleted key is kept in ~/.dispatch/backups for 30 days."),
			Codicon.lock);

		const say = (text: string, bad = false) => {
			status.textContent = bad ? '' : text;
			err.textContent = bad ? text : '';
			err.hidden = !bad;
			this.host.relayout();
		};

		let rows: IKeyRow[] | undefined;
		/** The form: open for a new key (''), for a key's edit (its name), or closed. */
		let editing: string | undefined;
		const form = store.add(new DisposableStore());
		/** The open form's element, kept across redraws so what is typed in it stays when the list changes. */
		let formEl: HTMLElement | undefined;
		/** What the open form starts with when another part of the window asked for a key. */
		let prefill: IKeyFormRequest | undefined;
		/** Asked for as this page opened: answered once the list is read (is the key there already?). */
		let asked = takeKeyFormRequest();
		const listStore = store.add(new DisposableStore());
		const revealed = new Map<string, string>();
		store.add(toDisposable(() => revealed.clear()));

		const draw = () => {
			if (!this.host.alive(root, store) || !rows) {
				return;
			}
			listStore.clear();
			DOM.clearNode(list);
			DOM.clearNode(top);
			count.textContent = rows.length === 1 ? localize('dispatchKeys.one', "1 key") : localize('dispatchKeys.n', "{0} keys", rows.length);
			// no keys: the empty card (with its own button) or the form says it all; the line comes with the first key
			bar.hidden = !rows.length;
			search.hidden = rows.length < 2;
			add.setAttribute('aria-expanded', String(editing === ''));
			if (!rows.length && editing !== '') {
				const e = empty(list, Codicon.key, localize('dispatchKeys.emptyT', "No keys yet"), localize('dispatchKeys.emptyS', "Save an API key once here and every agent can use it by name. You will not have to paste it into a chat again."));
				button(e, localize('dispatchKeys.addFirst', "Add a key"), () => openForm(''), listStore, true).element.dataset.keys = 'add-first';
			}
			const words = search.hidden ? '' : query.value.trim().toLowerCase();
			const shown = words ? rows.filter(k => k.name === editing || [k.name, k.note, k.project].some(t => t?.toLowerCase().includes(words))) : rows;
			if (rows.length && !shown.length) {
				DOM.append(list, $('.dset-keys-nomatch', undefined, localize('dispatchKeys.noMatch', "No key matches \"{0}\".", query.value.trim())));
			}
			for (const k of shown) {
				drawRow(k);
			}
			if (editing === '') {
				placeForm(top, undefined);
			}
			this.host.relayout();
		};

		const drawRow = (k: IKeyRow) => {
			const r = row(list, { label: k.name, detail: k.note || localize('dispatchKeys.noPurpose', "No purpose yet: Edit to say what it is for"), icon: Codicon.key, key: `key:${k.name}` }, listStore);
			r.row.dataset.key = k.name;
			r.row.classList.add('dset-key-row');
			// the name in the editor's monospace, the project tag in the page's own font
			DOM.clearNode(r.label);
			DOM.append(r.label, $('span.dset-key-name', undefined, k.name));
			if (!k.note) {
				r.detail.classList.add('dset-key-nopurpose');
			}
			tag(r.label, k.project || localize('dispatchKeys.everyProject', "Every project")).classList.toggle('dset-key-all', !k.project);
			const val = DOM.append(r.ctl, $('span.dset-key-val'));
			const shown = revealed.get(k.name);
			val.textContent = shown ?? DOTS;
			val.classList.toggle('shown', shown !== undefined);
			val.title = shown !== undefined ? '' : localize('dispatchKeys.hiddenTitle', "{0} characters, hidden", k.length);
			const eye = iconButton(r.ctl, shown !== undefined ? Codicon.eyeClosed : Codicon.eye, shown !== undefined ? localize('dispatchKeys.hide', "Hide value") : localize('dispatchKeys.reveal', "Show value"), () => toggleValue(k), listStore);
			eye.dataset.keys = 'eye';
			iconButton(r.ctl, Codicon.copy, localize('dispatchKeys.copy', "Copy value"), () => copyValue(k), listStore).dataset.keys = 'copy';
			const edit = iconButton(r.ctl, Codicon.edit, localize('dispatchKeys.edit', "Edit"), () => openForm(k.name), listStore);
			edit.dataset.keys = 'edit';
			const del = iconButton(r.ctl, Codicon.trash, localize('dispatchKeys.delete', "Delete"), () => remove(k), listStore);
			del.dataset.keys = 'delete';
			if (editing === k.name) {
				r.row.classList.add('editing');
				placeForm(DOM.append(list, $('.dset-keys-editwrap')), k);
			}
		};

		const toggleValue = async (k: IKeyRow) => {
			if (revealed.has(k.name)) {
				revealed.delete(k.name);
				draw();
				return;
			}
			const ans = await this.ask<{ value: string }>('reveal', { name: k.name });
			if (!this.host.alive(root, store)) {
				return;
			}
			if (!ans.ok || ans.result?.value === undefined) {
				say(ans.error || localize('dispatchKeys.revealFailed', "Dispatch could not read {0}.", k.name), true);
				return;
			}
			revealed.set(k.name, ans.result.value);
			say('');
			draw();
			// shown for a while, then hidden again by itself
			const h = setTimeout(() => {
				if (revealed.delete(k.name)) {
					draw();
				}
			}, SHOWN_MS);
			store.add(toDisposable(() => clearTimeout(h)));
		};

		const copyValue = async (k: IKeyRow) => {
			const ans = await this.ask<{ value: string }>('reveal', { name: k.name });
			if (!this.host.alive(root, store)) {
				return;
			}
			if (!ans.ok || ans.result?.value === undefined) {
				say(ans.error || localize('dispatchKeys.revealFailed', "Dispatch could not read {0}.", k.name), true);
				return;
			}
			await this.clipboardService.writeText(ans.result.value);
			say(localize('dispatchKeys.copied', "{0} copied.", k.name));
		};

		const remove = async (k: IKeyRow) => {
			const { confirmed } = await this.dialogService.confirm({
				message: localize('dispatchKeys.deleteQ', "Delete {0}?", k.name),
				detail: localize('dispatchKeys.deleteD', "Agents can no longer use it. Undo brings it back, and a copy is kept in ~/.dispatch/backups for 30 days."),
				primaryButton: localize('dispatchKeys.deleteYes', "&&Delete"),
			});
			if (!confirmed || !this.host.alive(root, store)) {
				return;
			}
			// the line under the list was about the step before ("… copied."): it goes now, as the bridge's toast for
			// this change can come before the answer below
			say('');
			closeKeysToast();
			const ans = await this.ask<IRemoveAnswer>('remove', { name: k.name });
			if (!this.host.alive(root, store)) {
				return;
			}
			if (!ans.ok || !ans.result) {
				say(ans.error || localize('dispatchKeys.deleteFailed', "{0} could not be deleted. Nothing changed.", k.name), true);
				return;
			}
			revealed.delete(k.name);
			if (editing === k.name) {
				dropForm();
				editing = undefined;
			}
			// the toast says it (with Undo); a line here would say it twice
			say('');
			toast({ id: ans.result.change, op: 'unset', name: k.name, note: ans.result.note, project: ans.result.project });
			await reload();
		};

		const toast = (e: IKeyEvent) => this.instantiationService.invokeFunction(a => showKeysToast(a, [e]));

		const dropForm = () => {
			form.clear();
			formEl = undefined;
			prefill = undefined;
		};

		const openForm = (name: string, fill?: IKeyFormRequest) => {
			dropForm();
			prefill = fill;
			editing = name;
			say('');
			draw();
		};

		/** The open form's first box still to fill: Value when the name is given. */
		const focusForm = () => {
			const box = formEl?.querySelector<HTMLInputElement>('input[data-keys="name"]:placeholder-shown') ?? formEl?.querySelector<HTMLInputElement>('input[data-keys="value"]');
			box?.focus();
		};

		/** The key another part of the window asked for, once the list says whether it is there. */
		const answerRequest = () => {
			const r = asked;
			if (!r || !rows) {
				return;
			}
			asked = undefined;
			const how = keyFormFor(r, rows);
			query.value = '';
			openForm(how.edit ? r.name : '', { name: r.name, note: how.note });
		};

		const closeForm = () => {
			dropForm();
			editing = undefined;
			draw();
		};

		const placeForm = (parent: HTMLElement, k: IKeyRow | undefined) => {
			if (formEl) {
				parent.appendChild(formEl);
			} else {
				formEl = drawForm(parent, k);
			}
		};

		/** The form, for a new key (`k` undefined) or one there is. */
		const drawForm = (parent: HTMLElement, k: IKeyRow | undefined): HTMLElement => {
			form.clear();
			const f = DOM.append(parent, $('form.dset-keys-form', { autocomplete: 'off' }));
			f.dataset.keys = k ? 'edit-form' : 'add-form';
			const field = (cls: string, label: string) => {
				const w = DOM.append(f, $(`label.dset-keys-field.${cls}`));
				DOM.append(w, $('span.dset-keys-l', undefined, label));
				return DOM.append(w, $('.dset-keys-in'));
			};
			const input = (parentEl: HTMLElement, placeholder: string, aria: string, type = 'text') => {
				const box = form.add(new InputBox(parentEl, this.contextViewService, { placeholder, ariaLabel: aria, type, inputBoxStyles: defaultInputBoxStyles }));
				box.inputElement.spellcheck = false;
				box.inputElement.autocomplete = 'off';
				return box;
			};

			let nameBox: InputBox | undefined;
			if (k) {
				const nameField = field('name', localize('dispatchKeys.nameL', "Name"));
				DOM.append(nameField, $('span.dset-keys-fixed', undefined, k.name));
			} else {
				nameBox = input(field('name', localize('dispatchKeys.nameL', "Name")), localize('dispatchKeys.namePh', "DEEPSEEK_API_KEY"), localize('dispatchKeys.nameL', "Name"));
				nameBox.inputElement.dataset.keys = 'name';
				nameBox.value = prefill?.name ?? '';
			}
			const projects = (dispatchProjectsRegistry.get() ?? []).filter(p => p.host === 'local' && !p.archived).map(p => p.name);
			if (k?.project && !projects.some(p => p.toLowerCase() === k.project.toLowerCase())) {
				projects.unshift(k.project);
			}
			const options = ['', ...projects];
			const select = form.add(new SelectBox(options.map(p => ({ text: p || localize('dispatchKeys.everyProject', "Every project") })),
				Math.max(0, options.findIndex(p => p.toLowerCase() === (k?.project ?? '').toLowerCase())), this.contextViewService, defaultSelectBoxStyles,
				{ ariaLabel: localize('dispatchKeys.projectL', "Project") }));
			let project = k?.project ?? '';
			form.add(select.onDidSelect(e => { project = options[e.index] ?? ''; }));
			select.render(field('project', localize('dispatchKeys.projectL', "Project")));

			const valueBox = input(field('value', localize('dispatchKeys.valueL', "Value")),
				k ? localize('dispatchKeys.valueKeepPh', "Leave empty to keep the current value") : localize('dispatchKeys.valuePh', "Paste the key"),
				localize('dispatchKeys.valueL', "Value"), 'password');
			valueBox.inputElement.dataset.keys = 'value';
			const noteBox = input(field('note', localize('dispatchKeys.noteL', "What it is for")), localize('dispatchKeys.notePh', "DeepSeek API for OpenCode"), localize('dispatchKeys.noteL', "What it is for"));
			noteBox.inputElement.dataset.keys = 'note';
			noteBox.value = (k ? k.note : '') || (prefill && (!k || prefill.name === k.name) ? prefill.note : '');

			const actions = DOM.append(f, $('.dset-keys-actions'));
			const save = button(actions, k ? localize('dispatchKeys.saveEdit', "Save") : localize('dispatchKeys.saveNew', "Save key"), () => submit(), form, true);
			save.element.dataset.keys = 'save';
			button(actions, localize('dispatchKeys.cancel', "Cancel"), () => closeForm(), form).element.dataset.keys = 'cancel';
			const hint = DOM.append(actions, $('span.dset-keys-hint'));

			const valid = (): string | undefined => {
				if (nameBox) {
					const n = nameBox.value.trim();
					if (!n) {
						return localize('dispatchKeys.needName', "Give it a name, like DEEPSEEK_API_KEY.");
					}
					if (!NAME.test(n)) {
						return localize('dispatchKeys.badName', "Letters, digits and underscores only, not starting with a digit: {0} would do.", keyName(n) || 'MY_KEY');
					}
				}
				if (!k && !valueBox.value.trim()) {
					return localize('dispatchKeys.needValue', "Paste the key's value.");
				}
				if (/[\r\n]/.test(valueBox.value.trim())) {
					return localize('dispatchKeys.oneLine', "A key is one line.");
				}
				return undefined;
			};

			let busy = false;
			const submit = async () => {
				if (busy) {
					return;
				}
				const bad = valid();
				if (bad) {
					hint.textContent = bad;
					hint.classList.add('bad');
					if (nameBox && /name/i.test(bad)) {
						nameBox.showMessage({ content: bad, type: MessageType.ERROR });
						nameBox.focus();
					} else {
						valueBox.focus();
					}
					return;
				}
				const name = k ? k.name : nameBox!.value.trim();
				const existing = !k && rows?.some(r => r.name === name);
				if (existing) {
					const { confirmed } = await this.dialogService.confirm({
						message: localize('dispatchKeys.replaceQ', "Replace the value of {0}?", name),
						detail: localize('dispatchKeys.replaceD', "There is a key with this name already. Undo brings its old value back."),
						primaryButton: localize('dispatchKeys.replaceYes', "&&Replace"),
					});
					if (!confirmed) {
						return;
					}
				}
				busy = true;
				save.enabled = false;
				hint.textContent = '';
				say(''); // as in remove: the step before's line goes before the toast can come
				closeKeysToast();
				const ans = await this.ask<ISaveAnswer>('save', { name, value: valueBox.value, note: noteBox.value, project });
				busy = false;
				if (!this.host.alive(root, store)) {
					return;
				}
				save.enabled = true;
				if (!ans.ok || !ans.result) {
					hint.textContent = ans.error || localize('dispatchKeys.saveFailed', "{0} could not be saved. Nothing changed.", name);
					hint.classList.add('bad');
					return;
				}
				valueBox.value = '';
				dropForm();
				editing = undefined;
				revealed.delete(name);
				const r = ans.result;
				// a change gets the toast (with Undo); only "nothing changed" is said here
				say(r.changed ? '' : localize('dispatchKeys.same', "{0} was already saved like that.", name));
				if (r.changed && r.change) {
					toast({ id: r.change, op: 'set', name, note: r.note, project: r.project, created: r.created });
				}
				await reload();
			};
			form.add(DOM.addDisposableListener(f, DOM.EventType.SUBMIT, e => { DOM.EventHelper.stop(e, true); void submit(); }));
			form.add(DOM.addDisposableListener(f, DOM.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
					DOM.EventHelper.stop(e, true);
					void submit();
				} else if (e.key === 'Escape') {
					DOM.EventHelper.stop(e, true);
					closeForm();
				}
			}));
			for (const box of [nameBox, valueBox, noteBox]) {
				if (box) {
					form.add(box.onDidChange(() => { hint.textContent = ''; hint.classList.remove('bad'); }));
				}
			}
			// a pasted name of words becomes a name
			if (nameBox) {
				const nb = nameBox;
				form.add(DOM.addDisposableListener(nb.inputElement, DOM.EventType.BLUR, () => {
					const n = nb.value.trim();
					if (n && !NAME.test(n) && keyName(n) && NAME.test(keyName(n))) {
						nb.value = keyName(n);
					}
				}));
			}
			// the cursor where the typing starts: Name, or Value when the name is given (an edit, a key asked for)
			const asking = !!prefill;
			DOM.getWindow(f).requestAnimationFrame(() => {
				(nameBox && !nameBox.value ? nameBox : valueBox).focus();
				if (asking) {
					f.scrollIntoView({ block: 'nearest' });
				}
			});
			this.host.relayout();
			return f;
		};

		/** The names as Settings read them last (with everything else kept on this Mac, design/settings-fast). */
		const take = (kept: IKeyRow[]) => {
			rows = kept;
			for (const name of [...revealed.keys()]) {
				if (!rows.some(r => r.name === name)) {
					revealed.delete(name);
				}
			}
			if (editing && !rows.some(r => r.name === editing)) {
				dropForm();
				editing = undefined;
			}
			if (asked) {
				answerRequest();
			} else {
				draw();
			}
		};
		const reload = async () => {
			await settingsData.refresh('keys');
			if (!this.host.alive(root, store)) {
				return;
			}
			const now = settingsData.get<IKeyRow[]>('keys');
			if (now) {
				take(now);
			} else {
				say(localize('dispatchKeys.cantRead', "Dispatch could not read your keys. Check that Dispatch is installed, then open this page again."), true);
			}
		};
		store.add(settingsData.onDidChange(keys => {
			const kept = settingsData.get<IKeyRow[]>('keys');
			if (keys.has('keys') && kept && this.host.alive(root, store)) {
				take(kept);
			}
		}));

		// an agent, a terminal or the toast's Undo changed the store: read it again
		store.add(onDidChangeDispatchKeys(() => void reload()));
		// the projects for the form's list
		void refreshDispatchProjectsRegistry();
		const begin = () => {
			const kept = settingsData.get<IKeyRow[]>('keys');
			if (kept) {
				take(kept);
			} else {
				// the first Settings on this Mac, before the first answer
				const wait = pending(list);
				void reload().then(() => wait.remove());
			}
		};
		// Settings opened by a command (Open Keys, a toast's Show) renders its page before the view is in the window:
		// a draw then would be skipped (nothing to draw into) and the key asked for lost, so the first one waits for it
		// (task-5wvgj)
		let tries = 0;
		const whenShown = () => {
			if (store.isDisposed) {
				return;
			}
			if (root.isConnected || ++tries > 60) {
				begin();
				return;
			}
			const h = setTimeout(whenShown, 16);
			store.add(toDisposable(() => clearTimeout(h)));
		};
		whenShown();
	}
}
