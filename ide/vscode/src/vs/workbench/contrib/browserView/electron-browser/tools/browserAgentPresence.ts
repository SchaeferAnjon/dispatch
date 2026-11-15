/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IBrowserViewAgentOverlayCue, IBrowserViewAgentOverlayState, IBrowserViewRect, IBrowserViewService, ipcBrowserViewChannelName } from '../../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import type { IToolInvocation, IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';

// eslint-disable-next-line local/code-import-patterns
import type { Page } from 'playwright-core';

/**
 * Dispatch: who is driving a page. Taken from the chat the tool call comes from (the Agents
 * window's Claude and Codex sessions), or given by `dispatch browser --ide` for a terminal session.
 */
export interface IBrowserAgentIdentity {
	readonly engine: 'claude' | 'codex' | 'agent';
	readonly name: string;
}

export function browserAgentIdentity(invocation: Pick<IToolInvocation, 'context' | 'parameters'> | undefined): IBrowserAgentIdentity {
	const given = (invocation?.parameters as { dispatchEngine?: string } | undefined)?.dispatchEngine;
	const where = given ?? invocation?.context?.sessionResource?.scheme ?? '';
	return identityFromName(where);
}

export function identityFromName(where: string | undefined): IBrowserAgentIdentity {
	if (/claude/i.test(where ?? '')) {
		return { engine: 'claude', name: 'Claude' };
	}
	if (/codex|openai/i.test(where ?? '')) {
		return { engine: 'codex', name: 'Codex' };
	}
	return { engine: 'agent', name: localize('browserAgent.genericName', "Agent") };
}

/** One browser tool call: what the bar says while it runs (present tense, no agent name). */
export interface IBrowserAgentAction {
	readonly label: string;
	/**
	 * What the action sends into the page (see {@link IBrowserViewAgentOverlayState.actingInput}):
	 * `pointer` for clicks and hovers, `keys` for typing, `any` for drags and scripts, `none` for
	 * reading, screenshots and loading (then any click or key from the user takes over).
	 */
	readonly input?: 'pointer' | 'keys' | 'any' | 'none';
}

export interface IBrowserAgentActionControl {
	readonly token: CancellationToken;
	/** Whether cues animate (off under reduced motion). */
	readonly motion: boolean;
	/** Play a cue; resolves once the cursor has arrived (at once under reduced motion). */
	cue(cue: IBrowserViewAgentOverlayCue): Promise<void>;
}

/** Why an action did not run to its end. */
export type BrowserAgentInterruption = 'user' | 'stop' | 'paused' | 'covered';

/**
 * What in the window hides a page (the page is a native view, so anything drawn over it hides it
 * and the page stops rendering): a dialog, a menu, the command palette or another popup.
 */
export type BrowserPageCover = 'dialog' | 'menu' | 'quickInput' | 'notification' | 'hover' | 'other';

export class BrowserAgentInterrupted {
	constructor(readonly reason: BrowserAgentInterruption, readonly cover?: BrowserPageCover) { }

	/** The tool result the model gets. */
	toToolResult(): IToolResult {
		if (this.reason === 'covered') {
			const what = this.cover === 'dialog' ? 'a dialog'
				: this.cover === 'menu' ? 'a menu'
					: this.cover === 'quickInput' ? 'the command palette'
						: this.cover === 'notification' ? 'the notifications'
							: 'a popup';
			const message = `The browser page is paused: ${what} in Dispatch IDE covers it, so the page is hidden and cannot be used right now. Nothing was done on the page. Tell the user what you were about to do and ask them to close it, then try again.`;
			return {
				content: [{ kind: 'text', value: message }],
				toolResultError: message,
				toolResultMessage: this.cover === 'dialog'
					? localize('browserAgent.coveredDialog', "Paused: a dialog covers the page")
					: this.cover === 'menu'
						? localize('browserAgent.coveredMenu', "Paused: a menu covers the page")
						: this.cover === 'quickInput'
							? localize('browserAgent.coveredQuickInput', "Paused: the command palette covers the page")
							: localize('browserAgent.coveredOther', "Paused: a popup covers the page"),
			};
		}
		const message = this.reason === 'user'
			? 'The user took control of the browser page (they clicked or typed in it), so this action was stopped. Do not retry: tell the user what you were about to do and wait for them. Browser actions on this page wait until the user clicks Resume in the page.'
			: this.reason === 'stop'
				? 'The user pressed Stop in the browser page, so this action was stopped. Do not retry: ask the user how to continue.'
				: 'The browser page is paused because the user has control of it, and they did not click Resume. Do not retry: ask the user to click Resume in the page, or to tell you when to continue.';
		return {
			content: [{ kind: 'text', value: message }],
			toolResultError: message,
			toolResultMessage: this.reason === 'paused'
				? localize('browserAgent.pausedResult', "Paused: the user has control of the page")
				: this.reason === 'user'
					? localize('browserAgent.userResult', "Stopped: the user took control of the page")
					: localize('browserAgent.stopResult', "Stopped by the user"),
		};
	}
}

