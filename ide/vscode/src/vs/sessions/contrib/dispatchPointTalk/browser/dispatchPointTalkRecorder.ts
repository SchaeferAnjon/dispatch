/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: one Point and talk recording (task-0y0km, kanban design/screen-talk direction A).
 *
 *  - The screen under the pointer and the microphone, from the sources the window hands in (the real ones in
 *    ../electron-browser, a test instance's in dispatchPointTalkTestSources.ts).
 *  - The video (screen and voice) and the voice alone are written to the recording's folder as they are recorded,
 *    a second at a time: a crash keeps what was recorded (Blurt's Recorder.swift writes in pieces for the same reason).
 *  - The voice goes to Soniox's real-time socket as it comes (a temporary key from dispatch-bridge: the person's own
 *    key never reaches this window), so the words show while you talk and are all there half a second after Stop.
 *    When the socket broke off, the voice file is transcribed whole after Stop (the async API, a few seconds).
 *  - The pointer is read ten times a second; still for a second marks a spot, and the screen at that moment is
 *    kept as the spot's picture (at most 1600 pixels wide).
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { VSBuffer, newWriteableBufferStream } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IPointTalkDisplay, IPointTalkRect } from '../../../../platform/dispatchPointTalk/common/dispatchPointTalk.js';
import { IRest, ISonioxToken, RestTracker, snapBox } from '../common/dispatchPointTalkModel.js';

/** The screen (one video track) and the microphone (one audio track) of a recording. */
export interface IPointTalkCapture {
	readonly screen: MediaStream;
	readonly mic: MediaStream;
	dispose(): void;
}

export interface IPointTalkSources {
	open(): Promise<IPointTalkCapture>;
	/** Where the pointer is, in screen points; undefined when it cannot be read. */
	pointer(): Promise<{ readonly x: number; readonly y: number } | undefined>;
}

/** A spot's picture: the screen when it was marked, at most {@link MAX_PICTURE} wide. */
export interface IPointTalkSpot {
	readonly rest: IRest;
	readonly bytes: Uint8Array;
	readonly size: [number, number];
	/** Picture pixels per screen point. */
	readonly scale: number;
	/** The thing under the pointer, in picture pixels, when its edges could be found. */
	readonly snapped?: [number, number, number, number];
}

export interface IPointTalkTake {
	readonly folder: URI;
	readonly video: URI;
	readonly audio: URI;
	/** Seconds. */
	readonly duration: number;
	readonly tokens: readonly ISonioxToken[];
	readonly rests: readonly IRest[];
	readonly spots: ReadonlyMap<number, IPointTalkSpot>;
	readonly display: IPointTalkDisplay;
	/** The words could not be had, live or afterwards: why. */
	readonly wordsError?: string;
}

/** What dispatch-bridge's `dispatch.pointTalk key` answers. */
interface IKeyAnswer {
	readonly ok: boolean;
	readonly key?: string;
	readonly url?: string;
	readonly model?: string;
	readonly languages?: string[];
	readonly message?: string;
}

const MAX_PICTURE = 1600;
const SAMPLE_MS = 100;

function pickVideoType(): string {
	for (const t of ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
		if (MediaRecorder.isTypeSupported(t)) {
			return t;
		}
	}
	return '';
}

/** Soniox's real-time socket: opened with a temporary key in the protocols list (a browser cannot set headers). */
class SonioxLive {

	private ws: WebSocket | undefined;
	private readonly queue: Blob[] = [];
	private opened = false;
	private readonly finished = new DeferredPromise<void>();
	error: string | undefined;
	final: ISonioxToken[] = [];
	pending: ISonioxToken[] = [];

	constructor(private readonly changed: () => void, private readonly logService: ILogService) { }

