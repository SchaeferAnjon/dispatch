/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "From other apps" on the Automations page (patches/455-automations.patch).
 *  Scheduled jobs Hermes, OpenClaw, Codex, Claude, login items and cron run on their own, found on this
 *  Mac and the other Macs Dispatch knows, shown with what each does in words, when it runs next and its
 *  last runs with their output. Read-only: nothing here changes those jobs; each detail says which app
 *  runs it and where to change it. Learned from Orca's external automations (github.com/stablyai/orca,
 *  MIT): the list, not the look.
 *
 *  Overview, list, detail: the section lists cards like Dispatch's own automations above it; a card
 *  opens its detail in place, with a breadcrumb back. The one hook in the native page is
 *  automationsView.ts creating this between its cards and its history.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchFoundAutomations.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { agentIcon, byMachine, IFoundAutomations, IFoundJob, IFoundMachine, IFoundRun, lastRunWords, nextRunWords, relativeWords, statusIcon, statusWords, whenWords } from './dispatchFoundAutomationsModel.js';

const $ = DOM.$;
const REFRESH_MS = 2 * 60 * 1000;

export class DispatchFoundAutomations extends Disposable {

	private readonly element: HTMLElement;
	private readonly body: HTMLElement;
	private readonly head: HTMLElement;
	private readonly desc: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private here: IFoundAutomations | undefined;
	private others: IFoundAutomations | undefined;
	private loading = true;
	private error: string | undefined;
	private selected: string | undefined;
	private readonly openRuns = new Set<string>();
	private readonly openFolds = new Set<string>();
	private readonly openPrompts = new Set<string>();
	private generation = 0;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		// above the templates: someone with jobs elsewhere sees them before ideas for new ones
		this.element = $('section.dispatch-found');
		parent.insertBefore(this.element, parent.querySelector(':scope > .automations-templates'));
		this.element.setAttribute('aria-labelledby', 'dispatch-found-title');

		const head = this.head = DOM.append(this.element, $('.dispatch-found-head'));
		const title = DOM.append(head, $('h3.dispatch-found-title#dispatch-found-title'));
		title.textContent = localize('dispatchFound.title', "From other apps");
		this.countEl = DOM.append(head, $('span.dispatch-found-count'));
		const refresh = DOM.append(head, $<HTMLButtonElement>('button.dispatch-found-refresh', { type: 'button' }));
		DOM.append(refresh, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		refresh.setAttribute('aria-label', localize('dispatchFound.refresh', "Look again"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), refresh, localize('dispatchFound.refresh', "Look again")));
		this._register(DOM.addDisposableListener(refresh, DOM.EventType.CLICK, () => this.load(true)));

		const desc = this.desc = DOM.append(this.element, $('p.dispatch-found-description'));
		desc.textContent = localize('dispatchFound.description', "Jobs that Hermes, Claude, Codex and other apps run on a schedule. Dispatch only shows them here and never changes them.");

