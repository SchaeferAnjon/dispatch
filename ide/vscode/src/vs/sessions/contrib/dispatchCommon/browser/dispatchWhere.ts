/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: 「在哪」, the annotated screenshot every Dispatch surface shows the same way
 *  (kanban design/docs-tab/redesign 1.3, design/annotations/redesign 第 1 节, DESIGN.md 「第四处颜色」
 *  and 「联动悬停」; patches/070-where-is-what.patch). One implementation, no webview:
 *
 *  - the marks JSON (`00-where.json` next to a delivery note, `<picture>.marks.json` elsewhere) and
 *    its reader, {@link parseDispatchMarks} / {@link readDispatchMarks};
 *  - a thumbnail, {@link renderDispatchWhereThumb}: 3:2, cropped to all the marks plus a margin;
 *  - the viewer, {@link DispatchWhereViewer}: a "Where to look" head, the whole picture with every
 *    numbered box first, the numbered lines under it (beside it from 720 wide); a line or a box zooms
 *    to that spot (the box whole, at most 1:1) with the rest dimmed, Whole picture comes back, dragging
 *    looks around. The same behaviour as the delivery page's 在哪 (kanban agent/skills/delivery-page);
 *  - the numbered lines alone, {@link renderDispatchWhereLegend} (a message bubble, a card);
 *  - the snippet card for hovers, {@link DispatchWhereCard}: a viewport, a title, one line, actions.
 *
 *  The red and green boxes and their numbers are picture content: the component draws them on the raw
 *  screenshot (the delivery page's convention), or they are already in the picture (`drawn`: a picture
 *  the draw tool burned for the agent, an old annotated capture). The interface's own numbers (the
 *  lines) are neutral dots and never use the marks' colours.
 *
 *  Pictures are local files; the window's CSP allows blob: URLs, not file:, so
 *  {@link dispatchPictureUrl} reads them once and hands out a cached blob URL.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchWhere.css';
import { setupDispatchRowDetail } from '../../../../workbench/browser/dispatchHoverCard.js';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';

const $ = dom.$;

// ---------------------------------------------------------------- data

/** A mark's colour in the picture. Red is the default; green is "leave this" or a second hand on a picture that already has red. */
export type DispatchMarkColor = 'red' | 'green';

/** The two colours as they are drawn into pictures (DESIGN.md 「第四处颜色」). Never used for interface controls. */
export const DISPATCH_MARK_COLORS: Readonly<Record<DispatchMarkColor, string>> = { red: '#dc2626', green: '#16a34a' };

export interface IDispatchMark {
	/** The number drawn at the box's top left corner, from 1. */
	readonly n: number;
	/** x, y, width, height in picture pixels, origin at the top left. */
	readonly box: readonly [number, number, number, number];
	readonly color?: DispatchMarkColor;
	/** An agent's delivery: what it is · where it is · how to get there. */
	readonly what?: string;
	readonly where?: string;
	readonly how?: string;
	/** A person's mark: the one sentence written under it. */
	readonly note?: string;
	/** The mark is on another picture than the JSON's `image` (a delivery page with several frames). */
	readonly image?: string;
}

/**
 * The marks JSON, one format everywhere (kanban design/annotations/redesign 第 6 节):
 * `{ "v": 1, "image": "00-where.png", "size": [2880, 1774], "scale": 2, "marks": [{ "n": 1, "box": [x, y, w, h], "color": "red", "what", "where", "how" | "note" }] }`.
 * `dispatch docs list --json` gives the same thing as `where: { image, size, items }`; both read here.
 */
export interface IDispatchMarks {
	readonly v?: number;
	/** The picture: absolute path or URI string once read through {@link readDispatchMarks}, else as written (relative to the JSON). */
	readonly image: string;
	/** The picture's size in pixels, when known. */
	readonly size?: readonly [number, number];
	/** Picture pixels per screen point: 2 for a Retina screenshot. Unset means "guess from the size". */
	readonly scale?: number;
	/** The boxes are already in the picture (burned by the draw tool or an old annotation): draw none. */
	readonly drawn?: boolean;
	readonly marks: readonly IDispatchMark[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v : undefined;
}

function num4(v: unknown): [number, number, number, number] | undefined {
	if (!Array.isArray(v) || v.length !== 4 || !v.every(x => typeof x === 'number' && isFinite(x))) {
		return undefined;
	}
	return [v[0], v[1], v[2], v[3]];
}

/** Read a marks JSON (or a docs list `where`); undefined when it is not one. Marks without a usable box are dropped. */
export function parseDispatchMarks(raw: unknown): IDispatchMarks | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const image = str(raw.image);
	const list = Array.isArray(raw.marks) ? raw.marks : Array.isArray(raw.items) ? raw.items : undefined;
	if (!image || !list) {
		return undefined;
	}
	const marks: IDispatchMark[] = [];
	list.forEach((m, i) => {
		if (!isRecord(m)) {
			return;
		}
		const box = num4(m.box);
		if (!box || box[2] <= 0 || box[3] <= 0) {
			return;
		}
		marks.push({
			n: typeof m.n === 'number' && m.n > 0 ? m.n : i + 1,
			box,
			color: m.color === 'green' ? 'green' : 'red',
			what: str(m.what),
			where: str(m.where),
			how: str(m.how),
			note: typeof m.note === 'string' ? m.note : undefined,
			image: str(m.image),
		});
	});
	const size = Array.isArray(raw.size) && raw.size.length === 2 && raw.size.every(x => typeof x === 'number' && x > 0) ? [raw.size[0] as number, raw.size[1] as number] as const : undefined;
	const scale = typeof raw.scale === 'number' && raw.scale > 0 ? raw.scale : undefined;
	return { v: 1, image, size, scale, drawn: raw.drawn === true, marks };
}

