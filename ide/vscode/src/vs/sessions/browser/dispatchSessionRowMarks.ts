/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: at the end of a session row, the agent's own mark, and ">_" when it runs in a terminal
 *  (kanban design/terminal-merge, direction A: "Agent 用自己的图标").
 *
 *  The sessions list (contrib/sessions/browser/views/sessionsList.ts) calls `renderDispatchRowMark` for every
 *  session row. A chat session of Claude Code, Codex or OpenCode shows that agent's mark; a terminal session
 *  (contrib/dispatchTerminal) registers its own: the agent's mark, or none for a plain shell, then ">_".
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSessionRowMarks.css';
import * as DOM from '../../base/browser/dom.js';
import { Codicon } from '../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { openCodeIcon } from '../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { getChatSessionType } from '../../workbench/contrib/chat/common/model/chatUri.js';
import { ISession } from '../services/sessions/common/session.js';
import { renderSubAgentCount } from './dispatchSubAgentRows.js';

export interface IDispatchRowMark {
	/** The agent's mark; undefined for a plain shell. */
	readonly icon?: ThemeIcon;
	/** It runs in a terminal: ">_" follows the mark. */
	readonly terminal: boolean;
	/** Said by screen readers and the tooltip: "Claude Code in a terminal". */
	readonly label: string;
}

type RowMarkProvider = (session: ISession) => IDispatchRowMark | undefined;
const providers: RowMarkProvider[] = [];

export function registerDispatchRowMark(provider: RowMarkProvider): IDisposable {
	providers.push(provider);
	return toDisposable(() => {
		const i = providers.indexOf(provider);
		if (i >= 0) {
			providers.splice(i, 1);
		}
	});
}

const ENGINES: readonly { readonly id: string; readonly name: string; readonly icon: ThemeIcon }[] = [
	{ id: 'claude', name: 'Claude Code', icon: Codicon.claude },
	{ id: 'codex', name: 'Codex', icon: Codicon.openai },
	{ id: 'opencode', name: 'OpenCode', icon: openCodeIcon },
];

function chatMark(session: ISession): IDispatchRowMark | undefined {
	let type = '';
	try {
		type = getChatSessionType(session.resource);
	} catch {
		return undefined;
	}
	const engine = ENGINES.find(e => type === `agent-host-${e.id}` || (type.startsWith('remote-') && type.endsWith(`-${e.id}`)));
	return engine ? { icon: engine.icon, terminal: false, label: engine.name } : undefined;
}

export function dispatchRowMark(session: ISession): IDispatchRowMark | undefined {
	for (const provider of providers) {
		const mark = provider(session);
		if (mark) {
			return mark;
		}
	}
	return chatMark(session);
}

/**
 * Fills `container` (a span at the end of the row's title line) with the session's mark, and before it the count of
 * the sub-agents it sent out (dispatchSubAgentRows.ts), kept up to date for as long as `store` lives.
 */
export function renderDispatchRowMark(container: HTMLElement, session: ISession, store?: DisposableStore): void {
	DOM.clearNode(container);
	const mark = dispatchRowMark(session);
	renderSubAgentCount(container, session, store);
	container.classList.toggle('empty', !mark);
	if (!mark) {
		container.removeAttribute('title');
		container.removeAttribute('aria-label');
		return;
	}
	if (mark.icon) {
		DOM.append(container, DOM.$(`span.dispatch-row-mark-icon${ThemeIcon.asCSSSelector(mark.icon)}`));
	}
	if (mark.terminal) {
		DOM.append(container, DOM.$('span.dispatch-row-mark-terminal')).textContent = '>_';
	}
	container.title = mark.label;
	container.setAttribute('aria-label', mark.label);
}
