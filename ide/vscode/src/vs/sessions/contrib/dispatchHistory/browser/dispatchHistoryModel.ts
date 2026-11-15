/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the History tab's data (patches/450-history.patch). Every agent session left on
 *  this Mac, from `dispatch sessions history --json` through dispatch-bridge's `dispatch.history`
 *  (kanban app/cli/session_history.py). Looking imports nothing: no project is registered, no session is
 *  added to the list on the left. The parts that need no workbench service live here.
 *--------------------------------------------------------------------------------------------*/

export const DISPATCH_HISTORY_COMMAND = 'dispatch.history';

export type HistoryScope = 'workspace' | 'project' | 'all';
export type HistorySort = 'updated' | 'created';

export interface IHistoryResume {
	readonly ok: boolean;
	/** Typed into a terminal in `cwd`: the agent's own resume line. */
	readonly command?: string;
	readonly cwd?: string;
	/** Why it cannot be continued here, in plain words. */
	readonly why?: string;
}

export interface IHistorySession {
	readonly key: string;
	readonly agent: string;
	readonly agent_name: string;
	readonly icon: string;
	readonly session_id: string;
	readonly title: string;
	readonly preview: { readonly role: 'user' | 'agent'; readonly text: string } | null;
	/** A search that matched what the person typed: the line it is in. */
	readonly snippet?: string;
	readonly matches?: 'title' | 'details' | 'text';
	readonly first_prompt: string;
	readonly messages: number;
	readonly subagents: number;
	readonly last_at: number;
	readonly created_at: number;
	readonly model: string;
	readonly cwd: string;
	readonly folder_exists: boolean;
	readonly project: string;
	readonly project_root: string;
	readonly branch: string;
	readonly resume: IHistoryResume;
	/** The Agents window already lists it: its provider and the window's id for it. */
	readonly window: { readonly provider: string; readonly id: string } | null;
	/** "local", or the id of the other Mac it is on. */
	readonly host: string;
}

export interface IHistoryGroup {
	readonly project: string;
	readonly root: string;
	readonly count: number;
	readonly sessions: readonly IHistorySession[];
}

export interface IHistoryAnswer {
	readonly ok: boolean;
	readonly error?: string;
	/** Another Mac is still being asked (its answer takes longer than the first wait): ask again soon. */
	readonly pending?: boolean;
	readonly scope?: HistoryScope;
	readonly project?: { readonly root: string; readonly name: string };
	readonly total?: number;
	readonly matched?: number;
	readonly shown?: number;
	readonly agents?: readonly { readonly id: string; readonly name: string; readonly icon: string; readonly count: number }[];
	readonly refreshing?: boolean;
	readonly indexing?: { readonly done: number; readonly total: number } | null;
	readonly groups?: readonly IHistoryGroup[];
	readonly machine?: string;
	readonly machines?: readonly { readonly id: string; readonly name: string; readonly local: boolean }[];
}

export interface IHistoryRequest {
	readonly scope: HistoryScope;
	readonly folder?: string;
	readonly query?: string;
	readonly agents?: readonly string[];
	readonly sort: HistorySort;
	readonly limit: number;
	readonly showEmpty?: boolean;
	readonly machine?: string;
}

export const PAGE = 80;

/** The agent marks the window has (codicon's own, or Dispatch's icon font); anything else is a plain terminal mark. */
const KNOWN_ICONS = new Set(['claude', 'openai', 'dispatch-opencode', 'google-gemini', 'copilot', 'terminal']);

export function agentIconId(icon: string | undefined): string {
	return icon && KNOWN_ICONS.has(icon) ? icon : 'terminal';
}

/** The request as a key: the cache and the in-flight check use it. */
export function requestKey(req: IHistoryRequest): string {
	return JSON.stringify([req.scope, req.folder ?? '', req.query ?? '', [...(req.agents ?? [])].sort(), req.sort, req.limit, !!req.showEmpty, req.machine ?? 'local']);
}

/** "3,602" and "1 message" / "12 messages". */
export function countLabel(n: number, one: string, many: string): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The terminal session's name for a continued session: its title, short. */
export function continueName(s: Pick<IHistorySession, 'title' | 'agent_name'>): string {
	const t = (s.title || s.agent_name || 'Session').trim();
	return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/** How long ago, in the words the other tabs use (now, 5m, 3h, 2d), weeks and months for older ones. */
export function historyAgo(at: number, now = Date.now() / 1000): string {
	if (!at) {
		return '';
	}
	const s = Math.max(0, Math.round(now - at));
	if (s < 60) {
		return 'now';
	}
	if (s < 3600) {
		return `${Math.floor(s / 60)}m`;
	}
	if (s < 86400) {
		return `${Math.floor(s / 3600)}h`;
	}
	if (s < 14 * 86400) {
		return `${Math.floor(s / 86400)}d`;
	}
	if (s < 60 * 86400) {
		return `${Math.floor(s / (7 * 86400))}w`;
	}
	return `${Math.floor(s / (30 * 86400))}mo`;
}

/** The scope a tab opens with: what it was last time, or the project when the session on screen has a folder. */
export function initialScope(saved: string | undefined, hasFolder: boolean): HistoryScope {
	if (saved === 'workspace' || saved === 'project' || saved === 'all') {
		return hasFolder || saved === 'all' ? saved : 'all';
	}
	return hasFolder ? 'project' : 'all';
}

/** A model as people say it: claude-opus-5-5 is Opus 5.5; others stay as the agent names them. */
export function modelLabel(model: string): string {
	const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(model);
	return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model;
}
