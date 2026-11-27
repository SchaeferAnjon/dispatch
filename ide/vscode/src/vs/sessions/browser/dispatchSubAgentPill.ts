/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: one sub-agent drawn as VS Code's own sub-agent block (task-518qw; the person 2026-11-16: the sub-agent
 *  rows look like the block in the conversation, 「左栏做成这种的就可以」, and the three places alike).
 *
 *  The block in the conversation is VS Code's ChatSubagentContentPart, whose pill is OpenSubagentChatActionViewItem
 *  (workbench/contrib/chat/browser/widget/chatContentParts/chatSubagentOpenChat.ts): an outlined pill with the spinner
 *  while it works and the open icon once back, what it was sent to do, "Working for 3m 40s" in italics after it, and
 *  under it an L-shaped line to the step it is on. The sidebar rows under a session (dispatchSubAgentRows.ts), the strip
 *  above the message box (contrib/dispatchSubagents) and the Now tab (contrib/dispatchNow) draw that same view item,
 *  with the same context the block gives it, read from the tool call that sent the sub-agent out; only whether it
 *  works comes from the sub-agent's own chat (the Agent Host's end of it, task-518qw). A click opens it read only in a
 *  tab next to the conversation, as "Open Subagent" in the block does (openChatToSide); "N finished" is the same
 *  quiet line in all three.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSubAgentPill.css';
