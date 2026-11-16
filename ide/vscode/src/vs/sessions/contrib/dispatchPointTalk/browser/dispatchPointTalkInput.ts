/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk in the message box (direction A「Button by the input」, task-0y0km; kanban
 *  design/screen-talk frames A1 and A2).
 *
 *  A1, recording: the box shows the words as they come (grey, three lines at most, older ones scroll up), and its
 *  tool row becomes a breathing red dot, "Recording", the clock, the level, the newest spot's number, then Discard
 *  and Stop where the send button was (Stop has its word: it is not the agent's stop square); the box keeps its own
 *  border (task-dd4hw: the grey camera did not tell the person it was recording, a grey border fought the working flow).
 *
 *  A2, stopped: three placeholders and "Picking frames…" while the frames are picked, then the keyframes (each a
 *  crop round its red box, its number and when its sentence starts; × removes it, the pen opens the draw tool to
 *  move the box), the video ("Screen recording 0:15", the path on hover) and one line per sentence (number, time,
 *  the words; click a line to change them). The box's own tool row stays, so Enter or the send button sends, the
 *  same as any message. The text of the box is the message itself (hidden): every change here writes it again.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchPointTalk.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { DispatchThumbSize, renderDispatchWhereThumb } from '../../dispatchCommon/browser/dispatchWhere.js';
import { clock, ILine } from '../common/dispatchPointTalkModel.js';

const $ = dom.$;

export interface IPointTalkRecordingView {
	readonly clock: string;
	readonly level: readonly number[];
	readonly words: string;
	/** The newest spot's number, 0 before the first. */
	readonly spot: number;
}

export interface IPointTalkReviewFrame {
	readonly n: number;
	/** When its sentence starts (s). */
	readonly t: number;
	/** The spot's picture without the box (blob: URL), its size, and the box in its pixels. */
	readonly url: string;
	readonly size: readonly [number, number];
	readonly box: readonly [number, number, number, number];
}

export interface IPointTalkReviewView {
	readonly frames: readonly IPointTalkReviewFrame[];
	readonly lines: readonly ILine[];
	readonly duration: number;
	readonly video: string;
	/** The words could not be had: why (the frames and the video are still there). */
	readonly wordsError?: string;
}

export interface IPointTalkInputActions {
	discard(): void;
	stop(): void;
	removeFrame(n: number): void;
	drawFrame(n: number): void;
	editLine(index: number, text: string): void;
	openVideo(): void;
	send(): void;
}

/** The input box's Point and talk part: one per box, drawn by the window's controller. */
export class PointTalkInputSlot extends Disposable {

	private readonly slot: HTMLElement;
	private readonly draw = this._register(new DisposableStore());
	private mode: 'rec' | 'picking' | 'review' | undefined;
	private lastSpot = 0;
	private recParts: { live: HTMLElement; clock: HTMLElement; bars: HTMLElement[]; dot: HTMLElement } | undefined;

	constructor(readonly box: HTMLElement, private readonly actions: IPointTalkInputActions) {
		super();
		this.slot = $('.dispatch-pt-slot');
		box.prepend(this.slot);
		this._register(toDisposable(() => {
			this.slot.remove();
			box.classList.remove('dispatch-pt-recording', 'dispatch-pt-review');
		}));
	}

	get element(): HTMLElement {
		return this.slot;
	}

	// ---------------------------------------------------------------- A1 recording

	showRecording(v: IPointTalkRecordingView): void {
		if (this.mode !== 'rec' || !this.recParts) {
			this.draw.clear();
			dom.clearNode(this.slot);
			this.mode = 'rec';
			this.box.classList.add('dispatch-pt-recording');
			this.box.classList.remove('dispatch-pt-review');
			this.slot.className = 'dispatch-pt-slot rec';
			const live = dom.append(this.slot, $('.pt-live', { 'aria-live': 'polite' }));
			const tools = dom.append(this.slot, $('.pt-tools'));
			dom.append(tools, $('span.pt-rec', { 'aria-hidden': 'true' }));
			dom.append(tools, $('span.pt-rec-label', undefined, localize('dispatchPointTalk.recording', "Recording")));
			const clockEl = dom.append(tools, $('span.pt-clock', { role: 'timer', 'aria-label': localize('dispatchPointTalk.elapsed', "Recording time") }));
			const meter = dom.append(tools, $('span.pt-meter', { 'aria-hidden': 'true' }));
			const bars = [0, 1, 2, 3, 4].map(() => dom.append(meter, $('i')));
			const dot = dom.append(tools, $('span.pt-nd.pt-dot'));
			dot.title = localize('dispatchPointTalk.spotsTip', "Rest the pointer for a second to mark a spot.");
			dom.append(tools, $('span.pt-grow'));
			const discard = dom.append(tools, $('button.pt-discard', { type: 'button' }, localize('dispatchPointTalk.discard', "Discard")));
			const stop = dom.append(tools, $('button.pt-stop', { type: 'button' }));
			dom.append(stop, $(`span${ThemeIcon.asCSSSelector(Codicon.debugStop)}`, { 'aria-hidden': 'true' }));
			dom.append(stop, $('span', undefined, localize('dispatchPointTalk.stop', "Stop")));
			this.draw.add(dom.addDisposableListener(discard, dom.EventType.CLICK, () => this.actions.discard()));
			this.draw.add(dom.addDisposableListener(stop, dom.EventType.CLICK, () => this.actions.stop()));
			this.recParts = { live, clock: clockEl, bars, dot };
			this.lastSpot = 0;
		}
		const p = this.recParts;
		p.clock.textContent = v.clock;
		v.level.forEach((h, i) => p.bars[i].style.height = `${2 + Math.round(h * 8)}px`);
		if (v.words) {
			if (p.live.firstElementChild?.classList.contains('pt-shim') || p.live.textContent !== v.words) {
				dom.clearNode(p.live);
				dom.append(p.live, $('span', undefined, v.words));
			}
		} else if (!p.live.firstElementChild) {
			dom.append(p.live, $('span.pt-shim', undefined, localize('dispatchPointTalk.listening', "Listening…")));
		}
		p.dot.style.display = v.spot ? '' : 'none';
		if (v.spot !== this.lastSpot) {
			p.dot.textContent = String(v.spot);
			p.dot.setAttribute('aria-label', localize('dispatchPointTalk.spots', "{0} spots marked", v.spot));
			p.dot.classList.remove('pop');
			void p.dot.offsetWidth;
			p.dot.classList.add('pop');
			this.lastSpot = v.spot;
		}
	}

	// ---------------------------------------------------------------- A2 stopped

	/** Stopped, the frames being picked: three placeholders, the video, "Picking frames…". */
	showPicking(duration: number, video: string): void {
		this.draw.clear();
		dom.clearNode(this.slot);
		this.recParts = undefined;
		this.mode = 'picking';
		this.box.classList.remove('dispatch-pt-recording');
		this.box.classList.add('dispatch-pt-review');
		this.slot.className = 'dispatch-pt-slot review picking';
		const frames = dom.append(this.slot, $('.pt-frames'));
		for (let i = 0; i < 3; i++) {
			dom.append(frames, $('i.pt-ph'));
		}
		this.chip(duration, video);
		const lines = dom.append(this.slot, $('.pt-lines'));
		dom.append(lines, $('span.pt-shim', undefined, localize('dispatchPointTalk.picking', "Picking frames…")));
	}

	showReview(v: IPointTalkReviewView, fresh: boolean): void {
		const focusedLine = this.slot.querySelector<HTMLElement>('.pt-tx:focus');
		const keepLine = focusedLine?.dataset.i;
		this.draw.clear();
		dom.clearNode(this.slot);
		this.recParts = undefined;
		this.mode = 'review';
		this.box.classList.remove('dispatch-pt-recording');
		this.box.classList.add('dispatch-pt-review');
		this.slot.className = 'dispatch-pt-slot review';
		this.slot.tabIndex = -1;
		this.slot.setAttribute('aria-label', localize('dispatchPointTalk.reviewLabel', "Point and talk recording: remove a frame, change a line, then press Enter to send"));
		if (v.frames.length) {
			const frames = dom.append(this.slot, $('.pt-frames'));
			for (const f of v.frames) {
				// a Tab stop: Delete removes it, Enter opens the pen (the × and the pen show on hover and on focus)
				const th = dom.append(frames, $('.pt-th', { 'data-n': String(f.n), tabindex: '0', role: 'group', 'aria-label': localize('dispatchPointTalk.frameLabel', "Frame {0} at {1}: Delete removes it, Enter moves its box", f.n, clock(f.t)) }));
				th.classList.toggle('new', fresh);
				this.draw.add(dom.addDisposableListener(th, dom.EventType.KEY_DOWN, e => {
					if (e.target !== th) {
						return;
					}
					if (e.key === 'Delete' || e.key === 'Backspace') {
						e.preventDefault();
						e.stopPropagation();
						this.actions.removeFrame(f.n);
					} else if (e.key === 'Enter') {
						e.preventDefault();
						e.stopPropagation();
						this.actions.drawFrame(f.n);
					}
				}));
				const thumb = renderDispatchWhereThumb(f.url, { size: f.size, marks: [{ n: f.n, box: f.box, color: 'red' }], drawn: false }, { size: DispatchThumbSize.message, fit: 'marks' });
				th.appendChild(thumb);
				const lab = dom.append(th, $('span.pt-lab'));
				dom.append(lab, $('span.pt-nd', undefined, String(f.n)));
				dom.append(lab, $('span', undefined, clock(f.t)));
				const x = dom.append(th, $('button.pt-x', { type: 'button', 'aria-label': localize('dispatchPointTalk.removeFrame', "Remove frame {0}", f.n) }));
				x.title = localize('dispatchPointTalk.removeFrameTip', "Remove this frame");
				dom.append(x, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
				const pen = dom.append(th, $('button.pt-pen', { type: 'button', 'aria-label': localize('dispatchPointTalk.drawFrame', "Move the box on frame {0}", f.n) }));
				pen.title = localize('dispatchPointTalk.drawFrameTip', "Draw on it");
				dom.append(pen, $(`span${ThemeIcon.asCSSSelector(Codicon.edit)}`));
				this.draw.add(dom.addDisposableListener(x, dom.EventType.CLICK, e => {
					e.preventDefault();
					e.stopPropagation();
					this.actions.removeFrame(f.n);
				}));
				this.draw.add(dom.addDisposableListener(pen, dom.EventType.CLICK, e => {
					e.preventDefault();
					e.stopPropagation();
					this.actions.drawFrame(f.n);
				}));
			}
		}
		const chips = this.chip(v.duration, v.video);
		// no other way out of a recording that is not wanted: a quiet Discard at the end of the video's row
		const discard = dom.append(chips, $('button.pt-discard', { type: 'button' }, localize('dispatchPointTalk.discard', "Discard")));
		discard.title = localize('dispatchPointTalk.discardTip', "Throw this recording away");
		this.draw.add(dom.addDisposableListener(discard, dom.EventType.CLICK, e => {
			e.preventDefault();
			this.actions.discard();
		}));
		const list = dom.append(this.slot, $('.pt-lines', { role: 'list' }));
		if (v.wordsError) {
			dom.append(list, $('.pt-note', undefined, v.wordsError));
		}
		v.lines.forEach((l, i) => {
			const row = dom.append(list, $('.pt-row', { role: 'listitem', 'data-line': l.n ? String(l.n) : '' }));
			dom.append(row, l.n ? $('span.pt-nd', undefined, String(l.n)) : $('span'));
			dom.append(row, $('span.pt-ts', undefined, clock(l.t)));
			const tx = dom.append(row, $('span.pt-tx', { contenteditable: 'plaintext-only', spellcheck: 'false', 'data-i': String(i), role: 'textbox', 'aria-label': localize('dispatchPointTalk.line', "Line at {0}", clock(l.t)) }, l.text));
			this.draw.add(dom.addDisposableListener(tx, dom.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					e.stopPropagation();
					tx.blur();
					this.slot.focus();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					tx.textContent = l.text;
					tx.blur();
					this.slot.focus();
				}
			}));
			this.draw.add(dom.addDisposableListener(tx, dom.EventType.BLUR, () => {
				const text = (tx.textContent ?? '').trim();
				if (text !== l.text) {
					this.actions.editLine(i, text);
				}
			}));
		});
		// a line lights its frame, a frame its line
		this.draw.add(dom.addDisposableListener(this.slot, dom.EventType.MOUSE_OVER, e => this.light(e.target as HTMLElement)));
		this.draw.add(dom.addDisposableListener(this.slot, dom.EventType.MOUSE_LEAVE, () => this.light(undefined)));
		this.draw.add(dom.addDisposableListener(this.slot, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(e.target as HTMLElement).closest('.pt-tx, button')) {
				e.preventDefault();
				this.actions.send();
			}
		}));
		if (keepLine !== undefined) {
			this.slot.querySelector<HTMLElement>(`.pt-tx[data-i="${keepLine}"]`)?.focus();
		}
	}

	private chip(duration: number, video: string): HTMLElement {
		const row = dom.append(this.slot, $('.pt-chiprow'));
		const chip = dom.append(row, $('button.pt-vchip', { type: 'button', title: video }));
		dom.append(chip, $(`span${ThemeIcon.asCSSSelector(Codicon.deviceCameraVideo)}`, { 'aria-hidden': 'true' }));
		dom.append(chip, $('span.n', undefined, localize('dispatchPointTalk.video', "Screen recording")));
		dom.append(chip, $('span.m', undefined, clock(duration)));
		chip.setAttribute('aria-label', localize('dispatchPointTalk.videoLabel', "Screen recording, {0}: open it", clock(duration)));
		this.draw.add(dom.addDisposableListener(chip, dom.EventType.CLICK, e => {
			e.preventDefault();
			this.actions.openVideo();
		}));
		return row;
	}

	private light(target: HTMLElement | undefined): void {
		this.slot.querySelectorAll('.pt-th.hl, .pt-row.hl').forEach(x => x.classList.remove('hl'));
		const row = target?.closest<HTMLElement>('.pt-row[data-line]');
		const th = target?.closest<HTMLElement>('.pt-th[data-n]');
		const n = row?.dataset.line || th?.dataset.n;
		if (!n) {
			return;
		}
		this.slot.querySelectorAll(`.pt-th[data-n="${n}"], .pt-row[data-line="${n}"]`).forEach(x => x.classList.add('hl'));
	}

	focus(): void {
		this.slot.focus();
	}
}
