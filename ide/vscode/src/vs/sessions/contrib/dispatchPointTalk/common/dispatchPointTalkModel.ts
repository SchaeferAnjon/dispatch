/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk worked out without the window (direction A「Button by the input」, the person picked
 *  it 2026-11-16, task-0y0km; kanban design/screen-talk). The recorder (../browser/dispatchPointTalkRecorder.ts) and
 *  the input box (../browser/dispatchPointTalkInput.ts) use it; ide/tests/point-talk.test.mjs tests it. No imports:
 *  Node runs this file as it is.
 *
 *  - where the pointer rested: still for about a second marks a spot (once, until it moves on);
 *  - the words: Soniox's tokens put into sentences, the way Blurt does it (soniox_segments in
 *    skills/blurt/scripts/transcribe.py, MIT, see NOTICE): punctuation is timed at the next word, so a mark stays with
 *    the words before it and pauses are measured from the last word;
 *  - which spots become keyframes: each sentence keeps the spot it was said over, numbered in time order;
 *  - the message the agent gets, and reading it back for the bubble.
 *--------------------------------------------------------------------------------------------*/

/** Still this long (ms) marks a spot. */
export const REST_MS = 1000;
/** How far (points) the pointer may wander and still be resting. */
export const REST_RADIUS = 6;
/** After a spot, the pointer has to move this far (points) before it can mark another. */
export const LEAVE_RADIUS = 24;
/** At most this many keyframes go with one message. */
export const MAX_FRAMES = 8;
/** The red box round a spot, in points: what a pointer usually rests on (a button, a field, a line). */
export const SPOT_BOX: readonly [number, number] = [160, 72];

/** m:ss, the way the design writes times ("0:07", "1:05"). */
export function clock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- where the pointer rested

/** A pointer sample in points, relative to the recorded display's top left; `t` in ms since recording started. */
export interface IPointerSample {
	readonly t: number;
	readonly x: number;
	readonly y: number;
}

export interface IRest {
	/** In the order they were marked, from 1. */
	readonly n: number;
	/** When the pointer came to rest (ms). */
	readonly t: number;
	/** When it moved on, or the recording ended (ms); grows while it rests. */
	until: number;
	readonly x: number;
	readonly y: number;
}

/**
 * Marks a spot when the pointer has been still for {@link REST_MS}, once per stop: it has to move
 * {@link LEAVE_RADIUS} away from the last spot before it can mark another. Samples outside the display (undefined)
 * break a rest.
 */
export class RestTracker {

	private anchor: IPointerSample | undefined;
	private last: IRest | undefined;
	private armed = true;
	readonly rests: IRest[] = [];

	push(s: IPointerSample | undefined): IRest | undefined {
		if (!s) {
			this.anchor = undefined;
			return undefined;
		}
		const last = this.last;
		if (last && !this.armed && Math.hypot(s.x - last.x, s.y - last.y) > LEAVE_RADIUS) {
			this.armed = true;
		}
		if (!this.anchor || Math.hypot(s.x - this.anchor.x, s.y - this.anchor.y) > REST_RADIUS) {
			if (last && last.until < s.t && !this.armed) {
				last.until = s.t;
			}
			this.anchor = s;
			return undefined;
		}
		if (last && !this.armed) {
			last.until = s.t;
		}
		if (this.armed && s.t - this.anchor.t >= REST_MS) {
			const rest: IRest = { n: this.rests.length + 1, t: this.anchor.t, until: s.t, x: this.anchor.x, y: this.anchor.y };
			this.rests.push(rest);
			this.last = rest;
			this.armed = false;
			return rest;
		}
		return undefined;
	}
}

// ---------------------------------------------------------------- the words

export interface ISonioxToken {
	readonly text: string;
	readonly start_ms?: number;
	readonly end_ms?: number;
	readonly is_final?: boolean;
	readonly language?: string;
	readonly translation_status?: string;
}

