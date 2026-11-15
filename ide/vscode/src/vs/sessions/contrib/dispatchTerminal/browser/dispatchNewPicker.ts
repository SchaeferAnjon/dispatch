/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "+" asks Chat or Terminal first, then which agent (kanban design/terminal-merge, direction A, A1).
 *
 *  A small panel opens next to what was clicked (not at the top of the window): a "Chat / Terminal" switch that
 *  remembers the last choice, then one row per agent with its own mark, its name and the plain sentence the CLI
 *  gives (`dispatch terminal agents`). In Terminal the mark sits in a dark square, so it is clear a terminal
 *  opens. An agent Dispatch's chat cannot drive says "Terminal only" and opens a terminal from Chat too. Terminal
 *  ends with "Blank terminal": a shell where the person types any command.
 *
 *  Opened by ⌘T (Terminal), by "New Session or Terminal..." in the command palette, and by "New Terminal..."
 *  in the "+" menu of a folder in the sessions list.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchNewPicker.css';
import * as DOM from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ITerminalAgent } from './dispatchTerminalModel.js';
import { DISPATCH_TERMINAL_PROVIDER_ID, DispatchTerminalSessionsProvider } from './dispatchTerminalSessionsProvider.js';
import { folderDisplayName } from '../../../common/dispatchSeparateCopy.js';

export type NewSessionMode = 'chat' | 'terminal';
const MODE_KEY = 'dispatch.newPicker.mode';

