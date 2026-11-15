/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: who wrote each changed line, the agent or you (patches/340-attribution.patch).
 *
 *  Direction B, "only what you touched": the agent's lines are the default and carry no mark. In the
 *  Agents window's diffs (the Changes editor and the single-file diffs it opens) a line you changed gets
 *  a small person block in the glyph margin, a line the agent wrote and you then changed gets the person
 *  block with the agent's star, and a line nobody can vouch for gets a dashed block: one no agent of Dispatch's
 *  wrote and no Dispatch editor saw typed (a tool, a script, git) included, never the person. Hovering one says
 *  who and when (and what the agent had written). A grey line above each diff says what a line without
 *  a mark means. In the Changes file list a file you changed lines in ends with the person block; the
 *  A / M / D letter goes into the hover of the line counts.
 *
 *  Data: dispatch-bridge's dispatch.attributionShow / dispatch.attributionFiles run the CLI
 *  (`dispatch attribution show|files`, kanban app/cli/attribution.py). The record comes from marks the
 *  CLI takes when an agent's turn starts and ends: Claude Code's and Codex's hooks, OpenCode's plugin,
 *  and this window, which marks every local session's turns as its status changes (TurnMarks), so any
 *  agent the window runs is covered.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchAttribution.css';
import './dispatchAttributionSteps.js'; // the chat's rows and Changes' All / Turn 1 / You (patches/340-attribution.patch)
import * as dom from '../../../../base/browser/dom.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDiffEditor, ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { GlyphMarginLane, IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISession, isActiveSessionStatus, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { AttributionMark, changeWords, hintText, hoverOf, IAttributionCounts, IAttributionFile, IAttributionRun, marksForLines, parseAttributionFile, parseAttributionFiles, rowMark } from './dispatchAttributionModel.js';

const SHOW_COMMAND = 'dispatch.attributionShow';
const FILES_COMMAND = 'dispatch.attributionFiles';
const MARK_COMMAND = 'dispatch.attributionMark';
/** the record changed: a save of yours (workbench/contrib/dispatchEditorEdits, with its path) or a turn's mark (every
 *  file); the diffs ask for their marks again */
const RECORDED_COMMAND = 'dispatch.attributionRecorded';
const TOLD_LATER_MS = 12_000;
/** answers this fresh are reused: several diffs and rows ask for the same file at once */
const FRESH_MS = 1500;
const HINT_HEIGHT = 24;
/** a narrow diff (the side pane) wraps the grey line onto a second line rather than cutting off the agent's name */
const HINT_TWO_LINES = 40;
/** a turn that ended this recently when the window first sees the session is still marked as ended */
const RECENT_END_MS = 120_000;
/** a running session's folder must stay put this long before its turn moves there: while the session's own
 *  worktree appears, the workspace flips between the worktree and the project folder within milliseconds */
const SETTLE_MS = 1500;

// ---------------------------------------------------------------- the CLI's answers, shared and short-lived

class AttributionSource {
	private readonly _files = new Map<string, { at: number; answer: Promise<IAttributionFile | undefined> }>();
	private readonly _counts = new Map<string, { at: number; answer: Promise<IAttributionCounts | undefined> }>();
	private _batch: { paths: Set<string>; done: Promise<Map<string, IAttributionCounts>> } | undefined;

	constructor(private readonly _commands: ICommandService, private readonly _log: ILogService) { }

	forget(path: string | undefined): void {
		if (path === undefined) {
			this._files.clear();
			this._counts.clear();
			return;
		}
		this._files.delete(path);
		this._counts.delete(path);
	}

	file(path: string): Promise<IAttributionFile | undefined> {
		const hit = this._files.get(path);
		if (hit && Date.now() - hit.at < FRESH_MS) {
			return hit.answer;
		}
		const answer = this._commands.executeCommand<unknown>(SHOW_COMMAND, path)
			.then(parseAttributionFile, e => { this._log.trace(`[dispatchAttribution] show ${path}: ${e}`); return undefined; });
		this._files.set(path, { at: Date.now(), answer });
		return answer;
	}

