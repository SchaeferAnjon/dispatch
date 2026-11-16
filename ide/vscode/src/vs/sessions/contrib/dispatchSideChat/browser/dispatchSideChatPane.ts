/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side chat's pane (direction B「Split pane」, user 2026-11-16, task-5im8n, design/side-chat-now;
 *  it replaces direction A's card in the corner, task-23iin, which covered Now). The side pane is split in two under
 *  its tabs: the tab in front (Now, a document, Changes) over the side chat, a 1px line between them. Nothing floats
 *  over anything: the editor (and the docked detail beside it) is laid out shorter by the pane's height
 *  (EditorGroupView.setContentBottomInset), and the pane sits in the room that leaves.
 *
 *  - The line is VS Code's own sash: dragged it moves, a double-click puts it back (55% of the room for the pane, the
 *    old card's height in a window 1200 wide or less). Over the pane at least 32 stays, the pane at least 200; under
 *    120 Now folds into its one line (dispatchNowEditor.ts), whose click puts the line back.
 *  - The head, 28 high: chevron, "Side chat", "· from <session>", and on the pointer ⋯ (Rename…, Delete Side Chat,
 *    the session's other side chats) and × (closes it; the title bar's session menu brings it back). A click on the
 *    head folds the pane to the head alone, at the side pane's bottom, which then says "· Answering" while it writes
 *    and "· 1 new answer" in 500 once it has; another click opens it again.
 *  - The quoted passage at the top of the side chat's list, scrolling with it: the pointer on it lights the passage in
 *    the document, a click scrolls the document back to it.
 *  - The side chat itself is the chat view the conversation has (the same engine and the same chat); the message you
 *    sent, once it has scrolled away, is one quiet line at the top that scrolls back to it (dispatchStickyAsk.ts).
 *  - Once an answer is in, over the input: Add to chat, Keep as comment and Copy.
 *  The sums are dispatchSideChatModel.ts's splitRoom.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatSideChatService } from '../../../../workbench/contrib/chat/common/chatSideChatService.js';
import { IChatModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { AbstractChatView } from '../../../browser/parts/chatView.js';
import { isSessionConversationSideChat } from '../../../browser/sessionConversationGroups.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ISessionContext, SessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { getChatCapabilities, IChat, SessionStatus } from '../../../services/sessions/common/session.js';
import { setActiveSessionContextKeys } from '../../../services/sessions/common/sessionContextKeys.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { DISPATCH_REVEAL_QUOTE_COMMAND, addQuoteToWidget, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { LEARN_MODE_SETTING, LearnMode, learnMode } from '../../dispatchLearn/common/dispatchLearnModel.js';
import { IDispatchWalkService } from '../../dispatchLearn/browser/dispatchWalkService.js';
import { fileName, foldedBadge, ISideChatPassage, ISideChatSplit, passageLine, passageSource, passageWhere, shareForTop, SIDE_CHAT_HEAD, SIDE_CHAT_THIN_PANE, SideChatCardMode, splitRoom, splitSelection } from '../common/dispatchSideChatModel.js';
import { docReaderBody, lightPassage, onDidRenderDoc, PassageLight, scrollToPassage } from './dispatchDocPassage.js';
import { DISPATCH_SIDE_CHAT_CARD_KEY, IDispatchSideChatService } from './dispatchSideChatService.js';

/** `dispatch.openDoc` (dispatchDocsOpen.ts): opens a document's tab in the side pane; by id, not imported. */
const OPEN_DOC_COMMAND = 'dispatch.openDoc';

/** The room over the first message for the quote: 12, its 48, 12. */
const QUOTE_ROOM = 72;

/** What the pane needs of the side pane's editor group (EditorGroupView, with Dispatch's hooks in it). */
interface IInsetGroup {
	readonly element: HTMLElement;
	readonly titleHeight: { readonly offset: number };
	readonly contentTopInset?: number;
	setContentBottomInset?(inset: number): void;
	readonly onDidRelayout?: (listener: () => void) => IDisposable;
}

export class DispatchSideChatPane extends Disposable {

	readonly element: HTMLElement;

	private readonly _head: HTMLElement;
	private readonly _badge: HTMLElement;
	private readonly _view: AbstractChatView;
	private readonly _quote: HTMLElement | undefined;
	private readonly _chatHost: HTMLElement;
	private readonly _acts: HTMLElement;
	private readonly _sash: Sash;
	private readonly _passage: ISideChatPassage | undefined;
	private readonly _answering = observableValue(this, false);
	private readonly _unread = observableValue(this, 0);
	private readonly _flash = this._register(new MutableDisposable());
	private readonly _didTimer = this._register(new MutableDisposable());
	private readonly _relayout = this._register(new MutableDisposable());
	private readonly _groupWatch = this._register(new MutableDisposable());
	private _watchedGroup: IInsetGroup | undefined;
	private _laidOut: { width: number; height: number } | undefined;
	private _split: ISideChatSplit = { top: 0, pane: 0, oneLine: false };
	private _dragFrom: number | undefined;
	private _layingOut = false;
	private _quoteRoom = false;
	private _paneHidden = false;
	private _mode: SideChatCardMode = 'open';
	private _hover = false;
	private _lastFocus = 0;
	private _answer: { text: string; requestId: string; responseId: string } | undefined;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _session: IActiveSession,
		private readonly _chat: IChat,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatViewFactory chatViewFactory: IChatViewFactory,
		@IDispatchSideChatService private readonly _sideChats: IDispatchSideChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChatSideChatService private readonly _chatSideChatService: IChatSideChatService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDispatchWalkService private readonly _walkService: IDispatchWalkService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
	) {
		super();
		const win = dom.getWindow(_container);
		if (win.getComputedStyle(_container).position === 'static') {
			_container.style.position = 'relative';
		}

		// ---- the pane ----
		this.element = dom.$('.dispatch-side-chat-pane', { role: 'complementary', 'data-part': 'side-chat-pane' });
		this.element.setAttribute('aria-label', localize('dispatchSideChat.aria', "Side chat"));
		_container.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));

		// ---- the line over it: VS Code's sash; dragged it moves, a double-click puts it back ----
		this._sash = this._register(new Sash(this.element, { getHorizontalSashTop: () => 0 }, { orientation: Orientation.HORIZONTAL }));
		this._register(this._sash.onDidStart(() => { this._dragFrom = this._split.top; this.element.classList.add('dragging'); }));
		this._register(this._sash.onDidChange(e => {
			if (this._dragFrom !== undefined) {
				this._sideChats.setShare(shareForTop(this.room(), this._dragFrom + e.currentY - e.startY));
			}
		}));
		this._register(this._sash.onDidEnd(() => { this._dragFrom = undefined; this.element.classList.remove('dragging'); }));
		this._register(this._sash.onDidReset(() => this._sideChats.setShare(undefined)));

		// ---- the head: a click folds the pane to it, and opens it again ----
		const head = this._head = dom.append(this.element, dom.$('.dsc-head', { role: 'button', tabindex: '0', 'data-part': 'side-chat-head' }));
		head.title = localize('dispatchSideChat.headTip', "Collapse or expand the side chat");
		dom.append(head, dom.$(`span.dsc-car${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`, { 'aria-hidden': 'true' }));
		dom.append(head, dom.$(`span.dsc-ic${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`, { 'aria-hidden': 'true' }));
		dom.append(head, dom.$('span.dsc-t', undefined, localize('dispatchSideChat.title', "Side chat")));
		const from = dom.append(head, dom.$('span.dsc-from'));
		this._badge = dom.append(head, dom.$('span.dsc-badge', { 'data-part': 'side-chat-badge' }));
		dom.append(head, dom.$('span.dsc-sp'));
		this._register(autorun(reader => {
			const title = _session.title.read(reader);
			from.textContent = title ? localize('dispatchSideChat.from', "· from {0}", title) : '';
			from.title = title;
		}));
		const more = this.iconButton(head, Codicon.ellipsis, localize('dispatchSideChat.more', "More Actions for This Side Chat"), 'more');
		const close = this.iconButton(head, Codicon.close, localize('dispatchSideChat.close', "Close Side Chat"), 'close');
		this._register(dom.addDisposableListener(more, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this.showMenu(more); }));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._sideChats.setMode(_session.sessionId, 'closed'); }));
		const toggle = () => this._sideChats.setMode(_session.sessionId, this._mode === 'open' ? 'min' : 'open');
		this._register(dom.addDisposableListener(head, dom.EventType.CLICK, e => {
			if (!(dom.isHTMLElement(e.target) && e.target.closest('.dsc-ib'))) {
				toggle();
			}
		}));
		this._register(dom.addDisposableListener(head, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === head) {
				dom.EventHelper.stop(e, true);
				toggle();
			}
		}));
		this._register(autorun(reader => {
			const badge = foldedBadge(this._answering.read(reader), this._unread.read(reader));
			this._badge.textContent = badge.text;
			this._badge.classList.toggle('new', badge.bold);
			this._badge.classList.toggle('answering', badge.answering);
		}));

		const body = dom.append(this.element, dom.$('.dsc-body'));

		// ---- the quoted passage: at the top of the side chat's list, it scrolls with it (placeQuote puts it there) ----
		this._passage = _sideChats.passageOf(_chat.resource);
		const sel = splitSelection(_chat.origin?.selection?.text);
		const words = this._passage?.text ?? sel.text;
		if (words.trim()) {
			const q = this._quote = dom.$('button.dsc-quote', { type: 'button', 'data-part': 'side-chat-quote' });
			this.element.classList.add('has-quote');
			// a terminal's output and a command say so in the icon; everything else is a quote (task-q9x2r)
			const quoteIcon = this._passage?.from === 'terminal' ? Codicon.terminal : this._passage?.from === 'learn' && !this._passage.path ? Codicon.package : Codicon.quote;
			dom.append(q, dom.$(`span.dsc-quote-ic${ThemeIcon.asCSSSelector(quoteIcon)}`, { 'aria-hidden': 'true' }));
			const qt = dom.append(q, dom.$('span.dsc-quote-t'));
			dom.append(qt, dom.$('span.dsc-quote-1', undefined, passageLine(words)));
			const where = this._passage ? passageSource(this._passage) : sel.where || localize('dispatchSideChat.inConversation', "In the conversation");
			dom.append(qt, dom.$('span.dsc-quote-2', undefined, where));
			q.title = this._passage?.inDocs
				? localize('dispatchSideChat.quoteTip', "Show the passage in the document")
				: this._passage && !this._passage.path
					? where
					: localize('dispatchSideChat.quoteTipOther', "Show where this was asked");
			this._register(dom.addDisposableListener(q, dom.EventType.MOUSE_ENTER, () => { this._hover = true; this.relight(); }));
			this._register(dom.addDisposableListener(q, dom.EventType.MOUSE_LEAVE, () => { this._hover = false; this.relight(); }));
			// the list under it would take the press as a row's (focus, selection): the quote keeps it
			this._register(dom.addDisposableListener(q, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));
			this._register(dom.addDisposableListener(q, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); void this.goToPassage(); }));
			this._register(toDisposable(() => q.remove()));
		}
		if (this._passage?.inDocs) {
			const path = this._passage.path;
			this._register(onDidRenderDoc(p => { if (p === path) { this.relight(); } }));
		}

		// ---- the side chat: the conversation's own chat view, in its own scope for this session ----
		this._chatHost = dom.append(body, dom.$('.dsc-chat'));
		const scopedKeys = this._register(contextKeyService.createScoped(this._chatHost));
		// the chat view starts its input one line high in here (chatView.ts reads it)
		scopedKeys.createKey(DISPATCH_SIDE_CHAT_CARD_KEY, true);
		this._register(autorun(reader => setActiveSessionContextKeys(_session, scopedKeys, reader)));
		const sessionObs = observableValue<IActiveSession | undefined>(this, _session);
		const scoped = this._register(instantiationService.createChild(new ServiceCollection(
			[IContextKeyService, scopedKeys],
			[ISessionContext, new SessionContext(sessionObs)],
		)));
		this._view = this._register(chatViewFactory.createChatView(scoped));
		this._chatHost.appendChild(this._view.element);
		this._view.setPrimary(false);
		this._view.setActive(true);
		this._view.setVisible(true);
		// sized before its chat comes: a chat that already has answers draws them at once, at the size it has then
		this.layout();
		this._view.setChat(_chat, _session.sessionId, _session);
		this.placeQuote();

		// ---- Add to chat, Keep as comment, Copy: over the input once an answer is in ----
		this._acts = dom.$('.dsc-acts', { 'data-part': 'side-chat-answer-actions' });
		this.act(this._acts, Codicon.reply, localize('dispatchSideChat.addToChat', "Add to chat"), 'add', localize('dispatchSideChat.addToChatTip', "Put the answer into the conversation's input as a quote; you send it"), () => this.addToChat());
		// a comment stays on a file's lines: the terminal's output and a command have none
		if (this._passage?.path) {
			this.act(this._acts, Codicon.comment, localize('dispatchSideChat.keep', "Keep as comment"), 'keep', localize('dispatchSideChat.keepTip', "Keep the answer as a comment on the passage"), b => this.keepAsComment(b));
		}
		this.act(this._acts, Codicon.copy, localize('dispatchSideChat.copy', "Copy"), 'copy', localize('dispatchSideChat.copyTip', "Copy the answer"), b => this.copy(b));
		const widget = this.widget();
		if (widget) {
			this.watchAnswers(widget);
			this._register(widget.onDidChangeViewModel(() => this.placeQuote()));
		}

		// ---- size: follows the side pane, its tabs, the line's place and the window ----
		const ro = new ResizeObserver(() => this.layout());
		ro.observe(_container);
		this._register(toDisposable(() => ro.disconnect()));
		this._register(dom.addDisposableListener(win, dom.EventType.RESIZE, () => this.layout()));
		this._register(this._editorGroupsService.mainPart.onDidLayout(() => this.layout()));
		this._register(this._editorGroupsService.mainPart.onDidActivateGroup(() => this.layout()));
		this._register(autorun(reader => { this._sideChats.share.read(reader); this.layout(); }));
		// gone: the editors get their room back
		this._register(toDisposable(() => this.inset(0)));
		this.setMode('open', 0);
	}

	get chat(): IChat {
		return this._chat;
	}

	get session(): IActiveSession {
		return this._session;
	}

	setMode(mode: SideChatCardMode, unread: number): void {
		const was = this._mode;
		this._mode = mode;
		this._unread.set(unread, undefined);
		this.element.classList.toggle('folded', mode === 'min');
		this.element.classList.toggle('hidden', mode === 'closed');
		this._head.setAttribute('aria-expanded', String(mode === 'open'));
		this._view.setVisible(mode === 'open' && !this._paneHidden);
		this.layout();
		if (mode === 'open' && was !== 'open') {
			// once the pane is drawn again, its list measures its rows at the pane's real size and shows the end
			this.settle();
		}
		this.relight();
	}

	/** Moves the keyboard into the side chat's input (once per request). */
	focus(request: number): void {
		if (request > this._lastFocus) {
			this._lastFocus = request;
			this._view.focus();
		}
	}

	/** The editor group the pane sits under (the side pane has one). */
	private group(): IInsetGroup | undefined {
		return this._editorGroupsService.mainPart.activeGroup as unknown as IInsetGroup | undefined;
	}

	/** The room under the side pane's tabs: what the tab in front and the pane share. */
	private room(): number {
		const g = this.group();
		return g ? Math.max(0, g.element.getBoundingClientRect().height - g.titleHeight.offset - (g.contentTopInset ?? 0)) : 0;
	}

	/** Keeps `px` under every editor of the side pane (and the docked detail beside it) for the pane. */
	private inset(px: number): void {
		for (const g of this._editorGroupsService.mainPart.groups) {
			(g as unknown as IInsetGroup).setContentBottomInset?.(px);
		}
	}

	layout(): void {
		// the first readings come before the chat view is there; the inset set here lays the group out again, and that
		// comes back here
		if (!this._view || this._layingOut) {
			return;
		}
		this._layingOut = true;
		try {
			this.doLayout();
		} finally {
			this._layingOut = false;
		}
	}

	private doLayout(): void {
		const pane = this._container.getBoundingClientRect();
		const g = this.group();
		// the side pane put away (Settings over the window, the pane hidden): the chat is not drawn at no size, and is
		// drawn again at the pane's size when the side pane is back
		const hidden = !g || pane.width < 1 || pane.height < 1;
		if (hidden !== this._paneHidden) {
			this._paneHidden = hidden;
			this._view.setVisible(!hidden && this._mode === 'open');
			if (!hidden) {
				this._laidOut = undefined;
				this.settle();
			}
		}
		if (!g || hidden) {
			return;
		}
		this.watchGroup(g);
		const win = dom.getWindow(this._container);
		const split = this._split = splitRoom(this.room(), win.innerWidth, this._mode, this._sideChats.share.get());
		this.inset(split.pane);
		const box = g.element.getBoundingClientRect();
		const s = this.element.style;
		s.left = `${Math.round(box.left - pane.left - this._container.clientLeft)}px`;
		s.width = `${Math.round(box.width)}px`;
		s.top = `${Math.round(box.bottom - pane.top - this._container.clientTop - split.pane)}px`;
		s.height = `${split.pane}px`;
		this.element.classList.toggle('thin', box.width < SIDE_CHAT_THIN_PANE);
		this.element.dataset.top = String(split.top);
		this._sash.state = this._mode === 'open' ? SashState.Enabled : SashState.Disabled;
		this._sash.layout();
		if (this._mode !== 'open') {
			return;
		}
		const inner = Math.round(box.width);
		const height = Math.max(0, split.pane - 1 - SIDE_CHAT_HEAD);
		this._chatHost.style.height = `${height}px`;
		this._view.layout(inner, height, 0, 0);
		this.placeQuote();
		if (this._laidOut && (this._laidOut.width !== inner || this._laidOut.height !== height)) {
			this.settle();
		}
		this._laidOut = { width: inner, height };
	}

	/** Lays the pane out again when the group does (its tabs come or go, a header shows). */
	private watchGroup(g: IInsetGroup): void {
		if (this._watchedGroup === g) {
			return;
		}
		this._watchedGroup = g;
		this._groupWatch.value = g.onDidRelayout?.(() => this.layout());
	}

	/**
	 * The quote goes at the top of the list's rows, so it scrolls with the messages; the list keeps room for it above
	 * the first message (its own top padding: 12, the quote's 48, 12). The chat widget does not hand out its tree, so it
	 * is reached by name here.
	 */
	private placeQuote(): void {
		const q = this._quote;
		const rows = q && this._chatHost.querySelector<HTMLElement>('.interactive-list .monaco-list-rows');
		if (q && rows && q.parentElement !== rows) {
			rows.prepend(q);
		}
		if (q && !this._quoteRoom) {
			const tree = (this.widget() as unknown as { readonly listWidget?: { readonly _tree?: { updateOptions(o: { paddingTop?: number }): void } } } | undefined)?.listWidget?._tree;
			if (tree) {
				tree.updateOptions({ paddingTop: QUOTE_ROOM });
				this._quoteRoom = true;
			}
		}
	}

	/** On the next frame: the list measures its rows again at the pane's size and shows the end of the chat. */
	private settle(): void {
		const win = dom.getWindow(this._container);
		this._relayout.value = dom.scheduleAtNextAnimationFrame(win, () => {
			if (this._laidOut && this._mode === 'open') {
				this._view.layout(this._laidOut.width, this._laidOut.height, 0, 0);
			}
			this.placeQuote();
			const widget = this.widget(), last = widget?.viewModel?.getItems().at(-1);
			if (widget && last) {
				widget.reveal(last);
			}
		});
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, part: string): HTMLElement {
		const b = dom.append(parent, dom.$('button.dsc-ib', { type: 'button', 'aria-label': label, title: label, 'data-part': `side-chat-${part}` }));
		dom.append(b, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`, { 'aria-hidden': 'true' }));
		return b;
	}

	private act(parent: HTMLElement, icon: ThemeIcon, label: string, part: string, title: string, run: (b: HTMLElement) => void): void {
		const b = dom.append(parent, dom.$('button.dispatch-side-chat-act', { type: 'button', title, 'data-part': `side-chat-${part}` }));
		dom.append(b, dom.$(`span${ThemeIcon.asCSSSelector(icon)}`, { 'aria-hidden': 'true' }));
		dom.append(b, dom.$('span.l', undefined, label));
		this._register(dom.addDisposableListener(b, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); run(b); }));
	}

	/** Says a button did it, for a moment, in its own words. */
	private done(b: HTMLElement, words: string): void {
		const l = b.querySelector<HTMLElement>('.l');
		if (!l) {
			return;
		}
		const was = l.dataset.label ??= l.textContent ?? '';
		l.textContent = words;
		b.classList.add('did');
		const handle = setTimeout(() => { l.textContent = was; b.classList.remove('did'); }, 1600);
		this._didTimer.value = toDisposable(() => clearTimeout(handle));
	}

	private widget(): IChatWidget | undefined {
		const view = this._view as unknown as { readonly widget?: IChatWidget };
		return view.widget;
	}

	/** Follows the side chat's turns: answering or not, the last answer's words, and an answer that came unseen. */
	private watchAnswers(widget: IChatWidget): void {
		const model = observableFromEvent(this, widget.onDidChangeViewModel, () => widget.viewModel?.model as IChatModel | undefined);
		let wasAnswering = false;
		this._register(autorun(reader => {
			const m = model.read(reader);
			const last = m?.lastRequestObs.read(reader);
			const response = last?.response;
			const incomplete = response ? response.isIncomplete.read(reader) : false;
			const answering = !!response && incomplete;
			this._answering.set(answering, undefined);
			const text = response && !incomplete ? response.response.getFinalResponse().trim() || response.response.toString().trim() : '';
			this._answer = last && response && text ? { text, requestId: last.id, responseId: response.id } : undefined;
			this._acts.classList.toggle('on', !!this._answer);
			if (wasAnswering && !answering) {
				this._sideChats.answered(this._session.sessionId, this._chat.resource);
			}
			wasAnswering = answering;
		}));
		// over the input, where the session's pills float (the transcript scrolls under them)
		const holder = widget.inputPart.persistentContentContainerElement;
		holder.appendChild(this._acts);
		this._register(toDisposable(() => this._acts.remove()));
	}

	private relight(): void {
		const p = this._passage;
		if (!p?.inDocs) {
			return;
		}
		const win = dom.getWindow(this._container);
		const light: PassageLight = this._mode !== 'open' ? 'none' : this._hover || this._flash.value ? 'strong' : 'soft';
		lightPassage(docReaderBody(win.document, p.path), p, light, win);
	}

	/** The quote's click: the document scrolls back to the passage and lights it; else where it was asked. */
	private async goToPassage(): Promise<void> {
		const p = this._passage;
		if (!p) {
			await this._chatSideChatService.revealSideChatSource(this._chat.resource);
			return;
		}
		if (!p.path) {
			// the terminal's output, a command: nothing to go back to (the quote's hover says where it was)
			return;
		}
		if (!p.inDocs) {
			const uri = URI.file(p.path).toString();
			await this._commandService.executeCommand(DISPATCH_REVEAL_QUOTE_COMMAND, { v: 1, text: p.text, source: { from: 'file', label: passageWhere(p), uri, file: p.path, startLine: p.start, endLine: p.end } });
			return;
		}
		const win = dom.getWindow(this._container);
		let body = docReaderBody(win.document, p.path);
		if (!body) {
			await this._commandService.executeCommand(OPEN_DOC_COMMAND, p.path);
			for (let i = 0; i < 50 && !body; i++) {
				await new Promise(r => setTimeout(r, 100));
				body = docReaderBody(win.document, p.path);
			}
		}
		if (!body || this._store.isDisposed) {
			return;
		}
		const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
		scrollToPassage(body, p, !reduce);
		// lit fully for a moment, then softly again
		const handle = setTimeout(() => { this._flash.clear(); this.relight(); }, 1400);
		this._flash.value = toDisposable(() => clearTimeout(handle));
		this.relight();
	}

	private addToChat(): void {
		const answer = this._answer;
		if (!answer) {
			return;
		}
		const main = this._session.mainChat.get();
		const widget = this._chatWidgetService.getWidgetBySessionResource(main.resource);
		if (!widget) {
			this._notificationService.warn(localize('dispatchSideChat.noMain', "The conversation's input is not on screen."));
			return;
		}
		const label = this._passage?.path ? localize('dispatchSideChat.quoteLabel', "Side chat · {0}", fileName(this._passage.path)) : localize('dispatchSideChat.quoteLabelBare', "Side chat");
		addQuoteToWidget(widget, toQuoteEntry(answer.text, {
			from: 'reply',
			label,
			icon: Codicon.commentDiscussion.id,
			chat: this._chat.resource.toString(),
			requestId: answer.requestId,
			responseId: answer.responseId,
			at: Date.now(),
		}));
	}

	private keepAsComment(b: HTMLElement): void {
		const answer = this._answer, p = this._passage;
		if (!answer || !p) {
			return;
		}
		this._sideChats.addComment({ path: p.path, start: p.start, end: p.end, text: p.text, body: answer.text, chat: this._chat.resource.toString() });
		this.done(b, localize('dispatchSideChat.kept', "Kept on {0}", passageWhere(p)));
	}

	private async copy(b: HTMLElement): Promise<void> {
		if (!this._answer) {
			return;
		}
		await this._clipboardService.writeText(this._answer.text);
		this.done(b, localize('dispatchSideChat.copied', "Copied"));
	}

	private showMenu(anchor: HTMLElement): void {
		const caps = getChatCapabilities(this._chat, this._session, undefined);
		const actions: IAction[] = [];
		if (caps.canRename) {
			actions.push(new Action('dispatch.sideChat.rename', localize('dispatchSideChat.rename', "Rename…"), undefined, true, () => this.rename()));
		}
		if (caps.canDelete) {
			actions.push(new Action('dispatch.sideChat.delete', localize('dispatchSideChat.delete', "Delete Side Chat"), undefined, true, () => this.delete()));
		}
		// the session's other side chats: switching is here and in the title bar's session menu
		const others = this._session.chats.get().filter(c => isSessionConversationSideChat(c) && c.status.get() !== SessionStatus.Untitled && c.resource.toString() !== this._chat.resource.toString());
		if (others.length) {
			actions.push(new Separator(), new Action('dispatch.sideChat.othersHead', localize('dispatchSideChat.others', "Other Side Chats"), undefined, false));
			for (const c of others) {
				const p = this._sideChats.passageOf(c.resource);
				const title = c.title.get() || localize('dispatchSideChat.untitled', "Untitled Side Chat");
				actions.push(new Action(`dispatch.sideChat.open.${c.resource.toString()}`, p?.path ? `${title} · ${fileName(p.path)}` : title, undefined, true,
					() => this._sideChats.show(this._session.sessionId, c.resource, { focus: true })));
			}
		}
		// Walk me through the turn that just ended, the same walk as the pill and the Now tab's button (task-fktjx)
		if (this._walkService.offer.get()?.sessionId === this._session.sessionId) {
			actions.push(new Separator(), new Action('dispatch.learn.walk', localize('dispatchSideChat.walk', "Walk Me Through This Turn"), undefined, true, () => this._walkService.start()));
		}
		// Quiet or Talk while the agent works, the same setting as Settings › Learning (task-q9x2r, design/learn-scene)
		const mode = learnMode(this._configurationService.getValue(LEARN_MODE_SETTING));
		const setMode = (m: LearnMode) => this._configurationService.updateValue(LEARN_MODE_SETTING, m, ConfigurationTarget.USER);
		const quiet = new Action('dispatch.learn.quiet', localize('dispatchSideChat.quiet', "Quiet: Only When You Ask"), undefined, true, () => setMode('quiet'));
		quiet.checked = mode === 'quiet';
		const talk = new Action('dispatch.learn.talk', localize('dispatchSideChat.talk', "Talk: Small Cards"), undefined, true, () => setMode('talk'));
		talk.checked = mode === 'talk';
		actions.push(
			new Separator(),
			new Action('dispatch.learn.head', localize('dispatchSideChat.whileWorking', "While the Agent Works"), undefined, false),
			quiet,
			talk,
			new Separator(),
			new Action('dispatch.learn.settings', localize('dispatchSideChat.learnSettings', "Learning Settings…"), undefined, true, () => this._commandService.executeCommand('dispatch.settings.open', 'learning', 'learn-mode')),
		);
		anchor.classList.add('open');
		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => anchor.classList.remove('open'),
		});
	}

	private async rename(): Promise<void> {
		const value = this._chat.title.get();
		const title = await this._quickInputService.input({
			value,
			valueSelection: [0, value.length],
			prompt: localize('dispatchSideChat.renamePrompt', "Name of this side chat"),
		});
		if (title?.trim()) {
			await this._sessionsManagementService.renameChat(this._session, this._chat.resource, title.trim());
		}
	}

	/** Deleting a chat asks first (sessionsManagementService's own question); a side chat that is gone closes its pane. */
	private async delete(): Promise<void> {
		const session = this._session, id = this._chat.resource.toString(), chat = this._chat.resource, sideChats = this._sideChats;
		try {
			await this._sessionsManagementService.deleteChat(session, chat);
			if (!session.chats.get().some(c => c.resource.toString() === id)) {
				sideChats.forget(session.sessionId, chat);
			}
		} catch (e) {
			this._logService.error('[dispatch] side chat: could not delete', e);
			this._notificationService.error(localize('dispatchSideChat.deleteFailed', "The side chat could not be deleted."));
		}
	}

	override dispose(): void {
		const win = dom.getWindow(this._container);
		if (this._passage?.inDocs) {
			lightPassage(undefined, undefined, 'none', win);
		}
		super.dispose();
	}
}
