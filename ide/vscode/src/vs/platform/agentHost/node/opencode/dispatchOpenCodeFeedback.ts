/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: notes on a diff go back to OpenCode (patches/220-opencode.patch, kanban task-ttsd).
 *
 *  In the Agents window you select lines of a change, write a note, and press Submit Feedback: the
 *  window sends `/act-on-feedback` with the ids of the notes. Claude and Copilot read the notes with the
 *  host's listComments tool; OpenCode has no host tools, so it never saw them. Here its turn gets the
 *  notes written out (the file, the lines, the code there and what you wrote), and the notes are
 *  marked done when the turn ends, as the other agents do with resolveComments.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import type { IAgentServerToolHost } from '../../common/agentServerTools.js';
import { isAgentFeedbackAnnotationsAttachment } from '../../common/meta/agentFeedbackAttachments.js';
import type { MessageAttachment } from '../../common/state/protocol/state.js';

/** One note as the host's listComments tool lists it. */
export interface IDiffNote {
	readonly id: string;
	readonly resourceUri: string;
	readonly range?: { readonly startLineNumber: number; readonly startColumn?: number; readonly endLineNumber: number; readonly endColumn?: number };
	readonly text: string;
	readonly author?: string;
	readonly replies?: readonly { readonly author?: string; readonly text: string }[];
}

const ACT_ON_FEEDBACK = /^\s*\/act-on-feedback\b\s*/;
const MAX_CODE_LINES = 20;

/** The ids of the notes a message carries (Submit Feedback attaches them); `all` when an attachment
 *  names no ids, which means every open note. Undefined when the message carries no notes. */
export function diffNoteIds(attachments: readonly MessageAttachment[] | undefined): string[] | 'all' | undefined {
	let found = false;
	const ids: string[] = [];
	for (const att of attachments ?? []) {
		if (!isAgentFeedbackAnnotationsAttachment(att)) {
			continue;
		}
		found = true;
		if (!att.annotationIds) {
			return 'all';
		}
		for (const id of att.annotationIds) {
			if (typeof id === 'string' && !ids.includes(id)) {
				ids.push(id);
			}
		}
	}
	return found && ids.length ? ids : undefined;
}

/** The lines a note covers: a selection that ends at the start of a line does not cover that line. */
export function noteLines(note: IDiffNote): { start: number; end: number } | undefined {
	const r = note.range;
	if (!r || !(r.startLineNumber > 0)) {
		return undefined;
	}
	let end = Math.max(r.startLineNumber, r.endLineNumber || r.startLineNumber);
	if (end > r.startLineNumber && r.endColumn === 1) {
		end--;
	}
	return { start: r.startLineNumber, end };
}

function fileOf(note: IDiffNote): string | undefined {
	try {
		const uri = URI.parse(note.resourceUri);
		return uri.scheme === 'file' ? uri.fsPath : undefined;
	} catch {
		return undefined;
	}
}

function shownPath(file: string | undefined, note: IDiffNote, cwd: string | undefined): string {
	if (!file) {
		return note.resourceUri;
	}
	if (cwd) {
		const rel = path.relative(cwd, file);
		if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
			return rel;
		}
	}
	return file;
}

function fence(code: string): string {
	let ticks = '```';
	while (code.includes(ticks)) {
		ticks += '`';
	}
	return ticks;
}

/**
 * The message OpenCode gets: what you typed (without `/act-on-feedback`), then every note with its
 * file, lines and the code there now.
 */
