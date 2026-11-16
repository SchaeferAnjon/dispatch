/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk's sources in a test instance (DISPATCH_E2E_INSTANCE, task-0y0km). A test never
 *  records the person's screen or microphone and never opens macOS's dialogs; the scenario hands in a take instead:
 *
 *  - the screen: a checkout page drawn on a canvas (the design's example, kanban design/screen-talk), with the
 *    pointer drawn where the take says it is;
 *  - the voice: a sound file (a WAV of real speech), played into the microphone track and nowhere else;
 *  - the pointer: the take's path, in the recorded display's points;
 *  - what macOS would say about the two permissions, and whether a Soniox key is there.
 *
 *  Everything after the sources is the real thing: the recorders, the files, Soniox's socket, the spots.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import type { IPointTalkDisplay, PointTalkAccessState } from '../../../../platform/dispatchPointTalk/common/dispatchPointTalk.js';
import { IPointTalkCapture, IPointTalkSources } from './dispatchPointTalkRecorder.js';

export interface IPointTalkTestTake {
	/** A sound file of the words (WAV, M4A …): the microphone. */
	readonly audio?: string;
	/** The pointer over time (ms from the start), in the recorded display's points. */
	readonly pointer?: readonly { readonly t: number; readonly x: number; readonly y: number }[];
	/** The display the take is on; Dispatch is on another one when `elsewhere` (the bar and the frame show). */
	readonly display?: IPointTalkDisplay;
	readonly elsewhere?: boolean;
	readonly access?: { readonly microphone?: PointTalkAccessState; readonly screen?: PointTalkAccessState; readonly relaunch?: boolean };
	/** False: as if SONIOX_API_KEY were not in the key store. */
	readonly key?: boolean;
}

/** What the scenario set, and what the window did because of it (for the scenario to read back). */
export const pointTalkTest: { take: IPointTalkTestTake | undefined; events: string[] } = { take: undefined, events: [] };

export const TEST_DISPLAY: IPointTalkDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1 };

/** The checkout page of the design's example, drawn at the display's size. */
function drawPage(ctx: CanvasRenderingContext2D, w: number, h: number, paying: boolean): void {
	ctx.fillStyle = '#e9e6e2';
	ctx.fillRect(0, 0, w, h);
	// the browser window
	const bx = 40, by = 60, bw = Math.min(900, w - 80), bh = Math.min(700, h - 100);
	ctx.fillStyle = '#ffffff';
	ctx.strokeStyle = '#e7e5e4';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(bx, by, bw, bh, 10);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = '#fafaf9';
	ctx.fillRect(bx + 1, by + 1, bw - 2, 37);
	ctx.fillStyle = '#79716b';
	ctx.font = '12px -apple-system, sans-serif';
	ctx.fillText('localhost:5173/checkout', bx + bw / 2 - 70, by + 24);
	const px = bx + 48, py = by + 38;
	ctx.fillStyle = '#0c0a09';
	ctx.font = '600 22px -apple-system, sans-serif';
	ctx.fillText('Larder', px + 26, py + 58);
	ctx.strokeStyle = '#3b6fd8';
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(px + 9, py + 51, 8, 0, Math.PI * 2);
	ctx.stroke();
	ctx.fillStyle = '#79716b';
	ctx.font = '12px -apple-system, sans-serif';
	ctx.fillText('Ship to', px, py + 108);
	ctx.strokeStyle = '#e7e5e4';
	ctx.lineWidth = 1;
	ctx.strokeRect(px, py + 118, 240, 36);
	ctx.fillStyle = '#0c0a09';
	ctx.font = '14px -apple-system, sans-serif';
	ctx.fillText('Canada', px + 12, py + 141);
	[['Oat milk ×2', '$7.80'], ['Coffee beans', '$14.50'], ['Sourdough', '$6.20']].forEach(([n, p], i) => {
		const y = py + 186 + i * 64;
		ctx.fillStyle = '#f2f1f0';
		ctx.fillRect(px, y, 44, 44);
		ctx.fillStyle = '#0c0a09';
		ctx.font = '500 14px -apple-system, sans-serif';
		ctx.fillText(n, px + 56, y + 18);
		ctx.fillStyle = '#79716b';
		ctx.font = '12px -apple-system, sans-serif';
		ctx.fillText(p, px + 56, y + 36);
	});
	const sx = px + 422, sy = py + 96;
	ctx.fillStyle = '#fafaf9';
	ctx.strokeStyle = '#e7e5e4';
	ctx.beginPath();
	ctx.roundRect(sx, sy, 340, 300, 10);
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = '#0c0a09';
	ctx.font = '600 16px -apple-system, sans-serif';
	ctx.fillText('Summary', sx + 22, sy + 40);
	ctx.font = '14px -apple-system, sans-serif';
	[['Subtotal', '$28.50'], ['Shipping', '$15.40']].forEach(([a, b], i) => {
		ctx.fillText(a, sx + 22, sy + 76 + i * 28);
		ctx.fillText(b, sx + 270, sy + 76 + i * 28);
	});
	ctx.font = '600 18px -apple-system, sans-serif';
	ctx.fillText('Total', sx + 22, sy + 150);
	ctx.fillText('$43.90', sx + 252, sy + 150);
	ctx.fillStyle = '#3b6fd8';
	ctx.beginPath();
	ctx.roundRect(sx + 22, sy + 236, 296, 42, 8);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = '500 15px -apple-system, sans-serif';
	ctx.fillText(paying ? '◌  Pay now' : 'Pay now', sx + 138, sy + 263);
}