import * as DOM from '../../base/browser/dom.js';
import { Action } from '../../base/common/actions.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { formatCompactSubagentDuration, IOpenSubagentChatContext, OpenSubagentChatActionViewItem } from '../../workbench/contrib/chat/browser/widget/chatContentParts/chatSubagentOpenChat.js';
import { IChatService, IChatToolInvocation } from '../../workbench/contrib/chat/common/chatService/chatService.js';
import { renderAsPlaintext } from '../../base/browser/markdownRenderer.js';
import { IChat, ISession } from '../services/sessions/common/session.js';
import { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import { modelLabel, openSubAgentElsewhere, subAgentElapsed, subAgentStart, subAgentState } from './dispatchSubAgents.js';

/** The kinds VS Code's block leaves out of the pill (chatSubagentContentPart.ts GENERIC_SUBAGENT_TYPES). */
const GENERIC = new Set(['default', 'general-purpose', 'task']);

interface ISpawn {
	readonly toolCallId: string;
	readonly description?: string;
	readonly agentName?: string;
	readonly agentDisplayName?: string;
	readonly modelId?: string;
	readonly modelName?: string;
	readonly startedAt?: number;
	readonly duration?: number;
	readonly parentModelId?: string;
	/** The step it is on: its newest call not finished, in the reply of the conversation that sent it. */
	readonly step?: string;
}

function sentBy(chat: IChat, toolCallId: string, chatResource: string | undefined): boolean {
	const resource = chat.resource.toString();
	const fragment = chat.resource.fragment;
	return chatResource === resource || fragment === `subagent/${toolCallId}` || fragment === toolCallId || resource.endsWith(`/subagent/${toolCallId}`);
}

/** The tool call that sent `chat` out, from the conversation of `session` that the window holds. */
function spawnOf(chatService: IChatService, session: ISession, chat: IChat): ISpawn | undefined {
	const requests = chatService.getSession(session.mainChat.get().resource)?.getRequests() ?? [];
	for (let r = requests.length - 1; r >= 0; r--) {
		const parts = requests[r].response?.response.value ?? [];
		for (const part of parts) {
			if ((part.kind !== 'toolInvocation' && part.kind !== 'toolInvocationSerialized') || part.toolSpecificData?.kind !== 'subagent' || !sentBy(chat, part.toolCallId, part.toolSpecificData.chatResource)) {
				continue;
			}
			const data = part.toolSpecificData;
			// the step under the pill, as the block in the conversation shows it: the call it runs, else the last one it ran
			// (ChatSubagentContentPart's active tool, else its most recent one)
			let step: string | undefined;
			let last: string | undefined;
			for (let i = parts.length - 1; i >= 0 && !step; i--) {
				const p = parts[i];
				if ((p.kind === 'toolInvocation' || p.kind === 'toolInvocationSerialized') && p.subAgentInvocationId === part.toolCallId && !IChatToolInvocation.isEffectivelyHidden(p)) {
					const words = renderAsPlaintext(p.invocationMessage).replace(/\s+/g, ' ').trim();
					if (!IChatToolInvocation.isComplete(p)) {
						step = words;
					} else {
						last ??= words;
					}
				}
			}
			step ||= last;
			return {
				toolCallId: part.toolCallId, description: data.description, agentName: data.agentName, agentDisplayName: data.agentDisplayName,
				modelId: data.modelId, modelName: data.modelName, startedAt: data.startedAt, duration: data.duration, parentModelId: requests[r].modelId, step,
			};
		}
	}
	return undefined;
}

/** What VS Code's pill needs to draw `chat` as the block in the conversation draws it. */
export function subAgentPillContext(chatService: IChatService, session: ISession, chat: IChat): IOpenSubagentChatContext {
	const spawn = spawnOf(chatService, session, chat);
	const working = subAgentState(chat) === 'sub-agent';
	const elapsed = subAgentElapsed(chat);
	// one start for the three places, so their clocks say the same
	const startedAt = spawn?.startedAt ?? subAgentStart(chat);
	const agentName = spawn?.agentName?.trim().toLowerCase();
	const agentType = agentName && !GENERIC.has(agentName) ? spawn?.agentDisplayName?.trim() || undefined : undefined;
	// a terminal session's sub-agent has no tool call in a conversation: its own model, from Claude Code's record
	const modelName = spawn ? spawn.modelName : modelLabel(chat.modelId.get()) || undefined;
	return {
		chatResource: chat.resource.toString(),
		isChatAvailable: true,
		parentSessionResource: session.mainChat.get().resource.toString(),
		title: chat.title.get() || spawn?.description,
		...(agentType ? { agentType } : {}),
		startedAt,
		duration: working ? undefined : spawn?.duration ?? elapsed,
		isActive: working,
		...(spawn?.modelId ? { modelId: spawn.modelId } : {}),
		...(modelName ? { modelName } : {}),
		...(spawn?.parentModelId ? { parentModelId: spawn.parentModelId } : {}),
		...(working && spawn?.step ? { activeToolLabel: spawn.step } : {}),
	};
}

/** Opens a sub-agent the way "Open Subagent" in the block does: read only, in a tab next to its session's conversation. */
export async function openSubAgent(sessionsService: ISessionsService, session: ISession, chat: IChat): Promise<void> {
	if (openSubAgentElsewhere(session, chat)) {
		return;
	}
	await sessionsService.openChatToSide(session, chat.resource, { referenceChatResource: session.mainChat.get().resource });
}

/**
 * One sub-agent as VS Code's pill, inside the wrapper its css is written for. `update()` gives it the context again
 * (the state, the step); the pill keeps its own clock and spinner.
 */
export class DispatchSubAgentPill extends Disposable {

	readonly element: HTMLElement;
	private readonly _item: OpenSubagentChatActionViewItem;
	private _sig = '';

	constructor(
		private readonly _session: ISession,
		private readonly _chat: IChat,
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatService private readonly _chatService: IChatService,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super();
		this.element = DOM.$('.chat-subagent-open-chat-toolbar.dispatch-subagent-pill');
		const bar = DOM.append(this.element, DOM.$('.monaco-action-bar'));
		const list = DOM.append(bar, DOM.$('ul.actions-container', { role: 'presentation' }));
		const li = DOM.append(list, DOM.$('li.action-item', { role: 'presentation' }));
		const action = this._register(new Action('dispatch.openSubAgent', localize('dispatchSubAgentPill.open', "Open Subagent"), undefined, true, () => openSubAgent(sessionsService, _session, _chat)));
		this._item = this._register(instantiationService.createInstance(OpenSubagentChatActionViewItem, undefined, action, {}, false));
		// it can always be opened: the pill would ask the Agent Host's chat URI, which a terminal's sub-agent has not got
		this._item.trackEnabled((_context, update) => { update(true); return toDisposable(() => { }); });
		this._item.render(li);
		// Tab reaches it and Enter or Space opens it, as a button (VS Code's toolbar does this for the block)
		li.tabIndex = 0;
		this._register(DOM.addDisposableListener(li, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				DOM.EventHelper.stop(e, true);
				void action.run();
			}
		}));
		this.element.dataset.chat = _chat.resource.toString();
		this.update();
	}

	update(): void {
		const context = subAgentPillContext(this._chatService, this._session, this._chat);
		// the start time moves when it is worked out from the clock: the pill keeps its own
		const sig = JSON.stringify({ ...context, startedAt: undefined });
		if (sig === this._sig) {
			return;
		}
		this._sig = sig;
		const state = subAgentState(this._chat);
		this.element.dataset.state = state;
		this._item.setActionContext(context);
		// one that ended without finishing (killed, stopped, failed, gone with its process) says so where VS Code says
		// "Worked for": it did not work to the end (task-518qw)
		const duration = this.element.querySelector<HTMLElement>('.chat-subagent-pill-duration');
		if (state === 'stopped' && duration && context.startedAt !== undefined) {
			duration.textContent = localize('dispatchSubAgentPill.stopped', "Stopped after {0}", formatCompactSubagentDuration(context.startedAt, context.duration));
		}
	}
}

