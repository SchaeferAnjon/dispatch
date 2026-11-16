/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a sent Point and talk message (task-0y0km; kanban design/screen-talk A3 and A4, one component for
 *  both directions).
 *
 *  Above the bubble the keyframes in time order (the draw-and-ask tile: a crop round the red box, the number and
 *  when its sentence starts), then the video ("Screen recording 0:15"), then the bubble: one line per sentence, its
 *  time at the front is the time line. A frame or a number opens Where to look right under the message: the picture
 *  with its numbered box, the numbered lines under it, a line switches the picture; pointing at a line lights its
 *  frame. The agent's "look at 2" is the frame numbered 2 here.
 *
 *  What is drawn comes from the recording's folder (take.json and the spots' own pictures, so the boxes stay sharp
 *  lines); when it is gone, from the message itself: its text has the lines, its pictures have the boxes burned in.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { readDispatchMarksMeta } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { IDispatchChatImageAttachmentContext, IDispatchChatRequestContext } from '../../../../workbench/contrib/chat/browser/attachments/dispatchChatPictureHooks.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { DispatchThumbSize, renderDispatchWhereThumb } from '../../dispatchCommon/browser/dispatchWhere.js';
import { dispatchAttachmentBytes, dispatchBlobUrl } from '../../dispatchDraw/browser/dispatchDrawInput.js';
import { clock, ILine, IPointTalkText, parseMessage } from '../common/dispatchPointTalkModel.js';

const $ = dom.$;

/** The `_meta` key on a keyframe attachment: its number, time and the recording's folder. */
export const POINT_TALK_FRAME_META = 'dispatch.pointTalk';

export interface IPointTalkFrameMeta {
	readonly n: number;
	readonly t: number;
	readonly folder: string;
}

export function readPointTalkFrameMeta(entry: { readonly _meta?: Record<string, unknown> } | undefined): IPointTalkFrameMeta | undefined {
	const raw = entry?._meta?.[POINT_TALK_FRAME_META];
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	return typeof r.n === 'number' && typeof r.t === 'number' && typeof r.folder === 'string' ? { n: r.n, t: r.t, folder: r.folder } : undefined;
}

/** What take.json keeps of each frame (the box in the spot picture's pixels). */
export interface IPointTalkSavedFrame {
	readonly n: number;
	readonly t: number;
	readonly file: string;
	readonly size: [number, number];
	readonly box: [number, number, number, number];
}

export interface IPointTalkSavedTake {
	readonly v: 1;
	readonly duration: number;
	readonly video: string;
	readonly frames: IPointTalkSavedFrame[];
	readonly lines: ILine[];
}

interface IShownFrame {
	readonly n: number;
	readonly t: number;
	readonly url: string;
	readonly size: readonly [number, number];
	readonly box: readonly [number, number, number, number];
	/** The box is in the picture already (the attachment sent to the agent): draw no outline. */
	readonly drawn: boolean;
}

export async function readSavedTake(fileService: IFileService, folder: string): Promise<IPointTalkSavedTake | undefined> {
	if (!folder) {
		return undefined;
	}
	try {
		const raw = JSON.parse((await fileService.readFile(joinPath(URI.file(folder), 'take.json'))).value.toString());
		return raw && raw.v === 1 && Array.isArray(raw.frames) && Array.isArray(raw.lines) ? raw as IPointTalkSavedTake : undefined;
	} catch {
		return undefined;
	}
}

/** The sent message's parts, decorated by the chat's picture hooks (contrib/dispatchDraw shares them). */
export class PointTalkMessages extends Disposable {

	/** Blob URLs of spot pictures, by file. */
	private readonly urls = new Map<string, Promise<string | undefined>>();

	constructor(private readonly fileService: IFileService, private readonly openVideo: (path: string) => void) {
		super();
		this._register(toDisposable(() => {
			for (const p of this.urls.values()) {
				void p.then(u => u && URL.revokeObjectURL(u));
			}
			this.urls.clear();
		}));
	}

	private pictureUrl(path: string): Promise<string | undefined> {
		let p = this.urls.get(path);
		if (!p) {
			p = this.fileService.readFile(URI.file(path)).then(c => dispatchBlobUrl(c.value.buffer, 'image/png').url, () => undefined);
			this.urls.set(path, p);
		}
		return p;
	}

