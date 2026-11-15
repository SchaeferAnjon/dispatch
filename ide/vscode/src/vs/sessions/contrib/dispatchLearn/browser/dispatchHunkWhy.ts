/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Why and More on every block of the Changes tab (learning while the agent works, the third part,
 *  user 2026-11-15, task-39x97, kanban design/learn-scene frame 4; the person: "终端生成的文件我从来不看，黑箱子让人
 *  不安心").
 *
 *  - Each block of lines a diff in Changes shows has two small text buttons at its top right, "Why" and "More", the
 *    way VS Code's own hunk toolbar sits on a block the agent changed (chatEditingCodeEditorIntegration's
 *    DiffHunkWidget): they show while the pointer is over the block, the cursor is in it or they have the keyboard
 *    (every one is a Tab stop), and stay while the block's Why is open.
 *  - Why opens one or two sentences right under the block (a view zone), and closes again with Why, the ⌃ in the box
 *    or Esc. The words: what the walk of the same turn already has for these lines, a new file's first comment, the
 *    agent's own sentence before it changed the file; else one call to the session's own agent for every block of
 *    Changes with nothing said, this one first (IDispatchWalkService.why). The agent is never interrupted.
 *  - More asks about the block in the side chat card; where side chats are not there (OpenCode) its lines go into the
 *    conversation's input as a quote (dispatchQuote's Ask Question and Quote, as a selection in the diff does).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor, IDiffEditor, IOverlayWidget, IOverlayWidgetPosition, IViewZone, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { ILineChange } from '../../../../editor/common/diff/legacyLinesDiffComputer.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { addQuoteToWidget, DISPATCH_ASK_COMMAND, DISPATCH_QUOTE_COMMAND, IDispatchQuoteFileArgs, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { stopLines } from '../common/dispatchWalkModel.js';
import { IDispatchWalkService, IWhyAnswer } from './dispatchWalkService.js';

/** At most this many lines of a block go to the model or into a quote. */
const MAX_LINES = 60;
/** The buttons' height (22 high pills) and the room around an open Why's box. */
const BUTTONS_HEIGHT = 24;
const ZONE_PADDING = 12;

/** One block of the diff: its lines now (a block that only removed lines: the line before the gap), and before. */
interface IBlock {
	readonly start: number;
	readonly end: number;
	readonly removedOnly: boolean;
	readonly ostart: number;
	readonly oend: number;
}

function blocksOf(changes: readonly ILineChange[]): IBlock[] {
	return changes.map(c => {
		const removedOnly = c.modifiedEndLineNumber === 0;
		const start = Math.max(1, c.modifiedStartLineNumber);
		return { start, end: removedOnly ? start : c.modifiedEndLineNumber, removedOnly, ostart: c.originalStartLineNumber, oend: c.originalEndLineNumber };
	});
}

const key = (b: IBlock) => `${b.start}-${b.end}:${b.ostart}-${b.oend}`;

/** What the buttons of a block do. */
interface IButtonsHost {
	why(): void;
	more(): void;
	/** The pointer came onto the buttons. */
	enter(): void;
	/** The keyboard came or went. */
	focus(): void;
	/** Esc: closes the block's Why when it is open (true), else nothing. */
	escape(): boolean;
}

/** The two buttons over one block, as an overlay widget of the diff's modified side. */
class BlockButtons implements IOverlayWidget {
	private static _n = 0;
	private readonly _id = `dispatch-hunk-why-${BlockButtons._n++}`;
	readonly domNode: HTMLElement;
	readonly why: HTMLButtonElement;
	readonly more: HTMLButtonElement;
	private _position: IOverlayWidgetPosition | null = null;
	private readonly _store = new DisposableStore();

