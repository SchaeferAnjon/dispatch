/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Usage page (kanban task-it54z, design/usage-v2 direction A "All on one page"), shown inside
 *  Settings (Account and usage › Usage); the account panel's "Usage" row and the Usage command open it there.
 *
 *  One page, read top to bottom, all from `dispatch usage --json` (kanban app/cli/usage.py) through dispatch-bridge's
 *  `dispatch.usage`: the allowance of every account now and over 14 days, tokens and money, where they went, the
 *  costliest sessions, tools / skills / MCP / sub-agents / hooks / commands, and a year of sessions per engine.
 *  The CLI answers at once with its last reading and refreshes in the background; the page asks again until the
 *  refresh is in.
 *
 *  Colour: the engines' identity colours (`--dispatch-engine-*`, softened toward the background) only in charts, so the
 *  engines can be told apart; the app icon's amber (over 80%, failing) and coral (at the limit, failed a lot) for
 *  state. Everything else is the foreground at a few strengths.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchUsage.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar, ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';
import { Action } from '../../../../base/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable, observableValue } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import {
	agoDay, dayKey, dayLabel, heatStrength, int, IUsageCard, IUsagePage, IUsageTrack, IUsageWindow, IUsageWindowNow, meterCells, meterLevel,
	MONTHS, parseDay, Point, rate, rateLevel, readingAt, resetsBetween, resetWhen, shorten, shortTime, hhmm, tokens, topEngine, usd,
	USAGE_ENGINE_ORDER, weeklyPaths, windows5h,
} from './dispatchUsageModel.js';

const $ = DOM.$;
const SVGNS = 'http://www.w3.org/2000/svg';

export const DISPATCH_USAGE_SHOW = 'dispatch.usage.show';

/** The account panel's own action row, "Usage" with a chevron, opening the Usage page. */
export function appendDispatchUsageRow(panel: HTMLElement, panelStore: DisposableStore, commandService: ICommandService, closePanel: () => void): void {
	const section = DOM.append(panel, DOM.$('.sessions-account-titlebar-panel-actions.dispatch-usage-entry'));
	const actionBar = panelStore.add(new ActionBar(section, { orientation: ActionsOrientation.VERTICAL }));
	panelStore.add(actionBar.onWillRun(closePanel));
	actionBar.push(panelStore.add(new Action(
		DISPATCH_USAGE_SHOW,
		localize('dispatch.usageEntry', "Usage"),
		undefined,
		true,
		() => commandService.executeCommand(DISPATCH_USAGE_SHOW),
	)), { icon: false, label: true });
}

// Usage is a page of Settings (Settings › Account and usage › Usage): whichever way it is opened, the window stays in
// Settings with its contents in the side bar (kanban task-8eudz)
registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_USAGE_SHOW, title: localize2('dispatchUsage.show', "Usage"), f1: true });
	}
	override run(accessor: ServicesAccessor): void {
		void accessor.get(ICommandService).executeCommand('dispatch.settings.open', 'usage');
	}
});

/** undefined: not asked yet; null: the bridge or the CLI failed. Kept across openings: the page opens on it at once. */
const usageData = observableValue<IUsagePage | undefined | null>('dispatchUsage', undefined);
/** The window the spend and tools sections count over: 7, 30 or 90 days. */
const usageWindow = observableValue<string>('dispatchUsageWindow', '30');
let usageError = '';

const POLL_MS = 2500;
const POLL_FOR_MS = 15 * 60 * 1000;

function engineColor(engine: string): string {
	return USAGE_ENGINE_ORDER.includes(engine) ? `var(--dispatch-usage-${engine})` : 'var(--dispatch-usage-other)';
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVGNS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		e.setAttribute(k, String(v));
	}
	if (text !== undefined) {
		e.textContent = text;
	}
	return e;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
	const e = document.createElement(tag);
	if (cls) {
		e.className = cls;
	}
	if (text !== undefined) {
		e.textContent = text;
	}
	return e;
}

/** One line of a hover card: a swatch (optional), a label and a value in the foreground. */
function tipLine(label: string, value?: string, color?: string): HTMLElement {
	const row = el('div', 'dispatch-usage-tip-line');
	if (color) {
		const sw = row.appendChild(el('span', 'dispatch-usage-sw'));
		sw.style.background = color;
	}
	row.appendChild(el('span', 'l', label));
	if (value !== undefined) {
		row.appendChild(el('b', undefined, value));
	}
	return row;
}

function tipCard(title: string, ...lines: HTMLElement[]): HTMLElement {
	const card = el('div', 'dispatch-usage-tip');
	card.appendChild(el('div', 'dispatch-usage-tip-title', title));
	for (const l of lines) {
		card.appendChild(l);
	}
	return card;
}

