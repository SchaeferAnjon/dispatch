/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the draw tool of 「截图上画框当输入」 (kanban design/annotations/redesign 第 1 节 A4
 *  and 第 4 节; patches/320-draw-and-ask.patch). One tool for the chat input (a pasted picture, drawn at
 *  the input's width) and the side pane (any picture or page there, drawn 1:1 and scrolled):
 *
 *  - a tool row: red (default) and green, Undo, Clear, a hint until the first box, Cancel and the
 *    one filled button (Done, or Add to message);
 *  - the picture: drag to draw a box, the number goes on its top left corner; click a box to pick
 *    it, drag it to move it, drag a corner to resize, Backspace deletes it; on a web page the box
 *    snaps to the element under it (dashed preview while dragging, Alt draws freely);
 *  - a line under the picture per box, the cursor goes straight into it; Enter goes to the next one
 *    (on the last one it is the filled button), empty is fine; a line whose box is scrolled away
 *    brings it back into view;
 *  - the trackpad and the wheel scroll the picture (the boxes go with it), except while a box is being
 *    drawn, moved or resized.
 *
 *  Boxes are kept in picture pixels. {@link burnDispatchMarks} draws them into a copy of the picture
 *  (what the agent sees); the text that goes with it is renderDispatchMarksText (agentHost common).
 *  Red and green only ever appear on the picture and on the numbers that stand for it.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchDraw.css';
import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { DISPATCH_MARK_COLORS, DispatchMarkColor, dispatchPictureScale, IDispatchMark } from '../../dispatchCommon/browser/dispatchWhere.js';

const $ = dom.$;

/** A picture to draw on. */
export interface IDispatchDrawPicture {
	/** blob: or data: URL. */
	readonly url: string;
	/** Natural size in pixels. */
	readonly size: readonly [number, number];
	/** Picture pixels per screen point (2 for a Retina capture); guessed from the size when unset. */
	readonly scale?: number;
}

/** Something a box can snap to: an element of a web page, in picture pixels. */
export interface IDispatchSnapTarget {
	readonly box: readonly [number, number, number, number];
	/** Short name for the preview caption, e.g. `button.tab`. */
	readonly label: string;
	/** Nesting depth; deeper wins a tie. */
	readonly depth: number;
	/** Opaque key to look the element up again. */
	readonly key: string;
}

/** A mark as the tool keeps it: the snap target it took, if any. */
export interface IDispatchDrawMark extends IDispatchMark {
	readonly snapKey?: string;
}

export interface IDispatchDrawOptions {
	/** `width`: the picture fills the tool's width (chat input); `points`: 1:1 screen points, scroll to look around (side pane). */
	readonly fit: 'width' | 'points';
	/** The swatch picked at first (default red; green on a picture that already has red boxes). */
	readonly color?: DispatchMarkColor;
	/** Marks to start from (drawing again on an annotated attachment). */
	readonly marks?: readonly IDispatchDrawMark[];
	/** The filled button's words (default "Done"). */
	readonly accept?: string;
	/** Elements to snap to (a web page). */
	readonly snap?: readonly IDispatchSnapTarget[];
	/** The picture's visible height is capped at this many pixels (it scrolls beyond). */
	readonly maxHeight?: number;
	/** Picture pixels to show in the middle at first (`points`: where the picture was being looked at). */
	readonly center?: readonly [number, number];
}

type Handle = 'a' | 'b' | 'c' | 'd'; // top left, top right, bottom left, bottom right

type Box = [number, number, number, number];

const MIN_BOX = 6; // screen pixels: a smaller drag is a click
const SNAP_EDGE = 14; // screen pixels an edge may be off and still snap

function clampBox(b: Box, w: number, h: number): Box {
	let [x, y, bw, bh] = b;
	x = Math.max(0, Math.min(x, w - 1));
	y = Math.max(0, Math.min(y, h - 1));
	bw = Math.max(1, Math.min(bw, w - x));
	bh = Math.max(1, Math.min(bh, h - y));
	return [Math.round(x), Math.round(y), Math.round(bw), Math.round(bh)];
}

function iou(a: readonly number[], b: readonly number[]): number {
	const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
	const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
	const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
	const union = a[2] * a[3] + b[2] * b[3] - inter;
	return union > 0 ? inter / union : 0;
}

/**
 * The snap target for a drawn box: the element whose four edges are closest to the box's, when each
 * edge is within {@link SNAP_EDGE} screen pixels (or the two overlap by 60% or more); deeper elements
 * win ties. `k` is screen pixels per picture pixel.
 */
export function dispatchSnapTarget(box: readonly number[], targets: readonly IDispatchSnapTarget[], k: number): IDispatchSnapTarget | undefined {
	const tol = SNAP_EDGE / k;
	let best: IDispatchSnapTarget | undefined;
	let bestScore = Infinity;
	for (const t of targets) {
		const [tx, ty, tw, th] = t.box;
		const dx1 = Math.abs(box[0] - tx), dy1 = Math.abs(box[1] - ty);
		const dx2 = Math.abs(box[0] + box[2] - (tx + tw)), dy2 = Math.abs(box[1] + box[3] - (ty + th));
		const close = dx1 <= tol && dy1 <= tol && dx2 <= tol && dy2 <= tol;
		const overlap = iou(box, t.box);
		if (!close && overlap < 0.6) {
			continue;
		}
		const score = dx1 + dy1 + dx2 + dy2 - overlap * tol - t.depth * 0.01;
		if (score < bestScore) {
			bestScore = score;
			best = t;
		}
	}
	return best;
}

/**
 * The draw tool (`.dispatch-draw`). Put {@link element} where the tool goes, call {@link layout}
 * after it is in the DOM. {@link onDidAccept} fires with the marks (picture pixels, numbered from 1)
 * on the filled button or Enter on the last line; {@link onDidCancel} on Cancel or Escape.
 */
export class DispatchDrawTool extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidAccept = this._register(new Emitter<IDispatchDrawMark[]>());
	readonly onDidAccept: Event<IDispatchDrawMark[]> = this._onDidAccept.event;
	private readonly _onDidCancel = this._register(new Emitter<void>());
	readonly onDidCancel: Event<void> = this._onDidCancel.event;
	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The marks or a note changed. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly bar: HTMLElement;
	private readonly swatches: Record<DispatchMarkColor, HTMLButtonElement>;
	private readonly undoButton: HTMLButtonElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly hint: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly img: HTMLImageElement;
	private readonly layer: HTMLElement;
	private readonly snapEl: HTMLElement;
	private readonly list: HTMLOListElement;

	private color: DispatchMarkColor;
	private marks: IDispatchDrawMark[] = [];
	private selected: number | undefined;
	/** The selected box was picked by hand (a click on it or its line): a swatch then recolours it. */
	private picked = false;
	private centered = false;
	private readonly history: IDispatchDrawMark[][] = [];
	private readonly gesture = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly picture: IDispatchDrawPicture,
		private readonly options: IDispatchDrawOptions,
	) {
		super();
		this.color = options.color ?? 'red';
		this.marks = (options.marks ?? []).map(m => ({ ...m }));
		this.element = $('.dispatch-draw');
		this.element.classList.add(options.fit === 'points' ? 'fit-points' : 'fit-width');
		this.element.tabIndex = -1;

		// tool row
		this.bar = dom.append(this.element, $('.dbar'));
		this.swatches = {
			red: this.swatch('red', localize('dispatchDraw.red', "Red")),
			green: this.swatch('green', localize('dispatchDraw.green', "Green: leave this as it is")),
		};
		dom.append(this.bar, $('span.dsep'));
		this.undoButton = this.iconButton('discard', localize('dispatchDraw.undo', "Undo"), () => this.undo());
		this.clearButton = this.iconButton('trash', localize('dispatchDraw.clear', "Clear all boxes"), () => this.clear());
		this.hint = dom.append(this.bar, $('span.dhint', undefined, localize('dispatchDraw.hint', "Drag on the image to mark a spot")));
		dom.append(this.bar, $('span.sp'));
		this.pill(localize('dispatchDraw.cancel', "Cancel"), false, () => this._onDidCancel.fire());
		this.pill(options.accept ?? localize('dispatchDraw.done', "Done"), true, () => this.accept());

		// picture
		this.scroller = dom.append(this.element, $('.canvas'));
		if (options.maxHeight) {
			this.scroller.style.maxHeight = `${options.maxHeight}px`;
		}
		this.stage = dom.append(this.scroller, $('.stage'));
		this.img = dom.append(this.stage, $('img', { alt: '', draggable: 'false' })) as HTMLImageElement;
		this.layer = dom.append(this.stage, $('.layer'));
		this.snapEl = dom.append(this.stage, $('.snap'));
		this.img.src = picture.url;
		this._register(dom.addDisposableListener(this.img, 'load', () => this.layout()));

		// lines
		this.list = dom.append(this.element, $('ol.legedit')) as HTMLOListElement;

		this.wireStage();
		this.wireKeys();
		const ro = this._register(new dom.DisposableResizeObserver('dispatchDraw', () => this.layout(), dom.getWindow(this.element)));
		this._register(ro.observe(this.scroller));
		this.render();
	}

	/** The marks now, numbered from 1, notes trimmed. */
	getMarks(): IDispatchDrawMark[] {
		return this.marks.map(m => ({ ...m, note: (m.note ?? '').trim() }));
	}

	/** Screen pixels per picture pixel as shown. */
	private get k(): number {
		const w = this.img.clientWidth;
		return w ? w / this.picture.size[0] : 1;
	}

	layout(): void {
		const [pw, ph] = this.picture.size;
		if (this.options.fit === 'points') {
			const s = 1 / dispatchPictureScale({ scale: this.picture.scale }, pw);
			this.img.style.width = `${pw * s}px`;
			this.img.style.height = `${ph * s}px`;
		} else {
			this.img.style.width = '100%';
			this.img.style.height = 'auto';
		}
		this.render();
		const c = this.options.center;
		if (c && !this.centered && this.img.complete && this.img.naturalWidth && this.scroller.clientWidth) {
			const k = this.k;
			this.scroller.scrollLeft = Math.max(0, c[0] * k - this.scroller.clientWidth / 2);
			this.scroller.scrollTop = Math.max(0, c[1] * k - this.scroller.clientHeight / 2);
			this.centered = true;
		}
	}

	focus(): void {
		const firstEmpty = [...this.list.querySelectorAll<HTMLInputElement>('input')].find(i => !i.value);
		(firstEmpty ?? this.element).focus();
	}

	// ---- building blocks

	private swatch(color: DispatchMarkColor, title: string): HTMLButtonElement {
		const b = dom.append(this.bar, $('button.sw', { type: 'button', title, 'aria-label': title })) as HTMLButtonElement;
		b.classList.toggle('g', color === 'green');
		const dot = dom.append(b, $('i'));
		dot.style.background = DISPATCH_MARK_COLORS[color];
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, () => {
			this.color = color;
			// a swatch recolours a box picked by hand; the box just drawn keeps its colour (the next one takes the new one)
			const m = this.picked ? this.marks.find(x => x.n === this.selected) : undefined;
			if (m && m.color !== color) {
				this.snapshot();
				this.replace({ ...m, color });
			}
			this.render();
		}));
		return b;
	}

	private iconButton(icon: string, title: string, run: () => void): HTMLButtonElement {
		const b = dom.append(this.bar, $('button.ibtn', { type: 'button', title, 'aria-label': title })) as HTMLButtonElement;
		dom.append(b, $(`span.codicon.codicon-${icon}`));
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, () => run()));
		return b;
	}

	private pill(label: string, primary: boolean, run: () => void): HTMLButtonElement {
		const b = dom.append(this.bar, $('button.dpill', { type: 'button' }, label)) as HTMLButtonElement;
		b.classList.toggle('fill', primary);
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.preventDefault();
			run();
		}));
		return b;
	}

	// ---- state

	private snapshot(): void {
		this.history.push(this.marks.map(m => ({ ...m })));
		if (this.history.length > 100) {
			this.history.shift();
		}
	}

	private replace(m: IDispatchDrawMark): void {
		this.marks = this.marks.map(x => x.n === m.n ? m : x);
	}

	private renumber(): void {
		const old = this.selected;
		let sel: number | undefined;
		this.marks = this.marks.map((m, i) => {
			if (m.n === old) {
				sel = i + 1;
			}
			return { ...m, n: i + 1 };
		});
		this.selected = sel;
	}

	private undo(): void {
		const prev = this.history.pop();
		if (!prev) {
			return;
		}
		this.marks = prev;
		if (!this.marks.some(m => m.n === this.selected)) {
			this.selected = undefined;
		}
		this.render();
		this._onDidChange.fire();
	}

	private clear(): void {
		if (!this.marks.length) {
			return;
		}
		this.snapshot();
		this.marks = [];
		this.selected = undefined;
		this.render();
		this._onDidChange.fire();
	}

	private remove(n: number): void {
		this.snapshot();
		this.marks = this.marks.filter(m => m.n !== n);
		if (this.selected === n) {
			this.selected = undefined;
		}
		this.renumber();
		this.render();
		this._onDidChange.fire();
	}

	private accept(): void {
		this._onDidAccept.fire(this.getMarks());
	}

	// ---- rendering

	private render(): void {
		const k = this.k;
		const [pw, ph] = this.picture.size;
		this.swatches.red.classList.toggle('on', this.color === 'red');
		this.swatches.green.classList.toggle('on', this.color === 'green');
		this.undoButton.disabled = !this.history.length;
		this.clearButton.disabled = !this.marks.length;
		this.hint.style.display = this.marks.length ? 'none' : '';
		this.layer.style.width = `${pw * k}px`;
		this.layer.style.height = `${ph * k}px`;
		dom.clearNode(this.layer);
		for (const m of this.marks) {
			const el = dom.append(this.layer, $('span.mk'));
			el.dataset.n = String(m.n);
			el.classList.toggle('g', m.color === 'green');
			el.classList.toggle('sel', m.n === this.selected);
			el.classList.toggle('in', m.box[1] * k < 20);
			el.style.left = `${m.box[0] * k}px`;
			el.style.top = `${m.box[1] * k}px`;
			el.style.width = `${m.box[2] * k}px`;
			el.style.height = `${m.box[3] * k}px`;
			dom.append(el, $('i', undefined, String(m.n)));
			for (const h of ['a', 'b', 'c', 'd'] as Handle[]) {
				const hb = dom.append(el, $(`b.h.${h}`));
				hb.dataset.h = h;
			}
		}
		this.renderList();
	}

	private renderList(): void {
		// keep the focused input (and its caret) when only the selection changed
		const active = dom.getActiveElement();
		const focusedN = active instanceof HTMLInputElement && this.list.contains(active) ? Number(active.dataset.n) : undefined;
		const caret = focusedN !== undefined ? (active as HTMLInputElement).selectionStart : null;
		dom.clearNode(this.list);
		for (const m of this.marks) {
			const li = dom.append(this.list, $('li'));
			li.dataset.n = String(m.n);
			li.classList.toggle('focus', m.n === this.selected);
			const num = dom.append(li, $('span.n', undefined, String(m.n)));
			num.style.background = DISPATCH_MARK_COLORS[m.color ?? 'red'];
			const input = dom.append(li, $('input.tx', {
				type: 'text',
				placeholder: localize('dispatchDraw.notePlaceholder', "Say what is wrong here, or what to do"),
				'aria-label': localize('dispatchDraw.noteAria', "Note for box {0}", m.n),
			})) as HTMLInputElement;
			input.dataset.n = String(m.n);
			input.value = m.note ?? '';
			input.spellcheck = false;
			const x = dom.append(li, $('button.x', { type: 'button', title: localize('dispatchDraw.remove', "Remove box {0}", m.n) }));
			dom.append(x, $('span.codicon.codicon-close'));
		}
		if (focusedN !== undefined) {
			const again = this.list.querySelector<HTMLInputElement>(`input[data-n="${focusedN}"]`);
			if (again) {
				again.focus();
				if (caret !== null) {
					again.setSelectionRange(caret, caret);
				}
			}
		}
	}

	private focusNote(n: number): void {
		const input = this.list.querySelector<HTMLInputElement>(`input[data-n="${n}"]`);
		input?.focus();
	}

	// ---- pointer

	private toPicture(e: PointerEvent): [number, number] {
		const r = this.layer.getBoundingClientRect();
		const k = this.k;
		const [pw, ph] = this.picture.size;
		return [Math.max(0, Math.min(pw, (e.clientX - r.left) / k)), Math.max(0, Math.min(ph, (e.clientY - r.top) / k))];
	}

	private showSnap(t: IDispatchSnapTarget | undefined): void {
		if (!t) {
			this.snapEl.style.display = 'none';
			return;
		}
		const k = this.k;
		this.snapEl.style.display = 'block';
		this.snapEl.style.left = `${t.box[0] * k}px`;
		this.snapEl.style.top = `${t.box[1] * k}px`;
		this.snapEl.style.width = `${t.box[2] * k}px`;
		this.snapEl.style.height = `${t.box[3] * k}px`;
		this.snapEl.dataset.label = t.label;
	}

	/** Scroll the picture so box `n` is in view (a line picked while its box is scrolled away). */
	private revealMark(n: number): void {
		const m = this.marks.find(x => x.n === n);
		if (!m) {
			return;
		}
		const k = this.k;
		const sc = this.scroller;
		const [x, y, w, h] = m.box.map(v => v * k);
		const margin = 24;
		if (y < sc.scrollTop || y + h > sc.scrollTop + sc.clientHeight) {
			sc.scrollTop = h + 2 * margin > sc.clientHeight ? y - margin : y - (sc.clientHeight - h) / 2;
		}
		if (x < sc.scrollLeft || x + w > sc.scrollLeft + sc.clientWidth) {
			sc.scrollLeft = w + 2 * margin > sc.clientWidth ? x - margin : x - (sc.clientWidth - w) / 2;
		}
	}

	private wireStage(): void {
		// the wheel scrolls the picture, not while a box is being drawn, moved or resized
		this._register(dom.addDisposableListener(this.scroller, dom.EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (this.gesture.value) {
				e.preventDefault();
			}
		}, { passive: false }));
		this._register(dom.addDisposableListener(this.stage, dom.EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			this.element.focus({ preventScroll: true });
			const target = e.target as HTMLElement;
			const handle = target.closest<HTMLElement>('b.h');
			const mk = target.closest<HTMLElement>('span.mk');
			const start = this.toPicture(e);
			const [pw, ph] = this.picture.size;
			const store = new DisposableStore();
			this.stage.setPointerCapture(e.pointerId);
			const k = this.k;

			if (mk && (handle || mk)) {
				// pick, move or resize an existing box
				const n = Number(mk.dataset.n);
				const m = this.marks.find(x => x.n === n);
				if (!m) {
					return;
				}
				this.selected = n;
				this.picked = true;
				this.color = m.color ?? 'red';
				this.render();
				const orig: Box = [...m.box] as Box;
				const h = handle?.dataset.h as Handle | undefined;
				let changed = false;
				store.add(dom.addDisposableListener(this.stage, dom.EventType.POINTER_MOVE, (mv: PointerEvent) => {
					const [px, py] = this.toPicture(mv);
					const dx = px - start[0], dy = py - start[1];
					if (!changed && Math.abs(dx * k) + Math.abs(dy * k) < 3) {
						return;
					}
					if (!changed) {
						this.snapshot();
						changed = true;
					}
					let b: Box;
					if (!h) {
						b = [Math.max(0, Math.min(pw - orig[2], orig[0] + dx)), Math.max(0, Math.min(ph - orig[3], orig[1] + dy)), orig[2], orig[3]];
					} else {
						let x1 = orig[0], y1 = orig[1], x2 = orig[0] + orig[2], y2 = orig[1] + orig[3];
						if (h === 'a' || h === 'c') { x1 = px; }
						if (h === 'b' || h === 'd') { x2 = px; }
						if (h === 'a' || h === 'b') { y1 = py; }
						if (h === 'c' || h === 'd') { y2 = py; }
						b = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
					}
					this.replace({ ...m, box: clampBox(b, pw, ph), snapKey: undefined });
					this.render();
				}));
				const end = () => {
					this.gesture.clear();
					if (changed) {
						this._onDidChange.fire();
					}
					// the box stays picked with the focus on the tool: Backspace deletes it, typing goes to its line
					this.element.focus({ preventScroll: true });
				};
				store.add(dom.addDisposableListener(this.stage, dom.EventType.POINTER_UP, end));
				store.add(dom.addDisposableListener(this.stage, 'pointercancel', end));
				this.gesture.value = store;
				return;
			}

			// draw a new box
			const draft = dom.append(this.layer, $('span.mk.draft'));
			draft.classList.toggle('g', this.color === 'green');
			let cur: Box = [start[0], start[1], 0, 0];
			let snap: IDispatchSnapTarget | undefined;
			store.add(dom.addDisposableListener(this.stage, dom.EventType.POINTER_MOVE, (mv: PointerEvent) => {
				const [px, py] = this.toPicture(mv);
				cur = [Math.min(px, start[0]), Math.min(py, start[1]), Math.abs(px - start[0]), Math.abs(py - start[1])];
				draft.style.left = `${cur[0] * k}px`;
				draft.style.top = `${cur[1] * k}px`;
				draft.style.width = `${cur[2] * k}px`;
				draft.style.height = `${cur[3] * k}px`;
				snap = this.options.snap?.length && !mv.altKey && cur[2] * k > MIN_BOX && cur[3] * k > MIN_BOX ? dispatchSnapTarget(cur, this.options.snap, k) : undefined;
				this.showSnap(snap);
			}));
			const end = (up: PointerEvent) => {
				this.gesture.clear();
				draft.remove();
				this.showSnap(undefined);
				if (cur[2] * k <= MIN_BOX || cur[3] * k <= MIN_BOX) {
					// a click on the picture: drop the selection
					if (this.selected !== undefined) {
						this.selected = undefined;
						this.render();
					}
					return;
				}
				this.snapshot();
				const n = this.marks.length + 1;
				const box = snap && !up.altKey ? clampBox([...snap.box] as Box, pw, ph) : clampBox(cur, pw, ph);
				this.marks.push({ n, box, color: this.color, note: '', snapKey: snap && !up.altKey ? snap.key : undefined });
				this.selected = n;
				this.picked = false;
				this.render();
				this.focusNote(n);
				// its new line takes room from the picture: keep the box in view
				this.revealMark(n);
				this._onDidChange.fire();
			};
			store.add(dom.addDisposableListener(this.stage, dom.EventType.POINTER_UP, end));
			store.add(dom.addDisposableListener(this.stage, 'pointercancel', end));
			this.gesture.value = store;
		}));

		// the lines: a click picks the box, × removes it, typing is the note
		this._register(dom.addDisposableListener(this.list, dom.EventType.CLICK, e => {
			const li = (e.target as HTMLElement).closest<HTMLElement>('li');
			if (!li) {
				return;
			}
			const n = Number(li.dataset.n);
			if ((e.target as HTMLElement).closest('button.x')) {
				this.remove(n);
				return;
			}
			this.picked = true;
			if (this.selected !== n) {
				this.selected = n;
				const m = this.marks.find(x => x.n === n);
				this.color = m?.color ?? this.color;
				this.render();
			}
			this.revealMark(n);
		}));
		this._register(dom.addDisposableListener(this.list, dom.EventType.INPUT, e => {
			const input = e.target as HTMLInputElement;
			const n = Number(input.dataset.n);
			const m = this.marks.find(x => x.n === n);
			if (m) {
				this.replace({ ...m, note: input.value });
				this._onDidChange.fire();
			}
		}));
		this._register(dom.addDisposableListener(this.list, dom.EventType.FOCUS_IN, e => {
			const input = e.target as HTMLElement;
			const n = Number(input.dataset?.n);
			if (n && this.selected !== n) {
				this.selected = n;
				for (const li of this.list.querySelectorAll<HTMLElement>('li')) {
					li.classList.toggle('focus', Number(li.dataset.n) === n);
				}
				for (const mk of this.layer.querySelectorAll<HTMLElement>('span.mk')) {
					mk.classList.toggle('sel', Number(mk.dataset.n) === n);
				}
				// Tab or Enter to another line: its box comes into view
				this.revealMark(n);
			}
		}));
	}

	private wireKeys(): void {
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const inInput = e.target instanceof HTMLInputElement;
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				// Escape never throws boxes away: it lets go of the picked one; with none drawn it closes the tool
				if (this.selected !== undefined || inInput) {
					this.selected = undefined;
					this.render();
					this.element.focus({ preventScroll: true });
				} else if (!this.marks.length) {
					this._onDidCancel.fire();
				}
				return;
			}
			if (!inInput && this.selected !== undefined && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
				// typing with a box picked writes its line
				const input = this.list.querySelector<HTMLInputElement>(`input[data-n="${this.selected}"]`);
				input?.focus();
				return;
			}
			if (inInput && e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				e.stopPropagation();
				const n = Number((e.target as HTMLInputElement).dataset.n);
				if (n < this.marks.length) {
					this.focusNote(n + 1);
				} else {
					this.accept();
				}
				return;
			}
			if (!inInput && (e.key === 'Backspace' || e.key === 'Delete') && this.selected !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.remove(this.selected);
				return;
			}
			if (!inInput && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
				e.preventDefault();
				e.stopPropagation();
				this.undo();
			}
		}));
	}
}

