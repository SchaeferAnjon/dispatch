/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: side chats open in a pane under the side pane's tab (direction B「Split pane」, user 2026-11-16,
 *  task-5im8n, design/side-chat-now; before it a card in the corner, direction A, task-23iin), not in a second column
 *  beside the conversation.
 *
 *  A side chat is the same as before: a chat of the session, branched from the conversation, on the same engine
 *  (Ask Question in the Docs tab, the Markdown editor, Changes and a reply; /btw). Only where it shows changed:
 *  - visibleSessions.ts leaves side chats out of the conversation's chat groups, so nothing splits the column;
 *  - whatever makes a side chat the session's active chat (Ask Question, /btw, the Side Chats menu, reopening it) puts
 *    it in this pane instead, and the conversation the person was in stays the active chat;
 *  - the pane (dispatchSideChatPane.ts) belongs to the session on screen; folded it is its head at the side pane's
 *    bottom, closed the title bar's session menu lists the session's side chats (dispatchPlace.ts) and
 *    `dispatch.sideChat.open` reopens one.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSideChat.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { isSessionConversationSideChat } from '../../../browser/sessionConversationGroups.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { docCommentsHost } from './dispatchDocPassage.js';
import { askInSideChat, DISPATCH_SIDE_CHAT_ASK_COMMAND, ISideChatAsk } from './dispatchSideChatAsk.js';
import { DispatchSideChatPane } from './dispatchSideChatPane.js';
import { DISPATCH_SIDE_CHAT_OPEN_COMMAND, DISPATCH_SIDE_CHAT_RESET_SPLIT_COMMAND, IDispatchSideChatService } from './dispatchSideChatService.js';

class DispatchSideChatPanes extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchSideChatPanes';

	private readonly _pane = this._register(new MutableDisposable<DispatchSideChatPane>());

	constructor(
		@ISessionsService _sessionsService: ISessionsService,
		@IDispatchSideChatService private readonly _sideChats: IDispatchSideChatService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IInstantiationService _instantiationService: IInstantiationService,
	) {
		super();

		// the Docs reader draws kept answers under their passages (dispatchDocPassage.ts)
		const commentsChanged = this._register(new Emitter<void>());
		this._register(autorun(reader => { _sideChats.comments.read(reader); commentsChanged.fire(); }));
		docCommentsHost.current = {
			onDidChange: commentsChanged.event,
			comments: path => _sideChats.comments.get().filter(c => c.path === path),
			remove: id => _sideChats.removeComment(id),
			openChat: chat => {
				const session = _sessionsService.activeSession.get();
				if (session?.chats.get().some(c => c.resource.toString() === chat)) {
					this.open(session, URI.parse(chat), true);
				}
			},
		};
		this._register({ dispose: () => { docCommentsHost.current = undefined; } });

		// a side chat that becomes a session's active chat goes into the pane; the chat the person was in stays active
		const before = new Map<string, URI>();
		this._register(autorun(reader => {
			for (const session of _sessionsService.visibleSessions.read(reader)) {
				if (!session) {
					continue;
				}
				const chat = session.activeChat.read(reader);
				if (!chat) {
					continue;
				}
				if (!isSessionConversationSideChat(chat)) {
					before.set(session.sessionId, chat.resource);
					continue;
				}
				const back = before.get(session.sessionId) ?? session.mainChat.get().resource;
				// after this change has settled: opening a chat sets the active chat again
				setTimeout(() => {
					this.open(session, chat.resource, false);
					void _sessionsService.openChat(session, back, { preserveFocus: true });
				}, 0);
			}
		}));

		// the pane of the session on screen
		this._register(autorun(reader => {
			const session = _sessionsService.activeSession.read(reader);
			const card = session && _sideChats.cards.read(reader).get(session.sessionId);
			if (!session || !card || card.mode === 'closed') {
				this._pane.clear();
				return;
			}
			const chat = session.chats.read(reader).find(c => c.resource.toString() === card.chat);
			if (!chat) {
				// not loaded yet, or deleted elsewhere
				if (!session.loading.read(reader)) {
					this._pane.clear();
				}
				return;
			}
			const ui = this._pane.value;
			if (!ui || ui.session !== session || ui.chat.resource.toString() !== card.chat) {
				const part = _layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
				if (!part) {
					return;
				}
				this._pane.value = _instantiationService.createInstance(DispatchSideChatPane, part, session, chat);
			}
			this._pane.value!.setMode(card.mode, card.unread);
			this._pane.value!.focus(card.focus);
		}));
	}

	/** Opens the pane on this side chat; the side pane comes out if it was put away. */
	open(session: IActiveSession, chat: URI, focus: boolean): void {
		if (!this._layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			this._layoutService.setPartHidden(false, Parts.EDITOR_PART);
		}
		this._sideChats.show(session.sessionId, chat, { focus });
	}
}

registerWorkbenchContribution2(DispatchSideChatPanes.ID, DispatchSideChatPanes, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand(DISPATCH_SIDE_CHAT_ASK_COMMAND, (accessor: ServicesAccessor, ask: ISideChatAsk) => ask?.passage ? askInSideChat(accessor, ask) : false);

CommandsRegistry.registerCommand(DISPATCH_SIDE_CHAT_RESET_SPLIT_COMMAND, (accessor: ServicesAccessor) => accessor.get(IDispatchSideChatService).setShare(undefined));

CommandsRegistry.registerCommand(DISPATCH_SIDE_CHAT_OPEN_COMMAND, (accessor: ServicesAccessor, sessionId: unknown, chat: unknown) => {
	const sessionsService = accessor.get(ISessionsService);
	const layoutService = accessor.get(IWorkbenchLayoutService);
	const sideChats = accessor.get(IDispatchSideChatService);
	if (typeof sessionId !== 'string' || typeof chat !== 'string') {
		return;
	}
	const session = sessionsService.visibleSessions.get().find(s => s?.sessionId === sessionId) ?? sessionsService.activeSession.get();
	if (!session || session.sessionId !== sessionId || !session.chats.get().some(c => c.resource.toString() === chat)) {
		return;
	}
	if (!layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
		layoutService.setPartHidden(false, Parts.EDITOR_PART);
	}
	sideChats.show(sessionId, URI.parse(chat), { focus: true });
});