	constructor(private readonly _editor: ICodeEditor, block: IBlock, host: IButtonsHost) {
		this.domNode = dom.$('.dispatch-hunk-why');
		this.domNode.dataset.part = 'hunk-why-buttons';
		this.domNode.dataset.start = String(block.start);
		this.domNode.dataset.end = String(block.end);
		const lines = stopLines(block);
		this.why = dom.append(this.domNode, dom.$<HTMLButtonElement>('button.dispatch-hunk-btn', { type: 'button' }, localize('dispatchHunkWhy.why', "Why")));
		this.why.dataset.part = 'hunk-why';
		this.why.title = localize('dispatchHunkWhy.whyTitle', "Why was this changed? ({0})", lines);
		this.why.setAttribute('aria-expanded', 'false');
		this.more = dom.append(this.domNode, dom.$<HTMLButtonElement>('button.dispatch-hunk-btn', { type: 'button' }, localize('dispatchHunkWhy.more', "More")));
		this.more.dataset.part = 'hunk-more';
		this.more.title = localize('dispatchHunkWhy.moreTitle', "Ask more about {0}", lines);
		const click = (b: HTMLElement, run: () => void) => this._store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => { e.preventDefault(); e.stopPropagation(); run(); }));
		click(this.why, () => host.why());
		click(this.more, () => host.more());
		this._store.add(dom.addDisposableListener(this.domNode, dom.EventType.MOUSE_ENTER, () => host.enter()));
		this._store.add(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_IN, () => host.focus()));
		this._store.add(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_OUT, () => host.focus()));
		this._store.add(dom.addDisposableListener(this.domNode, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && host.escape()) {
				e.preventDefault();
				e.stopPropagation();
				this.why.focus();
			}
		}));
		this._editor.addOverlayWidget(this);
	}

	getId(): string { return this._id; }
	getDomNode(): HTMLElement { return this.domNode; }
	getPosition(): IOverlayWidgetPosition | null { return this._position; }

	setOpen(open: boolean): void {
		this.why.classList.toggle('active', open);
		this.why.setAttribute('aria-expanded', String(open));
	}

	/** Out of the way and out of the Tab order while the block's Why is open. */
	setHidden(hidden: boolean): void {
		this.domNode.classList.toggle('hidden', hidden);
		this.why.tabIndex = this.more.tabIndex = hidden ? -1 : 0;
	}

	/** Where the buttons start, from the editor's left. */
	left(): number {
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this._editor.getLayoutInfo();
		return Math.max(contentLeft, contentLeft + contentWidth - verticalScrollbarWidth - (this.domNode.offsetWidth || 96) - 8);
	}

	layout(top: number): void {
		this._position = { stackOrdinal: 1, preference: { top, left: this.left() } };
		this._editor.layoutOverlayWidget(this);
	}

	dispose(): void {
		this._store.dispose();
		this._editor.removeOverlayWidget(this);
	}
}

/**
 * An open Why: a view zone of the modified side makes room under the block, and the box is an overlay widget kept on
 * the zone (VS Code's ZoneWidget does the same: the lines are drawn over view zones, so a zone's own buttons would not
 * take a click).
 */
interface IOpen {
	readonly zone: IViewZone;
	id: string;
	readonly widget: IOverlayWidget;
	readonly node: HTMLElement;
	readonly box: HTMLElement;
}

let overlays = 0;

interface IHost {
	readonly walk: IDispatchWalkService;
	readonly chatWidgets: IChatWidgetService;
	readonly commands: ICommandService;
	readonly sessions: ISessionsService;
	readonly log: ILogService;
	readonly reduceMotion: () => boolean;
}

/** One diff editor of Changes: its blocks, their buttons, the Whys open under them. */
class DiffWhy extends Disposable {
	private _blocks: IBlock[] = [];
	private readonly _buttons = this._register(new DisposableMap<string, BlockButtons>());
	private readonly _open = new Map<string, IOpen>();
	private _hover: string | undefined;
	private _cursor: string | undefined;
	/** Buttons put on the line above their block: that line, by block. On the way up to them the pointer crosses it. */
	private readonly _raised = new Map<string, number>();
	private readonly _frames = this._register(new DisposableStore());

