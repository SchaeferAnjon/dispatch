/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the side chat card (direction A「Bottom-right card」, user 2026-11-15, task-23iin, kanban
 *  design/side-chat: "这样能融入到我们这个教学里面"). A side chat no longer splits the conversation column into two
 *  narrow ones: it floats in the side pane's bottom right corner, about half the pane wide and a little more than half
 *  its height, and the conversation keeps its whole column.
 *
 *  - Its own head: "Side chat · from <session>", and its own ⋯ (Rename…, Delete Side Chat, the session's other side
 *    chats), – (folds it into the pill) and × (closes it; the title bar's session menu brings it back).
 *  - On top the quoted passage (the quote card's look): the pointer on it lights the passage in the document, a click
 *    scrolls the document back to it.
 *  - Under it the side chat itself, the same chat view the conversation has (the same engine and the same chat), so
 *    a follow-up is typed in its own input.
 *  - Once an answer is in, over the input: Add to chat (the answer goes into the conversation's input as a quote
 *    card, not sent), Keep as comment (the answer stays on the passage in the document) and Copy.
 *  - Folded, the card is a pill at the same corner: "Side chat · Answering" while it writes, "Side chat · 1 new
 *    answer" in 500 once it has; a click opens the card again.
 *  The sizes are dispatchSideChatModel.ts's cardBox: 380 × at most 470 at 16 from the corner, and the pane's whole
 *  width (12 each side) in a window narrower than 1200.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { cardBox, fileName, ISideChatPassage, passageLine, passageSource, passageWhere, pillLabel, pillOffset, SideChatCardMode, splitSelection } from '../common/dispatchSideChatModel.js';
import { docReaderBody, lightPassage, onDidRenderDoc, PassageLight, scrollToPassage } from './dispatchDocPassage.js';
import { DISPATCH_SIDE_CHAT_CARD_KEY, IDispatchSideChatService } from './dispatchSideChatService.js';

/** `dispatch.openDoc` (dispatchDocsOpen.ts): opens a document's tab in the side pane; by id, not imported. */
const OPEN_DOC_COMMAND = 'dispatch.openDoc';
const HEAD_HEIGHT = 40;

export class DispatchSideChatCard extends Disposable {

	readonly element: HTMLElement;
	readonly pill: HTMLElement;

	private readonly _view: AbstractChatView;
	private readonly _quote: HTMLElement | undefined;
	private readonly _chatHost: HTMLElement;
	private readonly _acts: HTMLElement;
	private readonly _pillLabel: HTMLElement;
	private readonly _passage: ISideChatPassage | undefined;
	private readonly _answering = observableValue(this, false);
	private readonly _unread = observableValue(this, 0);
	private readonly _flash = this._register(new MutableDisposable());
	private readonly _didTimer = this._register(new MutableDisposable());
	private readonly _relayout = this._register(new MutableDisposable());
	private _laidOut: { width: number; height: number } | undefined;
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
	) {
		super();
		const win = dom.getWindow(_container);
		if (win.getComputedStyle(_container).position === 'static') {
			_container.style.position = 'relative';
		}

		// ---- the card ----
		this.element = dom.$('.dispatch-side-chat-card', { role: 'complementary', 'data-part': 'side-chat-card' });
		this.element.setAttribute('aria-label', localize('dispatchSideChat.aria', "Side chat"));
		_container.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const head = dom.append(this.element, dom.$('.dsc-head'));
		dom.append(head, dom.$(`span.dsc-ic${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`, { 'aria-hidden': 'true' }));
		dom.append(head, dom.$('span.dsc-t', undefined, localize('dispatchSideChat.title', "Side chat")));
		const from = dom.append(head, dom.$('span.dsc-from'));
		this._register(autorun(reader => {
			const title = _session.title.read(reader);
			from.textContent = title ? localize('dispatchSideChat.from', "· from {0}", title) : '';
			from.title = title;
		}));
		const more = this.iconButton(head, Codicon.ellipsis, localize('dispatchSideChat.more', "More Actions for This Side Chat"), 'more');
		const min = this.iconButton(head, Codicon.chromeMinimize, localize('dispatchSideChat.minimize', "Minimize"), 'minimize');
		const close = this.iconButton(head, Codicon.close, localize('dispatchSideChat.close', "Close Side Chat"), 'close');
		this._register(dom.addDisposableListener(more, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this.showMenu(more); }));
		this._register(dom.addDisposableListener(min, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._sideChats.setMode(_session.sessionId, 'min'); }));
		this._register(dom.addDisposableListener(close, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._sideChats.setMode(_session.sessionId, 'closed'); }));

		// ---- the pill ----
		this.pill = dom.$('button.dispatch-side-chat-pill', { type: 'button', 'data-part': 'side-chat-pill' });
		dom.append(this.pill, dom.$(`span.dsc-ic${ThemeIcon.asCSSSelector(Codicon.commentDiscussion)}`, { 'aria-hidden': 'true' }));
		this._pillLabel = dom.append(this.pill, dom.$('span.dsc-pill-t'));
		_container.appendChild(this.pill);
		this._register(toDisposable(() => this.pill.remove()));
		this._register(dom.addDisposableListener(this.pill, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); this._sideChats.setMode(_session.sessionId, 'open'); }));
		this._register(autorun(reader => {
			const label = pillLabel(this._answering.read(reader), this._unread.read(reader));
			this._pillLabel.textContent = label.text;
			this.pill.classList.toggle('unread', label.bold);
			this.pill.classList.toggle('answering', label.answering);
			this.pill.setAttribute('aria-label', localize('dispatchSideChat.pillAria', "{0}: open the side chat", label.text));
		}));

		const body = dom.append(this.element, dom.$('.dsc-body'));

		// ---- the quoted passage ----
		this._passage = _sideChats.passageOf(_chat.resource);
		const sel = splitSelection(_chat.origin?.selection?.text);
		const words = this._passage?.text ?? sel.text;
		if (words.trim()) {
			const q = this._quote = dom.append(body, dom.$('button.dsc-quote', { type: 'button', 'data-part': 'side-chat-quote' }));
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
			this._register(dom.addDisposableListener(q, dom.EventType.CLICK, e => { dom.EventHelper.stop(e, true); void this.goToPassage(); }));
		}
		if (this._passage?.inDocs) {
			const path = this._passage.path;
			this._register(onDidRenderDoc(p => { if (p === path) { this.relight(); } }));
		}

		// ---- the side chat: the conversation's own chat view, in its own scope for this session ----
		this._chatHost = dom.append(body, dom.$('.dsc-chat'));
		const scopedKeys = this._register(contextKeyService.createScoped(this._chatHost));
		// the chat view starts its input one line high in here (chatView.ts reads it): the card is short
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
		}

		// ---- size: follows the side pane and the window ----
		const ro = new ResizeObserver(() => this.layout());
		ro.observe(_container);
		this._register(toDisposable(() => ro.disconnect()));
		this._register(dom.addDisposableListener(win, dom.EventType.RESIZE, () => this.layout()));
		this.setMode('open', 0);
		this.layout();
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
		this.element.classList.toggle('hidden', mode !== 'open');
		this.pill.classList.toggle('hidden', mode !== 'min');
		this._view.setVisible(mode === 'open' && !this._paneHidden);
		if (mode === 'open' && was !== 'open') {
			this.layout();
			// once the card is drawn again, its list measures its rows at the card's real size and shows the end
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

	layout(): void {
		const win = dom.getWindow(this._container);
		const pane = this._container.getBoundingClientRect();
		// the side pane put away (Settings over the window, the pane hidden): the chat is not drawn at no size, and is
		// drawn again at the card's size when the pane is back
		const hidden = pane.width < 1 || pane.height < 1;
		if (hidden !== this._paneHidden) {
			this._paneHidden = hidden;
			this._view.setVisible(!hidden && this._mode === 'open');
			if (!hidden) {
				this._laidOut = undefined;
				this.settle();
			}
		}
		if (hidden) {
			return;
		}
		const box = cardBox(pane.width, pane.height, win.innerWidth);
		const s = this.element.style;
		s.right = `${box.right}px`;
		s.bottom = `${box.bottom}px`;
		s.width = `${box.width}px`;
		s.height = `${box.height}px`;
		this.element.classList.toggle('narrow', box.narrow);
		const off = pillOffset(win.innerWidth);
		this.pill.style.right = `${off}px`;
		this.pill.style.bottom = `${off}px`;
		if (this._mode !== 'open') {
			return;
		}
		const quote = this._quote ? this._quote.offsetHeight + 12 : 0; // the quote and the room above it
		const inner = box.width - 2; // the card's 1px border on each side
		const height = Math.max(120, box.height - 2 - HEAD_HEIGHT - quote);
		this._chatHost.style.height = `${height}px`;
		this._view.layout(inner, height, 0, 0);
		if (this._laidOut && (this._laidOut.width !== inner || this._laidOut.height !== height)) {
			this.settle();
		}
		this._laidOut = { width: inner, height };
	}

	/** On the next frame: the list measures its rows again at the card's size and shows the end of the chat. */
	private settle(): void {
		const win = dom.getWindow(this._container);
		this._relayout.value = dom.scheduleAtNextAnimationFrame(win, () => {
			if (this._laidOut && this._mode === 'open') {
				this._view.layout(this._laidOut.width, this._laidOut.height, 0, 0);
			}
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

	/** Deleting a chat asks first (sessionsManagementService's own question); a side chat that is gone closes its card. */
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
