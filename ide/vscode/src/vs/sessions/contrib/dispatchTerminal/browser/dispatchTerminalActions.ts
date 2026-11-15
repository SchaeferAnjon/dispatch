/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the keys and the right-click menu of a terminal session.
 *
 *  Keys while the terminal has the keyboard: ⌘C copies the selection, ⌘V pastes (a picture on the clipboard is
 *  pasted as a file the agent can read), ⌘A selects all, ⌘K clears, ⌘F finds.
 *
 *  The right-click menu, learned from Orca's terminal menu (https://github.com/stablyai/orca,
 *  TerminalContextMenu.tsx; MIT, notice in dispatchTerminalModel.ts) with what the person chose to keep:
 *  Copy, Paste, Select All; Snippets; Continue in a New Session (hand the work to a fresh session with the
 *  conversation so far), Fork Session (a copy of the conversation to try another way), Copy Context (the
 *  conversation as text to paste anywhere); Clear; More (Rename, Copy Session ID, Reset Terminal).
 *--------------------------------------------------------------------------------------------*/

import { Action, IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { boundedTranscript, buildContinuationPrompt, buildForkPrompt, claudeTranscriptPath, fillRecipe, ITerminalAgent } from './dispatchTerminalModel.js';
import { DispatchTerminalController } from './dispatchTerminalController.js';
import { loadSnippets, newChatWithText, newSnippet, removeSnippet, snippetsNow } from './dispatchSessionTools.js';
import { DISPATCH_TERMINAL_PROVIDER_ID, DispatchTerminalFocus, DispatchTerminalSession, DispatchTerminalSessionsProvider } from './dispatchTerminalSessionsProvider.js';
import { DISPATCH_TERMINAL_CATEGORY, DISPATCH_TERMINAL_KEY_WEIGHT, DISPATCH_TERMINAL_KEYS, DISPATCH_TERMINAL_KEYS_QUERY, terminalKeyCommand, terminalKeyWhen } from '../../../../workbench/contrib/dispatchTerminalKeys/common/dispatchTerminalKeys.js';
import { showTerminalFind } from './dispatchTerminalFind.js';
import { chatUnavailableReason } from './dispatchTerminalChat.js';

function provider(accessor: ServicesAccessor): DispatchTerminalSessionsProvider | undefined {
	return accessor.get(ISessionsProvidersService).getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID);
}

function active(accessor: ServicesAccessor): DispatchTerminalController | undefined {
	return provider(accessor)?.activeController;
}

const WEIGHT = KeybindingWeight.WorkbenchContrib + 60;

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.paste', title: localize2('dispatch.terminal.paste', "Paste into the Terminal"), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, when: DispatchTerminalFocus, weight: WEIGHT } });
	}
	run(accessor: ServicesAccessor): Promise<void> | void {
		return active(accessor)?.pasteClipboard();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.copy', title: localize2('dispatch.terminal.copy', "Copy from the Terminal"), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyC, when: DispatchTerminalFocus, weight: WEIGHT } });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const text = active(accessor)?.copyText;
		if (text) {
			await accessor.get(IClipboardService).writeText(text);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.selectAll', title: localize2('dispatch.terminal.selectAll', "Select All in the Terminal"), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyA, when: DispatchTerminalFocus, weight: WEIGHT } });
	}
	run(accessor: ServicesAccessor): void {
		active(accessor)?.selectAll();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.clear', title: localize2('dispatch.terminal.clear', "Clear the Terminal"), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyK, when: DispatchTerminalFocus, weight: WEIGHT } });
	}
	run(accessor: ServicesAccessor): Promise<void> | void {
		return active(accessor)?.clear();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.find', title: localize2('dispatch.terminal.find', "Find in the Terminal"), keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyF, when: DispatchTerminalFocus, weight: WEIGHT } });
	}
	run(accessor: ServicesAccessor): void {
		const c = active(accessor);
		if (c) {
			accessor.get(IInstantiationService).invokeFunction(showTerminalFind, c);
		}
	}
});