	async connect(key: () => Promise<IKeyAnswer>): Promise<void> {
		let ans: IKeyAnswer;
		try {
			ans = await key();
		} catch (e) {
			this.fail(`Dispatch could not get a key for Soniox: ${(e as Error).message}`);
			return;
		}
		if (!ans.ok || !ans.key || !ans.url) {
			this.fail(ans.message || 'Dispatch could not get a key for Soniox.');
			return;
		}
		if (this.finished.isSettled) {
			return; // stopped meanwhile
		}
		const ws = new WebSocket(ans.url, ['soniox-api-key', ans.key]);
		this.ws = ws;
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			ws.send(JSON.stringify({
				model: ans.model || 'stt-rt-v6',
				audio_format: 'auto',
				language_hints: ans.languages ?? [],
				enable_language_identification: true,
				client_reference_id: 'dispatch-point-talk',
			}));
			this.opened = true;
			for (const b of this.queue.splice(0)) {
				ws.send(b);
			}
		};
		ws.onmessage = ev => {
			let r: { tokens?: ISonioxToken[]; finished?: boolean; error_code?: number; error_message?: string };
			try {
				r = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
			} catch {
				return;
			}
			if (r.error_code) {
				this.fail(`Soniox ${r.error_code}: ${r.error_message ?? 'error'}`);
				return;
			}
			const toks = (r.tokens ?? []).filter(t => t.start_ms !== undefined || t.is_final);
			this.final.push(...toks.filter(t => t.is_final));
			this.pending = toks.filter(t => !t.is_final);
			this.changed();
			if (r.finished) {
				this.finished.complete();
			}
		};
		ws.onclose = ev => {
			if (!this.finished.isSettled) {
				this.fail(`The live words broke off (${ev.code}${ev.reason ? `: ${ev.reason}` : ''}).`);
			}
		};
		ws.onerror = () => {
			if (!this.finished.isSettled) {
				this.logService.warn('[dispatch] point and talk: Soniox socket error');
			}
		};
	}

	private fail(message: string): void {
		this.error ??= message;
		this.logService.warn(`[dispatch] point and talk: ${message}`);
		if (!this.finished.isSettled) {
			this.finished.complete();
		}
		this.changed();
	}

	send(chunk: Blob): void {
		if (this.error) {
			return;
		}
		if (this.opened && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(chunk);
		} else {
			this.queue.push(chunk);
		}
	}

	/** End of the voice: Soniox finalises what is left and says finished. True when all the words came. */
	async finish(timeoutMs: number): Promise<boolean> {
		if (this.error) {
			return false;
		}
		if (!this.ws) {
			// the key never came: nothing was sent
			this.fail('The live words never started.');
			return false;
		}
		const ws = this.ws;
		const end = () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send('');
			}
		};
		if (this.opened) {
			end();
		} else {
			ws.addEventListener('open', () => queueMicrotask(end), { once: true });
		}
		const timer = setTimeout(() => this.fail('Soniox did not finish the words in time.'), timeoutMs);
		await this.finished.p;
		clearTimeout(timer);
		ws.close();
		this.final.push(...this.pending);
		this.pending = [];
		return !this.error;
	}

	cancel(): void {
		if (!this.finished.isSettled) {
			this.finished.complete();
		}
		this.ws?.close();
	}
}

/** Chunks of a MediaRecorder written to a file as they come; `close()` waits for the last byte on disk. */
class FileSink {

	private readonly stream = newWriteableBufferStream();
	private readonly written: Promise<unknown>;
	/** Chunks go in in the order they came (reading a Blob is asynchronous). */
	private chain: Promise<unknown> = Promise.resolve();
	private failed: unknown;
	private closed = false;

	constructor(fileService: IFileService, readonly uri: URI, logService: ILogService) {
		this.written = fileService.writeFile(uri, this.stream).catch(e => {
			this.failed = e;
			logService.error(`[dispatch] point and talk: could not write ${uri.fsPath}`, e);
		});
	}

