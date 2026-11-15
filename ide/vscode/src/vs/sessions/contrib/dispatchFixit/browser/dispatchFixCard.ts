/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the card at the top of the Changes tab. Waiting: "Writing the commit message" with
 *  the writing agent's mark. Done: "Committed “…”" and "Written by OpenCode". Wrong: one line that
 *  says what happened, one that says what it means, and one button, "Let the agent fix it", that
 *  sends the agent everything it needs (dispatchFixitService.ts). Details shows git's own words.
 *  The look is the session input banner's (sessionInputBanners.css): a flat card, monochrome icons.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchFixCard.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { DispatchFixCardState, IDispatchFixitService, writerIcon } from './dispatchFixitService.js';

const $ = dom.$;

export class DispatchFixCard extends Disposable {

	readonly domNode: HTMLElement;
	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;
	private readonly content = this._register(new DisposableStore());
	private lastHeight = 0;
	private detailsOpen = false;
	private shownKey = '';

	/**
	 * `where`: 'editor' in the Changes tab's diff (SessionChangesEditor); 'detail' in the list of changed files
	 * (ChangesViewPane), shown only while the diff is not on screen (the side pane narrowed to the list), so the
	 * card is in one place at a time.
	 */
	constructor(
		parent: HTMLElement,
		private readonly where: 'editor' | 'detail',
		@IDispatchFixitService private readonly fixit: IDispatchFixitService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IAgentWorkbenchLayoutService private readonly layoutService: IAgentWorkbenchLayoutService,
	) {
		super();
		this.domNode = dom.append(parent, $('.dispatch-fix-card-host'));
		this._register(toDisposable(() => this.domNode.remove()));

		const observer = new ResizeObserver(() => this.reportHeight());
		observer.observe(this.domNode);
		this._register(toDisposable(() => observer.disconnect()));

		const diffShown = observableFromEvent(this, this.layoutService.onDidChangePartVisibility, () => this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow));
		this._register(autorun(reader => {
			const session = this.sessionsService.activeSession.read(reader);
			const state = session ? this.fixit.cards.read(reader).get(session.sessionId) : undefined;
			const here = this.where === 'editor' || !diffShown.read(reader);
			this.here = here;
			this.reportOnScreen();
			this.render(session?.sessionId, here ? state : undefined);
		}));
		this._register(toDisposable(() => this.fixit.setOnScreen(this, false)));
	}

	private here = false;
	private visible = false;

	/** The service brings the Changes tab forward for a failed Commit only when no card is on screen. */
	private reportOnScreen(): void {
		this.fixit.setOnScreen(this, this.here && this.visible);
	}

	/** The height the card takes from the tab (0 when there is none). */
	get height(): number {
		return this.domNode.offsetHeight;
	}

	/** Keeps the status fresh while the tab is on screen. */
	setVisible(visible: boolean): void {
		this.visible = visible;
		this.reportOnScreen();
		if (visible && !this.watch) {
			this.watch = this.fixit.watch();
		} else if (!visible && this.watch) {
			this.watch.dispose();
			this.watch = undefined;
		}
	}
	private watch: { dispose(): void } | undefined;

	override dispose(): void {
		this.watch?.dispose();
		this.watch = undefined;
		super.dispose();
	}

	private reportHeight(): void {
		const h = this.height;
		if (h !== this.lastHeight) {
			this.lastHeight = h;
			this._onDidChangeHeight.fire();
		}
	}

	private render(sessionId: string | undefined, state: DispatchFixCardState | undefined): void {
		this.content.clear();
		dom.clearNode(this.domNode);
		if (!sessionId || !state) {
			this.shownKey = '';
			this.reportHeight();
			return;
		}
		const key = state.kind === 'problem' || state.kind === 'sent' ? state.problem.key : state.kind;
		if (key !== this.shownKey) {
			this.detailsOpen = false;
		}
		const fresh = key !== this.shownKey;
		this.shownKey = key;

		const card = dom.append(this.domNode, $('.dispatch-fix-card'));
		card.classList.add(`is-${state.kind}`);
		card.classList.toggle('fresh', fresh);
		card.setAttribute('role', state.kind === 'problem' ? 'alert' : 'status');
		const icon = dom.append(card, $('.dfc-icon'));
		const main = dom.append(card, $('.dfc-main'));
		const title = dom.append(main, $('.dfc-title'));

		switch (state.kind) {
			case 'writing':
			case 'explaining': {
				icon.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				title.textContent = state.kind === 'writing'
					? localize('dispatchFixCard.writing', "Writing the commit message…")
					: localize('dispatchFixCard.explaining', "Looking at what went wrong…");
				title.classList.add('dfc-shimmer');
				break;
			}
			case 'committing':
			case 'written': {
				const mark = writerIcon(state.written.by);
				icon.appendChild(renderIcon(state.kind === 'committing' ? ThemeIcon.modify(Codicon.loading, 'spin') : Codicon.check));
				title.textContent = state.kind === 'committing'
					? localize('dispatchFixCard.committing', "Committing “{0}”", state.written.subject ?? '')
					: localize('dispatchFixCard.committed', "Committed “{0}”", state.written.subject ?? '');
				title.title = state.written.text ?? '';
				if (state.written.ai && state.written.by_label) {
					const by = dom.append(main, $('.dfc-by'));
					if (mark) {
						by.appendChild(renderIcon(mark));
					}
					dom.append(by, $('span', undefined, localize('dispatchFixCard.writtenBy', "Message written by {0}", state.written.by_label)));
				}
				if (state.kind === 'written') {
					this.closeButton(card, sessionId);
				}
				break;
			}
			case 'problem':
			case 'sent': {
				const { problem } = state;
				icon.appendChild(renderIcon(state.kind === 'sent' ? Codicon.commentDiscussion : Codicon.warning));
				title.textContent = problem.title;
				dom.append(main, $('.dfc-text', undefined, state.kind === 'sent'
					? localize('dispatchFixCard.sent', "{0} is fixing it and will answer in the chat.", state.agent)
					: problem.explain));
				const actions = dom.append(main, $('.dfc-actions'));
				if (state.kind === 'problem' && problem.fixable && problem.prompt) {
					const agent = this.fixit.agentOf(this.sessionsService.activeSession.get());
					const fix = this.content.add(new Button(actions, { ...defaultButtonStyles, supportIcons: true, title: localize('dispatchFixCard.fixTitle', "Send {0} what went wrong and let it fix it", agent.label) }));
					fix.element.classList.add('dfc-fix');
					fix.label = (agent.icon ? `$(${agent.icon.id}) ` : '') + localize('dispatchFixCard.fix', "Let the agent fix it");
					this.content.add(fix.onDidClick(() => void this.fixit.fix(sessionId)));
				}
				if (problem.details) {
					const toggle = dom.append(actions, $('a.dfc-link', { role: 'button', tabIndex: 0 }));
					const details = dom.append(main, $('pre.dfc-details'));
					details.textContent = problem.details;
					const sync = () => {
						toggle.textContent = this.detailsOpen ? localize('dispatchFixCard.hideDetails', "Hide details") : localize('dispatchFixCard.details', "Details");
						toggle.setAttribute('aria-expanded', String(this.detailsOpen));
						details.classList.toggle('open', this.detailsOpen);
					};
					sync();
					const flip = () => { this.detailsOpen = !this.detailsOpen; sync(); };
					this.content.add(dom.addDisposableListener(toggle, 'click', flip));
					this.content.add(dom.addDisposableListener(toggle, 'keydown', e => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							flip();
						}
					}));
				}
				if (!actions.childElementCount) {
					actions.remove();
				}
				this.closeButton(card, sessionId);
				break;
			}
			case 'fixed': {
				// what went wrong is behind us (kanban task-mrdg): the card stops saying the agent is fixing it
				const again = state.problem.kind === 'conflicts'
					? localize('dispatchFixCard.againMerge', "You can merge again.")
					: state.problem.kind === 'push'
						? localize('dispatchFixCard.againPush', "You can send your work again.")
						: localize('dispatchFixCard.againCommit', "Press Commit again.");
				if (state.how === 'answered') {
					icon.appendChild(renderIcon(Codicon.commentDiscussion));
					title.textContent = localize('dispatchFixCard.answered', "{0} answered in the chat", state.agent ?? this.fixit.agentOf(this.sessionsService.activeSession.get()).label);
					dom.append(main, $('.dfc-text', undefined, again));
				} else {
					icon.appendChild(renderIcon(Codicon.check));
					title.textContent = state.how === 'committed'
						? localize('dispatchFixCard.committed', "Committed “{0}”", state.subject ?? '')
						: state.how === 'sent'
							? localize('dispatchFixCard.sentAway', "Your work was sent")
							: localize('dispatchFixCard.fixed', "Fixed");
					if (state.how === 'ready') {
						dom.append(main, $('.dfc-text', undefined, again));
					} else if (state.agent) {
						dom.append(main, $('.dfc-text', undefined, localize('dispatchFixCard.fixedBy', "{0} fixed it.", state.agent)));
					}
				}
				this.closeButton(card, sessionId);
				break;
			}
		}
		this.reportHeight();
	}

	private closeButton(card: HTMLElement, sessionId: string): void {
		const close = dom.append(card, $('a.dfc-close', { role: 'button', tabIndex: 0, title: localize('dispatchFixCard.close', "Close"), 'aria-label': localize('dispatchFixCard.close', "Close") }));
		close.appendChild(renderIcon(Codicon.close));
		this.content.add(dom.addDisposableListener(close, 'click', () => this.fixit.dismiss(sessionId)));
		this.content.add(dom.addDisposableListener(close, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.fixit.dismiss(sessionId);
			}
		}));
	}
}
