/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agent strip above the message box. Direction A, the person picked it 2026-11-12
 *  (task-1rzdr, learned from Orca), drawn since 2026-11-16 with VS Code's own sub-agent pill (task-518qw: the three
 *  places that list sub-agents look alike, sessions/browser/dispatchSubAgentPill.ts). While sub-agents of the session
 *  on screen work, a block sits 8 above its message box, as wide as the box: "2 agents working ⌄", folded to one line
 *  by default (the first one and its step after the count); open, one pill per sub-agent that works (the spinner,
 *  what it was sent to do, "Working for 42s", the step it is on under it) and "N finished" for the ones back this
 *  round. It goes once none works; the ones back stay in the Now tab and under the session in the sidebar.
 *
 *  No tokens and no Stop: none of Claude Code, Codex and OpenCode in the Agent Host gives a sub-agent's own token
 *  count or stops one sub-agent alone today (task-1rzdr). A click on a pill opens the sub-agent read only next to the
 *  conversation, as "Open Subagent" in the block does.
 *
 *  Where it sits: in the input part's flow, the way the "Preference remembered" toast does (chat dispatchPrefs.ts),
 *  so the conversation makes room for it. Folded or not is kept for the window. This contribution also gives the
 *  sidebar's sub-agent rows their opener and where what was put away is kept (dispatchSubAgentRows.ts).
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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService, IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { DispatchSubAgentPill, openSubAgent, renderSubAgentList, renderWorkingHead } from '../../../browser/dispatchSubAgentPill.js';
import { bindSubAgentRowStorage, subAgentRowOpen } from '../../../browser/dispatchSubAgentRows.js';
import { subAgentElapsed, subAgentsOf, subAgentState } from '../../../browser/dispatchSubAgents.js';
import { IChat, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IReplyPart, IStrip, IStripAgentInput, runningStep, stepSince, stripOf, subagentStep } from './dispatchSubagentsModel.js';

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
			message: hidden ? '' : renderAsPlaintext(part.invocationMessage),
		};
	});
}

/** Folded or not, for this window. */
const FOLDED_KEY = 'dispatch.subagentStrip.folded';
/** The sub-agents put away from the sidebar (dispatchSubAgentRows.ts). */
const PUT_AWAY_KEY = 'dispatch.subagentRows.putAway';