/** "DeepSeek $4.06 · Tab completion <$0.01": what was billed, by the service that billed it, biggest first. */
function billedLine(by: IUsageWindow['spend']['billed_by']): string {
	const sums = new Map<string, number>();
	for (const b of by) {
		if (b.usd > 0) {
			const key = b.provider ? b.label.replace(/ via .*$/, '') : b.label;
			sums.set(key, (sums.get(key) ?? 0) + b.usd);
		}
	}
	return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${usd(v)}`).join(' · ');
}

// ---- the page ----------------------------------------------------------------------------------

export class DispatchUsageView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchUsage.title', "Usage"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('dispatchUsage.description', "Allowance, tokens, money and tools of every agent on this Mac."));
	override readonly maxWidth = 880;

	private root: HTMLElement | undefined;
	private polling = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
	) {
		super();
		ensureDispatchPalette();
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-usage-page');
		container.tabIndex = -1;
		this.root = container;
		const store = this._register(new DisposableStore());
		void this.load();
		this._register(autorun(reader => {
			const data = usageData.read(reader);
			const win = usageWindow.read(reader);
			store.clear();
			DOM.clearNode(container);
			if (data === undefined) {
				DOM.append(container, $('.dispatch-usage-empty', undefined, localize('dispatchUsage.loading', "Reading…")));
				return;
			}
			if (data === null) {
				DOM.append(container, $('.dispatch-usage-empty', undefined, /invalid choice|unrecognized arguments/.test(usageError)
					? localize('dispatchUsage.oldCli', "The dispatch command on this Mac is older than this app and cannot count usage yet. Update it (run dispatch-update, or reinstall Dispatch) and open this page again.")
					: /ENOENT|not found|spawn/.test(usageError)
						? localize('dispatchUsage.noCli', "Dispatch IDE could not find the dispatch command. Install Dispatch's command line tools (they go to ~/.local/bin/dispatch) and open this page again.")
						: localize('dispatchUsage.failed', "Could not read the usage: {0}", usageError.split('\n')[0] || localize('dispatchUsage.noAnswer', "no answer"))));
				return;
			}
			if (data.state === 'counting' || !data.windows || !data.allowance || !data.heatmap) {
				const p = data.progress ?? {};
				DOM.append(container, $('.dispatch-usage-empty.counting', undefined, p.total
					? localize('dispatchUsage.countingN', "Reading your agents' records for the first time: {0} of {1} transcripts. This takes about a minute once; after that the page opens at once.", int(p.done ?? 0), int(p.total))
					: localize('dispatchUsage.counting', "Reading your agents' records for the first time. This takes about a minute once; after that the page opens at once.")));
				return;
			}
			this.renderPage(container, data, win, store);
		}));
	}

	private async ask(): Promise<IUsagePage | undefined> {
		const res = await this.commandService.executeCommand<IUsagePage>('dispatch.usage');
		return res && typeof res === 'object' && 'v' in res ? res : undefined;
	}

	private async load(): Promise<void> {
		try {
			const res = await this.ask();
			if (res === undefined) {
				usageError = localize('dispatchUsage.badAnswer', "the answer was not the page");
				if (usageData.get() === undefined) {
					usageData.set(null, undefined);
				}
				return;
			}
			usageData.set(res, undefined);
			if (res.state !== 'ready' || res.refreshing) {
				void this.poll(res.generated_at ?? 0);
			}
		} catch (e) {
			this.logService.warn(`[DispatchUsage] ${e}`);
			usageError = String((e as Error)?.message ?? e);
			if (usageData.get() === undefined) {
				usageData.set(null, undefined);
			}
		}
	}

	/** Asks again while the CLI refreshes in the background, until a newer reading is in. */
	private async poll(since: number): Promise<void> {
		if (this.polling) {
			return;
		}
		this.polling = true;
		const end = Date.now() + POLL_FOR_MS;
		try {
			while (Date.now() < end && this.root?.isConnected !== false && !this._store.isDisposed) {
				await new Promise(r => setTimeout(r, POLL_MS));
				let res: IUsagePage | undefined;
				try {
					res = await this.ask();
				} catch {
					continue;
				}
				if (!res) {
					continue;
				}
				if (res.state !== 'ready' || (res.generated_at ?? 0) > since || !res.refreshing) {
					usageData.set(res, undefined);
				}
				if (res.state === 'ready' && !res.refreshing) {
					return;
				}
			}
		} finally {
			this.polling = false;
		}
	}

	// -- the parts

	private renderPage(root: HTMLElement, data: IUsagePage, win: string, store: DisposableStore): void {
		const w = data.windows![win] ?? data.windows!['30'];
		const today = data.today ?? dayKey(new Date());
		const days = Number(win);

		// the bar above everything: when it was read, and the window
		const bar = DOM.append(root, $('.dispatch-usage-bar'));
		const when = data.generated_at ? localize('dispatchUsage.readAt', "Read {0}", data.generated_at > Date.now() / 1000 - 86400 ? hhmm(data.generated_at) : shortTime(data.generated_at)) : '';
		DOM.append(bar, $('span.dispatch-usage-read', undefined, data.refreshing ? localize('dispatchUsage.readAtUpdating', "{0} · updating…", when) : when));
		const seg = DOM.append(bar, $('.dset-seg.dispatch-usage-seg'));
		for (const n of ['7', '30', '90']) {
			const b = DOM.append(seg, $<HTMLButtonElement>('button', { type: 'button' }, localize('dispatchUsage.nDays', "{0} days", n)));
			b.classList.toggle('on', n === win);
			b.dataset.window = n;
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => usageWindow.set(n, undefined)));
		}

		this.renderAllowanceNow(root, data);
		this.renderAllowanceHistory(root, data, store);
		this.renderMoney(root, w, days, store);
		this.renderWhere(root, w, days);
		this.renderSessions(root, w, today, days, store);
		this.renderTools(root, w, today, days, store);
		this.renderActivity(root, data, store);
	}

	private section(parent: HTMLElement, part: string, title: string, meta?: string): HTMLElement {
		const section = DOM.append(parent, $('section.dispatch-usage-section'));
		section.dataset.part = part;
		const head = DOM.append(section, $('.dispatch-usage-head'));
		DOM.append(head, $('h2.dispatch-usage-head-title', undefined, title));
		if (meta) {
			DOM.append(head, $('span.dispatch-usage-head-meta', undefined, meta));
		}
		return section;
	}

	private hover(target: HTMLElement | SVGElement, store: DisposableStore, content: () => HTMLElement | string | undefined): void {
		store.add(DOM.addDisposableListener(target as HTMLElement, DOM.EventType.MOUSE_ENTER, () => {
			const c = content();
			if (!c) {
				return;
			}
			// an SVG mark is not an HTMLElement the hover can anchor to: anchor it to the chart's box at the mark's top centre
			const box = target.getBoundingClientRect();
			const host = DOM.isHTMLElement(target) ? target : (target.closest('div') as HTMLElement | null);
			this.hoverService.showInstantHover({
				content: c,
				target: DOM.isHTMLElement(target) || !host ? target as HTMLElement : { targetElements: [host], x: box.left + box.width / 2, y: box.top },
				position: { hoverPosition: HoverPosition.ABOVE },
				appearance: { showPointer: true, skipFadeInAnimation: true },
			});
		}));
		store.add(DOM.addDisposableListener(target as HTMLElement, DOM.EventType.MOUSE_LEAVE, () => this.hoverService.hideHover(true)));
	}

	// -- 1. allowance now

	private renderAllowanceNow(root: HTMLElement, data: IUsagePage): void {
		const cards = data.allowance!.cards;
		const claude = cards.filter(c => c.kind === 'claude').length;
		const others = cards.filter(c => c.kind === 'glm' || c.kind === 'deepseek').length;
		const parts = [claude === 1 ? localize('dispatchUsage.oneClaude', "1 Claude account") : localize('dispatchUsage.nClaude', "{0} Claude accounts", claude)];
		if (cards.some(c => c.kind === 'codex')) {
			parts.push(localize('dispatchUsage.codexWord', "Codex"));
		}
		if (others) {
			parts.push(others === 1 ? localize('dispatchUsage.oneService', "a service OpenCode has a key for") : localize('dispatchUsage.nServices', "the {0} services OpenCode has a key for", others));
		}
		const section = this.section(root, 'allowance-now', localize('dispatchUsage.allowanceNow', "Allowance now"), parts.join(', '));
		if (!cards.length) {
			DOM.append(section, $('.dispatch-usage-empty', undefined, localize('dispatchUsage.noAccounts', "No subscription on this Mac yet. Sign in to Claude Code or Codex in Settings › Account and usage, and its allowance shows here.")));
			return;
		}
		const grid = DOM.append(section, $('.dispatch-usage-cards'));
		const now = Date.now() / 1000;
		for (const c of cards) {
			grid.appendChild(this.accountCard(c, now));
		}
	}

	private accountCard(c: IUsageCard, now: number): HTMLElement {
		const card = el('div', 'dispatch-usage-card dispatch-usage-acct');
		card.dataset.part = `account-${c.id}`;
		const top = card.appendChild(el('div', 'top'));
		const name = top.appendChild(el('span', 'nm', c.title));
		if (c.account) {
			name.title = c.account;
		}
		if (c.plan) {
			top.appendChild(el('span', 'pl', c.plan));
		}
		if (c.in_use) {
			const tag = top.appendChild(el('span', 'tag'));
			tag.appendChild(el('span', 'dot'));
			tag.appendChild(document.createTextNode(localize('dispatchUsage.inUse', "In use")));
		} else if (c.unnamed) {
			const tag = top.appendChild(el('span', 'tag', localize('dispatchUsage.unnamed', "unnamed")));
			tag.title = localize('dispatchUsage.unnamedTip', "Readings so far did not record which account was signed in; this one is told apart by the hour its week starts over. Readings from now on name the account.");
		} else if (c.via) {
			top.appendChild(el('span', 'tag', c.via));
		}
		const row = (k: string, w: IUsageWindowNow, resetText: [string, string] | undefined) => {
			const r = card.appendChild(el('div', 'row'));
			r.appendChild(el('span', 'k', k));
			r.appendChild(this.meter(w.used));
			r.appendChild(el('span', 'v', `${Math.round(w.used)}%`));
			// the card is narrow: the time alone, after the blocks; what it is on hover
			const when = r.appendChild(el('span', 'r', resetText ? resetText[0] : ''));
			if (resetText) {
				when.title = resetText[1];
			}
		};
		const resetText = (w: IUsageWindowNow): [string, string] | undefined => w.reset_at
			? [localize('dispatchUsage.didResetShort', "reset {0}", resetWhen(w.reset_at, now)), localize('dispatchUsage.didReset', "Started over {0}", shortTime(w.reset_at))]
			: w.resets_at ? [resetWhen(w.resets_at, now), localize('dispatchUsage.resets', "Starts over {0}", shortTime(w.resets_at))] : undefined;
		if (c.session) {
			row(localize('dispatchUsage.fiveHour', "5-hour"), c.session, resetText(c.session));
		}
		if (c.weekly) {
			row(localize('dispatchUsage.week', "Week"), c.weekly, resetText(c.weekly));
		}
		if (c.balance) {
			const r = card.appendChild(el('div', 'row'));
			r.appendChild(el('span', 'k', localize('dispatchUsage.balance', "Balance")));
			r.appendChild(el('span', 'bal', `${c.balance.currency === 'CNY' ? '¥' : c.balance.currency === 'USD' ? '$' : c.balance.currency + ' '}${Number(c.balance.amount).toFixed(2)}`));
		}
		if (c.note) {
			card.appendChild(el('div', 'empty', c.note));
		}
		const foot: string[] = [];
		if (c.weekly?.reset_at && c.weekly.was !== undefined) {
			foot.push(localize('dispatchUsage.wasBefore', "{0}% before the reset", Math.round(c.weekly.was)));
		}
		if (c.read_at) {
			foot.push(c.read_at > now - 86400 ? localize('dispatchUsage.readHm', "Read {0}", hhmm(c.read_at)) : localize('dispatchUsage.lastRead', "Last read {0}", shortTime(c.read_at)));
		}
		if (c.spent_30d !== undefined && c.spent_30d > 0) {
			foot.push(localize('dispatchUsage.spent30', "Spent {0} in 30 days", usd(c.spent_30d)));
		}
		if (foot.length) {
			card.appendChild(el('div', 'note', foot.join(' · ')));
		}
		return card;
	}

	private meter(used: number): HTMLElement {
		const m = el('span', `dispatch-usage-meter ${meterLevel(used)}`);
		m.setAttribute('role', 'meter');
		m.setAttribute('aria-valuenow', String(Math.round(used)));
		for (const cell of meterCells(used)) {
			m.appendChild(el('i', cell));
		}
		return m;
	}

	// -- 2. allowance over 14 days

	private renderAllowanceHistory(root: HTMLElement, data: IUsagePage, store: DisposableStore): void {
		const a = data.allowance!;
		const firsts: string[] = [];
		const firstOf = (engine: string) => Math.min(...a.tracks.filter(t => t.engine === engine).map(t => t.first_at));
		for (const [engine, label] of [['claude-code', 'Claude'], ['codex', 'Codex']] as const) {
			const f = firstOf(engine);
			if (isFinite(f) && f > a.from) {
				firsts.push(localize('dispatchUsage.firstFor', "{0} for {1}", dayLabel(dayKey(new Date(f * 1000))), label));
			}
		}
		const section = this.section(root, 'allowance-history', localize('dispatchUsage.history', "Allowance over {0} days", a.days),
			firsts.length ? localize('dispatchUsage.readingsStart', "Readings start {0}", firsts.join(', ')) : undefined);
		if (!a.tracks.length) {
			DOM.append(section, $('.dispatch-usage-empty', undefined, localize('dispatchUsage.noTracks', "No readings yet. Dispatch reads every account's allowance every few minutes while this window is open, and Codex writes its own into its session logs.")));
			return;
		}
		const grid = DOM.append(section, $('.dispatch-usage-charts'));
		const cards = new Map(a.cards.filter(c => c.track).map(c => [c.track!, c]));
		const now = Date.now() / 1000;
		for (const t of a.tracks) {
			grid.appendChild(this.trackChart(t, cards.get(t.id), a.from, a.to, now, store));
		}
		const legend = DOM.append(section, $('.dispatch-usage-legend'));
		const key = (cls: string, text: string) => {
			const s = DOM.append(legend, $('span'));
			DOM.append(s, $(`span.dispatch-usage-key.${cls}`));
			DOM.append(s, $('span', undefined, text));
		};
		key('line', localize('dispatchUsage.keyWeek', "Week"));
		key('win', localize('dispatchUsage.keyWindow', "A 5-hour window, at its peak"));
		key('win warn', localize('dispatchUsage.keyOver80', "Over 80%"));
		key('win hit', localize('dispatchUsage.keyHit', "Hit the limit"));
		key('dash', localize('dispatchUsage.keyNotRead', "Not read (app closed): the week holds until its reset"));
	}

	private trackChart(t: IUsageTrack, card: IUsageCard | undefined, from: number, to: number, now: number, store: DisposableStore): HTMLElement {
		const box = el('div', 'dispatch-usage-chart');
		box.dataset.part = `chart-${t.id}`;
		const head = box.appendChild(el('div', 'head'));
		head.appendChild(el('span', 'nm', t.title));
		const weekly = t.weekly.filter(p => p[0] >= from - 7 * 86400);
		const last = weekly[weekly.length - 1];
		const live = t.now !== null && t.now !== undefined;
		let sub = '';
		const peak = weekly.filter(p => p[0] >= from).reduce((m, p) => p[1] > m[1] ? p : m, [0, -1] as Point);
		if (live && last) {
			sub = t.reset ? localize('dispatchUsage.subNowReset', "Week {0}% now · resets {1}", Math.round(t.now!), resetWhen(t.reset, now)) : localize('dispatchUsage.subNow', "Week {0}% now", Math.round(t.now!));
		} else if (peak[1] >= 99) {
			sub = t.reset ? localize('dispatchUsage.subHit', "Hit the weekly limit {0} · resets {1}", dayLabel(dayKey(new Date(peak[0] * 1000))), resetWhen(t.reset, now)) : localize('dispatchUsage.subHitNoReset', "Hit the weekly limit {0}", dayLabel(dayKey(new Date(peak[0] * 1000))));
		} else if (last) {
			sub = localize('dispatchUsage.subLast', "{0}% on {1}", Math.round(last[1]), dayLabel(dayKey(new Date(last[0] * 1000))));
			if (t.reset && resetsBetween(t.reset, last[0], now).length) {
				sub += ' · ' + localize('dispatchUsage.subReset', "reset since");
			}
		}
		if (sub) {
			head.appendChild(el('span', 'sub', sub));
		}
		const color = engineColor(t.engine);
		const W = 420, H = 140, padL = 34, padR = 30, padT = 22, plotH = H - 40;
		const X = (x: number) => padL + (Math.max(from, Math.min(to, x)) - from) / (to - from) * (W - padL - padR);
		const Y = (v: number) => padT + plotH - Math.max(0, Math.min(100, v)) / 100 * plotH;
		const s = svg('svg', { viewBox: `0 0 ${W} ${H + 22}`, class: 'dispatch-usage-svg', role: 'img', 'aria-label': `${t.title}: ${sub}` });
		box.appendChild(s);
		for (const v of [0, 50, 100]) {
			s.appendChild(svg('line', { x1: padL, x2: W - padR, y1: Y(v), y2: Y(v), class: 'grid' }));
			s.appendChild(svg('text', { x: padL - 6, y: Y(v) + 4, 'text-anchor': 'end' }, `${v}%`));
		}
		s.appendChild(svg('line', { x1: padL, x2: W - padR, y1: Y(80), y2: Y(80), class: 'line80' }));
		const d0 = new Date(from * 1000);
		d0.setHours(0, 0, 0, 0);
		for (let x = d0.getTime() / 1000 + 86400; x < to; x += 86400) {
			const d = new Date(x * 1000);
			if ((d.getDate() - 1) % 3 || X(x) > W - padR - 12) {
				continue;
			}
			s.appendChild(svg('text', { x: X(x), y: padT + plotH + 16, 'text-anchor': 'middle' }, `${MONTHS[d.getMonth()]} ${d.getDate()}`));
		}
		const paths = weeklyPaths(weekly, to, t.reset, live, X, Y);
		s.appendChild(svg('path', { d: paths.dashed, class: 'dashed', stroke: color }));
		s.appendChild(svg('path', { d: paths.solid, class: 'solid', stroke: color }));
		for (const p of weekly) {
			if (p[0] >= from) {
				s.appendChild(svg('circle', { cx: X(p[0]), cy: Y(p[1]), r: 1.2, fill: color }));
			}
		}
		if (live && last) {
			s.appendChild(svg('circle', { cx: X(last[0]), cy: Y(t.now!), r: 3.5, fill: color }));
			// near the top the 5-hour row is above it: the words go under the dot
			s.appendChild(svg('text', { x: X(last[0]) - 6, y: t.now! > 80 ? Y(t.now!) + 14 : Y(t.now!) - 7, 'text-anchor': 'end', class: 'now' }, localize('dispatchUsage.pctNow', "{0}% now", Math.round(t.now!))));
		}
		const ws = windows5h(t.session.filter(p => p[0] >= from));
		if (ws.length) {
			s.appendChild(svg('text', { x: padL - 6, y: padT - 9, 'text-anchor': 'end' }, '5h'));
		}
		for (const wnd of ws) {
			const lvl = meterLevel(wnd.peak);
			const r = svg('rect', { x: X(wnd.start) - 3.5, y: padT - 16, width: 7, height: 7, rx: 1.5, class: `win ${lvl}` });
			if (!lvl) {
				r.style.fill = `color-mix(in oklch, var(--dset-text) ${Math.round(20 + wnd.peak * 0.5)}%, var(--dset-bg))`;
			}
			s.appendChild(r);
			this.hover(r, store, () => tipCard(localize('dispatchUsage.windowFrom', "5-hour window from {0}", shortTime(wnd.start)),
				tipLine(localize('dispatchUsage.peak', "Peak"), `${Math.round(wnd.peak)}%${wnd.peak >= 99 ? ' · ' + localize('dispatchUsage.hitIt', "hit the limit") : ''}`)));
		}
		// the hover over the plot: what was read then, or why nothing was
		const hit = svg('rect', { x: padL, y: padT, width: W - padL - padR, height: plotH, fill: 'transparent' });
		const vline = svg('line', { y1: padT, y2: padT + plotH, class: 'cross' });
		s.appendChild(vline);
		s.appendChild(hit);
		store.add(DOM.addDisposableListener(hit as unknown as HTMLElement, DOM.EventType.MOUSE_MOVE, (e: MouseEvent) => {
			const rect = s.getBoundingClientRect();
			const scale = rect.width / W;
			const px = (e.clientX - rect.left) / scale;
			const tt = from + (px - padL) / (W - padL - padR) * (to - from);
			vline.setAttribute('x1', String(px));
			vline.setAttribute('x2', String(px));
			vline.classList.add('on');
			const r = readingAt(weekly, t.session, t.reset, tt);
			const body = r.kind === 'read'
				? tipLine(localize('dispatchUsage.weekWord', "Week"), `${Math.round(r.weekly)}%${r.session !== undefined ? ` · 5-hour ${Math.round(r.session)}%` : ''}`)
				: r.kind === 'reset' ? tipLine(localize('dispatchUsage.notReadReset', "Not read. The week reset {0}, so it started again from 0%", shortTime(r.at)))
					: r.kind === 'held' ? tipLine(localize('dispatchUsage.notReadHeld', "Not read; last reading {0}: week {1}%", shortTime(r.at), Math.round(r.weekly)))
						: tipLine(localize('dispatchUsage.noReadingYet', "No reading yet"));
			this.hoverService.showInstantHover({
				content: tipCard(shortTime(tt), body),
				target: { targetElements: [box], x: e.clientX, y: rect.top + padT * scale },
				position: { hoverPosition: HoverPosition.ABOVE },
				appearance: { showPointer: false, skipFadeInAnimation: true },
			});
		}));
		store.add(DOM.addDisposableListener(hit as unknown as HTMLElement, DOM.EventType.MOUSE_LEAVE, () => {
			vline.classList.remove('on');
			this.hoverService.hideHover(true);
		}));
		const hits = ws.filter(x => x.peak >= 99).length;
		const foot: string[] = [t.readings === 1 ? localize('dispatchUsage.oneReading', "1 reading") : localize('dispatchUsage.nReadings', "{0} readings", t.readings)];
		if (ws.length) {
			foot.push(localize('dispatchUsage.windowsHits', "{0} five-hour windows, {1} hit the limit", ws.length, hits));
		} else if (t.engine === 'codex') {
			foot.push(localize('dispatchUsage.noCodex5h', "no 5-hour readings: Codex's sessions reported the week only"));
		}
		if (card?.account) {
			foot.push(card.account);
		}
		box.appendChild(el('div', 'note', foot.join(' · ')));
		return box;
	}

	// -- 3. tokens and money

	private renderMoney(root: HTMLElement, w: IUsageWindow, days: number, store: DisposableStore): void {
		const sp = w.spend;
		const section = this.section(root, 'money', localize('dispatchUsage.money', "Tokens and money"), localize('dispatchUsage.lastNDays', "Last {0} days", days));
		const kpis = DOM.append(section, $('.dispatch-usage-kpis'));
		const kpi = (part: string, label: string, value: string, sub: string) => {
			const k = DOM.append(kpis, $('.dispatch-usage-card.dispatch-usage-kpi'));
			k.dataset.part = part;
			DOM.append(k, $('.l', undefined, label));
			DOM.append(k, $('.v', undefined, value));
			DOM.append(k, $('.s', undefined, sub));
		};
		kpi('kpi-tokens', localize('dispatchUsage.kTokens', "Tokens"), tokens(sp.tokens_total),
			localize('dispatchUsage.kCache', "{0}% of them cache reads", Math.round(sp.cache_share * 100)));
		kpi('kpi-value', localize('dispatchUsage.kValue', "Subscriptions at API prices"), usd(sp.api_value),
			localize('dispatchUsage.kValueSub', "What Claude Code's tokens would cost per call. You pay the plan."));
		kpi('kpi-billed', localize('dispatchUsage.kBilled', "Billed per call"), usd(sp.billed),
			billedLine(sp.billed_by) || localize('dispatchUsage.kNothingBilled', "Nothing billed per call"));

		const keys = USAGE_ENGINE_ORDER.filter(k => sp.engines[k]).concat(Object.keys(sp.engines).filter(k => !USAGE_ENGINE_ORDER.includes(k)));
		const top = DOM.append(section, $('.dispatch-usage-row-end'));
		const metricSeg = DOM.append(top, $('.dset-seg.dispatch-usage-metric'));
		const chartWrap = DOM.append(section, $('.dispatch-usage-bars'));
		const draw = (metric: 'tok' | 'usd') => {
			DOM.clearNode(chartWrap);
			for (const b of metricSeg.querySelectorAll('button')) {
				b.classList.toggle('on', (b as HTMLElement).dataset.m === metric);
			}
			const series: Record<string, readonly number[]> = {};
			for (const k of keys) {
				series[k] = metric === 'tok' ? sp.engines[k].daily_tokens : sp.engines[k].daily_value;
			}
			const shown = metric === 'tok' ? keys : keys.filter(k => sp.engines[k].value + sp.engines[k].billed > 0);
			chartWrap.appendChild(this.stackedBars(w.days, shown, series, metric === 'tok' ? tokens : usd, store));
			const legend = chartWrap.appendChild(el('div', 'dispatch-usage-legend'));
			for (const k of shown) {
				const s = legend.appendChild(el('span'));
				const sw = s.appendChild(el('span', 'dispatch-usage-sw'));
				sw.style.background = engineColor(k);
				s.appendChild(document.createTextNode(this.engineLabel(k)));
				s.appendChild(el('b', undefined, metric === 'tok' ? tokens(sp.engines[k].total) : usd(sp.engines[k].value + sp.engines[k].billed)));
			}
		};
		for (const [m, label] of [['tok', localize('dispatchUsage.mTokens', "Tokens")], ['usd', localize('dispatchUsage.mValue', "API value")]] as const) {
			const b = DOM.append(metricSeg, $<HTMLButtonElement>('button', { type: 'button' }, label));
			b.dataset.m = m;
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => draw(m)));
		}
		draw('tok');
	}

	private engineLabel(k: string): string {
		return usageData.get()?.engines?.[k] ?? k;
	}

	private stackedBars(days: readonly string[], keys: readonly string[], series: Record<string, readonly number[]>, fmt: (v: number) => string, store: DisposableStore): SVGSVGElement {
		const W = 880, H = 120, left = 44;
		const n = days.length, gap = n > 40 ? 1 : 3, bw = (W - left) / n - gap;
		const totals = days.map((_, i) => keys.reduce((a, k) => a + (series[k]?.[i] ?? 0), 0));
		const max = Math.max(...totals) || 1;
		const s = svg('svg', { viewBox: `0 0 ${W} ${H + 22}`, class: 'dispatch-usage-svg', role: 'img' });
		s.appendChild(svg('line', { x1: left, x2: W, y1: H, y2: H, class: 'grid' }));
		s.appendChild(svg('text', { x: left - 6, y: 10, 'text-anchor': 'end' }, fmt(max)));
		s.appendChild(svg('text', { x: left - 6, y: H, 'text-anchor': 'end' }, '0'));
		const every = n > 40 ? 15 : n > 10 ? 5 : 1;
		days.forEach((d, i) => {
			let y = H;
			const x = left + i * (bw + gap);
			const g = svg('g');
			for (const k of keys) {
				const v = series[k]?.[i] ?? 0;
				if (!v) {
					continue;
				}
				const hh = Math.max(1, v / max * (H - 4));
				y -= hh;
				g.appendChild(svg('rect', { x, y, width: Math.max(1, bw), height: hh, rx: 1.5, fill: engineColor(k) }));
			}
			g.appendChild(svg('rect', { x, y: 0, width: bw + gap, height: H, fill: 'transparent' }));
			g.dataset.day = d;
			s.appendChild(g);
			if ((n - 1 - i) % every === 0) {
				s.appendChild(svg('text', { x: x + bw / 2, y: H + 16, 'text-anchor': 'middle' }, dayLabel(d)));
			}
			this.hover(g, store, () => tipCard(dayLabel(d), ...(totals[i]
				? keys.filter(k => series[k]?.[i]).map(k => tipLine(this.engineLabel(k), fmt(series[k][i]), engineColor(k)))
				: [tipLine(localize('dispatchUsage.nothingThatDay', "Nothing that day"))])));
		});
		return s;
	}

	// -- 4. where it went

	private renderWhere(root: HTMLElement, w: IUsageWindow, days: number): void {
		const sp = w.spend;
		const section = this.section(root, 'where', localize('dispatchUsage.where', "Where it went"), localize('dispatchUsage.whereMeta', "API value, last {0} days", days));
		const cols = DOM.append(section, $('.dispatch-usage-cols'));
		const col = (title: string) => {
			const c = DOM.append(cols, $('.dispatch-usage-col'));
			DOM.append(c, $('.dispatch-usage-col-title', undefined, title));
			return DOM.append(c, $('.dispatch-usage-ranked'));
		};
		const ranked = (list: HTMLElement, rows: { label: string; sub: string; parts: [number, string][]; title?: string }[]) => {
			const max = Math.max(1e-9, ...rows.map(r => r.parts.reduce((a, p) => a + p[0], 0)));
			if (!rows.length) {
				DOM.append(list, $('.dispatch-usage-note', undefined, localize('dispatchUsage.nothingYet', "Nothing in these days.")));
			}
			for (const r of rows) {
				const row = DOM.append(list, $('.rk'));
				const label = DOM.append(row, $('.rk-l', undefined, r.label));
				label.title = r.title ?? r.label;
				DOM.append(row, $('.rk-v', undefined, r.sub));
				const bar = DOM.append(row, $('.rk-bar'));
				for (const [v, c] of r.parts) {
					const seg = DOM.append(bar, $('span'));
					seg.style.width = `${Math.max(0.6, v / max * 100)}%`;
					seg.style.background = c;
				}
			}
		};
		const money = (v: number, b: number) => v + b;
		ranked(col(localize('dispatchUsage.byProject', "By project")), sp.projects.filter(p => money(p.value, p.billed) > 0 || p.tokens > 0).slice(0, 7).map(p => {
			const by = Object.entries(p.by).filter(([, v]) => v > 0);
			const valued = money(p.value, p.billed) > 0;
			return {
				label: p.name, sub: valued ? usd(money(p.value, p.billed)) : localize('dispatchUsage.tok', "{0} tok", tokens(p.tokens)),
				parts: valued ? by.map(([k, v]) => [v, engineColor(k)] as [number, string]) : Object.entries(p.tokens_by).map(([k, v]) => [v / 1e6, engineColor(k)] as [number, string]),
				title: localize('dispatchUsage.projectTip', "{0}: {1} sessions, {2} tokens", p.name, p.sessions, tokens(p.tokens)),
			};
		}));
		ranked(col(localize('dispatchUsage.byModel', "By model")), sp.models.filter(m => money(m.value, m.billed) > 0 || m.total > 1e8).slice(0, 7).map(m => ({
			label: m.label, sub: money(m.value, m.billed) > 0 ? usd(money(m.value, m.billed)) : localize('dispatchUsage.tok', "{0} tok", tokens(m.total)),
			parts: [[money(m.value, m.billed) || 0.01, engineColor(m.engine)]],
			title: `${m.model} · ${this.engineLabel(m.engine)}`,
		})));
		const engines = Object.entries(sp.engines).sort((a, b) => b[1].total - a[1].total);
		ranked(col(localize('dispatchUsage.byEngine', "By engine")), engines.map(([k, e]) => ({
			label: this.engineLabel(k),
			sub: `${tokens(e.total)} · ${e.value + e.billed > 0 ? usd(e.value + e.billed) : localize('dispatchUsage.plan', "plan")}`,
			parts: [[e.total, engineColor(k)]],
		})));
		DOM.append(section, $('.dispatch-usage-note', undefined, localize('dispatchUsage.whereNote', "Claude Code at Anthropic's list prices (as of {0}); OpenCode and Pi at what they were billed. Codex and the coding plans are counted in tokens: Dispatch does not know a per-call price for them.", usageData.get()?.prices_as_of ?? '')));
	}

	// -- 5. costliest sessions

	private renderSessions(root: HTMLElement, w: IUsageWindow, today: string, days: number, store: DisposableStore): void {
		const sp = w.spend;
		const rows = sp.sessions.slice(0, 8);
		const total = sp.api_value + sp.billed;
		const top3 = rows.slice(0, 3).reduce((a, s) => a + s.value + s.billed, 0);
		const section = this.section(root, 'sessions', localize('dispatchUsage.sessionsTitle', "Costliest sessions"),
			total > 0 && rows.length >= 3 ? localize('dispatchUsage.top3', "The top 3 are {0}% of these {1} days", Math.round(100 * top3 / total), days) : undefined);
		if (!rows.length) {
			DOM.append(section, $('.dispatch-usage-empty', undefined, localize('dispatchUsage.noSessionsN', "No sessions in these days.")));
			return;
		}
		const table = DOM.append(DOM.append(section, $('.dispatch-usage-tablewrap')), $('table.dispatch-usage-table'));
		const head = DOM.append(DOM.append(table, $('thead')), $('tr'));
		for (const [t, r] of [[localize('dispatchUsage.cSession', "Session"), 0], [localize('dispatchUsage.cProject', "Project"), 0], [localize('dispatchUsage.cEngine', "Engine"), 0],
			[localize('dispatchUsage.cSubagents', "Sub-agents"), 1], [localize('dispatchUsage.cTokens', "Tokens"), 1], [localize('dispatchUsage.cValue', "API value"), 1], [localize('dispatchUsage.cLast', "Last active"), 0]] as const) {
			DOM.append(head, $(r ? 'th.r' : 'th', undefined, t));
		}
		const body = DOM.append(table, $('tbody'));
		for (const s of rows) {
			const tr = DOM.append(body, $('tr.click'));
			tr.tabIndex = 0;
			const title = s.title || localize('dispatchUsage.untitled', "(untitled)");
			const t = DOM.append(tr, $('td.title', undefined, shorten(title, 44)));
			t.title = title;
			DOM.append(tr, $('td.s', undefined, s.project));
			DOM.append(tr, $('td.s', undefined, this.engineLabel(s.engine)));
			DOM.append(tr, $('td.r.s', undefined, s.subagents ? String(s.subagents) : '–'));
			DOM.append(tr, $('td.r', undefined, tokens(s.tokens)));
			DOM.append(tr, $('td.r', undefined, s.value + s.billed > 0 ? usd(s.value + s.billed) : localize('dispatchUsage.plan', "plan")));
			DOM.append(tr, $('td.s', undefined, agoDay(s.last, today)));
			const open = () => void this.openSession(s.id);
			store.add(DOM.addDisposableListener(tr, DOM.EventType.CLICK, open));
			store.add(DOM.addDisposableListener(tr, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { open(); } }));
		}
	}

	private async openSession(id: string): Promise<void> {
		const found = id ? this.management.getSessions().find(x => x.sessionId === id || x.sessionId.endsWith(`/${id}`) || x.resource.path.endsWith(`/${id}`)) : undefined;
		if (!found) {
			this.notificationService.info(localize('dispatchUsage.notHere', "This session is not in the Agents window. It ran in a terminal or another app."));
			return;
		}
		await this.sessionsService.openSession(found.resource);
	}

	// -- 6. tools

	private renderTools(root: HTMLElement, w: IUsageWindow, today: string, days: number, store: DisposableStore): void {
		const T = w.tools;
		const failed = T.totals.calls ? (100 * T.totals.errors / T.totals.calls).toFixed(1) : '0';
		const section = this.section(root, 'tools', localize('dispatchUsage.tools', "Tools, skills and MCP"),
			localize('dispatchUsage.toolsMeta', "{0} calls · {1}% failed · last {2} days", int(T.totals.calls), failed, days));
		const servers = T.mcp.filter(m => m.calls || !m.connector);
		const unusedServers = T.mcp.filter(m => !m.calls && m.offered);
		type Tab = 'mcp' | 'skills' | 'agents' | 'hooks' | 'commands' | 'builtin';
		const tabs: [Tab, string, number][] = [
			['mcp', localize('dispatchUsage.tMcp', "MCP servers"), T.mcp.filter(m => m.calls).length],
			['skills', localize('dispatchUsage.tSkills', "Skills"), T.skills.length],
			['agents', localize('dispatchUsage.tAgents', "Sub-agents"), T.agents.length],
			['hooks', localize('dispatchUsage.tHooks', "Hooks"), T.hooks.length],
			['commands', localize('dispatchUsage.tCommands', "Commands"), T.commands.length],
			['builtin', localize('dispatchUsage.tBuiltin', "Built-in tools"), T.builtin.length],
		];
		const unusedCount: Partial<Record<Tab, number>> = { mcp: unusedServers.length, skills: T.unused_skills.length, agents: T.unused_agents.length, hooks: T.hooks.filter(h => h.errors).length };
		const top = DOM.append(section, $('.dispatch-usage-toolbar'));
		const tabBar = DOM.append(top, $('.dset-seg.dispatch-usage-tabs'));
		DOM.append(top, $('span.grow'));
		const filterBtn = DOM.append(top, $<HTMLButtonElement>('button.dispatch-usage-btn', { type: 'button' }));
		const wrap = DOM.append(section, $('.dispatch-usage-tablewrap'));
		let cur: Tab = 'mcp';
		let only = false;
		const draw = () => {
			for (const b of tabBar.querySelectorAll('button')) {
				b.classList.toggle('on', (b as HTMLElement).dataset.k === cur);
			}
			const n = unusedCount[cur] ?? 0;
			filterBtn.style.display = n ? '' : 'none';
			filterBtn.textContent = only ? localize('dispatchUsage.showAll', "Show all")
				: cur === 'hooks' ? localize('dispatchUsage.failingN', "Failing ({0})", n) : localize('dispatchUsage.unusedN', "Unused in {0} days ({1})", days, n);
			DOM.clearNode(wrap);
			wrap.appendChild(this.toolsTable(w, cur, only, servers, unusedServers, today, days));
		};
		for (const [k, label, n] of tabs) {
			const b = DOM.append(tabBar, $<HTMLButtonElement>('button', { type: 'button' }, `${label} ${n}`));
			b.dataset.k = k;
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => { cur = k; only = false; draw(); }));
		}
		store.add(DOM.addDisposableListener(filterBtn, DOM.EventType.CLICK, () => { only = !only; draw(); }));
		draw();

		// what was offered or installed and not used
		const plain = unusedServers.filter(m => !m.connector);
		const connectors = unusedServers.filter(m => m.connector);
		if (!plain.length && !connectors.length && !T.unused_skills.length && !T.unused_agents.length) {
			return;
		}
		const card = DOM.append(section, $('.dispatch-usage-card.dispatch-usage-unused'));
		card.dataset.part = 'unused';
		DOM.append(card, $('.t', undefined, localize('dispatchUsage.unusedTitle', "Installed, not used in {0} days", days)));
		if (plain.length || connectors.length) {
			DOM.append(card, $('.dispatch-usage-note', undefined, localize('dispatchUsage.unusedNote', "These MCP servers were offered to your sessions and none was called. Each one offered costs room in every session's context.")));
			const chips = DOM.append(card, $('.dispatch-usage-chips'));
			for (const m of plain.filter(x => x.offered >= 10)) {
				DOM.append(chips, $('span.dispatch-usage-pill', undefined, localize('dispatchUsage.offeredIn', "{0} · offered in {1}", m.name, m.offered)));
			}
			if (connectors.length) {
				const c = DOM.append(chips, $('span.dispatch-usage-pill', undefined, localize('dispatchUsage.connectors', "{0} sign-in connectors", connectors.length)));
				c.title = connectors.map(x => x.name).join(', ');
			}
			const few = plain.filter(x => x.offered < 10);
			if (few.length) {
				const c = DOM.append(chips, $('span.dispatch-usage-pill', undefined, localize('dispatchUsage.fewOffered', "+{0} offered in fewer than 10 sessions", few.length)));
				c.title = few.map(x => x.name).join(', ');
			}
		}
		const lines: string[] = [];
		if (T.unused_skills.length) {
			lines.push(localize('dispatchUsage.skillsNever', "Skills never used: {0}.", T.unused_skills.join(', ')));
		}
		if (T.unused_agents.length) {
			lines.push(localize('dispatchUsage.agentsNever', "Sub-agents never run: {0}.", T.unused_agents.join(', ')));
		}
		if (lines.length) {
			DOM.append(card, $('.dispatch-usage-note', undefined, lines.join(' ')));
		}
		const links = DOM.append(card, $('.dispatch-usage-links'));
		for (const [page, label] of [['tools', localize('dispatchUsage.manageMcp', "Manage MCP servers")], ['skills', localize('dispatchUsage.manageSkills', "Manage skills")], ['subagents', localize('dispatchUsage.manageAgents', "Manage sub-agents")]] as const) {
			const b = DOM.append(links, $<HTMLButtonElement>('button.dispatch-usage-link', { type: 'button' }, label));
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => void this.commandService.executeCommand('dispatch.settings.open', page)));
		}
	}

	private toolsTable(w: IUsageWindow, kind: string, only: boolean, servers: IUsageWindow['tools']['mcp'], unusedServers: IUsageWindow['tools']['mcp'], today: string, days: number): HTMLElement {
		const T = w.tools;
		const table = el('table', 'dispatch-usage-table');
		const head = table.appendChild(el('thead')).appendChild(el('tr'));
		const cols = (list: [string, boolean][]) => {
			for (const [t, r] of list) {
				head.appendChild(el('th', r ? 'r' : '', t));
			}
		};
		const body = table.appendChild(el('tbody'));
		const tr = () => body.appendChild(el('tr'));
		const td = (row: HTMLElement, text: string, cls = '') => row.appendChild(el('td', cls, text));
		const failCell = (row: HTMLElement, errors: number | null, calls: number) => {
			if (errors === null) {
				const c = td(row, localize('dispatchUsage.notRecorded', "not recorded"), 'r s');
				c.title = localize('dispatchUsage.notRecordedTip', "Codex does not write whether a tool call failed.");
				return;
			}
			td(row, rate(errors, calls), `r ${rateLevel(errors, calls) || 's'}`).title = errors ? localize('dispatchUsage.nFailed', "{0} of {1} failed", int(errors), int(calls)) : '';
		};
		const projects = (p: readonly string[]) => p.slice(0, 2).join(', ') || '–';
		const never = localize('dispatchUsage.notInDays', "not in {0} days", days);
		const label = (k: string) => this.engineLabel(k);
		if (kind === 'mcp') {
			cols([[localize('dispatchUsage.cServer', "Server"), false], [localize('dispatchUsage.cCalls', "Calls"), true], [localize('dispatchUsage.cToolsUsed', "Tools used"), true],
				[localize('dispatchUsage.cOffered', "Offered in"), true], [localize('dispatchUsage.cProjects', "Projects"), false], [localize('dispatchUsage.cLastUsed', "Last used"), false], [localize('dispatchUsage.cFailed', "Failed"), true]]);
			for (const m of (only ? unusedServers : servers).slice(0, only ? 80 : 20)) {
				const r = tr();
				td(r, m.name).title = m.id;
				td(r, m.calls ? int(m.calls) : '0', m.calls ? 'r' : 'r s');
				td(r, m.tools ? String(m.tools) : '–', 'r s');
				td(r, m.offered ? localize('dispatchUsage.nSessionsWord', "{0} sessions", m.offered) : '–', 'r s');
				td(r, projects(m.projects), 's');
				td(r, m.last ? agoDay(m.last, today) : never, 's');
				failCell(r, m.calls ? m.errors : 0, m.calls);
			}
		} else if (kind === 'skills') {
			cols([[localize('dispatchUsage.cSkill', "Skill"), false], [localize('dispatchUsage.cUses', "Uses"), true], [localize('dispatchUsage.cEngines', "Engines"), false],
				[localize('dispatchUsage.cSessions', "Sessions"), true], [localize('dispatchUsage.cProjects', "Projects"), false], [localize('dispatchUsage.cLastUsed', "Last used"), false], [localize('dispatchUsage.cFailed', "Failed"), true]]);
			if (only) {
				for (const n of T.unused_skills) {
					const r = tr();
					td(r, n); td(r, '0', 'r s'); td(r, '–', 's'); td(r, '0', 'r s'); td(r, '–', 's'); td(r, never, 's'); td(r, '–', 'r s');
				}
			} else {
				for (const x of T.skills.slice(0, 20)) {
					const r = tr();
					td(r, x.name);
					td(r, int(x.count), 'r');
					td(r, Object.entries(x.engines).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${label(k)} ${n}`).join(', '), 's');
					td(r, String(x.sessions), 'r s');
					td(r, projects(x.projects), 's');
					td(r, agoDay(x.last, today), 's');
					failCell(r, x.errors, x.count);
				}
			}
		} else if (kind === 'agents') {
			cols([[localize('dispatchUsage.cSubagent', "Sub-agent"), false], [localize('dispatchUsage.cRuns', "Runs"), true], [localize('dispatchUsage.cSessions', "Sessions"), true],
				[localize('dispatchUsage.cProjects', "Projects"), false], [localize('dispatchUsage.cLastUsed', "Last used"), false], [localize('dispatchUsage.cFailed', "Failed"), true]]);
			if (only) {
				for (const n of T.unused_agents) {
					const r = tr();
					td(r, n); td(r, '0', 'r s'); td(r, '0', 'r s'); td(r, '–', 's'); td(r, never, 's'); td(r, '–', 'r s');
				}
			} else {
				for (const x of T.agents.slice(0, 20)) {
					const r = tr();
					const c = td(r, x.name);
					if (!x.defined) {
						c.appendChild(el('span', 'dispatch-usage-aside', localize('dispatchUsage.builtIn', "built in")));
					}
					td(r, int(x.count), 'r');
					td(r, String(x.sessions), 'r s');
					td(r, projects(x.projects), 's');
					td(r, agoDay(x.last, today), 's');
					failCell(r, x.errors, x.count);
				}
			}
		} else if (kind === 'hooks') {
			cols([[localize('dispatchUsage.cHook', "Hook"), false], [localize('dispatchUsage.cWhen', "When"), false], [localize('dispatchUsage.cRuns', "Runs"), true],
				[localize('dispatchUsage.cLastRun', "Last run"), false], [localize('dispatchUsage.cFailed', "Failed"), true]]);
			for (const x of T.hooks.filter(h => !only || h.errors).slice(0, 20)) {
				const r = tr();
				td(r, x.name);
				td(r, x.event || '–', 's');
				td(r, int(x.count), 'r');
				td(r, agoDay(x.last, today), 's');
				failCell(r, x.errors, x.count);
			}
		} else if (kind === 'commands') {
			cols([[localize('dispatchUsage.cCommand', "Command"), false], [localize('dispatchUsage.cTimes', "Times"), true], [localize('dispatchUsage.cSessions', "Sessions"), true], [localize('dispatchUsage.cLastUsed', "Last used"), false]]);
			for (const x of T.commands.slice(0, 20)) {
				const r = tr();
				td(r, x.name); td(r, int(x.count), 'r'); td(r, String(x.sessions), 'r s'); td(r, agoDay(x.last, today), 's');
			}
		} else {
			cols([[localize('dispatchUsage.cTool', "Tool"), false], [localize('dispatchUsage.cCalls', "Calls"), true], [localize('dispatchUsage.cEngines', "Engines"), false],
				[localize('dispatchUsage.cSessions', "Sessions"), true], [localize('dispatchUsage.cProjects', "Projects"), false], [localize('dispatchUsage.cLastUsed', "Last used"), false], [localize('dispatchUsage.cFailed', "Failed"), true]]);
			for (const x of T.builtin.slice(0, 20)) {
				const r = tr();
				td(r, x.name);
				td(r, int(x.count), 'r');
				td(r, Object.keys(x.engines).map(label).join(', '), 's');
				td(r, String(x.sessions), 'r s');
				td(r, projects(x.projects), 's');
				td(r, agoDay(x.last, today), 's');
				failCell(r, x.errors, x.count);
			}
		}
		if (!body.childElementCount) {
			const r = tr();
			const c = td(r, localize('dispatchUsage.noneHere', "Nothing in these days."), 's');
			(c as HTMLTableCellElement).colSpan = head.childElementCount;
		}
		return table;
	}

	// -- 7. a year of sessions, per engine

	private renderActivity(root: HTMLElement, data: IUsagePage, store: DisposableStore): void {
		const h = data.heatmap!;
		const section = this.section(root, 'activity', localize('dispatchUsage.activity', "Activity"),
			h.total ? localize('dispatchUsage.activityMeta', "{0} sessions on {1} days in the last year", int(h.total), h.active_days) : undefined);
		if (!h.total) {
			DOM.append(section, $('.dispatch-usage-empty', undefined, localize('dispatchUsage.noActivity', "No sessions on this Mac in the last year. Every day you work with an agent adds a square here.")));
			return;
		}
		const to = parseDay(h.to);
		const from = parseDay(h.from);
		const start = new Date(from);
		start.setDate(start.getDate() - start.getDay());
		const weeks = Math.ceil(((to.getTime() - start.getTime()) / 86400000 + 1) / 7);
		const wrap = DOM.append(section, $('.dispatch-usage-heat'));
		wrap.style.setProperty('--weeks', String(weeks));
		const months = DOM.append(wrap, $('.dispatch-usage-heat-months'));
		const body = DOM.append(wrap, $('.dispatch-usage-heat-body'));
		const wd = DOM.append(body, $('.dispatch-usage-heat-weekdays'));
		for (const [i, l] of ['', 'Mon', '', 'Wed', '', 'Fri', ''].entries()) {
			DOM.append(wd, $('span', { style: `grid-row: ${i + 1}` }, l));
		}
		const grid = DOM.append(body, $('.dispatch-usage-heat-grid'));
		let lastMonth = -1;
		for (let wk = 0; wk < weeks; wk++) {
			for (let d = 0; d < 7; d++) {
				const day = new Date(start);
				day.setDate(start.getDate() + wk * 7 + d);
				if (day > to) {
					continue;
				}
				const cell = DOM.append(grid, $('span.dispatch-usage-cell'));
				cell.style.gridColumn = String(wk + 1);
				cell.style.gridRow = String(d + 1);
				if (day < from) {
					cell.classList.add('outside');
					continue;
				}
				const key = dayKey(day);
				const c = h.counts[key];
				if (c) {
					const tot = Object.values(c).reduce((a, b) => a + b, 0);
					const eng = topEngine(c);
					cell.style.background = `color-mix(in oklch, ${engineColor(eng)} ${heatStrength(tot)}%, var(--dispatch-usage-heat-0))`;
					cell.dataset.engine = eng;
					cell.setAttribute('aria-label', `${dayLabel(key)}: ${tot}`);
					this.hover(cell, store, () => tipCard(tot === 1 ? localize('dispatchUsage.dayOne', "{0} · 1 session", dayLabel(key)) : localize('dispatchUsage.dayN', "{0} · {1} sessions", dayLabel(key), tot),
						...Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => tipLine(this.engineLabel(k), String(n), engineColor(k)))));
				}
				if (d === 0 && day.getDate() <= 7 && day.getMonth() !== lastMonth && wk > 0 && wk < weeks - 2) {
					lastMonth = day.getMonth();
					DOM.append(months, $('span', { style: `grid-column: ${wk + 1} / span 4` }, MONTHS[day.getMonth()]));
				}
			}
		}
		const legend = DOM.append(section, $('.dispatch-usage-legend'));
		for (const [k, n] of Object.entries(h.by_engine).sort((a, b) => b[1] - a[1])) {
			const s = DOM.append(legend, $('span'));
			const sw = DOM.append(s, $('span.dispatch-usage-sw'));
			sw.style.background = engineColor(k);
			s.appendChild(document.createTextNode(this.engineLabel(k)));
			DOM.append(s, $('b', undefined, int(n)));
		}
		DOM.append(section, $('.dispatch-usage-note', undefined, localize('dispatchUsage.heatNote', "Each day takes the colour of the engine that ran most sessions; deeper means more sessions.")));
	}

	layout(_width: number, _height: number): void { }

	override focus(): void {
		this.root?.focus();
	}
}