// ---- the session's conversation -------------------------------------------------------------------

function agentOf(session: DispatchTerminalSession): ITerminalAgent | undefined {
	const a = session.agent;
	return a ? { id: a.id, name: a.name, about: '', command: a.command, start: a.start, resume: a.resume, fork: a.fork, runnable: false, enabled: true, is_default: false } : undefined;
}

async function transcriptPathOf(accessor: ServicesAccessor, session: DispatchTerminalSession): Promise<string | undefined> {
	const id = session.controller.info.agentSession;
	if (session.agent?.id !== 'claude' || !id) {
		return undefined;
	}
	const home = accessor.get(IPathService).userHome({ preferLocal: true }).fsPath;
	const file = claudeTranscriptPath(home, session.folder.fsPath, id);
	return await accessor.get(IFileService).exists(URI.file(file)) ? file : undefined;
}

async function continueInNewSession(accessor: ServicesAccessor, session: DispatchTerminalSession): Promise<void> {
	const p = provider(accessor);
	const sessions = accessor.get(ISessionsService);
	const parts = accessor.get(ISessionsPartService);
	const notifications = accessor.get(INotificationService);
	const transcriptPath = await transcriptPathOf(accessor, session);
	const text = transcriptPath ? '' : await session.controller.text(800);
	const prompt = buildContinuationPrompt({ text, transcriptPath, agentName: session.agent?.name ?? 'a terminal', title: session.title.get(), folder: session.folder.fsPath });
	if (!prompt) {
		notifications.info('This terminal has nothing to go on with yet.');
		return;
	}
	const agent = agentOf(session);
	if (agent && p) {
		// the same agent in a fresh terminal, the hand-over in its prompt to read and send
		const next = await p.open(session.folder, agent, { draft: prompt });
		await sessions.openSession(next.resource);
		return;
	}
	// a plain terminal: the work goes on in a chat session, the hand-over in its input
	await newChatWithText(sessions, parts, session.folder, prompt);
}

async function forkSession(accessor: ServicesAccessor, session: DispatchTerminalSession): Promise<void> {
	const p = provider(accessor);
	const sessions = accessor.get(ISessionsService);
	const notifications = accessor.get(INotificationService);
	if (!p) {
		return;
	}
	const agent = agentOf(session);
	const folder = URI.file(session.controller.cwd || session.folder.fsPath);
	if (!agent) {
		const next = await p.open(folder, undefined);
		await sessions.openSession(next.resource);
		return;
	}
	const fresh = generateUuid();
	const native = fillRecipe(agent.fork, session.controller.info.agentSession, fresh);
	const title = `${agent.name} (terminal, copy)`;
	if (native) {
		// the agent copies its own conversation (Claude Code --fork-session, codex fork, opencode --fork)
		const next = await p.open(session.folder, agent, { command: native, title, agentSession: native.includes(fresh) ? fresh : undefined });
		await sessions.openSession(next.resource);
		return;
	}
	const prompt = buildForkPrompt({ text: await session.controller.text(800), agentName: agent.name, title: session.title.get(), folder: session.folder.fsPath });
	if (!prompt) {
		notifications.info('This terminal has nothing to copy yet.');
		return;
	}
	const next = await p.open(session.folder, agent, { draft: prompt, title });
	await sessions.openSession(next.resource);
}

async function copyContext(accessor: ServicesAccessor, session: DispatchTerminalSession): Promise<void> {
	// the accessor only works until the first await: the services are taken here
	const notifications = accessor.get(INotificationService);
	const clipboard = accessor.get(IClipboardService);
	const text = boundedTranscript(await session.controller.text(800));
	if (!text) {
		notifications.info('This terminal has nothing to copy yet.');
		return;
	}
	await clipboard.writeText(text);
	notifications.info('Copied what this terminal shows. Paste it into any session.');
}

