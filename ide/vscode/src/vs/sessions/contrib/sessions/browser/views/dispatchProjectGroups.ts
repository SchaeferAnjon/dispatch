/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sessions list's folder groups are Dispatch's registered projects (130-session-rows.patch,
 *  kanban DECISIONS.md「项目」). sessionsList.ts regroups its workspace sections with groupByDispatchProject.
 *--------------------------------------------------------------------------------------------*/

import { ISession } from '../../../../services/sessions/common/session.js';
import { dispatchMachineOfSession } from '../../../dispatchRunOn/browser/dispatchRunOn.js';
import { dispatchSidebarSession, IDispatchProject, projectOfSession } from '../dispatchProjectsModel.js';
import type { ISessionSection } from './sessionsList.js';

/**
 * The folder sections regrouped by Dispatch's registered projects (dispatch projects):
 * one section per project, labelled with the project's label, a worktree's sessions under the
 * repository they belong to. Sessions in folders nobody registered are left out (`keep` still shows
 * the active one under its folder). Before the registry has loaded, the folder sections stay as they are.
 */
export function groupByDispatchProject(sections: readonly ISessionSection[], projects: readonly IDispatchProject[] | undefined, keep: (session: ISession) => boolean): ISessionSection[] {
	if (!projects) {
		return [...sections];
	}
	const workspaceSections = sections.filter(s => s.id.startsWith('workspace:'));
	const groups = new Map<string, ISession[]>();
	const worktreeGroups = new Map<string, ISessionSection>();
	for (const section of workspaceSections) {
		for (const session of section.sessions) {
			if (dispatchSidebarSession(session)?.hidden) {
				continue;
			}
			const match = projectOfSession(session, projects);
			// Run on: a session on another Mac is never one of this Mac's projects; it stays, under its folder
			const label = match?.project.label ?? (keep(session) || dispatchMachineOfSession(session) ? section.label : undefined);
			if (label === undefined) {
				continue;
			}
			let group = groups.get(label);
			if (!group) {
				group = [];
				groups.set(label, group);
			}
			group.push(session);
			const nested = match?.project.worktree_group;
			if (match?.worktree && nested) {
				let subgroup = worktreeGroups.get(label);
				if (!subgroup) {
					subgroup = { id: `workspace:${label}:${nested.id}`, label: nested.label, sessions: [], defaultCollapsed: nested.collapsed };
					worktreeGroups.set(label, subgroup);
				}
				subgroup.sessions.push(session);
			}
		}
	}
	// a project the person added shows from the start, before its first session
	for (const project of projects) {
		if (isKeptProject(project) && !groups.has(project.label)) {
			groups.set(project.label, []);
		}
	}
	const regrouped: ISessionSection[] = [...groups.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map(label => ({ id: `workspace:${label}`, label, sessions: groups.get(label)!, sections: worktreeGroups.has(label) ? [worktreeGroups.get(label)!] : [] }));
	const first = workspaceSections.length ? sections.indexOf(workspaceSections[0]) : sections.length;
	const rest = sections.filter(s => !s.id.startsWith('workspace:'));
	return [...rest.slice(0, first), ...regrouped, ...rest.slice(first)];
}

/** Added by the person (Add Project stars it), on this Mac and not archived. */
function isKeptProject(project: IDispatchProject): boolean {
	return project.starred && !project.archived && project.host === 'local';
}

/** The project sections that never fold into "+N more workspaces": the ones the person added. */
export function dispatchKeptProjectSectionIds(projects: readonly IDispatchProject[] | undefined): ReadonlySet<string> {
	return new Set((projects ?? []).filter(isKeptProject).map(project => `workspace:${project.label}`));
}
