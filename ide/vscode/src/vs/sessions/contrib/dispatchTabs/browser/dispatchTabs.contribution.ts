/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side pane's tab strip (Now, Changes, Files, Docs, Tasks and the files opened next to them),
 *  kanban task-fecz and task-gcc5.
 *
 *  Clicking a tab's name switches to it: the close button shows on the tab in front only, in a space of its own
 *  (the Modern UI tabs lay it over the end of the name, so on a short name like "Files" the click closed the tab).
 *  When the strip is wider than the pane, the tabs behind give up their names and keep their icons (the name is
 *  in the tab's hover), then the tab in front too; only then does the strip scroll. Nothing is cut off under the
 *  buttons at the end of the strip.
 *
 *  Of the documents opened next to the fixed tabs only the one in front and the one before it keep a tab
 *  (task-fif4i, direction B): the others are tucked away and listed in the Open group of the Docs list, and the
 *  Docs tab carries how many are open (dispatchOpenDocs.ts).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTabs.css';
import { getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { DispatchDocsEditorInput } from '../../dispatchDocs/browser/dispatchDocsInput.js';
import { dispatchDocKind, dispatchDocKindIcon, dispatchDocShortName } from '../../dispatchDocs/browser/dispatchDocKind.js';
import { isOpenDoc, isWebDoc, openDocPath, openDocs, stripDocs } from './dispatchOpenDocs.js';

/** Some names are hidden (steps 1 to 3); the e2e scenarios read it. */
export const COMPACT_CLASS = 'dispatch-tabs-compact';
/** Labels hidden on every tab (step 4). */
export const ICONS_CLASS = 'dispatch-tabs-icons';
/** A document's tab that is not in the strip (it is in the Docs list's Open group). */
export const TUCKED_CLASS = 'dispatch-tab-tucked';

export type FitStep = 0 | 1 | 2 | 3 | 4;

export interface IStripMeasure {
	/** The width the strip has (the scrolling area between the start and the buttons at the end). */
	readonly available: number;
	/** The width the tabs need with the given step applied. */
	need(step: FitStep): number;
}

/**
 * Who gives way first when the strip is too narrow (design/right-tabs/redesign A5, B2): 0 every name; 1 the fixed
 * tabs behind (Now, Changes, Files, Tasks) keep their icons only; 2 the documents' names get shorter; 3 the
 * document behind and Docs' name go too (Docs keeps its count); 4 every tab is an icon.
 */
export function fitStep(m: IStripMeasure): FitStep {
	for (const step of [0, 1, 2, 3] as const) {
		if (m.need(step) <= m.available + 1) {
			return step;
		}
	}
	return 4;
}

class DispatchSidePaneTabs extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchSidePaneTabs';

	private readonly watched = new WeakSet<HTMLElement>();
	private readonly pending = new Set<HTMLElement>();
	private frame: number | undefined;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly groupsService: IEditorGroupsService,
	) {
		super();
		const part = layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!part) {
			return;
		}
		const resize = new ResizeObserver(entries => {
			for (const e of entries) {
				const title = (e.target as HTMLElement).closest<HTMLElement>('.editor-group-container > .title');
				if (title) {
					this.schedule(title);
				}
			}
		});
		const tabsChanged = new MutationObserver(records => {
			for (const r of records) {
				const title = (r.target as HTMLElement).closest?.<HTMLElement>('.editor-group-container > .title') ?? r.target.parentElement?.closest<HTMLElement>('.editor-group-container > .title');
				if (title) {
					this.schedule(title);
				}
			}
		});
		const scan = () => {
			for (const title of part.querySelectorAll<HTMLElement>('.editor-group-container > .title')) {
				if (this.watched.has(title)) {
					continue;
				}
				const strip = title.querySelector<HTMLElement>('.tabs-and-actions-container');
				const tabs = title.querySelector<HTMLElement>('.tabs-container');
				if (!strip || !tabs) {
					continue;
				}
				this.watched.add(title);
				resize.observe(strip);
				// tabs come and go, the one in front changes, a name changes
				tabsChanged.observe(tabs, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
				this.schedule(title);
			}
		};
		// a page of a file says what it is on its tab and goes by its short name
		BrowserEditorInput.dispatchLook = input => {
			const path = openDocPath(input);
			if (!path) {
				return undefined;
			}
			const kind = dispatchDocKind(path);
			return { icon: kind === 'page' ? undefined : dispatchDocKindIcon(kind), name: input.title ? dispatchDocShortName(input.title, path) : undefined };
		};
		this._register(toDisposable(() => BrowserEditorInput.dispatchLook = undefined));
		const groups = new MutationObserver(() => scan());
		groups.observe(part, { childList: true, subtree: true });
		scan();
		this._register(toDisposable(() => {
			resize.disconnect();
			tabsChanged.disconnect();
			groups.disconnect();
			if (this.frame !== undefined) {
				getWindow(part).cancelAnimationFrame(this.frame);
			}
		}));
	}

	private schedule(title: HTMLElement): void {
		this.pending.add(title);
		if (this.frame === undefined) {
			const win = getWindow(title);
			this.frame = win.requestAnimationFrame(() => {
				this.frame = undefined;
				const titles = [...this.pending];
				this.pending.clear();
				titles.forEach(t => this.fit(t));
			});
		}
	}

	private groupOf(title: HTMLElement): IEditorGroup | undefined {
		const el = title.closest('.editor-group-container');
		return this.groupsService.groups.find(g => (g as IEditorGroup & { readonly element?: HTMLElement }).element === el);
	}

	/** Only the document in front and the one before it keep a tab; the Docs tab says how many are open. */
	private tuck(title: HTMLElement, tabs: HTMLElement): void {
		const group = this.groupOf(title);
		if (!group) {
			return;
		}
		const shown = new Set(stripDocs(group));
		const open = openDocs(group).length;
		const els = [...tabs.children].filter((c): c is HTMLElement => c.classList.contains('tab'));
		let first = true;
		els.forEach((el, i) => {
			const editor = group.getEditorByIndex(i);
			const doc = !!editor && isOpenDoc(editor);
			const tucked = doc && !shown.has(editor);
			// the marks the stylesheet goes by: which tabs are documents, Docs, a web page, the first document after
			// the fixed tabs (a short line before it, DESIGN.md's lanes in a tab strip)
			const marks: [string, boolean][] = [
				[TUCKED_CLASS, tucked],
				['dispatch-tab-doc', doc],
				['dispatch-tab-docs', editor instanceof DispatchDocsEditorInput],
				['dispatch-tab-web', !!editor && isWebDoc(editor)],
				['dispatch-tab-first-doc', doc && !tucked && first],
			];
			if (doc && !tucked) {
				first = false;
			}
			for (const [cls, on] of marks) {
				if (el.classList.contains(cls) !== on) {
					el.classList.toggle(cls, on);
				}
			}
			let cnt = el.querySelector<HTMLElement>(':scope > .dispatch-docs-count');
			if (!(editor instanceof DispatchDocsEditorInput) || !open) {
				cnt?.remove();
				return;
			}
			if (!cnt) {
				cnt = el.ownerDocument.createElement('span');
				cnt.className = 'dispatch-docs-count';
				el.querySelector(':scope > .tab-label')?.after(cnt);
			}
			const was = Number(cnt.textContent || '0');
			if (was !== open) {
				cnt.textContent = String(open);
				if (open > was) {
					// the number rolls up a line (DESIGN.md's number roll)
					cnt.classList.remove('roll');
					void cnt.offsetWidth;
					cnt.classList.add('roll');
				}
			}
		});
	}

	private fit(title: HTMLElement): void {
		const scroller = title.querySelector<HTMLElement>('.tabs-and-actions-container > .monaco-scrollable-element');
		const tabs = title.querySelector<HTMLElement>('.tabs-container');
		if (!scroller || !tabs || !title.isConnected || !scroller.clientWidth) {
			return; // hidden: measured when it shows
		}
		this.tuck(title, tabs);
		const apply = (step: FitStep) => {
			title.classList.toggle(COMPACT_CLASS, step >= 1 && step <= 3);
			title.classList.toggle(ICONS_CLASS, step === 4);
			title.dataset.dispatchFit = String(step);
		};
		// measured in one go, before the next paint: the classes only change what the next frame draws
		const step = fitStep({
			available: scroller.clientWidth,
			need: s => {
				apply(s);
				return tabs.scrollWidth;
			},
		});
		apply(step);
	}
}

registerWorkbenchContribution2(DispatchSidePaneTabs.ID, DispatchSidePaneTabs, WorkbenchPhase.AfterRestored);