/** A sentence: ms from the start of the recording. */
export interface ISentence {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

const ENDS = '。？！?!.';
const MARKS = ENDS + '，、,；;：:';

/**
 * Soniox's tokens as sentences (Blurt's soniox_segments): a sentence end closes one at a pause of 0.6 s (or past 8 s),
 * a comma at 1.5 s, anything at 3 s or 28 s. A token that is only punctuation stays with the words before it.
 */
export function sentencesOf(tokens: readonly ISonioxToken[]): ISentence[] {
	const out: ISentence[] = [];
	let cur: ISonioxToken[] = [];
	let wordEnd = 0;
	const close = () => {
		const text = tidyText(cur.map(t => t.text).join(''));
		if (text) {
			out.push({ start: cur[0].start_ms ?? 0, end: Math.max(wordEnd, cur[0].end_ms ?? 0), text });
		}
		cur = [];
	};
	for (const tok of tokens) {
		if (tok.translation_status === 'translation' || tok.start_ms === undefined) {
			continue;
		}
		const word = tok.text.trim();
		const punct = !!word && [...word].every(c => MARKS.includes(c));
		if (cur.length && punct) {
			cur.push(tok);
			continue;
		}
		if (cur.length && word) {
			const gap = (tok.start_ms - wordEnd) / 1000;
			const length = (wordEnd - (cur[0].start_ms ?? 0)) / 1000;
			// a space can come as a token of its own: the last character of the words so far
			const lastChar = cur.map(t => t.text).join('').trim().slice(-1);
			if (gap >= 3 || length >= 28 || (lastChar && ENDS.includes(lastChar) && (gap >= 0.6 || length >= 8)) || (lastChar && MARKS.includes(lastChar) && gap >= 1.5)) {
				close();
			}
		}
		cur.push(tok);
		if (word && !punct) {
			wordEnd = tok.end_ms ?? tok.start_ms;
		}
	}
	if (cur.length) {
		close();
	}
	return out;
}

/** The words so far while recording: the final ones, then the ones Soniox may still change. */
export function liveWords(final: readonly ISonioxToken[], pending: readonly ISonioxToken[]): string {
	return [...final, ...pending].filter(t => t.translation_status !== 'translation').map(t => t.text).join('').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- keyframes

/** One line of the transcript: when the sentence starts (s), the words, its keyframe's number if it has one. */
export interface ILine {
	readonly t: number;
	text: string;
	n?: number;
}

/** A spot that became a keyframe. */
export interface IPickedFrame {
	readonly n: number;
	/** The spot it came from (its number in the recording). */
	readonly rest: number;
	/** Shown on the frame: its sentence's start, else when the pointer came to rest (s). */
	readonly t: number;
	/** The sentence it goes with (its index in `lines`), when it has one. */
	readonly line: number | undefined;
	readonly x: number;
	readonly y: number;
}

/** The sentence a spot was pointed at during: said while resting, else starting soon after, else just ended. */
function sentenceFor(rest: IRest, sentences: readonly ISentence[]): number | undefined {
	const during = sentences.findIndex(s => s.start - 300 <= rest.until && rest.t <= s.end + 600);
	if (during >= 0) {
		// several: the one that overlaps the rest most
		let best = during;
		let bestOverlap = -Infinity;
		sentences.forEach((s, i) => {
			const overlap = Math.min(s.end, rest.until) - Math.max(s.start, rest.t);
			if (s.start - 300 <= rest.until && rest.t <= s.end + 600 && overlap > bestOverlap) {
				best = i;
				bestOverlap = overlap;
			}
		});
		return best;
	}
	const after = sentences.findIndex(s => s.start >= rest.t && s.start - rest.until <= 2000);
	if (after >= 0) {
		return after;
	}
	for (let i = sentences.length - 1; i >= 0; i--) {
		if (sentences[i].end <= rest.t && rest.t - sentences[i].end <= 2000) {
			return i;
		}
	}
	return undefined;
}

/**
 * The keyframes and the lines, once the words are in: each sentence keeps one spot (the one rested on longest), spots
 * nobody spoke over stay as frames without a line, at most {@link MAX_FRAMES} (those with words first, then the
 * longest rests); numbered 1… in time order, and each line carries its frame's number.
 */
export function pickFrames(rests: readonly IRest[], sentences: readonly ISentence[], max = MAX_FRAMES): { frames: IPickedFrame[]; lines: ILine[] } {
	const bySentence = new Map<number, IRest>();
	const loose: IRest[] = [];
	for (const r of rests) {
		const i = sentenceFor(r, sentences);
		if (i === undefined) {
			loose.push(r);
			continue;
		}
		const had = bySentence.get(i);
		if (!had || r.until - r.t >= had.until - had.t) {
			bySentence.set(i, r);
		}
	}
	const chosen: { rest: IRest; line: number | undefined }[] = [...bySentence.entries()].map(([line, rest]) => ({ rest, line }));
	const longest = (a: IRest, b: IRest) => (b.until - b.t) - (a.until - a.t);
	chosen.sort((a, b) => longest(a.rest, b.rest));
	loose.sort(longest);
	const kept = [...chosen, ...loose.map(rest => ({ rest, line: undefined }))].slice(0, Math.max(0, max));
	kept.sort((a, b) => a.rest.t - b.rest.t);
	const lines: ILine[] = sentences.map(s => ({ t: s.start / 1000, text: s.text }));
	const frames = kept.map((k, i): IPickedFrame => {
		const n = i + 1;
		if (k.line !== undefined) {
			lines[k.line].n = n;
		}
		return { n, rest: k.rest.n, t: k.line !== undefined ? sentences[k.line].start / 1000 : k.rest.t / 1000, line: k.line, x: k.rest.x, y: k.rest.y };
	});
	return { frames, lines };
}

/** The red box round a spot in picture pixels (`scale` pixels per point), kept inside the picture. */
export function spotBox(x: number, y: number, scale: number, picture: readonly [number, number]): [number, number, number, number] {
	const w = Math.min(SPOT_BOX[0] * scale, picture[0]);
	const h = Math.min(SPOT_BOX[1] * scale, picture[1]);
	const left = Math.min(Math.max(0, x * scale - w / 2), picture[0] - w);
	const top = Math.min(Math.max(0, y * scale - h / 2), picture[1] - h);
	return [Math.round(left), Math.round(top), Math.round(w), Math.round(h)];
}

/**
 * The red box snapped to what the pointer rests on (designer review, task-0y0km): the region of one colour round a
 * point just above and left of the pointer's tip (the arrow itself is below and right of it), filled within
 * `tolerance`, as long as it stays smaller than {@link SNAP_MAX} points; its bounding box plus 4 points. A region that
 * runs into the search window's edge is the page's background, not a thing: undefined, and the fixed box is used.
 * `rgba` is the picture's pixels (`width` × `height`), `scale` picture pixels per point.
 */
export const SNAP_MAX: readonly [number, number] = [480, 160];
export function snapBox(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, x: number, y: number, scale: number, tolerance = 22): [number, number, number, number] | undefined {
	const sx = Math.round((x - 3) * scale);
	const sy = Math.round((y - 3) * scale);
	if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
		return undefined;
	}
	const hw = Math.round(SNAP_MAX[0] * scale / 2);
	const hh = Math.round(SNAP_MAX[1] * scale / 2);
	const x0 = Math.max(0, sx - hw), x1 = Math.min(width - 1, sx + hw);
	const y0 = Math.max(0, sy - hh), y1 = Math.min(height - 1, sy + hh);
	const at = (px: number, py: number) => (py * width + px) * 4;
	const s = at(sx, sy);
	const r0 = rgba[s], g0 = rgba[s + 1], b0 = rgba[s + 2];
	const seen = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
	const stack = [sx, sy];
	let minX = sx, maxX = sx, minY = sy, maxY = sy;
	while (stack.length) {
		const py = stack.pop()!;
		const px = stack.pop()!;
		if (px < x0 || px > x1 || py < y0 || py > y1) {
			continue;
		}
		const k = (py - y0) * (x1 - x0 + 1) + (px - x0);
		if (seen[k]) {
			continue;
		}
		seen[k] = 1;
		const i = at(px, py);
		if (Math.abs(rgba[i] - r0) + Math.abs(rgba[i + 1] - g0) + Math.abs(rgba[i + 2] - b0) > tolerance) {
			continue;
		}
		if (px === x0 || px === x1 || py === y0 || py === y1) {
			// it runs off the window: the background, not a thing
			if ((px === x0 && x0 > 0) || (px === x1 && x1 < width - 1) || (py === y0 && y0 > 0) || (py === y1 && y1 < height - 1)) {
				return undefined;
			}
		}
		minX = Math.min(minX, px); maxX = Math.max(maxX, px);
		minY = Math.min(minY, py); maxY = Math.max(maxY, py);
		stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
	}
	const pad = 4 * scale;
	const w = maxX - minX + 1, h = maxY - minY + 1;
	if (w < 12 * scale || h < 10 * scale) {
		return undefined; // a letter or a line, not a thing
	}
	const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
	return [Math.round(left), Math.round(top), Math.round(Math.min(width, maxX + 1 + pad) - left), Math.round(Math.min(height, maxY + 1 + pad) - top)];
}

/** A sentence as it is shown and sent: no space before Chinese punctuation or between Chinese characters. */
export function tidyText(text: string): string {
	return text.replace(/\s+([，。！？、；：）」』])/g, '$1').replace(/([\u3400-\u9fff，。！？、；：（「『])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
}

// ---------------------------------------------------------------- the message

/** What a Point and talk message holds, as the bubble reads it back from the text. */
export interface IPointTalkText {
	/** What was typed in the box before recording, if anything. */
	readonly note: string;
	readonly duration: number;
	readonly lines: readonly ILine[];
	/** The recording's folder: the video, the keyframes (frame-<n>.png) and take.json. */
	readonly folder: string;
	readonly video: string;
}

export const POINT_TALK_HEAD = 'Point and talk';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** A line typed over several lines, as one: no space where a line break meets Chinese or Japanese. */
export function oneLine(text: string): string {
	return text.trim().replace(/\s*\n\s*/g, (_m, at: number, all: string) => {
		const before = all.slice(0, at).trimEnd().slice(-1);
		const after = all.slice(at).trimStart().slice(0, 1);
		return CJK.test(before) || CJK.test(after) ? '' : ' ';
	});
}
const LINE = /^(?:\[(\d+)\] )?(\d+:\d{2}) (.*)$/;

/**
 * The message the agent gets: the head says what it is and how to read it; one line per sentence with when it
 * starts, a keyframe's number in brackets; then where the video is. The keyframes go along as pictures, each with its
 * red box and the sentence (the draw-and-ask attachment every engine reads).
 */
export function composeMessage(take: IPointTalkText): string {
	const framed = take.lines.some(l => l.n !== undefined);
	const head = `${POINT_TALK_HEAD} · ${clock(take.duration)} screen recording. What I said, with when I said it`
		+ (framed ? '; [n] is the attached keyframe with the same number, its red box is where my pointer rested:' : ':');
	const lines = take.lines.filter(l => l.text.trim()).map(l => `${l.n !== undefined ? `[${l.n}] ` : ''}${clock(l.t)} ${oneLine(l.text)}`);
	const parts = [head, ...(lines.length ? lines : ['(nothing was said)']), `Video: ${take.video}`];
	return (take.note.trim() ? take.note.trim() + '\n\n' : '') + parts.join('\n');
}

/** A Point and talk message read back from its text, or undefined when it is not one. */
export function parseMessage(text: string): IPointTalkText | undefined {
	const all = text.replace(/\r\n/g, '\n').split('\n');
	const at = all.findIndex(l => l.startsWith(`${POINT_TALK_HEAD} · `));
	if (at < 0) {
		return undefined;
	}
	const dur = /^Point and talk · (\d+):(\d{2}) screen recording\./.exec(all[at]);
	if (!dur) {
		return undefined;
	}
	const lines: ILine[] = [];
	let video = '';
	for (const raw of all.slice(at + 1)) {
		const l = raw.trim();
		if (l.startsWith('Video: ')) {
			video = l.slice('Video: '.length).trim();
			continue;
		}
		const m = LINE.exec(l);
		if (m) {
			const [mm, ss] = m[2].split(':').map(Number);
			lines.push({ t: mm * 60 + ss, text: m[3], n: m[1] ? Number(m[1]) : undefined });
		}
	}
	if (!video) {
		return undefined;
	}
	const slash = video.lastIndexOf('/');
	return { note: all.slice(0, at).join('\n').trim(), duration: Number(dur[1]) * 60 + Number(dur[2]), lines, video, folder: slash > 0 ? video.slice(0, slash) : '' };
}
