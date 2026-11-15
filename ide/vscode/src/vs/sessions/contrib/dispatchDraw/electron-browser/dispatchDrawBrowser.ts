/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Draw and ask on a page in the integrated browser (kanban design/task-model/
 *  DECISIONS.md 「标注图四个触点」: 网页用选元素、图和截图用画框，两者合一; patches/320-draw-and-ask.patch).
 *
 *  A button in the browser's toolbar next to Add to Chat. It freezes the page as it is (a PNG of the
 *  viewport, or of the whole page when it is longer than the pane, so the tool scrolls through all of it; the page
 *  view hidden meanwhile) and opens the draw tool over it at the page's own
 *  size, so the boxes land where the page was. While you drag, the box snaps to the page element
 *  whose edges it is closest to (a dashed outline and the element's name show which; Alt draws
 *  freely). Add to message puts the picture into the chat input with, per box, what the element
 *  picker would give for it: the element, its size, its text, a trimmed outer HTML and its key
 *  styles (the picker's own list and shorthands, platform/browserView/common/cssHelpers.ts). A
 *  box that did not snap gets the element covering it the way the picker resolves a dragged region
 *  (the deepest common visible ancestor of nine points).
 *
 *  The page is read through the browser's CDP service (the same one extensions use), attached to
 *  this page only, for as long as the tool is open.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDispatchMarksMetaElement } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { collapseToShorthands, keyComputedProperties } from '../../../../platform/browserView/common/cssHelpers.js';
import { CDPEvent, CDPResponse } from '../../../../platform/browserView/common/cdp/types.js';
import { IBrowserViewCDPService, IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionGroup, BrowserEditor, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { dispatchPictureSize } from '../../dispatchCommon/browser/dispatchWhere.js';
import { dispatchBlobUrl } from '../browser/dispatchDrawInput.js';
import { openDispatchPaneDraw } from '../browser/dispatchDrawPane.js';
import { IDispatchDrawMark, IDispatchSnapTarget } from '../browser/dispatchDrawTool.js';

/** One page's CDP connection through the browser's CDP service. */
class PageConnection {

	private seq = 1;
	private readonly store = new DisposableStore();
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private sessionId: string | undefined;

	private constructor(private readonly cdp: IBrowserViewCDPService, private readonly groupId: string) {
		this.store.add(cdp.onCDPMessage(groupId)((msg: CDPResponse | CDPEvent) => {
			if ('id' in msg && typeof msg.id === 'number') {
				const p = this.pending.get(msg.id);
				if (p) {
					this.pending.delete(msg.id);
					if (msg.error) {
						p.reject(new Error(msg.error.message));
					} else {
						p.resolve(msg.result);
					}
				}
			}
		}));
	}

	static async open(cdp: IBrowserViewCDPService, browserId: string): Promise<PageConnection> {
		const groupId = await cdp.createSessionGroup(browserId);
		const conn = new PageConnection(cdp, groupId);
		try {
			const targets = await conn.send('Target.getTargets') as { targetInfos?: { targetId: string; vscodeBrowserViewId?: string; type?: string }[] };
			const target = targets.targetInfos?.find(t => t.vscodeBrowserViewId === browserId) ?? targets.targetInfos?.find(t => t.type === 'page');
			if (!target) {
				throw new Error('page target not found');
			}
			const attached = await conn.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId: string };
			conn.sessionId = attached.sessionId;
			return conn;
		} catch (e) {
			conn.dispose();
			throw e;
		}
	}

	send(method: string, params?: unknown): Promise<unknown> {
		const id = this.seq++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.cdp.sendCDPMessage(this.groupId, { id, method, params, sessionId: this.sessionId }).catch(e => {
				this.pending.delete(id);
				reject(e);
			});
		});
	}

	async evaluate<T>(expression: string): Promise<T> {
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
		if (r.exceptionDetails) {
			throw new Error(r.exceptionDetails.text ?? 'page script failed');
		}
		return r.result?.value as T;
	}

	dispose(): void {
		for (const p of this.pending.values()) {
			p.reject(new Error('closed'));
		}
		this.pending.clear();
		this.store.dispose();
		void this.cdp.destroySessionGroup(this.groupId).catch(() => { });
	}
}