/** Read a marks JSON file; `image` comes back as an absolute path (relative ones are next to the JSON). */
export async function readDispatchMarks(fileService: IFileService, json: URI): Promise<IDispatchMarks | undefined> {
	try {
		const content = await fileService.readFile(json);
		const parsed = parseDispatchMarks(JSON.parse(content.value.toString()));
		if (!parsed) {
			return undefined;
		}
		return { ...parsed, image: resolveDispatchPicture(json, parsed.image).toString() };
	} catch {
		return undefined;
	}
}

/** A picture named in a marks JSON, as a URI: absolute paths and URIs as they are, relative ones next to the JSON. */
export function resolveDispatchPicture(json: URI, image: string): URI {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(image)) {
		return URI.parse(image);
	}
	if (image.startsWith('/')) {
		return URI.file(image);
	}
	return URI.joinPath(json, '..', image);
}

/** Picture pixels per screen point: the JSON's scale, else 2 for a picture wider than 1600 (a Retina capture), else 1. */
export function dispatchPictureScale(marks: Pick<IDispatchMarks, 'scale' | 'size'>, naturalWidth?: number): number {
	if (marks.scale) {
		return marks.scale;
	}
	const w = marks.size?.[0] ?? naturalWidth ?? 0;
	return w > 1600 ? 2 : 1;
}

/** The line a mark says in the interface: its note, or 「what · where · how」. */
export function dispatchMarkLine(m: IDispatchMark): string {
	if (m.note !== undefined) {
		return m.note;
	}
	return [m.what, m.where, m.how].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- pictures

const PICTURE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_CACHED = 48;
const pictureCache = new Map<string, Promise<string | undefined>>();

/**
 * A local picture as a blob: URL, read once and kept (the newest {@link MAX_CACHED}). The window's CSP
 * allows blob: images, not file:.
 */
export function dispatchPictureUrl(fileService: IFileService, picture: URI | string): Promise<string | undefined> {
	const uri = typeof picture === 'string' ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(picture) ? URI.parse(picture) : URI.file(picture)) : picture;
	const key = uri.toString();
	const hit = pictureCache.get(key);
	if (hit) {
		pictureCache.delete(key);
		pictureCache.set(key, hit);
		return hit;
	}
	const p = (async () => {
		try {
			const content = await fileService.readFile(uri);
			const type = PICTURE_TYPES[extname(uri).toLowerCase()] ?? 'image/png';
			return URL.createObjectURL(new Blob([content.value.buffer as Uint8Array<ArrayBuffer>], { type }));
		} catch {
			pictureCache.delete(key);
			return undefined;
		}
	})();
	pictureCache.set(key, p);
	while (pictureCache.size > MAX_CACHED) {
		const [oldKey, old] = pictureCache.entries().next().value!;
		pictureCache.delete(oldKey);
		void old.then(url => url && URL.revokeObjectURL(url));
	}
	return p;
}

/** The natural size of a picture URL (loads it once). */
export function dispatchPictureSize(url: string): Promise<[number, number] | undefined> {
	return new Promise(resolve => {
		const img = new Image();
		img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
		img.onerror = () => resolve(undefined);
		img.src = url;
	});
}

// ---------------------------------------------------------------- thumbnail

/** The thumbnail sizes (width × height, 3:2) and where each one is used. */
export const DispatchThumbSize = {
	/** a chat input's image attachment */
	attachment: [72, 48],
	/** a row of the What's new card */
	row: [96, 64],
	/** an annotated attachment after drawing, a sent message */
	message: [144, 96],
	/** a question card's option */
	option: [216, 144],
	/** a Decide card's option */
	decide: [240, 160],
} as const satisfies Record<string, readonly [number, number]>;

export interface IDispatchThumbOptions {
	/** Width and height in CSS pixels (see {@link DispatchThumbSize}). */
	readonly size: readonly [number, number];
	/** `marks` (default) crops to all the marks plus 48 picture pixels; `full` covers with the whole picture. */
	readonly fit?: 'marks' | 'full';
	/** Only these marks count for the crop (default: all). */
	readonly only?: readonly number[];
	/** A 2px ring in the text colour: this one is picked. */
	readonly selected?: boolean;
	/** An enlarge chip at the bottom right on hover. */
	readonly zoom?: boolean;
	readonly title?: string;
}

/**
 * Crop rectangle (picture pixels) for a thumbnail of `tw`×`th` showing `marks`: their outer box plus
 * 48 pixels (and 40 more on top for the numbers drawn above the boxes), grown to the thumbnail's
 * shape and kept inside the picture.
 */
