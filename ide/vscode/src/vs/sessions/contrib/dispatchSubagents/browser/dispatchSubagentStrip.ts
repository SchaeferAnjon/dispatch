/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agent strip above the message box. Direction A, the person picked it 2026-11-12
 *  (task-1rzdr; kanban design/subagent-strip, learned from Orca): while sub-agents of the session on screen work, a
 *  block sits 8 above its message box, as wide as the box, and says who works and on what, whatever the side pane
 *  shows. It goes once none works; the ones back stay in the Now tab as before (contrib/dispatchNow, which reads the
 *  same sub-agents through sessions/browser/dispatchSubAgentRows.ts and the step from dispatchSubagentsModel.ts).
 *
 *    head      the agent mark, "2 agents working", the caret; folded, the first one and its step after it
 *    a row     a 14px purple filled circle (DESIGN.md「符号表」), what it was sent to do, how long on the first line; the step it is on and how long on that
 *              step under it. Stopped (it ended with an error): the coral one, "Stopped after 2m 4s".
 *    finished  "1 finished", opening in place: the grey filled check, the name, how long it took
 *
 *  No tokens and no Stop: the design has them, but none of Claude Code, Codex and OpenCode in the Agent Host gives a
 *  sub-agent's own token count or stops one sub-agent alone today (task-1rzdr: Claude's adapter drops the SDK's
 *  task_progress usage and never calls stopTask; Codex keeps only a child thread's last call's usage and its abort
 *  knows only top chats; OpenCode mirrors no tokens and aborts only its own chats). Cancelling a sub-agent's chat
 *  ends it on screen while the engine runs on, so there is no button for it. The step is real for all three: the
 *  Agent Host puts a sub-agent's calls into the reply of the conversation that sent it, marked with its start.
 *  A click on a row opens the sub-agent's own conversation, as its row in Now does.
 *
 *  Where it sits: in the input part's flow, the way the "Preference remembered" toast does (chat dispatchPrefs.ts),
 *  so the conversation makes room for it. Folded or not is kept for the window.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSubagentStrip.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService, IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { onSubAgentRowClick, subAgentElapsed, subAgentsOf, subAgentState } from '../../../browser/dispatchSubAgentRows.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
import { finishedLabel, IReplyPart, IStrip, IStripAgentInput, IStripRow, runningStep, stepSince, stripOf, subagentStep } from './dispatchSubagentsModel.js';

/** The parts of a conversation's last reply, as much as tells the step it is on (dispatchSubagentsModel.runningStep). */
export function replyParts(chatService: IChatService, resource: URI): IReplyPart[] {
	const parts = chatService.getSession(resource)?.getRequests().at(-1)?.response?.response.value ?? [];
	return parts.map(part => {
		if (part.kind !== 'toolInvocation' && part.kind !== 'toolInvocationSerialized') {
			return { tool: false, running: false, hidden: false, message: '' };
		}
		const running = !IChatToolInvocation.isComplete(part);
		const hidden = IChatToolInvocation.isEffectivelyHidden(part);
		const data = part.toolSpecificData?.kind === 'subagent' ? part.toolSpecificData : undefined;
		return {
			tool: true,
			running,
			hidden,
			id: part.toolCallId,
			parent: part.subAgentInvocationId,
			subagent: data && { description: data.description, chat: data.chatResource },
			message: running && !hidden ? renderAsPlaintext(part.invocationMessage) : '',
		};
	});
}

/** Folded or not, for this window. */
const FOLDED_KEY = 'dispatch.subagentStrip.folded';
const SHIMMER_MS = 2_000;

