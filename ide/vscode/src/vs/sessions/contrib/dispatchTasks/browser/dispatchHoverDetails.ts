/*---------------------------------------------------------------------------------------------
 * Dispatch: complete waiting and task details shared by sidebar cards, graph and timeline.
 *--------------------------------------------------------------------------------------------*/
import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { linkifyDispatchTasksWith } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTaskLinks.js';
import { dismissDispatchHoverDetail, holdDispatchHoverCard, renderDispatchHoverCard, setupDispatchRowDetail } from '../../../../workbench/browser/dispatchHoverCard.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { answerWaitingItem, refreshDispatchWaiting } from '../../sessions/browser/dispatchWaiting.js';
import { DispatchWaitingAnswer, enterWaitingHover, IDispatchWaitingItem, leaveWaitingHover, restoreDispatchWaitingItems, waitingFor, waitingOptionLabel, waitingTitle } from '../../sessions/browser/dispatchWaitingModel.js';
import { openWaitingItem } from '../../sessions/browser/dispatchWaitingQueue.js';
import { agentName, askTasks, deliverableLabel, DISPATCH_OPEN_TASK_COMMAND, DispatchTaskStatus, IDispatchDeliverable, IDispatchPlanItem, openDeliverable, openTaskSession, sessionForTask, STATUS_LABEL, when } from './dispatchTasksModel.js';

const $ = DOM.$;
export function detailButton(parent: HTMLElement, label: string, cls: string, run: () => void, store: DisposableStore): HTMLButtonElement {
	const b = DOM.append(parent, $<HTMLButtonElement>(`button.dispatch-detail-btn.${cls}`, { type: 'button' }, label));
	store.add(DOM.addDisposableListener(b, 'click', e => { e.preventDefault(); e.stopPropagation(); run(); }));
	return b;
}

export function bindWaitingDetail(accessor: ServicesAccessor, card: HTMLElement, row: HTMLElement, item: IDispatchWaitingItem, store: DisposableStore): void {
	const instantiation = accessor.get(IInstantiationService);
	setupDispatchRowDetail(card, row, s => instantiation.invokeFunction(renderWaitingDetail, item, s), store, {
		onShow: () => enterWaitingHover(item.id, 'card'), onHide: () => leaveWaitingHover(item.id),
	});
}

export function renderWaitingDetail(accessor: ServicesAccessor, item: IDispatchWaitingItem, store: DisposableStore): HTMLElement {
	const instantiation = accessor.get(IInstantiationService), commands = accessor.get(ICommandService), hovers = accessor.get(IHoverService);
	const kind = { approve: 'Approve', decide: 'Decide', unread: 'Unread', only_you: 'Only you' }[item.kind];
	const card = renderDispatchHoverCard({ head: waitingTitle(item) });
	card.dataset.waitingId = item.id;
	card.prepend($('.dispatch-detail-meta', undefined, [kind, item.project, waitingFor(item.stopped_at ?? item.at)].filter(Boolean).join(' · ')));
	if (item.title && item.title !== waitingTitle(item)) { DOM.append(card, $('.dispatch-hover-note', undefined, `Session: ${item.title}`)); }
	const story = (item.description || item.phrase).replace(/(?:~?\/[^\s，。]+\/)([^/\s，。]+)/g, '$1').split(/(?<=[.!?。！？])\s*/).slice(0, 2).join(' ');
	const text = item.kind === 'approve' ? item.arg || item.phrase : item.kind === 'decide' ? item.question || item.phrase : item.kind === 'unread' ? item.summary || item.phrase : item.story || story;
	DOM.append(card, $(item.kind === 'approve' ? '.dispatch-hover-text.code' : '.dispatch-hover-text', undefined, text));
	const feedback = $('.dispatch-detail-feedback', { role: 'status', tabindex: '-1' });
	let busy = false;
	const act = async (a: DispatchWaitingAnswer | { act: 'read' | 'done' | 'snooze' }) => {
		if (busy) { return; }
		busy = true;
		const hold = holdDispatchHoverCard(card);
		card.setAttribute('aria-busy', 'true');
		const buttons = [...card.querySelectorAll<HTMLButtonElement>('button')];
		buttons.forEach(b => b.disabled = true);
		try {
			const ok = await instantiation.invokeFunction(answerWaitingItem, item, a, card);
			if (!ok) { buttons.forEach(b => b.disabled = false); return; }
			feedback.textContent = { allow: 'Allowed', deny: 'Denied', pick: 'Answered', read: 'Marked read', done: 'Done', snooze: 'Hidden until tomorrow' }[a.act];
			card.appendChild(feedback);
			feedback.focus({ preventScroll: true });
			if (a.act === 'read' || a.act === 'done' || a.act === 'snooze') {
				const op = a.act === 'read' ? 'unread' : a.act === 'done' ? 'reopen' : 'unsnooze';
				detailButton(feedback, 'Undo', 'ghost', () => {
					void commands.executeCommand<{ ok?: boolean }>('dispatch.waiting', op, item.task || item.id).then(async result => {
						if (result?.ok === false) { feedback.textContent = 'Could not undo. Try again in Waiting for you.'; return; }
						restoreDispatchWaitingItems([item]); await refreshDispatchWaiting();
						feedback.remove(); buttons.forEach(b => b.disabled = false);
					}, () => { feedback.textContent = 'Could not undo. Try again in Waiting for you.'; });
				}, store);
			}
		} finally { busy = false; card.removeAttribute('aria-busy'); hold.dispose(); }
	};
	if (item.kind === 'decide' && item.actions.includes('pick')) {
		const options = DOM.append(card, $('.dispatch-detail-options'));
		for (const option of item.options ?? []) { detailButton(options, waitingOptionLabel(option), 'outline', () => void act({ act: 'pick', option }), store); }
	}
	const bar = DOM.append(card, $('.dispatch-hover-actions'));
	detailButton(bar, item.open ? 'Open prototype' : item.kind === 'only_you' ? 'Open' : 'Open session', 'ghost', () => {
		dismissDispatchHoverDetail(card); hovers.hideHover(true); void instantiation.invokeFunction(a => openWaitingItem(a, item));
	}, store);
	DOM.append(bar, $('span.dispatch-hover-sp'));
	if (item.kind === 'approve' && item.actions.includes('allow')) {
		detailButton(bar, 'Deny', 'outline', () => void act({ act: 'deny' }), store);
		detailButton(bar, 'Allow', 'primary', () => void act({ act: 'allow' }), store);
	} else if (item.kind === 'unread') {
		detailButton(bar, 'Mark read', 'primary', () => void act({ act: 'read' }), store);
	} else if (item.kind === 'only_you') {
		// Not now: hidden until tomorrow morning (it was a bulk button on the page until 2026-11-11, task-0v1o9)
		detailButton(bar, 'Not now', 'outline', () => void act({ act: 'snooze' }), store).title = 'Hide until tomorrow morning';
		detailButton(bar, 'Done', 'primary', () => void act({ act: 'done' }), store);
	}
	store.add(linkifyDispatchTasksWith(commands, card));
	return card;
}

