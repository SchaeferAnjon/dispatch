/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Point and talk in the main process (task-0y0km, kanban design/screen-talk; the contract and
 *  what each part is for: ../common/dispatchPointTalk.ts).
 *
 *  macOS 15, what the code relies on (read 2026-11-16; only the person's own Mac can show the real dialogs):
 *  - Screen Recording is a switch in System Settings › Privacy & Security; an app is in its list once it asked
 *    (desktopCapturer.getSources asks, with macOS's own alert the first time) or once it is dragged in. Turned on while
 *    the app runs, macOS wants the app reopened: the card then offers Quit & Reopen (a relaunch keeps the sessions).
 *    getMediaAccessStatus('screen') only says granted or denied (CGPreflightScreenCaptureAccess).
 *  - Recording without the system picker (we pick the display ourselves: the person chose no picker) means macOS 15
 *    asks about once a month whether Dispatch may "bypass the system private window picker" (Allow For One Month).
 *    Only SCContentSharingPicker or a screen-sharing entitlement avoid it; neither fits here.
 *  - Windows with setContentProtection(true) are left out of Electron's own display captures (Electron hides them
 *    from ScreenCaptureKit's filter), which keeps the bar and the frame out of the video.
 *  - The microphone is macOS's dialog (askForMediaAccess) the first time; refused once, only System Settings
 *    changes it, and its list only shows apps that asked (nothing to drag).
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, desktopCapturer, globalShortcut, nativeImage, screen, shell, systemPreferences } from 'electron';
import * as path from 'path';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { INativeRunActionInWindowRequest } from '../../window/common/window.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IDispatchPointTalkMainService, IPointTalkAccess, IPointTalkBarState, IPointTalkPrepared, IPointTalkTheme, PointTalkAccessState } from '../common/dispatchPointTalk.js';
import { POINT_TALK_BAR_MARGIN, POINT_TALK_BAR_SIZE, POINT_TALK_HELP_SIZE, POINT_TALK_PAGE_SIGNAL, pointTalkBarPage, pointTalkFramePage, pointTalkHelpPage } from './dispatchPointTalkPages.js';

const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const MIC_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const TOGGLE_COMMAND = 'dispatch.pointTalk.toggle';
const STOP_COMMAND = 'dispatch.pointTalk.stop';
const BAR_POSITIONS = 'dispatch.pointTalk.barPositions';

/** The display each window's next screen capture takes (set by prepare, taken by app.ts's display media handler). */
const nextDisplay = new Map<number, Electron.Display>();

/**
 * code/electron-main/app.ts's getDisplayMedia handler asks this first: the display Point and talk chose for this
 * window (once), else undefined and VS Code's own choice (the window's display) stands.
 */
export function takeDispatchPointTalkDisplay(windowId: number | undefined): Electron.Display | undefined {
	if (windowId === undefined) {
		return undefined;
	}
	const display = nextDisplay.get(windowId);
	nextDisplay.delete(windowId);
	return display;
}

function isTestInstance(): boolean {
	return !!process.env['DISPATCH_E2E_INSTANCE'];
}

function access(kind: 'microphone' | 'screen'): PointTalkAccessState {
	if (!isMacintosh) {
		return 'granted';
	}
	return systemPreferences.getMediaAccessStatus(kind) as PointTalkAccessState;
}

/** The .app this process runs from (the dev build's too): what the drag panel hands to System Settings. */
function appBundle(): string {
	return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

const pageWindow = (options: Electron.BrowserWindowConstructorOptions): BrowserWindow => new BrowserWindow({
	frame: false,
	transparent: true,
	resizable: false,
	minimizable: false,
	maximizable: false,
	fullscreenable: false,
	skipTaskbar: true,
	hasShadow: false,
	show: false,
	focusable: false,
	acceptFirstMouse: true,
	type: 'panel',
	backgroundColor: '#00000000',
	...options,
	webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
});

export class DispatchPointTalkMainService extends Disposable implements IDispatchPointTalkMainService {

	declare readonly _serviceBrand: undefined;

	private bar: { win: BrowserWindow; displayId: number; windowId: number } | undefined;
	private frame: BrowserWindow | undefined;
	private help: BrowserWindow | undefined;
	private shortcut: { accelerator: string; windowId: number } | undefined;
	/** Screen Recording when this process started: turned on later, macOS wants a relaunch first. */
	private readonly screenAtStart = access('screen');

	constructor(
		@ILogService private readonly logService: ILogService,
		@IStateService private readonly stateService: IStateService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
	) {
		super();
		this._register(this.windowsMainService.onDidDestroyWindow(w => {
			if (this.shortcut?.windowId === w.id) {
				this.dropShortcut();
			}
			if (this.bar?.windowId === w.id) {
				void this.hideBar();
				void this.hideFrame();
			}
			nextDisplay.delete(w.id);
		}));
		this._register(toDisposable(() => {
			this.dropShortcut();
			for (const w of [this.bar?.win, this.frame, this.help]) {
				if (w && !w.isDestroyed()) {
					w.destroy();
				}
			}
		}));
	}

	// ---------------------------------------------------------------- permissions

	async access(): Promise<IPointTalkAccess> {
		const test = isTestInstance();
		const home = process.env['DISPATCH_HOME'] || path.join(app.getPath('home'), '.dispatch');
		const recordings = path.join(home, 'recordings');
		if (test) {
			return { microphone: 'not-determined', screen: 'denied', relaunch: false, test, recordings };
		}
		const screenNow = access('screen');
		return { microphone: access('microphone'), screen: screenNow, relaunch: screenNow === 'granted' && this.screenAtStart !== 'granted', test, recordings };
	}

	async askMicrophone(): Promise<boolean> {
		if (isTestInstance()) {
			return false;
		}
		if (!isMacintosh) {
			return true;
		}
		if (access('microphone') === 'not-determined') {
			return systemPreferences.askForMediaAccess('microphone');
		}
		if (access('microphone') !== 'granted') {
			// refused before: only System Settings changes it now
			await shell.openExternal(MIC_PANE);
			return false;
		}
		return true;
	}

	async openScreenSettings(windowId: number, theme: IPointTalkTheme): Promise<void> {
		if (isTestInstance()) {
			this.logService.info('[dispatch] point and talk: test instance, System Settings not opened');
			return;
		}
		if (access('screen') !== 'granted') {
			// asking is what puts Dispatch into the list (and macOS's own alert, the first time)
			try {
				await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
			} catch (e) {
				this.logService.warn('[dispatch] point and talk: asking for the screen failed', e);
			}
		}
		await shell.openExternal(SCREEN_PANE);
		await this.showHelp(windowId, theme);
	}

	private async showHelp(windowId: number, theme: IPointTalkTheme): Promise<void> {
		if (this.help && !this.help.isDestroyed()) {
			this.help.showInactive();
			return;
		}
		const owner = BrowserWindow.fromId(windowId);
		// System Settings opens on the display the person is working on; the panel waits in its top right corner
		const work = (owner ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay()).workArea;
		const icon = await app.getFileIcon(appBundle(), { size: 'large' }).catch(() => nativeImage.createEmpty());
		const w = POINT_TALK_HELP_SIZE.width + 16;
		const h = POINT_TALK_HELP_SIZE.height + 16;
		const win = pageWindow({ x: Math.round(work.x + work.width - w - 16), y: Math.round(work.y + 16), width: w, height: h });
		win.setAlwaysOnTop(true, 'floating');
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		this.help = win;
		win.webContents.on('console-message', e => {
			if (e.message === `${POINT_TALK_PAGE_SIGNAL}drag`) {
				win.webContents.startDrag({ file: appBundle(), icon: icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 64, height: 64 }) });
			} else if (e.message === `${POINT_TALK_PAGE_SIGNAL}close`) {
				void this.closeScreenHelp();
			}
		});
		win.on('closed', () => {
			if (this.help === win) {
				this.help = undefined;
			}
		});
		await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pointTalkHelpPage(theme, icon.isEmpty() ? '' : icon.toDataURL(), app.getName(), 'Close')));
		if (!win.isDestroyed()) {
			win.showInactive();
		}
	}

	async closeScreenHelp(): Promise<void> {
		const w = this.help;
		this.help = undefined;
		if (w && !w.isDestroyed()) {
			w.destroy();
		}
	}

	// ---------------------------------------------------------------- which display

	async prepare(windowId: number): Promise<IPointTalkPrepared> {
		const point = screen.getCursorScreenPoint();
		const display = screen.getDisplayNearestPoint(point);
		nextDisplay.set(windowId, display);
		const win = BrowserWindow.fromId(windowId);
		const windowOnDisplay = !!win && win.isVisible() && !win.isMinimized() && screen.getDisplayMatching(win.getBounds()).id === display.id;
		return {
			display: { id: display.id, bounds: { ...display.bounds }, scaleFactor: display.scaleFactor },
			windowOnDisplay,
		};
	}

	// ---------------------------------------------------------------- the bar and the frame

	private displayById(id: number): Electron.Display {
		return screen.getAllDisplays().find(d => d.id === id) ?? screen.getPrimaryDisplay();
	}

	async showBar(windowId: number, displayId: number, theme: IPointTalkTheme, state: IPointTalkBarState): Promise<void> {
		await this.hideBar();
		const display = this.displayById(displayId);
		const m = POINT_TALK_BAR_MARGIN;
		const width = POINT_TALK_BAR_SIZE.width + 2 * m;
		const height = POINT_TALK_BAR_SIZE.height + 2 * m;
		// under the menu bar, in the middle, or where it was dragged to on this display before
		const kept = (this.stateService.getItem<Record<string, { dx: number; dy: number }>>(BAR_POSITIONS) ?? {})[String(display.id)];
		const work = display.workArea;
		const x = kept ? display.bounds.x + kept.dx : Math.round(work.x + (work.width - width) / 2);
		const y = kept ? display.bounds.y + kept.dy : Math.round(work.y + 8 - m);
		const win = pageWindow({ x: Math.round(x), y: Math.round(y), width, height, movable: true });
		win.setAlwaysOnTop(true, 'floating');
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		// out of the recording (Electron leaves content-protected windows out of its display captures)
		win.setContentProtection(true);
		this.bar = { win, displayId: display.id, windowId };
		win.webContents.on('console-message', e => {
			if (e.message === `${POINT_TALK_PAGE_SIGNAL}stop`) {
				this.run(windowId, STOP_COMMAND);
			}
		});
		win.on('moved', () => {
			if (win.isDestroyed()) {
				return;
			}
			const [bx, by] = win.getPosition();
			const all = { ...(this.stateService.getItem<Record<string, { dx: number; dy: number }>>(BAR_POSITIONS) ?? {}) };
			all[String(display.id)] = { dx: bx - display.bounds.x, dy: by - display.bounds.y };
			this.stateService.setItem(BAR_POSITIONS, all);
		});
		win.on('closed', () => {
			if (this.bar?.win === win) {
				this.bar = undefined;
			}
		});
		await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pointTalkBarPage(theme, 'Stop', 'Listening…')));
		if (win.isDestroyed() || this.bar?.win !== win) {
			return;
		}
		await this.updateBar(state);
		win.showInactive();
	}

	async updateBar(state: IPointTalkBarState): Promise<void> {
		const win = this.bar?.win;
		if (!win || win.isDestroyed()) {
			return;
		}
		await win.webContents.executeJavaScript(`window.__pt && window.__pt(${JSON.stringify(state)})`).catch(() => undefined);
	}

	async hideBar(): Promise<void> {
		const w = this.bar?.win;
		this.bar = undefined;
		if (w && !w.isDestroyed()) {
			w.destroy();
		}
	}

	async showFrame(displayId: number, theme: IPointTalkTheme): Promise<void> {
		await this.hideFrame();
		const display = this.displayById(displayId);
		const win = pageWindow({ ...display.bounds, enableLargerThanScreen: true });
		win.setIgnoreMouseEvents(true);
		win.setAlwaysOnTop(true, 'screen-saver');
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		win.setContentProtection(true);
		this.frame = win;
		win.on('closed', () => {
			if (this.frame === win) {
				this.frame = undefined;
			}
		});
		await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pointTalkFramePage(theme)));
		if (!win.isDestroyed() && this.frame === win) {
			win.setBounds(display.bounds);
			win.showInactive();
		}
	}

	async ring(x: number, y: number): Promise<void> {
		const win = this.frame;
		if (!win || win.isDestroyed()) {
			return;
		}
		const b = win.getBounds();
		await win.webContents.executeJavaScript(`window.__ptRing && window.__ptRing(${Math.round(x - b.x)}, ${Math.round(y - b.y)})`).catch(() => undefined);
	}

	async hideFrame(): Promise<void> {
		const w = this.frame;
		this.frame = undefined;
		if (w && !w.isDestroyed()) {
			w.destroy();
		}
	}

	// ---------------------------------------------------------------- the shortcut

	async setShortcut(windowId: number, accelerator: string | undefined): Promise<boolean> {
		if (isTestInstance()) {
			// a test instance never takes the person's ⌃⇧S from their own Dispatch
			return false;
		}
		if (this.shortcut && this.shortcut.windowId !== windowId) {
			// another Agents window holds it, and keeps it while it is open
			return !accelerator || this.shortcut.accelerator === accelerator;
		}
		if (this.shortcut?.accelerator === accelerator) {
			return true;
		}
		this.dropShortcut();
		if (!accelerator) {
			return true;
		}
		let ok = false;
		try {
			ok = globalShortcut.register(accelerator, () => this.run(this.shortcut?.windowId ?? windowId, TOGGLE_COMMAND));
		} catch (e) {
			this.logService.warn(`[dispatch] point and talk: ${accelerator} could not be registered`, e);
		}
		if (ok) {
			this.shortcut = { accelerator, windowId };
		} else {
			this.logService.warn(`[dispatch] point and talk: ${accelerator} is taken by macOS or another app`);
		}
		return ok;
	}

	private dropShortcut(): void {
		if (this.shortcut) {
			try {
				globalShortcut.unregister(this.shortcut.accelerator);
			} catch {
				// already gone with the app
			}
			this.shortcut = undefined;
		}
	}

	/** Run a command in the Agents window that recorded (a shortcut or the bar's Stop: it does not come forward). */
	private run(windowId: number, id: string): void {
		const target = this.windowsMainService.getWindowById(windowId);
		if (!target) {
			return;
		}
		const request: INativeRunActionInWindowRequest = { id, from: 'systemWideKeybinding' };
		const send = () => target.sendWhenReady('vscode:runAction', CancellationToken.None, request);
		if (id === TOGGLE_COMMAND && target.win && !target.win.isDestroyed()) {
			// the shortcut comes from outside the page: it gets the user activation a click would have, which the
			// screen capture and the level meter's audio need
			target.win.webContents.executeJavaScript('void 0', true).then(send, send);
		} else {
			send();
		}
	}
}