export const IBrowserAgentPresenceService = createDecorator<IBrowserAgentPresenceService>('browserAgentPresenceService');

export interface IBrowserAgentPresenceService {
	readonly _serviceBrand: undefined;

	/** Fires with the page id whenever a page's agent state changes (the border follows it). */
	readonly onDidChange: Event<string>;

	/** `idle` (no agent on the page), `working`, or `paused` (the user has control). */
	getMode(pageId: string): 'idle' | 'working' | 'paused';

	/**
	 * Whether an agent has used this page in this window (it stays true between actions, while the
	 * agent thinks). Notifications and hovers never pause such a page.
	 */
	isAgentPage(pageId: string): boolean;

	/**
	 * The renderer reports what hides a page right now (`undefined`: nothing, the page is live).
	 * An action on a covered page fails at once with the reason instead of waiting on a page that
	 * does not render; an action already running when the page gets covered is stopped the same way.
	 */
	setCover(pageId: string, cover: BrowserPageCover | undefined): void;

	/**
	 * Run one browser action with the agent overlay: the bar says what the agent is doing, the
	 * border turns green, cues move the virtual cursor. While the page is paused the action first
	 * waits (up to {@link PAUSE_WAIT_MS}) for Resume. Returns {@link BrowserAgentInterrupted} when
	 * the user takes over, presses Stop, or does not resume.
	 */
	run<T>(pageId: string, who: IBrowserAgentIdentity, action: IBrowserAgentAction, token: CancellationToken, fn: (control: IBrowserAgentActionControl) => Promise<T>): Promise<T | BrowserAgentInterrupted>;

	/**
	 * Share a page the user opened with the agent without asking (no "Share with Agent?" dialog):
	 * in Dispatch the user asked for the built-in browser, and the overlay shows the agent using it.
	 */
	shareWithAgent(pageId: string): Promise<void>;
}

/** How long a new action waits for Resume while the user has control. */
const PAUSE_WAIT_MS = 90_000;
/** The overlay stays this long after the last action (the agent is usually thinking about its next one). */
const IDLE_HIDE_MS = 12_000;
/** A pause nobody resumes ends after this long; the page is the user's again. */
const PAUSE_EXPIRE_MS = 10 * 60_000;
/** Cursor travel (matches the preload's 300 ms transition). */
const CURSOR_TRAVEL_MS = 320;

interface IPageState {
	who: IBrowserAgentIdentity;
	label: string;
	mode: 'working' | 'paused';
	acting: boolean;
	input: 'pointer' | 'keys' | 'any' | 'none';
	target: IBrowserViewRect | undefined;
	current: { cts: CancellationTokenSource; reason?: BrowserAgentInterruption; cover?: BrowserPageCover } | undefined;
	hideTimer: ReturnType<typeof setTimeout> | undefined;
	waiters: Set<(resumed: boolean) => void>;
	listener: IDisposable;
}

export class BrowserAgentPresenceService extends Disposable implements IBrowserAgentPresenceService {
	declare readonly _serviceBrand: undefined;