interface IPageElements {
	readonly vw: number;
	readonly vh: number;
	readonly url: string;
	/** [x, y, w, h, depth, label, index] in CSS pixels: of the viewport, or of the whole page (`whole`). */
	readonly els: [number, number, number, number, number, string, number][];
}

/** How tall the page is against its viewport, and where it is scrolled to (CSS pixels). */
interface IPageSize {
	readonly vw: number;
	readonly vh: number;
	readonly height: number;
	readonly scrollY: number;
	/** The page's width without the scroll bar: what a whole-page picture is as wide as. */
	readonly sw: number;
}
const PAGE_SIZE = `({ vw: innerWidth, vh: innerHeight, height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), scrollY: scrollY, sw: document.documentElement.scrollWidth })`;
/**
 * A whole page as one picture: at most this many pixels a side. A capture taller than 16384 repeats the page from
 * its top below that row, so a longer page is taken smaller.
 */
const WHOLE_PAGE_MAX_SIDE = 16384;

/**
 * Every visible element in the viewport with its box, outermost first when several share a box (a
 * link and the span in it: the link). Kept on `window.__dispatchDrawEls` so a box can be looked up
 * again by index.
 */
const collectElements = (whole: boolean) => `((whole) => {
	const vw = innerWidth, vh = innerHeight, out = [], seen = new Set(), keep = [];
	// the whole page: every element, at its place on the page; else what is in the viewport
	const ox = whole ? scrollX : 0, oy = whole ? scrollY : 0;
	for (const el of document.querySelectorAll('body *')) {
		if (out.length >= (whole ? 12000 : 4000)) { break; }
		const b = el.getBoundingClientRect();
		const r = { left: b.left + ox, top: b.top + oy, width: b.width, height: b.height, right: b.right + ox, bottom: b.bottom + oy };
		if (r.width < 4 || r.height < 4 || r.right <= 0 || r.bottom <= 0 || r.left >= vw + ox || (!whole && r.top >= vh)) { continue; }
		const cs = getComputedStyle(el);
		if (cs.visibility === 'hidden' || cs.display === 'contents' || Number(cs.opacity) === 0) { continue; }
		const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
		if (seen.has(key)) { continue; }
		seen.add(key);
		let depth = 0;
		for (let p = el.parentElement; p; p = p.parentElement) { depth++; }
		const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
		const label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls.length ? '.' + cls.join('.') : '');
		keep.push(el);
		out.push([r.left, r.top, r.width, r.height, depth, label, keep.length - 1]);
	}
	window.__dispatchDrawEls = keep;
	return { vw, vh, url: location.href, els: out };
})(${whole})`;

/**
 * What the picker gives for an element: its name, size, text, trimmed outer HTML, ancestors and the
 * computed values of `props`. `index` is from collectElements; without one, `rect` (CSS pixels of the viewport, or of the
 * whole page with `whole`) resolves like the picker's dragged region: the deepest common visible ancestor of the
 * elements at its corners, edge midpoints and centre.
 */