	constructor(private readonly _diff: IDiffEditor, private readonly _host: IHost) {
		super();
		const modified = _diff.getModifiedEditor();
		const original = _diff.getOriginalEditor();
		this._register(_diff.onDidUpdateDiff(() => this.refresh()));
		this._register(_diff.onDidChangeModel(() => { this.closeAll(); this.refresh(); }));
		// a diff is made before it is put into Changes: looked at again once it is laid out there
		this._register(modified.onDidLayoutChange(() => this._buttons.size ? this.layout() : this.refresh()));
		this._register(modified.onDidScrollChange(() => this.layout()));
		this._register(modified.onDidContentSizeChange(() => this.layout()));
		this._register(modified.onMouseMove(e => {
			const t = e.target;
			if (t.type === MouseTargetType.OVERLAY_WIDGET) {
				const over = [...this._buttons].find(([, w]) => w.getId() === t.detail)?.[0] ?? [...this._open].find(([, o]) => o.widget.getId() === t.detail)?.[0];
				this.setHover(over ?? this._hover);
			} else if (t.type === MouseTargetType.CONTENT_VIEW_ZONE) {
				// an open Why keeps its block; deleted lines shown inline sit after the line before them
				const open = [...this._open].find(([, o]) => o.id === t.detail.viewZoneId)?.[0];
				this.setHover(open ?? this.blockAtGap(t.detail.afterLineNumber));
			} else {
				const line = t.position?.lineNumber;
				const raised = this._hover !== undefined && line !== undefined && this._raised.get(this._hover) === line;
				this.setHover(line === undefined ? undefined : this.blockAt(line) ?? (raised ? this._hover : undefined));
			}
		}));
		this._register(modified.onMouseLeave(e => {
			// onto the buttons (an overlay over the lines): kept
			const to = e.event.browserEvent.relatedTarget as HTMLElement | null;
			if (!to?.closest?.('.dispatch-hunk-why')) {
				this.setHover(undefined);
			}
		}));
		this._register(original.onMouseMove(e => {
			const line = e.target.position?.lineNumber;
			const b = line ? this._blocks.find(x => x.oend > 0 && x.ostart <= line && line <= x.oend) : undefined;
			this.setHover(b ? key(b) : undefined);
		}));
		this._register(original.onMouseLeave(() => this.setHover(undefined)));
		// the keyboard's way: the cursor in a block shows its buttons
		this._register(modified.onDidChangeCursorPosition(e => {
			this._cursor = modified.hasTextFocus() ? this.blockAt(e.position.lineNumber) : undefined;
			this.show();
		}));
		this._register(modified.onDidBlurEditorText(() => { this._cursor = undefined; this.show(); }));
		this._register(toDisposable(() => this.closeAll()));
		this.refresh();
	}

	private inChanges(): boolean {
		return !!this._diff.getContainerDomNode().closest('.session-changes-editor');
	}

	private blockAt(line: number): string | undefined {
		const b = this._blocks.find(x => !x.removedOnly && x.start <= line && line <= x.end) ?? this._blocks.find(x => x.removedOnly && x.start === line);
		return b ? key(b) : undefined;
	}

	/** Deleted lines drawn inline after line `after`: the block they belong to. */
	private blockAtGap(after: number): string | undefined {
		const b = this._blocks.find(x => x.oend > 0 && (x.removedOnly ? x.start === after : x.start - 1 === after));
		return b ? key(b) : undefined;
	}

	private setHover(k: string | undefined): void {
		if (k !== this._hover) {
			this._hover = k;
			this.show();
		}
	}

	private refresh(): void {
		const changes = this.inChanges() && this._diff.getModel() ? this._diff.getLineChanges() : null;
		if (!changes) {
			this._buttons.clearAndDisposeAll();
			this.closeAll();
			this._blocks = [];
			return;
		}
		const blocks = blocksOf(changes);
		const keys = new Set(blocks.map(key));
		this._blocks = blocks;
		for (const k of [...this._buttons.keys()]) {
			if (!keys.has(k)) {
				this._buttons.deleteAndDispose(k);
			}
		}
		for (const k of [...this._open.keys()]) {
			if (!keys.has(k)) {
				this.close(k);
			}
		}
		const modified = this._diff.getModifiedEditor();
		for (const b of blocks) {
			const k = key(b);
			if (!this._buttons.has(k)) {
				const w = new BlockButtons(modified, b, {
					why: () => this.toggle(k),
					more: () => void this.more(k),
					enter: () => this.setHover(k),
					focus: () => this.show(),
					escape: () => this._open.has(k) ? (this.close(k), true) : false,
				});
				this._buttons.set(k, w);
			}
		}
		this.layout();
		this.show();
	}

