/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Ask Question, the one way every place opens a side chat about something (task-23iin, task-q9x2r):
 *  a selection in a file, a diff in Changes, the Docs reader (dispatchQuote.contribution.ts), the terminal's output
 *  and a small card about what the agent did (contrib/dispatchLearn). The side chat branches from the conversation's
 *  last reply, opens in its card in the side pane on this passage, and takes the keyboard when nothing was typed yet.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { isResponseVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { ISideChatPassage } from '../common/dispatchSideChatModel.js';
import { IDispatchSideChatService } from './dispatchSideChatService.js';

/** `_dispatch.sideChat.ask(ask: ISideChatAsk)`: a side chat about this passage in the session on screen. */
export const DISPATCH_SIDE_CHAT_ASK_COMMAND = '_dispatch.sideChat.ask';

export interface ISideChatAsk {
	/** What the side chat carries for the agent: `<where>\n<words>`. */
	readonly selection: string;
	/** The passage the card's quote shows and goes back to. */
	readonly passage: ISideChatPassage;
	/** What was typed in the box; empty opens the side chat to type in. */
	readonly question?: string;
}

/** Whether the session on screen can have a side chat now (an engine that branches chats, a reply to branch from). */
export function canAskInSideChat(accessor: ServicesAccessor): boolean {
	const session = accessor.get(ISessionsService).activeSession.get();
	return !!session?.isCreated.get() && session.status.get() !== SessionStatus.Untitled && !session.isArchived.get() && !!session.capabilities.get().supportsSideChat;
}

/** Opens the side chat; says why when it cannot. Resolves with the side chat opened, or false. */
export async function askInSideChat(accessor: ServicesAccessor, ask: ISideChatAsk): Promise<boolean> {
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const chatWidgetService = accessor.get(IChatWidgetService);
	const notificationService = accessor.get(INotificationService);
	const sideChats = accessor.get(IDispatchSideChatService);
	const log = accessor.get(ILogService);
	const supported = canAskInSideChat(accessor);

	const session = sessionsService.activeSession.get();
	if (!session || !supported) {
		notificationService.warn(localize('dispatchSideChat.askUnsupported', "This conversation does not support side chats. Use Quote to ask in the conversation itself."));
		return false;
	}
	const chat = session.mainChat.get();
	const widget = chatWidgetService.getWidgetBySessionResource(chat.resource) ?? await whenChatWidgetForSession(chatWidgetService, chat.resource, 3000);
	const lastResponse = widget?.viewModel?.getItems().filter(isResponseVM).at(-1);
	if (!lastResponse) {
		notificationService.warn(localize('dispatchSideChat.askNoTurn', "Ask Question needs a reply in this conversation first. Use Quote to ask in the conversation itself."));
		return false;
	}
	const question = ask.question?.trim();
	try {
		const sideChat = await sessionsManagementService.createSideChatInSession(session, chat.resource, lastResponse.requestId, { text: ask.selection });
		sideChats.setPassage(sideChat.resource, ask.passage);
		sideChats.show(session.sessionId, sideChat.resource, { focus: !question });
		if (question) {
			await sessionsManagementService.sendRequest(session, sideChat, { query: question });
		}
		return true;
	} catch (err) {
		log.error('[dispatch] Ask Question: the side chat could not be created', err);
		notificationService.error(localize('dispatchSideChat.askFailed', "The side chat could not be created."));
		return false;
	}
}
