/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's tool calls (ACP `tool_call` / `tool_call_update`) as the rows of a
 *  Claude session: each OpenCode tool is shown as the Claude tool it matches ("Ran `ls app`",
 *  "Read DESIGN.md", "Edit app.ts", the same icons and renderers), through claudeToolDisplay's
 *  wording. A few OpenCode tools Claude has no row for (web search, a subagent task, reading the
 *  todo list) get the same kind of wording here. Pure helpers.
 *--------------------------------------------------------------------------------------------*/

import { appendEscapedMarkdownInlineCode } from '../../../../base/common/htmlContent.js';
import { truncate } from '../../../../base/common/strings.js';
import { localize } from '../../../../nls.js';
import type { StringOrMarkdown } from '../../common/state/protocol/state.js';
import { buildClaudeToolMeta, getClaudeConfirmationTitle, getClaudeInvocationMessage, getClaudePastTenseMessage, getClaudePermissionKind, getClaudeToolDisplayName, getClaudeToolInputString, getClaudeToolPath, type ClaudePermissionKind } from '../claude/claudeToolDisplay.js';
import type { IAcpSessionUpdate } from './opencodeAcpClient.js';

/** A tool call as shown: the Claude tool it matches (or one of ours below) and that tool's input. */
export interface IOpenCodeToolView {
	/** OpenCode's own tool id (`bash`, `write`, `todowrite`), when the update said it */
	readonly ocName?: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
}