	/** Counts per file, asked in one batch for all the rows that render together. */
	counts(path: string): Promise<IAttributionCounts | undefined> {
		const hit = this._counts.get(path);
		if (hit && Date.now() - hit.at < FRESH_MS) {
			return hit.answer;
		}
		if (!this._batch) {
			const paths = new Set<string>();
			const done = new Promise<void>(resolve => setTimeout(resolve, 40)).then(() => {
				this._batch = undefined;
				return this._commands.executeCommand<unknown>(FILES_COMMAND, [...paths]).then(parseAttributionFiles, () => new Map<string, IAttributionCounts>());
			});
			this._batch = { paths, done };
		}
		const batch = this._batch;
		batch.paths.add(path);
		const answer = batch.done.then(m => m.get(path));
		this._counts.set(path, { at: Date.now(), answer });
		return answer;
	}
}

let source: AttributionSource | undefined;

// ---------------------------------------------------------------- marks in a diff

function hoverMarkdown(run: IAttributionRun): MarkdownString | undefined {
	const h = hoverOf(run);
	if (!h) {
		return undefined;
	}
	const md = new MarkdownString().appendMarkdown('**').appendText(h.title).appendMarkdown('**');
	if (h.was !== undefined) {
		md.appendMarkdown('\n\n').appendText(run.agent ? localize('dispatchAttribution.wrote', "{0} wrote:", run.agent) : localize('dispatchAttribution.itWas', "It was:")).appendCodeblock('', h.was || ' ');
	}
	for (const line of h.lines) {
		md.appendMarkdown('\n\n').appendText(line);
	}
	return md;
}

/** One diff editor: marks on the modified side's changed lines and the grey line above it. */
class DiffMarks extends Disposable {
	private readonly _refresh = this._register(new RunOnceScheduler(() => this.refresh(), 250));
	private _decorations: IEditorDecorationsCollection | undefined;
	private _zones: { editor: ICodeEditor; id: string }[] = [];
	private _generation = 0;
	private _glyphForced = false;
	private _hintText: string | undefined;
	private _hintSideBySide = false;
	private _hintLines = 1;
	/** what the marks drawn now say: asked again with the same answer, they are left alone (no animation again) */
	private _drawn: string | undefined;

	constructor(private readonly _diff: IDiffEditor, private readonly _source: AttributionSource) {
		super();
		this._register(_diff.onDidUpdateDiff(() => this._refresh.schedule()));
		this._register(_diff.getModifiedEditor().onDidLayoutChange(() => this._refresh.schedule()));
		this._register(_diff.onDidChangeModel(() => { this.clear(); this._refresh.schedule(); }));
		this._register(toDisposable(() => this.clear()));
		this._refresh.schedule();
	}

	/** the record of this file (undefined: of any file) changed: ask again */
	again(path: string | undefined): void {
		if (path === undefined || this.modifiedPath() === path) {
			this._refresh.schedule();
		}
	}

	private modifiedPath(): string | undefined {
		const uri: URI | undefined = this._diff.getModel()?.modified.uri;
		return uri && uri.scheme === Schemas.file ? uri.fsPath : undefined;
	}

	private clear(): void {
		this._generation++;
		this._decorations?.clear();
		for (const z of this._zones) {
			z.editor.changeViewZones(a => a.removeZone(z.id));
		}
		this._zones = [];
		this._hintText = undefined;
		this._drawn = undefined;
	}

