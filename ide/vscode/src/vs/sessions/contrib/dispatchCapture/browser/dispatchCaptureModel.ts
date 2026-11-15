/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the person asks for in a chat goes on the board by itself (patches/
 *  415-next-up.patch; kanban design/chat-capture, direction B "Next up queue", task-tix5).
 *  This is the window's copy of the receipts (`dispatch capture list`, app/cli/capture.py): one per message the
 *  person sent that had something in it, matched to the message by its words. Every message the window sends goes
 *  to `dispatch capture note` through dispatch-bridge's `dispatch.capture`; the answer is the receipt.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export const CAPTURE_COMMAND = 'dispatch.capture';

export type CaptureState = 'next' | 'later' | 'working' | 'waiting' | 'done' | 'gone' | 'merged' | 'todo' | 'same' | 'part';

export interface ICaptureItem {
	readonly kind: 'new' | 'same' | 'part';
	readonly task: string;
	readonly title: string;
	readonly quote: string;
	readonly project?: string;
	readonly state: CaptureState;
	readonly task_state?: CaptureState;
	readonly pos?: number;
	readonly ahead?: number;
	readonly into?: string;
	readonly into_title?: string;
	readonly step?: string;
	readonly done_at?: number;
}

/** One thing in the line (`dispatch nextup list`): pos is its place, 1 starts next. */
export interface INextUpRow {
	readonly id: string;
	readonly title: string;
	readonly project: string;
	readonly quote: string;
	readonly at: number;
	readonly session: string;
	readonly new: boolean;
	readonly pos?: number;
	/** The message it came from (its receipt), for a head over the things one message lined up. */
	readonly receipt?: string;
	readonly said?: string;
}

/** The thing in line that did not start (`dispatch nextup list`, capture.py failed_view): why, in plain words. */
export interface INextUpFailed {
	readonly task: string;
	readonly title: string;
	readonly why: string;
	readonly tries: number;
	/** Tried three times: nothing starts until the person says Try again. */
	readonly stuck: boolean;
	/** When it is tried again (epoch seconds); 0 when it is not. */
	readonly retry_at: number;
}

export interface INextUpLine {
	/** Start by itself is off (it is until the person turns it on): nothing in line starts on its own. */
	readonly paused: boolean;
	readonly limit: number;
	readonly next: readonly INextUpRow[];
	readonly later: readonly INextUpRow[];
	/** In progress on the board with nobody on it (no live session, nothing for an hour): `since` is the last word. */
	readonly idle?: readonly (INextUpRow & { readonly since?: number })[];
	readonly failed?: INextUpFailed | Record<string, never>;
}

/** The failed start of a line, when there is one. */
export function nextUpFailed(line: INextUpLine | undefined): INextUpFailed | undefined {
	const f = line?.failed as INextUpFailed | undefined;
	return f && f.task ? f : undefined;
}

export interface ICaptureReceipt {
	readonly id: string;
	readonly session: string;
	readonly text: string;
	readonly at: number;
	readonly items: readonly ICaptureItem[];
	readonly left_out: readonly { readonly kind: 'question' | 'not_doing' | 'for_agent'; readonly quote: string }[];
	readonly count: number;
	readonly next_pos: number;
	readonly paused: boolean;
	readonly first: boolean;
}

/** The words of a message as the CLI keeps them (whitespace folded, the first 1200 characters). */
export function captureKey(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(' ').slice(0, 1200);
}

/** Said in passing and never noted: no need to ask the CLI at all (it says the same, a moment later). */
const CHAT = /^(?:ok(?:ay)?|k|yes|yep|yeah|no|nope|sure|thanks?(?: you)?|thx|ty|great|nice|cool|good|fine|got it|go on|go ahead|continue|carry on|keep going|do it|done|lgtm|perfect|hi|hello|hey|bye|好|好的|好吧|嗯|嗯嗯|对|对的|是|是的|行|可以|没问题|谢谢|多谢|继续|接着做|开始吧|开始|收到|明白|了解|晚安|你好|辛苦了|不错|很好|棒)[\s!！.。,，~～?？]*$/i;

export function skipped(text: string): boolean {
	const t = captureKey(text);
	return t.length <= 3 || CHAT.test(t) || t.startsWith('[From Assistant]') || /^\/\S+$/.test(t);
}

/** How long a message is being read before the line says so (a quick "nothing to note" never shows it). */
export const NOTING_AFTER_MS = 1200;

/** Receipts older than this are read again when a line is drawn. */
const STALE_MS = 8000;

export class DispatchCaptureModel {

	private readonly receipts = new Map<string, ICaptureReceipt>();
	private readonly pendingSince = new Map<string, number>();
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	private loaded = false;
	private loadedAt = 0;
	private loading: Promise<void> | undefined;
	/** Start by itself is off until the person turns it on (capture.py queue_state). */
	paused = true;
	hintSeen = false;
	/** The whole line (Next up and Later), read only once a side pane tab shows it. */
	line: INextUpLine | undefined;
	private lineAt = 0;
	private lineLoading: Promise<void> | undefined;
	private lineAgain = false;

	constructor(private readonly commandService: ICommandService) { }