export function renderDiffNotes(prompt: string, notes: readonly IDiffNote[], cwd: string | undefined, readFile: (p: string) => string | undefined = safeRead): string {
	const asked = prompt.replace(ACT_ON_FEEDBACK, '').trim();
	const out: string[] = [];
	out.push(notes.length === 1
		? 'I left a note on your changes. Change the code it points at the way the note says and keep everything else as it is. Then say in a sentence or two what you changed.'
		: `I left ${notes.length} notes on your changes. Act on each one: change the code it points at the way the note says and keep everything else as it is. Then say in a sentence or two what you changed for each note.`);
	if (asked) {
		out.push(asked);
	}
	const cache = new Map<string, string[] | undefined>();
	notes.forEach((note, i) => {
		const file = fileOf(note);
		const lines = noteLines(note);
		const where = lines ? (lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start} to ${lines.end}`) : '';
		const head = `Note ${i + 1}, ${shownPath(file, note, cwd)}${where ? `, ${where}` : ''}:`;
		const parts = [head];
		if (file && lines) {
			if (!cache.has(file)) {
				const text = readFile(file);
				cache.set(file, text === undefined ? undefined : text.split(/\r?\n/));
			}
			const all = cache.get(file);
			if (all && lines.start <= all.length) {
				const code = all.slice(lines.start - 1, Math.min(lines.end, lines.start - 1 + MAX_CODE_LINES)).join('\n');
				const f = fence(code);
				parts.push(`${f}\n${code}\n${f}`);
			}
		}
		parts.push(note.text.trim());
		for (const reply of note.replies ?? []) {
			if (reply.text?.trim()) {
				parts.push(`${reply.author === 'agent' ? 'Your earlier reply' : 'Then I added'}: ${reply.text.trim()}`);
			}
		}
		out.push(parts.join('\n'));
	});
	return out.join('\n\n');
}

function safeRead(p: string): string | undefined {
	try {
		const stat = fs.statSync(p);
		return stat.size > 2 * 1024 * 1024 ? undefined : fs.readFileSync(p, 'utf8');
	} catch {
		return undefined;
	}
}

/** The notes with these ids, from the host's own record of them. */
export async function readDiffNotes(host: IAgentServerToolHost, chat: URI, ids: readonly string[] | 'all'): Promise<IDiffNote[]> {
	const raw = await host.executeTool(chat.toString(), 'listComments', { includeResolved: false });
	const parsed = JSON.parse(raw) as { comments?: (IDiffNote & { kind?: string })[] };
	const comments = (parsed.comments ?? []).filter(c => !!c && typeof c.id === 'string' && typeof c.text === 'string');
	if (ids === 'all') {
		return comments.filter(c => c.kind === undefined || c.kind === 'user');
	}
	const byId = new Map(comments.map(c => [c.id, c]));
	return ids.map(id => byId.get(id)).filter((c): c is IDiffNote => !!c);
}

/**
 * The prompt for a turn that carries notes, and their ids (to mark them done when the turn ends);
 * undefined when the message has no notes or they cannot be read (the prompt then goes as it is).
 */
export async function diffNotesPrompt(host: IAgentServerToolHost | undefined, chat: URI, prompt: string, attachments: readonly MessageAttachment[] | undefined, cwd: string | undefined, log: ILogService): Promise<{ prompt: string; ids: string[] } | undefined> {
	const ids = diffNoteIds(attachments);
	if (!ids || !host) {
		return undefined;
	}
	try {
		const notes = await readDiffNotes(host, chat, ids);
		if (!notes.length) {
			log.warn(`[OpenCode] ${chat.toString()}: none of the notes could be read`);
			return undefined;
		}
		log.info(`[OpenCode] ${chat.toString()}: ${notes.length} notes on the diff go with this turn`);
		return { prompt: renderDiffNotes(prompt, notes, cwd), ids: notes.map(n => n.id) };
	} catch (error) {
		log.warn(`[OpenCode] ${chat.toString()}: the notes could not be read: ${error}`);
		return undefined;
	}
}

/** The turn that got the notes ended: they are done (the window shows them as resolved). */
export async function resolveDiffNotes(host: IAgentServerToolHost | undefined, chat: URI, ids: readonly string[], log: ILogService): Promise<void> {
	if (!host || !ids.length) {
		return;
	}
	try {
		await host.executeTool(chat.toString(), 'resolveComments', { commentIds: [...ids], resolved: true });
	} catch (error) {
		log.warn(`[OpenCode] ${chat.toString()}: the notes could not be marked done: ${error}`);
	}
}