async function rename(accessor: ServicesAccessor, session: DispatchTerminalSession): Promise<void> {
	const p = provider(accessor);
	const title = await accessor.get(IQuickInputService).input({ title: 'Rename', value: session.title.get(), prompt: 'The name the sessions list shows.' });
	if (title?.trim() && p) {
		await p.renameSession(session.sessionId, title.trim());
	}
}

// ---- the menu ------------------------------------------------------------------------------------

async function terminalMenu(accessor: ServicesAccessor, session: DispatchTerminalSession, pane: DispatchTerminalController = session.controller): Promise<IAction[]> {
	const providerNow = provider(accessor);
	const instantiation = accessor.get(IInstantiationService);
	const clipboard = accessor.get(IClipboardService);
	const commands = accessor.get(ICommandService);
	// copy, paste, snippets and clear act on the pane that was right-clicked; the agent's commands on the session
	const c = pane;
	const main = session.controller;
	const isPane = pane !== main;
	const run = (fn: (a: ServicesAccessor, s: DispatchTerminalSession) => Promise<void>) => async () => instantiation.invokeFunction(fn, session);
	const selection = c.selection;
	const snippets = snippetsNow(commands);
	const snippetActions: IAction[] = snippets.map(s => new Action(`dispatch.terminal.snippet.${s.id}`, s.name, undefined, true, async () => {
		c.paste(s.text);
		c.focus();
	}));
	if (snippetActions.length) {
		snippetActions.push(new Separator());
	}
	snippetActions.push(new Action('dispatch.terminal.snippet.new', 'New Snippet...', undefined, true, async () => { await instantiation.invokeFunction(newSnippet); }));
	if (selection) {
		snippetActions.push(new Action('dispatch.terminal.snippet.fromSelection', 'Save Selection as Snippet...', undefined, true, async () => { await instantiation.invokeFunction(newSnippet, selection); }));
	}
	if (snippets.length) {
		snippetActions.push(new Action('dispatch.terminal.snippet.remove', 'Remove a Snippet...', undefined, true, async () => instantiation.invokeFunction(removeSnippet)));
	}
	return [
		new Action('dispatch.terminal.menu.copy', 'Copy', undefined, !!selection, async () => clipboard.writeText(c.copyText)),
		new Action('dispatch.terminal.menu.paste', 'Paste', undefined, true, async () => c.pasteClipboard()),
		new Action('dispatch.terminal.menu.selectAll', 'Select All', undefined, true, async () => c.selectAll()),
		new Separator(),
		new SubmenuAction('dispatch.terminal.menu.snippets', 'Snippets', snippetActions),
		new Separator(),
		new Action('dispatch.terminal.menu.continue', 'Continue in a New Session', undefined, true, run(continueInNewSession)),
		new Action('dispatch.terminal.menu.fork', 'Fork Session', undefined, true, run(forkSession)),
		new Action('dispatch.terminal.menu.copyContext', 'Copy Context', undefined, true, run(copyContext)),
		new Separator(),
		new Action('dispatch.terminal.menu.clear', 'Clear', undefined, true, async () => c.clear()),
		new Separator(),
		new Action('dispatch.terminal.menu.splitRight', 'Split Right', undefined, true, async () => c.paneCommand('splitRight')),
		new Action('dispatch.terminal.menu.splitDown', 'Split Down', undefined, true, async () => c.paneCommand('splitDown')),
		...(isPane ? [new Action('dispatch.terminal.menu.closePane', 'Close Pane', undefined, true, async () => c.paneCommand('closePane'))] : []),
		new Separator(),
		...(chatUnavailableReason(session) ? [] : [new Action('dispatch.terminal.menu.showChat', main.viewMode === 'chat' ? 'Show as Terminal' : 'Show as Chat', undefined, true, async () => main.showView(main.viewMode === 'chat' ? 'terminal' : 'chat'))]),
		...(session.agent ? [new Action('dispatch.terminal.menu.restart', `Restart ${session.agent.name}`, undefined, true, async () => main.restart())] : []),
		new Action('dispatch.terminal.menu.close', 'Close Terminal', undefined, true, async () => { await providerNow?.deleteSession(session.sessionId); }),
		new SubmenuAction('dispatch.terminal.menu.more', 'More', [
			new Action('dispatch.terminal.menu.rename', 'Rename...', undefined, true, run(rename)),
			new Action('dispatch.terminal.menu.copyId', 'Copy Session ID', undefined, true, async () => clipboard.writeText(main.id)),
			new Action('dispatch.terminal.menu.reset', 'Reset Terminal', undefined, true, async () => c.reset()),
			new Separator(),
			new Action('dispatch.terminal.menu.shortcuts', 'Change Shortcuts...', undefined, true, run(async accessor => { await accessor.get(ICommandService).executeCommand('dispatch.terminal.changeShortcuts'); })),
		]),
	];
}