	/**
	 * Which buttons show: the block pointed at, the cursor's, the one with the keyboard. A block whose Why is open has
	 * none: they would cover the change it explains, and the box has its own More and ⌃ (designer review, task-39x97).
	 */
	private show(): void {
		const active = dom.getActiveElement();
		for (const [k, w] of this._buttons) {
			const open = this._open.has(k);
			w.domNode.classList.toggle('on', !open && (k === this._hover || k === this._cursor || (!!active && w.domNode.contains(active))));
			w.setHidden(open);
		}
	}

	private layout(): void {
		const modified = this._diff.getModifiedEditor();
		const scroll = modified.getScrollTop();
		const lineHeight = modified.getOption(EditorOption.lineHeight);
		const model = modified.getModel();
		const { contentLeft } = modified.getLayoutInfo();
		this._raised.clear();
		for (const b of this._blocks) {
			const w = this._buttons.get(key(b));
			if (!w || !model) {
				continue;
			}
			// a block that only removed lines: where they are shown, after the line before them
			let top = b.removedOnly ? modified.getBottomForLineNumber(b.start) : modified.getTopForLineNumber(b.start);
			// the first line's words run under the buttons: they go up onto the line above the block (above the lines it
			// removed when those are shown inline), so the change itself stays readable (designer review, task-39x97)
			if (!b.removedOnly && b.start <= model.getLineCount()) {
				const textRight = contentLeft + modified.getOffsetForColumn(b.start, model.getLineMaxColumn(b.start)) - modified.getScrollLeft();
				const removedInline = !this._diff.renderSideBySide && b.oend > 0 ? (b.oend - b.ostart + 1) * lineHeight : 0;
				if (textRight > w.left() - 8 && top - removedInline >= lineHeight) {
					top -= removedInline + lineHeight;
					this._raised.set(key(b), b.start - 1);
				}
			}
			// the buttons' middle on the line's middle
			w.layout(top - scroll + Math.round((lineHeight - BUTTONS_HEIGHT) / 2));
		}
		for (const o of this._open.values()) {
			this.fitWidth(o);
		}
	}

	private fitWidth(o: IOpen): void {
		const { contentLeft, contentWidth, verticalScrollbarWidth } = this._diff.getModifiedEditor().getLayoutInfo();
		o.node.style.left = `${contentLeft}px`;
		o.box.style.width = `${Math.max(160, contentWidth - verticalScrollbarWidth - 16)}px`;
	}

	private toggle(k: string): void {
		if (this._open.has(k)) {
			this.close(k);
		} else {
			void this.open(k);
		}
	}

	private close(k: string): void {
		const o = this._open.get(k);
		if (!o) {
			return;
		}
		this._open.delete(k);
		const modified = this._diff.getModifiedEditor();
		modified.changeViewZones(a => a.removeZone(o.id));
		modified.removeOverlayWidget(o.widget);
		this._buttons.get(k)?.setOpen(false);
		this.show();
	}

	private closeAll(): void {
		for (const k of [...this._open.keys()]) {
			this.close(k);
		}
	}

	/** The block's lines before (-) and now (+). */
	private code(b: IBlock): string {
		const model = this._diff.getModel();
		if (!model) {
			return '';
		}
		const out: string[] = [];
		for (let i = b.ostart; b.oend > 0 && i <= b.oend && out.length < MAX_LINES; i++) {
			out.push(`-${model.original.getLineContent(i)}`);
		}
		for (let i = b.start; !b.removedOnly && i <= b.end && out.length < MAX_LINES; i++) {
			out.push(`+${model.modified.getLineContent(i)}`);
		}
		return out.join('\n');
	}

