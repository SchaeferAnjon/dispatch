/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: preferences in a session (patches/335-preferences.patch; kanban
 *  design/knowledge/redesign, direction B).
 *
 *  When an agent remembers what the person said about a delivery it calls prefs_add, the tool of Dispatch's
 *  MCP server (kanban app/cli/dispatch_mcp.py), or runs `dispatch prefs add …` (kanban app/cli/prefs.py).
 *  That call does not show as a command pill or a tool call but as one grey line,
 *  "Remembered: <the sentence> · Edit · Forget", or for several at once "Remembered 3 from your
 *  feedback: a, b, c · Show" that opens into rows (Like / Avoid, the sentence, where it applies and a
 *  thumbnail of the part it hangs on). Edit changes the sentence in place, Forget takes it out (the
 *  line then says "Forgotten: … · Undo"). While the reply runs the line is among its steps; once the
 *  reply is done and its steps fold into "Completed N steps", one line for all of the reply's calls
 *  stays under the reply (renderDispatchPrefsFooter).
 *
 *  While the session is on screen, the moment such a call finishes a toast comes up at the bottom of
 *  the conversation, above the input: "Preference remembered · <sentence>" with Edit and Undo, 8 s,
 *  held while the pointer is on it, several merged into one. It sits in the input part's flow, so the
 *  conversation above makes room for it instead of being covered.
 *
 *  A preference's short name in brackets in a reply, 「按你的偏好（方角开关）」, links to it in
 *  Knowledge and counts once as followed (`dispatch prefs cite --ref <reply>`).
 *
 *  Data goes through dispatch-bridge's `dispatch.knowledge` (ids, edit, forget, undo, cite). The
 *  window hears `_dispatch.prefsChanged` (the bridge watches ~/.dispatch/preferences.jsonl) and every
 *  line reads its preferences again.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchPrefs.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatTerminalToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, isLegacyChatTerminalToolInvocationData } from '../../../common/chatService/chatService.js';
import { IChatResponseViewModel } from '../../../common/model/chatViewModel.js';
import { isToolResultInputOutputDetails } from '../../../common/tools/languageModelToolsService.js';
import { IChatCodeBlockInfo, IChatWidgetService } from '../../chat.js';
import { IChatContentPartRenderContext } from './chatContentParts.js';
import { BaseChatToolInvocationSubPart } from './toolInvocationParts/chatToolInvocationSubPart.js';

