/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where Claude Code says a background sub-agent has ended (task-518qw). No imports but types: Node runs
 *  this file as it is (ide/tests/subagent-end.test.mjs).
 *
 *  A background sub-agent (`Agent` with run_in_background) ends three ways the host can see:
 *    - the SDK's `system` message `task_notification` carrying the `tool_use_id` that sent it out;
 *    - the user message the CLI writes into the parent conversation for it, `<task-notification>` with
 *      `<tool-use-id>` and `<status>` (the turn the CLI starts by itself when the parent was idle);
 *    - its own `subagents/agent-<id>.meta.json` next to the parent's record, which says `"finished": true`.
 *  Until 2026-11-16 the host listened only to the first, and only inside a turn it had started: a notification that
 *  came while the parent conversation was idle was dropped (ClaudeSdkMessageRouter has no turn to map it to), so the
 *  sub-agent showed "Working" for hours (3 of 4 that day, design/subagent-now/redesign/subagent-end-signal.json).
 *--------------------------------------------------------------------------------------------*/

export interface ISubagentEnd {
	/** The tool call that sent the sub-agent out; empty when the note names only the agent (`agentId`). */
	readonly toolUseId: string;
	/** The agent's own id, from a note that names agents only ("3 background agents didn't finish …" on a restart). */
	readonly agentId?: string;
	readonly status: string;
}

/** What Claude Code calls an end: the SDK says completed, failed or stopped; the CLI's note also killed. */
const ENDED = new Set(['completed', 'failed', 'stopped', 'killed']);

/**
 * The ends a `<task-notification>` note names: its tool call; or, with none, each agent it lists by its task id (the
 * one note Claude Code writes on a restart for all that did not finish). None for a note that is no end.
 */
function fromNote(text: string): ISubagentEnd[] {
	if (!text.includes('<task-notification>')) {
		return [];
	}
	const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1] ?? '';
	if (!ENDED.has(status)) {
		return [];
	}
	const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1];
	if (toolUseId) {
		return [{ toolUseId, status }];
	}
	const ends: ISubagentEnd[] = [];
	for (const m of text.matchAll(/<task-id>\s*([^<\s]+)\s*<\/task-id>/g)) {
		ends.push({ toolUseId: '', agentId: m[1], status });
	}
	return ends;
}

function textOf(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '').join('\n');
	}
	return '';
}

/**
 * The sub-agents a message from the SDK (or a line of the parent's record) says have ended: a `system`
 * `task_notification` with a tool call and an ending status, or a user message holding `<task-notification>` notes.
 */
export function subagentEndsIn(message: unknown): ISubagentEnd[] {
	if (!message || typeof message !== 'object') {
		return [];
	}
	const m = message as { type?: unknown; subtype?: unknown; tool_use_id?: unknown; status?: unknown; message?: { content?: unknown } };
	if (m.type === 'system' && m.subtype === 'task_notification') {
		return typeof m.tool_use_id === 'string' && m.tool_use_id && typeof m.status === 'string' && ENDED.has(m.status)
			? [{ toolUseId: m.tool_use_id, status: m.status }]
			: [];
	}
	if (m.type === 'user') {
		const text = textOf(m.message?.content);
		return text.split('</task-notification>').flatMap(fromNote);
	}
	return [];
}

/** Why one that ended without finishing ended, in the words its chat shows; undefined for one that completed. */
export function stoppedReason(status: string): string | undefined {
	switch (status) {
		case 'completed': return undefined;
		case 'failed': return 'Failed before it finished.';
		default: return 'Stopped before it finished.'; // killed, stopped
	}
}

/**
 * How long a background sub-agent may write nothing while the Claude Code process that ran it is gone, before it is
 * shown stopped. A sub-agent waiting on a long build writes nothing for a while too, so this is only used with no
 * process left to run it; half an hour, the window the sidebar uses for records that may still be at work.
 */
export const SILENT_MS = 30 * 60_000;

/** No word from it and none of the conversation that sent it for `SILENT_MS`, and no process to run it. */
export function isSilent(lastWrites: readonly (number | undefined)[], now: number, processAlive: boolean): boolean {
	return !processAlive && lastWrites.every(at => at === undefined || now - at >= SILENT_MS);
}

/** What one `agent-<id>.meta.json` says: the tool call that sent it out and whether it finished; undefined when unreadable. */
export function metaOf(text: string): { readonly toolUseId: string; readonly finished: boolean } | undefined {
	try {
		const meta = JSON.parse(text) as { toolUseId?: unknown; finished?: unknown };
		return typeof meta.toolUseId === 'string' && meta.toolUseId ? { toolUseId: meta.toolUseId, finished: meta.finished === true } : undefined;
	} catch {
		return undefined; // a file the CLI is writing this moment: read again next round
	}
}

/** The tool calls whose sub-agent is finished, from the text of its `agent-<id>.meta.json` files (unreadable ones skipped). */
export function finishedInMeta(metas: readonly string[]): string[] {
	return metas.map(metaOf).filter(meta => !!meta && meta.finished).map(meta => meta!.toolUseId);
}

/** The folder of a conversation's sub-agent records: next to its record, `<config>/projects/<cwd with - for every other character>/<session>/subagents`. */
export function subagentFolder(configDir: string, cwd: string, sessionId: string): string {
	return `${configDir.replace(/\/+$/, '')}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}/subagents`;
}
