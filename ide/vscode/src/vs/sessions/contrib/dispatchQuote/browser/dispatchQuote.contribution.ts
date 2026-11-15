/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Quote and Ask Question in the Agents window (kanban design/quote/redesign 方向 B;
 *  patches/315-quote.patch). Wires the pieces:
 *
 *  - the quote card for the chat's attachment rows (input and sent message), dispatchQuoteWidget.ts;
 *  - `_dispatch.quoteSelection` and `_dispatch.askAboutSelection` for a selection in a file or a diff
 *    (the Markdown editor's box, Changes' box, Docs); the reply's box calls the same helpers directly;
 *  - `_dispatch.revealQuoteSource`: a click on a card goes back to the reply (scrolls, flashes the
 *    words) or opens the file or the diff at those lines.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDispatchQuoteMeta, IDispatchQuoteSource, dispatchQuoteLocation, renderDispatchQuoteText } from '../../../../platform/agentHost/common/meta/dispatchQuoteAttachmentMeta.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatAttachmentWidgetRegistry } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentWidgetRegistry.js';
import { isResponseVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { addQuoteToWidget, DISPATCH_ASK_COMMAND, DISPATCH_QUOTE_COMMAND, DISPATCH_REVEAL_QUOTE_COMMAND, IDispatchQuoteFileArgs, toQuoteEntry } from './dispatchQuote.js';
import { revealAndFlash } from './dispatchQuoteSource.js';
import { dispatchNewSessionInput } from './dispatchQuoteNewSession.js';
import { DispatchQuoteAttachmentWidget } from './dispatchQuoteWidget.js';
import { IDispatchSideChatService } from '../../dispatchSideChat/browser/dispatchSideChatService.js';
import { isSessionConversationSideChat } from '../../../browser/sessionConversationGroups.js';

class DispatchQuoteContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchQuote';

	constructor(
		@IChatAttachmentWidgetRegistry registry: IChatAttachmentWidgetRegistry,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(registry.registerFactory('dispatchQuote', (attachment, options, container) =>
			instantiationService.createInstance(DispatchQuoteAttachmentWidget, attachment, options, container)));
	}
}

registerWorkbenchContribution2(DispatchQuoteContribution.ID, DispatchQuoteContribution, WorkbenchPhase.BlockRestore);

/** Where a file or diff selection is: the path the agent knows it by (from the session's working folder), and its lines. */
function fileSource(accessor: ServicesAccessor, args: IDispatchQuoteFileArgs): IDispatchQuoteSource {
	const sessionsService = accessor.get(ISessionsService);
	const uri = URI.parse(args.uri);
	const session = sessionsService.activeSession.get();
	// relative to the folder the agent works in (the worktree, not the repo it came from)
	const bases = session?.workspace.get()?.folders.flatMap(f => [f.workingDirectory, f.gitRepository?.workTreeUri, f.root]) ?? [];
	const file = bases.map(base => base && relativePath(base, uri)).find(rel => rel && !rel.startsWith('..')) || basename(uri);
	// a selection that ends at column 1 does not include that line
	const endLine = args.endColumn === 1 && args.endLineNumber > args.startLineNumber ? args.endLineNumber - 1 : args.endLineNumber;
	const from = args.from === 'diff' ? 'diff' : 'file';
	const source: IDispatchQuoteSource = {
		from,
		label: '',
		uri: args.uri,
		originalUri: args.originalUri,
		file,
		startLine: args.startLineNumber,
		endLine,
	};
	return { ...source, label: dispatchQuoteLocation(source) ?? file };
}

/** The chat input the quote goes into: the active session's active chat. */
async function activeChatWidget(accessor: ServicesAccessor): Promise<IChatWidget | undefined> {
	const sessionsService = accessor.get(ISessionsService);
	const chatWidgetService = accessor.get(IChatWidgetService);
	const session = sessionsService.activeSession.get();
	if (!session?.isCreated.get()) {
		return undefined;
	}
	const chat = session.activeChat.get();
	return chatWidgetService.getWidgetBySessionResource(chat.resource)
		?? await whenChatWidgetForSession(chatWidgetService, session.resource, 3000)
		?? chatWidgetService.lastFocusedWidget;
}

CommandsRegistry.registerCommand(DISPATCH_QUOTE_COMMAND, async (accessor: ServicesAccessor, args: IDispatchQuoteFileArgs) => {
	if (!args?.uri || !args.text?.trim()) {
		return;
	}
	const source = fileSource(accessor, args);
	const sessionsService = accessor.get(ISessionsService);
	const sessionsPartService = accessor.get(ISessionsPartService);
	const log = accessor.get(ILogService);
	const widget = await activeChatWidget(accessor);
	if (widget) {
		addQuoteToWidget(widget, toQuoteEntry(args.text, source));
		return;
	}
	// no started session: the new-session input takes the same card (dispatchQuoteNewSession.ts)
	log.info('[dispatch] quote: no chat input of a started session, quoting into the new-session input');
	const input = dispatchNewSessionInput();
	if (input) {
		input.addAttachments(toQuoteEntry(args.text, source));
		return;
	}
	const session = sessionsService.activeSession.get();
	sessionsPartService.getSessionView(session?.sessionId)?.prefillInput(`${renderDispatchQuoteText({ v: 1, text: args.text, source })}\n\n`);
});

