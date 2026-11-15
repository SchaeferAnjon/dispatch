/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: OpenCode's own sessions, for the Agents window's list. A session started outside the
 *  app (OpenCode's terminal UI, `opencode run`) shows up there the way Claude's and Codex's do, and
 *  opening it goes on in the same OpenCode session. OpenCode keeps its sessions in its database and
 *  lists them per project only (ACP `session/list`, `opencode session list`), so the app reads its
 *  database itself: all top-level sessions in one query, kept in an index (opencodeSessionIndex.ts)
 *  that is read again only when the database file changes. When the query fails (an OpenCode without
 *  `db`, a changed schema) the last index stays and nothing else changes.
 *--------------------------------------------------------------------------------------------*/

import type { ModelSelection } from '../../common/state/protocol/state.js';
import { OPENCODE_DEFAULT_EFFORT, OPENCODE_THINKING_LEVEL_KEY } from './opencodeModels.js';

/** OpenCode's session ids (`ses_` and base62); anything else never reaches a query. */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

/** The title OpenCode gives a session before it has one of its own. */
export const OPENCODE_PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/** How many of the most recent sessions discovery lists; the host drops the ones older than its limit. */
export const OPENCODE_DISCOVERY_LIMIT = 300;

export interface IOpenCodeSessionRow {
	readonly id: string;
	/** OpenCode's title, or the first thing typed while OpenCode's is still the placeholder */
	readonly title?: string;
	readonly directory: string;
	readonly created: number;
	readonly updated: number;
	readonly model?: ModelSelection;
	/** Discovery lists it: it has a message and is not archived in OpenCode */
	readonly listed: boolean;
}

// Dispatch IDE (opencode-first-line-title): the first thing typed, for a session OpenCode has not titled yet
const FIRST_TYPED = "(SELECT json_extract(p.data, '$.text') FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = s.id AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0 ORDER BY p.time_created LIMIT 1)";
const COLUMNS = `s.id AS id, s.title AS title, s.directory AS directory, s.time_created AS created, s.time_updated AS updated, s.model AS model, ${FIRST_TYPED} AS first, (s.time_archived IS NULL AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)) AS listed`;

/** A title from the first thing typed: its first line, at most 80 characters. */
export function openCodeTitleFromFirst(first: unknown): string {
	const line = typeof first === 'string' ? first.trim().split('\n')[0].trim() : '';
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * Every top-level session (not a subagent's, `parent_id`), each with whether discovery lists it (`listed`: not
 * archived in OpenCode and not an empty one a client opened and left); with `since` (ms) only those updated at
 * or after it. One query for the whole index: a session id is never looked up on its own.
 */
export function openCodeSessionIndexQuery(since?: number): string {
	const changed = since === undefined ? '' : ` AND s.time_updated >= ${Math.max(0, Math.floor(since))}`;
	return `SELECT ${COLUMNS} FROM session s WHERE s.parent_id IS NULL${changed} ORDER BY s.time_updated DESC`;
}

/** The sessions discovery lists: the most recent listed ones, newest first. */
export function openCodeDiscoverable(rows: Iterable<IOpenCodeSessionRow>, limit = OPENCODE_DISCOVERY_LIMIT): IOpenCodeSessionRow[] {
	return [...rows].filter(row => row.listed).sort((a, b) => b.updated - a.updated).slice(0, Math.max(1, Math.floor(limit)));
}

/** `opencode db … --format json` output; undefined when it is not a JSON list (a failed read, never "no sessions"). */
export function parseOpenCodeSessionRows(stdout: string): IOpenCodeSessionRow[] | undefined {
	let rows: unknown;
	try {
		rows = JSON.parse(stdout.trim());
	} catch {
		return undefined;
	}
	return Array.isArray(rows) ? openCodeSessionRows(rows) : undefined;
}

/** Rows of the index query (from `opencode db` or the database itself); rows missing an id, a folder or times are left out. */
export function openCodeSessionRows(rows: readonly unknown[]): IOpenCodeSessionRow[] {
	const out: IOpenCodeSessionRow[] = [];
	for (const row of rows as Record<string, unknown>[]) {
		const id = row?.['id'];
		const directory = row?.['directory'];
		const created = Number(row?.['created']);
		const updated = Number(row?.['updated']);
		if (typeof id !== 'string' || !OPENCODE_SESSION_ID.test(id) || typeof directory !== 'string' || !directory.startsWith('/') || !Number.isFinite(created) || !Number.isFinite(updated)) {
			continue;
		}
		const own = typeof row['title'] === 'string' ? row['title'].trim() : '';
		// OpenCode's placeholder ("New session - <date>") until it names the session: the first thing typed instead
		const title = own && !OPENCODE_PLACEHOLDER_TITLE.test(own) ? own : openCodeTitleFromFirst(row['first']);
		const model = openCodeSessionModel(row['model']);
		out.push({
			id, directory, created, updated,
			...(title ? { title } : {}),
			...(model ? { model } : {}),
			listed: Number(row['listed']) === 1,
		});
	}
	return out;
}

/** The model a session last ran on (`{"id","providerID","variant"}` in OpenCode's database) as a picker selection. */
export function openCodeSessionModel(raw: unknown): ModelSelection | undefined {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { id, providerID, variant } = value as { id?: unknown; providerID?: unknown; variant?: unknown };
	if (typeof id !== 'string' || !id || typeof providerID !== 'string' || !providerID) {
		return undefined;
	}
	const effort = typeof variant === 'string' && /^[\w.-]+$/.test(variant) && variant !== OPENCODE_DEFAULT_EFFORT ? variant : undefined;
	return { id: `${providerID}/${id}`, ...(effort ? { config: { [OPENCODE_THINKING_LEVEL_KEY]: effort } } : {}) };
}
