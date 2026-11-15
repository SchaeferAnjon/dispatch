/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the first three suggestions on a new chat's page (the page "+" on Chats opens; 2026-11-11 direction A,
 *  task-0v1o9: they were on the Assistant's page until the Assistant went). The new-session page's own "Send your first
 *  prompt" cards: "Check my projects for unfinished work", "What is running right now?", "Connect two sessions". A click
 *  puts the words in the input; the ones that are complete sentences send themselves. A first-steps guide, like
 *  Getting started: only on a chat's page, never on a project's; once a card was used, the ✕ clicked or a message sent
 *  from a chat's page, never again (application storage: through restarts and updates), and Getting started's "Ask
 *  what is unfinished" ticks. Someone who talked to the old Assistant (the CLI's `fresh` is false) does not see them.
 *  The words come from `dispatch assistant --json` through dispatch-bridge's `dispatch.assistant`, so the CLI stays the
 *  one place that says them; a CLI that did not answer shows why, not empty cards.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkspaceSelectionSnapshot } from '../../../common/workspaceSelection.js';
import { INewSessionComposer, INewSessionComposerService, INewSessionPromptOption, INewSessionPromptOptionsController, NewSessionPromptOptionsState } from '../../chat/browser/newSessionComposerService.js';
import { firstPromptsFailureKind } from '../common/dispatchFirstPromptsFailure.js';

/** Run when the suggestions are done with: remembers it, and Getting started ticks its item (dispatchToursData.ts). */
export const DISPATCH_FIRST_PROMPTS_DONE = 'dispatch.firstPrompts.done';
/** The suggestions were used, closed, or a chat was started: they do not come back. The key they had on the Assistant's page, so a dismissal then still holds. */
const DONE_KEY = 'dispatch.assistant.suggestionsDone';
/** Getting started's list (dispatchToursState.ts): its "Ask what is unfinished" item is done once it was used. */
const CHECKLIST_DONE_KEY = 'dispatch.checklist.done';
/** That item's id, as the list keeps it. */
const CHECKLIST_ITEM = 'assistant';

interface IFirstPrompt {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
	readonly placeholder?: string;
	readonly send: boolean;
	readonly icon?: string;
}

interface IFirstPromptsAnswer {
	readonly fresh?: boolean;
	readonly suggestions?: readonly IFirstPrompt[];
}

/** A chat's page: the new-session page with no folder picked (Chats' "+"). */
function isChatPage(selection: IWorkspaceSelectionSnapshot | undefined): boolean {
	return selection?.state === 'noWorkspace';
}

function isDone(storage: IStorageService): boolean {
	if (storage.getBoolean(DONE_KEY, StorageScope.APPLICATION, false)) {
		return true;
	}
	try {
		const done = JSON.parse(storage.get(CHECKLIST_DONE_KEY, StorageScope.PROFILE) ?? '[]');
		return Array.isArray(done) && done.includes(CHECKLIST_ITEM);
	} catch {
		return false; // an unreadable list: as if nothing was done
	}
}

/** What to tell the person when the CLI did not answer, in plain words. */
function explain(err: string): string {
	switch (firstPromptsFailureKind(err)) {
		case 'old-cli':
			return localize('dispatchFirstPrompts.oldCli', "The dispatch command on this Mac is older than this app. Update it (run dispatch-update, or reinstall Dispatch) to see the suggestions.");
		case 'no-cli':
			return localize('dispatchFirstPrompts.noCli', "Dispatch IDE could not find the dispatch command. Install Dispatch's command line tools (they go to ~/.local/bin/dispatch).");
		case 'busy':
			return localize('dispatchFirstPrompts.busy', "This Mac is too busy to answer right now. The suggestions come back with the next new chat.");
		case 'other':
			return localize('dispatchFirstPrompts.failed', "The suggestions could not be read: {0}", err.trim().split('\n')[0]);
		default:
			return localize('dispatchFirstPrompts.noBridge', "Dispatch is not ready yet. The suggestions come back with the next new chat.");
	}
}