CommandsRegistry.registerCommand(DISPATCH_ASK_COMMAND, async (accessor: ServicesAccessor, args: IDispatchQuoteFileArgs) => {
	if (!args?.uri || !args.text?.trim()) {
		return;
	}
	const source = fileSource(accessor, args);
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const chatWidgetService = accessor.get(IChatWidgetService);
	const notificationService = accessor.get(INotificationService);
	const sideChats = accessor.get(IDispatchSideChatService);
	const log = accessor.get(ILogService);

	const session = sessionsService.activeSession.get();
	if (!session?.isCreated.get() || session.status.get() === SessionStatus.Untitled || session.isArchived.get() || !session.capabilities.get().supportsSideChat) {
		notificationService.warn(localize('dispatchQuote.askUnsupported', "This conversation does not support side chats. Use Quote to ask in the conversation itself."));
		return;
	}
	const chat = session.mainChat.get();
	const widget = chatWidgetService.getWidgetBySessionResource(chat.resource) ?? await whenChatWidgetForSession(chatWidgetService, chat.resource, 3000);
	const lastResponse = widget?.viewModel?.getItems().filter(isResponseVM).at(-1);
	if (!lastResponse) {
		notificationService.warn(localize('dispatchQuote.askNoTurn', "Ask Question needs a reply in this conversation first. Use Quote to ask in the conversation itself."));
		return;
	}
	const selection = { text: `${source.label}\n${args.text}` };
	const question = args.question?.trim();
	try {
		// the side chat opens in its card in the side pane, on this passage (dispatchSideChat, task-23iin); with nothing
		// typed yet the keyboard goes into its input
		const sideChat = await sessionsManagementService.createSideChatInSession(session, chat.resource, lastResponse.requestId, selection);
		// the card's quote names where it was asked: the file's lines, and Changes for a diff (task-q9x2r)
		sideChats.setPassage(sideChat.resource, { path: URI.parse(args.uri).fsPath, start: source.startLine ?? args.startLineNumber, end: source.endLine ?? args.endLineNumber, text: args.text, inDocs: !!args.inDocs, from: source.from === 'diff' ? 'diff' : 'file' });
		sideChats.show(session.sessionId, sideChat.resource, { focus: !question });
		if (question) {
			await sessionsManagementService.sendRequest(session, sideChat, { query: question });
		}
	} catch (err) {
		log.error('[dispatch] Ask Question: the side chat could not be created', err);
		notificationService.error(localize('dispatchQuote.askFailed', "The side chat could not be created."));
	}
});

CommandsRegistry.registerCommand(DISPATCH_REVEAL_QUOTE_COMMAND, async (accessor: ServicesAccessor, meta: IDispatchQuoteMeta) => {
	const source = meta?.source;
	if (!source) {
		return;
	}
	if (source.from === 'reply') {
		if (!source.chat || !source.responseId) {
			return;
		}
		const chatWidgetService = accessor.get(IChatWidgetService);
		const chatUri = URI.parse(source.chat);
		let widget = chatWidgetService.getWidgetBySessionResource(chatUri);
		// Dispatch IDE: an answer from a side chat (Add to chat): its card opens again when it was closed (task-23iin)
		const session = accessor.get(ISessionsService).activeSession.get();
		const sideChat = session?.chats.get().find(c => c.resource.toString() === source.chat && isSessionConversationSideChat(c));
		if (session && sideChat) {
			accessor.get(IDispatchSideChatService).show(session.sessionId, sideChat.resource);
			widget ??= await whenChatWidgetForSession(chatWidgetService, chatUri, 3000);
		}
		if (widget) {
			revealAndFlash(widget, source.responseId, meta.text);
		}
		return;
	}
	if (!source.uri) {
		return;
	}
	const editorService = accessor.get(IEditorService);
	const start = source.startLine ?? 1;
	const selection = { startLineNumber: start, startColumn: 1, endLineNumber: source.endLine ?? start, endColumn: Number.MAX_SAFE_INTEGER };
	if (source.from === 'diff' && source.originalUri) {
		await editorService.openEditor({
			original: { resource: URI.parse(source.originalUri) },
			modified: { resource: URI.parse(source.uri) },
			options: { selection, revealIfOpened: true },
		});
		return;
	}
	await editorService.openEditor({ resource: URI.parse(source.uri), options: { selection, revealIfOpened: true } });
});
