/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Ask more on a word's hover (Explain terms, task-39x97; the marks are workbench/.../dispatchTermMarks.ts).
 *  The side chat card opens on the word (its quote: the word, "Term" under it) to go on asking; where side chats are
 *  not there (OpenCode) the word goes into the conversation's input as a quote, as a Talk card's click does.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { DISPATCH_ASK_TERM_COMMAND } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/dispatchTermMarks.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { addQuoteToWidget, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { DISPATCH_SIDE_CHAT_ASK_COMMAND, ISideChatAsk } from '../../dispatchSideChat/browser/dispatchSideChatAsk.js';

CommandsRegistry.registerCommand(DISPATCH_ASK_TERM_COMMAND, async (accessor: ServicesAccessor, args: { term?: unknown; plain?: unknown } | undefined) => {
	const term = typeof args?.term === 'string' ? args.term.trim() : '';
	if (!term) {
		return;
	}
	const plain = typeof args?.plain === 'string' ? args.plain : '';
	const where = localize('dispatchAskTerm.where', "Term");
	const session = accessor.get(ISessionsService).activeSession.get();
	const commands = accessor.get(ICommandService);
	const chatWidgets = accessor.get(IChatWidgetService);
	const log = accessor.get(ILogService);
	if (!session) {
		return;
	}
	if (session.capabilities.get().supportsSideChat) {
		const ask: ISideChatAsk = {
			// what the side chat carries for the agent: the word and the sentence the person read
			selection: `${where}\n${term}${plain ? `: ${plain}` : ''}`,
			passage: { path: '', start: 1, end: 1, text: term, inDocs: false, from: 'learn', where },
		};
		await commands.executeCommand(DISPATCH_SIDE_CHAT_ASK_COMMAND, ask);
		return;
	}
	const main = session.mainChat.get().resource;
	const widget = chatWidgets.getWidgetBySessionResource(main) ?? await whenChatWidgetForSession(chatWidgets, main, 3000);
	if (!widget) {
		log.warn('[dispatch] Ask more: no conversation input to put the word in');
		return;
	}
	addQuoteToWidget(widget, toQuoteEntry(term, { from: 'file', label: where, icon: Codicon.book.id, file: where }));
});