	private readonly _browserViewService: IBrowserViewService;
	private readonly _pages = new Map<string, IPageState>();
	/** Pages an agent has acted on in this window (see {@link isAgentPage}). */
	private readonly _agentPages = new Set<string>();
	/** What hides each covered page (see {@link setCover}). */
	private readonly _covers = new Map<string, BrowserPageCover>();
	private readonly _listeners = this._register(new DisposableMap<string>());

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._browserViewService = ProxyChannel.toService<IBrowserViewService>(mainProcessService.getChannel(ipcBrowserViewChannelName));
		this._register({
			dispose: () => {
				for (const st of this._pages.values()) {
					clearTimeout(st.hideTimer);
					st.current?.cts.dispose(true);
				}
				this._pages.clear();
			}
		});
	}

	getMode(pageId: string): 'idle' | 'working' | 'paused' {
		return this._pages.get(pageId)?.mode ?? 'idle';
	}

	isAgentPage(pageId: string): boolean {
		return this._agentPages.has(pageId) || this._pages.has(pageId);
	}

	setCover(pageId: string, cover: BrowserPageCover | undefined): void {
		if (cover === undefined) {
			this._covers.delete(pageId);
			return;
		}
		this._covers.set(pageId, cover);
		// the page stopped rendering: an action on it would hang (Playwright waits for frames)
		const st = this._pages.get(pageId);
		if (st?.current && !st.current.cts.token.isCancellationRequested) {
			st.current.reason = 'covered';
			st.current.cover = cover;
			st.current.cts.cancel();
		}
	}

	async shareWithAgent(pageId: string): Promise<void> {
		await this._browserViewService.setAudience(pageId, { type: 'agent' }, true);
	}

	async run<T>(pageId: string, who: IBrowserAgentIdentity, action: IBrowserAgentAction, token: CancellationToken, fn: (control: IBrowserAgentActionControl) => Promise<T>): Promise<T | BrowserAgentInterrupted> {
		if (!this._agentPages.has(pageId)) {
			// From now on notifications and hovers no longer pause this page: the renderer hears
			// this at once and takes such a cover off before the check below.
			this._agentPages.add(pageId);
			this._onDidChange.fire(pageId);
		}
		const cover = this._covers.get(pageId);
		if (cover) {
			return new BrowserAgentInterrupted('covered', cover);
		}
		let st = this._pages.get(pageId);
		if (st?.mode === 'paused') {
			const resumed = await this._waitForResume(st, token);
			if (!resumed) {
				return new BrowserAgentInterrupted('paused');
			}
		}
		st = this._ensure(pageId, who);
		clearTimeout(st.hideTimer);
		st.who = who;
		st.mode = 'working';
		st.label = action.label;
		st.input = action.input ?? 'none';
		st.target = undefined;
		st.acting = st.input !== 'none';
		const cts = new CancellationTokenSource(token);
		const current: IPageState['current'] = { cts };
		st.current = current;
		this._push(pageId);

		const motion = !this._accessibilityService.isMotionReduced();
		const control: IBrowserAgentActionControl = {
			token: cts.token,
			motion,
			cue: async cue => {
				// a stopped action (the user took over, Stop, the page got covered) keeps running
				// in the background for a moment: its cues go nowhere
				if (cts.token.isCancellationRequested) {
					return;
				}
				const page = this._pages.get(pageId);
				if (page && cue.rect && page.target !== cue.rect) {
					// the preload tells the agent's pointer from the user's by this box
					page.target = cue.rect;
					this._push(pageId);
				}
				await this._browserViewService.showAgentOverlayCue(pageId, cue).catch(() => { });
				if (motion && cue.rect && (cue.kind === 'move' || cue.kind === 'click' || cue.kind === 'hover' || cue.kind === 'type' || cue.kind === 'drag')) {
					await timeout(cue.kind === 'drag' ? CURSOR_TRAVEL_MS * 2 : CURSOR_TRAVEL_MS);
				}
			},
		};

		try {
			const result = await raceCancellation(fn(control), cts.token);
			if (cts.token.isCancellationRequested) {
				return new BrowserAgentInterrupted(current.reason ?? 'stop', current.cover);
			}
			return result as T;
		} finally {
			cts.dispose();
			const now = this._pages.get(pageId);
			if (now && now.current === current) {
				now.current = undefined;
				// Let the trailing events of the agent's own input (pointerup, click, keyup) pass
				// before the page listens for the user again.
				setTimeout(() => {
					if (now.current === undefined && this._pages.get(pageId) === now) {
						now.acting = false;
						this._push(pageId);
					}
				}, 200);
				if (now.mode === 'working') {
					this._scheduleHide(pageId, now, IDLE_HIDE_MS);
				}
			}
		}
	}

	private _ensure(pageId: string, who: IBrowserAgentIdentity): IPageState {
		let st = this._pages.get(pageId);
		if (!st) {
			let listener: IDisposable = Disposable.None;
			try {
				listener = this._browserViewService.onDynamicDidAgentOverlayEvent(pageId)(e => this._onPageEvent(pageId, e.type));
			} catch (e) {
				this._logService.warn('[BrowserAgentPresence] cannot listen to the page', e);
			}
			st = { who, label: '', mode: 'working', acting: false, input: 'none', target: undefined, current: undefined, hideTimer: undefined, waiters: new Set(), listener };
			this._pages.set(pageId, st);
			this._listeners.set(pageId, listener);
		}
		return st;
	}

	private _onPageEvent(pageId: string, type: 'userInput' | 'stop' | 'resume'): void {
		const st = this._pages.get(pageId);
		if (!st) {
			return;
		}
		if (type === 'resume') {
			if (st.mode !== 'paused') {
				return;
			}
			st.mode = 'working';
			st.label = localize('browserAgent.resuming', "Resuming");
			for (const w of [...st.waiters]) {
				w(true);
			}
			st.waiters.clear();
			this._push(pageId);
			this._scheduleHide(pageId, st, IDLE_HIDE_MS);
			return;
		}
		if (st.mode === 'paused') {
			return;
		}
		// The user clicked or typed in the page, or pressed Stop: the agent lets go.
		st.mode = 'paused';
		if (st.current) {
			st.current.reason = type === 'userInput' ? 'user' : 'stop';
			st.current.cts.cancel();
		}
		st.acting = false;
		this._push(pageId);
		this._scheduleHide(pageId, st, PAUSE_EXPIRE_MS);
	}

	private _waitForResume(st: IPageState, token: CancellationToken): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			let done = false;
			const finish = (resumed: boolean) => {
				if (done) {
					return;
				}
				done = true;
				st.waiters.delete(finish);
				clearTimeout(timer);
				sub.dispose();
				resolve(resumed);
			};
			st.waiters.add(finish);
			const timer = setTimeout(() => finish(false), PAUSE_WAIT_MS);
			const sub = token.onCancellationRequested(() => finish(false));
		});
	}

	private _scheduleHide(pageId: string, st: IPageState, afterMs: number): void {
		clearTimeout(st.hideTimer);
		st.hideTimer = setTimeout(() => {
			if (this._pages.get(pageId) !== st || st.current) {
				return;
			}
			for (const w of [...st.waiters]) {
				w(false);
			}
			this._pages.delete(pageId);
			this._listeners.deleteAndDispose(pageId);
			void this._browserViewService.setAgentOverlay(pageId, this._state(undefined)).catch(() => { });
			this._onDidChange.fire(pageId);
		}, afterMs);
	}

	private _push(pageId: string): void {
		const st = this._pages.get(pageId);
		void this._browserViewService.setAgentOverlay(pageId, this._state(st)).catch(() => { });
		this._onDidChange.fire(pageId);
	}

	private _state(st: IPageState | undefined): IBrowserViewAgentOverlayState {
		const reducedMotion = this._accessibilityService.isMotionReduced();
		const stopLabel = localize('browserAgent.stop', "Stop");
		const resumeLabel = localize('browserAgent.resume', "Resume");
		if (!st) {
			return { active: false, engine: 'agent', label: '', mode: 'working', acting: false, reducedMotion, stopLabel, resumeLabel };
		}
		const label = st.mode === 'paused'
			? localize('browserAgent.paused', "Paused, you have control")
			: localize({ key: 'browserAgent.working', comment: ['{0} is Claude, Codex or Agent; {1} is what it does, e.g. Clicking “Sign in”'] }, "{0} · {1}", st.who.name, st.label);
		return {
			active: true, engine: st.who.engine, label, mode: st.mode, acting: st.acting,
			...(st.acting && st.input !== 'none' ? { actingInput: st.input } : {}),
			...(st.acting && st.target ? { target: st.target } : {}),
			reducedMotion, stopLabel, resumeLabel,
		};
	}
}

