/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the line of things noted from chats, in the side pane (patches/415-next-up.patch;
 *  kanban design/chat-capture direction B, B1 and B4, task-tix5). Two places, one model (dispatchCaptureModel.ts):
 *
 *    Tasks tab   under the cards, "Next up n" with Pause: the scope's things in line, in order, each with its place
 *                (1 starts next), a quiet head over the things one message lined up; on hover Move to front,
 *                Not now and ⋯ (Edit, Merge into…, Not a task, with Undo after). "Later n": what was put off, Line it up.
 *    Now tab     under the Now card's line, "Next up n" with Pause: the first two, "··· n more", the newest one,
 *                so a session shows what it does now and what follows.
 *
 *  Rows are flat (no card): a number, a hollow block (to do, DESIGN.md's grey), the title. Pause is the line's one
 *  switch (`dispatch nextup pause`): nothing new starts, running work goes on.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { ago, DISPATCH_OPEN_TASK_COMMAND } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { captureModel, DispatchCaptureModel, INextUpLine, INextUpRow, nextUpFailed, onDidChangeNextUp } from './dispatchCaptureModel.js';

/** The Now card shows this many rows of a longer line: the first two, a fold, the newest. */
const NOW_ROWS = 4;

function clip(text: string, n: number): string {
	const t = (text || '').replace(/\s+/g, ' ').trim();
	return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
}

/** When a message was said: the time today ("18:27"), else the day ("Oct 5"). */
function saidAt(at: number): string {
	if (!at) {
		return '';
	}
	const d = new Date(at * 1000);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export class DispatchNextUpView extends Disposable {

	private readonly model: DispatchCaptureModel;
	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The line changed (or a row is being edited): the tab draws again. */
	readonly onDidChange = this._onDidChange.event;
	private editing: string | undefined;
	private nowAll = false;
	/** Taken off the board from this tab a moment ago: a row with Undo stays for a minute. */
	private readonly dropped = new Map<string, { readonly row: INextUpRow; readonly at: number }>();

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.model = captureModel(commandService);
		this._register(this.model.onDidChange(() => this._onDidChange.fire()));
	}

	/** Read the line when the tab draws (again when it is older than a few seconds). */
	ensure(): void {
		this.model.ensureLine();
	}

	/** Read the line now (the board changed: a thing may have just been noted or started). */
	fresh(): void {
		void this.model.refreshLine();
	}

	get line(): INextUpLine | undefined {
		return this.model.line;
	}

	/** What the tab compares to know whether to draw again. */
	signature(): string {
		return JSON.stringify([this.model.line, this.editing, this.nowAll, [...this.dropped.keys()]]);
	}

	/** The ids of the given tasks that are in the line (Next up or Later): the Tasks tab draws them here, not as cards. */
	lined(ids: readonly string[]): Set<string> {
		const line = this.model.line;
		const all = new Set([...(line?.next ?? []), ...(line?.later ?? []), ...(line?.idle ?? [])].map(r => r.id));
		return new Set(ids.filter(id => all.has(id)));
	}

	// ---- Tasks tab ------------------------------------------------------------------------------------------

	/** Next up and Later for the tasks in the tab's scope (`ids`). Nothing when none of them is in line. */
	renderTasks(parent: HTMLElement, store: DisposableStore, ids: readonly string[]): void {
		const line = this.model.line;
		if (!line) {
			return;
		}
		const scope = new Set(ids);
		const next = line.next.filter(r => scope.has(r.id));
		const later = line.later.filter(r => scope.has(r.id));
		for (const [id, d] of [...this.dropped]) {
			if (Date.now() - d.at > 60_000) {
				this.dropped.delete(id);
			}
		}
		// still in the line as last read (the read after the click is on its way), or put back from elsewhere: no Undo row
		const dropped = [...this.dropped.values()].filter(d => !line.next.some(r => r.id === d.row.id) && !line.later.some(r => r.id === d.row.id));
		if (next.length || dropped.length) {
			const group = dom.append(parent, dom.$('.dispatch-nextup-group'));
			group.dataset.part = 'next-up';
			this.groupHead(group, store, localize('nextUp.head', "Next up"), next.length, true);
			if (!this.failedNote(group, store, line)) {
				dom.append(group, dom.$('.dispatch-nextup-note', undefined, lineNote(line)));
			}
			let source = '';
			for (const r of next) {
				const from = r.receipt || `${r.session}|${r.at}`;
				if (from !== source) {
					source = from;
					this.sourceHead(group, r, next.filter(x => (x.receipt || `${x.session}|${x.at}`) === from).length);
				}
				this.taskRow(group, store, r, 'next');
			}
			for (const d of dropped) {
				this.droppedRow(group, store, d.row);
			}
		}
		// in progress on the board, nobody on it: an agent that stopped or a session closed before it said done
		const idle = (line.idle ?? []).filter(r => scope.has(r.id));
		if (idle.length) {
			const group = dom.append(parent, dom.$('.dispatch-nextup-group.idle'));
			group.dataset.part = 'idle';
			const head = dom.append(group, dom.$('.dispatch-nextup-head'));
			dom.append(head, dom.$('span', undefined, localize('nextUp.idle', "Nobody on it")));
			dom.append(head, dom.$('span.dispatch-nextup-count', undefined, String(idle.length)));
			if (idle.length > 1) {
				const all = dom.append(head, dom.$<HTMLButtonElement>('button.dispatch-nextup-pause', { type: 'button', title: localize('nextUp.idleAllTip', "Put every one of these back in Next up, at the end of the line") }));
				dom.append(all, dom.$('span', undefined, localize('nextUp.idleAll', "Line them all up")));
				store.add(dom.addDisposableListener(all, dom.EventType.CLICK, e => {
					e.stopPropagation();
					void this.run('requeueAll');
				}));
			}
			dom.append(group, dom.$('.dispatch-nextup-note', undefined, localize('nextUp.idleNote', "Still in progress on the board, but no session has worked on these for an hour.")));
			for (const r of idle) {
				this.idleRow(group, store, r);
			}
		}
		if (later.length) {
			const group = dom.append(parent, dom.$('.dispatch-nextup-group.later'));
			group.dataset.part = 'later';
			this.groupHead(group, store, localize('nextUp.later', "Later"), later.length, false);
			dom.append(group, dom.$('.dispatch-nextup-note', undefined, localize('nextUp.laterNotePlain', "Waits until you put it back in Next up.")));
			for (const r of later) {
				this.taskRow(group, store, r, 'later');
			}
		}
	}

	private groupHead(group: HTMLElement, store: DisposableStore, label: string, count: number, pause: boolean): void {
		const head = dom.append(group, dom.$('.dispatch-nextup-head'));
		dom.append(head, dom.$('span', undefined, label));
		dom.append(head, dom.$('span.dispatch-nextup-count', undefined, String(count)));
		if (pause) {
			this.pauseButton(head, store);
		}
	}

	/** A start that did not happen: what went wrong, when it is tried again, Try again. False when there is none. */
	private failedNote(parent: HTMLElement, store: DisposableStore, line: INextUpLine): boolean {
		const f = nextUpFailed(line);
		if (!f || line.paused) {
			return false;
		}
		const note = dom.append(parent, dom.$('.dispatch-nextup-note.failed'));
		note.dataset.part = 'next-up-failed';
		note.appendChild(renderIcon(Codicon.warning));
		const words = dom.append(note, dom.$('span'));
		words.append(localize('nextUp.failedHead', "\"{0}\" did not start. {1}", clip(f.title, 60), f.why));
		if (!f.stuck && f.retry_at) {
			const d = new Date(f.retry_at * 1000);
			words.append(' ' + localize('nextUp.failedAgain', "Trying again at {0}.", `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`));
		} else if (f.stuck) {
			words.append(' ' + localize('nextUp.failedStopped', "Stopped after {0} tries.", f.tries));
		}
		const again = dom.append(note, dom.$<HTMLButtonElement>('button.dispatch-nextup-act.shown', { type: 'button' }, localize('nextUp.tryAgain', "Try again")));
		store.add(dom.addDisposableListener(again, dom.EventType.CLICK, e => {
			e.stopPropagation();
			void this.run('retry');
		}));
		return true;
	}

	private pauseButton(parent: HTMLElement, store: DisposableStore): HTMLButtonElement {
		const paused = !!this.model.line?.paused;
		const b = dom.append(parent, dom.$<HTMLButtonElement>('button.dispatch-nextup-pause', { type: 'button' }));
		b.dataset.paused = String(paused);
		b.title = paused ? localize('nextUp.resumeTip', "Let the next thing start by itself when its project is free") : localize('nextUp.pauseTip', "Nothing new starts; running work goes on");
		b.appendChild(renderIcon(paused ? Codicon.play : Codicon.debugPause));
		dom.append(b, dom.$('span', undefined, paused ? localize('nextUp.turnOnStartByItself', "Turn on Start by itself") : localize('nextUp.pause', "Pause")));
		store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			void this.run(paused ? 'resume' : 'pause');
		}));
		return b;
	}

	/** Over the things one message lined up: when it was said and what (the whole message, cut to a line). */
	private sourceHead(group: HTMLElement, r: INextUpRow, count: number): void {
		const said = r.said || r.quote;
		const h = dom.append(group, dom.$('.dispatch-nextup-source'));
		h.title = said;
		h.appendChild(renderIcon(Codicon.commentDiscussion));
		dom.append(h, dom.$('span.dispatch-nextup-source-when', undefined, saidAt(r.at)));
		dom.append(h, dom.$('span.dispatch-nextup-source-said', undefined, said ? `「${clip(said, 120)}」` : localize('nextUp.fromChat', "From chat")));
		if (count > 1) {
			dom.append(h, dom.$('span.dispatch-nextup-source-count', undefined, String(count)));
		}
	}

	private taskRow(group: HTMLElement, store: DisposableStore, r: INextUpRow, kind: 'next' | 'later'): void {
		const row = dom.append(group, dom.$<HTMLElement>('.dispatch-nextup-row', { tabindex: '0', role: 'button' }));
		row.dataset.task = r.id;
		row.dataset.kind = kind;
		row.title = r.quote ? `${r.title}\n「${clip(r.quote, 200)}」` : r.title;
		dom.append(row, dom.$('span.dispatch-nextup-pos', undefined, kind === 'next' && r.pos ? String(r.pos) : ''));
		const block = row.appendChild(stateBlock('todo', { size: 14, title: kind === 'next' ? localize('nextUp.blockNext', "Next up") : localize('nextUp.blockLater', "Later") }));
		block.classList.toggle('new', !!r.new);
		if (this.editing === r.id) {
			this.editRow(row, store, r);
			return;
		}
		dom.append(row, dom.$(`span.dispatch-nextup-title${r.new ? '.new' : ''}`, undefined, r.title));
		dom.append(row, dom.$('span.dispatch-nextup-time', undefined, r.new ? localize('nextUp.new', "new") : ago(r.at)));
		const acts = dom.append(row, dom.$('span.dispatch-nextup-acts'));
		if (kind === 'next') {
			if ((r.pos ?? 1) > 1) {
				this.act(acts, store, localize('nextUp.front', "Move to front"), () => this.run('front', { task: r.id }));
			}
			this.act(acts, store, localize('nextUp.saveForLater', "Save for later"), () => this.run('later', { task: r.id }));
		} else {
			this.act(acts, store, localize('nextUp.backToNextUp', "Back to Next up"), () => this.run('lineup', { task: r.id }));
		}
		const more = this.act(acts, store, '', () => this.more(more, r), 'dispatch-nextup-more');
		more.appendChild(renderIcon(Codicon.ellipsis));
		more.setAttribute('aria-label', localize('nextUp.moreAria', "More"));
		more.title = localize('nextUp.moreTip', "Edit, merge into another task, or take it off the board");
		const open = () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, r.id);
		store.add(dom.addDisposableListener(row, dom.EventType.CLICK, open));
		store.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				open();
			}
		}));
	}

	/** A task in progress with nobody on it: when it last moved, and Back to Next up. */
	private idleRow(group: HTMLElement, store: DisposableStore, r: INextUpRow & { readonly since?: number }): void {
		const row = dom.append(group, dom.$<HTMLElement>('.dispatch-nextup-row', { tabindex: '0', role: 'button' }));
		row.dataset.task = r.id;
		row.dataset.kind = 'idle';
		row.title = r.title;
		dom.append(row, dom.$('span.dispatch-nextup-pos'));
		row.appendChild(stateBlock('stopped', { size: 14, title: localize('nextUp.blockIdle', "In progress, nobody on it") }));
		dom.append(row, dom.$('span.dispatch-nextup-title', undefined, r.title));
		dom.append(row, dom.$('span.dispatch-nextup-time', undefined, ago(r.since || r.at)));
		const acts = dom.append(row, dom.$('span.dispatch-nextup-acts'));
		this.act(acts, store, localize('nextUp.requeue', "Back to Next up"), () => this.run('requeue', { task: r.id }));
		const open = () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, r.id);
		store.add(dom.addDisposableListener(row, dom.EventType.CLICK, open));
		store.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				open();
			}
		}));
	}

	/** A thing just taken off the board: struck through, with Undo. */
	private droppedRow(group: HTMLElement, store: DisposableStore, r: INextUpRow): void {
		const row = dom.append(group, dom.$('.dispatch-nextup-row.dropped'));
		row.dataset.task = r.id;
		row.dataset.kind = 'dropped';
		dom.append(row, dom.$('span.dispatch-nextup-pos'));
		row.appendChild(renderIcon(Codicon.circleSlash)).classList.add('dispatch-nextup-gone');
		dom.append(row, dom.$('span.dispatch-nextup-title', undefined, r.title));
		const acts = dom.append(row, dom.$('span.dispatch-nextup-acts.shown'));
		this.act(acts, store, localize('nextUp.undo', "Undo"), async () => {
			this.dropped.delete(r.id);
			await this.run('undo', { task: r.id });
		});
	}

	private editRow(row: HTMLElement, store: DisposableStore, r: INextUpRow): void {
		row.classList.add('editing');
		const input = dom.append(row, dom.$<HTMLInputElement>('input.dispatch-nextup-edit', { type: 'text', value: r.title, 'aria-label': localize('nextUp.titleAria', "Task title") }));
		const done = (save: boolean) => {
			const v = input.value.trim();
			this.editing = undefined;
			if (save && v && v !== r.title) {
				void this.run('edit', { task: r.id, title: v });
			}
			this._onDidChange.fire();
		};
		store.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				done(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				done(false);
			}
		}));
		store.add(dom.addDisposableListener(input, dom.EventType.CLICK, e => e.stopPropagation()));
		const acts = dom.append(row, dom.$('span.dispatch-nextup-acts.shown'));
		this.act(acts, store, localize('nextUp.save', "Save"), () => done(true));
		this.act(acts, store, localize('nextUp.cancel', "Cancel"), () => done(false));
		setTimeout(() => { input.focus(); input.select(); }, 0);
	}

	private act(parent: HTMLElement, store: DisposableStore, text: string, run: () => unknown, cls = 'dispatch-nextup-act'): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>(`button.${cls}`, { type: 'button' }, text));
		store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			void run();
		}));
		return b;
	}

	private more(anchor: HTMLElement, r: INextUpRow): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'nextUp.edit', label: localize('nextUp.edit', "Edit"), run: () => { this.editing = r.id; this._onDidChange.fire(); } }),
				toAction({ id: 'nextUp.merge', label: localize('nextUp.mergeInto', "Merge into…"), run: () => void this.mergeMenu(anchor, r) }),
				toAction({
					id: 'nextUp.drop', label: localize('nextUp.removeFromBoard', "Remove from the board"), tooltip: localize('nextUp.notATaskTip', "Take it off the board"), run: async () => {
						this.dropped.set(r.id, { row: r, at: Date.now() });
						await this.run('drop', { task: r.id });
					}
				}),
			],
		});
	}

	private async mergeMenu(anchor: HTMLElement, r: INextUpRow): Promise<void> {
		const got = await this.model.act('targets', { task: r.id });
		const targets = got?.targets ?? [];
		if (!targets.length) {
			this.notificationService.info(localize('nextUp.noTargets', "There is no other open task to merge it into."));
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => targets.map(t => toAction({ id: `nextUp.mergeTo.${t.id}`, label: clip(t.title, 70), run: () => this.run('merge', { task: r.id, into: t.id }) })),
		});
	}

	private async run(op: string, arg?: object): Promise<void> {
		const r = await this.model.act(op, arg);
		if (r && r.ok === false && r.error) {
			this.notificationService.warn(r.error);
		}
		if (!this.model.line) {
			await this.model.refreshLine();
		}
		onDidChangeNextUp.fire();
	}

	// ---- Now tab --------------------------------------------------------------------------------------------

	/** Under the Now card's line: what starts after it in this session's project (`project`, its name and label; none
	 *  for a session outside every project). Nothing when that part of the line is empty. */
	renderNow(card: HTMLElement, store: DisposableStore, project: { readonly name: string; readonly label: string } | undefined): void {
		const line = this.model.line;
		const next = (line?.next ?? []).filter(r => project ? r.project === project.name || r.project === project.label : !r.project);
		if (!line || !next.length) {
			return;
		}
		const box = dom.append(card, dom.$('.dispatch-nextup-now'));
		box.dataset.part = 'next-up';
		const head = dom.append(box, dom.$('.dispatch-nextup-head'));
		dom.append(head, dom.$('span', undefined, localize('nextUp.head2', "Next up")));
		dom.append(head, dom.$('span.dispatch-nextup-count', undefined, String(next.length)));
		this.pauseButton(head, store);
		// a long line: the first two, a fold, the newest (what was just said)
		let shown: (INextUpRow | undefined)[] = [...next];
		if (!this.nowAll && next.length > NOW_ROWS) {
			const rest = next.slice(2);
			const newest = rest.reduce((a, b) => (b.at > a.at ? b : a), rest[rest.length - 1]);
			shown = [next[0], next[1], undefined, newest];
		}
		for (const r of shown) {
			if (!r) {
				const more = dom.append(box, dom.$<HTMLButtonElement>('button.dispatch-nextup-fold', { type: 'button' }, localize('nextUp.moreInLine', "··· {0} more in line", next.length - 3)));
				store.add(dom.addDisposableListener(more, dom.EventType.CLICK, e => {
					e.stopPropagation();
					this.nowAll = true;
					this._onDidChange.fire();
				}));
				continue;
			}
			const row = dom.append(box, dom.$<HTMLElement>('.dispatch-nextup-row.compact', { tabindex: '0', role: 'button' }));
			row.dataset.task = r.id;
			row.title = r.quote ? `${r.title}\n「${clip(r.quote, 200)}」` : r.title;
			dom.append(row, dom.$('span.dispatch-nextup-pos', undefined, String(r.pos ?? '')));
			row.appendChild(stateBlock('todo', { size: 12, title: localize('nextUp.blockNext2', "Next up") })).classList.toggle('new', !!r.new);
			dom.append(row, dom.$(`span.dispatch-nextup-title${r.new ? '.new' : ''}`, undefined, r.title));
			const open = () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, r.id);
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, open));
			store.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
		if (!this.failedNote(box, store, line)) {
			dom.append(box, dom.$('.dispatch-nextup-note', undefined, lineNote(line)));
		}
	}
}

/** When the next thing starts, as it really does (capture.py _tick): only with Start by itself on, once nothing works
 *  in its project and fewer than the limit work at all. */
export function lineNote(line: INextUpLine): string {
	if (line.paused) {
		return localize('nextUp.offNote', "Start by itself is off. Nothing here starts until you turn it on.");
	}
	return line.limit === 1
		? localize('nextUp.runsNoteOne2', "Starts by itself when no other session is working.")
		: localize('nextUp.runsNote2', "Starts by itself when nothing else works in its project and fewer than {0} sessions work.", line.limit);
}
