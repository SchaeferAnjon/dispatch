/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk in the Agents window (direction A「Button by the input」, the person picked it
 *  2026-11-16, task-0y0km; kanban design/screen-talk). A camera in the message box (or ⌃⇧S anywhere) records the
 *  display under the pointer and your voice: no picker, no app or project to choose. While it records, the box shows
 *  it; when Dispatch is not in sight on that display, a bar at its top does (B's bar, borrowed). Stopped, it comes
 *  back to the box: keyframes where the pointer rested, the video, the words line by line with their times; remove
 *  a frame, change a line, send. The agent gets the words with their times and each keyframe with its red box.
 *
 *  This file wires it: the real sources (the main process picks the display, getDisplayMedia records it, the
 *  microphone, the pointer), the state of the window's one recording, the cards for what is missing, the system-wide
 *  shortcut, the bar and the frame. The parts: ../browser (recorder, box, cards, the sent message), ../common (the
 *  pure model), platform/dispatchPointTalk (the main process).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FocusMode, INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { DispatchMarksMetadataKey, IDispatchMarksMetadata, readDispatchMarksMeta } from '../../../../platform/agentHost/common/meta/dispatchMarksAttachmentMeta.js';
import { DISPATCH_POINT_TALK_CHANNEL, IDispatchPointTalkMainService, IPointTalkAccess, IPointTalkDisplay, IPointTalkPrepared, IPointTalkTheme } from '../../../../platform/dispatchPointTalk/common/dispatchPointTalk.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatExecuteActionContext } from '../../../../workbench/contrib/chat/browser/actions/chatExecuteActions.js';
import { setDispatchChatPictureHooks } from '../../../../workbench/contrib/chat/browser/attachments/dispatchChatPictureHooks.js';
import { IChatRequestVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { dispatchBlobUrl, dispatchDrawInputController, rememberDispatchOriginal } from '../../dispatchDraw/browser/dispatchDrawInput.js';
import { burnDispatchMarks } from '../../dispatchDraw/browser/dispatchDrawTool.js';
import { onDidChangeDispatchKeys } from '../../dispatchSettings/browser/dispatchSettingsKeysToast.js';
import { clock, composeMessage, ILine, liveWords, pickFrames, sentencesOf, spotBox } from '../common/dispatchPointTalkModel.js';
import { IPointTalkPermissionState, PointTalkCard } from '../browser/dispatchPointTalkCards.js';
import { IPointTalkReviewFrame, PointTalkInputSlot } from '../browser/dispatchPointTalkInput.js';
import { IPointTalkSavedTake, POINT_TALK_FRAME_META, PointTalkMessages } from '../browser/dispatchPointTalkMessage.js';
import { IPointTalkCapture, IPointTalkSources, IPointTalkTake, PointTalkRecording } from '../browser/dispatchPointTalkRecorder.js';
import { IPointTalkTestTake, pointTalkTest, PointTalkTestSources, TEST_DISPLAY } from '../browser/dispatchPointTalkTestSources.js';

const TOGGLE = 'dispatch.pointTalk.toggle';
const STOP = 'dispatch.pointTalk.stop';
/** The key Point and talk needs, and what Keys says it is for when the card's Open Keys adds it. */
const SONIOX_KEY = 'SONIOX_API_KEY';
const SONIOX_NOTE = 'Point and talk speech recognition (Soniox)';

/** The real screen and microphone: the main process picked the display under the pointer just before. */
class RealSources implements IPointTalkSources {

	constructor(private readonly nativeHostService: INativeHostService) { }

	async open(): Promise<IPointTalkCapture> {
		const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
		let mic: MediaStream;
		try {
			mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (e) {
			screen.getTracks().forEach(t => t.stop());
			throw e;
		}
		return {
			screen,
			mic,
			dispose: () => {
				screen.getTracks().forEach(t => t.stop());
				mic.getTracks().forEach(t => t.stop());
			},
		};
	}

	async pointer(): Promise<{ x: number; y: number } | undefined> {
		return (await this.nativeHostService.getCursorScreenPoint()).point;
	}
}

interface IFrameState extends IPointTalkReviewFrame {
	/** Its attachment in the box (the picture with the box burned in, for the agent). */
	entryId: string;
	/** The spot's own picture and its pixels per point, to draw on again. */
	readonly file: string;
	readonly scale: number;
	/** Drawn on with the pen: the attachment's picture is what shows (its boxes are burned in). */
	drawnUrl?: string;
}

interface IReview {
	readonly take: IPointTalkTake;
	readonly note: string;
	frames: IFrameState[];
	lines: ILine[];
	readonly store: DisposableStore;
}

interface IRecordingState {
	readonly widget: IChatWidget;
	readonly recording: PointTalkRecording;
	readonly slot: PointTalkInputSlot;
	readonly prepared: IPointTalkPrepared;
	readonly note: string;
	readonly store: DisposableStore;
	bar: boolean;
	stopping: boolean;
}

function today(): { day: string; time: string } {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
}

class DispatchPointTalkController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchPointTalk';

	private readonly main: IDispatchPointTalkMainService;
	private test = false;
	private recordingsRoot = '';
	private rec: IRecordingState | undefined;
	private starting = false;
	private readonly reviews = new Map<string, IReview>();
	/** The review drawn in a box right now, and the box's slot. */
	private shown: { widget: IChatWidget; slot: PointTalkInputSlot; review: IReview; store: DisposableStore } | undefined;
	private card: { widget: IChatWidget; card: PointTalkCard; timer: number; wants: 'start' | 'none'; sim?: IPointTalkPermissionState; keyWatch?: IDisposable } | undefined;
	private readonly messages: PointTalkMessages;
	private shortcutWarned = false;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IThemeService private readonly themeService: IThemeService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.main = ProxyChannel.toService<IDispatchPointTalkMainService>(mainProcessService.getChannel(DISPATCH_POINT_TALK_CHANNEL));
		controller = this;
		this._register(toDisposable(() => controller = controller === this ? undefined : controller));
		this.messages = this._register(new PointTalkMessages(fileService, path => this.openVideo(path)));
		this._register(setDispatchChatPictureHooks({
			decorateImageAttachment: ctx => this.messages.decorateImage(ctx),
			decorateRequest: ctx => this.messages.decorateRequest(ctx),
		}));
		void this.main.access().then(a => {
			this.test = a.test;
			this.recordingsRoot = a.recordings;
			if (a.test) {
				// the scenario hands in a take here and reads back what the window did
				(mainWindow as unknown as { __dispatchPointTalkTest?: unknown }).__dispatchPointTalkTest = {
					configure: (take: IPointTalkTestTake) => { pointTalkTest.take = take; pointTalkTest.events.length = 0; },
					set: (patch: Partial<IPointTalkTestTake>) => { pointTalkTest.take = { ...(pointTalkTest.take ?? {}), ...patch }; },
					events: () => pointTalkTest.events.slice(),
					state: () => this.describe(),
				};
			}
			this.syncShortcut();
		});
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.syncShortcut()));
		this._register(this.chatWidgetService.onDidAddWidget(w => this.watchWidget(w)));
		for (const w of this.chatWidgetService.getAllWidgets()) {
			this.watchWidget(w);
		}
		this._register(toDisposable(() => {
			void this.rec?.recording.discard();
			this.rec?.store.dispose();
			this.hideCard();
			this.hideShown();
			for (const r of this.reviews.values()) {
				r.store.dispose();
			}
		}));
	}

	// ---------------------------------------------------------------- the shortcut

	private syncShortcut(): void {
		const kb = this.keybindingService.lookupKeybinding(TOGGLE);
		const accelerator = kb?.getElectronAccelerator() ?? undefined;
		void this.main.setShortcut(mainWindow.vscodeWindowId, accelerator ?? undefined).then(ok => {
			if (!ok && accelerator && !this.test && !this.shortcutWarned) {
				this.shortcutWarned = true;
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('dispatchPointTalk.shortcutTaken', "{0} is taken by macOS or another app, so Point and talk's shortcut works only while Dispatch is in front.", kb?.getLabel() ?? accelerator),
				});
			}
		});
	}

	// ---------------------------------------------------------------- which box

	private widgetFor(context: IChatExecuteActionContext | undefined): IChatWidget | undefined {
		const fromToolbar = context?.widget;
		if (fromToolbar && fromToolbar.input?.element?.isConnected) {
			return fromToolbar;
		}
		const session = this.sessionsService.activeSession.get();
		const widget = session && this.chatWidgetService.getWidgetBySessionResource(session.mainChat.get().resource);
		return widget?.input?.element?.isConnected ? widget : undefined;
	}

	private boxOf(widget: IChatWidget): HTMLElement | undefined {
		return widget.input.element.querySelector<HTMLElement>('.chat-input-container') ?? undefined;
	}

	private sessionOf(widget: IChatWidget): string | undefined {
		return widget.viewModel?.sessionResource.toString();
	}

	private watchWidget(widget: IChatWidget): void {
		this._register(widget.onDidChangeViewModel(() => this.showReviewFor(widget)));
		this._register(widget.onDidAcceptInput(() => this.sent(widget)));
	}

	// ---------------------------------------------------------------- start and stop

	async toggle(context?: IChatExecuteActionContext): Promise<void> {
		if (this.rec) {
			if (!this.rec.stopping) {
				await this.stop();
			}
			return;
		}
		if (this.starting) {
			return;
		}
		const widget = this.widgetFor(context);
		if (!widget) {
			this.notificationService.info(localize('dispatchPointTalk.noSession', "Open a session first: Point and talk sends to the session that is open."));
			return;
		}
		const session = this.sessionOf(widget);
		if (session && this.reviews.has(session)) {
			this.shown?.slot.focus();
			return;
		}
		this.starting = true;
		try {
			if (!await this.hasKey()) {
				this.showCard(widget, 'key');
				return;
			}
			const access = await this.access();
			if (access.microphone !== 'granted' || access.screen !== 'granted' || access.relaunch) {
				this.showCard(widget, 'permissions', access);
				return;
			}
			this.hideCard();
			await this.start(widget);
		} finally {
			this.starting = false;
		}
	}

	private async hasKey(): Promise<boolean> {
		if (this.test && pointTalkTest.take?.key === false) {
			pointTalkTest.events.push('no-key');
			return false;
		}
		const ans = await this.commandService.executeCommand<{ ok: boolean; key?: boolean }>('dispatch.pointTalk', 'status');
		return !!ans?.ok && ans.key === true;
	}

	private async access(): Promise<IPointTalkPermissionState> {
		if (this.test) {
			const a = pointTalkTest.take?.access;
			return { microphone: a?.microphone ?? 'granted', screen: a?.screen ?? 'granted', relaunch: !!a?.relaunch };
		}
		const a: IPointTalkAccess = await this.main.access();
		return { microphone: a.microphone, screen: a.screen, relaunch: a.relaunch };
	}

	private async start(widget: IChatWidget): Promise<void> {
		const box = this.boxOf(widget);
		if (!box) {
			return;
		}
		const take = this.test ? pointTalkTest.take ?? {} : undefined;
		let prepared: IPointTalkPrepared;
		let sources: IPointTalkSources;
		if (take) {
			const display: IPointTalkDisplay = take.display ?? TEST_DISPLAY;
			prepared = { display, windowOnDisplay: !take.elsewhere };
			sources = new PointTalkTestSources(take, mainWindow, this.fileService);
		} else {
			prepared = await this.main.prepare(mainWindow.vscodeWindowId);
			sources = new RealSources(this.nativeHostService);
		}
		const when = today();
		const folder = joinPath(URI.file(this.recordingsRoot || '/tmp'), when.day, when.time);
		const store = new DisposableStore();
		const recording = store.add(this.instantiationService.createInstance(PointTalkRecording, {
			sources,
			folder,
			display: prepared.display,
			// rests on the Agents window itself mark nothing (its own camera, its own box); a test take's screen is drawn,
			// the hidden test window is not on it
			ignore: take ? undefined : () => ({ x: mainWindow.screenX, y: mainWindow.screenY, width: mainWindow.outerWidth, height: mainWindow.outerHeight }),
			window: mainWindow,
		}));
		const slot = store.add(new PointTalkInputSlot(box, {
			discard: () => void this.discard(),
			stop: () => void this.stop(),
			removeFrame: () => undefined,
			drawFrame: () => undefined,
			editLine: () => undefined,
			openVideo: () => undefined,
			send: () => undefined,
		}));
		const state: IRecordingState = { widget, recording, slot, prepared, note: widget.getInput(), store, bar: false, stopping: false };
		this.rec = state;
		slot.showRecording({ clock: '0:00', level: [0, 0, 0, 0, 0], words: '', spot: 0 });
		try {
			await recording.start();
		} catch (e) {
			this.logService.error('[dispatch] point and talk could not start', e);
			this.rec = undefined;
			store.dispose();
			await this.fileService.del(folder, { recursive: true }).catch(() => undefined);
			this.notificationService.error(localize('dispatchPointTalk.cannotStart', "Point and talk could not start recording: {0}", (e as Error).message || String(e)));
			return;
		}
		pointTalkTest.events.push('recording');
		// the moving red frame round the recorded display, the whole time, so it shows in any app (task-dd4hw)
		void this.main.showFrame(prepared.display.id, this.theme());
		pointTalkTest.events.push('frame');
		store.add(toDisposable(() => void this.main.hideFrame()));
		let lastBar = 0;
		let lastSpot = 0;
		const draw = () => {
			if (this.rec !== state || state.stopping) {
				return;
			}
			if (recording.interrupted) {
				void this.stop();
				return;
			}
			const spot = recording.tracker.rests.length;
			const words = liveWords(recording.finalTokens, recording.pendingTokens);
			slot.showRecording({ clock: clock(recording.elapsed), level: recording.level, words, spot });
			const now = Date.now();
			if (state.bar && (now - lastBar > 110 || spot !== lastSpot)) {
				lastBar = now;
				void this.main.updateBar({ clock: clock(recording.elapsed), level: recording.level, words, spot, popped: spot !== lastSpot });
			}
			lastSpot = spot;
		};
		store.add(recording.onDidChange(draw));
		const tick = mainWindow.setInterval(draw, 500);
		store.add(toDisposable(() => mainWindow.clearInterval(tick)));
		store.add(recording.onDidMarkSpot(r => {
			const b = prepared.display.bounds;
			void this.main.ring(b.x + r.x, b.y + r.y);
		}));
		// the bar shows while Dispatch is not in sight on the recorded display
		const place = () => {
			const away = !prepared.windowOnDisplay || mainWindow.document.visibilityState === 'hidden';
			if (away && !state.bar) {
				state.bar = true;
				pointTalkTest.events.push('bar');
				const theme = this.theme();
				void this.main.showBar(mainWindow.vscodeWindowId, prepared.display.id, theme, { clock: clock(recording.elapsed), level: recording.level, words: liveWords(recording.finalTokens, recording.pendingTokens), spot: recording.tracker.rests.length, popped: false });
			} else if (!away && state.bar) {
				state.bar = false;
				pointTalkTest.events.push('bar-hidden');
				void this.main.hideBar();
			}
		};
		store.add(dom.addDisposableListener(mainWindow.document, 'visibilitychange', place));
		store.add(toDisposable(() => {
			if (state.bar) {
				void this.main.hideBar();
			}
		}));
		place();
	}

	async stop(): Promise<void> {
		const state = this.rec;
		if (!state || state.stopping) {
			return;
		}
		state.stopping = true;
		void this.main.hideFrame();
		if (state.bar) {
			state.bar = false;
			void this.main.hideBar();
		}
		const { widget, recording, slot } = state;
		slot.showPicking(recording.elapsed, recording.videoUri?.fsPath ?? '');
		// Dispatch comes to the front, the cursor in the box
		if (!mainWindow.document.hasFocus()) {
			void this.hostService.focus(mainWindow, { mode: FocusMode.Force });
		}
		slot.focus();
		let take: IPointTalkTake;
		try {
			take = await recording.stop();
		} catch (e) {
			this.logService.error('[dispatch] point and talk could not finish the recording', e);
			this.rec = undefined;
			state.store.dispose();
			this.notificationService.error(localize('dispatchPointTalk.cannotStop', "Point and talk could not finish the recording: {0}", (e as Error).message || String(e)));
			return;
		}
		const review = await this.pick(take, state.note);
		this.rec = undefined;
		state.store.dispose();
		const session = this.sessionOf(widget);
		if (!session) {
			review.store.dispose();
			return;
		}
		this.reviews.set(session, review);
		await this.applyToBox(widget, review);
		this.showReviewFor(widget, true);
		pointTalkTest.events.push('review');
	}

	async discard(): Promise<void> {
		const state = this.rec;
		if (!state || state.stopping) {
			return;
		}
		this.rec = undefined;
		await state.recording.discard();
		state.store.dispose();
		pointTalkTest.events.push('discarded');
		state.widget.focusInput?.();
	}

	// ---------------------------------------------------------------- the frames picked

	private async pick(take: IPointTalkTake, note: string): Promise<IReview> {
		const store = new DisposableStore();
		const sentences = sentencesOf(take.tokens);
		const rests = take.rests.filter(r => take.spots.has(r.n));
		const { frames, lines } = pickFrames(rests, sentences);
		const states: IFrameState[] = [];
		for (const f of frames) {
			const spot = take.spots.get(f.rest)!;
			const box = spot.snapped ?? spotBox(f.x, f.y, spot.scale, spot.size);
			const url = dispatchBlobUrl(spot.bytes, 'image/png');
			store.add(url);
			states.push({ n: f.n, t: f.t, url: url.url, size: spot.size, box, entryId: '', file: `spot-${f.rest}.png`, scale: spot.scale });
		}
		return { take, note, frames: states, lines, store };
	}

	/** The message into the box: the keyframes as attachments (boxes burned in), the text hidden behind the review. */
	private async applyToBox(widget: IChatWidget, review: IReview): Promise<void> {
		const entries: IChatRequestVariableEntry[] = [];
		const stamp = generateUuid().slice(0, 8);
		for (const f of review.frames) {
			const spot = [...review.take.spots.values()].find(s => `spot-${s.rest.n}.png` === f.file)!;
			const line = review.lines.find(l => l.n === f.n);
			const meta: IDispatchMarksMetadata = {
				v: 1,
				size: f.size,
				scale: f.scale,
				marks: [{ n: f.n, box: f.box, color: 'red', note: line?.text || undefined }],
				source: `Point and talk, ${clock(f.t)}`,
			};
			const bytes = await burnDispatchMarks({ url: f.url, size: f.size as [number, number], scale: f.scale }, [{ n: f.n, box: f.box, color: 'red' }]);
			const id = `dispatch-pt-${stamp}-${f.n}#dispatch-marked-0`;
			rememberDispatchOriginal(id, { bytes: spot.bytes, mime: 'image/png', size: [f.size[0], f.size[1]], scale: f.scale });
			f.entryId = id;
			entries.push({
				id,
				kind: 'image',
				name: localize('dispatchPointTalk.frameName', "Frame {0} · {1}", f.n, clock(f.t)),
				value: bytes,
				mimeType: 'image/png',
				isPasted: true,
				_meta: { [DispatchMarksMetadataKey]: meta, [POINT_TALK_FRAME_META]: { n: f.n, t: f.t, folder: review.take.folder.fsPath } },
			} as IChatRequestVariableEntry);
		}
		widget.attachmentModel.addContext(...entries);
		this.writeText(widget, review);
	}

	private writeText(widget: IChatWidget, review: IReview): void {
		widget.setInput(composeMessage({ note: review.note, duration: review.take.duration, lines: review.lines, folder: review.take.folder.fsPath, video: review.take.video.fsPath }));
		void this.save(review);
	}

	/** take.json: what the bubble draws (the frames with their boxes, the lines), kept current while reviewing. */
	private async save(review: IReview): Promise<void> {
		const saved: IPointTalkSavedTake = {
			v: 1,
			duration: review.take.duration,
			video: review.take.video.fsPath,
			frames: review.frames.map(f => ({ n: f.n, t: f.t, file: f.file, size: [f.size[0], f.size[1]], box: [f.box[0], f.box[1], f.box[2], f.box[3]] })),
			lines: review.lines,
		};
		const extra = { display: review.take.display, rests: review.take.rests, tokens: review.take.tokens };
		await this.fileService.writeFile(joinPath(review.take.folder, 'take.json'), VSBuffer.fromString(JSON.stringify({ ...saved, ...extra }, undefined, 1))).catch(e => this.logService.warn('[dispatch] point and talk: take.json not written', e));
	}

	// ---------------------------------------------------------------- reviewing in the box

	private showReviewFor(widget: IChatWidget, fresh = false): void {
		const session = this.sessionOf(widget);
		const review = session ? this.reviews.get(session) : undefined;
		if (this.shown && (this.shown.widget !== widget || this.shown.review !== review)) {
			if (this.shown.widget === widget) {
				this.hideShown();
			}
		}
		if (!review || (this.shown?.review === review && this.shown.widget === widget && !fresh)) {
			return;
		}
		const box = this.boxOf(widget);
		if (!box) {
			return;
		}
		this.hideShown();
		const store = new DisposableStore();
		const slot = store.add(new PointTalkInputSlot(box, {
			discard: () => this.dropReview(review, widget, true),
			stop: () => undefined,
			removeFrame: n => this.removeFrame(widget, review, n),
			drawFrame: n => this.drawFrame(widget, review, n),
			editLine: (i, text) => this.editLine(widget, review, i, text),
			openVideo: () => this.openVideo(review.take.video.fsPath),
			send: () => void widget.acceptInput(),
		}));
		this.shown = { widget, slot, review, store };
		// the pen's draw tool swapped a frame's attachment: the frame follows it
		store.add(widget.attachmentModel.onDidChange(() => this.followAttachments(widget, review)));
		this.render(fresh);
		slot.focus();
	}

	private render(fresh = false): void {
		const s = this.shown;
		if (!s) {
			return;
		}
		const r = s.review;
		s.slot.showReview({
			frames: r.frames.map(f => f.drawnUrl ? { ...f, url: f.drawnUrl } : f),
			lines: r.lines,
			duration: r.take.duration,
			video: r.take.video.fsPath,
			wordsError: r.take.wordsError ? localize('dispatchPointTalk.noWords', "The words could not be transcribed: {0}", r.take.wordsError) : undefined,
		}, fresh);
		s.slot.element.classList.toggle('drawn', r.frames.some(f => !!f.drawnUrl));
	}

	private hideShown(): void {
		this.shown?.store.dispose();
		this.shown = undefined;
	}

	private removeFrame(widget: IChatWidget, review: IReview, n: number): void {
		const f = review.frames.find(x => x.n === n);
		if (!f) {
			return;
		}
		review.frames = review.frames.filter(x => x !== f);
		for (const l of review.lines) {
			if (l.n === n) {
				l.n = undefined;
			}
		}
		widget.attachmentModel.delete(f.entryId);
		this.writeText(widget, review);
		this.render();
		pointTalkTest.events.push(`removed ${n}`);
	}

	private drawFrame(widget: IChatWidget, review: IReview, n: number): void {
		const f = review.frames.find(x => x.n === n);
		const box = this.boxOf(widget);
		if (!f || !box) {
			return;
		}
		void dispatchDrawInputController()?.openFor({
			box,
			row: box.querySelector<HTMLElement>('.chat-attachments-container') ?? undefined,
			entries: () => widget.attachmentModel.attachments,
			replace: (oldId, entry) => widget.attachmentModel.updateContext([oldId], [entry]),
			focus: () => this.shown?.slot.focus(),
		}, f.entryId);
	}

	private followAttachments(widget: IChatWidget, review: IReview): void {
		const byN = new Map<number, IChatRequestVariableEntry>();
		for (const e of widget.attachmentModel.attachments) {
			const meta = e._meta?.[POINT_TALK_FRAME_META] as { n?: number } | undefined;
			if (typeof meta?.n === 'number') {
				byN.set(meta.n, e);
			}
		}
		let changed = false;
		for (const f of review.frames) {
			const e = byN.get(f.n);
			if (e && e.id !== f.entryId) {
				f.entryId = e.id;
				const marks = readDispatchMarksMeta(e);
				if (marks?.marks[0]) {
					const bytes = e.value instanceof Uint8Array ? e.value : undefined;
					if (bytes) {
						const url = dispatchBlobUrl(bytes, 'image/png');
						review.store.add(url);
						f.drawnUrl = url.url;
					}
				}
				changed = true;
			}
		}
		if (changed) {
			this.render();
		}
	}

	private editLine(widget: IChatWidget, review: IReview, index: number, text: string): void {
		const line = review.lines[index];
		if (!line) {
			return;
		}
		line.text = text;
		const f = line.n !== undefined ? review.frames.find(x => x.n === line.n) : undefined;
		const entry = f && widget.attachmentModel.attachments.find(e => e.id === f.entryId);
		const marks = entry && readDispatchMarksMeta(entry);
		if (entry && marks) {
			const meta: IDispatchMarksMetadata = { ...marks, marks: marks.marks.map(m => m.n === line.n ? { ...m, note: text || undefined } : m) };
			widget.attachmentModel.updateContext([entry.id], [{ ...entry, _meta: { ...entry._meta, [DispatchMarksMetadataKey]: meta } } as IChatRequestVariableEntry]);
		}
		this.writeText(widget, review);
		this.render();
		pointTalkTest.events.push(`edited ${index}`);
	}

	/** Sent: the box goes back to normal; the recording's folder stays (the bubble reads it). */
	private sent(widget: IChatWidget): void {
		const session = this.sessionOf(widget);
		const review = session ? this.reviews.get(session) : undefined;
		if (!review || !session) {
			return;
		}
		this.reviews.delete(session);
		if (this.shown?.review === review) {
			this.hideShown();
		}
		review.store.dispose();
		pointTalkTest.events.push('sent');
	}

	private dropReview(review: IReview, widget: IChatWidget, deleteFolder: boolean): void {
		const session = this.sessionOf(widget);
		if (session) {
			this.reviews.delete(session);
		}
		widget.attachmentModel.delete(...review.frames.map(f => f.entryId));
		widget.setInput(review.note);
		if (this.shown?.review === review) {
			this.hideShown();
		}
		review.store.dispose();
		if (deleteFolder) {
			void this.fileService.del(review.take.folder, { recursive: true }).catch(() => undefined);
		}
		pointTalkTest.events.push('review-discarded');
		widget.focusInput?.();
	}

	private openVideo(path: string): void {
		if (this.test) {
			pointTalkTest.events.push(`open-video ${path}`);
			return;
		}
		void this.openerService.open(URI.file(path), { openExternal: true });
	}

	// ---------------------------------------------------------------- the card

	private showCard(widget: IChatWidget, kind: 'permissions' | 'key', access?: IPointTalkPermissionState): void {
		if (this.card && this.card.widget !== widget) {
			this.hideCard();
		}
		if (!this.card) {
			const card = new PointTalkCard(widget.input.element, {
				allowMicrophone: () => void this.allowMicrophone(),
				openScreenSettings: () => void this.openScreenSettings(),
				relaunch: () => void this.relaunch(),
				openKeys: () => {
					// Keys with the form open on SONIOX_API_KEY; the card stays until the key is saved (watchKey)
					pointTalkTest.events.push('open-keys');
					void this.commandService.executeCommand('dispatch.settings.open', 'keys', { add: SONIOX_KEY, note: SONIOX_NOTE });
				},
				close: () => this.hideCard(),
			});
			const timer = mainWindow.setInterval(() => void this.pollCard(), 1000);
			this.card = { widget, card, timer, wants: 'start' };
		}
		pointTalkTest.events.push(`card ${kind}`);
		if (kind === 'key') {
			this.card.card.showKey();
			this.watchKey(this.card);
		} else if (access) {
			this.card.card.showPermissions(access);
		}
	}

	private async pollCard(): Promise<void> {
		const c = this.card;
		if (!c || c.card.showing !== 'permissions') {
			return;
		}
		const access = await this.access();
		if (this.card !== c) {
			return;
		}
		if (access.microphone === 'granted' && access.screen === 'granted' && !access.relaunch) {
			this.hideCard();
			void this.main.closeScreenHelp();
			// everything is there now: the recording the person asked for starts
			void this.toggle({ widget: c.widget });
			return;
		}
		if (access.screen === 'granted') {
			void this.main.closeScreenHelp();
		}
		c.card.showPermissions(access);
	}

	/** The key card goes by itself once SONIOX_API_KEY is saved, wherever from (Keys, a terminal, an agent): every
	 *  save lands in the key store's event file, which the bridge watches. Asked once per change, not every second:
	 *  each ask runs the CLI. The recording does not start by itself: the person is on Settings, not on the box. */
	private watchKey(c: NonNullable<DispatchPointTalkController['card']>): void {
		c.keyWatch ??= onDidChangeDispatchKeys(events => {
			if (!events.some(e => e.name === SONIOX_KEY)) {
				return;
			}
			void this.hasKey().then(there => {
				if (there && this.card === c && c.card.showing === 'key') {
					this.hideCard();
					pointTalkTest.events.push('key-saved');
				}
			});
		});
	}

	private hideCard(): void {
		if (this.card) {
			mainWindow.clearInterval(this.card.timer);
			this.card.keyWatch?.dispose();
			this.card.card.dispose();
			this.card = undefined;
		}
	}

	private async allowMicrophone(): Promise<void> {
		pointTalkTest.events.push('ask-microphone');
		if (this.test) {
			// the scenario plays macOS's dialog: OK
			pointTalkTest.take = { ...(pointTalkTest.take ?? {}), access: { ...(pointTalkTest.take?.access ?? {}), microphone: 'granted' } };
		} else {
			await this.main.askMicrophone();
		}
		await this.pollCard();
	}

	private async openScreenSettings(): Promise<void> {
		pointTalkTest.events.push('open-screen-settings');
		if (!this.test) {
			await this.main.openScreenSettings(mainWindow.vscodeWindowId, this.theme());
		}
	}

	private async relaunch(): Promise<void> {
		pointTalkTest.events.push('relaunch');
		if (!this.test) {
			await this.nativeHostService.relaunch();
		}
	}

	// ---------------------------------------------------------------- odds and ends

	private theme(): IPointTalkTheme {
		const theme = this.themeService.getColorTheme();
		const c = (id: string, fallback: string) => theme.getColor(id)?.toString() ?? fallback;
		const dark = isDark(theme.type);
		return {
			dark,
			bg: c('sideBar.background', dark ? '#1c1917' : '#fafaf9'),
			border: c('input.border', dark ? 'rgba(255,255,255,.15)' : '#e7e5e4'),
			text: c('foreground', dark ? '#fafaf9' : '#0c0a09'),
			text2: c('descriptionForeground', dark ? '#a6a09b' : '#79716b'),
			fill: c('button.background', dark ? '#fafaf9' : '#252525'),
			fillText: c('button.foreground', dark ? '#0c0a09' : '#fafaf9'),
			red: c('errorForeground', dark ? '#f87171' : '#dc2626'),
		};
	}

	/** For the scenario: what the window is doing (`window.__dispatchPointTalkTest.state()`). */
	private describe(): unknown {
		const r = this.rec;
		const shown = this.shown;
		return {
			recording: !!r && !r.stopping,
			stopping: !!r?.stopping,
			bar: !!r?.bar,
			elapsed: r?.recording.elapsed ?? 0,
			spots: r?.recording.tracker.rests.length ?? 0,
			words: r ? liveWords(r.recording.finalTokens, r.recording.pendingTokens) : '',
			liveError: r?.recording.liveError,
			reviews: this.reviews.size,
			review: shown ? { frames: shown.review.frames.map(f => ({ n: f.n, t: f.t, box: f.box })), lines: shown.review.lines, folder: shown.review.take.folder.fsPath, video: shown.review.take.video.fsPath, duration: shown.review.take.duration } : undefined,
			card: this.card?.card.showing,
			events: pointTalkTest.events.slice(),
		};
	}
}

let controller: DispatchPointTalkController | undefined;

registerWorkbenchContribution2(DispatchPointTalkController.ID, DispatchPointTalkController, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TOGGLE,
			title: localize2('dispatchPointTalk.title', "Point and talk"),
			tooltip: localize('dispatchPointTalk.tooltip', "Point and talk: record the screen under your pointer and your voice"),
			icon: Codicon.deviceCameraVideo,
			f1: true,
			precondition: IsSessionsWindowContext,
			keybinding: {
				primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyS,
				weight: KeybindingWeight.WorkbenchContrib,
				when: IsSessionsWindowContext,
			},
			menu: {
				id: MenuId.ChatExecute,
				group: 'navigation',
				// after the dictation microphone (3), before send (4)
				order: 3.5,
				when: ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat)),
			},
		});
	}
	async run(_accessor: ServicesAccessor, context?: IChatExecuteActionContext): Promise<void> {
		await controller?.toggle(context && typeof context === 'object' ? context : undefined);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: STOP, title: localize2('dispatchPointTalk.stopTitle', "Stop Point and Talk Recording"), f1: false, precondition: IsSessionsWindowContext });
	}
	async run(): Promise<void> {
		await controller?.stop();
	}
});