function describeElementScript(index: number, rect: readonly number[], props: readonly string[], whole = false): string {
	return `((index, rect, props, whole) => {
	let el = index >= 0 ? (window.__dispatchDrawEls || [])[index] : undefined;
	if (!el && rect) {
		const back = [scrollX, scrollY];
		let [x, y, w, h] = rect;
		if (whole) {
			// the box is on the whole page: bring it on screen to see what covers it
			// instant: a page with scroll-behavior: smooth would still be on its way when it is looked at
			scrollTo({ left: back[0], top: Math.max(0, y - Math.max(0, (innerHeight - h) / 2)), behavior: 'instant' });
			x -= scrollX;
			y -= scrollY;
		}
		const x2 = x + w, y2 = y + h, cx = x + w / 2, cy = y + h / 2;
		const pts = [[x, y], [x2, y], [x, y2], [x2, y2], [cx, y], [cx, y2], [x, cy], [x2, cy], [cx, cy]];
		const hits = pts.map(([px, py]) => document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, px)), Math.min(innerHeight - 1, Math.max(0, py)))).filter(Boolean);
		const chains = hits.map(h => { const c = []; for (let p = h; p; p = p.parentElement) { c.unshift(p); } return c; });
		let common = chains[0] || [];
		for (const c of chains.slice(1)) { let i = 0; while (i < common.length && i < c.length && common[i] === c[i]) { i++; } common = common.slice(0, i); }
		el = common[common.length - 1];
		while (el && el.parentElement && (el.offsetWidth === 0 || el.offsetHeight === 0)) { el = el.parentElement; }
		if (whole) { scrollTo({ left: back[0], top: back[1], behavior: 'instant' }); }
	}
	if (!el) { return null; }
	const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	const style = {};
	for (const p of props) { const v = cs.getPropertyValue(p); if (v) { style[p] = v; } }
	const path = [];
	for (let p = el; p && p !== document.documentElement && path.length < 6; p = p.parentElement) { path.unshift(name(p)); }
	const html = el.outerHTML.replace(/\\s+/g, ' ');
	const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
	return { selector: name(el), size: [r.width, r.height], html: html.length > 600 ? html.slice(0, 600) + '…' : html, text: text.length > 120 ? text.slice(0, 120) + '…' : text, path: path.join(' > '), style };
})(${index}, ${JSON.stringify(rect)}, ${JSON.stringify(props)}, ${whole})`;
}

/** The picker's key properties, plus what tells a box's shape and type (the four corners collapse into border-radius). */
const STYLE_PROPS = [...keyComputedProperties, 'width', 'height', 'font-weight', 'line-height', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'gap'];

function styleLine(style: Record<string, string>): string {
	const entries = new Map<string, string>();
	for (const [k, v] of Object.entries(style)) {
		if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== 'rgba(0, 0, 0, 0)' && !(/^0px( 0px)*$/.test(v) && k !== 'width' && k !== 'height')) {
			entries.set(k, v);
		}
	}
	// one line per property: a longhand the picker's list already has and its shorthand say the same thing
	entries.delete('border-radius');
	const seen = new Set<string>();
	return collapseToShorthands(entries).map(l => l.replace(/;$/, '')).filter(l => {
		const name = l.split(':')[0].trim();
		return !seen.has(name) && !!seen.add(name);
	}).join('; ');
}