export interface IDetailTask {
	readonly id: string;
	readonly title: string;
	readonly status: DispatchTaskStatus;
	readonly project?: string;
	readonly thing?: string | { readonly name: string };
	readonly from?: string | { readonly id: string; readonly source: string; readonly thing?: string; readonly title?: string } | null;
	readonly session?: string;
	readonly session_window?: string;
	readonly session_title?: string;
	readonly agent?: string;
	readonly plan?: readonly IDispatchPlanItem[];
	readonly deliverables?: readonly IDispatchDeliverable[];
	readonly last?: { readonly at: number; readonly text: string } | null;
	readonly at?: number;
	readonly created_at?: number;
	readonly done_at?: number | null;
	/** Where it came from on the graph: a new thing branched off another, or back to this one after a while. */
	readonly origin?: IDetailOrigin;
}
export interface IDetailOrigin { readonly kind: 'branch' | 'merge'; readonly gapDays: number; readonly fromThing?: string; readonly fromTitle?: string; readonly inferred?: boolean }
interface IGraphLink { readonly from: string; readonly to: string; readonly kind: string; readonly gap_days?: number; readonly source?: string }
const graphs = new Map<string, { at: number; value: Promise<{ nodes?: IDetailTask[]; links?: IGraphLink[]; error?: string }> }>();

export function prefetchTaskDetails(commands: ICommandService, project: string): Promise<{ nodes?: IDetailTask[]; links?: IGraphLink[]; error?: string }> {
	let graph = graphs.get(project);
	if (!graph || Date.now() - graph.at > 20_000) {
		const value = askTasks<{ nodes?: IDetailTask[]; links?: IGraphLink[] }>(commands, { op: 'graph', project }).then(data => {
			if (data.error) { graphs.delete(project); }
			return data;
		});
		graph = { at: Date.now(), value };
		graphs.set(project, graph);
	}
	return graph.value;
}