/** Where the pointer was last pressed: the panel opens there when the click came through a menu. */
let lastPointer: { x: number; y: number } | undefined;
mainWindow.addEventListener('pointerdown', e => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

function markIcon(agentId: string): ThemeIcon {
	return agentIcon(agentId);
}

/** The chat session type of an agent Dispatch's chat drives, from the session providers ('agent-host-claude' …). */
function chatTarget(accessor: ServicesAccessor, agentId: string): { providerId: string; sessionTypeId: string } | undefined {
	// the local agent host lists its types as 'claude', 'codex', 'opencode' (chat resources say agent-host-<id>)
	const providers = accessor.get(ISessionsProvidersService).getProviders().filter(p => p.id !== DISPATCH_TERMINAL_PROVIDER_ID);
	for (const local of [true, false]) {
		for (const provider of providers.filter(p => /local/i.test(p.id) === local)) {
			for (const type of provider.sessionTypes) {
				if (type.id === agentId || type.id === `agent-host-${agentId}`) {
					return { providerId: provider.id, sessionTypeId: type.id };
				}
			}
		}
	}
	return undefined;
}

interface IRow {
	readonly agent?: ITerminalAgent;
	readonly blank?: boolean;
}

/**
 * Shows the panel for `folder` next to `anchor` (the last pointer press when none is given) and does what is
 * picked: a new chat session with that agent, or a terminal running it.
 */
export async function showNewSessionPicker(accessor: ServicesAccessor, folder: URI, mode?: NewSessionMode, anchor?: { x: number; y: number }): Promise<void> {
	const contextView = accessor.get(IContextViewService);
	const commands = accessor.get(ICommandService);
	const storage = accessor.get(IStorageService);
	const sessions = accessor.get(ISessionsService);
	const notifications = accessor.get(INotificationService);
	const providers = accessor.get(ISessionsProvidersService);
	const targets = new Map<string, { providerId: string; sessionTypeId: string }>();
	for (const id of ['claude', 'codex', 'opencode']) {
		const t = chatTarget(accessor, id);
		if (t) {
			targets.set(id, t);
		}
	}
	let current: NewSessionMode = mode ?? (storage.get(MODE_KEY, StorageScope.APPLICATION) === 'terminal' ? 'terminal' : 'chat');
	let agents: ITerminalAgent[] = [];
	const where = anchor ?? lastPointer ?? { x: 120, y: 80 };
	const store = new DisposableStore();

	const pick = async (row: IRow) => {
		contextView.hideContextView();
		const terminalProvider = providers.getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID);
		try {
			const target = row.agent && targets.get(row.agent.id);
			if (current === 'chat' && row.agent && target) {
				await sessions.openNewSession({ folderUri: folder, ...target });
				return;
			}
			if (!terminalProvider) {
				return;
			}
			await commands.executeCommand('_dispatch.terminal.offerGhostty');
			const session = await terminalProvider.open(folder, row.blank ? undefined : row.agent);
			await sessions.openSession(session.resource);
		} catch (e) {
			notifications.error(String((e as Error)?.message ?? e));
		}
	};

	contextView.showContextView({
		getAnchor: () => ({ x: where.x, y: where.y, width: 0, height: 0 }),
		render: container => {
			const root = DOM.append(container, DOM.$('.dispatch-new-picker'));
			root.setAttribute('role', 'dialog');
			root.setAttribute('aria-label', `New in ${folderDisplayName(folder.path)}`);
			const head = DOM.append(root, DOM.$('.dnp-head'));
			// a separate copy's project, not the copy's folder name (kanban task-lj06.28)
			DOM.append(head, DOM.$('span.dnp-folder')).textContent = folderDisplayName(folder.path);
			const switcher = DOM.append(head, DOM.$('.dnp-switch'));
			switcher.setAttribute('role', 'tablist');
			const tabs: Record<NewSessionMode, HTMLButtonElement> = {
				chat: DOM.append(switcher, DOM.$<HTMLButtonElement>('button.dnp-tab', { role: 'tab', type: 'button' })),
				terminal: DOM.append(switcher, DOM.$<HTMLButtonElement>('button.dnp-tab', { role: 'tab', type: 'button' })),
			};
			tabs.chat.textContent = 'Chat';
			tabs.terminal.textContent = 'Terminal';
			const list = DOM.append(root, DOM.$('.dnp-list'));
			list.setAttribute('role', 'listbox');
			const foot = DOM.append(root, DOM.$('.dnp-foot'));
			let rows: HTMLElement[] = [];
			let focused = 0;

			const focusRow = (i: number) => {
				if (!rows.length) {
					return;
				}
				focused = (i + rows.length) % rows.length;
				rows.forEach((r, j) => r.classList.toggle('focused', j === focused));
				rows[focused].focus();
			};

			const draw = () => {
				for (const m of ['chat', 'terminal'] as const) {
					tabs[m].classList.toggle('on', current === m);
					tabs[m].setAttribute('aria-selected', String(current === m));
				}
				root.classList.toggle('terminal', current === 'terminal');
				DOM.clearNode(list);
				rows = [];
				const shown = agents.filter(a => a.enabled || current === 'terminal');
				if (!agents.length) {
					DOM.append(list, DOM.$('.dnp-empty')).textContent = 'Looking for the agents on this Mac...';
				}
				for (const agent of shown) {
					const terminalOnly = !targets.has(agent.id);
					const row = DOM.append(list, DOM.$<HTMLButtonElement>('button.dnp-row', { type: 'button', role: 'option' }));
					const mark = DOM.append(row, DOM.$('span.dnp-mark'));
					DOM.append(mark, DOM.$(`span${ThemeIcon.asCSSSelector(markIcon(agent.id))}`));
					const text = DOM.append(row, DOM.$('span.dnp-text'));
					const name = DOM.append(text, DOM.$('span.dnp-name'));
					name.textContent = agent.name;
					if (agent.is_default) {
						DOM.append(name, DOM.$('span.dnp-default')).textContent = 'Default';
					}
					DOM.append(text, DOM.$('span.dnp-about')).textContent = agent.about;
					if (terminalOnly && current === 'chat') {
						DOM.append(row, DOM.$('span.dnp-tag')).textContent = 'Terminal only';
					}
					row.title = terminalOnly && current === 'chat' ? `${agent.name} runs in a terminal: it opens there.` : '';
					store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => void pick({ agent })));
					rows.push(row);
				}
				DOM.clearNode(foot);
				if (current === 'terminal') {
					const blank = DOM.append(foot, DOM.$<HTMLButtonElement>('button.dnp-row.dnp-blank', { type: 'button', role: 'option' }));
					DOM.append(DOM.append(blank, DOM.$('span.dnp-mark')), DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.terminal)}`));
					const text = DOM.append(blank, DOM.$('span.dnp-text'));
					DOM.append(text, DOM.$('span.dnp-name')).textContent = 'Blank terminal';
					DOM.append(text, DOM.$('span.dnp-about')).textContent = `A shell in ${folderDisplayName(folder.path)}. Type any command.`;
					store.add(DOM.addDisposableListener(blank, DOM.EventType.CLICK, () => void pick({ blank: true })));
					rows.push(blank);
				}
				focusRow(0);
			};

			const setMode = (m: NewSessionMode) => {
				current = m;
				storage.store(MODE_KEY, m, StorageScope.APPLICATION, StorageTarget.USER);
				draw();
			};
			store.add(DOM.addDisposableListener(tabs.chat, DOM.EventType.CLICK, () => setMode('chat')));
			store.add(DOM.addDisposableListener(tabs.terminal, DOM.EventType.CLICK, () => setMode('terminal')));
			store.add(DOM.addDisposableListener(root, DOM.EventType.KEY_DOWN, e => {
				const k = new StandardKeyboardEvent(e);
				if (k.equals(KeyCode.DownArrow)) {
					focusRow(focused + 1);
				} else if (k.equals(KeyCode.UpArrow)) {
					focusRow(focused - 1);
				} else if (k.equals(KeyCode.LeftArrow) || k.equals(KeyCode.RightArrow)) {
					setMode(current === 'chat' ? 'terminal' : 'chat');
				} else if (k.equals(KeyCode.Escape)) {
					contextView.hideContextView();
				} else {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
			}));
			draw();
			void commands.executeCommand<{ agents?: ITerminalAgent[] }>('dispatch.terminal', 'agents').then(answer => {
				agents = Array.isArray(answer?.agents) ? answer.agents : [];
				draw();
			}, () => {
				DOM.clearNode(list);
				DOM.append(list, DOM.$('.dnp-empty')).textContent = 'Dispatch could not look for agents just now. A blank terminal still opens.';
			});
			return store;
		},
		onHide: () => store.dispose(),
	});
}