/** Quote an element's name for the bar and the chat: Clicking “Sign in”. */
export function quoteElement(name: string | undefined, fallback: string): string {
	const n = (name ?? '').trim().replace(/\s+/g, ' ');
	if (!n) {
		return fallback;
	}
	return `“${n.length > 60 ? n.slice(0, 59) + '…' : n}”`;
}

/** The host of a URL for the bar ("example.com"), or the URL itself. */
export function hostOf(url: string | undefined): string {
	if (!url) {
		return '';
	}
	try {
		const u = URI.parse(url);
		return u.authority || url;
	} catch {
		return url;
	}
}

registerSingleton(IBrowserAgentPresenceService, BrowserAgentPresenceService, InstantiationType.Delayed);

/**
 * The box of the element a tool acts on, in viewport coordinates, after bringing it into view
 * (smoothly when motion is on) so the virtual cursor has somewhere to go. `undefined` when the
 * element is not there yet: the action itself then reports that, and the overlay shows no cue.
 */
export async function agentTargetRect(playwrightService: IPlaywrightService, sessionId: string, pageId: string, selector: string, motion: boolean): Promise<IBrowserViewRect | undefined> {
	try {
		const box = await playwrightService.invokeFunctionRaw(sessionId, pageId, (async (page: Page, sel: string, smooth: boolean) => {
			const locator = page.locator(sel).first();
			// a label stands for its field (Playwright fills the field when given the label)
			const rect = () => locator.evaluate((el: Element) => {
				const target = el instanceof HTMLLabelElement && el.control ? el.control : el;
				const r = target.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height, inView: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth };
			}, undefined, { timeout: 3000 });
			let r = await rect();
			if (!r.inView) {
				await locator.evaluate((el: Element, s: boolean) => {
					const target = el instanceof HTMLLabelElement && el.control ? el.control : el;
					target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: s ? 'smooth' : 'instant' });
				}, smooth, { timeout: 3000 });
				await page.waitForTimeout(smooth ? 420 : 30);
				r = await rect();
			}
			return r.width > 0 || r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
		}).toString(), selector, motion) as { x: number; y: number; width: number; height: number } | null;
		return box ?? undefined;
	} catch {
		return undefined;
	}
}