		this.body = DOM.append(this.element, $('.dispatch-found-body'));
		this.render();
		void this.load(true);
		const timer = DOM.getWindow(parent).setInterval(() => {
			if (this.element.isConnected && DOM.getWindow(this.element).document.visibilityState === 'visible') {
				void this.load(false);
			}
		}, REFRESH_MS);
		this._register({ dispose: () => DOM.getWindow(parent).clearInterval(timer) });
	}

	/** fresh: the person asked (Look again), so say it is looking and ask the other Macs now; otherwise a quiet refresh. */
	private async load(fresh: boolean): Promise<void> {
		const gen = ++this.generation;
		this.loading = fresh || !this.here;
		if (this.loading) {
			this.render();
		}
		try {
			const here = await this.commandService.executeCommand<IFoundAutomations>('dispatch.automations', 'here');
			if (gen !== this.generation) {
				return;
			}
			this.here = here ?? { machines: [], jobs: [] };
			this.error = undefined;
		} catch (e) {
			if (gen !== this.generation) {
				return;
			}
			this.error = e instanceof Error ? e.message : String(e);
		}
		this.render();
		// the other Macs: an ssh each, so after this Mac's list is already on screen
		try {
			const others = await this.commandService.executeCommand<IFoundAutomations>('dispatch.automations', fresh && gen > 1 ? 'fresh' : 'others');
			if (gen !== this.generation) {
				return;
			}
			this.others = others ?? undefined;
		} catch {
			// no other Macs, or none answered: this Mac's list stands
		}
		if (gen === this.generation) {
			this.loading = false;
			this.render();
		}
	}

	private data(): IFoundAutomations {
		const unique = <T extends { id: string }>(xs: readonly T[]) => [...new Map(xs.map(x => [x.id, x])).values()];
		return {
			machines: unique([...(this.here?.machines ?? []), ...(this.others?.machines ?? [])]),
			jobs: unique([...(this.here?.jobs ?? []), ...(this.others?.jobs ?? [])]),
		};
	}

	private render(): void {
		this.renderStore.clear();
		DOM.clearNode(this.body);
		const data = this.data();
		this.countEl.textContent = data.jobs.length ? String(data.jobs.length) : '';
		const job = this.selected ? data.jobs.find(j => j.id === this.selected) : undefined;
		// in a job's detail the breadcrumb names the section
		this.head.style.display = this.desc.style.display = job ? 'none' : '';
		if (job) {
			this.renderDetail(job, data.machines.find(m => m.id === job.host));
			return;
		}
		this.selected = undefined;
		if (!this.here && this.loading) {
			const row = DOM.append(this.body, $('.dispatch-found-quiet'));
			DOM.append(row, $(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
			DOM.append(row, $('span', undefined, localize('dispatchFound.looking', "Looking at what other apps run on a schedule…")));
			return;
		}
		if (this.error && !this.here) {
			const row = DOM.append(this.body, $('.dispatch-found-quiet'));
			DOM.append(row, $(`span${ThemeIcon.asCSSSelector(Codicon.info)}`));
			DOM.append(row, $('span', undefined, localize('dispatchFound.error', "Could not look this time. Try again with the button above.")));
			this.renderStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), row, this.error));
			return;
		}
		const groups = byMachine(data);
		const several = groups.length > 1;
		for (const { machine, jobs } of groups) {
			if (several) {
				this.renderMachineHead(machine, jobs.length);
			}
			if (!jobs.length) {
				if (machine.local || machine.reachable) {
					const row = DOM.append(this.body, $('.dispatch-found-quiet'));
					row.textContent = machine.local
						? localize('dispatchFound.noneHere', "Nothing scheduled by other apps on this Mac. Dispatch looked in Hermes, OpenClaw, Codex, Claude, login items and cron.")
						: localize('dispatchFound.noneThere', "Nothing scheduled by other apps on {0}.", machine.name);
				}
				continue;
			}
			const on = jobs.filter(j => j.enabled);
			const off = jobs.filter(j => !j.enabled);
			if (on.length) {
				const grid = DOM.append(this.body, $('.dispatch-found-grid'));
				grid.setAttribute('role', 'list');
				for (const j of on) {
					this.renderCard(grid, j);
				}
			}
			if (off.length) {
				// paused and finished jobs fold away; opening the fold is remembered while the page lives
				const fold = DOM.append(this.body, $<HTMLDetailsElement>('details.dispatch-found-fold'));
				fold.open = this.openFolds.has(machine.id) || !on.length;
				const summary = DOM.append(fold, $('summary'));
				DOM.append(summary, $(`span.dispatch-found-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
				DOM.append(summary, $('span', undefined, off.length === 1 ? localize('dispatchFound.onePaused', "1 paused or finished") : localize('dispatchFound.nPaused', "{0} paused or finished", off.length)));
				const grid = DOM.append(fold, $('.dispatch-found-grid'));
				grid.setAttribute('role', 'list');
				for (const j of off) {
					this.renderCard(grid, j);
				}
				this.renderStore.add(DOM.addDisposableListener(fold, 'toggle', () => {
					if (fold.open) {
						this.openFolds.add(machine.id);
					} else {
						this.openFolds.delete(machine.id);
					}
				}));
			}
		}
		if (this.loading && this.here) {
			const row = DOM.append(this.body, $('.dispatch-found-quiet.dispatch-found-others-loading'));
			DOM.append(row, $(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
			DOM.append(row, $('span', undefined, localize('dispatchFound.askingOthers', "Asking your other Macs…")));
		}
	}

	private renderMachineHead(machine: IFoundMachine, count: number): void {
		const head = DOM.append(this.body, $('.dispatch-found-machine'));
		const tag = DOM.append(head, $('span.dispatch-found-machine-tag'));
		DOM.append(tag, $(`span${ThemeIcon.asCSSSelector(Codicon.vm)}`));
		DOM.append(tag, $('span', undefined, machine.local ? localize('dispatchFound.thisMac', "This Mac") : machine.name));
		const note = DOM.append(head, $('span.dispatch-found-machine-note'));
		if (machine.local || machine.reachable) {
			note.textContent = count === 1 ? localize('dispatchFound.oneJob', "1 job") : localize('dispatchFound.nJobs', "{0} jobs", count);
		} else {
			DOM.append(head, $('span.dispatch-found-offline')).setAttribute('aria-hidden', 'true');
			note.textContent = machine.at
				? localize('dispatchFound.offlineSince', "Not reachable now. Showing what it had {0}.", whenWords(machine.at))
				: localize('dispatchFound.offline', "Not reachable now. Dispatch will look again in a couple of minutes.");
		}
	}

	private renderCard(grid: HTMLElement, job: IFoundJob): void {
		const card = DOM.append(grid, $<HTMLButtonElement>('button.dispatch-found-card', { type: 'button' }));
		card.setAttribute('role', 'listitem');
		card.dataset.job = job.id;
		card.setAttribute('aria-label', localize('dispatchFound.cardLabel', "{0}, run by {1}. {2}", job.name, job.source_label, job.schedule));
		const name = DOM.append(card, $('.dispatch-found-card-name'));
		const icon = DOM.append(name, $(`span.dispatch-found-agent${ThemeIcon.asCSSSelector(agentIcon(job.agent))}`));
		this.renderStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), icon, job.agent_label));
		DOM.append(name, $('span.dispatch-found-card-title', undefined, job.name));
		DOM.append(name, $('span.dispatch-found-app', undefined, job.source_label));

		const meta = DOM.append(card, $('.dispatch-found-card-meta'));
		DOM.append(meta, $('span.dispatch-found-meta-item', undefined, job.schedule));
		const next = nextRunWords(job);
		if (next) {
			DOM.append(meta, $('span.dispatch-found-meta-item', undefined, next));
		}
		if (job.does) {
			DOM.append(card, $('.dispatch-found-card-does', undefined, job.does));
		}
		// only what needs the person shows a mark: a failure, or a run going on now
		const last = DOM.append(card, $('.dispatch-found-card-last'));
		if (job.last_status === 'failed') {
			last.classList.add('failed');
			DOM.append(last, $(`span${ThemeIcon.asCSSSelector(Codicon.error)}`));
		} else if (job.last_status === 'running') {
			DOM.append(last, $(`span${ThemeIcon.asCSSSelector(ThemeIcon.modify(Codicon.loading, 'spin'))}`));
		}
		DOM.append(last, $('span', undefined, lastRunWords(job)));
		this.renderStore.add(DOM.addDisposableListener(card, DOM.EventType.CLICK, () => {
			this.selected = job.id;
			this.render();
			this.body.querySelector<HTMLElement>('.dispatch-found-back')?.focus();
		}));
	}

	private renderDetail(job: IFoundJob, machine: IFoundMachine | undefined): void {
		const crumbs = DOM.append(this.body, $('.dispatch-found-crumbs'));
		const back = DOM.append(crumbs, $<HTMLButtonElement>('button.dispatch-found-back', { type: 'button' }));
		DOM.append(back, $(`span${ThemeIcon.asCSSSelector(Codicon.arrowLeft)}`));
		DOM.append(back, $('span', undefined, localize('dispatchFound.crumb', "From other apps")));
		DOM.append(crumbs, $(`span.dispatch-found-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
		DOM.append(crumbs, $('span.dispatch-found-crumb-here', undefined, job.name));
		this.renderStore.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => {
			const id = this.selected;
			this.selected = undefined;
			this.render();
			[...this.body.querySelectorAll<HTMLElement>('.dispatch-found-card')].find(c => c.dataset.job === id)?.focus();
		}));

		const detail = DOM.append(this.body, $('.dispatch-found-detail'));
		const head = DOM.append(detail, $('.dispatch-found-detail-head'));
		DOM.append(head, $(`span.dispatch-found-agent.large${ThemeIcon.asCSSSelector(agentIcon(job.agent))}`));
		const titles = DOM.append(head, $('.dispatch-found-detail-titles'));
		DOM.append(titles, $('h4.dispatch-found-detail-title', undefined, job.name));
		DOM.append(titles, $('.dispatch-found-detail-sub', undefined, job.source_label === job.agent_label
			? localize('dispatchFound.runsIn', "Runs in {0}", job.source_label)
			: localize('dispatchFound.runsInWith', "Runs in {0} with {1}", job.source_label, job.agent_label)));
		if (job.does) {
			DOM.append(detail, $('p.dispatch-found-detail-does', undefined, job.does));
		}

		const facts = DOM.append(detail, $('dl.dispatch-found-facts'));
		const fact = (key: string, value: string | HTMLElement) => {
			DOM.append(facts, $('dt', undefined, key));
			const dd = DOM.append(facts, $('dd'));
			if (typeof value === 'string') {
				dd.textContent = value;
			} else {
				dd.appendChild(value);
			}
			return dd;
		};
		fact(localize('dispatchFound.when', "When"), job.schedule);
		const next = job.enabled && job.next_run ? `${whenWords(job.next_run)} (${relativeWords(job.next_run)})` : nextRunWords(job) || localize('dispatchFound.nextUnknown', "Not known to Dispatch");
		fact(localize('dispatchFound.nextKey', "Next run"), next);
		fact(localize('dispatchFound.lastKey', "Last run"), job.last_run ? (job.last_status === 'failed' || job.last_status === 'running' ? `${whenWords(job.last_run)} · ${statusWords(job.last_status)}` : whenWords(job.last_run)) : localize('dispatchFound.neverRan', "No runs yet"));
		if (job.last_status === 'failed' && job.last_error) {
			fact(localize('dispatchFound.problem', "What went wrong"), job.last_error);
		}
		if (job.workdir) {
			fact(localize('dispatchFound.folder', "Folder"), job.workdir);
		}
		if (machine && !machine.local) {
			fact(localize('dispatchFound.mac', "Mac"), machine.name);
		}
		if (job.where) {
			const wrap = $('span.dispatch-found-where');
			const slash = job.where.lastIndexOf('/');
			DOM.append(wrap, $('span.dispatch-found-file', undefined, slash >= 0 ? job.where.slice(slash + 1) : job.where));
			if (slash > 0) {
				DOM.append(wrap, $('span.dispatch-found-dir', undefined, job.where.slice(0, slash).replace(/^\/Users\/[^/]+/, '~')));
			}
			if (machine?.local && job.where.startsWith('/')) {
				const reveal = this.renderStore.add(new Button(wrap, { ...defaultButtonStyles, secondary: true, title: localize('dispatchFound.reveal', "Show in Finder") }));
				reveal.label = localize('dispatchFound.reveal', "Show in Finder");
				reveal.element.classList.add('dispatch-found-small-button');
				this.renderStore.add(reveal.onDidClick(() => this.commandService.executeCommand('revealFileInOS', URI.file(job.where!))));
			}
			fact(localize('dispatchFound.where', "Saved in"), wrap);
		}
		const manage = DOM.append(detail, $('.dispatch-found-manage'));
		DOM.append(manage, $(`span${ThemeIcon.asCSSSelector(Codicon.lock)}`));
		const manageText = DOM.append(manage, $('span'));
		DOM.append(manageText, $('strong', undefined, localize('dispatchFound.readOnly', "Dispatch only reads this job.")));
		DOM.append(manageText, $('span', undefined, ' ' + job.manage + (job.note ? ' ' + job.note : '')));

		if (job.prompt) {
			const details = DOM.append(detail, $<HTMLDetailsElement>('details.dispatch-found-prompt'));
			details.open = this.openPrompts.has(job.id);
			this.renderStore.add(DOM.addDisposableListener(details, 'toggle', () => {
				if (details.open) {
					this.openPrompts.add(job.id);
				} else {
					this.openPrompts.delete(job.id);
				}
			}));
			const summary = DOM.append(details, $('summary'));
			DOM.append(summary, $(`span.dispatch-found-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
			DOM.append(summary, $('span', undefined, localize('dispatchFound.prompt', "What it tells the agent")));
			DOM.append(details, $('pre.dispatch-found-text', undefined, job.prompt));
		}

		const runsHead = DOM.append(detail, $('.dispatch-found-runs-head'));
		DOM.append(runsHead, $('h5', undefined, localize('dispatchFound.runs', "Last runs")));
		if (job.run_count > job.runs.length) {
			DOM.append(runsHead, $('span.dispatch-found-count', undefined, localize('dispatchFound.ofRuns', "{0} of {1}", job.runs.length, job.run_count)));
		}
		if (!job.runs.length) {
			DOM.append(detail, $('.dispatch-found-quiet', undefined, job.last_run
				? localize('dispatchFound.noRecords', "{0} keeps no record of its runs that Dispatch can read.", job.source_label)
				: localize('dispatchFound.noRunsYet', "It has not run yet.")));
			return;
		}
		const list = DOM.append(detail, $('.dispatch-found-runs'));
		list.setAttribute('role', 'list');
		job.runs.forEach((r, i) => this.renderRun(list, job, r, i));
	}

	private renderRun(list: HTMLElement, job: IFoundJob, r: IFoundRun, index: number): void {
		const key = `${job.id}#${r.at ?? index}`;
		const item = DOM.append(list, $('.dispatch-found-run'));
		item.setAttribute('role', 'listitem');
		const hasMore = !!(r.output || r.error);
		const row = DOM.append(item, $<HTMLButtonElement>('button.dispatch-found-run-row', { type: 'button' }));
		row.disabled = !hasMore;
		const mark = r.status === 'failed' ? Codicon.error : r.status === 'running' ? ThemeIcon.modify(Codicon.loading, 'spin') : r.status === 'skipped' ? statusIcon('skipped') : undefined;
		const icon = DOM.append(row, $(`span.dispatch-found-run-status${mark ? ThemeIcon.asCSSSelector(mark) : ''}`));
		if (r.status === 'failed') {
			row.classList.add('failed');
		}
		icon.setAttribute('aria-label', statusWords(r.status));
		DOM.append(row, $('span.dispatch-found-run-when', undefined, r.at ? whenWords(r.at) : localize('dispatchFound.unknownTime', "Unknown time")));
		DOM.append(row, $('span.dispatch-found-run-preview', undefined, r.title && r.preview !== r.title ? `${r.title} · ${r.preview}` : (r.preview || r.title || statusWords(r.status))));
		if (hasMore) {
			DOM.append(row, $(`span.dispatch-found-chevron${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
		}
		const open = this.openRuns.has(key);
		row.setAttribute('aria-expanded', String(open));
		if (open && hasMore) {
			item.classList.add('open');
			const out = DOM.append(item, $('.dispatch-found-output'));
			const text = r.output || r.error || '';
			if (job.source === 'launchd' || job.source === 'cron' || !r.output) {
				DOM.append(out, $('pre.dispatch-found-text', undefined, text));
			} else {
				// an agent's answer is Markdown: read it as such; logs stay as they are
				const md = this.renderStore.add(renderMarkdown(new MarkdownString(text, { supportThemeIcons: false }), { markedOptions: { gfm: true, breaks: true } }));
				md.element.classList.add('dispatch-found-reply');
				out.appendChild(md.element);
			}
			const bar = DOM.append(out, $('.dispatch-found-output-bar'));
			const copy = this.renderStore.add(new Button(bar, { ...defaultButtonStyles, secondary: true, title: localize('dispatchFound.copy', "Copy output") }));
			copy.label = localize('dispatchFound.copy', "Copy output");
			copy.element.classList.add('dispatch-found-small-button');
			this.renderStore.add(copy.onDidClick(() => this.clipboardService.writeText(text)));
			if (r.path && job.host === 'local' && r.path.startsWith('/')) {
				const reveal = this.renderStore.add(new Button(bar, { ...defaultButtonStyles, secondary: true, title: localize('dispatchFound.reveal', "Show in Finder") }));
				reveal.label = localize('dispatchFound.reveal', "Show in Finder");
				reveal.element.classList.add('dispatch-found-small-button');
				this.renderStore.add(reveal.onDidClick(() => this.commandService.executeCommand('revealFileInOS', URI.file(r.path!))));
			}
		}
		this.renderStore.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
			if (this.openRuns.has(key)) {
				this.openRuns.delete(key);
			} else {
				this.openRuns.add(key);
			}
			this.render();
			[...this.body.querySelectorAll<HTMLElement>('.dispatch-found-run-row')][index]?.focus();
		}));
	}
}