	private async refresh(): Promise<void> {
		const path = this.modifiedPath();
		const changes = this._diff.getLineChanges();
		if (!path || !changes) {
			this.clear();
			return;
		}
		const generation = ++this._generation;
		const file = await this._source.file(path);
		if (generation !== this._generation || this._store.isDisposed || this.modifiedPath() !== path) {
			return;
		}
		const changed = changes.filter(c => c.modifiedEndLineNumber > 0).map(c => ({ start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber }));
		const marked = file ? marksForLines(file, changed) : new Map<number, IAttributionRun>();
		const modified = this._diff.getModifiedEditor();
		const drawn = JSON.stringify([...marked].map(([line, run]) => [line, markClass(run), hoverMarkdown(run)?.value]));
		if (drawn === this._drawn && this._decorations) {
			this.hint(file && changed.length ? hintText(file) : undefined, modified);
			return;
		}
		this._drawn = drawn;
		const decorations: IModelDeltaDecoration[] = [];
		for (const [line, run] of marked) {
			decorations.push({
				range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
				options: {
					description: 'dispatch-attribution',
					glyphMarginClassName: `dispatch-attr-mark dispatch-attr-${markClass(run)}`,
					glyphMarginHoverMessage: hoverMarkdown(run),
					glyphMargin: { position: GlyphMarginLane.Left },
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			});
		}
		if (decorations.length && !modified.getOption(EditorOption.glyphMargin)) {
			modified.updateOptions({ glyphMargin: true });
			this._glyphForced = true;
		} else if (!decorations.length && this._glyphForced) {
			modified.updateOptions({ glyphMargin: false });
			this._glyphForced = false;
		}
		if (!this._decorations) {
			this._decorations = modified.createDecorationsCollection(decorations);
		} else {
			this._decorations.set(decorations);
		}
		this.hint(file && changed.length ? hintText(file) : undefined, modified);
	}

	private hint(text: string | undefined, modified: ICodeEditor): void {
		const sideBySide = this._diff.renderSideBySide;
		const lines = text && hintWidth(text, modified) > modified.getLayoutInfo().contentWidth - 8 ? 2 : 1;
		if (text === this._hintText && sideBySide === this._hintSideBySide && lines === this._hintLines && this._zones.some(z => z.editor === modified)) {
			return;
		}
		this._hintText = text;
		this._hintSideBySide = sideBySide;
		this._hintLines = lines;
		for (const z of this._zones) {
			z.editor.changeViewZones(a => a.removeZone(z.id));
		}
		this._zones = [];
		if (!text) {
			return;
		}
		const editors = sideBySide ? [this._diff.getOriginalEditor(), modified] : [modified];
		for (const editor of editors) {
			const domNode = dom.$('.dispatch-attr-hint');
			if (editor === modified) {
				domNode.textContent = text;
				domNode.setAttribute('aria-label', text);
			}
			editor.changeViewZones(a => {
				domNode.classList.toggle('two-lines', lines === 2);
				const id = a.addZone({ afterLineNumber: 0, heightInPx: lines === 2 ? HINT_TWO_LINES : HINT_HEIGHT, domNode, suppressMouseDown: true });
				this._zones.push({ editor, id });
			});
		}
	}
}

let measure: CanvasRenderingContext2D | null | undefined;
/** How wide the grey line is in the editor's window (12px, the workbench font). */
function hintWidth(text: string, editor: ICodeEditor): number {
	const node = editor.getDomNode();
	measure ??= node?.ownerDocument.createElement('canvas').getContext('2d');
	if (!measure || !node) {
		return text.length * 6.5;
	}
	const family = node.ownerDocument.defaultView?.getComputedStyle(node.ownerDocument.body).fontFamily || 'sans-serif';
	measure.font = `12px ${family}`;
	return measure.measureText(text).width + 4;
}

function markClass(run: IAttributionRun): string {
	const mark: AttributionMark = run.who === 'mix' ? 'mix' : run.who === 'you' ? 'you' : run.who === 'other' ? 'other' : 'unsure';
	return mark === 'mix' && run.agent && run.agent !== 'Claude' ? 'mix dispatch-attr-generic' : mark;
}

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

	/** once more a while after a turn starts: the agent's own hook or plugin marks it too as it passes the note about
	 *  your lines on, and your lines' hovers then say who was told */
	private readonly _askAgain = this._register(new RunOnceScheduler(() => this.recorded(), TOLD_LATER_MS));

	private mark(event: 'start' | 'end', key: string, folder: string): void {
		this._log.info(`[dispatchAttribution] ${event} ${key} ${folder}`);
		this._marks = this._marks.then(() => this._commands.executeCommand(MARK_COMMAND, event, key, folder)).then(() => {
			this.recorded();
			if (event === 'start') {
				this._askAgain.schedule();
			}
		}).catch(() => { /* no bridge: no record */ });
	}