export class DispatchSubagentStrip extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchSubagentStrip';

	private _slot: HTMLElement | undefined;
	private _folded: boolean;
	private _finishedOpen = false;
	/** The last fold or open came from the keyboard: the focus goes back where it was after the strip is drawn again
	 *  (a mouse click leaves it, so no ring shows where the pointer just was). */
	private _byKey = false;
	private readonly _draw = this._register(new DisposableStore());
	private _pills: DispatchSubAgentPill[] = [];
	/** The step each sub-agent was last seen on, and since when (the folded line). */
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
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		// folded to one line until opened: "2 agents working ⌄" (the person, 2026-11-16)
		this._folded = this._storageService.getBoolean(FOLDED_KEY, StorageScope.WORKSPACE, true);
		// the sidebar's sub-agent rows open like the pill, and keep what was put away for this profile
		subAgentRowOpen.open = (session, chat) => void openSubAgent(this._sessionsService, session, chat);
		bindSubAgentRowStorage(this.putAway(), ids => this._storageService.store(PUT_AWAY_KEY, JSON.stringify(ids), StorageScope.PROFILE, StorageTarget.MACHINE));
		this._register(toDisposable(() => subAgentRowOpen.open = undefined));
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
		// the steps are read again every second while it shows; while one works and it does not show, the message box
		// may have come back without a word (the session's own conversation opened again after a sub-agent's): it looks again
		const timer = mainWindow.setInterval(() => {
			if (this._slot?.childElementCount || this.someoneWorks()) {
				this.render();
			}
		}, 1000);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		this._register(toDisposable(() => this._slot?.remove()));
	}

	private putAway(): string[] {
		const raw = this._storageService.get(PUT_AWAY_KEY, StorageScope.PROFILE);
		if (!raw) {
			return [];
		}
		const ids: unknown = JSON.parse(raw);
		return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
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
			this._draw.clear();
			this._pills = [];
			if (this._slot) {
				dom.clearNode(this._slot);
			}
			this._session = undefined;
			this._widget = undefined;
			return;
		}
		const sameShape = this._session === session && this._widget === widget && !!this._slot?.firstChild
			&& this.shape(strip) === this._slot.firstElementChild?.getAttribute('data-shape');
		this._session = session;
		this._widget = widget;
		if (sameShape) {
			this.update(strip); // only the words moved: the same pills, their clocks and spinners, and the focus stay
			return;
		}
		const focused = mainWindow.document.activeElement as HTMLElement | null;
		const refocus = this._byKey && focused && this._slot?.contains(focused) ? focused.dataset.focusKey : undefined;
		this._byKey = false;
		this.draw(this.slotIn(widget), session, strip);
		if (refocus) {
			this._slot?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(refocus)}"]`)?.focus();
		}
	}

	private draw(slot: HTMLElement, session: ISession, strip: IStrip): void {
		this._draw.clear();
		dom.clearNode(slot);
		const box = dom.append(slot, dom.$('section.dispatch-subagents'));
		box.dataset.part = 'subagent-strip';
		box.dataset.shape = this.shape(strip);
		box.setAttribute('aria-label', localize('dispatchSubagents.aria', "Sub-agents at work"));
		// Enter and Space on the strip's buttons and pills are theirs: they never reach the message box's keys (send)
		this._draw.add(dom.addDisposableListener(box, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.stopPropagation();
				this._byKey = true;
			}
		}));

		const head = renderWorkingHead(box, strip.rows.filter(r => r.state === 'sub-agent').length, 'button') as HTMLButtonElement;
		head.classList.add('dsa-head');
		head.type = 'button';
		head.dataset.focusKey = 'head';
		head.setAttribute('aria-expanded', String(!this._folded));
		dom.append(head, dom.$('span.dsa-line'));
		dom.append(head, dom.$(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}.dsa-car`)).setAttribute('aria-hidden', 'true');
		this._draw.add(dom.addDisposableListener(head, dom.EventType.CLICK, () => {
			this._folded = !this._folded;
			this._storageService.store(FOLDED_KEY, this._folded, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.render();
		}));

		this._pills = [];
		if (!this._folded) {
			// in the order they were sent out, as in the conversation, Now and the sidebar
			const chats = subAgentsOf(session);
			const rows = new Set(strip.rows.map(r => r.id));
			const finished = new Set(strip.finished.map(r => r.id));
			const working = chats.filter(c => rows.has(c.resource.toString()));
			const back = chats.filter(c => finished.has(c.resource.toString()));
			const body = dom.append(box, dom.$('.dsa-body'));
			this._pills = renderSubAgentList(body, session, working, back, this._finishedOpen, this._draw, this._instantiationService, () => {
				this._finishedOpen = !this._finishedOpen;
				this.render();
			});
			body.querySelector<HTMLElement>('.dispatch-subagent-finished-toggle')?.setAttribute('data-focus-key', 'finished');
		}
		this.update(strip);
	}

	/** The words on the nodes there are; each pill reads its own state and step again. */
	private update(strip: IStrip): void {
		const box = this._slot?.firstElementChild as HTMLElement | null;
		if (!box) {
			return;
		}
		const head = box.querySelector<HTMLElement>('.dsa-head')!;
		head.querySelector('.dsa-line')!.textContent = this._folded ? strip.line : '';
		head.setAttribute('aria-label', this._folded
			? localize('dispatchSubagents.headFolded', "{0}. {1}. Show them", strip.head, strip.line)
			: localize('dispatchSubagents.headOpen', "{0}. Fold them into one line", strip.head));
		head.title = this._folded ? strip.line : '';
		for (const pill of this._pills) {
			pill.update();
		}
	}

	/** What the strip's nodes are: which sub-agents in which state, folded or not; the words are not in it. */
	private shape(strip: IStrip): string {
		return JSON.stringify([strip.rows.map(r => [r.id, r.state]), strip.finished.map(r => r.id), this._folded, this._finishedOpen]);
	}
}
