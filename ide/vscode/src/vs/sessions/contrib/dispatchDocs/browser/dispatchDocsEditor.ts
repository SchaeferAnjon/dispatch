/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Docs tab of the Agents window's side pane (patches/435-docs.patch),
 *  direction A of kanban design/docs-tab/redesign: a list, and a document opened in place.
 *
 *  List: the documents Dispatch knows for the active session's project (`dispatch docs list
 *  --folder --session`, kanban app/cli/docs_view.py, through dispatch-bridge's `dispatch.docsList`).
 *  The first frame does not wait for it: dispatch-bridge's `dispatch.docsQuick` answers at once with the
 *  project's files sorted into the groups and the last list it kept (kanban app/ide-ext/src/core/docsQuick.ts),
 *  and the CLI's answer (tasks, sessions, registered documents) replaces it when it comes.
 *  On top the same square switch as the Tasks tab (This session / the project), the picker (All ⌄:
 *  Today, Deliveries, Designs, Reviews, Notes, All; the filter of the build the mini still runs, user
 *  2026-10-01) and Search; below, the groups (Delivered, Designs, Reviews, Handoffs, Notes) of what
 *  the picker keeps, five rows each and "Show N more", a group folds and stays folded per project. A row is a grey format icon, the title (500 while a delivery
 *  is unseen) and its time; a README.md and the index.html next to it are one row with a globe at
 *  the end that opens the page.
 *
 *  Reader: a row opens in a tab of its own next to Docs (DispatchDocTabInput; the same row again brings that
 *  tab back), and that tab's pane is this one in reader mode ({@link DispatchDocTabEditor}): the whole pane is
 *  the document. The head row is "‹ Docs" (the Docs tab, the list where it was scrolled to; Esc too), Draw and ask and "…"
 *  (Reveal in Finder, Copy Path, Remove from Docs). Under it "Delivered 6m ago for <task> +3" (the
 *  task opens in the Tasks tab), the title, the "Where to look" picture as a 1:1 viewport with the
 *  numbered lines under it (a line moves the viewport there, a box in the picture picks its line,
 *  clicking the picture opens it larger), then the Markdown. Selected text gets the Ask Question box.
 *  An HTML file opens as the prototype page: the page in a webview, Fit / 100%, Notes back to the
 *  README of its folder.
 *
 *  Draw and ask on a document longer than the pane takes a picture of all of it: `_dispatch.docsScroll`
 *  says where the document shows and scrolls it (the reader's scroller, or the page through a small
 *  agent in it; a delivery page served by dispatch-bridge carries the same agent), a screen at a time.
 *
 *  `dispatch.openDoc` (dispatchDocsOpen.ts) opens a document's tab from outside: `dispatch ide show`,
 *  `task deliver --show`, a task's deliverable in the Tasks tab.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchDocs.css';
import { drawDispatchDocument } from '../../dispatchDraw/browser/dispatchDrawPane.js';
import { clearDispatchLinkedHover, hasDispatchLinkedHover, linkDocTasks } from './dispatchLinkedHover.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { safeSetInnerHtml } from '../../../../base/browser/domSanitize.js';
import { Action } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import * as marked from '../../../../base/common/marked/marked.js';
import { autorun } from '../../../../base/common/observable.js';
import { basename, dirname, extname, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DISPATCH_QUOTE_COMMAND, quoteIcon, quoteLabel, quoteTitle } from '../../dispatchQuote/browser/dispatchQuote.js';
import { attachDocComments } from '../../dispatchSideChat/browser/dispatchDocPassage.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, Verbosity } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { FeedbackInputWidget } from '../../agentFeedback/browser/feedbackInputWidget.js';
import { openDispatchDocTab, revealDispatchDocsTab } from './dispatchDocsOpen.js';
import { DispatchDocsEditorInput, DispatchDocTabInput, dispatchDocFallbackTitle, type IDispatchDocTabContext } from './dispatchDocsInput.js';
import { dispatchOpenPath, onDidOpenDocPage } from './dispatchOpenPath.js';
import { dispatchDocKind, dispatchDocKindIcon } from './dispatchDocKind.js';
import { isWebDoc, openDocPath, openDocProject, openDocs, openDocTitle, stripDocs } from '../../dispatchTabs/browser/dispatchOpenDocs.js';
import { DispatchWhereViewer, dispatchWherePictureOf, parseDispatchMarks } from '../../dispatchCommon/browser/dispatchWhere.js';
import { setupDispatchTextHover } from '../../../../workbench/browser/dispatchHoverCard.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

export { DispatchDocsEditorInput, DispatchDocsEditorSerializer, DispatchDocTabInput, DispatchDocTabSerializer } from './dispatchDocsInput.js';

/** A context handoff written by `dispatch handoff write` (kept under handoffs/, listed in the handoff group). */
function isHandoffDoc(path: string, doc?: { group?: string }): boolean {
	return doc?.group === 'handoff' || /\/handoffs\//.test(path);
}

export type DispatchDocGroup = 'delivered' | 'design' | 'research' | 'handoff' | 'notes';

export interface IDispatchDocTask {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	/** Seconds since the epoch. */
	readonly delivered_at: number;
}

export interface IDispatchDocWhere {
	readonly image: string;
	readonly size?: [number, number];
	/** An item may sit on another screenshot of the folder (a delivery page's 00-where.json). */
	readonly items: { n: number; box: [number, number, number, number]; what: string; where: string; how: string; image?: string }[];
	/** The boxes are in the picture (dispatch annotate's figure): only dim around them; else ring them too. */
	readonly drawn?: boolean;
}

export interface IDispatchDoc {
	readonly id: string;
	readonly title: string;
	readonly group: DispatchDocGroup;
	readonly path: string;
	/** Seconds since the epoch. */
	readonly mtime: number;
	readonly ext: string;
	readonly tasks: readonly IDispatchDocTask[];
	readonly delivered_at: number;
	unseen: boolean;
	/** Delivered or changed today (the picker's Today). */
	readonly today?: boolean;
	readonly in_session: boolean;
	readonly prototype?: string;
	readonly where?: IDispatchDocWhere;
	/** Not a list row: a handoff or report opened from elsewhere (a transcript, a task), kept for the reader's "for <task>" line. */
	readonly reader_only?: boolean;
	/** The sessions it belongs to; a cached list says "This session" from these. */
	readonly sessions?: readonly string[];
}

const GROUPS: DispatchDocGroup[] = ['delivered', 'design', 'research', 'handoff', 'notes'];
const GROUP_LABEL: Record<DispatchDocGroup, string> = {
	delivered: localize('dispatchDocs.group.delivered', "Delivered"),
	design: localize('dispatchDocs.group.design', "Designs"),
	research: localize('dispatchDocs.group.reviews', "Reviews"),
	handoff: 'Handoffs',
	notes: localize('dispatchDocs.group.notes', "Notes"),
};
const FIRST_ROWS = 5;
const MORE_ROWS = 20;
const WIDE_PX = 720;
const SCOPE_KEY = 'dispatch.docs.scope';
const FILTER_KEY = 'dispatch.docs.filter';

/** The picker over the list: Today, one group, or All (kanban docs_view.FILTERS). Notes holds the handoffs too. */
type DocsFilter = 'today' | 'delivered' | 'design' | 'research' | 'notes' | 'all';
const FILTERS: DocsFilter[] = ['today', 'delivered', 'design', 'research', 'notes', 'all'];
const FILTER_LABEL: Record<DocsFilter, string> = {
	today: localize('dispatchDocs.filter.today', "Today"),
	delivered: localize('dispatchDocs.filter.delivered', "Deliveries"),
	design: localize('dispatchDocs.filter.design', "Designs"),
	research: localize('dispatchDocs.filter.research', "Reviews"),
	notes: localize('dispatchDocs.filter.notes', "Notes"),
	all: localize('dispatchDocs.filter.all', "All"),
};

const FILTER_NONE: Record<DocsFilter, string> = {
	today: localize('dispatchDocs.noneToday', "Nothing delivered or changed today."),
	delivered: localize('dispatchDocs.noneDelivered', "No deliveries here yet."),
	design: localize('dispatchDocs.noneDesign', "No designs here yet."),
	research: localize('dispatchDocs.noneResearch', "No reviews here yet."),
	notes: localize('dispatchDocs.noneNotes', "No notes here yet."),
	all: '',
};

function inDocsFilter(doc: IDispatchDoc, filter: DocsFilter): boolean {
	switch (filter) {
		case 'all': return true;
		case 'today': return !!doc.today;
		case 'notes': return doc.group === 'notes' || doc.group === 'handoff';
		default: return doc.group === filter;
	}
}
const COLLAPSED_KEY = 'dispatch.docs.collapsed.';
/** The Open group folded (one switch for every project: it is about the side pane, not the project). */
const OPEN_FOLDED_KEY = 'dispatch.docs.openFolded';

/** One open document in the Open group. */
interface IOpenRow {
	readonly editor: EditorInput;
	readonly title: string;
	readonly path?: string;
	readonly project: string;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const isIndexPage = (p: string) => /\/index\.html?$/i.test(p);

type Scope = 'session' | 'project';

type View =
	| { readonly kind: 'list' }
	| { readonly kind: 'doc'; readonly path: string; readonly task?: string; readonly reason?: IDispatchDocTabContext['reason']; readonly mark?: number }
	| { readonly kind: 'proto'; readonly path: string; readonly task?: string };

interface IDocsState {
	readonly folder?: string;
	readonly project?: string;
	readonly session?: string;
	readonly docs?: IDispatchDoc[];
	readonly error?: string;
	readonly loading: boolean;
	/** The first frame's rows (dispatch.docsQuick): the board's part (tasks, this session's own) is not in yet. */
	readonly partial?: boolean;
}

/** A row the CLI knows (its id is the registration's hash): only those can be marked seen or removed. */
const isBoardDoc = (doc: IDispatchDoc) => /^[0-9a-f]{6,64}$/.test(doc.id);

const isHtml = (p: string) => /\.html?$/i.test(p);

/** The lists of every folder and session, shared by the Docs tab and the documents' tabs (a document opens with its task line at once). */
const docsCache = new Map<string, IDocsState>();

/** Draw and ask's whole-page picture asks the Docs tab where its document is (`_dispatch.docsScroll`). */
export const DISPATCH_DOCS_SCROLL_COMMAND = '_dispatch.docsScroll';

/** Where the document in the Docs tab is: what shows of it on screen (window CSS pixels) and its scroll, in the same pixels. */
export interface IDispatchDocScroll {
	readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly top: number;
	readonly height: number;
}

/**
 * The page side of Draw and ask's whole-page picture: `{dispatchDraw: 'metrics' | 'scroll', id, y?, hideFixed?}`
 * in, `{dispatchDraw: 'done', id, m: {top, height, vh}}` back once the page is painted there. Fixed and sticky
 * elements step out while `hideFixed` (the picture below its first screen), so a bar that stays on screen is in
 * it once; lazy pictures load at once and a screen is answered once the pictures on it are in (up to 1.5 s).
 * `accept` says which message events are asks, `post` sends the answer. dispatch-bridge's delivery pages carry
 * the same agent (kanban app/ide-ext/src/core/deliveryPage.ts, DRAW_SCROLL_AGENT).
 */
function drawScrollAgent(accept: string, post: string): string {
	return `(function(){var hidden=null;function se(){return document.scrollingElement||document.documentElement;}`
		+ `function m(){var s=se();return {top:s.scrollTop,height:Math.max(s.scrollHeight,document.body?document.body.scrollHeight:0),vh:innerHeight};}`
		+ `function fixed(on){if(on&&!hidden){hidden=[];var all=document.body?document.body.getElementsByTagName('*'):[];for(var i=0;i<all.length&&i<20000;i++){var p=getComputedStyle(all[i]).position;if(p==='fixed'||p==='sticky'){hidden.push([all[i],all[i].style.visibility]);all[i].style.visibility='hidden';}}}else if(!on&&hidden){for(var j=0;j<hidden.length;j++){hidden[j][0].style.visibility=hidden[j][1];}hidden=null;}}`
		// lazy pictures load at once, and a screen is answered once the pictures on it are in
		+ `function eager(){var im=document.images;for(var i=0;i<im.length;i++){if(im[i].loading==='lazy'){im[i].loading='eager';}}}function settle(done){var t0=Date.now();(function w(){var im=document.images,pend=false;for(var i=0;i<im.length;i++){var r=im[i].getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&r.width>0&&!im[i].complete){pend=true;break;}}if(pend&&Date.now()-t0<1500){setTimeout(w,50);}else{requestAnimationFrame(function(){requestAnimationFrame(done);});}})();}`
		+ `addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('.lb,.where.full,.proto.full')){${post}({dispatchDraw:'escape'});}},true);`
		+ `addEventListener('message',function(e){var d=e.data;if(!d||typeof d.dispatchDraw!=='string'||d.dispatchDraw==='done'||!(${accept}))return;`
		+ `var done=function(){${post}({dispatchDraw:'done',id:d.id,m:m()});};`
		+ `if(d.dispatchDraw==='scroll'){fixed(!!d.hideFixed);var s=se(),b=s.style.scrollBehavior;s.style.scrollBehavior='auto';s.scrollTop=d.y;s.style.scrollBehavior=b;settle(done);}else{eager();done();}});})();`;
}

/** The prototype page asks and answers through the webview's API. */
const DRAW_SCROLL_PAGE = `<script>(function(){var api;try{api=acquireVsCodeApi();}catch(e){return;}${drawScrollAgent('true', 'api.postMessage')}})();</script>`;
/**
 * A page that brings no style of its own is drawn in the pane's colours: the webview gives text the theme's colour
 * (light in a dark theme) over the browser's white page, and light on white cannot be read (task-e1qsa). With no
 * background of its own the page gets the editor's; a page that paints itself a light background but leaves the text
 * colour alone gets dark text. A page that sets both is left as it is.
 */
const READABLE_PAGE = `<script>(function(){function rgb(c){var m=/rgba?\\(([^)]+)\\)/.exec(c||'');if(!m)return null;var p=m[1].split(',').map(parseFloat);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};}function lum(c){return(0.299*c.r+0.587*c.g+0.114*c.b)/255;}function fix(){var d=document.documentElement,b=document.body;if(!b)return;var cs=getComputedStyle;var bg=[rgb(cs(b).backgroundColor),rgb(cs(d).backgroundColor)].filter(function(c){return c&&c.a>0.05;})[0];if(!bg){d.style.backgroundColor='var(--vscode-editor-background)';return;}var fg=rgb(cs(b).color);if(fg&&lum(bg)>0.6&&lum(fg)>0.6){b.style.color='#1f1f1f';}}document.addEventListener('DOMContentLoaded',fix);addEventListener('load',fix);})();</script>`;

/** A delivery page sits in an iframe of the bridge's page server: pass the asks in and the answers out. */
const DRAW_SCROLL_RELAY = `<script>(function(){var api;try{api=acquireVsCodeApi();}catch(e){return;}var f=document.querySelector('iframe');addEventListener('message',function(e){var d=e.data;if(!d||typeof d.dispatchDraw!=='string'||!f||!f.contentWindow)return;if(e.source===f.contentWindow){if(d.dispatchDraw==='done'||d.dispatchDraw==='escape'){api.postMessage(d);}}else if(d.dispatchDraw!=='done'){f.contentWindow.postMessage(d,'*');}});})();</script>`;

/** The pictures showing in `el` have loaded (up to 1.5 s): a screen of a whole-page picture is taken after. */
async function picturesIn(el: HTMLElement): Promise<void> {
	const until = Date.now() + 1500;
	for (const img of el.querySelectorAll('img')) {
		if (img.loading === 'lazy') {
			img.loading = 'eager';
		}
	}
	const view = el.getBoundingClientRect();
	while (Date.now() < until) {
		const pending = [...el.querySelectorAll('img')].some(img => {
			const r = img.getBoundingClientRect();
			return r.width > 0 && r.bottom > view.top && r.top < view.bottom && !img.complete;
		});
		if (!pending) {
			return;
		}
		await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 50));
	}
}

function twoFrames(): Promise<void> {
	return new Promise(resolve => mainWindow.requestAnimationFrame(() => mainWindow.requestAnimationFrame(() => resolve())));
}

/** 6m, 1h, 2d, Sep 3: the list's time column. */
export function dispatchDocShortTime(seconds: number, now = Date.now()): string {
	if (!seconds) {
		return '';
	}
	const s = Math.max(0, now / 1000 - seconds);
	if (s < 60) {
		return localize('dispatchDocs.now', "now");
	}
	if (s < 3600) {
		return `${Math.floor(s / 60)}m`;
	}
	if (s < 86400) {
		return `${Math.floor(s / 3600)}h`;
	}
	if (s < 86400 * 60) {
		return `${Math.floor(s / 86400)}d`;
	}
	return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** just now, 6m ago, 2h ago, yesterday, 3d ago, Sep 3: the reader's second line. */
export function dispatchDocAgo(seconds: number, now = Date.now()): string {
	const s = Math.max(0, now / 1000 - seconds);
	if (s < 90) {
		return localize('dispatchDocs.justNow', "just now");
	}
	if (s < 3600) {
		return localize('dispatchDocs.minutesAgo', "{0}m ago", Math.floor(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchDocs.hoursAgo', "{0}h ago", Math.floor(s / 3600));
	}
	if (s < 2 * 86400) {
		return localize('dispatchDocs.yesterday', "yesterday");
	}
	if (s < 86400 * 30) {
		return localize('dispatchDocs.daysAgo', "{0}d ago", Math.floor(s / 86400));
	}
	return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A Markdown file's blocks with the source lines they came from (for Ask Question's quote). */
interface IMdBlock { readonly html: string; readonly start: number; readonly end: number }

function markdownBlocks(text: string, dropWhere: boolean): { title?: string; blocks: IMdBlock[] } {
	const tokens = marked.lexer(text);
	const links = (tokens as marked.TokensList).links ?? {};
	let line = 1;
	let title: string | undefined;
	const blocks: IMdBlock[] = [];
	let skipping = false;
	for (const token of tokens) {
		const start = line;
		const raw = token.raw ?? '';
		line += (raw.match(/\n/g) ?? []).length;
		if (token.type === 'space') {
			continue;
		}
		if (token.type === 'heading') {
			const h = token as marked.Tokens.Heading;
			if (h.depth === 1 && title === undefined && !blocks.length) {
				title = h.text.replace(/\s+/g, ' ').trim();
				continue;
			}
			if (h.depth <= 2) {
				// the document's own "在哪" section: its picture and list are the viewport above
				skipping = dropWhere && /^(在哪|Where)/i.test(h.text.trim());
				if (skipping) {
					continue;
				}
			}
		}
		if (skipping) {
			continue;
		}
		const list = Object.assign([token], { links }) as unknown as marked.TokensList;
		blocks.push({ html: marked.parser(list), start, end: Math.max(start, line - (raw.endsWith('\n') ? 1 : 0)) });
	}
	return { title, blocks };
}

export class DispatchDocsEditor extends EditorPane {

	static readonly ID: string = DispatchDocsEditorInput.EDITOR_ID;

	private _root!: HTMLElement;
	private _state: IDocsState = { loading: true };
	private readonly _cache = docsCache;
	private readonly _viewStore = this._register(new DisposableStore());
	/** The list's rows (drawn again on every keystroke of a search): their listeners go with them. */
	private readonly _rowsStore = this._register(new DisposableStore());
	/** The Open group alone (drawn again whenever the documents open next to the tabs change). */
	private readonly _openStore = this._register(new DisposableStore());
	private _searchFocused = false;
	private readonly _webview = this._register(new MutableDisposable<IWebviewElement>());
	private readonly _blobs = new Map<string, string>();
	private _requestId = 0;
	/** When the list of the folder on screen was asked for with nothing to show yet (the first-frame time, e2e reads it). */
	private _firstAsked: { readonly folder: string; readonly at: number } | undefined;
	private _refreshRender: number | undefined;
	private _view: View = { kind: 'list' };
	private _scope: Scope;
	private _filter: DocsFilter;
	private _query: string | undefined;
	private readonly _more = new Map<DispatchDocGroup, number>();
	private readonly _scroll = new Map<string, number>();
	/** The project name each folder had when a list last came back: a failed refresh must not move scroll and folds to another key. */
	private readonly _projectOf = new Map<string, string>();
	private _width = 0;
	private _renderGen = 0;
	private _ask: FeedbackInputWidget | undefined;
	private _askRange: { text: string; start: number; end: number } | undefined;
	private _protoZoom: 'fit' | 'one' = 'fit';
	/** What Draw and ask scrolls through for a whole-page picture: the reader's scroller, or the prototype's page. */
	private _drawScroll: { readonly kind: 'dom'; readonly el: HTMLElement } | { readonly kind: 'webview'; readonly frame: HTMLElement; readonly webview: IWebviewElement } | undefined;
	/** Screen pixels per page pixel of the prototype (its last answer). */
	private _drawK = 1;
	private _drawSeq = 0;
	private readonly _drawWaiters = new Map<number, (m: { top: number; height: number; vh: number } | undefined) => void>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storage: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IAgentWorkbenchLayoutService private readonly _layoutService: IAgentWorkbenchLayoutService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		// the documents' tabs are this pane too, under their own id (DispatchDocTabEditor)
		super((new.target as typeof DispatchDocsEditor).ID, group, telemetryService, themeService, _storage);
		this._scope = _storage.get(SCOPE_KEY, StorageScope.PROFILE) === 'session' ? 'session' : 'project';
		const filter = _storage.get(FILTER_KEY, StorageScope.PROFILE) as DocsFilter | undefined;
		this._filter = filter && FILTERS.includes(filter) ? filter : 'all';
		this._register(toDisposable(() => {
			for (const url of this._blobs.values()) {
				URL.revokeObjectURL(url);
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, dom.$('.dispatch-docs'));
		this._root.tabIndex = -1;
		this._register(toDisposable(() => dom.getWindow(this._root).clearTimeout(this._refreshRender)));
		// the active session decides the project
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			session?.workspace.read(reader);
			if (this.isVisible()) {
				void this.refresh();
			}
		}));
		this._register(dom.addDisposableListener(this._root, dom.EventType.KEY_DOWN, e => this.onKey(e)));
		// a document opened or closed next to the fixed tabs: the list's Open group follows
		this._register(onDidOpenDocPage(path => this.markSeen(path)));
		this._register(this.group.onDidModelChange(() => {
			if (!this.isDocTab && this._view.kind === 'list' && this.isVisible()) {
				this.renderOpenOnly();
			}
		}));
		this.render();
	}

	/** A document's own tab (reader only), not the Docs tab (the list). */
	protected get isDocTab(): boolean {
		return this.getId() === DispatchDocTabInput.EDITOR_ID;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof DispatchDocTabInput) {
			const why = input.context;
			input.context = undefined;
			this._view = { kind: input.isPage ? 'proto' : 'doc', path: input.path, task: why?.task, reason: why?.reason, mark: why?.mark } as View;
			// the list this document belongs to, when Docs has it already: the reader's task line at once
			this.useCachedState();
			this.render();
			this.markSeen(input.path);
			if (options?.preserveFocus === false) {
				this._root.focus({ preventScroll: true });
			}
		}
		// the kept list will do for a document's tab, unless it does not know this document or the task it came
		// for yet (delivered just now): then the list is read again and the reader's task line follows
		const doc = this._view.kind !== 'list' ? this.docByPath(this._view.path) : undefined;
		const task = this._view.kind !== 'list' ? this._view.task : undefined;
		const known = !!doc && (!task || doc.tasks.some(t => t.id === task));
		void this.refresh(this.isDocTab && known);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) { clearDispatchLinkedHover(this._root); }
		if (visible && !this.isDocTab) {
			// documents opened or closed while the list was hidden: its Open group is redrawn at once
			if (this._view.kind === 'list') {
				this.renderRows();
			}
			void this.refresh();
		}
	}

	override focus(): void {
		this._root?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (!this._root) {
			return;
		}
		// the tab takes the whole side pane, however wide it is dragged
		this._root.style.width = `${dimension.width}px`;
		this._root.style.height = `${dimension.height}px`;
		this._width = dimension.width;
		const wide = this._width >= WIDE_PX;
		this._root.classList.toggle('wide', wide);
		// A list rebuilt while the tab was hidden could not take its scroll: give it back once it has a size.
		const list = this._view.kind === 'list' ? this._root.querySelector<HTMLElement>('.dispatch-docs-list') : null;
		const saved = list ? this._scroll.get(this.projectKey()) ?? 0 : 0;
		if (list && saved > 0 && list.scrollTop === 0 && list.scrollHeight > list.clientHeight) { list.scrollTop = saved; }
	}

	// ---- data -----------------------------------------------------------------------------------

	private folder(): string | undefined {
		const folder = this._sessionsService.activeSession.get()?.workspace.get()?.folders[0];
		const uri = folder?.root ?? folder?.workingDirectory ?? this._workspaceService.getWorkspace().folders[0]?.uri;
		return uri?.scheme === 'file' ? uri.fsPath : undefined;
	}

	private sessionId(): string {
		return this._sessionsService.activeSession.get()?.resource.toString() ?? '';
	}

	/** A document's tab takes the list Docs already has for this folder and session (no request). */
	private useCachedState(): boolean {
		const folder = this.folder();
		const cached = folder ? this._cache.get(`${folder}|${this.sessionId()}`) : undefined;
		if (cached) {
			this._state = cached;
		}
		return !!cached;
	}

	/** Shows the cached list for the folder at once, then asks the bridge for a fresh one (`cachedOk`: not when a cached one is there). */
	async refresh(cachedOk = false): Promise<void> {
		if (cachedOk && this.useCachedState()) {
			return;
		}
		const folder = this.folder();
		const session = this.sessionId();
		if (this._state.folder !== folder || this._state.session !== session) { clearDispatchLinkedHover(this._root); }
		const id = ++this._requestId;
		if (!folder) {
			this._state = { loading: false };
			this.renderIfList();
			return;
		}
		const key = `${folder}|${session}`;
		const cached = this._cache.get(key);
		const had = this._state.docs;
		this._state = cached ? { ...cached, loading: true } : { folder, session, loading: true, docs: this._state.folder === folder ? this._state.docs : undefined, project: this._state.folder === folder ? this._state.project : undefined, partial: this._state.folder === folder ? this._state.partial : undefined };
		if (!this._state.docs) {
			this._firstAsked = { folder, at: performance.now() };
		}
		if (!had || !cached) {
			this.renderIfList();
		}
		if (!cached) {
			// the first frame: the project's files and the last list the bridge kept, without the CLI
			const quick = await this._commandService.executeCommand<{ project?: string; docs?: IDispatchDoc[]; error?: string }>('dispatch.docsQuick', folder, session).catch(() => undefined);
			if (id !== this._requestId) {
				return;
			}
			if (quick?.docs && !quick.error) {
				this._state = { folder, session, project: quick.project, docs: quick.docs, loading: true, partial: true };
				if (this._view.kind === 'list') {
					this.renderRefreshedList();
				} else {
					this.refreshContext();
				}
			}
		}
		let next: IDocsState;
		try {
			const ans = await this._commandService.executeCommand<{ project?: string; docs?: IDispatchDoc[]; error?: string }>('dispatch.docsList', folder, session);
			next = ans?.error || !ans ? { folder, session, error: ans?.error ?? localize('dispatchDocs.noBridge', "Dispatch is not answering."), loading: false } : { folder, session, project: ans.project, docs: ans.docs ?? [], loading: false };
		} catch (e) {
			next = { folder, session, error: String((e as Error)?.message ?? e), loading: false };
		}
		if (id !== this._requestId) {
			return;
		}
		if (!next.error) {
			this._cache.set(key, next);
		}
		if (next.project && next.folder) { this._projectOf.set(next.folder, next.project); }
		// a failed refresh keeps what is on screen (the last list, or the first frame's)
		this._state = next.error && this._state.docs ? { ...this._state, loading: false } : next;
		if (this._view.kind === 'list') {
			this.renderRefreshedList();
		} else {
			this.refreshContext();
		}
	}

	/** A late catalogue response must not remove the row or summary that owns keyboard focus. */
	private renderRefreshedList(): void {
		if (this._view.kind !== 'list') { return; }
		if (hasDispatchLinkedHover(this._root)) {
			if (this._refreshRender === undefined) {
				this._refreshRender = dom.getWindow(this._root).setTimeout(() => {
					this._refreshRender = undefined;
					this.renderRefreshedList();
				}, 150);
			}
			return;
		}
		this.render();
	}

	private renderIfList(): void {
		if (this._view.kind === 'list') {
			this.render();
		}
	}

	private docByPath(path: string): IDispatchDoc | undefined {
		return this._state.docs?.find(d => d.path === path) ?? this._state.docs?.find(d => d.prototype === path);
	}

	/** The rows of this session or the project, before the picker. */
	private inScope(): IDispatchDoc[] {
		const docs = (this._state.docs ?? []).filter(d => !d.reader_only);
		return this._scope === 'session' ? docs.filter(d => d.in_session) : docs;
	}

	private scoped(): IDispatchDoc[] {
		const shown = this.inScope().filter(d => inDocsFilter(d, this._filter));
		const q = this._query?.trim().toLowerCase();
		return q ? shown.filter(d => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) : shown;
	}

	private setFilter(filter: DocsFilter): void {
		if (this._filter === filter) {
			return;
		}
		this._filter = filter;
		this._storage.store(FILTER_KEY, filter, StorageScope.PROFILE, StorageTarget.USER);
		this._more.clear();
		this.render();
	}

	/** The picker's menu: every choice with a check on the one shown; a choice with nothing in it is greyed (the groups carry the counts). */
	private showFilter(anchor: HTMLElement): void {
		const docs = this.inScope();
		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => FILTERS.map(f => {
				const n = docs.filter(d => inDocsFilter(d, f)).length;
				const a = new Action(`dispatch.docs.filter.${f}`, FILTER_LABEL[f], undefined, f === 'all' || f === this._filter || n > 0, () => this.setFilter(f));
				a.checked = f === this._filter;
				return a;
			}),
			onHide: () => anchor.setAttribute('aria-expanded', 'false'),
		});
		anchor.setAttribute('aria-expanded', 'true');
	}

	/** Scroll and folds belong to the project, whatever the state of the list at the moment (loading, failed refresh). */
	private projectKey(state: IDocsState = this._state): string {
		return state.project ?? (state.folder ? this._projectOf.get(state.folder) : undefined) ?? '';
	}

	private collapsed(): Set<DispatchDocGroup> {
		try {
			const raw = JSON.parse(this._storage.get(COLLAPSED_KEY + this.projectKey(), StorageScope.PROFILE, '[]'));
			return new Set(Array.isArray(raw) ? raw.filter((g): g is DispatchDocGroup => GROUPS.includes(g)) : []);
		} catch {
			return new Set();
		}
	}

	private setCollapsed(groups: Set<DispatchDocGroup>): void {
		this._storage.store(COLLAPSED_KEY + this.projectKey(), JSON.stringify([...groups]), StorageScope.PROFILE, StorageTarget.USER);
	}

	// ---- navigation -----------------------------------------------------------------------------

	/** A document in its own tab (the one already open for it comes to the front); the keyboard goes with it. */
	private openTab(path: string, title?: string): void {
		if (this._view.kind === 'list') {
			// the list keeps its place for when its tab comes back
			const list = this._root.querySelector<HTMLElement>('.dispatch-docs-list');
			if (list && list.offsetHeight > 0) {
				this._scroll.set(this.projectKey(), list.scrollTop);
			}
		}
		const started = performance.now();
		if (isHtml(path)) {
			// a page (a delivery, a design) in the integrated browser, ‹ Docs above it (kanban preference「文档默认进浏览器」)
			void this._instantiationService.invokeFunction(dispatchOpenPath, URI.file(path), { fromDocs: true, inEditor: true, focus: true, task: this.docByPath(path)?.tasks[0]?.id });
			return;
		}
		void this._instantiationService.invokeFunction(openDispatchDocTab, path, { title, reason: 'list', focus: true }).then(() => {
			// e2e reads how long a click took to show the document's tab
			(mainWindow as unknown as { __dispatchDocTabMs?: number }).__dispatchDocTabMs = Math.round(performance.now() - started);
		});
	}

	/** A delivery the person has now seen: its row is no longer bold. */
	private markSeen(path: string): void {
		const doc = this.docByPath(path);
		if (doc?.unseen && this._state.folder && isBoardDoc(doc)) {
			doc.unseen = false;
			void this._commandService.executeCommand('dispatch.docsSeen', this._state.folder, doc.id);
			// its row on screen is no longer bold
			for (const row of this._root.querySelectorAll<HTMLElement>('.dispatch-docs-row')) {
				if (row.dataset.docPath === doc.path) {
					row.querySelector('.t')?.classList.remove('unseen');
				}
			}
		}
	}

	/** From a document's tab: the Docs tab, its list where it was. */
	private back(): void {
		if (this.isDocTab) {
			void this._instantiationService.invokeFunction(revealDispatchDocsTab, false);
		}
	}

	private onKey(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && this._view.kind === 'list') {
			e.preventDefault();
			e.stopPropagation();
			this.startSearch();
			return;
		}
		if (e.key !== 'Escape' || e.defaultPrevented) {
			return;
		}
		if (this._ask && this._ask.domNode.style.display !== 'none') {
			return;
		}
		if (this._layoutService.isEditorMaximized()) {
			e.preventDefault();
			e.stopPropagation();
			void this._commandService.executeCommand('workbench.action.agentSessions.restoreMainEditorPart');
			return;
		}
		if (this._view.kind !== 'list') {
			e.preventDefault();
			e.stopPropagation();
			this.back();
		}
	}

	// ---- rendering ------------------------------------------------------------------------------

	private render(): void {
		if (!this._root) {
			return;
		}
		// a list drawn again under the person's typing (fresh data came in) keeps the search box focused
		const search = this._root.querySelector<HTMLInputElement>('.dispatch-docs-search-input');
		this._searchFocused = !!search && dom.isActiveElement(search);
		this._viewStore.clear();
		this._webview.clear();
		this._drawScroll = undefined;
		for (const resolve of this._drawWaiters.values()) {
			resolve(undefined);
		}
		this._drawWaiters.clear();
		this._ask = undefined;
		dom.clearNode(this._root);
		// Going back from a linked document is a list again, including its padding and toolbar.
		this._root.classList.toggle('reading', this._view.kind !== 'list');
		this._root.classList.remove('entering');
		void this._root.offsetWidth;
		this._root.classList.add('entering');
		const gen = ++this._renderGen;
		switch (this._view.kind) {
			case 'list':
				this.renderList();
				break;
			case 'doc':
				void this.renderDoc(this._view, gen);
				break;
			case 'proto':
				void this.renderProto(this._view, gen);
				break;
		}
	}

	private button(parent: HTMLElement, cls: string, label: string, icon: ThemeIcon | undefined, run: (e: MouseEvent) => void, title?: string, store: DisposableStore = this._viewStore): HTMLButtonElement {
		const b = dom.append(parent, dom.$<HTMLButtonElement>(`button.${cls}`, { type: 'button' }));
		if (icon) {
			b.appendChild(renderIcon(icon));
		}
		if (label) {
			dom.append(b, dom.$('span', undefined, label));
		}
		if (title) {
			b.title = title;
			b.setAttribute('aria-label', title);
		}
		store.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.stopPropagation();
			run(e);
		}));
		return b;
	}

	private renderList(): void {
		const state = this._state;
		const bar = dom.append(this._root, dom.$('.dispatch-docs-bar'));
		const seg = dom.append(bar, dom.$('.dispatch-docs-scope', { role: 'tablist' }));
		const scopes: [Scope, string][] = [
			['session', localize('dispatchDocs.thisSession', "This session")],
			['project', state.project || localize('dispatchDocs.project', "Project")],
		];
		for (const [scope, label] of scopes) {
			const tab = this.button(seg, 'dispatch-docs-pill', label, undefined, () => {
				if (this._scope !== scope) {
					this._scope = scope;
					this._storage.store(SCOPE_KEY, scope, StorageScope.PROFILE, StorageTarget.USER);
					this._more.clear();
					this.render();
				}
			});
			tab.setAttribute('role', 'tab');
			tab.classList.toggle('on', this._scope === scope);
			tab.setAttribute('aria-selected', String(this._scope === scope));
		}
		const pick = dom.append(bar, dom.$<HTMLButtonElement>('button.dispatch-docs-ghost.dispatch-docs-filter', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': localize('dispatchDocs.filterLabel', "Show: {0}", FILTER_LABEL[this._filter]) }));
		dom.append(pick, dom.$('span', undefined, FILTER_LABEL[this._filter]));
		pick.appendChild(renderIcon(Codicon.chevronDown));
		pick.classList.toggle('on', this._filter !== 'all');
		this._viewStore.add(dom.addDisposableListener(pick, dom.EventType.CLICK, () => this.showFilter(pick)));
		dom.append(bar, dom.$('span.dispatch-docs-spacer'));
		this.renderTools(bar);
		// one search box, always there, over the open documents and all the others (design/right-tabs/redesign B4)
		const box = dom.append(this._root, dom.$('label.dispatch-docs-search-box'));
		box.appendChild(renderIcon(Codicon.search));
		const input = dom.append(box, dom.$<HTMLInputElement>('input.dispatch-docs-search-input', { type: 'text', placeholder: localize('dispatchDocs.searchAll', "Search open and all docs"), 'aria-label': localize('dispatchDocs.searchAll', "Search open and all docs") }));
		input.value = this._query ?? '';
		dom.append(box, dom.$('span.dispatch-docs-kbd', undefined, isMacintosh ? '⌘K' : 'Ctrl+K'));
		this._viewStore.add(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			this._query = input.value || undefined;
			this.renderRows();
		}));
		this._viewStore.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && input.value) {
				e.preventDefault();
				e.stopPropagation();
				input.value = '';
				this._query = undefined;
				this.renderRows();
			} else if (e.key === 'Enter') {
				const first = this._root.querySelector<HTMLElement>('.dispatch-docs-list .dispatch-docs-row');
				first?.click();
			}
		}));
		if (this._query !== undefined || this._searchFocused) {
			this._searchFocused = false;
			setTimeout(() => input.focus(), 0);
		}
		const list = dom.append(this._root, dom.$('.dispatch-docs-list'));
		this._drawScroll = { kind: 'dom', el: list };
		const key = this.projectKey(state);
		this._viewStore.add(dom.addDisposableListener(list, 'scroll', () => {
			// Only a list on screen speaks: hiding the tab or emptying the rows resets scrollTop without the person scrolling.
			if (list.offsetHeight > 0 && list.scrollHeight > list.clientHeight) { this._scroll.set(key, list.scrollTop); }
		}, { passive: true }));
		this.renderRows();
		list.scrollTop = this._scroll.get(key) ?? 0;
	}

	private startSearch(): void {
		const input = this._root.querySelector<HTMLInputElement>('.dispatch-docs-search-input');
		input?.focus();
		input?.select();
	}

	private renderRows(): void {
		const list = this._root.querySelector<HTMLElement>('.dispatch-docs-list');
		if (!list) {
			return;
		}
		// where the person had scrolled: given back once every row is in (with only the Open group in, it was clamped to 0)
		const top = list.scrollTop;
		this._rowsStore.clear();
		dom.clearNode(list);
		const openHits = this.renderOpen(dom.append(list, dom.$('.dispatch-docs-open-host')));
		this.fillRows(list, openHits);
		list.scrollTop = top;
	}

	/** Only the Open group again: the documents next to the tabs changed (the rows below and the scroll stay). */
	private renderOpenOnly(): void {
		const host = this._root.querySelector<HTMLElement>('.dispatch-docs-list > .dispatch-docs-open-host');
		// while searching, the line under the rows says whether only open ones match: the whole list again
		if (!host || this._query) {
			this.renderRows();
			return;
		}
		dom.clearNode(host);
		this.renderOpen(host);
	}

	private fillRows(list: HTMLElement, openHits: number): void {
		const state = this._state;
		const empty = (title: string, detail?: string) => {
			const e = dom.append(list, dom.$('.dispatch-docs-empty'));
			dom.append(e, dom.$('.et', undefined, title));
			if (detail) {
				dom.append(e, dom.$('.ed', undefined, detail));
			}
		};
		if (!state.folder && !state.loading) {
			empty(localize('dispatchDocs.noFolder', "No project folder."), localize('dispatchDocs.noFolderDetail', "Open a session in a project folder to see its docs."));
			return;
		}
		if (!state.docs) {
			if (state.error) {
				empty(localize('dispatchDocs.errorTitle', "Could not list the docs."), state.error);
			} else {
				empty(localize('dispatchDocs.loading', "Loading docs…"));
			}
			return;
		}
		// how long the list took to show anything, and whether the board's part is in (e2e docs-fast reads both)
		const asked = this._firstAsked;
		if (asked && asked.folder === state.folder) {
			this._root.dataset.firstFrameMs = String(Math.round(performance.now() - asked.at));
			this._firstAsked = undefined;
		}
		this._root.dataset.partial = String(!!state.partial);
		const rows = this.scoped();
		if (!rows.length) {
			const others = this._filter !== 'all' && this.inScope().length > 0;
			if (this._query && openHits) {
				// the open ones above match: one quiet line for the rest, not an empty page under a list that has rows
				dom.append(list, dom.$('.dispatch-docs-open-none', undefined, localize('dispatchDocs.nothingElse', "Nothing else matches “{0}”.", this._query.trim())));
			} else if (this._query) {
				empty(this._filter === 'all'
					? localize('dispatchDocs.noMatch', "No docs match “{0}”.", this._query.trim())
					: localize('dispatchDocs.noMatchIn', "No docs in {0} match “{1}”.", FILTER_LABEL[this._filter], this._query.trim()));
			} else if (others) {
				empty(FILTER_NONE[this._filter], localize('dispatchDocs.pickAll', "Pick All above to see every doc."));
			} else if (this._scope === 'session' && state.partial && state.loading) {
				// the first frame does not know this session's documents yet
				empty(localize('dispatchDocs.loading', "Loading docs…"));
			} else if (this._scope === 'session') {
				empty(localize('dispatchDocs.noneInSession', "No docs in this session yet."), localize('dispatchDocs.noneInSessionDetail', "When the agent delivers something, it opens here."));
			} else if (state.project) {
				empty(localize('dispatchDocs.noneInProject', "No docs in {0} yet.", state.project), localize('dispatchDocs.noneInProjectDetail', "When the agent delivers something, it opens here."));
			} else {
				empty(localize('dispatchDocs.none', "No docs yet."), localize('dispatchDocs.noneInProjectDetail', "When the agent delivers something, it opens here."));
			}
			return;
		}
		const collapsed = this._query ? new Set<DispatchDocGroup>() : this.collapsed();
		for (const g of GROUPS) {
			const inGroup = rows.filter(d => d.group === g);
			if (!inGroup.length) {
				continue;
			}
			const section = dom.append(list, dom.$('section.dispatch-docs-group'));
			section.classList.toggle('collapsed', collapsed.has(g));
			const head = dom.append(section, dom.$<HTMLButtonElement>('button.dispatch-docs-group-head', { type: 'button' }));
			head.appendChild(renderIcon(Codicon.chevronDown));
			dom.append(head, dom.$('span.name', undefined, GROUP_LABEL[g]));
			dom.append(head, dom.$('span.cnt', undefined, String(inGroup.length)));
			head.setAttribute('aria-expanded', String(!collapsed.has(g)));
			this._rowsStore.add(dom.addDisposableListener(head, dom.EventType.CLICK, () => {
				const now = this.collapsed();
				if (now.has(g)) {
					now.delete(g);
				} else {
					now.add(g);
				}
				this.setCollapsed(now);
				section.classList.toggle('collapsed', now.has(g));
				head.setAttribute('aria-expanded', String(!now.has(g)));
			}));
			const wrap = dom.append(section, dom.$('.dispatch-docs-rows'));
			const inner = dom.append(wrap, dom.$('ul'));
			const limit = this._query ? inGroup.length : FIRST_ROWS + (this._more.get(g) ?? 0);
			inGroup.slice(0, limit).forEach((doc, i) => {
				const li = this.renderRow(inner, doc);
				if (i >= FIRST_ROWS + (this._more.get(g) ?? 0) - MORE_ROWS && i >= FIRST_ROWS && this._justMore === g) {
					li.classList.add('fresh');
				}
			});
			const rest = inGroup.length - limit;
			if (rest > 0) {
				const more = dom.append(inner, dom.$<HTMLButtonElement>('button.dispatch-docs-more', { type: 'button' }));
				more.appendChild(renderIcon(Codicon.chevronRight));
				dom.append(more, dom.$('span', undefined, localize('dispatchDocs.showMore', "Show {0} more", rest)));
				this._rowsStore.add(dom.addDisposableListener(more, dom.EventType.CLICK, () => {
					const top = list.scrollTop;
					this._more.set(g, (this._more.get(g) ?? 0) + MORE_ROWS);
					this._justMore = g;
					this.renderRows();
					this._justMore = undefined;
					list.scrollTop = top;
				}));
			}
		}
	}
	private _justMore: DispatchDocGroup | undefined;

	/**
	 * The documents open next to the fixed tabs (task-fif4i, direction B): the strip keeps only the one in front and
	 * the one before it, so here are all of them, by project (this one first, the web last), with their whole titles;
	 * a prototype or the notes next to an open page hang under it. A row opens it; its × (or a group's Close, or Close
	 * all) closes it. Search filters these rows too.
	 */
	/** Draws the Open group; how many open documents it shows (the search may leave out some). */
	private renderOpen(list: HTMLElement): number {
		this._openStore.clear();
		if (this.isDocTab) {
			return 0;
		}
		const editors = openDocs(this.group);
		if (!editors.length) {
			return 0;
		}
		const folder = this._state.folder ?? this.folder();
		const project = this._state.project;
		const here = folder ? openDocProject(`${folder}/`, folder, project) : undefined;
		const rows: IOpenRow[] = editors.map(editor => {
			const path = openDocPath(editor);
			return { editor, title: openDocTitle(editor), path, project: isWebDoc(editor) || !path ? 'Web' : openDocProject(path, folder, project) };
		});
		const parentOf = (r: IOpenRow) => r.path && !isIndexPage(r.path) ? rows.find(o => o !== r && o.path && isIndexPage(o.path) && dirOf(o.path) === dirOf(r.path!)) : undefined;
		const q = this._query?.trim().toLowerCase();
		const hit = (r: IOpenRow) => !q || `${r.title} ${r.project} ${r.path ?? ''}`.toLowerCase().includes(q);
		const order: string[] = [];
		for (const r of rows) {
			if (!order.includes(r.project)) {
				order.push(r.project);
			}
		}
		order.sort((a, b) => (a === here ? -1 : b === here ? 1 : a === 'Web' ? 1 : b === 'Web' ? -1 : 0));
		const front = stripDocs(this.group, 1)[0];
		const folded = !q && this._storage.getBoolean(OPEN_FOLDED_KEY, StorageScope.PROFILE, false);

		const section = dom.append(list, dom.$('section.dispatch-docs-group.dispatch-docs-open'));
		section.classList.toggle('collapsed', folded);
		const head = dom.append(section, dom.$('.dispatch-docs-open-top'));
		const fold = dom.append(head, dom.$<HTMLButtonElement>('button.dispatch-docs-group-head', { type: 'button', 'aria-expanded': String(!folded) }));
		fold.appendChild(renderIcon(Codicon.chevronDown));
		dom.append(fold, dom.$('span.name', undefined, localize('dispatchDocs.open', "Open")));
		const cnt = dom.append(fold, dom.$('span.cnt', undefined, String(rows.length)));
		this._openStore.add(dom.addDisposableListener(fold, dom.EventType.CLICK, () => {
			const now = !section.classList.contains('collapsed');
			this._storage.store(OPEN_FOLDED_KEY, now, StorageScope.PROFILE, StorageTarget.USER);
			section.classList.toggle('collapsed', now);
			fold.setAttribute('aria-expanded', String(!now));
		}));
		this.button(head, 'dispatch-docs-close-all', localize('dispatchDocs.closeAll', "Close all"), undefined, () => void this.group.closeEditors(editors), undefined, this._openStore);
		const inner = dom.append(dom.append(section, dom.$('.dispatch-docs-rows')), dom.$('ul'));
		let shown = 0;
		for (const p of order) {
			const mine = rows.filter(r => r.project === p);
			const tops = mine.filter(r => !parentOf(r));
			const visible = tops.filter(r => hit(r) || mine.some(c => parentOf(c) === r && hit(c)));
			if (!visible.length) {
				continue;
			}
			const ph = dom.append(inner, dom.$('li.dispatch-docs-open-project'));
			ph.appendChild(renderIcon(p === 'Web' ? Codicon.globe : Codicon.folder));
			dom.append(ph, dom.$('span.pn', undefined, p));
			if (p === here) {
				dom.append(ph, dom.$('span.this', undefined, localize('dispatchDocs.thisProject', "This project")));
			}
			dom.append(ph, dom.$('span.cnt', undefined, String(mine.length)));
			this.button(ph, 'dispatch-docs-close-all', localize('dispatchDocs.close', "Close"), undefined, () => void this.group.closeEditors(mine.map(r => r.editor)),
				localize('dispatchDocs.closeProject', "Close the open docs of {0}", p), this._openStore);
			for (const r of visible) {
				this.renderOpenRow(inner, r, false, r.editor === front);
				shown++;
				for (const c of mine.filter(c => parentOf(c) === r)) {
					this.renderOpenRow(inner, c, true, c.editor === front);
					shown++;
				}
			}
		}
		if (!shown) {
			dom.append(inner, dom.$('li.dispatch-docs-open-none', undefined, localize('dispatchDocs.noOpenMatch', "No open doc matches “{0}”.", this._query?.trim() ?? '')));
		}
		// searching: the count says how many match
		cnt.textContent = String(q ? shown : rows.length);
		return shown;
	}

	private renderOpenRow(parent: HTMLElement, r: IOpenRow, child: boolean, front: boolean): void {
		const row = dom.append(parent, dom.$('li.dispatch-docs-row.dispatch-docs-open-row', { role: 'button', tabindex: '0' }));
		row.classList.toggle('child', child);
		row.classList.toggle('on', front);
		if (r.path) {
			row.dataset.docPath = r.path;
		}
		this._openStore.add(setupDispatchTextHover(this._hoverService, row, () => ({ head: r.title, notes: [r.path ?? (r.editor.getTitle(Verbosity.LONG) || r.project)] }), { when: () => true }));
		// what it is (a delivery, a design, a prototype, notes …), the same symbol as its tab; a web page its site's icon in grey
		const icon = dom.append(row, dom.$('span.format'));
		const own = r.editor.getIcon();
		const kind = r.path ? dispatchDocKind(r.path) : 'page';
		if (kind !== 'page' || !own) {
			icon.appendChild(renderIcon(dispatchDocKindIcon(kind)));
		} else if (ThemeIcon.isThemeIcon(own)) {
			icon.appendChild(renderIcon(own));
		} else {
			dom.append(icon, dom.$<HTMLImageElement>('img.favicon', { src: own.toString(true), alt: '' }));
		}
		const doc = r.path ? this.docByPath(r.path) : undefined;
		const name = child ? (/\.(md|markdown)$/i.test(r.path ?? '') ? localize('dispatchDocs.notes', "Notes") : localize('dispatchDocs.prototypeOf', "Prototype · {0}", r.title)) : r.title;
		dom.append(row, dom.$('span.t', undefined, name)).classList.toggle('unseen', !!doc?.unseen);
		if (doc) {
			dom.append(row, dom.$('span.time', undefined, dispatchDocShortTime(Math.max(doc.delivered_at, doc.mtime))));
		}
		const close = this.button(row, 'dispatch-docs-acc.dispatch-docs-open-x', '', Codicon.close, () => void this.group.closeEditor(r.editor), localize('dispatchDocs.closeDoc', "Close"), this._openStore);
		close.tabIndex = -1;
		const open = () => void this.group.openEditor(r.editor, { preserveFocus: false });
		this._openStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, open));
		this._openStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
				e.preventDefault();
				open();
			}
		}));
	}

	private renderRow(parent: HTMLElement, doc: IDispatchDoc): HTMLElement {
		const row = dom.append(parent, dom.$('li.dispatch-docs-row', { role: 'button', tabindex: '0' }));
		// the whole title and where the file is (the row does not say): our card
		if (doc.tasks.length) {
			this._rowsStore.add(linkDocTasks(this._root, row, this._commandService, this._state.folder ?? '', doc, this._hoverService));
		} else {
			this._rowsStore.add(setupDispatchTextHover(this._hoverService, row, () => ({ head: doc.title, notes: [doc.path] }), { when: () => true }));
		}
		row.dataset.docPath = doc.path;
		const icon = dom.append(row, dom.$('span.format'));
		icon.appendChild(renderIcon(isHtml(doc.path) ? Codicon.globe : Codicon.fileText));
		const t = dom.append(row, dom.$('span.t', undefined, doc.title));
		t.classList.toggle('unseen', doc.unseen);
		if (doc.prototype) {
			const acc = this.button(row, 'dispatch-docs-acc', '', Codicon.globe, () => this.openTab(doc.prototype!, doc.title), localize('dispatchDocs.openPrototype', "Open the prototype"), this._rowsStore);
			acc.tabIndex = 0;
		}
		dom.append(row, dom.$('span.time', undefined, dispatchDocShortTime(Math.max(doc.delivered_at, doc.mtime))));
		this._rowsStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.openDoc(doc)));
		this._rowsStore.add(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, e => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === row) {
				e.preventDefault();
				this.openDoc(doc);
			}
		}));
		// a page opens in the browser, which has no "⋯" of the reader: the row's own menu has what that one has
		this._rowsStore.add(dom.addDisposableListener(row, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			this.rowMenu(e, doc);
		}));
		return row;
	}

	private rowMenu(e: MouseEvent, doc: IDispatchDoc): void {
		this._contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				new Action('dispatch.docs.row.reveal', localize('dispatchDocs.reveal', "Reveal in Finder"), undefined, true, () => this._commandService.executeCommand('revealFileInOS', URI.file(doc.path))),
				new Action('dispatch.docs.row.copyPath', localize('dispatchDocs.copyPath', "Copy Path"), undefined, true, () => this._clipboardService.writeText(doc.path)),
				new Action('dispatch.docs.row.remove', localize('dispatchDocs.remove', "Remove from Docs"), undefined, !!this._state.folder && isBoardDoc(doc), async () => {
					if (!this._state.folder) {
						return;
					}
					await this._commandService.executeCommand('dispatch.docsRemove', this._state.folder, doc.id);
					for (const [k, v] of this._cache) {
						this._cache.set(k, { ...v, docs: v.docs?.filter(d => d.id !== doc.id) });
					}
					this._state = { ...this._state, docs: this._state.docs?.filter(d => d.id !== doc.id) };
					this.renderRows();
				}),
			],
		});
	}

	private openDoc(doc: IDispatchDoc): void {
		this.markSeen(doc.path);
		this.openTab(doc.path, doc.title);
	}

	/** The reader's head row: "‹ Docs", then (right) the actions. */
	private renderHead(parent: HTMLElement, path: string, notes?: string): HTMLElement {
		const head = dom.append(parent, dom.$('.dispatch-docs-reader-head'));
		const back = this.button(head, 'dispatch-docs-back', localize('dispatchDocs.back', "Docs"), Codicon.chevronLeft, () => this.back(), localize('dispatchDocs.backTitle', "Back to Docs (Esc)"));
		back.removeAttribute('aria-label');
		dom.append(head, dom.$('span.sp'));
		if (notes) {
			this.button(head, 'dispatch-docs-ghost', localize('dispatchDocs.notes', "Notes"), Codicon.fileText, () => this.openTab(notes), localize('dispatchDocs.notesTitle', "The notes of this prototype"));
		}
		this.renderTools(head);
		const more = this.button(head, 'dispatch-docs-icon', '', Codicon.ellipsis, () => this.showMore(more, path), localize('dispatchDocs.more', "More Actions"));
		return head;
	}

	/** One in-flow action row, shared by the list and every reader. */
	private renderTools(parent: HTMLElement): void {
		const actions = dom.append(parent, dom.$('.dispatch-docs-actions', { role: 'toolbar', 'aria-label': localize('dispatchDocs.actions', "Document actions") }));
		const draw = this.button(actions, 'dispatch-docs-icon', '', Codicon.edit, () => {
			draw.disabled = true;
			void drawDispatchDocument().finally(() => { draw.disabled = false; });
		}, localize('dispatchDocs.draw', "Draw and ask"));
		// no Enlarge of its own: the tab strip's maximize at the top right does it (user 2026-10-21: two of them)
	}

	private showMore(anchor: HTMLElement, path: string): void {
		const doc = this.docByPath(path);
		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				new Action('dispatch.docs.openSource', isHtml(path) ? localize('dispatchDocs.openBrowser', "Open in Integrated Browser") : localize('dispatchDocs.openEditor', "Open in Editor"), undefined, true, () => this._instantiationService.invokeFunction(dispatchOpenPath, URI.file(path), { fromDocs: true, inEditor: true, focus: true, task: this.docByPath(path)?.tasks[0]?.id })),
				new Action('dispatch.docs.reveal', localize('dispatchDocs.reveal', "Reveal in Finder"), undefined, true, () => this._commandService.executeCommand('revealFileInOS', URI.file(path))),
				new Action('dispatch.docs.copyPath', localize('dispatchDocs.copyPath', "Copy Path"), undefined, true, () => this._clipboardService.writeText(path)),
				new Action('dispatch.docs.remove', localize('dispatchDocs.remove', "Remove from Docs"), undefined, !!doc && !!this._state.folder && isBoardDoc(doc), async () => {
					if (!doc || !this._state.folder) {
						return;
					}
					await this._commandService.executeCommand('dispatch.docsRemove', this._state.folder, doc.id);
					for (const [k, v] of this._cache) {
						this._cache.set(k, { ...v, docs: v.docs?.filter(d => d.id !== doc.id) });
					}
					this._state = { ...this._state, docs: this._state.docs?.filter(d => d.id !== doc.id) };
					// its tab goes; the Docs tab shows the list without it
					const input = this.input;
					this.back();
					if (input) {
						await this.group.closeEditor(input);
					}
				}),
			],
		});
	}

	/** "Delivered 6m ago for <task> +3" / "Prototype for <task>" / "Updated 2d ago · design/x". */
	private renderContext(parent: HTMLElement, path: string, proto: boolean): void {
		const view = this._view as { task?: string; reason?: string };
		const doc = this.docByPath(path);
		const ctx = dom.append(parent, dom.$('.dispatch-docs-context'));
		let tasks = [...(doc?.tasks ?? [])];
		if (view.task) {
			const i = tasks.findIndex(t => t.id === view.task);
			if (i > 0) {
				tasks.unshift(...tasks.splice(i, 1));
			}
		}
		tasks = tasks.filter(t => t.id);
		if (tasks.length) {
			ctx.appendChild(renderIcon(Codicon.checklist));
			const first = tasks[0];
			// a delivery page is a delivery, not a prototype: "Prototype for" is for a page that belongs to a design or a note
			const delivered = !!doc && doc.path === path && (doc.group === 'delivered' || doc.delivered_at > 0);
			const lead = isHandoffDoc(path, doc)
				? localize('dispatchDocs.handoffFor', "Handoff for")
				: proto && !delivered
				? localize('dispatchDocs.prototypeFor', "Prototype for")
				: view.reason === 'delivered' && Date.now() / 1000 - first.delivered_at < 90
					? localize('dispatchDocs.deliveredJustNow', "Delivered just now for")
					: localize('dispatchDocs.deliveredFor', "Delivered {0} for", dispatchDocAgo(first.delivered_at || doc?.delivered_at || doc?.mtime || 0));
			dom.append(ctx, dom.$('span.li', undefined, lead));
			const a = dom.append(ctx, dom.$<HTMLAnchorElement>('a.task', { role: 'button', tabindex: '0' }, first.title));
			a.title = localize('dispatchDocs.showTask', "Show the task in Tasks");
			const openTask = (t: IDispatchDocTask) => void this._commandService.executeCommand('dispatch.showTask', t.id, t.title);
			this._viewStore.add(dom.addDisposableListener(a, dom.EventType.CLICK, () => openTask(first)));
			this._viewStore.add(dom.addDisposableListener(a, dom.EventType.KEY_DOWN, e => { if (e.key === 'Enter') { openTask(first); } }));
			if (tasks.length > 1) {
				const plus = this.button(ctx, 'dispatch-docs-plus', `+${tasks.length - 1}`, undefined, () => {
					this._contextMenuService.showContextMenu({
						getAnchor: () => plus,
						getActions: () => tasks.slice(1).map(t => new Action(`dispatch.docs.task.${t.id}`, t.title, undefined, true, async () => openTask(t))),
					});
				}, localize('dispatchDocs.moreTasks', "Also delivered for {0} more tasks", tasks.length - 1));
			}
		} else if (!proto) {
			const folder = this._state.folder;
			const dir = folder && path.startsWith(folder + '/') ? path.slice(folder.length + 1).replace(/\/[^/]+$/, '') : dirname(URI.file(path)).fsPath;
			const when = doc ? dispatchDocAgo(Math.max(doc.delivered_at, doc.mtime)) : '';
			dom.append(ctx, dom.$('span.li.quiet', undefined, when ? localize('dispatchDocs.updated', "Updated {0} · {1}", when, dir) : dir));
		}
	}

	/** After a fresh list: the second line learns the task (a delivery opens before the list has it). */
	private refreshContext(): void {
		const v = this._view;
		if (v.kind === 'list') {
			return;
		}
		const ctx = this._root.querySelector<HTMLElement>('.dispatch-docs-context');
		if (!ctx) {
			return;
		}
		const holder = dom.$('div');
		this.renderContext(holder, v.path, v.kind === 'proto');
		const fresh = holder.firstElementChild;
		if (fresh) {
			ctx.replaceWith(fresh);
		}
		if (v.kind === 'doc' && !this._root.querySelector('.dispatch-docs-where')) {
			const doc = this.docByPath(v.path);
			if (doc?.where) {
				this.render();
			}
		}
	}

	private async readText(uri: URI): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(uri)).value.toString();
		} catch {
			return undefined;
		}
	}

	/** A local picture as a blob: URL (the window's CSP allows blob:, not file:). */
	private async blobUrl(uri: URI): Promise<string | undefined> {
		const key = uri.toString();
		const hit = this._blobs.get(key);
		if (hit) {
			return hit;
		}
		try {
			const content = await this._fileService.readFile(uri);
			const ext = extname(uri).toLowerCase();
			const type = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
			const url = URL.createObjectURL(new Blob([content.value.buffer as Uint8Array<ArrayBuffer>], { type }));
			this._blobs.set(key, url);
			return url;
		} catch {
			return undefined;
		}
	}

	private async renderDoc(view: Extract<View, { kind: 'doc' }>, gen: number): Promise<void> {
		const root = this._root;
		root.classList.add('reading');
		const reader = dom.append(root, dom.$('.dispatch-docs-reader'));
		this.renderHead(reader, view.path);
		const scroll = dom.append(reader, dom.$('.dispatch-docs-reader-scroll'));
		this._drawScroll = { kind: 'dom', el: scroll };
		this.renderContext(scroll, view.path, false);
		const h1 = dom.append(scroll, dom.$('h1.dispatch-docs-title'));
		const doc = this.docByPath(view.path);
		h1.textContent = doc?.title ?? basename(URI.file(view.path));
		if (doc) {
			this.nameTab(doc.title, true);
		}
		const uri = URI.file(view.path);
		const text = await this.readText(uri);
		if (gen !== this._renderGen) {
			return;
		}
		if (text === undefined) {
			const e = dom.append(scroll, dom.$('.dispatch-docs-empty'));
			dom.append(e, dom.$('.et', undefined, localize('dispatchDocs.gone', "This file is not there any more.")));
			dom.append(e, dom.$('.ed', undefined, view.path));
			return;
		}
		const where = doc?.where;
		// a handoff's header names its task and session by id; the reader shows them by name above (users 09-27: no
		// task-xxxx on screen). The lines stay as blank lines so the line numbers of notes and drawings still match.
		const shown = isHandoffDoc(view.path, doc) ? text.replace(/^(Task|Session|After message):.*$/gm, '') : text;
		const md = markdownBlocks(shown, !!where?.items.length);
		if (!doc && md.title) {
			h1.textContent = md.title.replace(/[（(](task-[a-z0-9]+|\d{4}-\d{2}-\d{2}|[，,\s]|[A-Z] 组)+[）)]\s*$/, '').trim() || md.title;
			this.nameTab(h1.textContent, false);
		}
		if (where?.items.length) {
			this.renderWhere(scroll, where, view.mark);
		}
		const body = dom.append(scroll, dom.$('.dispatch-docs-md'));
		// which file this is: a side chat's card finds its passage here (dispatchSideChat/browser/dispatchDocPassage.ts)
		body.dataset.path = view.path;
		safeSetInnerHtml(body, md.blocks.map(b => `<div class="md-block" data-line="${b.start}" data-end="${b.end}">${b.html}</div>`).join(''), {
			allowedAttributes: { augment: ['class', 'data-line', 'data-end', 'colspan', 'rowspan', 'start'] },
			allowedLinkProtocols: { override: ['http', 'https', 'mailto', 'file'] },
			allowedMediaProtocols: { override: ['http', 'https', 'data', 'file'] },
			allowRelativeLinkPaths: true,
			allowRelativeMediaPaths: true,
		});
		const dir = dirname(uri);
		for (const img of body.querySelectorAll('img')) {
			const src = img.getAttribute('src') ?? '';
			img.classList.add('fig');
			img.tabIndex = 0;
			img.setAttribute('role', 'button');
			this._viewStore.add(dom.addDisposableListener(img, dom.EventType.CLICK, e => { e.preventDefault(); e.stopPropagation(); this.enlargePicture(img); }));
			this._viewStore.add(dom.addDisposableListener(img, dom.EventType.KEY_DOWN, e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.enlargePicture(img); } }));
			img.removeAttribute('src');
			if (/^https?:|^data:/i.test(src)) {
				img.src = src;
				continue;
			}
			const target = src.startsWith('file:') ? URI.parse(src) : src.startsWith('/') ? URI.file(src) : joinPath(dir, decodeURIComponent(src.split('#')[0].split('?')[0]));
			void this.blobUrl(target).then(url => { if (url) { img.src = url; } });
		}
		this._viewStore.add(dom.addDisposableListener(body, dom.EventType.CLICK, e => {
			const a = (e.target as HTMLElement).closest('a');
			if (!a) {
				return;
			}
			e.preventDefault();
			const href = a.getAttribute('href') ?? '';
			if (!href || href.startsWith('#')) {
				return;
			}
			if (/^(https?|mailto):/i.test(href)) {
				void this._openerService.open(URI.parse(href), { openExternal: true });
				return;
			}
			const target = href.startsWith('file:') ? URI.parse(href) : href.startsWith('/') ? URI.file(href) : joinPath(dir, decodeURIComponent(href.split('#')[0].split('?')[0]));
			if (/\.(md|markdown)$/i.test(target.path) || isHtml(target.path)) {
				this.openTab(target.fsPath);
			} else {
				void this._instantiationService.invokeFunction(dispatchOpenPath, target, { fromDocs: true, focus: true });
			}
		}));
		this.setupAsk(reader, body, uri);
		// answers kept on a passage from a side chat (Keep as comment, task-23iin)
		this._viewStore.add(attachDocComments(body, view.path));
	}

	/** The document's tab learns its name: the list's (`known`), or the document's own when the tab only had its file name. */
	private nameTab(title: string, known: boolean): void {
		const input = this.input;
		if (input instanceof DispatchDocTabInput && (known || input.fullTitle === dispatchDocFallbackTitle(input.path))) {
			input.setTitle(title);
		}
	}

	private enlargePicture(img: HTMLImageElement): void {
		if (!img.src) { return; }
		const store = this._viewStore.add(new DisposableStore());
		const overlay = dom.append(this._root, dom.$('.dispatch-docs-picture', { role: 'dialog', 'aria-label': img.alt || localize('dispatchDocs.picture', "Picture"), 'aria-modal': 'true' }));
		const head = dom.append(overlay, dom.$('.dispatch-docs-reader-head'));
		dom.append(head, dom.$('span.sp', undefined, img.alt));
		const close = () => store.dispose();
		const button = this.button(head, 'dispatch-docs-icon', '', Codicon.close, close, localize('dispatchDocs.closePicture', "Close picture (Esc)"));
		const scroll = dom.append(overlay, dom.$('.dispatch-docs-picture-scroll'));
		const picture = dispatchWherePictureOf(img);
		if (picture) {
			store.add(new DispatchWhereViewer(scroll, picture, img.src, { pictureUrl: image => this.blobUrl(URI.file(image)) }));
		} else {
			dom.append(scroll, dom.$('img', { src: img.src, alt: img.alt }));
		}
		store.add(dom.addDisposableListener(overlay, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
		}, true));
		store.add(toDisposable(() => { overlay.remove(); img.focus(); }));
		button.focus();
	}

	// ---- Where to look --------------------------------------------------------------------------

	/**
	 * The shared 「在哪」 (dispatchWhere.ts, the delivery page's): the whole picture with every numbered box
	 * first, a line or a box zooms there, Whole picture comes back; opened from a deliverable's snippet it
	 * starts on the spot the snippet showed. Enlarge widens the side pane.
	 */
	private renderWhere(parent: HTMLElement, where: IDispatchDocWhere, mark: number | undefined): void {
		const picture = parseDispatchMarks(where);
		if (!picture?.marks.length) {
			return;
		}
		const holder = dom.append(parent, dom.$('.dispatch-docs-where'));
		const pictureUrl = (image: string) => this.blobUrl(URI.file(image));
		const viewer = this._viewStore.add(new DispatchWhereViewer(holder, picture, undefined, { selected: mark, pictureUrl }));
		let down: { x: number; y: number } | undefined;
		this._viewStore.add(dom.addDisposableListener(viewer.viewport, dom.EventType.POINTER_DOWN, e => { down = { x: e.clientX, y: e.clientY }; }));
		this._viewStore.add(dom.addDisposableListener(viewer.viewport, dom.EventType.CLICK, e => {
			const img = viewer.viewport.querySelector('img');
			if (img && down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) <= 4) { this.enlargePicture(img); }
			down = undefined;
		}));
		void pictureUrl(picture.image).then(url => {
			const img = viewer.viewport.querySelector('img');
			if (url && img && !img.src) {
				img.src = url;
			}
		});
	}

	// ---- Ask Question on a selection ------------------------------------------------------------

	private setupAsk(reader: HTMLElement, body: HTMLElement, uri: URI): void {
		const ask = this._viewStore.add(new FeedbackInputWidget({
			placeholder: localize('dispatchDocs.askPlaceholder', "Ask Question"),
			ariaLabel: localize('dispatchDocs.askAria', "Ask a question about the selected text"),
			getMaxContentWidth: () => Math.max(200, body.clientWidth - 40),
			primaryAction: { label: localize('dispatchDocs.ask', "Ask Question"), icon: Codicon.arrowUpCompact, keybindingLabel: localize('dispatchDocs.enter', "Enter") },
			// Quote in front of Ask Question, as in the chat's selection box (kanban design/quote/redesign 方向 B)
			leadingActions: [{ id: 'quote', label: quoteLabel(), icon: quoteIcon, title: quoteTitle(), run: () => void quote() }],
		}));
		this._ask = ask;
		reader.appendChild(ask.domNode);
		ask.domNode.classList.add('dispatch-docs-ask');
		const hide = () => {
			ask.hide();
			ask.clearInput();
			this._askRange = undefined;
		};
		const submit = async () => {
			const r = this._askRange;
			const question = ask.inputElement.value.trim();
			if (!r) {
				return;
			}
			hide();
			await this._commandService.executeCommand('_dispatch.askAboutSelection', {
				uri: uri.toString(), startLineNumber: r.start, startColumn: 1, endLineNumber: r.end, endColumn: 2, text: r.text, question, inDocs: true,
			});
		};
		const quote = async () => {
			const r = this._askRange;
			if (!r) {
				return;
			}
			hide();
			dom.getWindow(body).getSelection()?.removeAllRanges();
			await this._commandService.executeCommand(DISPATCH_QUOTE_COMMAND, {
				uri: uri.toString(), startLineNumber: r.start, startColumn: 1, endLineNumber: r.end, endColumn: 2, text: r.text, from: 'file',
			});
		};
		// ⇧⌘L quotes the selection while its box is up
		this._viewStore.add(dom.addDisposableListener(dom.getWindow(body).document, dom.EventType.KEY_DOWN, e => {
			const mod = isMacintosh ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
			if (this._askRange && ask.domNode.style.display !== 'none' && mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
				e.preventDefault();
				e.stopPropagation();
				void quote();
			}
		}, true));
		this._viewStore.add(ask.onDidTriggerPrimary(() => void submit()));
		this._viewStore.add(dom.addDisposableListener(ask.inputElement, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void submit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				hide();
				dom.getWindow(body).getSelection()?.removeAllRanges();
			}
		}));
		const onUp = () => setTimeout(() => {
			const sel = dom.getWindow(body).getSelection();
			if (!sel || sel.isCollapsed || !sel.rangeCount) {
				if (!dom.isAncestorOfActiveElement(ask.domNode)) {
					hide();
				}
				return;
			}
			const range = sel.getRangeAt(0);
			if (!body.contains(range.commonAncestorContainer)) {
				return;
			}
			const text = sel.toString().trim();
			if (!text) {
				return;
			}
			const blockOf = (n: Node) => (n.nodeType === 1 ? n as HTMLElement : n.parentElement)?.closest<HTMLElement>('.md-block');
			const a = blockOf(range.startContainer), b = blockOf(range.endContainer);
			const start = Number(a?.dataset.line ?? 1), end = Number(b?.dataset.end ?? b?.dataset.line ?? start);
			this._askRange = { text, start, end: Math.max(start, end) };
			ask.show();
			ask.autoSize();
			ask.updateActionEnabled();
			const rr = range.getClientRects()[0] ?? range.getBoundingClientRect();
			const last = range.getBoundingClientRect();
			const origin = reader.getBoundingClientRect();
			const width = ask.domNode.offsetWidth;
			const left = Math.max(12, Math.min(rr.left - origin.left, origin.width - width - 12));
			let top = last.bottom - origin.top + 6;
			if (top + ask.domNode.offsetHeight > origin.height - 8) {
				top = Math.max(40, rr.top - origin.top - ask.domNode.offsetHeight - 6);
			}
			ask.domNode.style.left = `${left}px`;
			ask.domNode.style.top = `${top}px`;
		}, 0);
		this._viewStore.add(dom.addDisposableListener(body, dom.EventType.MOUSE_UP, onUp));
		this._viewStore.add(dom.addDisposableListener(reader, dom.EventType.MOUSE_DOWN, e => {
			if (!ask.domNode.contains(e.target as Node)) {
				hide();
			}
		}));
		const scroller = reader.querySelector('.dispatch-docs-reader-scroll');
		if (scroller) {
			this._viewStore.add(dom.addDisposableListener(scroller, 'scroll', () => hide(), { passive: true }));
		}
	}

	// ---- the prototype page ---------------------------------------------------------------------


	/**
	 * Draw and ask's whole-page picture (`_dispatch.docsScroll`): where the document shows and how far it is
	 * scrolled, after scrolling it to `y` when asked (window CSS pixels). Undefined: no document, or the page
	 * did not answer.
	 */
	async drawScroll(op: 'metrics' | 'scroll', y = 0, hideFixed = false): Promise<IDispatchDocScroll | undefined> {
		const target = this._drawScroll;
		if (!target) {
			return undefined;
		}
		if (target.kind === 'dom') {
			const el = target.el;
			if (op === 'scroll') {
				const behavior = el.style.scrollBehavior;
				el.style.scrollBehavior = 'auto';
				el.scrollTop = y;
				el.style.scrollBehavior = behavior;
				await picturesIn(el);
				await twoFrames();
			}
			const r = el.getBoundingClientRect();
			return { rect: { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight }, top: el.scrollTop, height: el.scrollHeight };
		}
		const id = ++this._drawSeq;
		const answer = new Promise<{ top: number; height: number; vh: number } | undefined>(resolve => {
			this._drawWaiters.set(id, resolve);
			mainWindow.setTimeout(() => {
				if (this._drawWaiters.delete(id)) {
					resolve(undefined);
				}
			}, 2000);
		});
		void target.webview.postMessage(op === 'scroll' ? { dispatchDraw: 'scroll', id, y: y / this._drawK, hideFixed } : { dispatchDraw: 'metrics', id });
		const m = await answer;
		if (!m || this._drawScroll !== target) {
			return undefined;
		}
		const r = target.frame.getBoundingClientRect();
		this._drawK = r.height / m.vh || 1;
		if (op === 'scroll') {
			// the page painted there; the window composites it a frame later
			await twoFrames();
		}
		return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, top: m.top * this._drawK, height: m.height * this._drawK };
	}

	private async renderProto(view: Extract<View, { kind: 'proto' }>, gen: number): Promise<void> {
		const root = this._root;
		root.classList.add('reading');
		const uri = URI.file(view.path);
		const dir = dirname(uri);
		const readme = joinPath(dir, 'README.md');
		const hasNotes = await this._fileService.exists(readme).catch(() => false);
		if (gen !== this._renderGen) {
			return;
		}
		const reader = dom.append(root, dom.$('.dispatch-docs-reader.proto'));
		const headRow = this.renderHead(reader, view.path, hasNotes ? readme.fsPath : undefined);
		const ph = dom.append(reader, dom.$('.dispatch-docs-proto-head'));
		this.renderContext(ph, view.path, true);
		const doc = this.docByPath(view.path);
		const html = await this.readText(uri);
		// a delivery page (`dispatch deliver`) comes from dispatch-bridge's local page server, so its
		// Choose A / B records the pick for its task; any other page is loaded from the file
		const task = view.task ?? (doc && doc.path === view.path ? doc.tasks[0]?.id : undefined) ?? '';
		const served = html === undefined ? undefined
			: await this._commandService.executeCommand<{ url: string; kind?: string }>('dispatch.docsPageUrl', view.path, task).catch(() => undefined);
		if (gen !== this._renderGen) {
			return;
		}
		const title = (html?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
			|| (doc && doc.path === view.path ? doc.title : '') || basename(uri);
		// the page's title right after "‹ Docs" on the head row, cut short with its whole text on hover; the row of its
		// own under the head is gone (kanban 2026-10-10: "这个文件的标题跟在 docs 后面就可以了")
		const ht = dom.$('span.ht', undefined, title);
		headRow.firstElementChild?.after(ht);
		this._viewStore.add(setupDispatchTextHover(this._hoverService, ht, () => ({ head: title })));
		this.nameTab(doc && doc.path === view.path ? doc.title : title, !!doc && doc.path === view.path);
		const bar = dom.append(reader, dom.$('.dispatch-docs-browser-bar'));
		this.button(bar, 'dispatch-docs-icon.small', '', Codicon.refresh, () => this.render(), localize('dispatchDocs.reload', "Reload"));
		const addr = dom.append(bar, dom.$('.addr'));
		addr.appendChild(renderIcon(Codicon.globe));
		dom.append(addr, dom.$('span.f', undefined, basename(uri)));
		const folder = this._state.folder;
		dom.append(addr, dom.$('span.d', undefined, folder && view.path.startsWith(folder + '/') ? view.path.slice(folder.length + 1).replace(/\/[^/]+$/, '') : dir.fsPath));
		const seg = dom.append(bar, dom.$('.dispatch-docs-scope.small', { role: 'tablist' }));
		// a delivery page lays itself out for the pane's width: no Fit / 100%
		const zooms: ['fit' | 'one', string][] = served?.url ? [] : [['fit', localize('dispatchDocs.fit', "Fit")], ['one', '100%']];
		const frame = dom.append(reader, dom.$('.dispatch-docs-frame'));
		for (const [z, label] of zooms) {
			const b = this.button(seg, 'dispatch-docs-pill', label, undefined, () => {
				this._protoZoom = z;
				seg.querySelectorAll('.dispatch-docs-pill').forEach(x => x.classList.toggle('on', x === b));
				void this._webview.value?.postMessage({ dispatchZoom: z });
			});
			b.setAttribute('role', 'tab');
			b.classList.toggle('on', this._protoZoom === z);
		}
		if (html === undefined) {
			const e = dom.append(frame, dom.$('.dispatch-docs-empty'));
			dom.append(e, dom.$('.et', undefined, localize('dispatchDocs.gone', "This file is not there any more.")));
			return;
		}
		const roots = [dir];
		const f = this._state.folder ? URI.file(this._state.folder) : undefined;
		if (f && isEqualOrParent(uri, f)) {
			roots.unshift(f);
		}
		const webview = this._webviewService.createWebviewElement({
			title,
			providedViewType: 'dispatch.docs.prototype',
			options: { purpose: WebviewContentPurpose.WebviewView, enableFindWidget: false, retainContextWhenHidden: false },
			// the page may ask for the API itself: Draw and ask's scroll agent has it too
			contentOptions: { allowScripts: true, localResourceRoots: roots, allowMultipleAPIAcquire: true },
			extension: undefined,
		});
		this._webview.value = webview;
		this._drawScroll = { kind: 'webview', frame, webview };
		this._viewStore.add(webview.onMessage(e => {
			const d = e.message as { dispatchDraw?: string; id?: number; m?: { top: number; height: number; vh: number } } | undefined;
			if (d?.dispatchDraw === 'escape' && this._layoutService.isEditorMaximized()) {
				void this._commandService.executeCommand('workbench.action.agentSessions.restoreMainEditorPart');
				return;
			}
			if (d?.dispatchDraw === 'done' && typeof d.id === 'number') {
				const resolve = this._drawWaiters.get(d.id);
				this._drawWaiters.delete(d.id);
				resolve?.(d.m && typeof d.m.top === 'number' && typeof d.m.height === 'number' && d.m.vh > 0 ? d.m : undefined);
			}
		}));
		if (served?.url && /^http:\/\/127\.0\.0\.1:\d+\//.test(served.url)) {
			const src = served.url.replace(/"/g, '%22');
			webview.setHtml(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head><body><iframe src="${src}" title="${title.replace(/[<>"&]/g, '')}"></iframe>${DRAW_SCROLL_RELAY}</body></html>`);
			webview.mountTo(frame, dom.getWindow(frame));
			return;
		}
		const base = asWebviewUri(dir).toString(true).replace(/\/?$/, '/');
		const zoom = `<script>(function(){var mode=${JSON.stringify(this._protoZoom)};function apply(){var d=document.documentElement;d.style.zoom='';if(mode!=='fit')return;var w=Math.max(d.scrollWidth,document.body?document.body.scrollWidth:0);if(w>innerWidth+2)d.style.zoom=String(innerWidth/w);}addEventListener('message',function(e){if(e.data&&e.data.dispatchZoom){mode=e.data.dispatchZoom;apply();}});addEventListener('load',apply);addEventListener('resize',apply);setTimeout(apply,300);})();</script>`;
		const head = `<base href="${base}">${zoom}${READABLE_PAGE}${DRAW_SCROLL_PAGE}`;
		const page = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html;
		webview.setHtml(page);
		webview.mountTo(frame, dom.getWindow(frame));
	}
}

CommandsRegistry.registerCommand(DISPATCH_DOCS_SCROLL_COMMAND, (accessor, op: unknown, y: unknown, hideFixed: unknown) => {
	const pane = accessor.get(IEditorService).activeEditorPane;
	if (!(pane instanceof DispatchDocsEditor) || (op !== 'metrics' && op !== 'scroll')) {
		return undefined;
	}
	return pane.drawScroll(op, typeof y === 'number' ? y : 0, hideFixed === true);
});

/** A document's own tab: the Docs pane in reader mode, under its own id (so the Docs list keeps its pane behind it). */
export class DispatchDocTabEditor extends DispatchDocsEditor {
	static override readonly ID: string = DispatchDocTabInput.EDITOR_ID;
}