export function dispatchThumbCrop(picture: readonly [number, number], marks: readonly IDispatchMark[], tw: number, th: number, fit: 'marks' | 'full' = 'marks'): [number, number, number, number] {
	const [pw, ph] = picture;
	let x0 = 0, y0 = 0, x1 = pw, y1 = ph;
	if (fit === 'marks' && marks.length) {
		const pad = 48;
		x0 = Math.min(...marks.map(m => m.box[0])) - pad;
		y0 = Math.min(...marks.map(m => m.box[1])) - pad - 40;
		x1 = Math.max(...marks.map(m => m.box[0] + m.box[2])) + pad;
		y1 = Math.max(...marks.map(m => m.box[1] + m.box[3])) + pad;
	}
	let cw = x1 - x0, ch = y1 - y0;
	const ar = tw / th;
	if (cw / ch < ar) {
		const nw = ch * ar;
		x0 -= (nw - cw) / 2;
		cw = nw;
	} else {
		const nh = cw / ar;
		y0 -= (nh - ch) / 2;
		ch = nh;
	}
	cw = Math.min(cw, pw);
	ch = Math.min(ch, ph);
	x0 = Math.max(0, Math.min(x0, pw - cw));
	y0 = Math.max(0, Math.min(y0, ph - ch));
	return [x0, y0, cw, ch];
}

/**
 * A thumbnail (`.dispatch-where-thumb`): the picture as a background, cropped by {@link dispatchThumbCrop},
 * with the marks' boxes outlined unless the picture already has them (`drawn`). `url` is a blob: URL
 * ({@link dispatchPictureUrl}) or a data: URL. The element is returned at once and painted when the
 * picture's size is known.
 */
export function renderDispatchWhereThumb(url: string | undefined, marks: Pick<IDispatchMarks, 'size' | 'marks' | 'drawn'> | undefined, options: IDispatchThumbOptions): HTMLElement {
	const [tw, th] = options.size;
	const el = $('span.dispatch-where-thumb');
	el.style.width = `${tw}px`;
	el.style.height = `${th}px`;
	el.classList.toggle('selected', !!options.selected);
	if (options.title) {
		el.title = options.title;
	}
	if (options.zoom) {
		const zoom = dom.append(el, $('span.zoom'));
		zoom.setAttribute('aria-hidden', 'true');
		dom.append(zoom, $('span.codicon.codicon-screen-full'));
	}
	if (!url) {
		return el;
	}
	const paint = (size: readonly [number, number]) => {
		const shown = (marks?.marks ?? []).filter(m => !options.only || options.only.includes(m.n));
		const [x0, y0, cw, ch] = dispatchThumbCrop(size, shown, tw, th, options.fit ?? 'marks');
		const s = Math.max(tw / cw, th / ch);
		el.style.backgroundImage = `url("${url}")`;
		el.style.backgroundSize = `${size[0] * s}px ${size[1] * s}px`;
		el.style.backgroundPosition = `${-x0 * s}px ${-y0 * s}px`;
		el.querySelectorAll('.rb').forEach(b => b.remove());
		if (!marks?.drawn) {
			for (const m of shown) {
				const b = $('i.rb');
				b.classList.toggle('g', m.color === 'green');
				b.style.left = `${(m.box[0] - x0) * s}px`;
				b.style.top = `${(m.box[1] - y0) * s}px`;
				b.style.width = `${m.box[2] * s}px`;
				b.style.height = `${m.box[3] * s}px`;
				el.insertBefore(b, el.firstChild);
			}
		}
	};
	if (marks?.size) {
		paint(marks.size);
	} else {
		void dispatchPictureSize(url).then(size => size && paint(size));
	}
	return el;
}

// ---------------------------------------------------------------- icon

/**
 * 「带框的图」: the line icon of a deliverable that has a Where to look picture (a frame with a box
 * in it and a pointer), 14 by default, in the text colour it sits in. Codicons have no such glyph.
 */
