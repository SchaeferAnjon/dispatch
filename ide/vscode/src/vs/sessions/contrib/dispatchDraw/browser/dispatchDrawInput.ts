/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a picture in the chat input (kanban design/annotations/redesign 第 4 节,
 *  patches/320-draw-and-ask.patch).
 *
 *  - The picture is a thumbnail, not a name pill: 72×48 with a pen at its bottom right corner and ×
 *    at the top right on hover; once it has boxes, 144×96 cropped to them with one line per box
 *    beside it. Only pictures get the pen; files and selections stay pills.
 *  - The pen (or a click on the thumbnail) opens the draw tool in place: the input box grows in
 *    280 ms, the tool takes the attachment row's place above the text, the conversation moves up.
 *    Done (or Enter on the last line, or sending) burns the boxes into the picture and puts their
 *    coordinates and lines into the attachment (`_meta` 'dispatch.marks'); Cancel leaves it as it
 *    was. Drawing again starts from the original picture with the boxes still editable.
 *  - Both inputs: a running session's (the workbench chat input, through the picture hooks) and
 *    the new-session composer's (newChatContextAttachments.ts).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { DispatchMarksMetadataKey, IDispatchMarksMetadata, readDispatchMarksMeta } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { coerceImageBuffer } from '../../../../workbench/contrib/chat/common/chatImageExtraction.js';
import { dispatchPictureSize, DispatchThumbSize, IDispatchMark, renderDispatchWhereLegend, renderDispatchWhereThumb } from '../../dispatchCommon/browser/dispatchWhere.js';
import { burnDispatchMarks, DispatchDrawTool, IDispatchDrawMark } from './dispatchDrawTool.js';

const $ = dom.$;

// ---------------------------------------------------------------- pictures of attachments

/** The original of an annotated attachment, to draw on it again (this window, in memory). */
interface IOriginal {
	readonly bytes: Uint8Array;
	readonly mime: string;
	readonly size: [number, number];
	readonly scale?: number;
}
const originals = new Map<string, IOriginal>();

/** Remember the unmarked picture behind an annotated attachment (the side pane's pictures come in marked). */
export function rememberDispatchOriginal(id: string, original: IOriginal): void {
	originals.set(id, original);
	while (originals.size > 64) {
		originals.delete(originals.keys().next().value!);
	}
}

function sniffMime(bytes: Uint8Array, fallback = 'image/png'): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) {
		return 'image/png';
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		return 'image/jpeg';
	}
	if (bytes[0] === 0x47 && bytes[1] === 0x49) {
		return 'image/gif';
	}
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
		return 'image/webp';
	}
	return fallback;
}

/** A blob URL for picture bytes, revoked with the returned disposable. */
export function dispatchBlobUrl(bytes: Uint8Array, mime?: string): { url: string; dispose(): void } {
	const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? sniffMime(bytes) }));
	return { url, dispose: () => URL.revokeObjectURL(url) };
}

