/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the agent did in the turn it is running, read from the conversation's own reply (task-q9x2r).
 *  Engine by engine the calls look different, so a call is read the same few ways for all of them:
 *  - a shell command (the terminal row's command line, or the `command` of its input): installs and deletions;
 *  - the files its message links (`Edit [reminder.ts](…)`) or Codex's `add: …` / `delete: …` lines;
 *  - Claude's edit pills, which say create or delete themselves.
 *  A file a writing call touched counts as new when the disk says it was made after the turn began. What the card says
 *  comes from the agent: the new file's first comment, else the sentence it wrote before the call (dispatchLearnModel).
 *--------------------------------------------------------------------------------------------*/

import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IChatProgressResponseContent } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { createdInTurn, deletesIn, filesInMessage, headerComment, ILearnEvent, installsIn, installSubjects, lastSentence, why, WRITE_TOOLS, writesIn } from '../common/dispatchLearnModel.js';

/** A file's path on this Mac from a link target or a path the agent wrote, or undefined. */
export function localPath(target: string, roots: readonly URI[]): URI | undefined {
	let uri: URI;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
		try {
			uri = URI.parse(target);
		} catch {
			return undefined;
		}
		if (uri.scheme === AGENT_HOST_SCHEME) {
			uri = fromAgentHostUri(uri);
		}
		if (uri.scheme !== 'file') {
			return undefined;
		}
		// a link to a line: `a.ts#L3`
		return uri.with({ fragment: '' });
	}
	const path = target.replace(/#L?\d+.*$/, '');
	if (path.startsWith('/')) {
		return URI.file(path);
	}
	return roots[0] ? URI.joinPath(roots[0], path) : undefined;
}

/** The session's folders as local file URIs (an agent-host session's are wrapped). */
export function localRoots(folders: readonly (URI | undefined)[]): URI[] {
	return folders.filter((u): u is URI => !!u).map(u => u.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(u) : u).filter(u => u.scheme === 'file');
}

function inside(uri: URI, roots: readonly URI[]): URI | undefined {
	return roots.find(r => isEqualOrParent(uri, r));
}

function relative(uri: URI, roots: readonly URI[]): string | undefined {
	const root = inside(uri, roots);
	return root ? uri.path.slice(root.path.replace(/\/$/, '').length + 1) : undefined;
}

function text(m: string | IMarkdownString | undefined): string {
	return !m ? '' : typeof m === 'string' ? m : m.value;
}

type ToolPart = IChatToolInvocation | IChatToolInvocationSerialized;