export function renderDispatchWhereIcon(size = 14): SVGSVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = mainWindow.document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('dispatch-where-icon');
	const frame = mainWindow.document.createElementNS(ns, 'rect');
	for (const [k, v] of [['x', '2'], ['y', '3'], ['width', '12'], ['height', '10'], ['rx', '1.5']]) {
		frame.setAttribute(k, v);
	}
	svg.appendChild(frame);
	for (const d of ['M4.5 5.5h4v3h-4z', 'M14 11l-2.6-2.6']) {
		const path = mainWindow.document.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

// ---------------------------------------------------------------- numbered lines

export interface IDispatchLegendOptions {
	/** Show at most this many lines. */
	readonly max?: number;
	/** One line each, cut with an ellipsis (cards). */
	readonly oneLine?: boolean;
	/** Lines are options that can be picked (the viewer). */
	readonly selectable?: boolean;
}

/**
 * The numbered lines (`ol.dispatch-where-leg`): a neutral dot with the number, then the note, or
 * 「<em>what</em> · where · how」. Each `li` carries `data-n`.
 */
export function renderDispatchWhereLegend(parent: HTMLElement | undefined, marks: readonly IDispatchMark[], options: IDispatchLegendOptions = {}): HTMLOListElement {
	const ol = $('ol.dispatch-where-leg') as HTMLOListElement;
	ol.classList.toggle('one-line', !!options.oneLine);
	if (options.selectable) {
		ol.setAttribute('role', 'listbox');
	}
	for (const m of marks.slice(0, options.max ?? marks.length)) {
		const li = dom.append(ol, $('li'));
		li.dataset.n = String(m.n);
		if (options.selectable) {
			li.setAttribute('role', 'option');
			li.tabIndex = 0;
		}
		dom.append(li, $('span.n', { 'aria-hidden': 'true' }, String(m.n)));
		const text = dom.append(li, $('span.x'));
		if (m.note !== undefined) {
			text.textContent = m.note;
		} else {
			if (m.what) {
				dom.append(text, $('em', undefined, m.what));
			}
			const rest = [m.where, m.how].filter(Boolean).join(' · ');
			if (rest) {
				text.append(m.what ? ` · ${rest}` : rest);
			}
		}
		li.setAttribute('aria-label', `${m.n}. ${dispatchMarkLine(m)}`);
	}
	if (parent) {
		parent.appendChild(ol);
	}
	return ol;
}

// ---------------------------------------------------------------- viewer

export interface IDispatchWhereViewerOptions {
	/** The head's words (default "Where to look"); false for no head (cards). */
	readonly title?: string | false;
	/** A fixed viewport height. Unset: the whole picture at the viewer's width, at most {@link maxHeight}. */
	readonly height?: number;
	/** The most the automatic height grows to (default 400; 520 beside the lines). */
	readonly maxHeight?: number;
	/** Picture left, lines right: true, false, or 'auto' (from 720 wide, default). */
	readonly side?: boolean | 'auto';
	/** The lines: false for none; `max` / `oneLine` as in {@link renderDispatchWhereLegend}. */
	readonly legend?: false | Omit<IDispatchLegendOptions, 'selectable'>;
	/** Start zoomed to this mark (default: the whole picture). */
	readonly selected?: number;
	/** Drag and scroll to look around, click a box to zoom to it (default true). */
	readonly pan?: boolean;
	/**
	 * A mark on another picture of the folder (a delivery page's 00-where.json puts one line on another
	 * screenshot): how to load that picture. Without it such marks stay lines only.
	 */
	readonly pictureUrl?: (image: string) => Promise<string | undefined>;
}

interface IViewState {
	tx: number;
	ty: number;
	k: number;
}

/** Which picture and marks a viewer's `img` shows (Draw and ask on it burns the boxes in first). */
const viewerPictures = new WeakMap<HTMLImageElement, IDispatchMarks>();

/** The picture and marks behind an `img` of a {@link DispatchWhereViewer}. */
export function dispatchWherePictureOf(img: HTMLImageElement): IDispatchMarks | undefined {
	return viewerPictures.get(img);
}

/**
 * 「Where to look」 (`.dispatch-where`), the same as the delivery page's 在哪: the whole picture with
 * every numbered box first (the viewer draws the boxes on a raw screenshot; `drawn` pictures have
 * them already), the numbered lines under it (beside it from 720 wide). A line or a box zooms there
 * in 200 ms, fitting the box whole at most 1:1 (screen points: a Retina capture at half its pixels),
 * with the rest dimmed by the background at 45%; the picked line again, Escape or Whole picture goes
 * back. Drag or scroll to look around. Hovering a line brings its box forward, hovering a box lights
 * its line (DESIGN.md 「联动悬停」).
 *
 * `header` is the head element; put extra buttons (Enlarge, Open in Docs) into it with
 * {@link addHeadAction}. The viewer observes its own size.
 */
export class DispatchWhereViewer extends Disposable {

	readonly element: HTMLElement;
	readonly header: HTMLElement | undefined;
	readonly viewport: HTMLElement;
	readonly legend: HTMLOListElement | undefined;

	private readonly _onDidSelect = this._register(new Emitter<number | undefined>());
	/** A mark was zoomed to (a line, a box, the keyboard); undefined: back to the whole picture. */
	readonly onDidSelect: Event<number | undefined> = this._onDidSelect.event;

	private readonly img: HTMLImageElement;
	private readonly boxes = new Map<number, HTMLElement>();
	private readonly mask: HTMLElement;
	private readonly all: HTMLElement | undefined;
	private current: number | undefined;
	private pan: { x: number; y: number } | undefined;
	private view: IViewState = { tx: 0, ty: 0, k: 1 };
	private natural: [number, number] | undefined;
	/** The other picture shown now (a mark's own `image`); undefined: the JSON's picture. */
	private frame: string | undefined;
	private mainUrl: string | undefined;
	private readonly drag = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		parent: HTMLElement | undefined,
		private readonly picture: IDispatchMarks,
		url: string | undefined,
		private readonly options: IDispatchWhereViewerOptions = {},
	) {
		super();
		const marks = picture.marks;
		this.element = $('.dispatch-where');
		if (options.title !== false) {
			this.header = dom.append(this.element, $('.wh'));
			dom.append(this.header, $('span.t', undefined, options.title ?? localize('dispatchWhere.title', "Where to look")));
			if (marks.length) {
				dom.append(this.header, $('span.cnt', undefined, String(marks.length)));
			}
			dom.append(this.header, $('span.sp'));
			if (marks.length) {
				this.all = this.addHeadAction(localize('dispatchWhere.whole', "Whole picture"), undefined, () => this.showAll());
				this.all.hidden = true;
			}
		}
		this.viewport = dom.append(this.element, $('.vp'));
		this.viewport.classList.toggle('pannable', options.pan !== false);
		this.img = dom.append(this.viewport, $('img', { alt: '', draggable: 'false' })) as HTMLImageElement;
		viewerPictures.set(this.img, picture);
		if (!picture.drawn) {
			for (const m of marks) {
				const b = dom.append(this.viewport, $('i.rb'));
				b.classList.toggle('g', m.color === 'green');
				dom.append(b, $('em.k', { 'aria-hidden': 'true' }, String(m.n)));
				// a mark on another picture shows its box once that picture is up
				b.hidden = this.frameOf(m.n) !== undefined;
				this.boxes.set(m.n, b);
			}
		}
		this.mask = dom.append(this.viewport, $('i.mask'));
		this.mask.hidden = true;
		if (options.legend !== false && marks.length) {
			this.legend = renderDispatchWhereLegend(this.element, marks, { ...(options.legend || {}), selectable: true });
		}
		if (options.height) {
			this.viewport.style.height = `${options.height}px`;
		}
		this.current = marks.find(m => m.n === options.selected)?.n;
		this.markSelected();
		this.wireLegend();
		this.wireViewport();

		const ro = this._register(new dom.DisposableResizeObserver('dispatchWhere', () => this.layout(true), dom.getWindow(this.element)));
		this._register(ro.observe(this.element));
		this._register(dom.addDisposableListener(this.img, 'load', () => {
			this.natural = [this.img.naturalWidth, this.img.naturalHeight];
			if (this.frame === undefined) {
				this.mainUrl = this.img.src;
			}
			this.layout(true);
		}));
		if (url) {
			this.img.src = url;
		}
		if (this.current !== undefined) {
			this.showFrame(this.frameOf(this.current));
		}
		if (parent) {
			parent.appendChild(this.element);
		}
	}

	/** The picture mark `n` is on when it is not the JSON's own (undefined: the JSON's). */
	private frameOf(n: number | undefined): string | undefined {
		const m = n !== undefined ? this.picture.marks.find(x => x.n === n) : undefined;
		return m?.image && m.image !== this.picture.image && this.options.pictureUrl ? m.image : undefined;
	}

	/** Switch the viewport to `frame` (undefined: the JSON's picture); the boxes of the other pictures hide. */
	private showFrame(frame: string | undefined): void {
		if (frame === this.frame) {
			return;
		}
		if (this.frame === undefined && this.img.src) {
			this.mainUrl = this.img.src;
		}
		this.frame = frame;
		this.natural = undefined;
		for (const mk of this.picture.marks) {
			const b = this.boxes.get(mk.n);
			if (b) {
				b.hidden = this.frameOf(mk.n) !== frame;
			}
		}
		const want = frame;
		const load = frame === undefined ? Promise.resolve(this.mainUrl) : this.options.pictureUrl!(frame);
		void load.then(u => {
			if (u && this.frame === want) {
				this.img.src = u;
			}
		});
	}

	/** A small ghost button at the right of the head. */
	addHeadAction(label: string, icon: string | undefined, run: () => void, title?: string): HTMLElement {
		const b = dom.append(this.header ?? this.element, $('button.dispatch-where-ghost', { type: 'button' }));
		if (icon) {
			dom.append(b, $(`span.codicon.codicon-${icon}`));
		}
		dom.append(b, $('span', undefined, label));
		if (title) {
			b.title = title;
		}
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			run();
		}));
		return b;
	}

	/** The mark zoomed to now (undefined: the whole picture). */
	get selected(): number | undefined {
		return this.current;
	}

	/** Zoom to mark `n` (200 ms unless `instant`). */
	select(n: number, instant = false): void {
		if (!this.picture.marks.some(m => m.n === n)) {
			return;
		}
		this.current = n;
		this.pan = undefined;
		this.showFrame(this.frameOf(n));
		this.markSelected();
		this.layout(instant);
		this._onDidSelect.fire(n);
	}

	/** Back to the whole picture with every box. */
	showAll(instant = false): void {
		this.current = undefined;
		this.pan = undefined;
		this.showFrame(undefined);
		this.markSelected();
		this.layout(instant);
		this._onDidSelect.fire(undefined);
	}

	/** Place the picture for the current size (the viewer also observes itself). */
	layout(instant = false): void {
		const side = this.options.side ?? 'auto';
		const wide = side === true || (side === 'auto' && this.element.clientWidth >= 720);
		this.element.classList.toggle('side', wide && !!this.legend);
		const vp = this.viewport;
		const nat = this.frame === undefined ? this.picture.size ?? this.natural : this.natural;
		if (!nat || !vp.clientWidth) {
			return;
		}
		const [iw, ih] = nat;
		// at most 1:1 in screen points
		const max = 1 / dispatchPictureScale(this.picture, iw);
		if (!this.options.height) {
			const w = Math.min(vp.clientWidth, iw * max);
			vp.style.height = `${Math.round(Math.min(w * ih / iw, this.options.maxHeight ?? (wide ? 520 : 400)))}px`;
		}
		const W = vp.clientWidth, H = vp.clientHeight;
		if (!W || !H) {
			return;
		}
		// the whole picture: a tall one (several frames stacked) fits the width and scrolls
		const fit = Math.min(max, ih > iw * 1.2 ? W / iw : Math.min(W / iw, H / ih));
		const m = this.current !== undefined ? this.picture.marks.find(x => x.n === this.current) : undefined;
		let k = fit, tx = 0, ty = 0;
		if (m) {
			const [bx, by, bw, bh] = m.box;
			k = Math.max(fit, Math.min(max, (W - 32) / bw, (H - 32) / bh));
			tx = W / 2 - (bx + bw / 2) * k;
			ty = H / 2 - (by + bh / 2) * k;
		}
		if (this.pan) {
			tx = this.pan.x;
			ty = this.pan.y;
		}
		const sw = iw * k, sh = ih * k;
		tx = sw <= W ? (W - sw) / 2 : Math.min(0, Math.max(W - sw, tx));
		ty = sh <= H ? (H - sh) / 2 : Math.min(0, Math.max(H - sh, ty));
		this.view = { tx, ty, k };
		vp.classList.toggle('instant', instant);
		this.element.classList.toggle('zoomed', !!m);
		if (this.all) {
			this.all.hidden = !m;
		}
		this.img.style.width = `${sw}px`;
		this.img.style.height = `${sh}px`;
		this.img.style.transform = `translate(${tx}px, ${ty}px)`;
		for (const mk of this.picture.marks) {
			const b = this.boxes.get(mk.n);
			if (b && !b.hidden) {
				this.place(b, mk.box[0] * k + tx, mk.box[1] * k + ty, mk.box[2] * k, mk.box[3] * k);
			}
		}
		this.badges(tx, ty, sw, sh);
		this.showMask(m);
		if (instant) {
			// drop the no-transition class after this frame so the next zoom animates
			dom.getWindow(vp).requestAnimationFrame(() => vp.classList.remove('instant'));
		}
	}

	/**
	 * A number sits on its box's top left corner; on a small target (under 24 px on screen) it goes
	 * under or beside the box so it never covers it; one that would cover another number moves on;
	 * it always stays inside the picture (the delivery page's rule), which is at `px`,`py`, `pw`×`ph`
	 * in the viewport.
	 */
	private badges(px: number, py: number, pw: number, ph: number): void {
		const placed: [number, number][] = [];
		const r = 12, o = 14;
		const clampX = (v: number) => Math.max(px + r, Math.min(px + pw - r, v));
		const clampY = (v: number) => Math.max(py + r, Math.min(py + ph - r, v));
		for (const mk of this.picture.marks) {
			const b = this.boxes.get(mk.n);
			const badge = b?.firstElementChild as HTMLElement | null;
			if (!b || !badge || b.hidden) {
				continue;
			}
			const x = parseFloat(b.style.left), y = parseFloat(b.style.top), w = parseFloat(b.style.width), h = parseFloat(b.style.height);
			const small = Math.min(w, h) < 24;
			const spots: [number, number][] = small
				? [[w / 2, h + o], [-o, h / 2], [w / 2, -o], [w + o, h / 2], [-o, h + o], [w + o, h + o]]
				: [[0, 0], [0, h], [w, h], [w, 0], [-o, h / 2], [w / 2, h + o]];
			for (let j = 2; j < 6; j++) {
				spots.push([w / 2, h + o * j * 1.6], [-o * j * 1.6, h / 2]);
			}
			let pick: [number, number] | undefined;
			for (const [sx, sy] of spots) {
				const cx = clampX(x + sx), cy = clampY(y + sy);
				if (!placed.some(p => Math.abs(p[0] - cx) < 22 && Math.abs(p[1] - cy) < 22)) {
					pick = [cx, cy];
					break;
				}
			}
			pick ??= [clampX(x), clampY(y)];
			placed.push(pick);
			badge.style.left = `${pick[0] - x}px`;
			badge.style.top = `${pick[1] - y}px`;
		}
	}

	private place(el: HTMLElement, x: number, y: number, w: number, h: number): void {
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.style.width = `${w}px`;
		el.style.height = `${h}px`;
	}

	/** Dim everything but mark `m`'s box (none: no dimming). */
	private showMask(m: IDispatchMark | undefined): void {
		if (!m) {
			this.mask.hidden = true;
			return;
		}
		const { tx, ty, k } = this.view;
		this.mask.hidden = false;
		this.place(this.mask, m.box[0] * k + tx - 4, m.box[1] * k + ty - 4, m.box[2] * k + 8, m.box[3] * k + 8);
	}

	private markSelected(): void {
		if (!this.legend) {
			return;
		}
		for (const li of this.legend.querySelectorAll<HTMLElement>('li')) {
			const on = Number(li.dataset.n) === this.current;
			li.classList.toggle('on', on);
			li.setAttribute('aria-selected', String(on));
		}
	}

	/** Linked hover: the line and the box of mark `n` light together; on the whole picture its box comes forward. */
	private hoverMark(n: number | undefined): void {
		if (this.legend) {
			for (const li of this.legend.querySelectorAll<HTMLElement>('li')) {
				li.classList.toggle('hover', Number(li.dataset.n) === n);
			}
		}
		for (const [bn, b] of this.boxes) {
			b.classList.toggle('hover', bn === n);
		}
		if (this.current === undefined) {
			this.showMask(n !== undefined && this.frameOf(n) === this.frame ? this.picture.marks.find(x => x.n === n) : undefined);
		}
	}

	private markAt(clientX: number, clientY: number): number | undefined {
		const r = this.viewport.getBoundingClientRect();
		const { tx, ty, k } = this.view;
		const px = (clientX - r.left - tx) / k, py = (clientY - r.top - ty) / k;
		const pad = 8 / k;
		// the smallest box under the point (nested marks: the inner one)
		const hits = this.picture.marks.filter(m => this.frameOf(m.n) === this.frame && px >= m.box[0] - pad && px <= m.box[0] + m.box[2] + pad && py >= m.box[1] - pad && py <= m.box[1] + m.box[3] + pad);
		hits.sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3]);
		return hits[0]?.n;
	}

	private toggle(n: number): void {
		if (this.current === n) {
			this.showAll();
		} else {
			this.select(n);
		}
	}

	private wireLegend(): void {
		const leg = this.legend;
		if (!leg) {
			return;
		}
		const nOf = (e: UIEvent) => {
			const li = (e.target as HTMLElement | null)?.closest?.('li');
			return li instanceof HTMLElement && leg.contains(li) ? Number(li.dataset.n) : undefined;
		};
		this._register(dom.addDisposableListener(leg, dom.EventType.CLICK, e => {
			const n = nOf(e);
			if (n !== undefined) {
				this.toggle(n);
			}
		}));
		this._register(dom.addDisposableListener(leg, dom.EventType.MOUSE_OVER, e => this.hoverMark(nOf(e))));
		this._register(dom.addDisposableListener(leg, dom.EventType.MOUSE_LEAVE, () => this.hoverMark(undefined)));
		this._register(dom.addDisposableListener(leg, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const n = nOf(e);
			if (n === undefined) {
				return;
			}
			const lis = [...leg.querySelectorAll<HTMLElement>('li')];
			const i = lis.findIndex(li => Number(li.dataset.n) === n);
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggle(n);
			} else if (e.key === 'Escape' && this.current !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.showAll();
			} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const j = Math.max(0, Math.min(lis.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
				this.select(Number(lis[j].dataset.n));
				lis[j].focus();
			}
		}));
	}

	private wireViewport(): void {
		const vp = this.viewport;
		const canPan = this.options.pan !== false;
		/** More picture than the viewport shows: dragging and scrolling look around. */
		const overflows = () => {
			const nat = this.frame === undefined ? this.picture.size ?? this.natural : this.natural;
			return !!nat && (nat[0] * this.view.k > vp.clientWidth + 1 || nat[1] * this.view.k > vp.clientHeight + 1);
		};
		this._register(dom.addDisposableListener(vp, dom.EventType.MOUSE_MOVE, (e: MouseEvent) => {
			if (!vp.classList.contains('dragging')) {
				const n = this.markAt(e.clientX, e.clientY);
				vp.classList.toggle('on-box', canPan && n !== undefined && n !== this.current);
				this.hoverMark(n);
			}
		}));
		this._register(dom.addDisposableListener(vp, dom.EventType.MOUSE_LEAVE, () => this.hoverMark(undefined)));
		if (!canPan) {
			return;
		}
		this._register(dom.addDisposableListener(vp, dom.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (!overflows()) {
				return;
			}
			const before = { x: this.view.tx, y: this.view.ty };
			this.pan = { x: before.x - e.deltaX, y: before.y - e.deltaY };
			this.layout(true);
			if (this.view.tx !== before.x || this.view.ty !== before.y) {
				e.preventDefault();
				e.stopPropagation();
			}
		}, { passive: false }));
		this._register(dom.addDisposableListener(vp, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			const start = { x: this.view.tx, y: this.view.ty };
			const x0 = e.clientX, y0 = e.clientY;
			let moved = false;
			const store = new DisposableStore();
			vp.setPointerCapture(e.pointerId);
			store.add(dom.addDisposableListener(vp, dom.EventType.POINTER_MOVE, (m: PointerEvent) => {
				const dx = m.clientX - x0, dy = m.clientY - y0;
				if (!moved && Math.abs(dx) + Math.abs(dy) > 3 && overflows()) {
					moved = true;
					vp.classList.add('dragging');
					this.hoverMark(undefined);
				}
				if (moved) {
					this.pan = { x: start.x + dx, y: start.y + dy };
					this.layout(true);
				}
			}));
			const end = (u: PointerEvent) => {
				this.drag.clear();
				vp.classList.remove('dragging');
				if (!moved) {
					const n = this.markAt(u.clientX, u.clientY);
					if (n !== undefined && n !== this.current) {
						this.select(n);
					} else if (n === undefined && this.current === undefined && this.picture.marks.length) {
						// a click beside the boxes on the whole picture zooms to the first one
						this.select(this.picture.marks[0].n);
					}
				}
			};
			store.add(dom.addDisposableListener(vp, dom.EventType.POINTER_UP, end));
			store.add(dom.addDisposableListener(vp, 'pointercancel', end));
			this.drag.value = store;
		}));
	}
}