	get(text: string): ICaptureReceipt | undefined {
		return this.receipts.get(captureKey(text));
	}

	/** Being read for longer than NOTING_AFTER_MS: the line says "Noting…". */
	noting(text: string): boolean {
		const since = this.pendingSince.get(captureKey(text));
		return since !== undefined && Date.now() - since >= NOTING_AFTER_MS;
	}

	all(): ICaptureReceipt[] {
		return [...this.receipts.values()];
	}

	/** The newest receipt with something noted: the first-time sentence goes under that one only. */
	newest(): string | undefined {
		let best: ICaptureReceipt | undefined;
		for (const r of this.receipts.values()) {
			if (r.items.length && (!best || r.at > best.at)) {
				best = r;
			}
		}
		return best?.id;
	}

	async refresh(): Promise<void> {
		if (this.loading) {
			return this.loading;
		}
		this.loading = (async () => {
			try {
				const r = await this.commandService.executeCommand<{ receipts?: ICaptureReceipt[]; paused?: boolean }>(CAPTURE_COMMAND, 'list');
				if (r && Array.isArray(r.receipts)) {
					this.receipts.clear();
					for (const x of r.receipts) {
						this.receipts.set(captureKey(x.text), x);
					}
					this.paused = !!r.paused;
					this.loaded = true;
					this.loadedAt = Date.now();
					this._onDidChange.fire();
				}
			} catch {
				// no bridge (tests, a window without Dispatch): nothing to show
			} finally {
				this.loading = undefined;
			}
		})();
		return this.loading;
	}

	/** A line is drawn: read again when what we have is older than STALE_MS (a session opened again after a while
	 *  must not show a thing as next up that was delivered meanwhile). */
	ensureLoaded(): void {
		if ((!this.loaded || Date.now() - this.loadedAt > STALE_MS) && !this.loading) {
			void this.refresh();
		}
	}

	/** The line as `dispatch nextup list` has it now. */
	async refreshLine(): Promise<void> {
		if (this.lineLoading) {
			// a read started before a change (a click, the board) answers with the line before it: read once more after it
			this.lineAgain = true;
			return this.lineLoading.then(() => this.lineAgain ? this.refreshLine() : undefined);
		}
		this.lineAgain = false;
		this.lineLoading = (async () => {
			try {
				const r = await this.commandService.executeCommand<INextUpLine>(CAPTURE_COMMAND, 'nextup');
				if (r && Array.isArray(r.next) && Array.isArray(r.later)) {
					this.line = r;
					this.lineAt = Date.now();
					this.paused = !!r.paused;
					this._onDidChange.fire();
				}
			} catch {
				// no bridge: no line
			} finally {
				this.lineLoading = undefined;
			}
		})();
		return this.lineLoading;
	}

	/** A tab that shows the line asks for it when it draws; read again when older than `maxAgeMs`. */
	ensureLine(maxAgeMs = 5000): void {
		if ((!this.line || Date.now() - this.lineAt > maxAgeMs) && !this.lineLoading) {
			void this.refreshLine();
		}
	}

	/** A message the person just sent: read it, and show the receipt under it when it comes. */
	async note(text: string, session: string, cwd: string | undefined, title: string | undefined, chat = false): Promise<void> {
		if (skipped(text)) {
			return;
		}
		const key = captureKey(text);
		this.pendingSince.set(key, Date.now());
		const later = setTimeout(() => this._onDidChange.fire(), NOTING_AFTER_MS + 20);
		try {
			const r = await this.commandService.executeCommand<ICaptureReceipt & { ok?: boolean }>(CAPTURE_COMMAND, 'note', { text, session, cwd, title, chat });
			if (r && r.id && Array.isArray(r.items)) {
				this.receipts.set(key, r);
				this.paused = !!r.paused;
			}
		} catch {
			// the line just stays away
		} finally {
			clearTimeout(later);
			this.pendingSince.delete(key);
			this._onDidChange.fire();
		}
	}

	/** One of the panel's buttons; then everything is read again (positions move for every receipt). */
	async act(op: string, arg?: object): Promise<{ ok?: boolean; error?: string; targets?: { id: string; title: string; state: string }[] } | undefined> {
		let r: { ok?: boolean; error?: string } | undefined;
		try {
			r = await this.commandService.executeCommand(CAPTURE_COMMAND, op, arg ?? {});
		} catch (e) {
			r = { ok: false, error: String(e) };
		}
		if (op === 'pause' || op === 'resume') {
			this.paused = op === 'pause';
		}
		if (op === 'seen') {
			this.hintSeen = true;
		}
		if (op !== 'targets') {
			this._onDidChange.fire();
			await Promise.all([this.refresh(), this.line ? this.refreshLine() : undefined]);
		}
		return r;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

let shared: DispatchCaptureModel | undefined;

/** One model per window: the chat's lines, the Tasks tab and the Now tab read the same receipts. */
export function captureModel(commandService: ICommandService): DispatchCaptureModel {
	if (!shared) {
		shared = new DispatchCaptureModel(commandService);
	}
	return shared;
}

/** The home and the lines tell each other when the line moved (a click on one changes the other). */
export const onDidChangeNextUp = new Emitter<void>();