	private recorded(): void {
		this._commands.executeCommand(RECORDED_COMMAND).catch(() => { /* the diffs are gone */ });
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

// ---------------------------------------------------------------- the Changes file list

/**
 * Hook for the Changes list's file rows (changesViewRenderer.ts): hides the A / M / D letter and says it
 * in the hover of the line counts instead, and ends the row with the person block when you changed lines
 * in the file.
 */
export class DispatchAttributionRows {
	private static _instance: DispatchAttributionRows | undefined;

	static get(instantiationService: IInstantiationService): DispatchAttributionRows {
		return this._instance ??= instantiationService.invokeFunction(accessor => new DispatchAttributionRows(
			accessor.get(IHoverService), accessor.get(ICommandService), accessor.get(ILogService)));
	}

	private readonly _source: AttributionSource;
	/** the rows on screen by file, to ask again when the record changes */
	private readonly _shown = new Map<string, Set<() => void>>();

	private constructor(private readonly _hover: IHoverService, commands: ICommandService, log: ILogService) {
		this._source = source ??= new AttributionSource(commands, log);
	}

	/** the record of a file (undefined: of any) changed: its rows ask again */
	again(path: string | undefined): void {
		for (const [p, fills] of this._shown) {
			if (path === undefined || p === path) {
				fills.forEach(fill => fill());
			}
		}
	}

	static again(path: string | undefined): void {
		this._instance?.again(path);
	}

	render(file: { uri: URI; changeType: string; linesAdded: number; linesRemoved: number }, letter: HTMLElement, lineCounts: HTMLElement, store: DisposableStore): void {
		letter.classList.add('dispatch-attr-letter');
		const changed = file.changeType !== 'none';
		if (changed) {
			const words = changeWords(file.changeType, file.linesAdded, file.linesRemoved);
			store.add(this._hover.setupDelayedHover(lineCounts, { content: words, style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
		}
		let chip = letter.nextElementSibling as HTMLElement | null;
		if (!chip?.classList.contains('dispatch-attr-row')) {
			chip = dom.$('span.dispatch-attr-row.dispatch-attr-chip.dispatch-attr-you');
			letter.after(chip);
		}
		const el = chip;
		el.hidden = true;
		el.removeAttribute('aria-label');
		if (!changed || file.uri.scheme !== Schemas.file) {
			return;
		}
		const path = file.uri.fsPath;
		let live = true;
		const hover = store.add(new DisposableStore());
		const fill = () => this._source.counts(path).then(c => {
			if (!live) {
				return;
			}
			const m = rowMark(c);
			hover.clear();
			el.hidden = !m;
			if (!m) {
				el.removeAttribute('aria-label');
				return;
			}
			el.setAttribute('role', 'img');
			el.setAttribute('aria-label', m.tip);
			hover.add(this._hover.setupDelayedHover(el, { content: m.tip, style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
		});
		const fills = this._shown.get(path) ?? new Set<() => void>();
		this._shown.set(path, fills.add(fill));
		store.add(toDisposable(() => {
			live = false;
			fills.delete(fill);
			if (!fills.size && this._shown.get(path) === fills) {
				this._shown.delete(path);
			}
		}));
		fill();
	}
}

// ---------------------------------------------------------------- the contribution

class DispatchAttributionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchAttribution';

	private readonly _diffs = this._register(new DisposableMap<IDiffEditor, DiffMarks>());

	constructor(
		@ICodeEditorService codeEditors: ICodeEditorService,
		@ICommandService commands: ICommandService,
		@ILogService log: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const src = source ??= new AttributionSource(commands, log);
		const add = (diff: IDiffEditor) => {
			if (!this._diffs.has(diff)) {
				this._diffs.set(diff, new DiffMarks(diff, src));
			}
		};
		codeEditors.listDiffEditors().forEach(add);
		this._register(codeEditors.onDiffEditorAdd(add));
		this._register(codeEditors.onDiffEditorRemove(diff => this._diffs.deleteAndDispose(diff)));
		this._register(instantiationService.createInstance(TurnMarks));
		// a save of yours lands in the record a moment after the diff has asked about the saved file, and a turn's mark
		// changes what your lines' hovers say: ask again then
		this._register(CommandsRegistry.registerCommand(RECORDED_COMMAND, (_accessor, path: unknown) => {
			const which = typeof path === 'string' ? path : undefined;
			src.forget(which);
			for (const [, marks] of this._diffs) {
				marks.again(which);
			}
			DispatchAttributionRows.again(which);
		}));
	}
}

registerWorkbenchContribution2(DispatchAttributionContribution.ID, DispatchAttributionContribution, WorkbenchPhase.AfterRestored);
