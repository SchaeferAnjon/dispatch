/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: every coding agent's own mark, wherever an agent is listed (the first-run wizard,
 *  Customizations, a terminal session's row). The user's rule (2026-10-01): an agent always shows its own
 *  icon, never a generic one.
 *    - Claude Code, Codex, GitHub Copilot: codicon's own marks; OpenCode: Dispatch's glyph (dispatchEngineIcons.ts).
 *    - every other agent in kanban app/cli/agents_catalog.py: a product icon `dispatch-agent-<id>` drawn from
 *      media/agent-icons (dispatchAgentIcons.css): the agent's logo reduced to its shape in the text colour, so it
 *      sits with codicon's marks (DESIGN.md: icons are one colour). The logos are Orca's (github.com/stablyai/orca,
 *      MIT, Copyright (c) 2026 Lovecast Inc.); OpenHands' and Hermes' come from their GitHub organisations.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchAgentIcons.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { openCodeIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';

/** The agents with a mark of their own in media/agent-icons. */
const OWN_MARKS: readonly string[] = ['aider', 'amp', 'ante', 'antigravity', 'auggie', 'autohand', 'cline', 'codebuddy', 'codebuff', 'command-code', 'continue', 'crush', 'cursor', 'devin', 'droid', 'dsh', 'freebuff', 'gemini', 'goose', 'grok', 'hermes', 'kilo', 'kimi', 'kiro', 'mimo', 'muse', 'omp', 'openclaude', 'openclaw', 'openhands', 'pi', 'prime-agent', 'qoder', 'qwen', 'rovo', 'trae', 'vibe', 'zcode'];

const registered = new Map<string, ThemeIcon>();
for (const id of OWN_MARKS) {
	registered.set(id, registerIcon(`dispatch-agent-${id}`, Codicon.circleLargeOutline, localize('dispatchAgentIcon', "Icon for the coding agent {0}.", id)));
}

/** The icon of agent `id` (an agents_catalog.py id, or an agent host provider id). */
export function agentIcon(id: string): ThemeIcon {
	switch (id) {
		case 'claude': case 'claude-code': return Codicon.claude;
		case 'codex': return Codicon.openai;
		case 'copilot': return Codicon.copilot;
		case 'opencode': return openCodeIcon;
	}
	return registered.get(id) ?? Codicon.hubot;
}