export function renderTaskDetail(accessor: ServicesAccessor, task: IDetailTask, store: DisposableStore): HTMLElement {
	const commands = accessor.get(ICommandService), instantiation = accessor.get(IInstantiationService), hovers = accessor.get(IHoverService);
	const management = accessor.get(ISessionsManagementService);
	const customViews = accessor.get(ICustomViewService);
	const card = $('.dispatch-hover-card');
	card.dataset.taskId = task.id;
	let loadingOrigin = !!task.project && (typeof task.from === 'string' || typeof task.thing === 'string');
	let originError = false;
	const fill = (t: IDetailTask) => {
		DOM.clearNode(card);
		DOM.append(card, $('.dispatch-detail-meta', undefined, `${STATUS_LABEL[t.status]} · ${when(t.done_at || t.at || t.created_at)}`));
		DOM.append(card, $('.dispatch-hover-head', undefined, t.title));
		DOM.append(card, $('.dispatch-hover-note', undefined, [t.project, typeof t.thing === 'string' ? t.thing : t.thing?.name].filter(Boolean).join(' · ')));
		const fields = DOM.append(card, $('dl.dispatch-detail-fields'));
		const field = (key: string, value?: string) => {
			const row = DOM.append(fields, $('.dispatch-detail-field'));
			DOM.append(row, $('dt', undefined, key));
			return DOM.append(row, $('dd.dispatch-detail-value', undefined, value ?? ''));
		};
		const plan = t.plan ?? [], active = plan.findIndex(p => p.state === 'active'), next = plan.findIndex(p => p.state === 'todo');
		const step = active >= 0 ? active : next >= 0 ? next : plan.length - 1;
		const p = field('Plan', plan.length ? `${plan.filter(x => x.state === 'done').length} of ${plan.length} done · Step ${step + 1}` : 'No plan');
		if (plan.length) {
			const ol = DOM.append(p, $('ol'));
			for (const it of plan) { DOM.append(ol, $(`li.${it.state}`, undefined, it.text)); }
		}
		const delivered = field('Delivered', t.deliverables?.length ? '' : 'Nothing yet');
		for (const d of t.deliverables ?? []) {
			const b = detailButton(delivered, deliverableLabel(d), 'ghost', () => { hovers.hideHover(true); void instantiation.invokeFunction(openDeliverable, d, t.id); }, store);
			b.className = 'dispatch-detail-link';
		}
		field('Session', t.session_title || (t.session ? sessionForTask(management, t.session, t.session_window)?.title.get() || 'Session unavailable' : 'Not recorded'));
		const thingName = typeof t.thing === 'string' ? t.thing : t.thing?.name;
		const o = t.origin;
		const days = o?.gapDays ?? 0;
		// branch and merge read differently: a new thing branched off another, or back to this one after a while
		const origin = field(o?.kind === 'merge' ? 'Came back' : 'Branched off', o
			? [o.kind === 'branch'
				? `Branched off ${o.fromThing || 'a previous request'}`
				: days >= 1 ? `Back to ${thingName || 'this'} after ${days} ${days === 1 ? 'day' : 'days'}` : `Back to ${thingName || 'this'}`,
			o.kind === 'branch' ? `asked while the session was on: ${o.fromTitle || 'Not recorded'}` : `from ${o.fromThing || 'a previous request'}: ${o.fromTitle || 'Not recorded'}`,
			...(o.inferred ? ['inferred from session order'] : [])].join('\n')
			: t.from && typeof t.from !== 'string' ? `${t.from.thing || 'Previous request'} · ${t.from.title || 'Not recorded'}` : loadingOrigin ? 'Loading origin' : originError ? 'Origin unavailable' : 'Not recorded');
		origin.classList.toggle('dispatch-detail-loading', loadingOrigin);
		field('Last activity', t.last ? `${t.last.text}\n${when(t.last.at)}` : 'Not recorded');
		field('Who', t.agent ? agentName(t.agent) : 'Not recorded');
		const bar = DOM.append(card, $('.dispatch-hover-actions'));
		if (t.session) { detailButton(bar, 'Open session', 'ghost', () => { hovers.hideHover(true); void instantiation.invokeFunction(openTaskSession, t.session!, t.session_window).then(ok => { if (ok) { customViews.hideCustomView(); } }); }, store); }
		DOM.append(bar, $('span.dispatch-hover-sp'));
		detailButton(bar, 'Open task', 'primary', () => { hovers.hideHover(true); void commands.executeCommand(DISPATCH_OPEN_TASK_COMMAND, t.id); }, store);
		store.add(linkifyDispatchTasksWith(commands, card));
	};
	fill(task);
	// List rows carry their complete plan; the graph resolves the readable parent, including inferred links.
	if (loadingOrigin && task.project) {
		void prefetchTaskDetails(commands, task.project).then(g => {
			if (store.isDisposed) { return; }
			loadingOrigin = false;
			originError = !!g.error;
			const found = g.nodes?.find(n => n.id === task.id);
			const link = task.origin ? undefined : g.links?.find(l => l.to === task.id && (l.kind === 'branch' || l.kind === 'merge'));
			const parent = link && g.nodes?.find(n => n.id === link.from);
			const origin: IDetailOrigin | undefined = task.origin ?? (link ? { kind: link.kind as 'branch' | 'merge', gapDays: link.gap_days ?? 0, fromThing: typeof parent?.thing === 'string' ? parent.thing : parent?.thing?.name, fromTitle: parent?.title, inferred: link.source !== 'explicit' } : undefined);
			fill({ ...task, ...(found ?? {}), ...(origin ? { origin } : {}) });
		});
	}
	return card;
}
