/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the side chat's pane remembers (direction B「Split pane」, user 2026-11-16, task-5im8n,
 *  design/side-chat-now; it was direction A's card, task-23iin).
 *
 *  - Per session, the side chat its pane shows and how: open, folded to its head, or closed; and how many answers
 *    came while nobody looked. The pane itself is dispatchSideChatPane.ts, put up by dispatchSideChat.contribution.ts.
 *  - The pane's share of the side pane once the person dragged the line over it (undefined: the default), kept
 *    across restarts.
 *  - Per side chat, the passage it was asked about (a document's lines and words), so the pane's quote lights the
 *    passage and goes back to it; kept across restarts.
 *  - The answers kept as comments on a document's passage (Keep as comment); the Docs reader draws them
 *    (dispatchDocPassage.ts).
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IDocComment, ISideChatPassage, parseComments, SideChatCardMode, unreadAfterAnswer, withComment } from '../common/dispatchSideChatModel.js';

/** The pane of one session. */
export interface ISideChatCard {
	/** The side chat's resource. */
	readonly chat: string;
	readonly mode: SideChatCardMode;
	/** Answers that came while the pane was folded or closed. */
	readonly unread: number;
	/** Bumped when the pane should take the keyboard (a new side chat to type in). */
	readonly focus: number;
}

/** A context key, true inside a side chat's pane: the chat view there starts its input one line high (chatView.ts). */
export const DISPATCH_SIDE_CHAT_CARD_KEY = 'dispatchSideChatCard';

/** `dispatch.sideChat.open(sessionId, chatResource)`: the session's pane on that side chat, the keyboard in it. */
export const DISPATCH_SIDE_CHAT_OPEN_COMMAND = 'dispatch.sideChat.open';

/** `dispatch.sideChat.resetSplit`: the line between the tab and the side chat back where it starts (Now's one line). */
export const DISPATCH_SIDE_CHAT_RESET_SPLIT_COMMAND = 'dispatch.sideChat.resetSplit';

export const IDispatchSideChatService = createDecorator<IDispatchSideChatService>('dispatchSideChatService');

export interface IDispatchSideChatService {
	readonly _serviceBrand: undefined;

	/** The panes, by session id. */
	readonly cards: IObservable<ReadonlyMap<string, ISideChatCard>>;
	/** The pane's share of the room under the side pane's tabs, once dragged; undefined: the default. */
	readonly share: IObservable<number | undefined>;
	setShare(share: number | undefined): void;
	/** Opens the pane of `sessionId` on this side chat (another one it showed is replaced). */
	show(sessionId: string, chat: URI, options?: { readonly focus?: boolean }): void;
	setMode(sessionId: string, mode: SideChatCardMode): void;
	/** A turn of this side chat ended: unread while nobody looks. */
	answered(sessionId: string, chat: URI): void;

	passageOf(chat: URI): ISideChatPassage | undefined;
	setPassage(chat: URI, passage: ISideChatPassage): void;
	/** The side chat was deleted: its pane closes and its passage is forgotten. */
	forget(sessionId: string, chat: URI): void;

	readonly comments: IObservable<readonly IDocComment[]>;
	addComment(comment: Omit<IDocComment, 'id' | 'at'>): void;
	removeComment(id: string): void;
}

const PASSAGES_KEY = 'dispatch.sideChat.passages';
const COMMENTS_KEY = 'dispatch.docs.comments';
const SHARE_KEY = 'dispatch.sideChat.share';
/** Passages kept for at most this many side chats (the oldest go first). */
const MAX_PASSAGES = 300;