/**
 * "N finished": a chevron and the words, VS Code's quiet description line; it opens and closes the finished ones in
 * place (the strip, Now) or under the session (the sidebar). `onDismiss` adds the × that puts them away.
 */
export function renderFinishedToggle(container: HTMLElement, count: number, open: boolean, store: DisposableStore, onToggle: () => void, onDismiss?: () => void): HTMLElement {
	const row = DOM.append(container, DOM.$('.dispatch-subagent-finished'));
	const button = DOM.append(row, DOM.$<HTMLButtonElement>('button.dispatch-subagent-finished-toggle', { type: 'button' }));
	button.dataset.part = 'finished';
	button.setAttribute('aria-expanded', String(open));
	button.setAttribute('aria-label', open
		? localize('dispatchSubAgentPill.hideFinished', "Hide the {0} sub-agents that came back", count)
		: localize('dispatchSubAgentPill.showFinished', "Show the {0} sub-agents that came back", count));
	DOM.append(button, DOM.$(`span.dispatch-subagent-finished-chevron${ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight)}`)).setAttribute('aria-hidden', 'true');
	DOM.append(button, DOM.$('span', undefined, localize('dispatchSubAgentPill.finished', "{0} finished", count)));
	store.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, e => {
		DOM.EventHelper.stop(e, true);
		onToggle();
	}));
	if (onDismiss) {
		const dismiss = DOM.append(row, DOM.$<HTMLButtonElement>(`button.dispatch-subagent-dismiss${ThemeIcon.asCSSSelector(Codicon.close)}`, { type: 'button' }));
		dismiss.title = localize('dispatchSubAgentPill.dismissAll', "Clear the finished sub-agents");
		dismiss.setAttribute('aria-label', dismiss.title);
		store.add(DOM.addDisposableListener(dismiss, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			onDismiss();
		}));
	}
	return row;
}

/** "2 agents working": VS Code's agent icon and the count, the head of the strip and of the sub-agents in Now. */
export function renderWorkingHead(parent: HTMLElement, count: number, tag = 'div'): HTMLElement {
	const head = DOM.append(parent, DOM.$(`${tag}.dispatch-subagent-head`));
	DOM.append(head, DOM.$(`span.dispatch-subagent-head-icon${ThemeIcon.asCSSSelector(Codicon.agent)}`)).setAttribute('aria-hidden', 'true');
	DOM.append(head, DOM.$('span.dispatch-subagent-head-label', undefined, workingLabel(count)));
	return head;
}

export function workingLabel(count: number): string {
	return count === 1 ? localize('dispatchSubAgentPill.oneWorking', "1 agent working") : localize('dispatchSubAgentPill.nWorking', "{0} agents working", count);
}

/**
 * The sub-agents of a session as the strip and Now list them: a pill for each that works, then "N finished", which
 * opens the pills of the ones back in place. Returns the pills, for `update()` on each round.
 */
export function renderSubAgentList(parent: HTMLElement, session: ISession, working: readonly IChat[], back: readonly IChat[], finishedOpen: boolean, store: DisposableStore, instantiationService: IInstantiationService, onToggleFinished: () => void): DispatchSubAgentPill[] {
	const pills: DispatchSubAgentPill[] = [];
	const list = DOM.append(parent, DOM.$('.dispatch-subagent-list'));
	const add = (chat: IChat) => {
		const pill = store.add(instantiationService.createInstance(DispatchSubAgentPill, session, chat));
		DOM.append(list, DOM.$('.dispatch-subagent-row')).appendChild(pill.element);
		pills.push(pill);
	};
	working.forEach(add);
	if (back.length) {
		renderFinishedToggle(list, back.length, finishedOpen, store, onToggleFinished);
		if (finishedOpen) {
			back.forEach(add);
		}
	}
	return pills;
}
