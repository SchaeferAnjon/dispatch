/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what fills a Claude Code session's context window, by kind (system prompt, built-in tools, MCP tools,
 *  skills, memory files, the conversation, free space), for the Context card (kanban, user 2026-10-20: "show how much
 *  skills, the conversation, MCP and the system take, as a chart"). The numbers are Claude Code's own, the data behind
 *  its /context (the SDK's getContextUsage), asked once after each turn with detail 'summary': from the last answer's
 *  usage and local counts, no extra request to the model. Written to <DISPATCH_DIR>/context-usage/<session id>.json;
 *  `dispatch session life` (kanban app/cli/session_life.py) hands it to the card.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ILogService } from '../../../log/common/log.js';
import { dispatchStateDir } from '../dispatchAgentSleep.js';

export async function recordDispatchContextUsage(query: Query, sessionId: string, log: ILogService): Promise<void> {
	try {
		const u = await query.getContextUsage({ detail: 'summary' });
		const dir = path.join(dispatchStateDir(), 'context-usage');
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${sessionId}.json`);
		const body = {
			at: Math.round(Date.now() / 1000),
			model: u.model,
			total: u.totalTokens,
			max: u.rawMaxTokens || u.maxTokens,
			categories: u.categories.map(c => ({ name: c.name, tokens: c.tokens, deferred: !!c.isDeferred })),
			skills: u.skills ? { count: u.skills.includedSkills, tokens: u.skills.tokens } : undefined,
			mcp: [...new Set(u.mcpTools.filter(t => t.isLoaded !== false).map(t => t.serverName))],
		};
		await fs.writeFile(`${file}.part`, JSON.stringify(body));
		await fs.rename(`${file}.part`, file);
	} catch (err) {
		log.info(`[Claude:${sessionId}] context usage not recorded: ${err}`);
	}
}
