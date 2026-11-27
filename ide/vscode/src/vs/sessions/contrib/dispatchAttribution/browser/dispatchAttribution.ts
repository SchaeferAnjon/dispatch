/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the record of who wrote which line (kanban app/cli/attribution.py, patches/340-attribution.patch).
 *
 *  This window marks every local session's turns as its status changes (TurnMarks), so any agent it runs is in
 *  the record, next to Claude Code's and Codex's hooks and OpenCode's plugin. The record feeds the rows under a reply
 *  (dispatchAttributionSteps.ts) and the note an agent's next turn gets about the lines you changed. Changes itself
 *  shows no marks: it is VS Code's as it is (the user, 2026-11-16).
 *
 *  Data: dispatch-bridge's dispatch.attributionMark runs `dispatch attribution mark --event --host-session --cwd`.
 *--------------------------------------------------------------------------------------------*/

import './dispatchAttributionSteps.js'; // the rows under a reply (patches/340-attribution.patch)
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { Schemas } from '../../../../base/common/network.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISession, isActiveSessionStatus, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const MARK_COMMAND = 'dispatch.attributionMark';
/** a turn that ended this recently when the window first sees the session is still marked as ended */
const RECENT_END_MS = 120_000;
/** a running session's folder must stay put this long before its turn moves there: while the session's own
 *  worktree appears, the workspace flips between the worktree and the project folder within milliseconds */
const SETTLE_MS = 1500;

// ---------------------------------------------------------------- the session's turns, for the record

/** What the window knows about one session's turn; it moves to the session that replaces it (a draft
 *  graduating into a committed session) so the turn's end is still recorded. */
interface ITurnState {
	open?: { key: string; folder: string };
	/** the session was seen working, whether or not its start could be marked */
	active: boolean;
	carried: boolean;
	/** the folder or id changed while the turn runs: the move waits until it settles */
	moving?: ReturnType<typeof setTimeout>;
}

/** Every local session's turn start and end, from its status: any agent the window runs is recorded. */
class TurnMarks extends Disposable {
	private readonly _watched = this._register(new DisposableMap<string>());
	private readonly _states = new Map<string, ITurnState>();
	private readonly _objects = new Map<string, ISession>();