function drawPointer(ctx: CanvasRenderingContext2D, x: number, y: number): void {
	ctx.save();
	ctx.translate(x, y);
	ctx.beginPath();
	ctx.moveTo(0, 0);
	ctx.lineTo(0, 18);
	ctx.lineTo(5, 13.5);
	ctx.lineTo(8.5, 21);
	ctx.lineTo(11.5, 19.6);
	ctx.lineTo(8, 12.2);
	ctx.lineTo(14.5, 12.2);
	ctx.closePath();
	ctx.fillStyle = '#000';
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 1.4;
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}

/** Where the take's pointer is `t` ms in: the last point at or before it. */
function pointerAt(take: IPointTalkTestTake, t: number): { x: number; y: number } | undefined {
	const path = take.pointer ?? [];
	let at: { x: number; y: number } | undefined;
	for (const p of path) {
		if (p.t <= t) {
			at = p;
		}
	}
	return at ?? path[0];
}

export class PointTalkTestSources implements IPointTalkSources {

	private started = 0;

	constructor(private readonly take: IPointTalkTestTake, private readonly window: Window & typeof globalThis, private readonly fileService: IFileService) { }

	get display(): IPointTalkDisplay {
		return this.take.display ?? TEST_DISPLAY;
	}

	async open(): Promise<IPointTalkCapture> {
		const win = this.window;
		const { width, height } = this.display.bounds;
		const canvas = win.document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d')!;
		const audioCtx = new win.AudioContext();
		await audioCtx.resume().catch(() => undefined);
		const dest = audioCtx.createMediaStreamDestination();
		let source: AudioBufferSourceNode | undefined;
		if (this.take.audio) {
			const bytes = (await this.fileService.readFile(URI.file(this.take.audio))).value.buffer;
			const buffer = await audioCtx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
			const node = audioCtx.createBufferSource();
			node.buffer = buffer;
			node.connect(dest);
			source = node;
		} else {
			// silence still makes a track
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			gain.gain.value = 0;
			osc.connect(gain).connect(dest);
			osc.start();
		}
		this.started = performance.now();
		source?.start();
		const draw = () => {
			const t = performance.now() - this.started;
			drawPage(ctx, width, height, t > 7000);
			const p = pointerAt(this.take, t);
			if (p) {
				drawPointer(ctx, p.x, p.y);
			}
		};
		draw();
		const timer = win.setInterval(draw, 100);
		const screen = canvas.captureStream(10);
		pointTalkTest.events.push('open');
		return {
			screen,
			mic: dest.stream,
			dispose: () => {
				win.clearInterval(timer);
				screen.getTracks().forEach((t: MediaStreamTrack) => t.stop());
				dest.stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
				try {
					source?.stop();
				} catch {
					// already ended
				}
				void audioCtx.close().catch(() => undefined);
			},
		};
	}

	async pointer(): Promise<{ x: number; y: number } | undefined> {
		if (!this.started) {
			return undefined;
		}
		const p = pointerAt(this.take, performance.now() - this.started);
		const b = this.display.bounds;
		return p ? { x: b.x + p.x, y: b.y + p.y } : undefined;
	}
}