class DispatchTerminalMenus extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.terminalMenus';

	constructor(
		@ISessionsProvidersService providers: ISessionsProvidersService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super();
		const p = providers.getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID);
		if (!p) {
			return;
		}
		// read once now, so the first right-click shows them without waiting
		void instantiation.invokeFunction(accessor => loadSnippets(accessor.get(ICommandService)));
		this._register(p.onDidRequestFind(controller => instantiation.invokeFunction(showTerminalFind, controller)));
		// the sessions of a folder are its tabs: ⌘⇧] ⌘⇧[ go to the next or previous one, in the order they were opened
		this._register(p.onDidRequestSessionStep(({ session, delta }) => instantiation.invokeFunction(accessor => {
			const folder = session.folder.toString();
			const same = accessor.get(ISessionsManagementService).getSessions()
				.filter(s => s.workspace.get()?.folders[0]?.root.toString() === folder || s.workspace.get()?.uri.toString() === folder)
				.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
			const at = same.findIndex(s => s.sessionId === session.sessionId);
			if (same.length < 2 || at < 0) {
				return;
			}
			const to = same[(at + delta + same.length) % same.length];
			void accessor.get(ISessionsService).openSession(to.resource);
		})));
		this._register(p.onDidRequestMenu(async ({ session, pane, event }) => {
			const actions = await instantiation.invokeFunction(terminalMenu, session, pane);
			menus.showContextMenu({
				getAnchor: () => ({ x: event.clientX, y: event.clientY }),
				getActions: () => actions,
				onHide: () => pane.focus(),
			});
		}));
	}
}

registerWorkbenchContribution2(DispatchTerminalMenus.ID, DispatchTerminalMenus, WorkbenchPhase.AfterRestored);

// ---- panes, the folder's sessions, the text size: the menu, the command palette and Keyboard Shortcuts ----------
// Orca's keys are the defaults; each one can be changed or removed in Keyboard Shortcuts (Orca lets every shortcut be
// changed too). The terminal asks the window's key bindings which command a key is (dispatchXterm.ts). The list is
// shared with the editor window, whose Keyboard Shortcuts lists them too (workbench/contrib/dispatchTerminalKeys).

for (const key of DISPATCH_TERMINAL_KEYS) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: terminalKeyCommand(key.name), title: key.title, category: DISPATCH_TERMINAL_CATEGORY, f1: true,
				keybinding: { primary: key.primary, secondary: key.secondary, when: terminalKeyWhen(key), weight: DISPATCH_TERMINAL_KEY_WEIGHT },
			});
		}
		run(accessor: ServicesAccessor): void {
			const name = key.name;
			if (name === 'zoomIn' || name === 'zoomOut' || name === 'zoomReset') {
				active(accessor)?.shortcut(name);
			} else {
				active(accessor)?.paneCommand(name);
			}
		}
	});
}

// the terminal's own menu › More › Change Shortcuts…: Keyboard Shortcuts, showing only these
registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'dispatch.terminal.changeShortcuts', title: localize2('dispatchTerminal.changeShortcuts', "Change Terminal Shortcuts"), category: DISPATCH_TERMINAL_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('workbench.action.openGlobalKeybindings', DISPATCH_TERMINAL_KEYS_QUERY);
	}
});