// ---------------------------------------------------------------- snippet card

export interface IDispatchWhereCardAction {
	readonly label: string;
	/** A codicon id shown after the label (e.g. 'arrow-right'). */
	readonly icon?: string;
	/** Left of the gap (default right). */
	readonly start?: boolean;
	readonly run: () => void;
}

export interface IDispatchWhereCardOptions {
	readonly title: string;
	/** One line under the title (12, secondary). */
	readonly subtitle?: string;
	/** `picture` (default): viewport, then title (What's new); `text`: title, then viewport (a delivery). */
	readonly order?: 'picture' | 'text';
	/** The mark in the viewport (default the first). */
	readonly mark?: number;
	/** Numbered lines under the viewport, one line each (default none). */
	readonly lines?: number;
	readonly actions?: readonly IDispatchWhereCardAction[];
	/** A fixed viewport height; 0 for none (the words alone). Default: the picture's own shape, at most 150. */
	readonly height?: number;
	/** Drop the card's own surface (inside a hover widget that already draws one). */
	readonly bare?: boolean;
	/** As the viewer's: loads a mark's own picture. */
	readonly pictureUrl?: (image: string) => Promise<string | undefined>;
}

/**
 * The snippet card (`.dispatch-where-card`, 320 wide): what a hover shows about one annotated
 * picture. What's new: picture first, the feature's name and one line, Got it / Show me. A task's
 * deliverable: the note's title and "Delivered … · N places", the picture, three lines, Open in Docs.
 */
