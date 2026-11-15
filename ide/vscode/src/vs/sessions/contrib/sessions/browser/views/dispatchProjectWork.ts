/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what works for a project right now, under the project in the sessions list (kanban task-y3z2s,
 *  「我希望在看板这里能看到正在运行 并且想在kanban哪里看到正在运行的会话」).
 *
 *  A sub-agent runs in the folder of the session that sent it out: a chat's (no project), Dispatch's own folder or
 *  another project's. The CLI says which project each one works for (`dispatch projects-view
 *  --json` with the sidebar flag, `subagents`: the project of the task it claimed, else the folder its own tool calls
 *  name), by the tool call that sent it out. While such a sub-agent works for another project than its session's, its
 *  row (the sub-agent row of browser/dispatchSubAgentRows.ts, unchanged: breathing block, what it was sent to do,
 *  model, time) sits first under that project instead of under its session; once it is back it returns to its
 *  session's finished ones. Its hover card adds the task it is on. A click opens it as from under its session.
 *
 *  sessionsList.ts turns it on for the grouping by project (`setProjectWorkRows`) and calls `insertProjectWorkRows`
 *  after it built the groups; browser/dispatchSubAgentRows.ts asks `subAgentRowWork.elsewhere` which to leave out.
 *--------------------------------------------------------------------------------------------*/

import { ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { IReader } from '../../../../../base/common/observable.js';
import { subAgentRowWork, subAgentsOf } from '../../../../browser/dispatchSubAgentRows.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { dispatchProjectsRegistry, dispatchSubAgentWork, IDispatchSubAgentWork, projectOfSession, refreshDispatchProjectsRegistry } from '../dispatchProjectsModel.js';

const SUBAGENT_FRAGMENT = 'subagent/';
/** Ask the CLI again this long after a working sub-agent it has not placed yet was first seen (it may not have named a folder yet). */
const ASK_AGAIN_MS = 20_000;

let enabled = false;

/** The list groups by project (rows can go under a project) or not (they stay under their session). */
export function setProjectWorkRows(on: boolean): void {
	enabled = on;
}

/** The tool call that sent a sub-agent out: the Agent Host's and a terminal's sub-agent chats both end their resource with it. */
function toolUseOf(chat: IChat): string | undefined {
	const fragment = chat.resource.fragment;
	const at = fragment.indexOf(SUBAGENT_FRAGMENT);
	return at >= 0 ? fragment.slice(at + SUBAGENT_FRAGMENT.length) || undefined : undefined;
}

function workOf(chat: IChat): IDispatchSubAgentWork | undefined {
	const id = toolUseOf(chat);
	return id ? dispatchSubAgentWork(id) : undefined;
}

function working(chat: IChat, reader?: IReader): boolean {
	const s = chat.status.read(reader);
	return s === SessionStatus.InProgress || s === SessionStatus.NeedsInput;
}

/** The project's label in the list, when the sub-agent works for another project than its session's. */
function elsewhereLabel(session: ISession, chat: IChat, reader?: IReader): string | undefined {
	if (!enabled) {
		return undefined;
	}
	const work = workOf(chat);
	const projects = dispatchProjectsRegistry.read(reader);
	const project = work && projects?.find(p => p.name === work.project && p.host === 'local' && !p.archived);
	if (!project || projectOfSession(session, projects)?.project.name === project.name) {
		return undefined;
	}
	return project.label || project.name;
}

subAgentRowWork.elsewhere = (session, chat, reader) => !!elsewhereLabel(session, chat, reader);
subAgentRowWork.notes = chat => {
	const title = workOf(chat)?.task_title;
	return title ? [`Working on: ${title}`] : [];
};

/** When each working sub-agent the CLI has not placed was last asked about. */
const asked = new Map<string, number>();

function askAbout(chat: IChat): void {
	const id = toolUseOf(chat);
	if (!id) {
		return;
	}
	const last = asked.get(id);
	// once when it is first seen, once more a little later (by then it has said where it works)
	if (last === undefined || (last > 0 && Date.now() - last > ASK_AGAIN_MS)) {
		asked.set(id, last === undefined ? Date.now() : 0);
		void refreshDispatchProjectsRegistry();
	}
}

interface ISectionLike {
	readonly id: string;
	readonly label: string;
	readonly sessions: readonly unknown[];
}

/**
 * Put each working sub-agent that works for another project than its session's first under that project in the list's
 * top-level `children` (sessionsList.ts, after it built them); a project without sessions in the list gets its group.
 * `row` makes the list's own chat row for it.
 */
export function insertProjectWorkRows<T extends { element: unknown }>(children: T[], sessions: readonly ISession[], row: (session: ISession, chat: IChat) => unknown): void {
	if (!enabled) {
		return;
	}
	const byLabel = new Map<string, { element: unknown }[]>();
	for (const session of sessions) {
		if (session.isArchived.get()) {
			continue;
		}
		for (const chat of subAgentsOf(session)) {
			if (!working(chat)) {
				continue;
			}
			const label = elsewhereLabel(session, chat);
			if (!label) {
				if (!workOf(chat)) {
					askAbout(chat);
				}
				continue;
			}
			let rows = byLabel.get(label);
			if (!rows) {
				rows = [];
				byLabel.set(label, rows);
			}
			rows.push({ element: row(session, chat) });
		}
	}
	for (const [label, rows] of byLabel) {
		const id = `workspace:${label}`;
		const folder = children.find(c => (c.element as ISectionLike).id === id) as (T & { children?: Iterable<unknown> }) | undefined;
		if (folder) {
			(folder as { children?: Iterable<unknown> }).children = [...rows, ...(folder.children ? [...folder.children] : [])];
			continue;
		}
		const group = { element: { id, label, sessions: [] } as ISectionLike, children: rows, collapsible: true, collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded };
		const firstFolder = children.findIndex(c => String((c.element as ISectionLike).id ?? '').startsWith('workspace:'));
		const archived = children.findIndex(c => (c.element as ISectionLike).id === 'archived');
		children.splice(firstFolder >= 0 ? firstFolder : archived >= 0 ? archived : children.length, 0, group as unknown as T);
	}
}
