/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the right-click menus of terminal sessions and chat sessions share.
 *
 *  Snippets: words a person sends to agents often, kept by the CLI (`dispatch terminal snippets`, kanban
 *  app/cli/snippets.py) and put into any session. Learned from Orca's Quick Commands
 *  (https://github.com/stablyai/orca, TerminalQuickCommandsSubmenu.tsx; MIT, notice in dispatchTerminalModel.ts),
 *  kept to what a person needs: a list, a new one, one from the selection, remove one.
 *
 *  A new chat session that starts with words in its input (Continue in a New Session from a plain terminal or a
 *  chat session): opened in the same folder, the words are put in its input to read and send.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface ISnippet {
	readonly id: string;
	readonly name: string;
	readonly text: string;
}

interface ISnippetsAnswer {
	readonly ok?: boolean;
	readonly snippets?: ISnippet[];
	readonly message?: string;
}

async function snippetsCall(commands: ICommandService, request: Record<string, string>): Promise<ISnippetsAnswer> {
	try {
		return await commands.executeCommand<ISnippetsAnswer>('dispatch.terminal', 'snippets', request) ?? { ok: false };
	} catch (e) {
		return { ok: false, message: String((e as Error)?.message ?? e) };
	}
}

let cached: readonly ISnippet[] | undefined;

export async function loadSnippets(commands: ICommandService): Promise<readonly ISnippet[]> {
	const answer = await snippetsCall(commands, { op: 'list' });
	cached = answer.ok && Array.isArray(answer.snippets) ? answer.snippets : (cached ?? []);
	return cached;
}

/** The snippets as last read, at once (a menu must not wait for the CLI); a fresh read starts behind it. */
export function snippetsNow(commands: ICommandService): readonly ISnippet[] {
	void loadSnippets(commands);
	return cached ?? [];
}

/** Asks for a name and the words (the words filled in when given), and keeps the snippet. */
export async function newSnippet(accessor: ServicesAccessor, text?: string): Promise<ISnippet | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const notifications = accessor.get(INotificationService);
	let words = text;
	if (words === undefined) {
		words = await quickInput.input({
			title: 'New Snippet',
			prompt: 'The words to send. You can put them into any session from its right-click menu.',
			placeHolder: 'Run the tests and fix what fails',
			validateInput: async v => v.trim() ? undefined : 'Type the words to keep.',
		});
		if (!words?.trim()) {
			return undefined;
		}
	}
	const firstLine = words.trim().split('\n')[0];
	const name = await quickInput.input({
		title: 'Name the Snippet',
		prompt: 'A short name for the menu.',
		value: firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine,
	});
	if (name === undefined) {
		return undefined;
	}
	const answer = await snippetsCall(commands, { op: 'add', name, text: words });
	if (answer.ok && Array.isArray(answer.snippets)) {
		cached = answer.snippets;
	}
	if (!answer.ok) {
		notifications.warn(answer.message || 'Dispatch could not keep the snippet.');
		return undefined;
	}
	return answer.snippets?.[answer.snippets.length - 1];
}

/** Lets the person pick a snippet to remove, and removes it. */
export async function removeSnippet(accessor: ServicesAccessor): Promise<void> {
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const snippets = await loadSnippets(commands);
	const picked = await quickInput.pick(snippets.map(s => ({ label: s.name, detail: s.text, snippet: s })), {
		title: 'Remove a Snippet',
		placeHolder: snippets.length ? 'Pick the snippet to remove' : 'There are no snippets',
	});
	if (picked) {
		const answer = await snippetsCall(commands, { op: 'remove', id: picked.snippet.id });
		if (answer.ok && Array.isArray(answer.snippets)) {
			cached = answer.snippets;
		}
	}
}

interface ISnippetPick extends IQuickPickItem {
	readonly snippet?: ISnippet;
	readonly make?: 'new' | 'remove';
}

/** The snippets in a list to pick from, with New Snippet and Remove a Snippet at the end. Returns the words. */
export async function pickSnippet(accessor: ServicesAccessor): Promise<string | undefined> {
	// the accessor only works until the first await: what comes later goes through the instantiation service
	const quickInput = accessor.get(IQuickInputService);
	const commands = accessor.get(ICommandService);
	const instantiation = accessor.get(IInstantiationService);
	const snippets = await loadSnippets(commands);
	const items: (ISnippetPick | IQuickPickSeparator)[] = snippets.map(s => ({ label: s.name, detail: s.text, snippet: s }));
	items.push({ type: 'separator' }, { label: '$(add) New Snippet...', make: 'new' });
	if (snippets.length) {
		items.push({ label: '$(trash) Remove a Snippet...', make: 'remove' });
	}
	const picked = await quickInput.pick(items, { title: 'Snippets', placeHolder: 'Pick the words to put in', matchOnDetail: true }) as ISnippetPick | undefined;
	if (!picked) {
		return undefined;
	}
	if (picked.make === 'new') {
		return (await instantiation.invokeFunction(newSnippet))?.text;
	}
	if (picked.make === 'remove') {
		await instantiation.invokeFunction(removeSnippet);
		return undefined;
	}
	return picked.snippet?.text;
}

/** A new chat session in `folder` with `text` in its input, to read and send. */
export async function newChatWithText(sessions: ISessionsService, parts: ISessionsPartService, folder: URI | undefined, text: string): Promise<void> {
	const { session } = await sessions.openNewSession(folder ? { folderUri: folder } : undefined);
	// the new session's view comes up a moment later
	for (let i = 0; i < 30; i++) {
		const view = parts.getSessionView(session?.sessionId ?? sessions.activeSession.get()?.sessionId);
		if (view) {
			view.prefillInput(text);
			return;
		}
		await new Promise(resolve => mainWindow.setTimeout(resolve, 100));
	}
}