export class DispatchWhereCard extends Disposable {

	readonly element: HTMLElement;
	readonly viewer: DispatchWhereViewer;

	constructor(picture: IDispatchMarks, url: string | undefined, options: IDispatchWhereCardOptions) {
		super();
		this.element = $('.dispatch-where-card');
		this.element.classList.toggle('bare', !!options.bare);
		const text = $('.hh');
		dom.append(text, $('.ht', undefined, options.title));
		if (options.subtitle) {
			dom.append(text, $('.hs', undefined, options.subtitle));
		}
		this.viewer = this._register(new DispatchWhereViewer(undefined, picture, url, {
			title: false,
			// as tall as the picture is at the card's width, at most 150: a strip is not letterboxed
			height: options.height,
			maxHeight: 150,
			side: false,
			// the card shows its one spot: zoomed to the mark (default the first)
			selected: options.mark ?? picture.marks[0]?.n,
			legend: options.lines ? { max: options.lines, oneLine: true } : false,
			pan: false,
			pictureUrl: options.pictureUrl,
		}));
		if (options.height === 0) {
			// no picture: the words alone
			this.viewer.viewport.hidden = true;
		}
		if (options.order === 'text') {
			this.element.append(text, this.viewer.element);
		} else {
			this.element.append(this.viewer.element, text);
		}
		if (options.actions?.length) {
			const foot = dom.append(this.element, $('.hf'));
			const startActs = options.actions.filter(a => a.start);
			const endActs = options.actions.filter(a => !a.start);
			for (const a of startActs) {
				this.button(foot, a);
			}
			dom.append(foot, $('span.sp'));
			for (const a of endActs) {
				this.button(foot, a);
			}
		}
		this._register(toDisposable(() => this.element.remove()));
	}

