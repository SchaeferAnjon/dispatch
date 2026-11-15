/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: when the window counts as idle (task-yocgz). A window nobody looks at, hidden or left behind
 *  other apps for half a minute, stops what only decorates: the infinite animations pause, the new-session
 *  page's blocks stop drawing, the bottom bar's cosmetic questions to the CLI wait. A move of the pointer over
 *  the window, a key, or coming back to it wakes everything at once. Pure state, no DOM (dispatchIdle.ts
 *  connects it to the window); tests in ide/tests/idle.test.mjs.
 *--------------------------------------------------------------------------------------------*/

/** How long an unfocused window that nobody touches stays awake. */
export const DISPATCH_IDLE_AFTER_MS = 30_000;

export interface IIdleClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export class DispatchIdleTracker {
	private focused: boolean;
	private visible: boolean;
	private lastActive: number;
	private timer: unknown;
	private _idle = false;
	private readonly clock: IIdleClock;
	private readonly onChange: (idle: boolean) => void;
	private readonly afterMs: number;

	constructor(
		clock: IIdleClock,
		onChange: (idle: boolean) => void,
		start: { readonly focused: boolean; readonly visible: boolean } = { focused: true, visible: true },
		afterMs = DISPATCH_IDLE_AFTER_MS,
	) {
		this.clock = clock;
		this.onChange = onChange;
		this.afterMs = afterMs;
		this.focused = start.focused;
		this.visible = start.visible;
		this.lastActive = clock.now();
		this.settle();
	}

	get idle(): boolean {
		return this._idle;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.lastActive = this.clock.now();
		this.settle();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.lastActive = this.clock.now();
		this.settle();
	}

	/** The pointer moved or a key went down over the window: it is looked at (cheap while awake). */
	interact(): void {
		this.lastActive = this.clock.now();
		if (this._idle) {
			this.settle();
		}
	}

	dispose(): void {
		if (this.timer !== undefined) {
			this.clock.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private settle(): void {
		this.dispose();
		let idle: boolean;
		if (!this.visible) {
			idle = true;
		} else if (this.focused) {
			idle = false;
		} else {
			const left = this.lastActive + this.afterMs - this.clock.now();
			idle = left <= 0;
			if (!idle) {
				// asked again when the time is up (an interaction since then pushes it further)
				this.timer = this.clock.setTimeout(() => {
					this.timer = undefined;
					this.settle();
				}, left);
			}
		}
		if (idle !== this._idle) {
			this._idle = idle;
			this.onChange(idle);
		}
	}
}

/**
 * Runs `fn` at once, then at most once every `gapMs`: calls in between become one run at the end of the gap.
 * The board pushes a change for every log line of every Agent; ten of them writing made a view ask the CLI every
 * 3 s (task-yocgz). `cancel()` drops a run still waiting.
 */
export function throttleLeadingTrailing(clock: IIdleClock, fn: () => void, gapMs: number): { call(): void; cancel(): void } {
	let last = -Infinity;
	let timer: unknown;
	const run = () => {
		timer = undefined;
		last = clock.now();
		fn();
	};
	return {
		call() {
			if (timer !== undefined) {
				return;
			}
			const wait = last + gapMs - clock.now();
			if (wait <= 0) {
				run();
			} else {
				timer = clock.setTimeout(run, wait);
			}
		},
		cancel() {
			if (timer !== undefined) {
				clock.clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
