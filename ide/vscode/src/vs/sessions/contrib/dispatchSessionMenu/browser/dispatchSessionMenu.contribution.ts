/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the same session tools in a chat session's right-click menu as in a terminal session's.
 *
 *  Right-clicking in a chat (a message or the space around them) offers, after the copy items:
 *  - Insert a Snippet...: words kept for sending often (dispatchTerminal/browser/dispatchSessionTools.ts) go into
 *    this chat's input;
 *  - Continue in a New Session: a new session in the same folder starts with a hand-over of this conversation in
 *    its input, to read and send (for when this one has grown long);
 *  - Fork Session: a copy of this conversation to try another way (the window's own Fork Conversation);
 *  - Copy Context: this conversation as text, to paste into any session.
 *  The terminal sessions have the same four (dispatchTerminal/browser/dispatchTerminalActions.ts).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { stringifyItem } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ForkConversationActionId } from '../../../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import { ChatTreeItem, IChatWidget, IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatRequestViewModel, IChatResponseViewModel, isRequestVM, isResponseVM } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { boundedTranscript, buildContinuationPrompt } from '../../dispatchTerminal/browser/dispatchTerminalModel.js';
import { newChatWithText, pickSnippet } from '../../dispatchTerminal/browser/dispatchSessionTools.js';

const GROUP = 'z_dispatch_session';

function widgetFor(accessor: ServicesAccessor, context: unknown): IChatWidget | undefined {
	const widgets = accessor.get(IChatWidgetService);
	const item = context as ChatTreeItem | undefined;
	return ((isRequestVM(item) || isResponseVM(item)) && widgets.getWidgetBySessionResource(item.sessionResource)) || widgets.lastFocusedWidget;
}

/** The conversation as text: who said what, oldest first. */
function conversationText(widget: IChatWidget): string {
	return (widget.viewModel?.getItems() ?? [])
		.filter((item): item is IChatRequestViewModel | IChatResponseViewModel => isRequestVM(item) || (isResponseVM(item) && !item.errorDetails?.responseIsFiltered))
		.map(item => stringifyItem(item))
		.join('\n\n');
}

function folderOf(accessor: ServicesAccessor, widget: IChatWidget): URI | undefined {
	const resource = widget.viewModel?.sessionResource;
	const session = (resource && accessor.get(ISessionsManagementService).getSessionForChatResource(resource)?.session) ?? accessor.get(ISessionsService).activeSession.get();
	const folder = session?.workspace.get()?.folders[0];
	return folder?.workingDirectory ?? folder?.root ?? session?.workspace.get()?.uri;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.session.insertSnippet', title: localize2('dispatch.session.insertSnippet', "Insert a Snippet..."), f1: false, menu: { id: MenuId.ChatContext, group: GROUP, order: 1 } });
	}
	async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const widget = widgetFor(accessor, context);
		const text = await pickSnippet(accessor);
		if (!widget || !text) {
			return;
		}
		const now = widget.getInput();
		widget.setInput(now.trim() ? `${now.replace(/\s+$/, '')}\n${text}` : text);
		widget.focusInput();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.session.continueInNewSession', title: localize2('dispatch.session.continueInNewSession', "Continue in a New Session"), f1: false, menu: { id: MenuId.ChatContext, group: GROUP, order: 2 } });
	}
	async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const widget = widgetFor(accessor, context);
		const notifications = accessor.get(INotificationService);
		if (!widget) {
			return;
		}
		const folder = folderOf(accessor, widget);
		const prompt = buildContinuationPrompt({ text: conversationText(widget), agentName: undefined, folder: folder?.fsPath });
		if (!prompt) {
			notifications.info('This session has nothing to go on with yet.');
			return;
		}
		await newChatWithText(accessor.get(ISessionsService), accessor.get(ISessionsPartService), folder, prompt);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.session.fork', title: localize2('dispatch.session.fork', "Fork Session"), f1: false, menu: { id: MenuId.ChatContext, group: GROUP, order: 3 } });
	}
	async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const resource = widgetFor(accessor, context)?.viewModel?.sessionResource;
		if (resource) {
			await accessor.get(ICommandService).executeCommand(ForkConversationActionId, resource);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.session.copyContext', title: localize2('dispatch.session.copyContext', "Copy Context"), f1: false, menu: { id: MenuId.ChatContext, group: GROUP, order: 4 } });
	}
	async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const widget = widgetFor(accessor, context);
		const notifications = accessor.get(INotificationService);
		const text = widget ? boundedTranscript(conversationText(widget)) : '';
		if (!text) {
			notifications.info('This session has nothing to copy yet.');
			return;
		}
		await accessor.get(IClipboardService).writeText(text);
		notifications.info('Copied this conversation. Paste it into any session.');
	}
});