	private button(parent: HTMLElement, a: IDispatchWhereCardAction): void {
		const b = dom.append(parent, $('button.dispatch-where-ghost', { type: 'button' }));
		dom.append(b, $('span', undefined, a.label));
		if (a.icon) {
			dom.append(b, $(`span.codicon.codicon-${a.icon}`));
		}
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			a.run();
		}));
	}
}

/** The same viewer in an attached detail: use the available side, never enlarge past 1:1. */
export function setupDispatchPictureDetail(card: HTMLElement, row: HTMLElement, picture: IDispatchMarks, mark: number | undefined, title: string, pictureUrl: (image: string) => Promise<string | undefined>, store: DisposableStore, action?: IDispatchWhereCardAction): void {
	setupDispatchRowDetail(card, row, detailStore => {
		const root = $('.dispatch-hover-card.dispatch-picture-detail');
		const m = picture.marks.find(x => x.n === mark);
		const scale = dispatchPictureScale(picture);
		const width = Math.max(320, ((m?.box[2] ?? picture.size?.[0] ?? 1280) + 96) / scale + 32);
		root.dataset.detailWidth = String(width);
		const head = dom.append(root, $('.dispatch-picture-detail-head'));
		dom.append(head, $('span', undefined, title));
		const ratio = dom.append(head, $('span.dispatch-detail-meta'));
		const height = Math.min(dom.getWindow(card).innerHeight - 160, Math.max(120, ((m?.box[3] ?? picture.size?.[1] ?? 720) + 96) / scale));
		const viewer = detailStore.add(new DispatchWhereViewer(root, picture, undefined, { title: false, selected: mark, legend: false, side: false, height, pictureUrl }));
		const updateRatio = () => {
			const img = viewer.viewport.querySelector('img');
			if (img?.naturalWidth) {
				const zoom = parseFloat(img.style.width) / img.naturalWidth * dispatchPictureScale(picture, img.naturalWidth);
				ratio.textContent = zoom >= .995 ? '1:1' : `${Math.round(zoom * 100)}%`;
			}
		};
		const observer = new ResizeObserver(updateRatio);
		observer.observe(viewer.viewport);
		detailStore.add(toDisposable(() => observer.disconnect()));
		void pictureUrl(m?.image || picture.image).then(url => {
			if (!url || detailStore.isDisposed) { return; }
			const img = viewer.viewport.querySelector('img');
			if (img) { detailStore.add(dom.addDisposableListener(img, 'load', () => { viewer.layout(true); updateRatio(); })); img.src = url; }
		});
		const bar = dom.append(root, $('.dispatch-hover-actions'));
		const whole = dom.append(bar, $('button.dispatch-detail-btn.ghost', { type: 'button' }, 'Whole picture'));
		detailStore.add(dom.addDisposableListener(whole, 'click', () => { viewer.showAll(); updateRatio(); }));
		if (action) {
			dom.append(bar, $('span.dispatch-hover-sp'));
			const open = dom.append(bar, $('button.dispatch-detail-btn.primary', { type: 'button' }, action.label));
			detailStore.add(dom.addDisposableListener(open, 'click', () => action.run()));
		}
		return root;
	}, store, { image: true });
}
