/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the registered projects (kanban design/task-model/DECISIONS.md「项目」).
 *
 *  `dispatch projects --json` (dispatch-bridge's `dispatch.projects`) lists the projects Dispatch
 *  knows: name, label, folder, Mac. The sessions list groups by them (sessionsList.ts): one group per
 *  project named by its label, a worktree's session under its repository with a "worktree" tag, and
 *  sessions in folders nobody registered (temporary folders, scratch checkouts) left out. Until the
 *  bridge has answered, the list keeps VS Code's own folder groups.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchProjectsList.css';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { isDispatchWindowIdle, onDidChangeDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { throttleLeadingTrailing } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdleModel.js';
import { dispatchBoardLive, onDidChangeDispatchBoard } from '../../dispatchBoard/browser/dispatchBoard.js';

export interface IDispatchProject {
	readonly name: string;
	/** What the person calls it (the alias set in Dispatch, else the name). */
	readonly label: string;
	readonly starred: boolean;
	readonly archived: boolean;
	/** The repository folder ('' when none is known); another Mac's path for a project there. */
	readonly dir: string;
	/** `local`, or the hosts.json id of the Mac it lives on. */
	readonly host: string;
	readonly host_name: string;
	/** "this Mac", "mini", … */
	readonly machine: string;
	readonly git: boolean;
	readonly worktree_group?: { readonly id: string; readonly label: string; readonly collapsed: boolean };
}

export interface IDispatchSidebarSession {
	readonly project: string;
	readonly worktree: boolean;
	readonly hidden: boolean;
	readonly one_shot: boolean;
}

let sidebarSessions: Readonly<Record<string, IDispatchSidebarSession>> = {};

/** Visibility and grouping are CLI decisions. Search still reads the complete host catalog. */
export function dispatchSidebarSession(session: ISession): IDispatchSidebarSession | undefined {
	const provider = session.resource.scheme.replace(/^(?:vscode-)?agent-host-/, '');
	const id = session.resource.path.split('/').filter(Boolean).at(-1);
	return sidebarSessions[`${provider}:${id}`];
}

const registry = observableValue<readonly IDispatchProject[] | undefined>('dispatchProjectsRegistry', undefined);
export const dispatchProjectsRegistry: IObservable<readonly IDispatchProject[] | undefined> = registry;

export function setDispatchProjectsRegistry(value: readonly IDispatchProject[] | undefined, sessions: Readonly<Record<string, IDispatchSidebarSession>> = {}): void {
	sidebarSessions = sessions;
	registry.set(value, undefined);
}

export interface IDispatchSessionProject {
	readonly project: IDispatchProject;
	/** The session works in a git worktree of the project's repository. */
	readonly worktree: boolean;
}

function trimSlash(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** macOS: /tmp, /var and /etc are /private/tmp, … An engine records the real path, the registry the given one. */
function canonical(p: string): string {
	return trimSlash(p).replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
}

/** Where a project's worktrees live, besides inside its folder (`.claude/worktrees/…`). */
function worktreeHomes(dir: string): string[] {
	return [`${dir}.worktrees/`, `${dir}-wt/`];
}

function isUnder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir + '/');
}

/**
 * The registered project a session belongs to, by its folders: its repository, its worktree, its
 * working directory. A local project matches by path; the longest folder wins.
 */
export function projectOfSession(session: ISession, projects: readonly IDispatchProject[] | undefined): IDispatchSessionProject | undefined {
	if (!projects?.length) {
		return undefined;
	}
	const policy = dispatchSidebarSession(session);
	const known = policy && projects.find(p => p.name === policy.project && p.host === 'local');
	if (known) {
		return { project: known, worktree: policy.worktree };
	}
	const folder = session.workspace.get()?.folders[0];
	if (!folder) {
		return undefined;
	}
	const paths: string[] = [];
	const add = (uri: URI | undefined) => {
		if (uri && uri.scheme === 'file') {
			paths.push(canonical(uri.fsPath));
		}
	};
	add(folder.gitRepository?.uri);
	add(folder.root);
	add(folder.gitRepository?.workTreeUri);
	add(folder.workingDirectory);
	const workTree = folder.gitRepository?.workTreeUri;
	const workTreePath = workTree && workTree.scheme === 'file' ? canonical(workTree.fsPath) : undefined;
	let best: IDispatchSessionProject | undefined;
	let bestLength = -1;
	for (const project of projects) {
		if (!project.dir || project.host !== 'local') {
			continue;
		}
		const dir = canonical(project.dir);
		for (const path of paths) {
			const inside = isUnder(path, dir);
			const beside = worktreeHomes(dir).some(home => path.startsWith(home));
			if ((inside || beside) && dir.length > bestLength) {
				const worktree = beside
					|| (!!workTreePath && workTreePath !== dir)
					|| paths.some(p => p.startsWith(dir + '/.claude/worktrees/') || worktreeHomes(dir).some(home => p.startsWith(home)));
				best = { project, worktree };
				bestLength = dir.length;
			}
		}
	}
	return best;
}

// ---- the registry poller ----------------------------------------------------------------------

const POLL_MS = 60_000;
let refreshNow: () => Promise<void> = async () => { };

/** Ask again now (after a project was added). */
export function refreshDispatchProjectsRegistry(): Promise<void> {
	return refreshNow();
}

class DispatchProjectsRegistryPoller extends Disposable {
	static readonly ID = 'dispatch.contrib.projectsRegistry';
	private running: Promise<void> | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		refreshNow = () => this.refresh();
		// the registry is on the board: its changes are pushed (dispatchBoard.ts), the timer only while they are not
		// (the sidebar's rows and counts, not an answer someone waits on: a refresh at most every 15 s while Agents write the board)
		const onBoard = throttleLeadingTrailing({ now: () => Date.now(), setTimeout: (fn, ms) => mainWindow.setTimeout(fn, ms), clearTimeout: h => mainWindow.clearTimeout(h as number) }, () => void (this.running ?? Promise.resolve()).then(() => this.refresh()), 15000);
		this._register(toDisposable(() => onBoard.cancel()));
		this._register(onDidChangeDispatchBoard(() => { if (!isDispatchWindowIdle()) { onBoard.call(); } }));
		this._register(onDidChangeDispatchWindowIdle(idle => { if (!idle) { void this.refresh(); } }));
		const timer = mainWindow.setInterval(() => {
			if (!dispatchBoardLive() && mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle()) {
				void this.refresh();
			}
		}, POLL_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));
		this._register(DOM.addDisposableListener(mainWindow.document, 'visibilitychange', () => {
			if (mainWindow.document.visibilityState === 'visible') {
				void this.refresh();
			}
		}));
		// the bridge activates after the window: first ask a moment later, then again in case it was not up yet
		for (const ms of [1500, 6000]) {
			const t = mainWindow.setTimeout(() => void this.refresh(), ms);
			this._register(toDisposable(() => mainWindow.clearTimeout(t)));
		}
	}

	refresh(): Promise<void> {
		this.running ??= (async () => {
			try {
				const answer = await this.commandService.executeCommand<{ projects?: IDispatchProject[]; sessions?: Record<string, IDispatchSidebarSession> }>('dispatch.projects', 'sidebar');
				if (answer && Array.isArray(answer.projects)) {
					const rows = answer.projects.filter(r => r && typeof r.name === 'string');
					const sessions = answer.sessions ?? {};
					const before = registry.get();
					if (!before || JSON.stringify(before) !== JSON.stringify(rows) || JSON.stringify(sidebarSessions) !== JSON.stringify(sessions)) {
						setDispatchProjectsRegistry(rows, sessions);
					}
				}
			} catch (e) {
				// no bridge (yet), or the CLI failed: keep what the list shows
				this.logService.trace(`[DispatchProjects] ${e}`);
			} finally {
				this.running = undefined;
			}
		})();
		return this.running;
	}
}

registerWorkbenchContribution2(DispatchProjectsRegistryPoller.ID, DispatchProjectsRegistryPoller, WorkbenchPhase.AfterRestored);