// ---------------------------------------------------------------- burning and text

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('picture did not load'));
		img.src = url;
	});
}

/**
 * The picture with the boxes drawn in, as PNG bytes: a 2 point line in the mark's colour and the
 * number in an 18 point square of that colour on the box's top left corner (inside the box when
 * there is no room above). Points are picture pixels / scale (a Retina capture draws 4 px lines).
 */
export async function burnDispatchMarks(picture: IDispatchDrawPicture, marks: readonly IDispatchMark[]): Promise<Uint8Array> {
	const img = await loadImage(picture.url);
	const [w, h] = [img.naturalWidth, img.naturalHeight];
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('no 2d context');
	}
	ctx.drawImage(img, 0, 0);
	const s = dispatchPictureScale({ scale: picture.scale }, w);
	const lw = 2 * s, tag = 18 * s;
	for (const m of marks) {
		const color = DISPATCH_MARK_COLORS[m.color ?? 'red'];
		const [x, y, bw, bh] = m.box;
		ctx.strokeStyle = color;
		ctx.lineWidth = lw;
		ctx.strokeRect(x + lw / 2, y + lw / 2, Math.max(1, bw - lw), Math.max(1, bh - lw));
		const tx = Math.max(0, x);
		const ty = y - tag >= 0 ? y - tag : y;
		ctx.fillStyle = color;
		ctx.fillRect(tx, ty, tag, tag);
		ctx.fillStyle = '#ffffff';
		ctx.font = `600 ${11 * s}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(String(m.n), tx + tag / 2, ty + tag / 2 + 0.5 * s);
	}
	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
	if (!blob) {
		throw new Error('canvas did not encode');
	}
	return new Uint8Array(await blob.arrayBuffer());
}