/** Our names for OpenCode tools Claude has no row for; rendered with the generic tool renderer. */
const WEB_SEARCH = 'WebSearch';
const TODO_READ = 'TodoRead';
const SUBAGENT = 'Subagent';

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function rawInputOf(update: IAcpSessionUpdate): Record<string, unknown> {
	const raw = update.rawInput;
	return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** The tool id: the first live `tool_call` titles the call with it; later updates and replays with a human title. */
function ocNameOf(update: IAcpSessionUpdate, previous?: IOpenCodeToolView): string | undefined {
	if (previous?.ocName) {
		return previous.ocName;
	}
	const title = (update.title ?? '').trim();
	return /^[a-z][a-z0-9_]*$/.test(title) && update.sessionUpdate === 'tool_call' ? title : undefined;
}

/**
 * The view of a tool call after this update. A later update with no input keeps what an earlier
 * one said (the first `tool_call` often has no input yet).
 */
export function toolView(update: IAcpSessionUpdate, previous?: IOpenCodeToolView): IOpenCodeToolView {
	const raw = rawInputOf(update);
	const ocName = ocNameOf(update, previous);
	const hasInput = Object.keys(raw).some(k => k !== 'cwd');
	if (!hasInput && previous && previous.name !== 'tool') {
		return ocName && !previous.ocName ? { ...previous, ocName } : previous;
	}
	const file = str(raw['filePath']) || str(raw['file_path']) || str(raw['filepath']) || str(update.locations?.[0]?.path);
	const view = (name: string, input: Record<string, unknown>): IOpenCodeToolView => ({ ...(ocName ? { ocName } : {}), name, input });
	switch (ocName) {
		case 'bash': return view('Bash', { command: str(raw['command']), description: str(raw['description']) });
		case 'read': return view('Read', { file_path: file });
		case 'list': return view('LS', { path: str(raw['path']) || str(update.locations?.[0]?.path) });
		case 'write': return view('Write', { file_path: file });
		case 'edit':
		case 'multiedit':
		case 'patch':
		case 'apply_patch': return view('Edit', { file_path: file });
		case 'glob': return view('Glob', { pattern: str(raw['pattern']), path: str(raw['path']) });
		case 'grep': return view('Grep', { pattern: str(raw['pattern']), path: str(raw['path']) });
		case 'webfetch': return view('WebFetch', { url: str(raw['url']) });
		case 'websearch':
		case 'codesearch': return view(WEB_SEARCH, { query: str(raw['query']) });
		case 'todowrite': return view('TodoWrite', { todos: raw['todos'] });
		case 'todoread': return view(TODO_READ, {});
		case 'task': return view(SUBAGENT, { description: str(raw['description']), prompt: str(raw['prompt']), subagent_type: str(raw['subagent_type']) });
		case 'skill': return view('Skill', { skill: str(raw['name']) || str(raw['skill']) });
		// OpenCode's question tool: Claude's AskUserQuestion (its card is the host's question card, opencodeQuestions.ts)
		case 'question': return view('AskUserQuestion', { questions: raw['questions'] });
	}
	// no tool id (a replay, or an update that came first): the ACP kind and the input's shape
	switch (update.kind) {
		case 'execute': return view('Bash', { command: str(raw['command']) || (hasInput ? '' : str(update.title)), description: str(raw['description']) });
		case 'read':
			return file || !raw['path'] ? view('Read', { file_path: file }) : view('LS', { path: str(raw['path']) });
		case 'edit': return view(raw['content'] !== undefined && raw['oldString'] === undefined ? 'Write' : 'Edit', { file_path: file });
		case 'search': return view(raw['include'] !== undefined || /grep/i.test(update.title ?? '') ? 'Grep' : raw['pattern'] !== undefined && /[*?{[]/.test(str(raw['pattern'])) ? 'Glob' : 'Grep', { pattern: str(raw['pattern']), path: str(raw['path']) });
		case 'fetch': return raw['url'] !== undefined ? view('WebFetch', { url: str(raw['url']) }) : view(WEB_SEARCH, { query: str(raw['query']) });
	}
	if (Array.isArray(raw['todos'])) {
		return view('TodoWrite', { todos: raw['todos'] });
	}
	if (raw['subagent_type'] !== undefined || (raw['prompt'] !== undefined && raw['description'] !== undefined)) {
		return view(SUBAGENT, { description: str(raw['description']), prompt: str(raw['prompt']), subagent_type: str(raw['subagent_type']) });
	}
	if (previous && !hasInput) {
		return previous;
	}
	return view(ocName ?? (update.title?.trim() || 'tool'), raw);
}

/** Whether the view knows enough to name what it does (a command, a file, a pattern). */
export function toolHasInput(view: IOpenCodeToolView): boolean {
	return Object.values(view.input).some(v => typeof v === 'string' ? !!v : v !== undefined && v !== null);
}

export function toolDisplayName(view: IOpenCodeToolView): string {
	switch (view.name) {
		case WEB_SEARCH: return localize('opencode.tool.webSearch', "Search the web");
		case TODO_READ: return localize('opencode.tool.todoRead', "Read todo list");
		case SUBAGENT: return localize('opencode.tool.subagent', "Run subagent task");
		default: return getClaudeToolDisplayName(view.name);
	}
}

export function toolInvocationMessage(view: IOpenCodeToolView): StringOrMarkdown {
	const displayName = toolDisplayName(view);
	switch (view.name) {
		case WEB_SEARCH: {
			const query = str(view.input['query']);
			return query ? { markdown: localize('opencode.toolInvoke.webSearch', "Searching the web for {0}", appendEscapedMarkdownInlineCode(truncate(query, 80))) } : displayName;
		}
		case TODO_READ: return localize('opencode.toolInvoke.todoRead', "Reading todo list");
		case SUBAGENT: return str(view.input['description']) || displayName;
		default: return getClaudeInvocationMessage(view.name, displayName, view.input);
	}
}

export function toolPastTenseMessage(view: IOpenCodeToolView, success: boolean, output?: string): StringOrMarkdown {
	const displayName = toolDisplayName(view);
	if (!success) {
		return localize('opencode.toolComplete.failed', "\"{0}\" failed", displayName);
	}
	switch (view.name) {
		case WEB_SEARCH: {
			const query = str(view.input['query']);
			return query ? { markdown: localize('opencode.toolComplete.webSearch', "Searched the web for {0}", appendEscapedMarkdownInlineCode(truncate(query, 80))) } : displayName;
		}
		case TODO_READ: return localize('opencode.toolComplete.todoRead', "Read todo list");
		case SUBAGENT: {
			const description = str(view.input['description']);
			return description ? localize('opencode.toolComplete.subagentNamed', "Ran subagent: {0}", truncate(description, 80)) : localize('opencode.toolComplete.subagent', "Ran subagent");
		}
		case 'TodoWrite': return localize('opencode.toolComplete.todoWrite', "Updated todo list");
		default: return getClaudePastTenseMessage(view.name, displayName, view.input, true, output);
	}
}

export function toolInputString(view: IOpenCodeToolView): string | undefined {
	switch (view.name) {
		case WEB_SEARCH: return str(view.input['query']) || undefined;
		case SUBAGENT: return str(view.input['prompt']) || str(view.input['description']) || undefined;
		case TODO_READ: return undefined;
		default: return getClaudeToolInputString(view.name, view.input);
	}
}

/**
 * Dispatch IDE: a subagent task OpenCode runs (its `task` tool), as the Agent Host's sub-agent signal wants it: the
 * agent it runs ("general", "explore"), its short description (the sub-agent's name in the sessions list) and the
 * prompt it was given (its chat's first message). Undefined for any other tool, or before OpenCode sent the input.
 */
export function subagentTask(view: IOpenCodeToolView): { agentName: string; agentDisplayName: string; description: string; prompt: string } | undefined {
	if (view.name !== SUBAGENT || !toolHasInput(view)) {
		return undefined;
	}
	const agentName = str(view.input['subagent_type']) || 'general';
	return {
		agentName,
		agentDisplayName: agentName.charAt(0).toUpperCase() + agentName.slice(1),
		description: str(view.input['description']),
		prompt: str(view.input['prompt']) || str(view.input['description']),
	};
}

/**
 * What a subagent task answered, without OpenCode's own bookkeeping: `<task_metadata>`, and what a plugin adds
 * for the agent rather than the person (empty `{}` lines, `to continue: task(task_id=…)`).
 */
export function subagentAnswer(output: string): string {
	// OpenCode 1.18 wraps it in <task id="ses_…" state="completed"><task_result>…</task_result></task>
	return output.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, '')
		.replace(/<\/?task(?:_result)?\b[^>]*>/g, '')
		.split('\n')
		.filter(line => !/^\s*\{\}\s*$/.test(line) && !/^\s*to continue: task\(/.test(line))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** The renderer hint (terminal for shell, read, search); none for a subagent task: there is no subagent chat to open. */
export function toolMeta(view: IOpenCodeToolView): Record<string, unknown> | undefined {
	return view.name === SUBAGENT ? undefined : buildClaudeToolMeta(view.name);
}

/** What a permission OpenCode asks for is about: the auto-approval kind, the path, the card's title. */
export function toolPermission(view: IOpenCodeToolView, update: IAcpSessionUpdate): { kind: ClaudePermissionKind; path?: string; title: StringOrMarkdown } {
	const kind: ClaudePermissionKind = view.name === WEB_SEARCH ? 'url' : view.name === SUBAGENT ? 'custom-tool' : getClaudePermissionKind(view.name);
	const path = getClaudeToolPath(view.name, view.input) || str(update.locations?.[0]?.path) || undefined;
	const title = view.name === WEB_SEARCH
		? localize('opencode.permission.webSearch', "Search the web?")
		: getClaudeConfirmationTitle(view.name);
	return { kind, ...(path ? { path } : {}), title };
}

/** The text a tool produced: ACP content blocks, else OpenCode's rawOutput; edits say which file. */
export function toolOutputText(update: IAcpSessionUpdate, limit = 20000): string {
	const parts: string[] = [];
	if (Array.isArray(update.content)) {
		for (const block of update.content as { type?: string; content?: { type?: string; text?: string }; path?: string }[]) {
			if (block?.type === 'content' && block.content?.type === 'text' && block.content.text) {
				parts.push(block.content.text);
			} else if (block?.type === 'diff' && block.path) {
				parts.push(localize('opencode.toolOutput.edited', "Edited {0}", block.path));
			}
		}
	}
	if (!parts.length && update.rawOutput && typeof update.rawOutput === 'object') {
		const output = (update.rawOutput as Record<string, unknown>)['output'];
		if (typeof output === 'string') {
			parts.push(output);
		}
	}
	const text = parts.join('\n');
	return text.length > limit ? text.slice(0, limit) + '\n…' : text;
}