export class DispatchSubagentStrip extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchSubagentStrip';

	private _slot: HTMLElement | undefined;
	private _folded: boolean;
	private _finishedOpen = false;
	private _sig = '';
	/** The last fold or open came from the keyboard: the focus goes back where it was after the strip is drawn again
	 *  (a mouse click leaves it, so no ring shows where the pointer just was). */
	private _byKey = false;
	private readonly _draw = this._register(new DisposableStore());
	/** The step each sub-agent was last seen on, and since when. */
	private readonly _steps = new Map<string, { readonly step: string; readonly since: number }>();
	/** The session the strip speaks for and the message box it sits on. */
	private _session: ISession | undefined;
	private _widget: IChatWidget | undefined;

	constructor(
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChatService private readonly _chatService: IChatService,
		@IStorageService private readonly _storageService: IStorageService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
	) {
		super();
		this._folded = this._storageService.getBoolean(FOLDED_KEY, StorageScope.WORKSPACE, false);
		// what the strip shows moves with the session's sub-agents: their states and names
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			const provided = session && (this._sessionsManagementService.getSession(session.resource) ?? session);
			for (const chat of provided ? subAgentsOf(provided, reader) : []) {
				subAgentState(chat, reader);
				chat.title.read(reader);
			}
			session?.mainChat.read(reader);
			this.render();
		}));
		this._register(this._chatWidgetService.onDidAddWidget(() => this.render()));
		this._register(this._accessibilityService.onDidChangeReducedMotion(() => { this._sig = ''; this.render(); }));
		// the clocks move every second while it shows, and the step each one is on is read again; while one works and it
		// does not show, the message box may have come back without a word (the session's own conversation opened again
		// after a sub-agent's, the same widget showing it): it looks again
		const timer = mainWindow.setInterval(() => {
			if (this._slot?.childElementCount || this.someoneWorks()) {
				this.render();
			}
		}, 1000);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		this._register(toDisposable(() => this._slot?.remove()));
	}

	private someoneWorks(): boolean {
		const active = this._sessionsService.activeSession.get();
		const session = active && (this._sessionsManagementService.getSession(active.resource) ?? active);
		return !!session && subAgentsOf(session).some(c => subAgentState(c) === 'sub-agent');
	}

	/** The message box of the session's own conversation, when it is on screen. */
	private widgetOf(session: ISession): IChatWidget | undefined {
		const widget = this._chatWidgetService.getWidgetBySessionResource(session.mainChat.get().resource);
		const input = widget?.input?.element;
		return input && input.isConnected ? widget : undefined;
	}

	private slotIn(widget: IChatWidget): HTMLElement {
		const input = widget.input.element;
		let slot = input.querySelector<HTMLElement>(':scope > .dispatch-subagents-slot');
		if (!slot) {
			slot = dom.$('.dispatch-subagents-slot');
			// first in the input part: above the box, and above a toast that sits there too
			input.prepend(slot);
		}
		if (this._slot && this._slot !== slot) {
			dom.clearNode(this._slot);
		}
		this._slot = slot;
		return slot;
	}

	private input(parts: readonly IReplyPart[], chat: IChat, now: number): IStripAgentInput {
		const state = subAgentState(chat);
		const id = chat.resource.toString();
		const step = state === 'sub-agent' ? this.stepOf(parts, chat) : '';
		const since = step ? stepSince(this._steps.get(id), step, now) : undefined;
		if (step && since !== undefined) {
			this._steps.set(id, { step, since });
		}
		const elapsed = subAgentElapsed(chat);
		return { id, name: chat.title.get(), state, startedAt: now - elapsed, elapsedMs: elapsed, step, stepSince: since };
	}

	/**
	 * What the sub-agent runs this moment: its newest unfinished call in the reply of the conversation that sent it
	 * out, else in its own conversation (there once it was opened).
	 */
	private stepOf(parts: readonly IReplyPart[], chat: IChat): string {
		return subagentStep(parts, { resource: chat.resource.toString(), fragment: chat.resource.fragment })
			|| runningStep(replyParts(this._chatService, chat.resource));
	}

	/** When the round the session is on started: the last message sent. */
	private roundStart(session: ISession): number | undefined {
		return this._chatService.getSession(session.mainChat.get().resource)?.getRequests().at(-1)?.timestamp;
	}

	private render(): void {
		const active = this._sessionsService.activeSession.get();
		const session = active && (this._sessionsManagementService.getSession(active.resource) ?? active);
		const widget = active && this.widgetOf(active);
		const now = Date.now();
		const parts = active && widget ? replyParts(this._chatService, active.mainChat.get().resource) : [];
		const strip = session && widget ? stripOf(subAgentsOf(session).map(c => this.input(parts, c, now)), this.roundStart(session), now) : undefined;
		if (!strip?.visible || !widget || !session) {
			this._sig = '';
			this._draw.clear();
			if (this._slot) {
				dom.clearNode(this._slot);
			}
			this._session = undefined;
			this._widget = undefined;
			return;
		}
		const still = this._accessibilityService.isMotionReduced();
		const sig = JSON.stringify([session.resource.toString(), strip, this._folded, this._finishedOpen, still]);
		if (sig === this._sig && this._widget === widget && this._slot?.firstChild) {
			return;
		}
		const sameShape = this._session === session && this._widget === widget && !!this._slot?.firstChild
			&& this.shape(strip, still) === this._slot.firstElementChild?.getAttribute('data-shape');
		this._sig = sig;
		this._session = session;
		this._widget = widget;
		if (sameShape) {
			this.update(strip); // only the words and clocks moved: the same nodes, the shimmer and the focus stay
			return;
		}
		const focused = mainWindow.document.activeElement as HTMLElement | null;
		const refocus = this._byKey && focused && this._slot?.contains(focused) ? focused.dataset.focusKey : undefined;
		this._byKey = false;
		this.draw(this.slotIn(widget), session, strip, still);
		if (refocus) {
			this._slot?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(refocus)}"]`)?.focus();
		}
	}

	private draw(slot: HTMLElement, session: ISession, strip: IStrip, still: boolean): void {
		this._draw.clear();
		dom.clearNode(slot);
		const box = dom.append(slot, dom.$('section.dispatch-subagents'));
		box.dataset.part = 'subagent-strip';
		box.dataset.shape = this.shape(strip, still);
		box.setAttribute('aria-label', localize('dispatchSubagents.aria', "Sub-agents at work"));
		// Enter and Space on the strip's buttons and rows are theirs: they never reach the message box's keys (send)
		this._draw.add(dom.addDisposableListener(box, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.stopPropagation();
				this._byKey = true;
			}
		}));

		const head = dom.append(box, dom.$<HTMLButtonElement>('button.dsa-head', { type: 'button' }));
		head.dataset.focusKey = 'head';
		head.setAttribute('aria-expanded', String(!this._folded));
		dom.append(head, icon(Codicon.agent));
		dom.append(head, dom.$('b.dsa-headline'));
		dom.append(head, dom.$('span.dsa-line'));
		dom.append(head, icon(Codicon.chevronDown, '.dsa-car'));
		this._draw.add(dom.addDisposableListener(head, dom.EventType.CLICK, () => {
			this._folded = !this._folded;
			this._storageService.store(FOLDED_KEY, this._folded, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this._sig = '';
			this.render();
		}));

		if (!this._folded) {
			for (const row of strip.rows) {
				this.row(box, session, row, still);
			}
			if (strip.finished.length) {
				const fin = dom.append(box, dom.$<HTMLButtonElement>('button.dsa-fin', { type: 'button' }));
				fin.dataset.focusKey = 'finished';
				fin.setAttribute('aria-expanded', String(this._finishedOpen));
				dom.append(fin, icon(Codicon.chevronRight, '.dsa-car'));
				dom.append(fin, dom.$('span', undefined, finishedLabel(strip.finished.length)));
				fin.setAttribute('aria-label', this._finishedOpen
					? localize('dispatchSubagents.hideFinished', "Hide the {0} sub-agents that came back", strip.finished.length)
					: localize('dispatchSubagents.showFinished', "Show the {0} sub-agents that came back", strip.finished.length));
				this._draw.add(dom.addDisposableListener(fin, dom.EventType.CLICK, () => {
					this._finishedOpen = !this._finishedOpen;
					this._sig = '';
					this.render();
				}));
				if (this._finishedOpen) {
					for (const row of strip.finished) {
						this.row(box, session, row, still);
					}
				}
			}
		}
		this.update(strip);
	}

	/** A sub-agent: two lines (one once back); a click, Enter or Space opens its own conversation. */
	private row(box: HTMLElement, session: ISession, row: IStripRow, still: boolean): void {
		const el = dom.append(box, dom.$('.dsa-row'));
		el.dataset.state = row.state;
		el.dataset.chat = row.id;
		el.dataset.focusKey = `row:${row.id}`;
		el.tabIndex = 0;
		el.setAttribute('role', 'button');
		const l1 = dom.append(el, dom.$('.dsa-l1'));
		dom.append(l1, dom.$('span.dsa-slot')).appendChild(stateMark(row.state === 'done' ? 'seen' : row.state));
		dom.append(l1, dom.$('span.dsa-name', { title: row.name }, row.name));
		dom.append(l1, dom.$('span.dsa-meta'));
		if (row.state !== 'done') {
			const l2 = dom.append(el, dom.$('.dsa-l2'));
			const step = dom.append(l2, dom.$('span.dsa-step'));
			if (row.state === 'sub-agent' && !still) {
				step.classList.add('shimmer');
				step.style.setProperty('--dsa-phase', `-${Date.now() % SHIMMER_MS}ms`);
			}
			dom.append(l2, dom.$('span.dsa-ago'));
		}
		const open = () => {
			const chat = subAgentsOf(session).find(c => c.resource.toString() === row.id);
			if (chat && !onSubAgentRowClick(session, chat)) {
				void this._sessionsService.openChat(session, chat.resource);
			}
		};
		this._draw.add(dom.addDisposableListener(el, dom.EventType.CLICK, open));
		this._draw.add(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
		}));
	}

	/** The words and clocks, on the nodes there are. */
	private update(strip: IStrip): void {
		const box = this._slot?.firstElementChild as HTMLElement | null;
		if (!box) {
			return;
		}
		const head = box.querySelector<HTMLElement>('.dsa-head')!;
		head.querySelector('.dsa-headline')!.textContent = strip.head;
		head.querySelector('.dsa-line')!.textContent = this._folded ? strip.line : '';
		head.setAttribute('aria-label', this._folded
			? localize('dispatchSubagents.headFolded', "{0}. {1}. Show them", strip.head, strip.line)
			: localize('dispatchSubagents.headOpen', "{0}. Fold them into one line", strip.head));
		head.title = this._folded ? strip.line : '';
		for (const row of [...strip.rows, ...strip.finished]) {
			const el = box.querySelector<HTMLElement>(`.dsa-row[data-chat="${CSS.escape(row.id)}"]`);
			if (!el) {
				continue;
			}
			el.querySelector('.dsa-name')!.textContent = row.name;
			el.querySelector('.dsa-meta')!.textContent = row.meta;
			const step = el.querySelector<HTMLElement>('.dsa-step');
			if (step) {
				step.textContent = row.second;
				step.title = row.second;
			}
			const ago = el.querySelector('.dsa-ago');
			if (ago) {
				ago.textContent = row.stepTime;
			}
			el.setAttribute('aria-label', row.state === 'sub-agent'
				? localize('dispatchSubagents.rowWorking', "{0}, working for {1}{2}. Open its conversation", row.name, row.meta, row.second ? `, on: ${row.second}` : '')
				: row.state === 'stopped'
					? localize('dispatchSubagents.rowStopped', "{0}, {1}. Open its conversation", row.name, row.second)
					: localize('dispatchSubagents.rowBack', "{0}, back, took {1}. Open its conversation", row.name, row.meta));
		}
	}

	/** What the strip's nodes are: which rows in which state, folded or not; the words and clocks are not in it. */
	private shape(strip: IStrip, still: boolean): string {
		return JSON.stringify([strip.rows.map(r => [r.id, r.state]), strip.finished.map(r => r.id), this._folded, this._finishedOpen, still]);
	}
}

function icon(i: ThemeIcon, cls = ''): HTMLElement {
	const el = dom.$(`span${ThemeIcon.asCSSSelector(i)}${cls}`);
	el.setAttribute('aria-hidden', 'true');
	return el;
}
