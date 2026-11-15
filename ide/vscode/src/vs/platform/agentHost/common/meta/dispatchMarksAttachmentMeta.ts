/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: boxes a person drew on a picture before sending it (kanban design/annotations/
 *  redesign 第 4 节「截图上画框当输入」; patches/320-draw-and-ask.patch).
 *
 *  The picture itself already has the boxes and numbers burned in. What rides along in the image
 *  attachment's `_meta` under {@link DispatchMarksMetadataKey} is the same thing as data: each
 *  box in picture pixels, its colour and the one line written under it, plus where the picture came
 *  from and, for a web page, the element each box snapped to. The chat renders the sent message's
 *  numbered lines from it; the Claude and Codex harnesses put {@link renderDispatchMarksText} right
 *  after the picture so the agent reads the coordinates and the sentences next to the image.
 *--------------------------------------------------------------------------------------------*/

export const DispatchMarksMetadataKey = 'dispatch.marks';

export type DispatchMarksColor = 'red' | 'green';

export interface IDispatchMarksMetaMark {
	readonly n: number;
	/** x, y, width, height in picture pixels, origin top left. */
	readonly box: readonly [number, number, number, number];
	readonly color: DispatchMarksColor;
	readonly note?: string;
}

/** The page element a box snapped to (drawn on a page in the integrated browser). */
export interface IDispatchMarksMetaElement {
	readonly n: number;
	/** e.g. `button.tab#graph` */
	readonly selector: string;
	/** Width and height in page CSS pixels. */
	readonly size: readonly [number, number];
	/** Trimmed outer HTML. */
	readonly html?: string;
	/** A few computed style properties. */
	readonly style?: string;
	/** Its text, trimmed. */
	readonly text?: string;
	/** Ancestors, `html > body > main > button.tab`. */
	readonly path?: string;
}

export interface IDispatchMarksMetadata {
	readonly v: 1;
	/** The picture's size in pixels. */
	readonly size: readonly [number, number];
	/** Picture pixels per screen point, when known (2 for a Retina capture). */
	readonly scale?: number;
	readonly marks: readonly IDispatchMarksMetaMark[];
	/** Where the picture came from, for the Source line (a document, a file, a page). */
	readonly source?: string;
	/** Drawn on a page: its URL and viewport (the picture is that viewport). */
	readonly page?: { readonly url: string; readonly viewport: readonly [number, number] };
	readonly elements?: readonly IDispatchMarksMetaElement[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBox(v: unknown): v is [number, number, number, number] {
	return Array.isArray(v) && v.length === 4 && v.every(x => typeof x === 'number' && isFinite(x));
}

function isPair(v: unknown): v is [number, number] {
	return Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && isFinite(x));
}

/** The marks an attachment carries, or undefined. */
export function readDispatchMarksMeta(attachment: { readonly _meta?: Record<string, unknown> } | undefined): IDispatchMarksMetadata | undefined {
	const raw = attachment?._meta?.[DispatchMarksMetadataKey];
	if (!isRecord(raw) || !isPair(raw.size) || !Array.isArray(raw.marks)) {
		return undefined;
	}
	const marks: IDispatchMarksMetaMark[] = [];
	for (const m of raw.marks) {
		if (isRecord(m) && typeof m.n === 'number' && isBox(m.box)) {
			marks.push({ n: m.n, box: m.box, color: m.color === 'green' ? 'green' : 'red', note: typeof m.note === 'string' ? m.note : undefined });
		}
	}
	if (!marks.length) {
		return undefined;
	}
	const elements: IDispatchMarksMetaElement[] = [];
	if (Array.isArray(raw.elements)) {
		for (const e of raw.elements) {
			if (isRecord(e) && typeof e.n === 'number' && typeof e.selector === 'string' && isPair(e.size)) {
				elements.push({
					n: e.n, selector: e.selector, size: e.size,
					html: typeof e.html === 'string' ? e.html : undefined,
					style: typeof e.style === 'string' ? e.style : undefined,
					text: typeof e.text === 'string' ? e.text : undefined,
					path: typeof e.path === 'string' ? e.path : undefined,
				});
			}
		}
	}
	const page = isRecord(raw.page) && typeof raw.page.url === 'string' && isPair(raw.page.viewport) ? { url: raw.page.url, viewport: raw.page.viewport } : undefined;
	return {
		v: 1,
		size: raw.size,
		scale: typeof raw.scale === 'number' && raw.scale > 0 ? raw.scale : undefined,
		marks,
		source: typeof raw.source === 'string' && raw.source ? raw.source : undefined,
		page,
		elements: elements.length ? elements : undefined,
	};
}

export function toDispatchMarksMeta(meta: IDispatchMarksMetadata): Record<string, unknown> {
	return { [DispatchMarksMetadataKey]: meta };
}

/** First line of {@link renderDispatchMarksText}; a replayed transcript is recognised by it. */
export const DISPATCH_MARKS_TEXT_PREFIX = 'Marks on image ';

/**
 * The text the agent gets right after the picture (kanban design/annotations/redesign 第 4 节):
 *
 *     Marks on image 1 (1620×1258 px, origin top-left, x y w h):
 *     1 red   26 72 372 66   这个开关改成和上面页签一样的方角
 *     2 green 1432 72 156 66  Graph 按钮保持不动
 *
 * then, from a page, what each box snapped to, the page, and a Source line.
 */
export function renderDispatchMarksText(meta: IDispatchMarksMetadata, index = 1): string {
	const lines: string[] = [];
	lines.push(`${DISPATCH_MARKS_TEXT_PREFIX}${index} (${Math.round(meta.size[0])}×${Math.round(meta.size[1])} px, origin top-left, x y w h):`);
	const rows = meta.marks.map(m => [String(m.n), m.color, m.box.map(v => String(Math.round(v))).join(' '), (m.note ?? '').trim()]);
	const w0 = Math.max(1, ...rows.map(r => r[0].length));
	const w1 = Math.max(1, ...rows.map(r => r[1].length));
	const w2 = Math.max(1, ...rows.map(r => r[2].length));
	const indent = ' '.repeat(w0 + 1);
	rows.forEach((r, i) => {
		lines.push(`${r[0].padEnd(w0)} ${r[1].padEnd(w1)} ${r[2].padEnd(w2)}  ${r[3] || '(no note)'}`);
		const el = meta.elements?.find(e => e.n === meta.marks[i].n);
		if (el) {
			lines.push(`${indent}element: ${el.selector}, ${Math.round(el.size[0])}×${Math.round(el.size[1])} CSS px${el.text ? `, text "${el.text}"` : ''}`);
			if (el.path) {
				lines.push(`${indent}path: ${el.path}`);
			}
			if (el.html) {
				lines.push(`${indent}html: ${el.html}`);
			}
			if (el.style) {
				lines.push(`${indent}style: ${el.style}`);
			}
		}
	});
	if (meta.page) {
		lines.push(`Page: ${meta.page.url} (the image is its ${Math.round(meta.page.viewport[0])}×${Math.round(meta.page.viewport[1])} CSS px viewport)`);
	}
	if (meta.source) {
		lines.push(`Source: ${meta.source}`);
	}
	return lines.join('\n');
}
