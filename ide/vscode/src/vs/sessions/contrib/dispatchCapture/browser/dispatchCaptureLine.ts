/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the line under the person's own message (patches/415-next-up.patch; kanban
 *  design/chat-capture B1 and B2, with the preference「首页简洁用符号」: symbols first, few words).
 *
 *    collapsed   [task] Noted 2 ◯ ◯ · next up #3  ⌄       one state mark per thing noted (DESIGN.md「符号表」:
 *                                                         the ring in line, green working, the teal check delivered)
 *    open        a row per thing: its mark, the title, what happens to it next and the person's words;
 *                on hover Move to front, Save for later, Remove (one click) and ⋯ (Edit, Merge into…), Undo after.
 *                A "same as" says where their words went and offers Keep separate; a step added to an open
 *                task says so. Not added as tasks: a question or a "let's not", with Note it for the question.
 *                The last row is the line's own switch, Pause / Resume (one per screen in a session).
 *    first time  one sentence under the line, "Dispatch writes down what you ask for…", with Got it.
 *  While the message is being read (after a second) the line says "Noting what to put on the board…" with a
 *  shimmer. Messages with nothing in them (chit-chat, a question alone) get no line at all.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatRequestViewModel } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IDispatchRequestLine } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchRequestHook.js';
import { DispatchBlockIcons } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { DispatchMark, stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
import { DISPATCH_OPEN_TASK_COMMAND } from '../../dispatchTasks/browser/dispatchTasksModel.js';
import { CaptureState, captureKey, DispatchCaptureModel, ICaptureItem, ICaptureReceipt, onDidChangeNextUp } from './dispatchCaptureModel.js';

const QUOTE_SHOWN = 90;

/** The block a thing's state is drawn as. */
/** A noted thing's state as the symbol table's mark (DESIGN.md「符号表」, task-o01fh). */
export function markOf(state: CaptureState | undefined): DispatchMark {
	switch (state) {
		case 'working': return 'now';
		case 'waiting': return 'waiting';
		case 'done': return 'done';
		case 'gone':
		case 'merged': return 'stopped';
		default: return 'todo';
	}
}

function clip(text: string, n: number): string {
	const t = (text || '').replace(/\s+/g, ' ').trim();
	return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
}

interface ILine {
	readonly host: HTMLElement;
	key: string;
	sig: string;
	readonly store: DisposableStore;
}

/** The lines of every request on screen, drawn from the shared model. */
export class DispatchCaptureLines implements IDispatchRequestLine, IDisposable {

	private readonly lines = new Map<HTMLElement, ILine>();
	private readonly open = new Set<string>();
	/** Rows shown whole: the title and the person's words wrapped instead of cut ("<receipt>:<row>"). */
	private readonly whole = new Set<string>();
	private editing: string | undefined;
	private readonly listener: IDisposable;

	constructor(
		private readonly model: DispatchCaptureModel,
		private readonly commandService: ICommandService,
		private readonly contextMenuService: IContextMenuService,
		private readonly notificationService: INotificationService,
	) {
		this.listener = model.onDidChange(() => this.redrawAll());
	}

	render(value: HTMLElement, element: IChatRequestViewModel): void {
		this.model.ensureLoaded();
		const key = captureKey(element.messageText || '');
		let line = this.lines.get(value);
		if (line && line.key !== key) {
			this.remove(value);
			line = undefined;
		}
		if (!line) {
			const host = dom.$('.dispatch-capture');
			line = { host, key, sig: '', store: new DisposableStore() };
			this.lines.set(value, line);
		}
		if (line.host.previousElementSibling !== value) {
			value.after(line.host);
		}
		this.draw(line);
	}

	remove(value: HTMLElement): void {
		const line = this.lines.get(value);
		if (line) {
			line.store.dispose();
			line.host.remove();
			this.lines.delete(value);
		}
	}

	private redrawAll(): void {
		for (const [value, line] of [...this.lines]) {
			if (!value.isConnected && !line.host.isConnected) {
				this.remove(value);
				continue;
			}
			this.draw(line);
		}
	}

	private draw(line: ILine): void {
		const r = this.model.get(line.key);
		const noting = !r && this.model.noting(line.key);
		const sig = JSON.stringify([r, noting, r && this.open.has(r.id), r && [...this.whole].filter(k => k.startsWith(r.id + ':')), this.editing, this.model.paused, this.model.hintSeen]);
		if (sig === line.sig) {
			return;
		}
		line.sig = sig;
		line.store.clear();
		dom.clearNode(line.host);
		// nothing noted (a question, chit-chat, a chat without a project folder): no line, and no gap under the message
		line.host.classList.toggle('empty', !noting && !r?.items.length);
		if (noting) {
			const n = dom.append(line.host, dom.$('.dispatch-capture-noting'));
			n.appendChild(renderIcon(DispatchBlockIcons.task));
			dom.append(n, dom.$('span.dispatch-capture-shimmer', undefined, localize('capture.noting', "Noting what to put on the board…")));
			return;
		}
		if (!r || (!r.items.length)) {
			return; // nothing in it, or only a question: no line
		}
		this.drawLine(line, r);
		if (r.first && !this.model.hintSeen && this.model.newest() === r.id) {
			this.drawHint(line);
		}
		if (this.open.has(r.id)) {
			this.drawPanel(line, r);
		}
	}

	private drawLine(line: ILine, r: ICaptureReceipt): void {
		const open = this.open.has(r.id);
		const b = dom.append(line.host, dom.$<HTMLButtonElement>('button.dispatch-capture-line', { type: 'button' }));
		b.dataset.receipt = r.id;
		b.setAttribute('aria-expanded', String(open));
		b.appendChild(renderIcon(DispatchBlockIcons.task));
		const fresh = r.items.filter(i => i.kind === 'new' && i.state !== 'gone' && i.state !== 'merged');
		let words: string;
		if (fresh.length) {
			words = localize('capture.noted', "Noted {0}", fresh.length);
		} else if (r.items.some(i => i.kind === 'same')) {
			words = localize('capture.already', "Already on the board");
		} else if (r.items.some(i => i.kind === 'part')) {
			const steps = r.items.filter(i => i.kind === 'part').length;
			words = steps === 1
				? localize('capture.stepAdded', "Added a step to {0}", clip(r.items.find(i => i.kind === 'part')!.title, 40))
				: localize('capture.stepsAdded', "Added {0} steps to {1}", steps, clip(r.items.find(i => i.kind === 'part')!.title, 40));
		} else {
			words = localize('capture.none', "Nothing noted from this message");
		}
		dom.append(b, dom.$('span.dispatch-capture-words', undefined, words));
		if (fresh.length) {
			const blocks = dom.append(b, dom.$('span.dispatch-capture-blocks'));
			for (const i of fresh) {
				blocks.appendChild(stateMark(markOf(i.state), { live: i.state === 'working' })).title = i.title;
			}
		}
		const tail = this.tail(r, fresh);
		if (tail) {
			dom.append(b, dom.$('span.dispatch-capture-dot', undefined, '·'));
			dom.append(b, dom.$('span.dispatch-capture-tail', undefined, tail));
		}
		b.appendChild(renderIcon(open ? Codicon.chevronUp : Codicon.chevronDown)).classList.add('dispatch-capture-chev');
		line.store.add(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
			if (this.open.has(r.id)) {
				this.open.delete(r.id);
			} else {
				this.open.add(r.id);
			}
			line.sig = '';
			this.draw(line);
		}));
	}

	/** What happens next, in two or three words: "next up #3", "working", "delivered". */
	private tail(r: ICaptureReceipt, fresh: readonly ICaptureItem[]): string {
		if (r.next_pos) {
			return this.model.paused ? localize('capture.tailQueuedOnHold', "#{0} in Next up, on hold", r.next_pos) : localize('capture.tailQueued', "#{0} in Next up", r.next_pos);
		}
		if (fresh.some(i => i.state === 'working')) {
			return localize('capture.tailWorking', "working");
		}
		if (fresh.some(i => i.state === 'waiting')) {
			return localize('capture.tailWaiting', "waiting for you");
		}
		if (fresh.length && fresh.every(i => i.state === 'done')) {
			return localize('capture.tailDone', "delivered");
		}
		if (fresh.some(i => i.state === 'later')) {
			return localize('capture.tailLater', "later");
		}
		return '';
	}

	private drawHint(line: ILine): void {
		const h = dom.append(line.host, dom.$('.dispatch-capture-hint'));
		h.appendChild(renderIcon(Codicon.info));
		const x = dom.append(h, dom.$('span.dispatch-capture-hint-words'));
		// the buttons as one group: beside the words when there is room, on a line of their own under them when the
		// chat is narrow (side by side they left the words one word a line, task-v0a2f)
		const acts = dom.$('.dispatch-capture-hint-acts');
		dom.append(x, dom.$('b', undefined, localize('capture.hintLead', "Dispatch writes down what you ask for along the way, so nothing gets lost.")));
		if (this.model.paused) {
			// the first time something is noted: ask once whether it may start on its own (it does not unless they say so)
			x.append(' ' + localize('capture.hintOffPlain', "It waits in Next up, and what you said is for later is saved for later. Nothing starts until you turn on Start by itself."));
			const on = dom.append(acts, dom.$<HTMLButtonElement>('button.dispatch-capture-gotit', { type: 'button' }, localize('capture.hintTurnOn', "Start by itself")));
			on.dataset.act = 'resume';
			line.store.add(dom.addDisposableListener(on, dom.EventType.CLICK, async () => {
				await this.model.act('resume');
				await this.model.act('seen');
			}));
		} else {
			x.append(' ' + localize('capture.hintRestPlain', "It waits behind the work already running and starts on its own when nothing else is running in its project. Click the line to change it."));
		}
		const ok = dom.append(acts, dom.$<HTMLButtonElement>('button.dispatch-capture-gotit', { type: 'button' }, localize('capture.gotIt', "Got it")));
		h.appendChild(acts);
		line.store.add(dom.addDisposableListener(ok, dom.EventType.CLICK, () => void this.model.act('seen')));
	}

	private drawPanel(line: ILine, r: ICaptureReceipt): void {
		const p = dom.append(line.host, dom.$('.dispatch-capture-panel'));
		p.dataset.receipt = r.id;
		r.items.forEach((it, i) => this.drawRow(line, p, r, it, i));
		if (r.left_out.length) {
			const lo = dom.append(p, dom.$('.dispatch-capture-left'));
			dom.append(lo, dom.$('.dispatch-capture-left-head', undefined, localize('capture.notAdded', "Not added as tasks")));
			r.left_out.forEach((x, i) => {
				const row = dom.append(lo, dom.$('.dispatch-capture-left-row'));
				const why = x.kind === 'question' ? localize('capture.questionPlain', "a question, answered in the chat")
					: x.kind === 'for_agent' ? localize('capture.forAgent', "left to this conversation's agent")
						: localize('capture.notDoing', "you said not to do it");
				dom.append(row, dom.$('span.dispatch-capture-left-words', undefined, `「${x.quote.trim()}」 · ${why}`));
				if (x.kind === 'question') {
					this.button(line, row, localize('capture.noteIt', "Note it"), () => this.run('noteit', { receipt: r.id, index: i }), 'dispatch-capture-act');
				}
			});
		}
		const foot = dom.append(p, dom.$('.dispatch-capture-foot'));
		const paused = this.model.paused;
		dom.append(foot, dom.$('span.dispatch-capture-foot-words', undefined, paused
			? localize('capture.offLinePlain', "Tasks in Next up wait until you turn on Start by itself.")
			: localize('capture.runsLinePlain', "Tasks in Next up start on their own when nothing else is running in their project.")));
		const pb = this.button(line, foot, paused ? localize('capture.turnOnStartByItself', "Turn on Start by itself") : localize('capture.pause', "Pause"), () => this.run(paused ? 'resume' : 'pause'), 'dispatch-capture-pause');
		pb.prepend(renderIcon(paused ? Codicon.play : Codicon.debugPause));
		pb.dataset.paused = String(paused);
	}

	private drawRow(line: ILine, p: HTMLElement, r: ICaptureReceipt, it: ICaptureItem, index: number): void {
		const row = dom.append(p, dom.$('.dispatch-capture-row'));
		row.dataset.task = it.task;
		row.dataset.state = it.state;
		const ic = dom.append(row, dom.$('span.dispatch-capture-ic'));
		if (it.kind === 'same') {
			ic.appendChild(renderIcon(Codicon.gitMerge));
		} else if (it.kind === 'part') {
			ic.appendChild(renderIcon(Codicon.add));
		} else if (it.state === 'gone') {
			ic.appendChild(renderIcon(Codicon.circleSlash));
		} else if (it.state === 'merged') {
			ic.appendChild(renderIcon(Codicon.gitMerge));
		} else {
			ic.appendChild(stateMark(markOf(it.state), { live: it.state === 'working' }));
		}
		const editing = this.editing === it.task;
		if (editing) {
			const input = dom.append(row, dom.$<HTMLInputElement>('input.dispatch-capture-edit', { type: 'text', value: it.title, 'aria-label': localize('capture.titleAria', "Task title") }));
			const save = () => {
				const v = input.value.trim();
				this.editing = undefined;
				if (v && v !== it.title) {
					void this.run('edit', { task: it.task, title: v });
				} else {
					this.redrawAll();
				}
			};
			line.store.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					save();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					this.editing = undefined;
					this.redrawAll();
				}
			}));
			setTimeout(() => { input.focus(); input.select(); }, 0);
			const acts = dom.append(row, dom.$('span.dispatch-capture-acts.shown'));
			this.button(line, acts, localize('capture.save', "Save"), save);
			this.button(line, acts, localize('capture.cancel', "Cancel"), () => { this.editing = undefined; this.redrawAll(); });
		} else {
			const title = it.kind === 'same' ? localize('capture.alreadyTask', "Already a task: {0}", it.title) : it.kind === 'part' ? localize('capture.stepAddedTo', "Added a step to {0}", it.title) : it.title;
			const t = dom.append(row, dom.$<HTMLButtonElement>('button.dispatch-capture-title', { type: 'button', title: localize('capture.openTask', "Open the task") }, title));
			t.classList.toggle('gone', it.state === 'gone' || it.state === 'merged');
			t.classList.toggle('new', it.kind === 'new' && it.state === 'next');
			line.store.add(dom.addDisposableListener(t, dom.EventType.CLICK, () => void this.commandService.executeCommand(DISPATCH_OPEN_TASK_COMMAND, it.task)));
			const acts = dom.append(row, dom.$('span.dispatch-capture-acts'));
			this.actions(line, acts, r, it, index);
			if (!acts.childElementCount) {
				// nothing to do on this row (a step added, a delivered thing): no strip, which in a narrow chat lay
				// over the title line on hover and left half a line of it showing
				acts.remove();
			}
		}
		// a title or the person's words cut short open whole on a click (Show all), and close again (Show less)
		const key = `${r.id}:${index}`;
		const whole = this.whole.has(key);
		row.classList.toggle('whole', whole);
		const sub = dom.append(row, dom.$('.dispatch-capture-sub'));
		const quote = it.quote ? `「${whole ? it.quote.trim() : clip(it.quote, QUOTE_SHOWN)}」` : '';
		const words = dom.append(sub, dom.$('span.dispatch-capture-sub-words', undefined, [this.stateWords(it), quote].filter(Boolean).join(' · ')));
		const toggle = dom.append(sub, dom.$<HTMLButtonElement>('button.dispatch-capture-whole', { type: 'button', 'aria-expanded': String(whole) }));
		toggle.textContent = whole ? localize('capture.showLess', "Show less") : localize('capture.showAll', "Show all");
		toggle.hidden = true;
		const flip = (e: Event) => {
			e.stopPropagation();
			if (this.whole.has(key)) {
				this.whole.delete(key);
			} else {
				this.whole.add(key);
			}
			line.sig = '';
			this.draw(line);
		};
		line.store.add(dom.addDisposableListener(toggle, dom.EventType.CLICK, flip));
		// shown only when something is cut: measured once the row is laid out
		const title = row.querySelector<HTMLElement>('.dispatch-capture-title');
		const measure = () => {
			const cut = (it.quote ?? '').trim().length > QUOTE_SHOWN || (!!title && title.scrollWidth > title.clientWidth + 1) || words.scrollWidth > words.clientWidth + 1;
			toggle.hidden = !(whole || cut);
		};
		const handle = dom.getWindow(row).requestAnimationFrame(measure);
		line.store.add(toDisposable(() => dom.getWindow(row).cancelAnimationFrame(handle)));
	}

	private stateWords(it: ICaptureItem): string {
		if (it.kind === 'same') {
			return localize('capture.sameWords', "Your words were added there");
		}
		if (it.kind === 'part') {
			return it.step ? localize('capture.stepWordsPlain', "The step: {0}", it.step) : '';
		}
		switch (it.state) {
			case 'next': return this.model.paused
				? (it.ahead ? localize('capture.queuedAheadOnHold', "In Next up, {0} ahead of it · waits until you turn on Start by itself", it.ahead) : localize('capture.queuedFirstOnHold', "First in Next up · waits until you turn on Start by itself"))
				: it.ahead ? localize('capture.queuedAhead', "In Next up, {0} ahead of it · will start on its own when nothing else is running", it.ahead) : localize('capture.queuedFirst', "First in Next up · will start on its own when nothing else is running");
			case 'later': return localize('capture.savedForLater', "Saved for later · starts only after you put it back in Next up");
			case 'working': return localize('capture.working', "Working");
			case 'waiting': return localize('capture.waiting', "Waiting for you");
			case 'done': return localize('capture.done', "Delivered");
			case 'gone': return localize('capture.removed', "Removed from the board");
			case 'merged': return localize('capture.merged', "Merged into {0}", clip(it.into_title || '', 50));
			default: return localize('capture.todo', "To do");
		}
	}

	private actions(line: ILine, acts: HTMLElement, r: ICaptureReceipt, it: ICaptureItem, index: number): void {
		if (it.kind === 'same') {
			this.button(line, acts, localize('capture.keep', "Keep separate"), () => this.run('keep', { receipt: r.id, index }));
			return;
		}
		if (it.kind === 'part') {
			return;
		}
		if (it.state === 'gone' || it.state === 'merged') {
			this.button(line, acts, localize('capture.undo', "Undo"), () => this.run('undo', { task: it.task }));
			return;
		}
		if (it.state === 'done') {
			return;
		}
		if (it.state === 'next') {
			if (it.ahead) {
				this.button(line, acts, localize('capture.front', "Move to front"), () => this.run('front', { task: it.task }));
			}
			this.button(line, acts, localize('capture.saveForLater', "Save for later"), () => this.run('later', { task: it.task }));
		} else if (it.state === 'later') {
			this.button(line, acts, localize('capture.backToNextUp', "Back to Next up"), () => this.run('lineup', { task: it.task }));
		}
		// one click: this one did not need noting
		const drop = this.button(line, acts, localize('capture.remove', "Remove"), () => this.run('drop', { task: it.task }));
		drop.title = localize('capture.notATaskTip', "Take it off the board");
		const more = this.button(line, acts, '', () => this.more(more, it), 'dispatch-capture-more');
		more.appendChild(renderIcon(Codicon.ellipsis));
		more.setAttribute('aria-label', localize('capture.moreAria', "More"));
		more.title = localize('capture.moreTitle', "Edit, or merge into another task");
	}

	private more(anchor: HTMLElement, it: ICaptureItem): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'capture.edit', label: localize('capture.edit', "Edit"), run: () => { this.editing = it.task; this.redrawAll(); } }),
				toAction({ id: 'capture.merge', label: localize('capture.mergeInto', "Merge into…"), run: () => void this.mergeMenu(anchor, it) }),
			],
		});
	}

	private async mergeMenu(anchor: HTMLElement, it: ICaptureItem): Promise<void> {
		const r = await this.model.act('targets', { task: it.task });
		const targets = r?.targets ?? [];
		if (!targets.length) {
			this.notificationService.info(localize('capture.noTargets', "There is no other open task to merge it into."));
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => targets.map(t => toAction({ id: `capture.mergeTo.${t.id}`, label: clip(t.title, 70), run: () => this.run('merge', { task: it.task, into: t.id }) })),
		});
	}

	private button(line: ILine, parent: HTMLElement, text: string, run: () => unknown, cls = 'dispatch-capture-act'): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>(`button.${cls}`, { type: 'button' }, text));
		line.store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			void run();
		}));
		return b;
	}

	private async run(op: string, arg?: object): Promise<void> {
		const r = await this.model.act(op, arg);
		if (r && r.ok === false && r.error) {
			this.notificationService.warn(r.error);
		}
		onDidChangeNextUp.fire();
	}

	dispose(): void {
		this.listener.dispose();
		for (const v of [...this.lines.keys()]) {
			this.remove(v);
		}
	}
}