export class DispatchSideChatService extends Disposable implements IDispatchSideChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _cards = observableValue<ReadonlyMap<string, ISideChatCard>>(this, new Map());
	readonly cards: IObservable<ReadonlyMap<string, ISideChatCard>> = this._cards;

	private readonly _comments = observableValue<readonly IDocComment[]>(this, []);
	readonly comments: IObservable<readonly IDocComment[]> = this._comments;

	private readonly _share = observableValue<number | undefined>(this, undefined);
	readonly share: IObservable<number | undefined> = this._share;

	private _passages: Record<string, ISideChatPassage & { readonly at?: number }>;
	private _focus = 0;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this._passages = this.readPassages();
		const share = Number(storageService.get(SHARE_KEY, StorageScope.APPLICATION));
		this._share.set(share > 0 && share < 1 ? share : undefined, undefined);
		this._comments.set(parseComments(storageService.get(COMMENTS_KEY, StorageScope.APPLICATION)), undefined);
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, COMMENTS_KEY, this._store)(() => {
			this._comments.set(parseComments(storageService.get(COMMENTS_KEY, StorageScope.APPLICATION)), undefined);
		}));
	}

	private readPassages(): Record<string, ISideChatPassage> {
		try {
			const v = JSON.parse(this.storageService.get(PASSAGES_KEY, StorageScope.APPLICATION) ?? '{}');
			return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
		} catch {
			return {};
		}
	}

	private update(sessionId: string, fn: (card: ISideChatCard | undefined) => ISideChatCard | undefined): void {
		const next = new Map(this._cards.get());
		const card = fn(next.get(sessionId));
		if (card) {
			next.set(sessionId, card);
		} else {
			next.delete(sessionId);
		}
		this._cards.set(next, undefined);
	}

	setShare(share: number | undefined): void {
		const next = share !== undefined && share > 0 && share < 1 ? share : undefined;
		if (next === this._share.get()) {
			return;
		}
		this._share.set(next, undefined);
		if (next === undefined) {
			this.storageService.remove(SHARE_KEY, StorageScope.APPLICATION);
		} else {
			this.storageService.store(SHARE_KEY, String(next), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	show(sessionId: string, chat: URI, options?: { readonly focus?: boolean }): void {
		const id = chat.toString();
		if (options?.focus) {
			this._focus++;
		}
		this.update(sessionId, card => ({ chat: id, mode: 'open', unread: 0, focus: options?.focus ? this._focus : (card?.focus ?? 0) }));
	}

	setMode(sessionId: string, mode: SideChatCardMode): void {
		this.update(sessionId, card => card && { ...card, mode, unread: mode === 'open' ? 0 : card.unread });
	}

	answered(sessionId: string, chat: URI): void {
		this.update(sessionId, card => card && card.chat === chat.toString() ? { ...card, unread: unreadAfterAnswer(card.mode, card.unread) } : card);
	}

	passageOf(chat: URI): ISideChatPassage | undefined {
		return this._passages[chat.toString()];
	}

	setPassage(chat: URI, passage: ISideChatPassage): void {
		this._passages = { ...this._passages, [chat.toString()]: { ...passage, at: Date.now() } };
		const keys = Object.keys(this._passages);
		if (keys.length > MAX_PASSAGES) {
			const old = keys.sort((a, b) => (this._passages[a].at ?? 0) - (this._passages[b].at ?? 0)).slice(0, keys.length - MAX_PASSAGES);
			const kept = { ...this._passages };
			for (const k of old) {
				delete kept[k];
			}
			this._passages = kept;
		}
		this.storageService.store(PASSAGES_KEY, JSON.stringify(this._passages), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	forget(sessionId: string, chat: URI): void {
		const id = chat.toString();
		this.update(sessionId, card => card?.chat === id ? undefined : card);
		if (this._passages[id]) {
			const kept = { ...this._passages };
			delete kept[id];
			this._passages = kept;
			this.storageService.store(PASSAGES_KEY, JSON.stringify(this._passages), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	addComment(comment: Omit<IDocComment, 'id' | 'at'>): void {
		this.storeComments(withComment(this._comments.get(), { ...comment, id: generateUuid(), at: Date.now() }));
	}

	removeComment(id: string): void {
		this.storeComments(this._comments.get().filter(c => c.id !== id));
	}

	private storeComments(all: readonly IDocComment[]): void {
		this._comments.set(all, undefined);
		this.storageService.store(COMMENTS_KEY, JSON.stringify(all), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

registerSingleton(IDispatchSideChatService, DispatchSideChatService, InstantiationType.Delayed);