const KNOWLEDGE = 'dispatch.knowledge';
const OPEN_KNOWLEDGE = '_dispatch.openKnowledge';
// `dispatch prefs add`, and `undo`: an agent told "record it after all" may bring the forgotten one back
const ADD_COMMAND = /(?:^|[\s;&|(`'"])(?:\S*\/)?dispatch(?:\.py)?['"]?\s+prefs\s+(?:add|undo)\b/;
// what those commands themselves print (prefs.py _add_text, the undo's "Back · …", --json); nothing else counts
const ADDED_ONE = /^(?:Preference remembered|Already remembered) · .* \((pref-[a-z0-9]{4,10})\)\s*$/;
const ADDED_MANY = /^\d+ preferences remembered · /;
const ADDED_ROW = /^ {2}\S.* \((pref-[a-z0-9]{4,10})\) · /;
const BACK = /^Back · /;
const PREF_ID = /\((pref-[a-z0-9]{4,10})\)/g;
const TOAST_MS = 8000;
/** A call that finished longer ago than this is history (a reloaded session): no toast. */
const FRESH_MS = 3 * 60 * 1000;

export interface IDispatchPref {
	id: string;
	name: string;
	text: string;
	polarity: 'like' | 'avoid';
	area: string;
	scope?: string;
	scope_label?: string;
	status?: 'active' | 'replaced' | 'forgotten';
	part?: string;
	thumb?: string;
	created?: string;
	updated?: string;
}

// ---- the preferences changed (an edit here, a Forget in Knowledge, an agent in another session) ----

const onDidChange = new Emitter<void>();
export const onDidChangeDispatchPrefs = onDidChange.event;
export function fireDispatchPrefsChanged(): void {
	onDidChange.fire();
}
CommandsRegistry.registerCommand('_dispatch.prefsChanged', () => fireDispatchPrefsChanged());

async function ask<T>(commandService: ICommandService, op: string, payload: Record<string, unknown>): Promise<T> {
	const answer = await commandService.executeCommand<{ ok: boolean; result?: T; error?: string }>(KNOWLEDGE, op, payload);
	if (!answer?.ok) {
		throw new Error(answer?.error || localize('dispatchPrefs.noBridge', "The Dispatch bridge did not answer."));
	}
	return answer.result as T;
}

async function prefsByIds(commandService: ICommandService, ids: string[]): Promise<IDispatchPref[]> {
	const r = await ask<{ items: IDispatchPref[] }>(commandService, 'prefsIds', { ids });
	const byId = new Map(r.items.map(p => [p.id, p]));
	return ids.map(id => byId.get(id)).filter((p): p is IDispatchPref => !!p);
}

// ---- which terminal calls are `dispatch prefs add` ------------------------------------------------

function terminalData(t: IChatToolInvocation | IChatToolInvocationSerialized): IChatTerminalToolInvocationData | undefined {
	const d = t.toolSpecificData;
	return d?.kind === 'terminal' && !isLegacyChatTerminalToolInvocationData(d) ? d : undefined;
}

// prefs_add of Dispatch's MCP server, as each agent names it: Claude Code mcp__dispatch__prefs_add, Codex
// dispatch.prefs_add, OpenCode dispatch_prefs_add. Its answer is the add's --json output, which reaches the window as
// it is (Claude Code, OpenCode) or as the MCP content item around it, printed as JSON (Codex: {"type": "text",
// "text": "…"}). Codex in code mode calls it from a script (`text(await tools.mcp__dispatch__prefs_add({...}))`), which
// prints the whole MCP result ({"content": [...]}) on a line of its own.
const MCP_ADD_TOOL = /^(?:mcp__dispatch__|dispatch[._])prefs_add$/;
const MCP_ADD_IN_SCRIPT = /\bmcp__dispatch__prefs_add\b/;

/** The text an MCP content item, or a whole MCP result, printed as JSON carries; undefined when `s` is neither. */
function mcpText(s: string): string | undefined {
	try {
		const v = JSON.parse(s) as { type?: string; text?: unknown; content?: { type?: string; text?: unknown }[]; isError?: boolean };
		if (v && v.type === 'text' && typeof v.text === 'string') {
			return v.text;
		}
		if (v && Array.isArray(v.content)) {
			return v.isError ? '' : v.content.map(c => c.type === 'text' && typeof c.text === 'string' ? c.text : '').join('\n');
		}
	} catch {
		// not JSON
	}
	return undefined;
}

/** Output with every MCP content item or result printed as JSON replaced by the text it carries: the whole output
 *  as one, else each block that starts with "{" at the start of a line (several items, a script's printed results). */
export function unwrapMcpOutput(text: string): string {
	const whole = mcpText(text.trim());
	if (whole !== undefined) {
		return whole;
	}
	return text.split(/\r?\n(?=\{)/).map(block => mcpText(block.trim()) ?? block).join('\n');
}

/** What a finished, successful prefs_add of Dispatch's MCP server answered; undefined for any other call. */
function mcpAddOutput(t: IChatToolInvocation | IChatToolInvocationSerialized): string | undefined {
	if (!IChatToolInvocation.isComplete(t)) {
		return undefined;
	}
	const direct = MCP_ADD_TOOL.test(t.toolId);
	const details = IChatToolInvocation.resultDetails(t);
	if (!isToolResultInputOutputDetails(details) || details.isError || (!direct && !MCP_ADD_IN_SCRIPT.test(details.input))) {
		return undefined;
	}
	return unwrapMcpOutput(details.output.map(o => o.type === 'embed' && typeof o.value === 'string' && o.isText !== false ? o.value : '').join('\n'));
}

/** The ids a finished `dispatch prefs add` (or prefs_add) printed, in order; [] for any other call. */
export function dispatchPrefIds(t: IChatToolInvocation | IChatToolInvocationSerialized): string[] {
	const mcp = mcpAddOutput(t);
	if (mcp !== undefined) {
		return addedIds(mcp);
	}
	const d = terminalData(t);
	if (!d || !IChatToolInvocation.isComplete(t)) {
		return [];
	}
	const command = d.commandLine.userEdited ?? d.commandLine.toolEdited ?? d.commandLine.original ?? '';
	if (!ADD_COMMAND.test(command) || (d.terminalCommandState?.exitCode ?? 0) !== 0) {
		return [];
	}
	const text = d.terminalCommandOutput?.text ?? '';
	return addedIds(text);
}

/**
 * The ids the add reported, in its text or its --json output, and not every id in the output: an agent
 * that lists preferences in the same command (`dispatch prefs add …; dispatch prefs list`) would
 * otherwise have all of them shown as remembered.
 */
export function addedIds(output: string): string[] {
	const out: string[] = [];
	const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const one = ADDED_ONE.exec(line);
		if (one) {
			out.push(one[1]);
			continue;
		}
		if (BACK.test(line)) {
			for (const m of line.matchAll(PREF_ID)) {
				out.push(m[1]);
			}
			continue;
		}
		if (ADDED_MANY.test(line)) {
			for (let j = i + 1; j < lines.length; j++) {
				const row = ADDED_ROW.exec(lines[j]);
				if (!row) {
					break;
				}
				out.push(row[1]);
			}
			continue;
		}
		if (line === '{') {
			// --json prints one object, indented, from a line "{" to a line "}"
			const end = lines.indexOf('}', i + 1);
			if (end > i) {
				try {
					const obj = JSON.parse(lines.slice(i, end + 1).join('\n')) as { remembered?: { id?: unknown }[]; restored?: { id?: unknown }[] };
					for (const e of [...(obj.remembered ?? []), ...(obj.restored ?? [])]) {
						if (typeof e?.id === 'string') {
							out.push(e.id);
						}
					}
				} catch {
					// not the add's object
				}
				i = end;
			}
		}
	}
	return [...new Set(out)];
}

// ---- the toast ---------------------------------------------------------------------------------

interface IToast {
	readonly slot: HTMLElement;
	readonly el: HTMLElement;
	prefs: IDispatchPref[];
	timer: ReturnType<typeof setTimeout> | undefined;
	left: number;
	started: number;
	readonly store: DisposableStore;
}
const toasts = new WeakMap<HTMLElement, IToast>();
const toasted = new Set<string>();

function slotOf(inputElement: HTMLElement): HTMLElement {
	let slot = inputElement.querySelector<HTMLElement>(':scope > .dispatch-prefs-toast-slot');
	if (!slot) {
		slot = dom.$('.dispatch-prefs-toast-slot');
		inputElement.prepend(slot);
	}
	return slot;
}

function toastText(prefs: IDispatchPref[]): { head: string; rest: string } {
	if (prefs.length === 1) {
		return { head: localize('dispatchPrefs.toastOne', "Preference remembered"), rest: prefs[0].text };
	}
	const names = prefs.slice(0, 2).map(p => p.name).join(', ');
	const more = prefs.length > 2 ? localize('dispatchPrefs.andMore', " and {0} more", prefs.length - 2) : '';
	return { head: localize('dispatchPrefs.toastMany', "{0} preferences remembered", prefs.length), rest: names + more };
}

function closeToast(t: IToast): void {
	if (t.timer) {
		clearTimeout(t.timer);
	}
	t.store.dispose();
	t.el.classList.add('out');
	const done = () => { t.el.remove(); toasts.delete(t.slot); };
	const reduced = dom.getWindow(t.el).matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	if (reduced) {
		done();
	} else {
		setTimeout(done, 200);
	}
}

function arm(t: IToast, ms: number): void {
	if (t.timer) {
		clearTimeout(t.timer);
	}
	t.left = ms;
	t.started = Date.now();
	t.timer = setTimeout(() => closeToast(t), ms);
}

function renderToast(t: IToast, commandService: ICommandService): void {
	const { head, rest } = toastText(t.prefs);
	dom.clearNode(t.el);
	t.store.clear();
	dom.append(t.el, dom.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.bookmark)));
	const text = dom.append(t.el, dom.$('span.tt'));
	dom.append(text, dom.$('b', undefined, head));
	text.append(` · ${rest}`);
	t.el.title = t.prefs.map(p => p.text).join('\n');
	const button = (label: string, run: () => void) => {
		const b = dom.append(t.el, dom.$('button.tb', { type: 'button' }, label));
		t.store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => { e.preventDefault(); run(); }));
	};
	button(localize('dispatchPrefs.edit', "Edit"), () => {
		const one = t.prefs.length === 1 ? t.prefs[0] : undefined;
		const line = one && RememberedLine.forPref(one.id);
		if (line) {
			line.edit(one.id);
		} else {
			void commandService.executeCommand(OPEN_KNOWLEDGE, one ? { view: 'pref', id: one.id, edit: true } : { view: 'prefs' });
		}
		closeToast(t);
	});
	button(localize('dispatchPrefs.undo', "Undo"), () => {
		const ids = t.prefs.map(p => p.id);
		// justSaid: one that was remembered before this reply only loses the words just said, it stays
		void ask<{ forgotten?: { name: string }[]; kept?: { name: string }[] }>(commandService, 'prefsForget', { ids, justSaid: true }).then(r => {
			fireDispatchPrefsChanged();
			const forgot = r?.forgotten ?? [];
			const kept = r?.kept ?? [];
			dom.clearNode(t.el);
			t.store.clear();
			dom.append(t.el, dom.$('span.icon' + ThemeIcon.asCSSSelector(forgot.length ? Codicon.discard : Codicon.bookmark)));
			let said: string;
			if (!kept.length) {
				said = forgot.length === 1
					? localize('dispatchPrefs.forgotOne', "Forgotten: {0}", forgot[0].name)
					: localize('dispatchPrefs.forgotMany', "Forgot {0} preferences", forgot.length);
			} else if (!forgot.length) {
				said = kept.length === 1
					? localize('dispatchPrefs.keptOne', "Kept: {0} was remembered before", kept[0].name)
					: localize('dispatchPrefs.keptMany', "Kept {0} that were remembered before", kept.length);
			} else {
				said = localize('dispatchPrefs.forgotKept', "Forgot {0}, kept {1} remembered before", forgot.length, kept.length);
			}
			dom.append(t.el, dom.$('span.tt', undefined, said));
			arm(t, 3000);
		}, () => closeToast(t));
	});
}

/** Show (or add to) the toast above this session's input. */
export function showDispatchPrefsToast(widgetService: IChatWidgetService, commandService: ICommandService, sessionResource: URI, prefs: IDispatchPref[]): void {
	const widget = widgetService.getWidgetBySessionResource(sessionResource);
	const input = widget?.input?.element;
	if (!input || !prefs.length) {
		return;
	}
	const slot = slotOf(input);
	let t = toasts.get(slot);
	if (t) {
		const have = new Set(t.prefs.map(p => p.id));
		t.prefs = [...t.prefs, ...prefs.filter(p => !have.has(p.id))];
	} else {
		const el = dom.append(slot, dom.$('.dispatch-prefs-toast', { role: 'status', 'aria-live': 'polite' }));
		t = { slot, el, prefs, timer: undefined, left: TOAST_MS, started: Date.now(), store: new DisposableStore() };
		toasts.set(slot, t);
		const tt = t;
		// held while the pointer is on it
		el.addEventListener('mouseenter', () => { if (tt.timer) { clearTimeout(tt.timer); tt.timer = undefined; tt.left = Math.max(1500, tt.left - (Date.now() - tt.started)); } });
		el.addEventListener('mouseleave', () => arm(tt, tt.left));
	}
	renderToast(t, commandService);
	arm(t, TOAST_MS);
}

// ---- the line under a reply ---------------------------------------------------------------------

function polarityIcon(p: IDispatchPref): ThemeIcon {
	return p.polarity === 'avoid' ? Codicon.circleSlash : Codicon.thumbsup;
}

function areaLabel(area: string): string {
	switch (area) {
		case 'design': return localize('dispatchPrefs.design', "Design");
		case 'workflow': return localize('dispatchPrefs.workflow', "Workflow");
		case 'writing': return localize('dispatchPrefs.writing', "Writing");
		case 'tools': return localize('dispatchPrefs.tools', "Tools");
		default: return area;
	}
}

class RememberedLine {
	private static readonly lines = new Map<string, RememberedLine>();

	static forPref(id: string): RememberedLine | undefined {
		return RememberedLine.lines.get(id);
	}

	private prefs: IDispatchPref[] = [];
	private open = false;
	private editing: string | undefined;
	private readonly store = new DisposableStore();
	private readonly renderStore = new DisposableStore();

	constructor(
		readonly domNode: HTMLElement,
		private readonly ids: string[],
		private readonly commandService: ICommandService,
		private readonly onLoaded: (prefs: IDispatchPref[]) => void,
	) {
		for (const id of ids) {
			RememberedLine.lines.set(id, this);
		}
		this.store.add(onDidChangeDispatchPrefs(() => void this.load()));
		void this.load();
	}

	dispose(): void {
		for (const id of this.ids) {
			if (RememberedLine.lines.get(id) === this) {
				RememberedLine.lines.delete(id);
			}
		}
		this.store.dispose();
		this.renderStore.dispose();
	}

	edit(id: string): void {
		this.editing = id;
		if (this.ids.length > 1) {
			this.open = true;
		}
		this.render();
		this.domNode.scrollIntoView({ block: 'nearest' });
	}

	private async load(): Promise<void> {
		try {
			this.prefs = await prefsByIds(this.commandService, this.ids);
		} catch {
			this.prefs = [];
		}
		this.render();
		this.onLoaded(this.prefs);
	}

	private link(parent: HTMLElement, label: string, run: () => void): void {
		const a = dom.append(parent, dom.$('a.a', { role: 'button', tabindex: '0' }, label));
		const go = (e: Event) => { e.preventDefault(); e.stopPropagation(); run(); };
		this.renderStore.add(dom.addDisposableListener(a, dom.EventType.CLICK, go));
		this.renderStore.add(dom.addDisposableListener(a, dom.EventType.KEY_DOWN, e => { if (e.key === 'Enter') { go(e); } }));
	}

	private async act(op: string, payload: Record<string, unknown>): Promise<void> {
		try {
			await ask(this.commandService, op, payload);
		} finally {
			fireDispatchPrefsChanged();
		}
	}

	private render(): void {
		this.renderStore.clear();
		dom.clearNode(this.domNode);
		if (!this.prefs.length) {
			return;
		}
		const live = this.prefs.filter(p => p.status !== 'forgotten');
		const line = dom.append(this.domNode, dom.$('.dispatch-prefs-line'));
		if (this.prefs.length === 1) {
			const p = this.prefs[0];
			if (p.status === 'forgotten') {
				dom.append(line, dom.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.discard)));
				dom.append(line, dom.$('span.s', undefined, localize('dispatchPrefs.forgotten', "Forgotten: {0}", p.name)));
				this.link(line, localize('dispatchPrefs.undo', "Undo"), () => void this.act('prefsUndo', { id: p.id }));
				return;
			}
			if (this.editing === p.id) {
				this.renderEditor(this.domNode, p, true);
				line.remove();
				return;
			}
			dom.append(line, dom.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.bookmark)));
			const s = dom.append(line, dom.$('span.s', undefined, localize('dispatchPrefs.remembered', "Remembered: ")));
			dom.append(s, dom.$('b', undefined, p.text));
			line.title = p.text;
			this.link(line, localize('dispatchPrefs.edit', "Edit"), () => this.edit(p.id));
			this.link(line, localize('dispatchPrefs.forget', "Forget"), () => void this.act('prefsForget', { ids: [p.id] }));
			return;
		}
		dom.append(line, dom.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.bookmark)));
		const s = dom.append(line, dom.$('span.s', undefined, localize('dispatchPrefs.rememberedMany', "Remembered {0} from your feedback: ", live.length)));
		live.slice(0, 3).forEach((p, i) => {
			if (i) {
				s.append(', ');
			}
			dom.append(s, dom.$('b', undefined, p.name));
		});
		if (live.length > 3) {
			s.append(localize('dispatchPrefs.andMore', " and {0} more", live.length - 3));
		}
		this.link(line, this.open ? localize('dispatchPrefs.hide', "Hide") : localize('dispatchPrefs.show', "Show"), () => { this.open = !this.open; this.render(); });
		if (!this.open) {
			return;
		}
		const list = dom.append(this.domNode, dom.$('.dispatch-prefs-rows'));
		for (const p of this.prefs) {
			const row = dom.append(list, dom.$('.dispatch-prefs-row'));
			if (p.status === 'forgotten') {
				row.classList.add('done');
				dom.append(row, dom.$('span.icon' + ThemeIcon.asCSSSelector(Codicon.discard)));
				dom.append(row, dom.$('span.s', undefined, localize('dispatchPrefs.forgotten', "Forgotten: {0}", p.name)));
				this.link(row, localize('dispatchPrefs.undo', "Undo"), () => void this.act('prefsUndo', { id: p.id }));
				continue;
			}
			dom.append(row, dom.$('span.icon.pol' + ThemeIcon.asCSSSelector(polarityIcon(p))));
			const body = dom.append(row, dom.$('.b'));
			if (this.editing === p.id) {
				this.renderEditor(body, p, false);
				continue;
			}
			dom.append(body, dom.$('.t', undefined, p.text));
			const meta = dom.append(body, dom.$('.m'));
			dom.append(meta, dom.$('span', undefined, [p.polarity === 'avoid' ? localize('dispatchPrefs.avoid', "Avoid") : localize('dispatchPrefs.like', "Like"), areaLabel(p.area), p.scope_label || p.scope || ''].filter(Boolean).join(' · ')));
			if (p.thumb) {
				const chip = dom.append(meta, dom.$('span.part'));
				const img = dom.append(chip, dom.$('img')) as HTMLImageElement;
				img.src = p.thumb;
				img.alt = '';
				dom.append(chip, dom.$('span', undefined, (p.part || '').split('#')[1] || localize('dispatchPrefs.whole', "Whole delivery")));
			}
			const acts = dom.append(row, dom.$('.acts'));
			this.link(acts, localize('dispatchPrefs.edit', "Edit"), () => this.edit(p.id));
			this.link(acts, localize('dispatchPrefs.forget', "Forget"), () => void this.act('prefsForget', { ids: [p.id] }));
		}
	}

	private renderEditor(parent: HTMLElement, p: IDispatchPref, single: boolean): void {
		const box = dom.append(parent, dom.$('.dispatch-prefs-edit'));
		const ta = dom.append(box, dom.$('textarea', { 'aria-label': localize('dispatchPrefs.sentence', "Preference") })) as HTMLTextAreaElement;
		ta.value = p.text;
		let polarity = p.polarity;
		const bar = dom.append(box, dom.$('.bar'));
		const seg = dom.append(bar, dom.$('.seg', { role: 'radiogroup', 'aria-label': localize('dispatchPrefs.kind', "Kind") }));
		const choices: HTMLElement[] = [];
		for (const [value, label] of [['like', localize('dispatchPrefs.like', "Like")], ['avoid', localize('dispatchPrefs.avoid', "Avoid")]] as const) {
			const b = dom.append(seg, dom.$('button.seg-b', { type: 'button', role: 'radio' }, label));
			choices.push(b);
			const sync = () => choices.forEach((c, i) => { const on = (i === 0 ? 'like' : 'avoid') === polarity; c.classList.toggle('on', on); c.setAttribute('aria-checked', String(on)); });
			this.renderStore.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => { polarity = value; sync(); }));
			sync();
		}
		dom.append(bar, dom.$('span.fill'));
		const cancel = dom.append(bar, dom.$('button.btn', { type: 'button' }, localize('dispatchPrefs.cancel', "Cancel")));
		const save = dom.append(bar, dom.$('button.btn.primary', { type: 'button' }, localize('dispatchPrefs.save', "Save")));
		const done = () => { this.editing = undefined; this.render(); };
		const submit = async () => {
			const text = ta.value.trim();
			if (!text) {
				return;
			}
			const payload: Record<string, unknown> = { id: p.id };
			if (text !== p.text) {
				payload.text = text;
			}
			if (polarity !== p.polarity) {
				payload.polarity = polarity;
			}
			this.editing = undefined;
			if (Object.keys(payload).length > 1) {
				await this.act('prefsEdit', payload).catch(() => undefined);
			} else {
				this.render();
			}
		};
		this.renderStore.add(dom.addDisposableListener(cancel, dom.EventType.CLICK, done));
		this.renderStore.add(dom.addDisposableListener(save, dom.EventType.CLICK, () => void submit()));
		this.renderStore.add(dom.addDisposableListener(ta, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
		}));
		box.classList.toggle('single', single);
		setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
	}
}

/**
 * The tool call part for a finished `dispatch prefs add` (chatToolInvocationPart.ts picks it for a
 * terminal call {@link dispatchPrefIds} finds ids in): the grey line, and the toast when the call just
 * finished in a session on screen.
 */
export class DispatchPrefsRememberedPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;
	public readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		@ICommandService commandService: ICommandService,
		@IChatWidgetService widgetService: IChatWidgetService,
	) {
		super(toolInvocation);
		this.domNode = dom.$('.dispatch-prefs-remembered');
		const ids = dispatchPrefIds(toolInvocation);
		const live = toolInvocation.kind === 'toolInvocation';
		const key = toolInvocation.toolCallId;
		const line = new RememberedLine(this.domNode, ids, commandService, prefs => {
			// the toast: once per call, only for one that just finished in this window
			if (!live || toasted.has(key)) {
				return;
			}
			toasted.add(key);
			const now = Date.now();
			const fresh = prefs.filter(p => p.status !== 'forgotten' && now - Date.parse(p.updated || p.created || '') < FRESH_MS);
			if (fresh.length) {
				showDispatchPrefsToast(widgetService, commandService, context.element.sessionResource, fresh);
			}
		});
		this._register(toDisposable(() => line.dispose()));
	}
}

// ---- under a finished reply ---------------------------------------------------------------------

/**
 * When a reply is done, VS Code folds its steps (and so the Remembered lines of its `dispatch prefs add`
 * calls) into "Completed N steps". One line for all of them goes under the reply instead, above its
 * footer, outside the folded part: chatListRenderer.ts calls this whenever it settles a response row.
 */
interface IFooter { readonly el: HTMLElement; readonly key: string; readonly line: RememberedLine }
const footers = new WeakMap<HTMLElement, IFooter>();

function idsOfResponse(element: IChatResponseViewModel): string[] {
	const out: string[] = [];
	for (const part of element.response.value) {
		if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
			for (const id of dispatchPrefIds(part)) {
				if (!out.includes(id)) {
					out.push(id);
				}
			}
		}
	}
	return out;
}

export function removeDispatchPrefsFooter(value: HTMLElement): void {
	const f = footers.get(value);
	if (f) {
		f.line.dispose();
		f.el.remove();
		footers.delete(value);
	}
}

export function renderDispatchPrefsFooter(commandService: ICommandService, value: HTMLElement, footerToolbar: HTMLElement | undefined, element: IChatResponseViewModel): void {
	const ids = element.isComplete ? idsOfResponse(element) : [];
	const key = ids.length ? `${element.id}:${ids.join(',')}` : '';
	const f = footers.get(value);
	if (f && f.key === key) {
		return;
	}
	removeDispatchPrefsFooter(value);
	if (!ids.length) {
		return;
	}
	const el = dom.$('.dispatch-prefs-remembered.dispatch-prefs-footer');
	if (footerToolbar && footerToolbar.parentElement === value.parentElement) {
		footerToolbar.before(el);
	} else {
		value.after(el);
	}
	footers.set(value, { el, key, line: new RememberedLine(el, ids, commandService, () => { }) });
}

// ---- short names in a reply -----------------------------------------------------------------------

const NAMES_MS = 60_000;
let namesCache: { at: number; value: Promise<Map<string, string>> } | undefined;
const SKIP = 'a, pre, code, button, textarea, .monaco-editor, .interactive-result-code-block, .chat-inline-anchor-widget, .dispatch-path-link, .dispatch-task-link, .dispatch-pref-link';

function prefNames(commandService: ICommandService): Promise<Map<string, string>> {
	if (!namesCache || Date.now() - namesCache.at > NAMES_MS) {
		const value = ask<{ items: IDispatchPref[] }>(commandService, 'prefsNames', {})
			.then(r => new Map(r.items.filter(p => (p.status ?? 'active') === 'active' && p.name).map(p => [p.name, p.id])), () => new Map<string, string>());
		namesCache = { at: Date.now(), value };
	}
	return namesCache.value;
}
onDidChangeDispatchPrefs(() => { namesCache = undefined; });

/** 「（方角开关）」 in a finished reply: the name links to the preference, and counts as followed once. */
export function linkifyDispatchPrefs(accessor: ServicesAccessor, root: HTMLElement, element: IChatResponseViewModel): IDisposable {
	const commandService = accessor.get(ICommandService);
	const store = new DisposableStore();
	if (!CommandsRegistry.getCommand(KNOWLEDGE) && !CommandsRegistry.getCommand(OPEN_KNOWLEDGE)) {
		return store;
	}
	if (!/[（(][^）)\n]{2,40}[）)]/.test(root.textContent ?? '')) {
		return store;
	}
	let disposed = false;
	store.add(toDisposable(() => { disposed = true; }));
	void prefNames(commandService).then(names => {
		if (disposed || !names.size) {
			return;
		}
		const cited = new Set<string>();
		const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.parentElement && !n.parentElement.closest(SKIP) && /[（(]/.test(n.textContent ?? '')) {
				nodes.push(n as Text);
			}
		}
		for (const node of nodes) {
			const text = node.textContent ?? '';
			const re = /([（(])([^（）()\n]{2,40})([）)])/g;
			let m: RegExpExecArray | null;
			let at = 0;
			const frag = node.ownerDocument.createDocumentFragment();
			let hit = false;
			while ((m = re.exec(text))) {
				const id = names.get(m[2].trim());
				if (!id) {
					continue;
				}
				hit = true;
				cited.add(m[2].trim());
				frag.append(text.slice(at, m.index) + m[1]);
				const span = node.ownerDocument.createElement('span');
				span.className = 'dispatch-pref-link';
				span.textContent = m[2];
				span.tabIndex = 0;
				span.setAttribute('role', 'link');
				span.title = localize('dispatchPrefs.openPref', "Open this preference in Knowledge");
				const open = (e: Event) => { e.preventDefault(); e.stopPropagation(); void commandService.executeCommand(OPEN_KNOWLEDGE, { view: 'pref', id }); };
				store.add(dom.addDisposableListener(span, dom.EventType.CLICK, open));
				store.add(dom.addDisposableListener(span, dom.EventType.KEY_DOWN, e => { if (e.key === 'Enter') { open(e); } }));
				frag.append(span, m[3]);
				at = m.index + m[0].length;
			}
			if (hit) {
				frag.append(text.slice(at));
				node.replaceWith(frag);
			}
		}
		// followed: once per reply however often it renders (the CLI keeps the reply's id)
		if (cited.size && element.isComplete) {
			void ask(commandService, 'prefsCite', { names: [...cited], ref: element.id }).catch(() => undefined);
		}
	});
	return store;
}