async function drawOnPage(editor: BrowserEditor, model: IBrowserViewModel, cdp: IBrowserViewCDPService, logService: ILogService, notificationService: INotificationService): Promise<void> {
	let conn: PageConnection | undefined;
	try {
		try {
			conn = await PageConnection.open(cdp, model.id);
		} catch (e) {
			logService.warn('[dispatch] Draw and ask: page not read, boxes will not snap', e);
		}
		// a page longer than the pane is taken whole, so the draw tool scrolls through all of it (user 2026-10-21:
		// in Draw and ask it stopped at the bottom of the screen while the page went on)
		let whole: IPageSize | undefined;
		let bytes: Uint8Array | undefined;
		if (conn) {
			try {
				const m = await conn.evaluate<IPageSize>(PAGE_SIZE);
				if (m && m.height > m.vh + 4) {
					// the browser view's own full-page capture: it allows for the page's zoom and gives pinch-to-zoom back
					bytes = (await model.captureScreenshot({ format: 'png', fullPage: true, fullPageMaxSide: WHOLE_PAGE_MAX_SIDE })).buffer;
					whole = m;
				}
			} catch (e) {
				logService.warn('[dispatch] Draw and ask: the whole page was not taken, the screen is', e);
			}
		}
		bytes ??= (await model.captureScreenshot({ format: 'png' })).buffer;
		const blob = dispatchBlobUrl(bytes, 'image/png');
		const size = await dispatchPictureSize(blob.url);
		blob.dispose();
		if (!size) {
			return;
		}
		let page: IPageElements | undefined;
		try {
			page = conn ? await conn.evaluate<IPageElements>(collectElements(!!whole)) : undefined;
		} catch (e) {
			logService.warn('[dispatch] Draw and ask: page elements not read, boxes will not snap', e);
		}
		// picture pixels per page CSS pixel (a whole page's picture is as wide as the page without its scroll bar)
		const k = whole?.sw ? size[0] / whole.sw : page?.vw ? size[0] / page.vw : 1;
		const snap: IDispatchSnapTarget[] = (page?.els ?? []).map(([x, y, w, h, depth, label, index]) => ({ box: [x * k, y * k, w * k, h * k], depth, label, key: String(index) }));

		// the page view is native and paints over everything: it steps back at once, and stays back while
		// the tool is open because the tool counts as an overlay for the browser (overNativeView)
		await model.setVisible(false);

		const pane = editor.getContainer() ?? editor.browserContainer;
		const connection = conn;
		await openDispatchPaneDraw({
			anchor: pane,
			bytes,
			mime: 'image/png',
			scale: k,
			name: `${model.title || 'page'}.png`,
			source: model.url,
			snap,
			overNativeView: true,
			page: page ? { url: page.url, viewport: [page.vw, page.vh] } : undefined,
			// the whole page opens where it was scrolled to, and the message gets the part with the boxes
			center: whole ? [whole.vw / 2 * k, (whole.scrollY + whole.vh / 2) * k] : undefined,
			wholeDocument: whole ? { viewport: whole.vh } : undefined,
			elements: connection ? async (marks: readonly IDispatchDrawMark[]) => {
				const out: IDispatchMarksMetaElement[] = [];
				for (const m of marks) {
					const index = m.snapKey !== undefined ? Number(m.snapKey) : -1;
					const rect = m.box.map(v => v / k);
					try {
						const d = await connection.evaluate<{ selector: string; size: [number, number]; html: string; text: string; path: string; style: Record<string, string> } | null>(describeElementScript(index, rect, STYLE_PROPS, !!whole));
						if (d) {
							out.push({ n: m.n, selector: d.selector, size: d.size, html: d.html, text: d.text || undefined, path: d.path, style: styleLine(d.style) || undefined });
						}
					} catch (e) {
						logService.warn('[dispatch] Draw and ask: element not read for box', m.n, e);
					}
				}
				return out;
			} : undefined,
		});
	} catch (e) {
		logService.error('[dispatch] Draw and ask on a page failed', e);
		notificationService.error(localize('dispatchDraw.pageFailed', "Could not draw on this page: {0}", String(e)));
	} finally {
		if (conn) {
			await conn.evaluate('delete window.__dispatchDrawEls').catch(() => undefined);
			conn.dispose();
		}
	}
}

class DispatchDrawAndAskOnPageAction extends Action2 {
	static readonly ID = 'workbench.action.browser.dispatchDrawAndAsk';

	constructor() {
		super({
			id: DispatchDrawAndAskOnPageAction.ID,
			title: localize2('dispatchDraw.browserAction', "Draw and ask"),
			tooltip: localize('dispatchDraw.browserTooltip', "Draw and ask"),
			icon: Codicon.edit,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL, CONTEXT_BROWSER_HAS_ERROR.negate()),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Tools,
				order: 0,
			},
		});
	}

	async run(accessor: ServicesAccessor, editorArg?: BrowserEditor): Promise<void> {
		const editor = editorArg instanceof BrowserEditor ? editorArg : accessor.get(IEditorService).activeEditorPane;
		if (!(editor instanceof BrowserEditor) || !editor.model) {
			return;
		}
		await drawOnPage(editor, editor.model, accessor.get(IBrowserViewCDPService), accessor.get(ILogService), accessor.get(INotificationService));
	}
}

registerAction2(DispatchDrawAndAskOnPageAction);
