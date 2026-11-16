/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Walk me through (direction B「Talk while new」 frames 5 and 6, user 2026-11-15, task-fktjx, kanban
 *  design/learn-scene; the person: "我之前用终端时它生成的文件我从来不看，这种黑箱子让人不安心"). The second part of
 *  learning while the agent works:
 *
 *  - A turn of the session on screen ends (it was running and stopped) and changed files: under Talk the pill
 *    "Walk me through · 4 stops" comes in the side pane's corner, never takes the keyboard, stays until it is used or
 *    sent away and goes when the next turn begins. Under Quiet no pill; the Now tab's head and the side chat card's ⋯
 *    offer the same walk either way (IDispatchWalkService).
 *  - The walk goes stop by stop through the turn's changes, as the Changes tab has them (its "turn" changeset, else
 *    the conversation's last-turn changes, the same list): each stop opens its file in the editor, scrolls to the lines
 *    and lights them, and the card in the corner says which stop of how many, the file and one sentence (Back, Next,
 *    Done; ← → Esc). Ask about this asks about those lines in the side chat card, or quotes them into the
 *    conversation's input where side chats are not there (OpenCode).
 *  - The sentence: a new file's own first comment, else the sentence the agent wrote right before it changed the file
 *    (dispatchLearnModel's ways); the stops left get theirs from one call to the session's own agent and model for the
 *    whole turn (`dispatch write walk`, headless, nothing left in the conversation), asked when the walk first starts;
 *    without an answer a stop says only its lines.
 *  The stops, their order and what they say are dispatchWalkModel.ts; the pill and the card are dispatchWalkCard.ts.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { autorun, IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { CursorColumns } from '../../../../editor/common/core/cursorColumns.js';
import { Range } from '../../../../editor/common/core/range.js';
import { DefaultLinesDiffComputer } from '../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { IEditorDecorationsCollection, ScrollType } from '../../../../editor/common/editorCommon.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IChatModel, IChatProgressResponseContent, IChatRequestModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionFileChange, SessionStatus, TURN_CHANGES_CHANGESET_ID } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { VIEW_SESSION_CHANGES_COMMAND_ID } from '../../changes/common/changes.js';
import { IChangesViewService } from '../../changes/common/changesViewService.js';
import { whenChatWidgetForSession } from '../../chat/browser/chatWidgetUtils.js';
import { writerOf } from '../../dispatchFixit/browser/dispatchFixitWriter.js';
import { addQuoteToWidget, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { DISPATCH_SIDE_CHAT_ASK_COMMAND, ISideChatAsk } from '../../dispatchSideChat/browser/dispatchSideChatAsk.js';
import { IDispatchSideChatService } from '../../dispatchSideChat/browser/dispatchSideChatService.js';
import { cardBox, cornerFloor, pillOffset } from '../../dispatchSideChat/common/dispatchSideChatModel.js';
import { filesInMessage, headerComment, LEARN_MODE_SETTING, learnMode, lastSentence, why, WRITE_TOOLS } from '../common/dispatchLearnModel.js';
import { asSentence, assignSaid, hunkOf, IWalkFile, IWalkHunk, IWalkStop, linesSentence, stopCode, stopLines, stopTag, walkStops, WalkSource } from '../common/dispatchWalkModel.js';
import { localPath, localRoots } from './dispatchLearnTurn.js';
import { DispatchWalkCard, DispatchWalkPill, IWalkCardStop } from './dispatchWalkCard.js';
import { DISPATCH_WALK_COMMAND, IDispatchWalkService, IWalkOfferState, IWhyAnswer, IWhyRequest } from './dispatchWalkService.js';
import { blockKey, blocksToAsk, IWhyBlock, knownFor, overlaps, WHY_NONE } from '../common/dispatchExplainModel.js';

/** A stop with what the window needs to show it. */
interface IStop extends IWalkStop {
	/** The file on this Mac, opened in the editor. */
	readonly uri: URI;
	/** Its lines now, for Ask about this. */
	readonly snippet: string;
	/** What the model is shown when nothing else says it. */
	readonly code: string;
	/** What is already said about it: the new file's first comment, the agent's own sentence. */
	readonly said?: { readonly text: string; readonly from: 'comment' | 'agent' };
	/** Where the first change is on its line (columns, 1-based): scrolled into view sideways too. */
	readonly focus?: { readonly line: number; readonly from: number; readonly to: number };
}

interface IPlan {
	readonly sessionId: string;
	/** The turn: its request's id. */
	readonly turn: string;
	readonly stops: readonly IStop[];
	readonly more: number;
	/** What the person asked in the turn (the model writes in its language). */
	readonly request: string;
	/** Where the changes came from: the Changes tab's turn changeset, or the conversation's last-turn changes. */
	readonly source: 'changes' | 'last-turn';
}

/** What the session's agent answered for a turn, by stop (`path:start-end`). */
interface IAnswer {
	state: 'asking' | 'done' | 'none';
	readonly texts: Map<string, string>;
	ms?: number;
	by?: string;
}

/** A file's lines now and before, as read for a walk or a Why. */
interface IFileText {
	readonly now: string[];
	readonly before: string[];
	readonly uri: URI;
}

/** A block of Changes the Why model call is told about. */
interface IWhyAsk extends IWhyBlock {
	readonly rel: string;
	readonly isNew: boolean;
	readonly code: string;
}

/** Per session: whether its turn runs, and whether the pill of the turn that just ended is up or was sent away. */
interface ITurnWatch {
	running: boolean;
	pill: boolean;
	dismissed: boolean;
}

const MAX_SNIPPET_LINES = 40;
/** A Why reads at most this many files of Changes to find the blocks it asks about together. */
const MAX_WHY_FILES = 40;
const REFRESH_MS = 400;

function text(m: string | IMarkdownString | undefined): string {
	return !m ? '' : typeof m === 'string' ? m : m.value;
}

function stopKey(s: Pick<IWalkStop, 'path' | 'start' | 'end'>): string {
	return `${s.path}:${s.start}-${s.end}`;
}

function isRunning(status: SessionStatus | undefined): boolean {
	return status === SessionStatus.InProgress || status === SessionStatus.NeedsInput;
}

/**
 * Whether the turn runs: the conversation's last reply is still being written (waiting for an approval included). The
 * session's own status is only asked while its conversation is not loaded: it says "done" for a moment now and then
 * around a turn, and the pill came and went with it.
 */
function turnRuns(model: IChatModel | undefined, status: SessionStatus | undefined, reader?: IReader): boolean {
	if (!model) {
		return isRunning(status);
	}
	const response = (reader ? model.lastRequestObs.read(reader) : model.lastRequest)?.response;
	return !!response && (reader ? response.isIncomplete.read(reader) : response.isIncomplete.get());
}

function toLocal(uri: URI): URI {
	return uri.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(uri) : uri;
}

export class DispatchWalkService extends Disposable implements IDispatchWalkService {
	declare readonly _serviceBrand: undefined;

	private readonly _offer = observableValue<IWalkOfferState | undefined>(this, undefined);
	readonly offer: IObservable<IWalkOfferState | undefined> = this._offer;
	private readonly _walking = observableValue(this, false);
	readonly walking: IObservable<boolean> = this._walking;
	private readonly _pillShown = observableValue(this, false);
	readonly pillShown: IObservable<boolean> = this._pillShown;

	private _sessionId: string | undefined;
	private readonly _watch = new Map<string, ITurnWatch>();
	private _plan: IPlan | undefined;
	private readonly _answers = new Map<string, IAnswer>();
	/** Why on Changes (task-39x97): the model's answers by turn, by block (`path:start-end`), and the call under way. */
	private readonly _why = new Map<string, Map<string, { block: IWhyBlock; text: string; ms: number; asked: number; by: string }>>();
	private readonly _whyAsking = new Map<string, { blocks: readonly IWhyBlock[]; done: Promise<void> }>();
	private _walk: { plan: IPlan; index: number } | undefined;
	private readonly _card = this._register(new MutableDisposable<DispatchWalkCard>());
	private _pill: DispatchWalkPill | undefined;
	private readonly _pillStore = this._register(new DisposableStore());
	private _lit: IEditorDecorationsCollection | undefined;
	/** The file list beside the editor was put away for the walk: it comes back when the walk ends. */
	private _hidFiles = false;
	/** Editors whose minimap the walk turned off (it covered the ends of lines in a narrow pane), and what it was. */
	private readonly _minimaps = new Map<ICodeEditor, boolean>();
	private readonly _walkStore = this._register(new DisposableStore());
	private _gen = 0;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _ro: ResizeObserver | undefined;
	private _mo: MutationObserver | undefined;
	private _observed: HTMLElement | undefined;

	constructor(
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IChatService private readonly _chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IChangesViewService private readonly _changesViewService: IChangesViewService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IEditorService private readonly _editorService: IEditorService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDispatchSideChatService private readonly _sideChats: IDispatchSideChatService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly _commandService: ICommandService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => { clearTimeout(this._timer); this._ro?.disconnect(); this._mo?.disconnect(); this._lit?.clear(); }));

		// the session on screen: a turn starts (the pill goes) or ends (the pill comes when it changed files)
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			const status = session?.status.read(reader);
			const model = session ? this._chatService.getSession(session.mainChat.read(reader).resource) : undefined;
			this.onSession(session, turnRuns(model, status, reader));
		}));
		// the turn's changes come in after it ends, and change as the Changes tab's list does
		// (only once the turn has ended: while it runs nothing here is read, so nothing is worked out for it either)
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			if (!session || turnRuns(this._chatService.getSession(session.mainChat.read(reader).resource), session.status.read(reader), reader)) {
				return;
			}
			const turn = this._changesViewService.activeSessionChangesetsObs.read(reader)?.find(c => c.id === TURN_CHANGES_CHANGESET_ID);
			turn?.isEnabled.read(reader);
			turn?.isLoadingChanges.read(reader);
			turn?.changes.read(reader);
			session.mainChat.read(reader).lastTurnChanges?.read(reader);
			this.schedule();
		}));
		// Quiet or Talk; the side chat card in the same corner
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LEARN_MODE_SETTING)) {
				this.layout();
			}
		}));
		this._register(autorun(reader => {
			this._sideChats.cards.read(reader);
			// the side chat card opened over the corner (Ask Question somewhere): the walk gives it the corner
			if (this._walk && this.sideCardMode() === 'open') {
				this.end();
			}
			this.layout();
		}));
	}

	// ---- turns ---------------------------------------------------------------------------------------------

	private watchOf(sessionId: string): ITurnWatch {
		let w = this._watch.get(sessionId);
		if (!w) {
			w = { running: false, pill: false, dismissed: false };
			this._watch.set(sessionId, w);
		}
		return w;
	}

	/** The turn of the session runs: its status says so, or its last reply is still being written. */
	private running(session: IActiveSession): boolean {
		return turnRuns(this._chatService.getSession(session.mainChat.get().resource), session.status.get());
	}

	private onSession(session: IActiveSession | undefined, running: boolean): void {
		if (session?.sessionId !== this._sessionId) {
			this.end();
			this._gen++;
			this._plan = undefined;
			this._offer.set(undefined, undefined);
			this._sessionId = session?.sessionId;
		}
		if (!session) {
			this.layout();
			return;
		}
		const w = this.watchOf(session.sessionId);
		if (running) {
			// the next turn began: the last one's pill and offer go
			if (!w.running) {
				w.running = true;
				w.pill = false;
				w.dismissed = false;
			}
			this._gen++;
			this._plan = undefined;
			this._offer.set(undefined, undefined);
			this.layout();
			return;
		}
		if (w.running) {
			// it was running and stopped: the pill of this turn, once its changes are known
			w.running = false;
			w.pill = true;
		}
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this._timer);
		this._timer = setTimeout(() => void this.refresh(), REFRESH_MS);
	}

	private async refresh(): Promise<void> {
		const session = this._sessionsService.activeSession.get();
		if (!session || this.running(session) || this._walk) {
			return;
		}
		const gen = ++this._gen;
		let plan: IPlan | undefined;
		try {
			plan = await this.plan(session);
		} catch (err) {
			this._logService.error('[dispatch] walk: reading the turn\'s changes failed', err);
		}
		if (gen !== this._gen || session.sessionId !== this._sessionId || this._walk) {
			return;
		}
		this._plan = plan;
		this._offer.set(plan ? { sessionId: plan.sessionId, stops: plan.stops.length } : undefined, undefined);
		this.layout();
	}

	/** The turn's changes as the Changes tab has them: its turn changeset, else the conversation's last-turn list. */
	private turnChanges(session: IActiveSession): { changes: readonly ISessionFileChange[]; source: IPlan['source'] } | undefined {
		const set = this._changesViewService.activeSessionChangesetsObs.get()?.find(c => c.id === TURN_CHANGES_CHANGESET_ID && c.isEnabled.get());
		if (set && !set.isLoadingChanges.get() && set.changes.get().length) {
			return { changes: set.changes.get(), source: 'changes' };
		}
		const last = session.mainChat.get().lastTurnChanges?.get().filter(c => !c.isOutsideWorkspace);
		return last?.length ? { changes: last, source: 'last-turn' } : undefined;
	}

	private async plan(session: IActiveSession): Promise<IPlan | undefined> {
		const found = this.turnChanges(session);
		if (!found) {
			return undefined;
		}
		const request = this._chatService.getSession(session.mainChat.get().resource)?.lastRequest;
		const roots = this.roots(session);
		const { files, texts, focusOf } = await this.readChanges(found.changes, roots);
		const { stops, more } = walkStops(files);
		if (!stops.length) {
			return undefined;
		}
		// what is already said: a new file's first comment, else the agent's sentence before it changed the file
		const agent = request ? this.agentSaid(request, roots) : new Map<string, string[]>();
		const out: IStop[] = [];
		for (let i = 0; i < stops.length;) {
			const path = stops[i].path;
			let j = i;
			while (j < stops.length && stops[j].path === path) {
				j++;
			}
			const t = texts.get(path)!;
			const group = stops.slice(i, j);
			const comment = group[0].isNew ? headerComment(t.now.slice(0, 40).join('\n')) : undefined;
			const said = comment ? [comment] : assignSaid(group.length, agent.get(path) ?? []);
			group.forEach((s, k) => {
				const words = said[k];
				out.push({
					...s,
					uri: t.uri,
					snippet: t.now.slice(s.start - 1, Math.min(s.end, s.start - 1 + MAX_SNIPPET_LINES)).join('\n'),
					code: stopCode(s, t.now, t.before),
					said: words ? { text: asSentence(words), from: comment ? 'comment' : 'agent' } : undefined,
					focus: s.hunks.length ? focusOf.get(s.hunks[0]) : undefined,
				});
			});
			i = j;
		}
		const turn = request?.id ?? `${session.sessionId}:${session.lastTurnEnd.get()?.getTime() ?? 0}`;
		this._logService.trace(`[dispatch] walk: ${turn} from ${found.source}: ${JSON.stringify(out.map(s => [s.rel, s.start, s.end, s.said?.from ?? '']))}, ${more} more`);
		return { sessionId: session.sessionId, turn, stops: out, more, request: request?.message.text ?? '', source: found.source };
	}

	private roots(session: IActiveSession): URI[] {
		const folders = session.workspace.get()?.folders ?? [];
		return localRoots(folders.flatMap(f => [f.workingDirectory, f.gitRepository?.workTreeUri, f.root]));
	}

	/** The files of a list of changes with their blocks (as the Changes tab diffs them), their lines now and before. */
	private async readChanges(changes: readonly ISessionFileChange[], roots: readonly URI[]): Promise<{ files: IWalkFile[]; texts: Map<string, IFileText>; focusOf: Map<IWalkHunk, { line: number; from: number; to: number }> }> {
		const files: IWalkFile[] = [];
		const focusOf = new Map<IWalkHunk, { line: number; from: number; to: number }>();
		const texts = new Map<string, IFileText>();
		for (const c of changes) {
			const uri = toLocal(isIChatSessionFileChange2(c) ? c.uri : c.modifiedUri);
			const root = roots.find(r => isEqualOrParent(uri, r));
			const rel = root ? uri.path.slice(root.path.replace(/\/$/, '').length + 1) : uri.path;
			if (!c.modifiedUri) {
				files.push({ path: uri.fsPath, rel, isNew: false, deleted: true, lines: 0, hunks: [] });
				continue;
			}
			const now = await this.lines(uri.scheme === 'file' ? uri : c.modifiedUri);
			if (!now) {
				continue;
			}
			const before = c.originalUri ? await this.lines(c.originalUri) ?? [] : [];
			const isNew = !c.originalUri || (before.length <= 1 && !before[0]);
			const diff = isNew ? undefined : new DefaultLinesDiffComputer().computeDiff(before, now, { ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false });
			const hunks = diff ? diff.changes.map(m => {
				const h = hunkOf(m.modified.startLineNumber, m.modified.endLineNumberExclusive, m.original.startLineNumber, m.original.endLineNumberExclusive, now.length);
				// the first changed characters of the block, to scroll them into view sideways
				const inner = h.added ? m.innerChanges?.find(r => !r.modifiedRange.isEmpty())?.modifiedRange : undefined;
				if (inner) {
					const line = inner.startLineNumber;
					focusOf.set(h, { line, from: inner.startColumn, to: inner.endLineNumber === line ? inner.endColumn : (now[line - 1] ?? '').length + 1 });
				}
				return h;
			}) : [];
			// a file that ends in a new line has no last line of its own (a new file of two lines is lines 1–2)
			files.push({ path: uri.fsPath, rel, isNew, lines: now.length > 1 && now[now.length - 1] === '' ? now.length - 1 : now.length, hunks });
			texts.set(uri.fsPath, { now, before, uri });
		}
		return { files, texts, focusOf };
	}

	private async lines(uri: URI): Promise<string[] | undefined> {
		try {
			const ref = await this._textModelService.createModelReference(uri);
			try {
				return ref.object.textEditorModel.getLinesContent();
			} finally {
				ref.dispose();
			}
		} catch (err) {
			// a file gone again, or a before-side the host no longer has: the file is left out of the walk
			this._logService.trace(`[dispatch] walk: cannot read ${uri.toString()}`, err);
			return undefined;
		}
	}

	/**
	 * The sentences the agent wrote right before each call that wrote a file (no other call between them), by file:
	 * only one that names the file or says what it is for (dispatchLearnModel's why).
	 */
	private agentSaid(request: IChatRequestModel, roots: readonly URI[]): Map<string, string[]> {
		const out = new Map<string, string[]>();
		const parts: readonly IChatProgressResponseContent[] = request.response?.response.value ?? [];
		const before = (index: number): string | undefined => {
			for (let i = index - 1; i >= 0; i--) {
				const p = parts[i];
				if (p.kind === 'markdownContent') {
					const s = lastSentence(p.content.value);
					if (s) {
						return s;
					}
				} else if (p.kind === 'toolInvocation' || p.kind === 'toolInvocationSerialized' || p.kind === 'externalEdit') {
					return undefined;
				}
			}
			return undefined;
		};
		const add = (uri: URI, sentence: string | undefined) => {
			const s = why(sentence, [uri.path]);
			if (s) {
				out.set(uri.fsPath, [...(out.get(uri.fsPath) ?? []), s]);
			}
		};
		parts.forEach((p, i) => {
			if (p.kind === 'toolInvocation' || p.kind === 'toolInvocationSerialized') {
				const message = `${text(p.invocationMessage)}\n${text(p.pastTenseMessage)}`;
				if (!WRITE_TOOLS.has(p.toolId) && !/^(Edit|Edited|Write|Wrote|Create|Created)\b/.test(text(p.invocationMessage))) {
					return;
				}
				const seen = new Set<string>();
				for (const f of filesInMessage(message)) {
					const uri = localPath(f.target, roots);
					if (uri && !seen.has(uri.fsPath)) {
						seen.add(uri.fsPath);
						add(uri, before(i));
					}
				}
			} else if (p.kind === 'externalEdit') {
				add(toLocal(p.uri), before(i));
			}
		});
		return out;
	}

	// ---- the walk ------------------------------------------------------------------------------------------

	async start(): Promise<void> {
		const session = this._sessionsService.activeSession.get();
		if (!session || this.running(session)) {
			return;
		}
		if (this._walk) {
			this._card.value?.focus();
			return;
		}
		if (!this._plan || this._plan.sessionId !== session.sessionId) {
			clearTimeout(this._timer);
			await this.refresh();
		}
		const plan = this._plan;
		if (!plan || this._walk) {
			return;
		}
		const w = this.watchOf(session.sessionId);
		w.pill = false;
		// the side chat card folds into its pill: the walk takes the corner
		if (this.sideCardMode() === 'open') {
			this._sideChats.setMode(session.sessionId, 'min');
		}
		const container = this.container();
		if (!container) {
			return;
		}
		this._walk = { plan, index: 0 };
		this._card.value = new DispatchWalkCard(container, {
			next: () => {
				const at = this._walk?.index ?? 0;
				if (this._walk && at < this._walk.plan.stops.length - 1) {
					void this.go(at + 1);
				} else {
					this.end();
				}
			},
			back: () => {
				if (this._walk && this._walk.index > 0) {
					void this.go(this._walk.index - 1);
				}
			},
			end: () => this.end(),
			ask: () => void this.ask(),
			openChanges: () => { this.end(); void this._commandService.executeCommand(VIEW_SESSION_CHANGES_COMMAND_ID); },
		});
		this._walking.set(true, undefined);
		// the file list beside the editor goes for the walk, so the file has the side pane's width (it comes back at
		// the end); opening a stop's file can bring it back: it goes again
		this._hidFiles = false;
		this.hideFiles();
		this._walkStore.add(this._layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART) {
				this.hideFiles();
			}
		}));
		this.layout();
		this._card.value.focus();
		void this.askModel(session, plan);
		await this.go(0);
	}

	private async go(index: number): Promise<void> {
		const walk = this._walk;
		if (!walk) {
			return;
		}
		walk.index = Math.max(0, Math.min(walk.plan.stops.length - 1, index));
		this.draw();
		const stop = walk.plan.stops[walk.index];
		const pane = await this._editorService.openEditor({ resource: stop.uri, options: { preserveFocus: true, revealIfOpened: true, pinned: true } });
		if (this._walk !== walk || walk.plan.stops[walk.index] !== stop) {
			return; // moved on while it opened
		}
		const control = pane?.getControl();
		const editor = isCodeEditor(control) ? control : isDiffEditor(control) ? control.getModifiedEditor() : undefined;
		this._lit?.clear();
		this._lit = undefined;
		this.hideFiles();
		if (!editor) {
			return;
		}
		// the minimap took the ends of the lines in a narrow pane: off while walking
		if (!this._minimaps.has(editor)) {
			this._minimaps.set(editor, editor.getOption(EditorOption.minimap).enabled);
			this._walkStore.add(editor.onDidDispose(() => this._minimaps.delete(editor)));
			editor.updateOptions({ minimap: { enabled: false } });
		}
		const reduce = this._accessibilityService.isMotionReduced();
		const range = new Range(stop.start, 1, stop.end, 1);
		this._lit = editor.createDecorationsCollection([{
			range,
			options: {
				description: 'dispatch-walk',
				isWholeLine: true,
				className: reduce ? 'dispatch-walk-line still' : 'dispatch-walk-line',
				linesDecorationsClassName: 'dispatch-walk-gutter',
			},
		}]);
		this.reveal(editor, stop, reduce ? ScrollType.Immediate : ScrollType.Smooth);
		// the card keeps the keyboard: ← → Esc go on working
		this._card.value?.focus();
	}

	/** The stop's first line three lines from the top (as the prototype scrolls), and its first change in view sideways. */
	private reveal(editor: ICodeEditor, stop: IStop, scrollType: ScrollType): void {
		const model = editor.getModel();
		if (!model) {
			return;
		}
		const scrollTop = Math.max(0, editor.getTopForLineNumber(stop.start) - 3 * editor.getOption(EditorOption.lineHeight));
		let scrollLeft = 0;
		const f = stop.focus;
		if (f && f.line <= model.getLineCount()) {
			const text = model.getLineContent(f.line);
			const tab = model.getOptions().tabSize;
			const cw = editor.getOption(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
			const x1 = CursorColumns.visibleColumnFromColumn(text, Math.min(f.from, text.length + 1), tab) * cw;
			const x2 = CursorColumns.visibleColumnFromColumn(text, Math.min(f.to, text.length + 1), tab) * cw;
			const layout = editor.getLayoutInfo();
			const width = layout.contentWidth - layout.verticalScrollbarWidth;
			if (x2 + 2 * cw > width) {
				scrollLeft = Math.max(0, Math.min(x1 - 4 * cw, x2 - width + 4 * cw));
			}
		}
		editor.setScrollPosition({ scrollTop, scrollLeft }, scrollType);
	}

	private hideFiles(): void {
		if (this._walk && this._layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			this._hidFiles = true;
			this._layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
	}

	/** The card on the stop it is on, with the best words it has for it. */
	private draw(): void {
		const walk = this._walk, card = this._card.value;
		if (!walk || !card) {
			return;
		}
		const stop = walk.plan.stops[walk.index];
		const answer = this._answers.get(walk.plan.turn);
		const said = stop.said;
		// the model's sentence for these lines, from the walk's own call or a Why on Changes (task-39x97)
		const fromModel = said ? undefined : answer?.texts.get(stopKey(stop)) ?? this.whyKnown(walk.plan.turn, stop)?.text;
		const source: WalkSource = said ? said.from : fromModel ? 'model' : 'lines';
		const shown: IWalkCardStop = {
			path: stop.path, rel: stop.rel, name: stop.name, isNew: stop.isNew, start: stop.start, end: stop.end,
			tag: stopTag(stop), lines: stopLines(stop), source,
			text: said?.text ?? (fromModel ? asSentence(fromModel) : linesSentence(stop)),
		};
		card.show(shown, walk.index, walk.plan.stops.length, walk.plan.more, answer?.state === 'asking');
		const el = card.element;
		el.dataset.model = answer?.state ?? '';
		el.dataset.modelMs = answer?.ms !== undefined ? String(answer.ms) : '';
		el.dataset.modelBy = answer?.by ?? '';
		el.dataset.changes = walk.plan.source;
	}

	/** One call to the session's own agent, with its model, for every stop of the turn nothing else says. */
	private async askModel(session: IActiveSession, plan: IPlan): Promise<void> {
		if (this._answers.has(plan.turn)) {
			return;
		}
		// a Why on Changes may have asked about some of them already, or be asking now (task-39x97)
		const pending = this._whyAsking.get(plan.turn);
		if (pending) {
			this._answers.set(plan.turn, { state: 'asking', texts: new Map() });
			this.draw();
			await pending.done;
			this._answers.delete(plan.turn);
		}
		const need = plan.stops.filter(s => !s.said && !this.whyKnown(plan.turn, s));
		const { engine, model } = writerOf(session);
		const answer: IAnswer = { state: need.length && engine ? 'asking' : 'none', texts: new Map() };
		this._answers.set(plan.turn, answer);
		if (answer.state === 'none') {
			this.draw();
			return;
		}
		this.draw();
		const payload = {
			request: plan.request.slice(0, 2000),
			stops: need.map(s => ({ file: s.rel, start: s.start, end: s.end, kind: s.isNew ? 'new' : 'edit', code: s.code })),
		};
		const t0 = Date.now();
		this._logService.info(`[dispatch] walk: asking ${engine}${model ? ` (${model})` : ''} once for ${need.length} of ${plan.stops.length} stops of ${plan.turn}`);
		let res: { texts?: unknown; by?: string; error?: string } | undefined;
		try {
			res = await this._commandService.executeCommand<{ texts?: unknown; by?: string; error?: string }>('dispatch.write', 'walk', '', JSON.stringify(payload), engine, model);
		} catch (err) {
			this._logService.warn('[dispatch] walk: the agent could not be asked', err);
		}
		const texts = Array.isArray(res?.texts) ? res.texts : [];
		need.forEach((s, i) => {
			const t = texts[i];
			if (typeof t === 'string' && t.trim()) {
				answer.texts.set(stopKey(s), t.trim());
			}
		});
		answer.state = 'done';
		answer.ms = Date.now() - t0;
		answer.by = res?.by || '';
		this._logService.info(`[dispatch] walk: ${engine} answered ${answer.texts.size} of ${need.length} in ${answer.ms} ms${res?.error ? `: ${res.error}` : ''}`);
		this.draw();
	}

	// ---- Why on a block of Changes (task-39x97) ------------------------------------------------------------

	/** What a Why's model call answered for these lines in this turn. */
	private whyKnown(turn: string, block: IWhyBlock): { text: string; ms: number; asked: number; by: string } | undefined {
		const map = this._why.get(turn);
		return map ? knownFor(block, [...map.values()].map(v => ({ ...v.block, ...v }))) : undefined;
	}

	/** What the walk of this turn says about these lines: its sentence, or the answer its model call got. */
	private walkSays(turn: string, block: IWhyBlock): IWhyAnswer | undefined {
		const plan = this._plan;
		if (!plan || plan.turn !== turn) {
			return undefined;
		}
		const stop = knownFor(block, plan.stops);
		if (!stop) {
			return undefined;
		}
		if (stop.said) {
			return { text: stop.said.text, source: stop.said.from, fromWalk: true };
		}
		const answer = this._answers.get(turn);
		const t = answer?.texts.get(stopKey(stop));
		return t ? { text: asSentence(t), source: 'model', fromWalk: true, ms: answer?.ms, by: answer?.by } : undefined;
	}

	async why(req: IWhyRequest): Promise<IWhyAnswer> {
		const none: IWhyAnswer = { text: WHY_NONE, source: 'none', fromWalk: false };
		const session = this._sessionsService.activeSession.get();
		if (!session) {
			return none;
		}
		const request = this._chatService.getSession(session.mainChat.get().resource)?.lastRequest;
		const turn = request?.id ?? session.sessionId;
		const block: IWhyBlock = { path: toLocal(req.uri).fsPath, start: req.start, end: req.end };
		const fromModel = (k: { text: string; ms: number; asked: number; by: string }): IWhyAnswer => ({ text: asSentence(k.text), source: 'model', fromWalk: false, ms: k.ms, asked: k.asked, by: k.by });

		// 1. the walk of this turn has it; 2. a Why's call has it, or is asking for it now
		const walked = this.walkSays(turn, block);
		if (walked) {
			return walked;
		}
		const pending = this._whyAsking.get(turn);
		if (pending?.blocks.some(b => overlaps(b, block))) {
			await pending.done;
		}
		const known = this.whyKnown(turn, block);
		if (known) {
			return fromModel(known);
		}

		// 3. what the agent already said: a new file's first comment, its sentence before it changed the file
		const roots = this.roots(session);
		const { files, texts } = await this.readChanges(this._changesViewService.activeSessionChangesObs.get().slice(0, MAX_WHY_FILES), roots);
		const agent = request ? this.agentSaid(request, roots) : new Map<string, string[]>();
		const all: (IWhyAsk & { said?: { text: string; from: 'comment' | 'agent' } })[] = [];
		for (const f of files) {
			const t = texts.get(f.path);
			if (f.deleted || !t) {
				continue;
			}
			if (f.isNew) {
				const comment = headerComment(t.now.slice(0, 40).join('\n'));
				const stop = walkStops([f]).stops[0];
				all.push({ path: f.path, rel: f.rel, start: 1, end: Math.max(1, f.lines), isNew: true, code: stop ? stopCode(stop, t.now, t.before) : '', said: comment ? { text: asSentence(comment), from: 'comment' } : undefined });
				continue;
			}
			const stops = walkStops([f], Number.MAX_SAFE_INTEGER).stops;
			const said = assignSaid(stops.length, agent.get(f.path) ?? []);
			stops.forEach((s, k) => all.push({ path: f.path, rel: f.rel, start: s.start, end: s.end, isNew: false, code: stopCode(s, t.now, t.before), said: said[k] ? { text: asSentence(said[k]!), from: 'agent' } : undefined }));
		}
		const mine = knownFor(block, all);
		if (mine?.said) {
			return { text: mine.said.text, source: mine.said.from, fromWalk: false };
		}

		// 4. one call to the session's own agent for every block shown that nothing says anything about, this one first
		const { engine, model } = writerOf(session);
		if (!engine) {
			return none;
		}
		const root = roots.find(r => isEqualOrParent(toLocal(req.uri), r));
		const clicked: IWhyAsk = { ...block, rel: mine?.rel ?? (root ? toLocal(req.uri).path.slice(root.path.replace(/\/$/, '').length + 1) : toLocal(req.uri).path), isNew: req.isNew, code: req.code };
		const ask = blocksToAsk<IWhyAsk & { said?: unknown }>(clicked, all.filter(b => !mine || !overlaps(b, mine)), b => !!b.said || !!this.whyKnown(turn, b) || !!this.walkSays(turn, b));
		const payload = {
			request: (request?.message.text ?? '').slice(0, 2000),
			why: true,
			stops: ask.map(b => ({ file: b.rel, start: b.start, end: b.end, kind: b.isNew ? 'new' : 'edit', code: b.code })),
		};
		const t0 = Date.now();
		this._logService.info(`[dispatch] why: asking ${engine}${model ? ` (${model})` : ''} once for ${ask.length} blocks of ${turn}`);
		const done = (async () => {
			let res: { texts?: unknown; by?: string; error?: string } | undefined;
			try {
				res = await this._commandService.executeCommand<{ texts?: unknown; by?: string; error?: string }>('dispatch.write', 'walk', '', JSON.stringify(payload), engine, model);
			} catch (err) {
				this._logService.warn('[dispatch] why: the agent could not be asked', err);
			}
			const ms = Date.now() - t0;
			const got = Array.isArray(res?.texts) ? res.texts : [];
			let map = this._why.get(turn);
			if (!map) {
				map = new Map();
				this._why.set(turn, map);
			}
			ask.forEach((b, i) => {
				const t = got[i];
				if (typeof t === 'string' && t.trim()) {
					map!.set(blockKey(b), { block: { path: b.path, start: b.start, end: b.end }, text: t.trim(), ms, asked: ask.length, by: res?.by || '' });
				}
			});
			this._logService.info(`[dispatch] why: ${engine} answered ${got.filter(x => typeof x === 'string' && x.trim()).length} of ${ask.length} in ${ms} ms${res?.error ? `: ${res.error}` : ''}`);
			// the walk's card shows them too when it is on one of these lines
			this.draw();
		})();
		this._whyAsking.set(turn, { blocks: ask, done });
		try {
			await done;
		} finally {
			if (this._whyAsking.get(turn)?.done === done) {
				this._whyAsking.delete(turn);
			}
		}
		const answered = this.whyKnown(turn, block);
		return answered ? fromModel(answered) : { ...none, ms: Date.now() - t0, asked: ask.length };
	}

	/** Ask about this: the stop's lines in the side chat card, else quoted into the conversation's input. */
	private async ask(): Promise<void> {
		const walk = this._walk;
		const session = this._sessionsService.activeSession.get();
		if (!walk || !session) {
			return;
		}
		const stop = walk.plan.stops[walk.index];
		this.end();
		if (session.capabilities.get().supportsSideChat) {
			const ask: ISideChatAsk = {
				selection: `${stop.rel}:${stop.start}-${stop.end}\n${stop.snippet}`,
				passage: { path: stop.path, start: stop.start, end: stop.end, text: stop.snippet, inDocs: false, from: 'file' },
			};
			await this._commandService.executeCommand(DISPATCH_SIDE_CHAT_ASK_COMMAND, ask);
			return;
		}
		const main = session.mainChat.get().resource;
		const widget = this._chatWidgetService.getWidgetBySessionResource(main) ?? await whenChatWidgetForSession(this._chatWidgetService, main, 3000);
		if (widget) {
			addQuoteToWidget(widget, toQuoteEntry(stop.snippet, {
				from: 'file', label: `${stop.name} · ${stopLines(stop)}`, icon: Codicon.file.id,
				uri: stop.uri.toString(), file: stop.rel, startLine: stop.start, endLine: stop.end,
			}));
		}
	}

	private end(): void {
		if (!this._walk) {
			return;
		}
		this._walk = undefined;
		this._walkStore.clear();
		this._lit?.clear();
		this._lit = undefined;
		this._card.clear();
		for (const [editor, enabled] of this._minimaps) {
			editor.updateOptions({ minimap: { enabled } });
		}
		this._minimaps.clear();
		if (this._hidFiles) {
			this._hidFiles = false;
			this._layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		}
		this._walking.set(false, undefined);
		this.layout();
	}

	// ---- the corner ----------------------------------------------------------------------------------------

	private sideCardMode(): 'open' | 'min' | 'closed' | undefined {
		return this._sessionId ? this._sideChats.cards.get().get(this._sessionId)?.mode : undefined;
	}

	/** The side pane the pill and the card sit in; undefined while it is put away. */
	private container(): HTMLElement | undefined {
		const part = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		const box = part?.getBoundingClientRect();
		return part && box && box.width > 0 && box.height > 0 ? part : undefined;
	}

	private observe(container: HTMLElement): void {
		if (this._observed === container) {
			return;
		}
		this._ro?.disconnect();
		this._mo?.disconnect();
		this._observed = container;
		this._ro = new ResizeObserver(() => this.layout());
		// the small cards come and go in the same corner: the pill waits until they have gone
		this._mo = new MutationObserver(() => this.layout());
		this._mo.observe(container, { childList: true });
		this._ro.observe(container);
		if (dom.getWindow(container).getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}
		this._pillStore.clear();
		this._pill = this._pillStore.add(new DispatchWalkPill(container, () => void this.start(), () => {
			if (this._sessionId) {
				this.watchOf(this._sessionId).dismissed = true;
			}
			this.layout();
		}));
	}

	private layout(): void {
		const container = this.container() ?? this._observed;
		if (!container) {
			this._pillShown.set(false, undefined);
			return;
		}
		this.observe(container);
		const win = dom.getWindow(container);
		const pane = container.getBoundingClientRect();
		const off = pillOffset(win.innerWidth);
		const side = this.sideCardMode();
		// 8 over the side chat's head when its pane is folded at the side pane's bottom (task-5im8n)
		const bottom = cornerFloor(side, win.innerWidth);
		const w = this._sessionId ? this._watch.get(this._sessionId) : undefined;
		const mode = learnMode(this._configurationService.getValue(LEARN_MODE_SETTING));
		// not while the small cards of the turn are still up: the pill would push them under the pointer (they stack
		// above it); it comes when the last one has gone
		const talking = !!container.querySelector('.dispatch-talk-card');
		const pill = !this._walk && !!this._plan && !!w?.pill && !w.dismissed && mode === 'talk' && side !== 'open' && pane.width > 0 && !talking;
		this._pill?.set(pill ? this._plan!.stops.length : undefined, off, bottom);
		this._pillShown.set(pill, undefined);
		const card = this._card.value;
		if (card && pane.width > 0) {
			const box = cardBox(pane.width, pane.height, win.innerWidth);
			card.place(box.right, bottom, box.width, Math.max(160, Math.min(470, pane.height - 96 - bottom)));
		}
	}
}

registerSingleton(IDispatchWalkService, DispatchWalkService, InstantiationType.Delayed);

CommandsRegistry.registerCommand(DISPATCH_WALK_COMMAND, (accessor: ServicesAccessor) => accessor.get(IDispatchWalkService).start());