	/** A sent keyframe: the 144×96 crop with its number and time; in the box: hidden (the box draws its own). */
	decorateImage(ctx: IDispatchChatImageAttachmentContext): IDisposable | undefined {
		const meta = readPointTalkFrameMeta(ctx.attachment);
		if (!meta) {
			return undefined;
		}
		if (ctx.isCurrentInput) {
			ctx.element.classList.add('dispatch-pt-hidden');
			return toDisposable(() => ctx.element.classList.remove('dispatch-pt-hidden'));
		}
		const store = new DisposableStore();
		ctx.element.classList.add('dispatch-pt-sent');
		ctx.element.dataset.ptN = String(meta.n);
		const tile = $('.pt-th', { 'data-n': String(meta.n) });
		ctx.element.prepend(tile);
		store.add(toDisposable(() => {
			tile.remove();
			ctx.element.classList.remove('dispatch-pt-sent');
			delete ctx.element.dataset.ptN;
		}));
		void this.frameOf(ctx.attachment, meta).then(f => {
			if (!f || store.isDisposed) {
				return;
			}
			tile.appendChild(renderDispatchWhereThumb(f.url, { size: f.size, marks: [{ n: f.n, box: f.box, color: 'red' }], drawn: f.drawn }, { size: DispatchThumbSize.message, fit: 'marks', title: localize('dispatchPointTalk.whereTip', "See where you pointed") }));
			const lab = dom.append(tile, $('span.pt-lab'));
			dom.append(lab, $('span.pt-nd', undefined, String(f.n)));
			dom.append(lab, $('span', undefined, clock(f.t)));
		});
		return store;
	}

	/** The frame of a sent attachment: the spot's own picture from the folder when it is there, else the sent one. */
	private async frameOf(entry: IChatRequestVariableEntry, meta: IPointTalkFrameMeta): Promise<IShownFrame | undefined> {
		const saved = (await readSavedTake(this.fileService, meta.folder))?.frames.find(f => f.n === meta.n);
		if (saved) {
			const url = await this.pictureUrl(joinPath(URI.file(meta.folder), saved.file).fsPath);
			if (url) {
				return { n: meta.n, t: meta.t, url, size: saved.size, box: saved.box, drawn: false };
			}
		}
		const marks = readDispatchMarksMeta(entry);
		const bytes = await dispatchAttachmentBytes(this.fileService, entry);
		const box = marks?.marks.find(m => m.n === meta.n)?.box ?? marks?.marks[0]?.box;
		if (!bytes || !marks || !box) {
			return undefined;
		}
		return { n: meta.n, t: meta.t, url: dispatchBlobUrl(bytes, 'image/png').url, size: marks.size, box, drawn: true };
	}