	write(blob: Blob): void {
		this.chain = this.chain.then(async () => {
			const bytes = new Uint8Array(await blob.arrayBuffer());
			if (!this.closed) {
				this.stream.write(VSBuffer.wrap(bytes));
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		await this.chain;
		this.closed = true;
		this.stream.end();
		await this.written;
		if (this.failed) {
			throw this.failed;
		}
	}
}

export interface IPointTalkRecordingOptions {
	readonly sources: IPointTalkSources;
	readonly folder: URI;
	readonly display: IPointTalkDisplay;
	/** Screen points where a rest marks nothing: the Agents window itself (its own button, its own box). */
	readonly ignore?: () => IPointTalkRect | undefined;
	readonly window: Window & typeof globalThis;
}

export class PointTalkRecording extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The clock, the level, the words or the spots moved. */
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidMarkSpot = this._register(new Emitter<IRest>());
	readonly onDidMarkSpot = this._onDidMarkSpot.event;

	readonly tracker = new RestTracker();
	readonly spots = new Map<number, IPointTalkSpot>();
	/** Five bar heights, 0 to 1. */
	level: number[] = [0, 0, 0, 0, 0];
	private startedAt = 0;
	private stoppedAt = 0;
	private capture: IPointTalkCapture | undefined;
	private videoRec: MediaRecorder | undefined;
	private audioRec: MediaRecorder | undefined;
	private videoFile: FileSink | undefined;
	private audioFile: FileSink | undefined;
	private live: SonioxLive | undefined;
	private video: HTMLVideoElement | undefined;
	private audioCtx: AudioContext | undefined;
	private analyser: AnalyserNode | undefined;
	private sampling = false;
	private grabbing: Promise<unknown> = Promise.resolve();
	private ended = false;
	videoUri: URI | undefined;
	readonly audioUri: URI;

	constructor(
		private readonly options: IPointTalkRecordingOptions,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.audioUri = joinPath(options.folder, 'audio.webm');
		this._register(toDisposable(() => this.release()));
	}

	/** Seconds since the recording started. */
	get elapsed(): number {
		return this.startedAt ? ((this.stoppedAt || performance.now()) - this.startedAt) / 1000 : 0;
	}

	get finalTokens(): readonly ISonioxToken[] {
		return this.live?.final ?? [];
	}

	get pendingTokens(): readonly ISonioxToken[] {
		return this.live?.pending ?? [];
	}

	/** The live words broke off (they are transcribed whole after Stop). */
	get liveError(): string | undefined {
		return this.live?.error;
	}

	/** The screen and the microphone are open, the files and the socket started. Throws when a source refuses. */
	async start(): Promise<void> {
		await this.fileService.createFolder(this.options.folder);
		this.capture = await this.options.sources.open();
		const win = this.options.window;
		// the audio graph before anything else awaits: it runs only while the click (or the shortcut) still counts
		this.audioCtx = new win.AudioContext();
		if (this.audioCtx.state === 'suspended') {
			void this.audioCtx.resume();
		}
		this.analyser = this.audioCtx.createAnalyser();
		this.analyser.fftSize = 256;
		this.audioCtx.createMediaStreamSource(this.capture.mic).connect(this.analyser);
		// a video element shows the screen to grab spots from (not attached to the page)
		const video = win.document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.srcObject = this.capture.screen;
		this.video = video;
		await video.play().catch(() => undefined);

		const type = pickVideoType();
		this.videoUri = joinPath(this.options.folder, type.startsWith('video/mp4') ? 'screen.mp4' : 'screen.webm');
		this.videoFile = new FileSink(this.fileService, this.videoUri, this.logService);
		this.audioFile = new FileSink(this.fileService, this.audioUri, this.logService);
		const both = new MediaStream([...this.capture.screen.getVideoTracks(), ...this.capture.mic.getAudioTracks()]);
		this.videoRec = new MediaRecorder(both, { mimeType: type || undefined, videoBitsPerSecond: 2_500_000 });
		this.audioRec = new MediaRecorder(this.capture.mic, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 });
		this.live = new SonioxLive(() => this._onDidChange.fire(), this.logService);
		this.videoRec.ondataavailable = e => {
			if (e.data.size) {
				this.videoFile?.write(e.data);
			}
		};
		this.audioRec.ondataavailable = e => {
			if (e.data.size) {
				this.live?.send(e.data);
				this.audioFile?.write(e.data);
			}
		};
		this.videoRec.start(1000);
		this.audioRec.start(250);
		this.startedAt = performance.now();
		void this.live.connect(() => this.commandService.executeCommand<IKeyAnswer>('dispatch.pointTalk', 'key') as Promise<IKeyAnswer>);
		for (const track of this.capture.screen.getVideoTracks()) {
			// the display went away (unplugged) or macOS stopped the capture: what was recorded stays
			track.addEventListener('ended', () => this._onDidChange.fire());
		}
		this.sampling = true;
		void this.sample();
		this.meter();
	}

	/** The display stopped (unplugged, or macOS took the capture back). */
	get interrupted(): boolean {
		return !!this.capture?.screen.getVideoTracks().some(t => t.readyState === 'ended') && !this.ended;
	}

	private async sample(): Promise<void> {
		const win = this.options.window;
		const d = this.options.display.bounds;
		while (this.sampling && !this.ended) {
			const at = performance.now();
			const p = await this.options.sources.pointer().catch(() => undefined);
			if (!this.sampling) {
				break;
			}
			const ignore = this.options.ignore?.();
			const inside = p && p.x >= d.x && p.y >= d.y && p.x < d.x + d.width && p.y < d.y + d.height
				&& !(ignore && p.x >= ignore.x && p.y >= ignore.y && p.x < ignore.x + ignore.width && p.y < ignore.y + ignore.height);
			const rest = this.tracker.push(inside ? { t: at - this.startedAt, x: p.x - d.x, y: p.y - d.y } : undefined);
			if (rest) {
				this.grabbing = this.grabbing.then(() => this.grab(rest)).catch(e => this.logService.warn('[dispatch] point and talk: a spot could not be grabbed', e));
				this._onDidMarkSpot.fire(rest);
				this._onDidChange.fire();
			}
			await new Promise(r => win.setTimeout(r, Math.max(10, SAMPLE_MS - (performance.now() - at))));
		}
	}

	private async grab(rest: IRest): Promise<void> {
		const video = this.video;
		if (!video || !video.videoWidth) {
			return;
		}
		const scale0 = video.videoWidth / this.options.display.bounds.width;
		const k = Math.min(1, MAX_PICTURE / video.videoWidth);
		const w = Math.round(video.videoWidth * k);
		const h = Math.round(video.videoHeight * k);
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.drawImage(video, 0, 0, w, h);
		const scale = scale0 * k;
		const snapped = snapBox(ctx.getImageData(0, 0, w, h).data, w, h, rest.x, rest.y, scale);
		const blob = await canvas.convertToBlob({ type: 'image/png' });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const spot: IPointTalkSpot = { rest, bytes, size: [w, h], scale, snapped };
		this.spots.set(rest.n, spot);
		await this.fileService.writeFile(joinPath(this.options.folder, `spot-${rest.n}.png`), VSBuffer.wrap(bytes)).catch(e => this.logService.warn('[dispatch] point and talk: a spot could not be saved', e));
	}

	private meter(): void {
		const analyser = this.analyser;
		const win = this.options.window;
		if (!analyser) {
			return;
		}
		const data = new Uint8Array(analyser.frequencyBinCount);
		const tick = () => {
			if (this.ended || !this.sampling) {
				return;
			}
			analyser.getByteFrequencyData(data);
			// five bands of the voice's range (bins of 187 Hz at 48 kHz): low to high
			const bands = [[1, 3], [3, 6], [6, 10], [10, 16], [16, 26]];
			this.level = bands.map(([a, b]) => {
				let sum = 0;
				for (let i = a; i < b; i++) {
					sum += data[i];
				}
				// byte dB values: quiet room about 60, speech 120 to 190
				return Math.max(0, Math.min(1, (sum / (b - a) - 70) / 130));
			});
			this._onDidChange.fire();
			win.setTimeout(tick, 120);
		};
		tick();
	}

	/** Stop: the files finished, the words in (live, or the voice file transcribed whole). */
	async stop(): Promise<IPointTalkTake> {
		this.sampling = false;
		this.stoppedAt = performance.now();
		const last = this.tracker.rests.at(-1);
		if (last && last.until < this.stoppedAt - this.startedAt) {
			last.until = Math.max(last.until, this.stoppedAt - this.startedAt);
		}
		await Promise.all([this.stopRecorder(this.videoRec), this.stopRecorder(this.audioRec)]);
		this.ended = true;
		await this.grabbing;
		await Promise.all([this.videoFile?.close(), this.audioFile?.close()]);
		this.capture?.dispose();
		const live = this.live;
		let tokens: ISonioxToken[] = [];
		let wordsError: string | undefined;
		if (live && await live.finish(8000)) {
			tokens = live.final;
		} else {
			this.logService.info(`[dispatch] point and talk: ${live?.error ?? 'no live words'}; transcribing the voice file`);
			const ans = await this.commandService.executeCommand<{ ok: boolean; tokens?: ISonioxToken[]; message?: string }>('dispatch.pointTalk', 'transcribe', { file: this.audioUri.fsPath });
			if (ans?.ok) {
				tokens = ans.tokens ?? [];
			} else {
				wordsError = ans?.message ?? live?.error ?? 'The words could not be transcribed.';
			}
		}
		return {
			folder: this.options.folder,
			video: this.videoUri!,
			audio: this.audioUri,
			duration: this.elapsed,
			tokens,
			rests: this.tracker.rests,
			spots: this.spots,
			display: this.options.display,
			wordsError,
		};
	}

	private stopRecorder(rec: MediaRecorder | undefined): Promise<void> {
		if (!rec || rec.state === 'inactive') {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			rec.addEventListener('stop', () => resolve(), { once: true });
			rec.requestData();
			rec.stop();
		});
	}

	/** Throw it all away: nothing kept, the folder removed. */
	async discard(): Promise<void> {
		this.sampling = false;
		this.ended = true;
		this.live?.cancel();
		for (const rec of [this.videoRec, this.audioRec]) {
			if (rec && rec.state !== 'inactive') {
				rec.ondataavailable = null;
				rec.stop();
			}
		}
		await Promise.allSettled([this.videoFile?.close(), this.audioFile?.close()]);
		this.release();
		await this.fileService.del(this.options.folder, { recursive: true }).catch(() => undefined);
	}

	private release(): void {
		this.sampling = false;
		this.capture?.dispose();
		this.capture = undefined;
		if (this.video) {
			this.video.srcObject = null;
			this.video = undefined;
		}
		void this.audioCtx?.close().catch(() => undefined);
		this.audioCtx = undefined;
		this.live?.cancel();
	}
}
