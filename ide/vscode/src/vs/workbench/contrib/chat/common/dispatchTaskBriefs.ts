/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the window already knows about a task, by its id (task-86t0e).
 *
 *  A task link in a reply opens the task in the side pane's Tasks tab. Asking the board for it is a CLI run
 *  (`dispatch task show <id> --brief --json` through dispatch-bridge: a process, then bd), 0.3 to 2 s, more while
 *  other agents write. So the answers are kept here: the links in a reply ask for their tasks as soon as the reply is
 *  drawn (a few at a time, the click's own question first), the Tasks tab adds every list it gets, and a click shows
 *  what is here at once and asks again in the background. No imports: the tests load it as it is (ide/tests).
 *--------------------------------------------------------------------------------------------*/

export interface IDispatchTaskBrief {
	readonly id: string;
	readonly title?: string;
	readonly error?: string;
}

interface IEntry<T> {
	readonly value: T;
	readonly at: number;
}

interface IQueued<T> {
	readonly id: string;
	readonly ask: (id: string) => Promise<T | undefined>;
	readonly resolve: (value: T | undefined) => void;
}

export interface IDispatchTaskBriefsOptions {
	/** How long an answer counts as fresh: a newer question is not asked again (ms). */
	readonly freshMs?: number;
	/** Questions at once: the rest wait in line (each is a CLI process). */
	readonly concurrency?: number;
	/** Answers kept, the oldest go first. */
	readonly max?: number;
	readonly now?: () => number;
}

export class DispatchTaskBriefs<T extends IDispatchTaskBrief = IDispatchTaskBrief> {

	private readonly entries = new Map<string, IEntry<T>>();
	private readonly asking = new Map<string, Promise<T | undefined>>();
	private readonly queue: IQueued<T>[] = [];
	private running = 0;
	private readonly freshMs: number;
	private readonly concurrency: number;
	private readonly max: number;
	private readonly now: () => number;

	constructor(options: IDispatchTaskBriefsOptions = {}) {
		this.freshMs = options.freshMs ?? 5 * 60_000;
		this.concurrency = Math.max(1, options.concurrency ?? 2);
		this.max = Math.max(1, options.max ?? 300);
		this.now = options.now ?? Date.now;
	}

	/** What is known about the task, however old (a click shows it at once). */
	peek(id: string): T | undefined {
		return this.entries.get(id)?.value;
	}

	/** Whether an answer this young is here: no need to ask. */
	isFresh(id: string): boolean {
		const e = this.entries.get(id);
		return !!e && this.now() - e.at < this.freshMs;
	}

	/** Answers that came another way (a Tasks list): a task without an error replaces what was known. */
	remember(tasks: readonly T[]): void {
		for (const t of tasks) {
			if (t && typeof t.id === 'string' && t.id && !t.error) {
				this.put(t.id, t);
			}
		}
	}

	/**
	 * The task: the fresh answer when there is one (unless `fresh`), else a question to the board through `ask`,
	 * shared with one already on its way. `urgent` puts it at the front of the line (a click, not a reply drawn).
	 * An error answer (no such task) is returned but not kept: the next question asks again.
	 */
	get(id: string, ask: (id: string) => Promise<T | undefined>, options: { fresh?: boolean; urgent?: boolean } = {}): Promise<T | undefined> {
		if (!options.fresh && this.isFresh(id)) {
			return Promise.resolve(this.peek(id));
		}
		const on = this.asking.get(id);
		if (on) {
			if (options.urgent) {
				this.promote(id);
			}
			return on;
		}
		const p = new Promise<T | undefined>(resolve => {
			const item: IQueued<T> = { id, ask, resolve };
			if (options.urgent) {
				this.queue.unshift(item);
			} else {
				this.queue.push(item);
			}
		});
		this.asking.set(id, p);
		this.pump();
		return p;
	}

	/** Asks for each task not known fresh, in the background, behind any click. */
	prefetch(ids: readonly string[], ask: (id: string) => Promise<T | undefined>): void {
		for (const id of new Set(ids)) {
			if (!this.isFresh(id) && !this.asking.has(id)) {
				void this.get(id, ask);
			}
		}
	}

	/** How many questions wait in line or run (for the tests). */
	get pending(): number {
		return this.asking.size;
	}

	private promote(id: string): void {
		const i = this.queue.findIndex(q => q.id === id);
		if (i > 0) {
			this.queue.unshift(...this.queue.splice(i, 1));
		}
	}

	private pump(): void {
		while (this.running < this.concurrency && this.queue.length) {
			const item = this.queue.shift()!;
			this.running++;
			item.ask(item.id).then(value => value, () => undefined).then(value => {
				this.running--;
				this.asking.delete(item.id);
				if (value && !value.error) {
					this.put(item.id, value);
				}
				item.resolve(value);
				this.pump();
			});
		}
	}

	private put(id: string, value: T): void {
		this.entries.delete(id);
		this.entries.set(id, { value, at: this.now() });
		while (this.entries.size > this.max) {
			this.entries.delete(this.entries.keys().next().value!);
		}
	}
}

/** The window's one store: the chat's task links and the Tasks tab share it. */
export const dispatchTaskBriefs = new DispatchTaskBriefs();
