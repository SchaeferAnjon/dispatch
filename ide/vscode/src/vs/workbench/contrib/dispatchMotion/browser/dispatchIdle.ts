/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the window's idle state (task-yocgz), connecting dispatchIdleModel.ts to the window. Hidden, or
 *  unfocused and untouched for 30 s: `dispatch-window-idle` goes on the body, every infinite animation pauses
 *  (new ones too, the moment they start), `onDidChangeDispatchWindowIdle` fires, and the things that redraw
 *  by themselves (the new-session page's blocks) and the cosmetic pollers (`dispatchActiveInterval`) wait.
 *  Anything that wakes the window (focus, pointer, key, shown again) resumes it all.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { DispatchIdleTracker } from './dispatchIdleModel.js';

export const DISPATCH_IDLE_CLASS = 'dispatch-window-idle';

const onChange = new Emitter<boolean>();
let idleNow = false;

/** True while the window is hidden, or unfocused and untouched for 30 s. */
export function isDispatchWindowIdle(): boolean {
	return idleNow;
}

/** Fires with true when the window goes idle, false when it wakes. */
export const onDidChangeDispatchWindowIdle: Event<boolean> = onChange.event;

/**
 * `setInterval` for a question only an awake window shows (the bottom bar's builds, the accounts' allowances):
 * not run while idle; one run at once when the window wakes, since it may have missed some.
 */
export function dispatchActiveInterval(win: Window, fn: () => void, ms: number): IDisposable {
	const timer = win.setInterval(() => {
		if (!idleNow) {
			fn();
		}
	}, ms);
	const woke = onChange.event(idle => {
		if (!idle) {
			fn();
		}
	});
	return toDisposable(() => {
		win.clearInterval(timer);
		woke.dispose();
	});
}

const isInfinite = (a: Animation): boolean => a.effect?.getComputedTiming().iterations === Infinity;

/** Starts tracking `win`; dispose to stop and let everything run again. */
export function trackDispatchWindowIdle(win: Window & typeof globalThis): IDisposable {
	const doc = win.document;
	const paused = new Set<Animation>();
	const pauseAll = () => {
		for (const a of doc.getAnimations()) {
			if (a.playState === 'running' && isInfinite(a)) {
				a.pause();
				paused.add(a);
			}
		}
	};
	const resumeAll = () => {
		for (const a of paused) {
			a.play();
		}
		paused.clear();
	};
	const tracker = new DispatchIdleTracker(
		{ now: () => Date.now(), setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: h => win.clearTimeout(h as number) },
		idle => {
			idleNow = idle;
			doc.body.classList.toggle(DISPATCH_IDLE_CLASS, idle);
			if (idle) {
				pauseAll();
			} else {
				resumeAll();
			}
			onChange.fire(idle);
		},
		{ focused: doc.hasFocus(), visible: doc.visibilityState === 'visible' },
	);
	const listeners: IDisposable[] = [];
	const on = (target: EventTarget, type: string, fn: (e: globalThis.Event) => void, capture = false) => {
		target.addEventListener(type, fn as EventListener, { capture, passive: true });
		listeners.push(toDisposable(() => target.removeEventListener(type, fn as EventListener, { capture })));
	};
	on(win, 'focus', () => tracker.setFocused(true));
	on(win, 'blur', () => tracker.setFocused(false));
	on(doc, 'visibilitychange', () => tracker.setVisible(doc.visibilityState === 'visible'));
	for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
		on(doc, type, () => tracker.interact(), true);
	}
	// an animation that starts while idle (a session began working overnight) waits too
	on(doc, 'animationstart', e => {
		if (idleNow && e.target instanceof win.Element) {
			for (const a of e.target.getAnimations()) {
				if (a.playState === 'running' && isInfinite(a)) {
					a.pause();
					paused.add(a);
				}
			}
		}
	}, true);
	return toDisposable(() => {
		tracker.dispose();
		for (const l of listeners) {
			l.dispose();
		}
		idleNow = false;
		doc.body.classList.remove(DISPATCH_IDLE_CLASS);
		resumeAll();
	});
}