/** The bytes of an image attachment: its value, or the file it points at after a reload. */
export async function dispatchAttachmentBytes(fileService: IFileService, entry: IChatRequestVariableEntry): Promise<Uint8Array | undefined> {
	const bytes = coerceImageBuffer(entry.value);
	if (bytes) {
		return bytes;
	}
	const uri = URI.isUri(entry.value) ? entry.value : undefined;
	if (uri) {
		try {
			return (await fileService.readFile(uri)).value.buffer;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function marksOf(meta: IDispatchMarksMetadata): IDispatchMark[] {
	return meta.marks.map(m => ({ n: m.n, box: m.box, color: m.color, note: m.note ?? '' }));
}

// ---------------------------------------------------------------- the tile

export interface IDispatchTileActions {
	/** Open the draw tool on this picture. */
	readonly draw: () => void;
	/** Remove the attachment (the composer draws its own ×; the workbench keeps its button). */
	readonly remove?: () => void;
}

/**
 * Turn an image attachment element into the tile: thumbnail, pen, (annotated) numbered lines. The
 * element keeps its own children (hidden by CSS) so the chat's hover, open and remove still work.
 */
export function renderDispatchImageTile(element: HTMLElement, entry: IChatRequestVariableEntry, bytes: Uint8Array, actions: IDispatchTileActions | undefined): IDisposable {
	const store = new DisposableStore();
	const meta = readDispatchMarksMeta(entry);
	const blob = dispatchBlobUrl(bytes, (entry as { mimeType?: string }).mimeType);
	store.add(blob);
	element.classList.add('dispatch-draw-tile');
	element.classList.toggle('annotated', !!meta);
	const tile = $('.dispatch-draw-thumbwrap');
	// an annotated attachment is the picture with its boxes burned in
	const thumb = renderDispatchWhereThumb(blob.url, meta ? { size: meta.size, marks: marksOf(meta), drawn: true } : undefined, {
		size: meta ? DispatchThumbSize.message : DispatchThumbSize.attachment,
		fit: meta ? 'marks' : 'full',
	});
	tile.appendChild(thumb);
	element.prepend(tile);
	store.add(toDisposable(() => {
		tile.remove();
		element.classList.remove('dispatch-draw-tile', 'annotated');
	}));
	if (actions) {
		const title = localize('dispatchDraw.annotate', "Draw and ask");
		thumb.title = title;
		thumb.setAttribute('role', 'button');
		const pen = dom.append(tile, $('button.dispatch-draw-pen', { type: 'button', title, 'aria-label': title }));
		dom.append(pen, $('span.codicon.codicon-edit'));
		const open = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			actions.draw();
		};
		store.add(dom.addDisposableListener(pen, dom.EventType.CLICK, open));
		store.add(dom.addDisposableListener(thumb, dom.EventType.CLICK, open));
		// the chat's own open handler would take the click on the tile otherwise
		store.add(dom.addDisposableListener(tile, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));
		// the chat's own remove button moves onto the thumbnail's corner (and back when the tile goes)
		const clear = element.querySelector<HTMLElement>(':scope > .monaco-button');
		if (clear && !actions.remove) {
			tile.appendChild(clear);
			store.add(toDisposable(() => element.appendChild(clear)));
		}
		if (actions.remove) {
			const rmTitle = localize('dispatchDraw.removePicture', "Remove");
			const rm = dom.append(tile, $('button.dispatch-draw-rm', { type: 'button', title: rmTitle, 'aria-label': rmTitle }));
			dom.append(rm, $('span.codicon.codicon-close'));
			store.add(dom.addDisposableListener(rm, dom.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				actions.remove!();
			}));
		}
	}
	if (meta) {
		const leg = renderDispatchWhereLegend(element, marksOf(meta), { max: 4, oneLine: true });
		leg.classList.add('dispatch-draw-tile-lines');
		store.add(toDisposable(() => leg.remove()));
	}
	return store;
}

// ---------------------------------------------------------------- drawing in the input

/** Where a drawing opens: an input box and the attachments it shows. */
export interface IDispatchDrawInputHost {
	/** The input box; the tool opens at its top. */
	readonly box: HTMLElement;
	/** The attachment row, hidden while drawing (the tool takes its place). */
	readonly row: HTMLElement | undefined;
	entries(): readonly IChatRequestVariableEntry[];
	replace(oldId: string, entry: IChatRequestVariableEntry): void;
	focus(): void;
}

let markedSerial = 0;

class OpenDrawing extends Disposable {

	readonly slot: HTMLElement;
	private readonly tool: DispatchDrawTool;
	private settled = false;

	constructor(
		readonly host: IDispatchDrawInputHost,
		private readonly entry: IChatRequestVariableEntry,
		private readonly original: IOriginal,
		private readonly url: string,
		/** False when the original is gone (a reloaded window): the boxes are already in the picture. */
		editable: boolean,
		private readonly onClose: (d: OpenDrawing) => void,
		private readonly logService: ILogService,
	) {
		super();
		const meta = editable ? readDispatchMarksMeta(entry) : undefined;
		const win = dom.getWindow(host.box);
		this.slot = $('.dispatch-draw-slot');
		const inner = dom.append(this.slot, $('.inner'));
		this.tool = this._register(new DispatchDrawTool({ url, size: original.size, scale: original.scale }, {
			fit: 'width',
			marks: meta ? marksOf(meta) : undefined,
			color: meta?.marks[0]?.color ?? 'red',
			accept: localize('dispatchDraw.doneButton', "Done"),
			maxHeight: Math.max(220, Math.min(460, Math.round(win.innerHeight * 0.46))),
		}));
		inner.appendChild(this.tool.element);
		this._register(this.tool.onDidAccept(() => void this.commit()));
		this._register(this.tool.onDidCancel(() => this.cancel()));
		host.box.classList.add('dispatch-drawing');
		host.box.prepend(this.slot);
		this.tool.layout();
		// grow in place (grid rows 0fr -> 1fr, 280 ms), then put the cursor on the picture
		win.requestAnimationFrame(() => {
			this.slot.classList.add('open');
			this.tool.focus();
		});
	}

	/** Dispose `d` with the drawing. */
	keep(d: IDisposable): void {
		this._register(d);
	}

	/** Done: burn the boxes in and swap the attachment (none left: back to the original). */
	async commit(): Promise<void> {
		if (this.settled) {
			return;
		}
		this.settled = true;
		const marks: IDispatchDrawMark[] = this.tool.getMarks();
		try {
			const replacement = marks.length ? await this.marked(marks) : this.unmarked();
			if (replacement) {
				this.host.replace(this.entry.id, replacement);
			}
		} catch (e) {
			this.logService.error('[dispatch] draw: could not burn the boxes into the picture', e);
		}
		this.close();
	}

	cancel(): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.close();
	}

	private async marked(marks: IDispatchDrawMark[]): Promise<IChatRequestVariableEntry> {
		const bytes = await burnDispatchMarks({ url: this.url, size: this.original.size, scale: this.original.scale }, marks);
		const old = readDispatchMarksMeta(this.entry);
		const meta: IDispatchMarksMetadata = {
			v: 1,
			size: this.original.size,
			scale: this.original.scale,
			marks: marks.map(m => ({ n: m.n, box: m.box, color: m.color ?? 'red', note: (m.note ?? '').trim() || undefined })),
			source: old?.source,
			page: old?.page,
			elements: old?.elements?.filter(e => marks.some(m => m.n === e.n)),
		};
		const base = this.entry.id.replace(/#dispatch-marked-\d+$/, '');
		const id = `${base}#dispatch-marked-${++markedSerial}`;
		rememberDispatchOriginal(id, this.original);
		return {
			...this.entry,
			id,
			value: bytes,
			mimeType: 'image/png',
			references: undefined,
			_meta: { ...(this.entry._meta ?? {}), [DispatchMarksMetadataKey]: meta },
		} as IChatRequestVariableEntry;
	}

	private unmarked(): IChatRequestVariableEntry | undefined {
		if (!readDispatchMarksMeta(this.entry)) {
			return undefined;
		}
		const meta = { ...(this.entry._meta ?? {}) };
		delete meta[DispatchMarksMetadataKey];
		return {
			...this.entry,
			id: this.entry.id.replace(/#dispatch-marked-\d+$/, ''),
			value: this.original.bytes,
			mimeType: this.original.mime,
			_meta: Object.keys(meta).length ? meta : undefined,
		} as IChatRequestVariableEntry;
	}

	private close(): void {
		const box = this.host.box;
		this.slot.classList.remove('open');
		const done = () => {
			this.slot.remove();
			box.classList.remove('dispatch-drawing');
			this.dispose();
		};
		// shrink back in 280 ms (no motion: at once)
		const reduce = dom.getWindow(box).matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduce) {
			done();
		} else {
			const t = setTimeout(done, 300);
			this.slot.addEventListener('transitionend', () => { clearTimeout(t); done(); }, { once: true });
		}
		this.onClose(this);
		this.host.focus();
	}
}

let currentController: DispatchDrawInputController | undefined;

/** This window's controller (set by dispatchDraw.contribution.ts). */
export function dispatchDrawInputController(): DispatchDrawInputController | undefined {
	return currentController;
}

export function setDispatchDrawInputController(controller: DispatchDrawInputController): IDisposable {
	currentController = controller;
	return toDisposable(() => {
		if (currentController === controller) {
			currentController = undefined;
		}
	});
}

/**
 * The drawings open in this window's inputs, one per input box. {@link flush} commits the one in a
 * box before its message goes out, so sending while drawing sends the boxes.
 */
export class DispatchDrawInputController extends Disposable {

	private readonly open = new Map<HTMLElement, OpenDrawing>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const d of this.open.values()) {
				d.dispose();
			}
			this.open.clear();
		}));
	}

	isDrawing(box: HTMLElement): boolean {
		return this.open.has(box);
	}

	/** Open the draw tool on attachment `id` of `host` (a second click on the pen closes it). */
	async openFor(host: IDispatchDrawInputHost, id: string): Promise<void> {
		const current = this.open.get(host.box);
		if (current) {
			await current.commit();
			return;
		}
		const entry = host.entries().find(e => e.id === id);
		if (!entry || entry.kind !== 'image') {
			return;
		}
		const original = await this.originalOf(entry);
		if (!original) {
			this.logService.warn('[dispatch] draw: no bytes for the picture', entry.id);
			return;
		}
		if (this.open.has(host.box)) {
			return;
		}
		const blob = dispatchBlobUrl(original.bytes, original.mime);
		const drawing = new OpenDrawing(host, entry, original, blob.url, originals.has(entry.id), d => {
			if (this.open.get(d.host.box) === d) {
				this.open.delete(d.host.box);
			}
		}, this.logService);
		drawing.keep(blob);
		this.open.set(host.box, drawing);
	}

	/** Commit the drawing open in `box` (or in any input when undefined). */
	async flush(box?: HTMLElement): Promise<void> {
		const list = box ? [this.open.get(box)].filter((d): d is OpenDrawing => !!d) : [...this.open.values()];
		await Promise.all(list.map(d => d.commit()));
	}

	private async originalOf(entry: IChatRequestVariableEntry): Promise<IOriginal | undefined> {
		const kept = originals.get(entry.id);
		if (kept) {
			return kept;
		}
		const bytes = await dispatchAttachmentBytes(this.fileService, entry);
		if (!bytes) {
			return undefined;
		}
		const mime = sniffMime(bytes, (entry as { mimeType?: string }).mimeType);
		const blob = dispatchBlobUrl(bytes, mime);
		try {
			const size = await dispatchPictureSize(blob.url);
			if (!size) {
				return undefined;
			}
			// a picture that already carries boxes but lost its original (reloaded): draw over it
			return { bytes, mime, size };
		} finally {
			blob.dispose();
		}
	}
}