	/** The bubble: the lines with their numbers and times, the video above it; Where to look under the message. */
	decorateRequest(ctx: IDispatchChatRequestContext): IDisposable | undefined {
		const parsed = ctx.text ? parseMessage(ctx.text) : undefined;
		if (!parsed) {
			return undefined;
		}
		const store = new DisposableStore();
		const md = [...ctx.container.querySelectorAll<HTMLElement>('.rendered-markdown')].filter(e => !e.classList.contains('dispatch-pt-bubble'));
		for (const e of md) {
			e.classList.add('dispatch-pt-raw');
		}
		const anchor = md.at(-1);
		const bubble = $('.rendered-markdown.dispatch-pt-bubble');
		const chipRow = $('.pt-chiprow.sent');
		if (anchor) {
			anchor.after(chipRow, bubble);
		} else {
			ctx.container.append(chipRow, bubble);
		}
		store.add(toDisposable(() => {
			chipRow.remove();
			bubble.remove();
			for (const e of md) {
				e.classList.remove('dispatch-pt-raw');
			}
		}));
		this.renderChip(chipRow, parsed, store);
		this.renderLines(bubble, parsed);

		// the frames: from the attachments when the message has them, else drawn here from the folder
		const sentFrames = ctx.variables.filter(v => v.kind === 'image' && readPointTalkFrameMeta(v));
		let frames: Promise<IShownFrame[]>;
		if (sentFrames.length) {
			frames = Promise.all(sentFrames.map(v => this.frameOf(v, readPointTalkFrameMeta(v)!))).then(fs => fs.filter((f): f is IShownFrame => !!f));
		} else {
			const row = $('.pt-frames.sent');
			chipRow.before(row);
			store.add(toDisposable(() => row.remove()));
			frames = this.savedFrames(parsed);
			void frames.then(fs => {
				if (store.isDisposed) {
					return;
				}
				for (const f of fs) {
					const tile = dom.append(row, $('.chat-attached-context-attachment.dispatch-pt-sent', { 'data-pt-n': String(f.n) }));
					const th = dom.append(tile, $('.pt-th', { 'data-n': String(f.n) }));
					th.appendChild(renderDispatchWhereThumb(f.url, { size: f.size, marks: [{ n: f.n, box: f.box, color: 'red' }], drawn: f.drawn }, { size: DispatchThumbSize.message, fit: 'marks' }));
					const lab = dom.append(th, $('span.pt-lab'));
					dom.append(lab, $('span.pt-nd', undefined, String(f.n)));
					dom.append(lab, $('span', undefined, clock(f.t)));
				}
			});
		}

		// Where to look: a frame or a number opens it under the message, the same one again closes it
		const viewer = store.add(new MutableDisposable<DisposableStore & { n?: number }>());
		const open = async (n: number) => {
			if (viewer.value?.n === n) {
				viewer.clear();
				return;
			}
			const all = await frames;
			if (store.isDisposed || !all.some(f => f.n === n)) {
				return;
			}
			const vs = new DisposableStore() as DisposableStore & { n?: number };
			vs.n = n;
			viewer.value = vs;
			const holder = dom.append(ctx.container, $('.dispatch-pt-where'));
			vs.add(toDisposable(() => holder.remove()));
			this.renderViewer(holder, all, parsed.lines, n, next => void open(next), () => viewer.clear(), vs);
			const win = dom.getWindow(holder);
			win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
				if (viewer.value === vs) {
					ctx.reveal?.(1);
				}
			}));
		};
		store.add(dom.addDisposableListener(ctx.container, dom.EventType.CLICK, e => {
			const target = e.target as HTMLElement;
			const tile = target.closest<HTMLElement>('.dispatch-pt-sent');
			const dot = target.closest<HTMLElement>('.dispatch-pt-bubble .pt-nd');
			const n = Number(tile?.dataset.ptN ?? dot?.textContent ?? NaN);
			if (n > 0) {
				e.preventDefault();
				e.stopPropagation();
				void open(n);
			}
		}, true));
		store.add(dom.addDisposableListener(ctx.container, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape' && viewer.value) {
				viewer.clear();
			}
		}));
		// pointing at a line lights its frame, at a frame its line
		store.add(dom.addDisposableListener(ctx.container, dom.EventType.MOUSE_OVER, e => {
			ctx.container.querySelectorAll('.pt-th.hl, .pt-row.hl').forEach(x => x.classList.remove('hl'));
			const t = e.target as HTMLElement;
			const n = t.closest<HTMLElement>('.dispatch-pt-bubble .pt-row')?.dataset.line || t.closest<HTMLElement>('.dispatch-pt-sent')?.dataset.ptN;
			if (n) {
				ctx.container.querySelectorAll(`.dispatch-pt-sent[data-pt-n="${n}"] .pt-th, .dispatch-pt-bubble .pt-row[data-line="${n}"]`).forEach(x => x.classList.add('hl'));
			}
		}));
		store.add(dom.addDisposableListener(ctx.container, dom.EventType.MOUSE_LEAVE, () => ctx.container.querySelectorAll('.pt-th.hl, .pt-row.hl').forEach(x => x.classList.remove('hl'))));
		return store;
	}

	private async savedFrames(parsed: IPointTalkText): Promise<IShownFrame[]> {
		const take = await readSavedTake(this.fileService, parsed.folder);
		if (!take) {
			return [];
		}
		const out: IShownFrame[] = [];
		for (const f of take.frames) {
			const url = await this.pictureUrl(joinPath(URI.file(parsed.folder), f.file).fsPath);
			if (url) {
				out.push({ n: f.n, t: f.t, url, size: f.size, box: f.box, drawn: false });
			}
		}
		return out;
	}

	private renderChip(row: HTMLElement, parsed: IPointTalkText, store: DisposableStore): void {
		const chip = dom.append(row, $('button.pt-vchip.big', { type: 'button', title: parsed.video }));
		dom.append(chip, $(`span${ThemeIcon.asCSSSelector(Codicon.deviceCameraVideo)}`, { 'aria-hidden': 'true' }));
		dom.append(chip, $('span.n', undefined, localize('dispatchPointTalk.video', "Screen recording")));
		dom.append(chip, $('span.m', undefined, clock(parsed.duration)));
		store.add(dom.addDisposableListener(chip, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.openVideo(parsed.video);
		}));
	}

	private renderLines(bubble: HTMLElement, parsed: IPointTalkText): void {
		if (parsed.note) {
			dom.append(bubble, $('p.pt-note-text', undefined, parsed.note));
		}
		const grid = dom.append(bubble, $('.pt-lines.sent', { role: 'list' }));
		for (const l of parsed.lines) {
			const row = dom.append(grid, $('.pt-row', { role: 'listitem', 'data-line': l.n ? String(l.n) : '' }));
			if (l.n) {
				const nd = dom.append(row, $('span.pt-nd', { role: 'button', tabindex: '0', 'aria-label': localize('dispatchPointTalk.openFrame', "Where frame {0} points", l.n) }, String(l.n)));
				nd.title = localize('dispatchPointTalk.whereTip', "See where you pointed");
			} else {
				dom.append(row, $('span'));
			}
			dom.append(row, $('span.pt-ts', undefined, clock(l.t)));
			dom.append(row, $('span.pt-tx', undefined, l.text));
		}
		if (!parsed.lines.length) {
			dom.append(grid, $('.pt-note', undefined, localize('dispatchPointTalk.nothingSaid', "Nothing was said.")));
		}
	}

	private renderViewer(holder: HTMLElement, frames: readonly IShownFrame[], lines: readonly ILine[], n: number, go: (n: number) => void, close: () => void, store: DisposableStore): void {
		const f = frames.find(x => x.n === n)!;
		const index = frames.indexOf(f);
		const head = dom.append(holder, $('.pt-wvh'));
		dom.append(head, $('b', undefined, localize('dispatchPointTalk.pictureOf', "Picture {0} of {1}", index + 1, frames.length)));
		dom.append(head, $('span.pt-ts', undefined, clock(f.t)));
		dom.append(head, $('span.pt-grow'));
		const closeBtn = dom.append(head, $('button.pt-link', { type: 'button' }, localize('dispatchPointTalk.close', "Close")));
		store.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			close();
		}));
		const pic = dom.append(holder, $('.pt-wvp'));
		const width = Math.min(440, f.size[0]);
		const s = width / f.size[0];
		pic.style.width = `${width}px`;
		pic.style.height = `${Math.round(f.size[1] * s)}px`;
		pic.style.backgroundImage = `url("${f.url}")`;
		pic.style.backgroundSize = `${width}px ${Math.round(f.size[1] * s)}px`;
		if (!f.drawn) {
			const rb = dom.append(pic, $('i.pt-rb'));
			rb.style.left = `${f.box[0] * s}px`;
			rb.style.top = `${f.box[1] * s}px`;
			rb.style.width = `${f.box[2] * s}px`;
			rb.style.height = `${f.box[3] * s}px`;
			dom.append(rb, $('i.pt-rk', undefined, String(f.n)));
		}
		const list = dom.append(holder, $('.pt-wvl'));
		for (const l of lines.filter(x => x.n && frames.some(fr => fr.n === x.n))) {
			const row = dom.append(list, $('button.pt-wvr', { type: 'button' }));
			row.classList.toggle('on', l.n === n);
			dom.append(row, $('span.pt-nd', undefined, String(l.n)));
			dom.append(row, $('span.pt-ts', undefined, clock(l.t)));
			dom.append(row, $('span.pt-tx', undefined, l.text));
			store.add(dom.addDisposableListener(row, dom.EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				if (l.n !== n) {
					go(l.n!);
				}
			}));
		}
	}
}