function promptIcon(name: string | undefined): ThemeIcon {
	switch (name) {
		case 'checklist': return Codicon.checklist;
		case 'pulse': return Codicon.pulse;
		case 'arrow-swap': return Codicon.arrowSwap;
		default: return Codicon.sparkle;
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: DISPATCH_FIRST_PROMPTS_DONE, title: localize2('dispatchFirstPrompts.done', "Hide the First Suggestions"), f1: false });
	}
	override run(accessor: ServicesAccessor): void {
		accessor.get(IStorageService).store(DONE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
	}
});

class FirstPromptsController implements INewSessionPromptOptionsController {

	private prompts: readonly IFirstPrompt[] = [];

	constructor(
		private readonly commandService: ICommandService,
		private readonly storage: IStorageService,
		private readonly composer: () => INewSessionComposer | undefined,
		private readonly onPage: () => boolean,
	) { }

	async resolve(token: CancellationToken): Promise<NewSessionPromptOptionsState> {
		const none: NewSessionPromptOptionsState = { kind: 'resolved', options: [] };
		// another page (the composer refreshes on every folder change): nothing, not even loading cards
		if (!this.onPage() || isDone(this.storage)) {
			return none;
		}
		let answer: IFirstPromptsAnswer | undefined;
		try {
			answer = await this.commandService.executeCommand<IFirstPromptsAnswer>('dispatch.assistant');
		} catch (e) {
			return token.isCancellationRequested || !this.onPage() ? none : { kind: 'failed', message: explain(e instanceof Error ? e.message : String(e)) };
		}
		if (token.isCancellationRequested || !this.onPage()) {
			return none;
		}
		if (!answer) {
			return { kind: 'failed', message: explain('') };
		}
		if (answer.fresh === false) {
			// the old Assistant was talked to (an earlier version): past the first steps for good
			this.done();
			return none;
		}
		this.prompts = answer.suggestions ?? [];
		const options: INewSessionPromptOption[] = this.prompts.map(p => ({
			id: p.id,
			title: p.title,
			description: p.description,
			prompt: p.prompt,
			placeholder: p.placeholder ?? '',
			icon: promptIcon(p.icon),
		}));
		return { kind: 'resolved', options };
	}

	onDidSelectOption(option: INewSessionPromptOption): void {
		this.done();
		const composer = this.composer();
		// used once: the words are in the input, the cards go
		composer?.showPromptOptions(undefined);
		if (!this.prompts.find(p => p.id === option.id)?.send) {
			return;
		}
		// a complete sentence goes straight on
		void (composer as unknown as { submit?: () => Promise<boolean> } | undefined)?.submit?.();
	}

	onDidClose(): void {
		this.done();
	}

	private done(): void {
		void this.commandService.executeCommand(DISPATCH_FIRST_PROMPTS_DONE);
	}
}

/** Gives a chat's page the controller, and takes it away from every other page. */
class DispatchFirstPrompts extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessions.dispatchFirstPrompts';

	private attachedTo: INewSessionComposer | undefined;

	constructor(
		@INewSessionComposerService composerService: INewSessionComposerService,
		@ICommandService commandService: ICommandService,
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
	) {
		super();
		const onPage = () => isChatPage(composerService.workspaceSelection.get());
		this._register(autorun(reader => {
			const composer = composerService.activeComposer.read(reader);
			const here = !!composer && isChatPage(composerService.workspaceSelection.read(reader));
			if (!here) {
				// off a chat's page the suggestions do not come along (0.9.2: three empty cards on a project's page)
				this.attachedTo?.setPromptOptionsController?.(undefined);
				this.attachedTo = undefined;
				return;
			}
			if (this.attachedTo === composer || isDone(storageService)) {
				return;
			}
			this.attachedTo?.setPromptOptionsController?.(undefined);
			this.attachedTo = composer;
			composer.setPromptOptionsController?.(new FirstPromptsController(commandService, storageService, () => composerService.activeComposer.get(), onPage));
			void composer.refreshPromptOptions?.().catch(e => logService.trace(`[DispatchFirstPrompts] ${e}`));
		}));
		// a chat started from its page: past the first steps (the old rule: a message to the Assistant)
		this._register(composerService.onWillSendRequest(e => {
			if (isChatPage(e.selection) && !isDone(storageService)) {
				void commandService.executeCommand(DISPATCH_FIRST_PROMPTS_DONE);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchFirstPrompts.ID, DispatchFirstPrompts, WorkbenchPhase.AfterRestored);
