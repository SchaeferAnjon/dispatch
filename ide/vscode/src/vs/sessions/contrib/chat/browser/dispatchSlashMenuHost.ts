/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the slash menu of a session's chat, wired to the chat widget (310-slash-menu.patch).
 *  chatView.ts calls createDispatchSlashMenu once the widget is rendered.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { acceptAgentHostCompletionItem } from '../../../../workbench/contrib/chat/browser/widget/input/editor/agentHostInputCompletions.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatSlashCommandService } from '../../../../workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { DispatchSlashMenu } from './dispatchSlashMenu.js';

/** The menu for Claude Code, Codex and OpenCode sessions; undefined while the widget has no input container. */
export function createDispatchSlashMenu(instantiationService: IInstantiationService, widget: ChatWidget, session: IObservable<ISession | undefined>): IDisposable | undefined {
	const slashAnchor = widget.input.inputContainerElement;
	if (slashAnchor) {
		const slashCommandService = instantiationService.invokeFunction(accessor => accessor.get(IChatSlashCommandService));
		return instantiationService.createInstance(DispatchSlashMenu, {
			editor: widget.inputEditor,
			anchor: slashAnchor,
			session: session,
			completionResource: () => widget.viewModel?.sessionResource,
			submit: text => {
				widget.setInput(text);
				void widget.acceptInput();
			},
			insertItem: item => acceptAgentHostCompletionItem(widget, item),
			getModels: () => {
				const current = widget.input.currentLanguageModel;
				return widget.input.availableLanguageModels
					.filter(model => model.metadata.isUserSelectable !== false)
					.map(model => ({ identifier: model.identifier, name: model.metadata.name, detail: model.metadata.modelGroup?.label ?? model.metadata.detail, current: model.identifier === current }));
			},
			switchModel: identifier => widget.input.switchModelByIdentifier(identifier, true, true),
			openModelPicker: () => widget.input.openModelPicker(),
			getWorkbenchCommands: () => slashCommandService.getCommands(ChatAgentLocation.Chat, widget.input.currentModeKind)
				.filter(command => (command.command === 'fork' || command.command === 'btw') && (!command.when || widget.scopedContextKeyService.contextMatchesRules(command.when)))
				.map(command => ({ name: command.command, description: command.detail, ...(command.command === 'btw' ? { argumentHint: localize('dispatchSlash.btwHint', "<question>") } : {}) })),
		});
	}
	return undefined;
}