/** The shell command a call ran, when it ran one. */
export function commandOf(part: ToolPart): string | undefined {
	const data = part.toolSpecificData;
	if (data?.kind === 'terminal') {
		const c = (data as { commandLine?: { original?: string; userEdited?: string; toolEdited?: string } }).commandLine;
		return c?.toolEdited ?? c?.userEdited ?? c?.original;
	}
	if (data?.kind === 'input' && data.rawInput && typeof data.rawInput.command === 'string') {
		return data.rawInput.command;
	}
	// a shell call drawn as a plain row: "Ran `npm install x`"
	if (/^(Bash|bash|shell|run_in_terminal|local_shell|exec_command)$/.test(part.toolId)) {
		const m = /`([^`]+)`/.exec(text(part.pastTenseMessage) || text(part.invocationMessage));
		return m?.[1];
	}
	return undefined;
}

/** Whether the call ended in failure (a command's exit code, a cancelled call). */
function failed(part: ToolPart): boolean {
	const data = part.toolSpecificData as { terminalCommandState?: { exitCode?: number } } | undefined;
	const exit = data?.terminalCommandState?.exitCode;
	if (exit !== undefined && exit !== 0) {
		return true;
	}
	if (part.kind === 'toolInvocationSerialized') {
		return typeof part.isConfirmed === 'object' && (part.isConfirmed.type === ToolConfirmKind.Denied || part.isConfirmed.type === ToolConfirmKind.Skipped);
	}
	return part.state.get().type === IChatToolInvocation.StateKind.Cancelled;
}

/** The last sentence the agent wrote before the part at `index` in this reply. */
export function sentenceBefore(parts: readonly IChatProgressResponseContent[], index: number): string | undefined {
	for (let i = index - 1; i >= 0; i--) {
		const p = parts[i];
		if (p.kind === 'markdownContent') {
			const s = lastSentence(p.content.value);
			if (s) {
				return s;
			}
		}
	}
	return undefined;
}

export interface ITurnContext {
	readonly parts: readonly IChatProgressResponseContent[];
	/** When the turn began (the request's time, ms). */
	readonly start: number;
	readonly roots: readonly URI[];
	readonly fileService: IFileService;
}

/** What one finished call did that gets a word. */
export async function eventsOfCall(part: ToolPart, index: number, ctx: ITurnContext): Promise<ILearnEvent[]> {
	if (failed(part)) {
		return [];
	}
	const out: ILearnEvent[] = [];
	const before = sentenceBefore(ctx.parts, index);
	const call = part.toolCallId;

	const command = commandOf(part);
	if (command) {
		for (const install of installsIn(command)) {
			for (const subject of installSubjects(install)) {
				out.push({ kind: 'install', subject, command: install.command, why: why(before, install.packages), call });
			}
		}
		const cwd = (part.toolSpecificData as { cwd?: URI } | undefined)?.cwd;
		const base = cwd ? localRoots([URI.revive(cwd)]) : [];
		for (const p of deletesIn(command)) {
			const uri = localPath(p, base.length ? base : ctx.roots);
			if (uri && inside(uri, ctx.roots)) {
				out.push({ kind: 'delete', subject: uri.fsPath, rel: relative(uri, ctx.roots), command, why: why(before, [p]), call });
			}
		}
		// a file written by the shell (`cat > notes.ts <<EOF`, `touch a.ts`) is new when the disk says so
		for (const p of writesIn(command)) {
			const uri = localPath(p, base.length ? base : ctx.roots);
			if (!uri || !inside(uri, ctx.roots)) {
				continue;
			}
			const made = await createdAndSaid(uri, ctx);
			if (made.created) {
				out.push({ kind: 'create', subject: uri.fsPath, rel: relative(uri, ctx.roots), why: made.said ?? why(before, [uri.path]), call });
			}
		}
		return out;
	}

	const message = `${text(part.invocationMessage)}\n${text(part.pastTenseMessage)}`;
	const files = filesInMessage(message);
	const writes = WRITE_TOOLS.has(part.toolId) || /^(Edit|Write|Wrote|Create|Created)\b/.test(text(part.invocationMessage));
	const seen = new Set<string>();
	for (const f of files) {
		const uri = localPath(f.target, ctx.roots);
		if (!uri || !inside(uri, ctx.roots) || seen.has(uri.toString())) {
			continue;
		}
		seen.add(uri.toString());
		if (f.op === 'delete') {
			out.push({ kind: 'delete', subject: uri.fsPath, rel: relative(uri, ctx.roots), why: why(before, [uri.path]), call });
			continue;
		}
		if (f.op !== 'create' && !writes) {
			continue;
		}
		const made = await createdAndSaid(uri, ctx);
		if (f.op === 'create' || made.created) {
			out.push({ kind: 'create', subject: uri.fsPath, rel: relative(uri, ctx.roots), why: made.said ?? why(before, [uri.path]), call });
		}
	}
	return out;
}

/** Claude's edit pills: a file created or deleted, said by the pill itself. */
export async function eventsOfEdit(uri: URI, editKind: string, index: number, ctx: ITurnContext): Promise<ILearnEvent | undefined> {
	const local = uri.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(uri) : uri;
	if (local.scheme !== 'file' || !inside(local, ctx.roots) || (editKind !== 'create' && editKind !== 'delete')) {
		return undefined;
	}
	const before = sentenceBefore(ctx.parts, index);
	if (editKind === 'delete') {
		return { kind: 'delete', subject: local.fsPath, rel: relative(local, ctx.roots), why: why(before, [local.path]), call: `edit:${local.toString()}` };
	}
	const made = await createdAndSaid(local, ctx);
	return { kind: 'create', subject: local.fsPath, rel: relative(local, ctx.roots), why: made.said ?? why(before, [local.path]), call: `edit:${local.toString()}` };
}

/** Whether the file was made in this turn, and its first comment. */
async function createdAndSaid(uri: URI, ctx: ITurnContext): Promise<{ created: boolean; said?: string }> {
	try {
		const stat = await ctx.fileService.stat(uri);
		if (stat.isDirectory) {
			return { created: false };
		}
		const created = createdInTurn(stat.ctime, ctx.start);
		if (!created) {
			return { created };
		}
		const head = await ctx.fileService.readFile(uri, { length: 4096 });
		return { created, said: headerComment(head.value.toString()) };
	} catch {
		// gone again, or not readable: no word about it
		return { created: false };
	}
}