	constructor(
		@ISessionsManagementService private readonly _sessions: ISessionsManagementService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._sessions.onDidChangeSessions(() => this.scan()));
		this._register(this._sessions.onDidReplaceSession(({ from, to }) => {
			const state = this._states.get(from.sessionId);
			this._log.info(`[dispatchAttribution] replaced ${from.sessionId} -> ${to.sessionId} carried=${!!state}`);
			if (state && from.sessionId !== to.sessionId) {
				state.carried = true;
				const next = this._states.get(to.sessionId);
				if (next) { // the replacement is watched already: its state takes the turn over
					next.open ??= state.open;
					next.active ||= state.active;
				} else {
					this._states.set(to.sessionId, { open: state.open, active: state.active, carried: false });
				}
			}
			this.scan();
		}));
		this._register(this._sessions.onWillSendRequest(session => this._log.trace(`[dispatchAttribution] will send ${session.sessionId} ${session.resource.toString()} status=${session.status.get()} folder=${sessionFolder(session.workspace.get()) ?? '-'} pending=${!!session.worktreePending?.get()}`)));
		this.scan();
		this._log.info(`[dispatchAttribution] turn marks on, ${this._watched.size} sessions`);
	}

	/** marks reach the record one after another, in the order the window took them */
	private _marks: Promise<unknown> = Promise.resolve();

	private mark(event: 'start' | 'end', key: string, folder: string): void {
		this._log.info(`[dispatchAttribution] ${event} ${key} ${folder}`);
		this._marks = this._marks.then(() => this._commands.executeCommand(MARK_COMMAND, event, key, folder)).catch(() => { /* no bridge: no record */ });
	}

	private scan(): void {
		const seen = new Set<string>();
		for (const session of [...this._sessions.getSessions(), ...this._sessions.getInFlightNewSessionRequests()]) {
			if (seen.has(session.sessionId) || session.isExternal?.get()) {
				continue;
			}
			seen.add(session.sessionId);
			if (this._objects.get(session.sessionId) !== session) {
				// new, or the provider replaced the object under the same id (a draft graduating): the turn's state stays
				this._log.trace(`[dispatchAttribution] watch ${session.sessionId} ${session.resource.toString()}`);
				this._objects.set(session.sessionId, session);
				this._watched.set(session.sessionId, this.watch(session));
			}
		}
		for (const id of [...this._watched.keys()]) {
			if (!seen.has(id)) {
				this._objects.delete(id);
				this._watched.deleteAndDispose(id);
			}
		}
	}

	private watch(session: ISession): IDisposable {
		const id = session.sessionId;
		let state = this._states.get(id);
		const first = !state;
		if (!state) {
			state = { active: false, carried: false };
			this._states.set(id, state);
		}
		const st = state;
		let seen = false;
		const store = new DisposableStore();
		store.add(autorun(reader => {
			const status = session.status.read(reader);
			const active = isActiveSessionStatus(status);
			const folder = sessionFolder(session.workspace.read(reader));
			const pending = !!session.worktreePending?.read(reader);
			const ended = session.lastTurnEnd.read(reader);
			const key = session.resource.toString();
			const firstRun = first && !seen;
			seen = true;
			this._log.trace(`[dispatchAttribution] ${id} ${key} status=${status} active=${active} folder=${folder ?? '-'} scheme=${session.workspace.get()?.folders[0]?.workingDirectory.scheme ?? '-'} pending=${pending} ended=${ended?.toISOString() ?? '-'} open=${st.open?.folder ?? '-'} first=${firstRun}`);
			if (status === SessionStatus.Untitled && !active) {
				return;
			}
			if (active) {
				st.active = true;
				if (pending || !folder) {
					return; // the session's own worktree comes first: its folder is the one the agent edits
				}
				if (st.open && st.open.folder === folder && st.open.key === key) {
					clearTimeout(st.moving); // back where the turn is: it was a flip, not a move
					st.moving = undefined;
					return;
				}
				if (!st.open) {
					st.open = { key, folder };
					this.mark('start', key, folder);
					return;
				}
				// the worktree appeared, or the session got its real id: the turn moves there once the
				// folder stays put (it flips back and forth for a moment while the worktree appears)
				clearTimeout(st.moving);
				st.moving = setTimeout(() => {
					st.moving = undefined;
					const nowFolder = sessionFolder(session.workspace.get());
					const nowKey = session.resource.toString();
					if (!st.open || !nowFolder || !isActiveSessionStatus(session.status.get()) || (st.open.folder === nowFolder && st.open.key === nowKey)) {
						return;
					}
					this.mark('end', st.open.key, st.open.folder);
					st.open = { key: nowKey, folder: nowFolder };
					this.mark('start', nowKey, nowFolder);
				}, SETTLE_MS);
				return;
			}
			const wasMoving = st.moving !== undefined;
			clearTimeout(st.moving);
			st.moving = undefined;
			if (st.open) {
				this.mark('end', st.open.key, st.open.folder);
				if (wasMoving && folder && folder !== st.open.folder) {
					this.mark('end', key, folder); // it ended before its move settled: the new folder hears of it too
				}
			} else if (folder && (st.active || (firstRun && ended && Date.now() - ended.getTime() < RECENT_END_MS))) {
				// a turn whose start the window could not mark (it ran before its worktree was known, or
				// before the window saw the session): its end still counts
				this.mark('end', key, folder);
			}
			st.open = undefined;
			st.active = false;
		}));
		store.add(toDisposable(() => {
			clearTimeout(st.moving); // a pending move belongs to this object: the next watch decides again
			st.moving = undefined;
			// replaced (the state moved on) or gone; wait a moment, the replacement may still be announced
			setTimeout(() => {
				if (this._watched.has(id) && this._states.get(id) === st) {
					return; // the same session goes on under a new object
				}
				if (!st.carried && st.open) {
					this.mark('end', st.open.key, st.open.folder);
				}
				if (this._states.get(id) === st && !this._watched.has(id)) {
					this._states.delete(id);
				}
			}, 3000);
		}));
		return store;
	}
}

/** The folder the agent edits: the session's own worktree when it has one. */
function sessionFolder(workspace: ISession['workspace'] extends IObservable<infer W> ? W : never): string | undefined {
	const f = workspace?.folders[0];
	const uri = f?.gitRepository?.workTreeUri ?? f?.workingDirectory;
	return uri && uri.scheme === Schemas.file ? uri.fsPath : undefined;
}

// ---------------------------------------------------------------- the contribution

class DispatchAttributionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchAttribution';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(instantiationService.createInstance(TurnMarks));
	}
}

registerWorkbenchContribution2(DispatchAttributionContribution.ID, DispatchAttributionContribution, WorkbenchPhase.AfterRestored);