	private async open(k: string): Promise<void> {
		const b = this._blocks.find(x => key(x) === k);
		const model = this._diff.getModel();
		if (!b || !model) {
			return;
		}
		const node = dom.$('.dispatch-hunk-expl');
		node.dataset.part = 'hunk-why-open';
		node.dataset.start = String(b.start);
		node.dataset.end = String(b.end);
		node.dataset.state = 'asking';
		node.classList.toggle('still', this._host.reduceMotion());
		const box = dom.append(node, dom.$('.dispatch-hunk-box'));
		const head = dom.append(box, dom.$('.dhw-head'));
		dom.append(head, dom.$('span.dhw-label', undefined, localize('dispatchHunkWhy.whyLabel', "Why")));
		const more = dom.append(head, dom.$<HTMLButtonElement>('button.dhw-more', { type: 'button', title: localize('dispatchHunkWhy.moreTitle2', "Ask more about these lines") }, localize('dispatchHunkWhy.more', "More")));
		more.dataset.part = 'hunk-why-more';
		more.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void this.more(k); });
		const hide = dom.append(head, dom.$<HTMLButtonElement>('button.dhw-hide', { type: 'button', title: localize('dispatchHunkWhy.hide', "Hide (Esc)") }));
		hide.setAttribute('aria-label', localize('dispatchHunkWhy.hideLabel', "Hide why"));
		hide.dataset.part = 'hunk-why-hide';
		dom.append(hide, dom.$(ThemeIcon.asCSSSelector(Codicon.chevronUp)));
		const text = dom.append(box, dom.$('.dhw-text.asking', undefined, localize('dispatchHunkWhy.finding', "Finding out why...")));
		text.dataset.part = 'hunk-why-text';
		text.setAttribute('aria-live', 'polite');
		const back = () => { this.close(k); this._buttons.get(k)?.why.focus(); };
		node.addEventListener('keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				back();
			}
		});
		hide.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); back(); });

		node.style.top = '-1000px';
		const widgetId = `dispatch-hunk-why-open-${overlays++}`;
		const widget: IOverlayWidget = { getId: () => widgetId, getDomNode: () => node, getPosition: () => null };
		const o: IOpen = {
			// the room under the block; the box follows its top as the diff scrolls and lays out
			zone: { afterLineNumber: b.end, heightInPx: 72, domNode: dom.$('.dispatch-hunk-room'), suppressMouseDown: true, onDomNodeTop: top => { node.style.top = `${top}px`; } },
			id: '', widget, node, box,
		};
		const modified = this._diff.getModifiedEditor();
		modified.addOverlayWidget(widget);
		modified.changeViewZones(a => { o.id = a.addZone(o.zone); });
		const hadKeyboard = !!this._buttons.get(k)?.domNode.contains(dom.getActiveElement());
		this._open.set(k, o);
		this._buttons.get(k)?.setOpen(true);
		this.fitWidth(o);
		this.fit(o);
		this.show();
		if (hadKeyboard) {
			hide.focus();
		}

		const t0 = Date.now();
		let answer: IWhyAnswer;
		try {
			answer = await this._host.walk.why({ uri: model.modified.uri, start: b.start, end: b.end, isNew: model.original.getValueLength() === 0, code: this.code(b) });
		} catch (err) {
			this._host.log.error('[dispatch] why: could not find out why', err);
			answer = { text: localize('dispatchHunkWhy.failed', "Could not find out why. Use More to ask."), source: 'none', fromWalk: false };
		}
		if (this._open.get(k) !== o) {
			return; // closed, or the diff changed meanwhile
		}
		text.classList.remove('asking');
		text.classList.toggle('none', answer.source === 'none');
		text.textContent = answer.text;
		Object.assign(node.dataset, {
			state: 'done', source: answer.source, fromWalk: String(answer.fromWalk), ms: String(Date.now() - t0),
			modelMs: answer.ms !== undefined ? String(answer.ms) : '', asked: answer.asked !== undefined ? String(answer.asked) : '', by: answer.by ?? '',
		});
		this.fit(o);
	}

	/** The zone as high as the box in it, once the box is drawn. */
	private fit(o: IOpen): void {
		this._frames.add(dom.scheduleAtNextAnimationFrame(dom.getWindow(this._diff.getContainerDomNode()), () => {
			const h = Math.ceil(o.box.offsetHeight) + ZONE_PADDING;
			if (h > ZONE_PADDING && h !== o.zone.heightInPx && [...this._open.values()].includes(o)) {
				o.zone.heightInPx = h;
				this._diff.getModifiedEditor().changeViewZones(a => a.layoutZone(o.id));
			}
		}));
	}

	/** More: the block in the side chat card, or its lines quoted into the conversation's input. */
	private async more(k: string): Promise<void> {
		const b = this._blocks.find(x => key(x) === k);
		const model = this._diff.getModel();
		if (!b || !model) {
			return;
		}
		const lines: string[] = [];
		const side = b.removedOnly ? model.original : model.modified;
		for (let i = b.removedOnly ? b.ostart : b.start; i <= (b.removedOnly ? b.oend : b.end) && lines.length < MAX_LINES; i++) {
			lines.push(side.getLineContent(i));
		}
		const end = Math.min(b.end, model.modified.getLineCount());
		const args: IDispatchQuoteFileArgs = {
			uri: model.modified.uri.toString(),
			originalUri: model.original.uri.toString(),
			startLineNumber: b.start,
			startColumn: 1,
			endLineNumber: end,
			endColumn: model.modified.getLineMaxColumn(end),
			text: lines.join('\n'),
			from: 'diff',
		};
		const session = this._host.sessions.activeSession.get();
		const sideChat = !!session?.capabilities.get().supportsSideChat;
		this._host.log.info(`[dispatch] why: More on lines ${b.start}-${b.end}, ${sideChat ? 'in a side chat' : 'quoted into the conversation'}`);
		if (sideChat || !session) {
			await this._host.commands.executeCommand(DISPATCH_ASK_COMMAND, args);
			return;
		}
		const main = session.mainChat.get().resource;
		const widget = this._host.chatWidgets.getWidgetBySessionResource(main) ?? await whenChatWidgetForSession(this._host.chatWidgets, main, 3000);
		if (!widget) {
			await this._host.commands.executeCommand(DISPATCH_QUOTE_COMMAND, args);
			return;
		}
		const uri = model.modified.uri;
		const bases = session.workspace.get()?.folders.flatMap(f => [f.workingDirectory, f.gitRepository?.workTreeUri, f.root]) ?? [];
		const file = bases.map(base => base && relativePath(base, uri)).find(rel => rel && !rel.startsWith('..')) || basename(uri);
		addQuoteToWidget(widget, toQuoteEntry(args.text, {
			from: 'diff', label: `${basename(uri)} · ${stopLines({ start: b.start, end })} · Changes`, icon: Codicon.diffSingle.id,
			uri: uri.toString(), originalUri: model.original.uri.toString(), file, startLine: b.start, endLine: end,
		}));
	}
}

class DispatchHunkWhy extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchHunkWhy';

	private readonly _diffs = this._register(new DisposableMap<IDiffEditor, DiffWhy>());

	constructor(
		@ICodeEditorService codeEditors: ICodeEditorService,
		@IDispatchWalkService walk: IDispatchWalkService,
		@ICommandService commands: ICommandService,
		@ISessionsService sessions: ISessionsService,
		@IChatWidgetService chatWidgets: IChatWidgetService,
		@ILogService log: ILogService,
		@IAccessibilityService accessibility: IAccessibilityService,
	) {
		super();
		const host: IHost = { walk, chatWidgets, commands, sessions, log, reduceMotion: () => accessibility.isMotionReduced() };
		const add = (diff: IDiffEditor) => {
			if (!this._diffs.has(diff)) {
				this._diffs.set(diff, new DiffWhy(diff, host));
			}
		};
		codeEditors.listDiffEditors().forEach(add);
		this._register(codeEditors.onDiffEditorAdd(add));
		this._register(codeEditors.onDiffEditorRemove(diff => this._diffs.deleteAndDispose(diff)));
	}
}

registerWorkbenchContribution2(DispatchHunkWhy.ID, DispatchHunkWhy, WorkbenchPhase.AfterRestored);
