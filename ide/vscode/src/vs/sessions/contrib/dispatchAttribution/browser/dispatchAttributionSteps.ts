/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: who wrote which line, step by step (patches/340-attribution.patch;
 *  kanban design/attribution/redesign, direction B).
 *
 *  - Under the reply of a turn, once you change lines after it: "You changed 2 lines in NOTES.md · 5:58 AM".
 *    Its hover says the agent hears about them when its next turn starts (or that it did); a click shows only
 *    those lines in Changes and scrolls to the first one.
 *  - Under the reply of a turn that made a commit, a commit card: the commit, "Message by <agent>", and
 *    "Includes 2 lines you changed" when some of its lines were yours. A chevron opens the whole message.
 *  - A commit you made yourself after a turn (the commit button in Changes or Source Control, a terminal) gets
 *    the same card under that turn's reply: "You committed" and whose lines it holds.
 *  The row's click shows your lines as a changeset of their own (two versions per file) in Changes' own picker;
 *  Changes adds nothing of its own above the diffs (VS Code's as it is, the user 2026-11-16).
 *
 *  Data: dispatch-bridge's dispatch.attributionSteps runs `dispatch attribution steps --host-session --cwd`
 *  (kanban app/cli/attribution.py), asked again when the session's changes change.
 *--------------------------------------------------------------------------------------------*/

import { isDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import './media/dispatchAttributionSteps.css';
import * as dom from '../../../../base/browser/dom.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable } from '../../../../base/common/observable.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { setDispatchChatResponseHooks, IDispatchChatResponseFooterContext } from '../../../../workbench/contrib/chat/browser/widget/dispatchChatResponseHooks.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession, ISessionChangeset, ISessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionChangesService } from '../../changes/common/sessionChangesService.js';
import { IChangesViewService } from '../../changes/common/changesViewService.js';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { engineBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import {
	changesetId, clock, commitYoursLabel, hasCoAuthor, ownCommitLabel, IAttributionSteps, IStepCommit, IStepYours, parseSteps,
	replyFor, stepFiles, stepNote, stepOfChangeset, YoursStep, yoursLabel, yoursTip,
} from './dispatchAttributionStepsModel.js';

const STEPS_COMMAND = 'dispatch.attributionSteps';
/** answers this fresh are reused: every reply row and the filter ask at once */
const FRESH_MS = 2000;
/** after a change, ask again this long after it (the turn's end mark can land a few seconds late) */
const AGAIN_MS = [700, 3000, 8000];
/** How often the shown session's steps are read again anyway (a commit of yours changes nothing the window watches). */
const OWN_COMMIT_MS = 15_000;
const $ = dom.$;

/** The folder the agent edits: the session's own worktree when it has one. */
function sessionFolder(session: ISession): string | undefined {
	const f = session.workspace.get()?.folders[0];
	const uri = f?.gitRepository?.workTreeUri ?? f?.workingDirectory;
	return uri && uri.scheme === Schemas.file ? uri.fsPath : undefined;
}

// ---------------------------------------------------------------- the CLI's answers per session

class StepsStore extends Disposable {
	private readonly _answers = new Map<string, { at: number; steps: IAttributionSteps | undefined; pending?: Promise<void> }>();
	private readonly _onDidChange = this._register(new Emitter<string>());
	/** a session's steps changed (its resource as a string) */
	readonly onDidChange: Event<string> = this._onDidChange.event;

	constructor(private readonly _commands: ICommandService, private readonly _log: ILogService) {
		super();
	}

	get(session: ISession): IAttributionSteps | undefined {
		return this._answers.get(session.resource.toString())?.steps;
	}

	refresh(session: ISession, force = false): Promise<void> {
		const key = session.resource.toString();
		const hit = this._answers.get(key);
		if (hit?.pending) {
			return hit.pending;
		}
		if (hit && !force && Date.now() - hit.at < FRESH_MS) {
			return Promise.resolve();
		}
		const folder = sessionFolder(session);
		if (!folder) {
			return Promise.resolve();
		}
		const entry = hit ?? { at: 0, steps: undefined };
		this._answers.set(key, entry);
		entry.pending = this._commands.executeCommand<unknown>(STEPS_COMMAND, key, folder).then(raw => {
			const steps = parseSteps(raw);
			const before = JSON.stringify(entry.steps);
			entry.steps = steps ?? entry.steps;
			entry.at = Date.now();
			if (JSON.stringify(entry.steps) !== before) {
				this._onDidChange.fire(key);
			}
		}, e => this._log.trace(`[dispatchAttribution] steps ${key}: ${e}`)).finally(() => { entry.pending = undefined; entry.at = Date.now(); });
		return entry.pending;
	}
}

let store: StepsStore | undefined;

// ---------------------------------------------------------------- showing a step in Changes

/**
 * A version of a file the record kept, shown under the file's own path (so Changes does not take it for a
 * rename): `dispatch-attr-version:<the file>?<the read-only copy>`.
 */
const VERSION_SCHEME = 'dispatch-attr-version';

function versionUri(file: string, copy: string | undefined): URI | undefined {
	if (!copy) {
		return undefined;
	}
	return copy === file ? URI.file(file) : URI.from({ scheme: VERSION_SCHEME, path: file, query: copy });
}

class VersionContent implements ITextModelContentProvider {
	constructor(
		@IModelService private readonly _models: IModelService,
		@ILanguageService private readonly _languages: ILanguageService,
		@IFileService private readonly _files: IFileService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this._models.getModel(resource);
		if (existing) {
			return existing;
		}
		const content = await this._files.readFile(URI.file(resource.query));
		return this._models.createModel(content.value.toString(), this._languages.createByFilepathOrFirstLine(URI.file(resource.path)), resource);
	}
}

/** The changeset Changes shows for your lines: each file as the version before and the version after. */
function changesetFor(steps: IAttributionSteps, id: YoursStep): ISessionChangeset {
	const note = stepNote(steps, id);
	const changes: ISessionFileChange[] = stepFiles(steps, id).map(f => ({
		uri: URI.file(f.path),
		originalUri: versionUri(f.path, f.before),
		modifiedUri: versionUri(f.path, f.after),
		insertions: f.added ?? f.count ?? 0,
		deletions: f.removed ?? 0,
	}));
	return {
		id: changesetId(id),
		label: note?.title ?? id,
		description: note?.rest,
		isEnabled: constObservable(true),
		isDefault: constObservable(false),
		isLoadingChanges: constObservable(false),
		changes: constObservable(changes),
		operations: constObservable([]),
		originalCheckpointRef: constObservable(undefined),
		modifiedCheckpointRef: constObservable(undefined),
		async invokeOperation(operationId: string): Promise<void> {
			throw new Error(`A step of the session does not support '${operationId}'`);
		},
	};
}

/** Which session the step on screen belongs to (Changes keeps one changeset for whichever session is shown). */
let shownFor: string | undefined;

class StepOpener {
	constructor(
		@ISessionsService private readonly _sessions: ISessionsService,
		@ISessionChangesService private readonly _sessionChanges: ISessionChangesService,
		@IAgentWorkbenchLayoutService private readonly _layout: IAgentWorkbenchLayoutService,
		@ICodeEditorService private readonly _editors: ICodeEditorService,
	) { }

	async open(session: ISession, id: YoursStep): Promise<void> {
		const steps = store?.get(session);
		if (!steps) {
			return;
		}
		if (this._sessions.activeSession.get()?.resource.toString() !== session.resource.toString()) {
			this._sessions.showSession(session.resource, { preserveFocus: true });
		}
		const changeset = changesetFor(steps, id);
		shownFor = session.resource.toString();
		const first = stepFiles(steps, id)[0];
		this._layout.revealEditorPartExplicitly();
		await this._sessionChanges.openChangesEditor(session.resource, { changesetSelection: { kind: 'transient', changeset } });
		const modified = first && versionUri(first.path, first.after);
		if (modified && first.first) {
			this.revealLine(modified, first.first);
		}
	}

	/** Scroll the step's diff to your first line once the Changes editor has drawn it (its list fills in a moment
	 *  after it opens, so asking it to reveal the file at once would fail). */
	private revealLine(modified: URI, line: number): void {
		const until = Date.now() + 8000;
		const tryReveal = () => {
			const diff = this._editors.listDiffEditors().find(d => d.getModel()?.modified.uri.toString() === modified.toString());
			const editor = diff?.getModifiedEditor();
			if (editor && editor.getModel() && editor.getModel()!.getLineCount() >= line) {
				editor.revealLineInCenterIfOutsideViewport(line);
				editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 });
				return;
			}
			if (Date.now() < until) {
				setTimeout(tryReveal, 200);
			}
		};
		tryReveal();
	}
}

// ---------------------------------------------------------------- under a reply

interface IFooter {
	readonly el: HTMLElement;
	readonly store: DisposableStore;
	key: string;
}

class ReplyFooters {
	private readonly _footers = new WeakMap<HTMLElement, IFooter>();

	constructor(
		private readonly _opener: StepOpener,
		@ISessionsManagementService private readonly _management: ISessionsManagementService,
		@IHoverService private readonly _hover: IHoverService,
	) { }

	remove(value: HTMLElement): void {
		const f = this._footers.get(value);
		if (f) {
			f.store.dispose();
			f.el.remove();
			this._footers.delete(value);
		}
	}

	render(ctx: IDispatchChatResponseFooterContext): void {
		const { value, element } = ctx;
		const owner = element.isComplete ? this._management.getSessionForChatResource(element.sessionResource) : undefined;
		if (!owner || !store) {
			this.remove(value);
			return;
		}
		const session = owner.session;
		let f = this._footers.get(value);
		if (!f || f.el.dataset.reply !== element.requestId) {
			this.remove(value);
			const el = $('.dispatch-attr-reply');
			el.dataset.reply = element.requestId;
			f = { el, store: new DisposableStore(), key: '' };
			this._footers.set(value, f);
			this.fill(f, ctx, session);
		} else {
			this.fill(f, ctx, session);
		}
		if (!f.el.isConnected) {
			if (ctx.footerToolbar && ctx.footerToolbar.parentElement === value.parentElement) {
				ctx.footerToolbar.before(f.el);
			} else {
				value.after(f.el);
			}
		}
		void store.refresh(session);
	}

	private fill(f: IFooter, ctx: IDispatchChatResponseFooterContext, session: ISession): void {
		const steps = store?.get(session);
		const element = ctx.element;
		const requests = element.session.model.getRequests().map(r => ({ id: r.id, ts: r.timestamp }));
		const mine = (anchor: number | undefined) => anchor !== undefined && replyFor(requests, anchor) === element.requestId;
		const yours = steps?.yours.filter(y => mine(y.anchor)) ?? [];
		// the turn's own commits, then the ones you made yourself after it (the commit button, a terminal)
		const commits = steps?.turns.filter(t => mine(t.end)).flatMap(t => [...t.commits, ...t.own_commits].map(c => ({ c, engine: t.engine }))) ?? [];
		const key = JSON.stringify([yours.map(y => [y.after_turn, y.count, y.told, y.ts, y.files.map(x => x.rel)]), commits.map(x => [x.c.hash, x.c.yours, x.c.by, x.c.agents])]);
		if (key === f.key) {
			return;
		}
		const fresh = f.key !== ''; // the rows come in while you look, not when the list draws the reply again
		f.key = key;
		f.store.clear();
		f.store.add(store!.onDidChange(k => { if (k === session.resource.toString()) { this.fill(f, ctx, session); } }));
		dom.clearNode(f.el);
		for (const y of yours) {
			this.yoursRow(f, session, y, fresh);
		}
		for (const { c, engine } of commits) {
			this.commitCard(f, c, engine);
		}
	}

	private yoursRow(f: IFooter, session: ISession, y: IStepYours, animate: boolean): void {
		const row = dom.append(f.el, $('button.dispatch-attr-yours', { type: 'button' }));
		row.classList.toggle('enter', animate);
		dom.append(row, $('span.dispatch-attr-chip.dispatch-attr-you', { 'aria-hidden': 'true' }));
		dom.append(row, $('span.who', undefined, yoursLabel(y)));
		dom.append(row, $('span.meta', undefined, clock(y.ts)));
		dom.append(row, $('span.go' + ThemeIcon.asCSSSelector(Codicon.chevronRight), { 'aria-hidden': 'true' }));
		const tip = yoursTip(y);
		row.setAttribute('aria-label', `${yoursLabel(y)}. ${tip}`);
		f.store.add(this._hover.setupDelayedHover(row, { content: tip, style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
		f.store.add(dom.addDisposableListener(row, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			void this._opener.open(session, `you:${y.after_turn}`);
		}));
	}

	private commitCard(f: IFooter, c: IStepCommit, engine: string): void {
		const card = dom.append(f.el, $('.dispatch-attr-commit'));
		const l1 = dom.append(card, $('.l1'));
		dom.append(l1, $('span.ic' + ThemeIcon.asCSSSelector(Codicon.gitCommit), { 'aria-hidden': 'true' }));
		dom.append(l1, $('span.hash', undefined, c.short));
		dom.append(l1, $('span.subj', undefined, c.subject));
		const more = dom.append(l1, $('button.more', { type: 'button', 'aria-expanded': 'false', 'aria-label': localize('dispatchAttribution.showMessage', "Show the whole message") }));
		dom.append(more, $('span' + ThemeIcon.asCSSSelector(Codicon.chevronDown)));
		f.store.add(this._hover.setupDelayedHover(more, { content: localize('dispatchAttribution.showMessage', "Show the whole message"), style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
		const l2 = dom.append(card, $('.l2'));
		if (c.by === 'turbo') {
			// a Turbo run's result brought into this branch: its agent made it, not you (task-v6glz)
			card.classList.add('own', 'turbo');
			const maker = c.maker || c.agent;
			const by = dom.append(l2, $('span.by'));
			by.appendChild(engineBlock(agentIcon(c.engine || engine)));
			dom.append(by, $('span', undefined, localize('dispatchAttribution.committedByTurbo', "{0} committed in Turbo", maker)));
			f.store.add(this._hover.setupDelayedHover(by, { content: localize('dispatchAttribution.committedByTurboTip', "A Turbo run made these changes in copies of the project and brought them into this branch. You did not write them."), style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
			const holds = ownCommitLabel(c);
			if (holds) {
				dom.append(dom.append(l2, $('span.holds')), $('span', undefined, holds));
			}
			const msg = dom.append(card, $('.msg'));
			const inner = dom.append(msg, $('div'));
			dom.append(inner, $('pre', undefined, c.message || c.subject));
			dom.append(inner, $('.note', undefined, localize('dispatchAttribution.noteTurbo', "Turbo wrote this message when it brought its result in. The parts' own commits are inside it.")));
			f.store.add(dom.addDisposableListener(more, dom.EventType.CLICK, e => {
				dom.EventHelper.stop(e, true);
				const open = !card.classList.contains('open');
				card.classList.toggle('open', open);
				more.setAttribute('aria-expanded', String(open));
			}));
			return;
		}
		if (c.by === 'you') {
			// a commit you made yourself: the card says so, and whose lines it holds
			card.classList.add('own');
			const by = dom.append(l2, $('span.by.you'));
			dom.append(by, $('span.dispatch-attr-chip.dispatch-attr-you', { 'aria-hidden': 'true' }));
			dom.append(by, $('span', undefined, localize('dispatchAttribution.committedByYou', "You committed")));
			f.store.add(this._hover.setupDelayedHover(by, { content: localize('dispatchAttribution.committedByYouTip', "You made this commit after {0}'s turn: Commit or Merge in Changes, or a terminal", c.agent), style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
			if (c.message_by) {
				// the Commit button: an agent wrote the message, you pressed the button
				const msgBy = dom.append(l2, $('span.by'));
				msgBy.appendChild(engineBlock(agentIcon(c.message_by === 'Dispatch' ? engine : c.message_by.toLowerCase())));
				dom.append(msgBy, $('span', undefined, localize('dispatchAttribution.messageBy', "Message by {0}", c.message_by)));
			}
			const holds = ownCommitLabel(c);
			if (holds) {
				const h = dom.append(l2, $('span.holds'));
				if (c.agents?.length) {
					h.appendChild(engineBlock(agentIcon(engine)));
				}
				dom.append(h, $('span', undefined, holds));
			}
			const msg = dom.append(card, $('.msg'));
			const inner = dom.append(msg, $('div'));
			dom.append(inner, $('pre', undefined, c.message || c.subject));
			dom.append(inner, $('.note', undefined, c.message_by
				? localize('dispatchAttribution.noteWrittenForYou', "{0} wrote this message for your commit (Commit or Merge in Changes). Dispatch added nothing to it.", c.message_by)
				: localize('dispatchAttribution.noteYours', "Your message, as you wrote it. Dispatch added nothing to it.")));
			f.store.add(dom.addDisposableListener(more, dom.EventType.CLICK, e => {
				dom.EventHelper.stop(e, true);
				const open = !card.classList.contains('open');
				card.classList.toggle('open', open);
				more.setAttribute('aria-expanded', String(open));
			}));
			return;
		}
		const by = dom.append(l2, $('span.by'));
		by.appendChild(engineBlock(agentIcon(engine)));
		dom.append(by, $('span', undefined, localize('dispatchAttribution.messageBy', "Message by {0}", c.agent)));
		f.store.add(this._hover.setupDelayedHover(by, { content: localize('dispatchAttribution.messageByTip', "{0} wrote this commit message", c.agent), style: HoverStyle.Pointer, position: { hoverPosition: HoverPosition.BELOW } }));
		const yoursText = commitYoursLabel(c.yours);
		if (yoursText) {
			const y = dom.append(l2, $('span.yours'));
			dom.append(y, $('span.dispatch-attr-chip.dispatch-attr-you', { 'aria-hidden': 'true' }));
			dom.append(y, $('span', undefined, yoursText));
		}
		const msg = dom.append(card, $('.msg'));
		const inner = dom.append(msg, $('div'));
		dom.append(inner, $('pre', undefined, c.message || c.subject));
		dom.append(inner, $('.note', undefined, hasCoAuthor(c.message)
			? localize('dispatchAttribution.noteTrailer', "The Co-authored-by line was asked for in Settings › Agents.")
			: localize('dispatchAttribution.noteNothing', "Dispatch added nothing to this message. Who wrote which line stays in Dispatch on this Mac.")));
		f.store.add(dom.addDisposableListener(more, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			const open = !card.classList.contains('open');
			card.classList.toggle('open', open);
			more.setAttribute('aria-expanded', String(open));
		}));
	}
}

// ---------------------------------------------------------------- the contribution

class DispatchAttributionStepsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchAttributionSteps';

	constructor(
		@ICommandService commands: ICommandService,
		@ILogService log: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsService sessions: ISessionsService,
		@IChangesViewService changesView: IChangesViewService,
		@ITextModelService textModels: ITextModelService,
	) {
		super();
		store ??= this._register(new StepsStore(commands, log));
		this._register(textModels.registerTextModelContentProvider(VERSION_SCHEME, instantiationService.createInstance(VersionContent)));
		const steps = store;
		const opener = instantiationService.createInstance(StepOpener);
		const footers = instantiationService.createInstance(ReplyFooters, opener);
		this._register(setDispatchChatResponseHooks({
			renderFooter: ctx => footers.render(ctx),
			removeFooter: value => footers.remove(value),
		}));
		// ask again when the shown session's changes change (you saved a file, a turn wrote one) or its turn ends;
		// again a few seconds later too, since the hooks write the turn's end mark a moment after the window sees it
		const timers: ReturnType<typeof setTimeout>[] = [];
		const clear = () => timers.splice(0).forEach(clearTimeout);
		this._register(toDisposable(clear));
		this._register(autorun(reader => {
			const session = sessions.activeSession.read(reader);
			if (!session) {
				return;
			}
			session.status.read(reader);
			changesView.activeSessionChangesObs.read(reader).map(c => c.insertions + c.deletions);
			clear();
			for (const ms of AGAIN_MS) {
				timers.push(setTimeout(() => void steps.refresh(session, true), ms));
			}
		}));
		// a commit of yours (the commit button, a terminal) changes no count above: look again now and then while the
		// window is in front, so its card comes in without another turn
		const every = mainWindow.setInterval(() => {
			const session = sessions.activeSession.get();
			if (session && mainWindow.document.visibilityState === 'visible' && !isDispatchWindowIdle()) {
				void steps.refresh(session, true);
			}
		}, OWN_COMMIT_MS);
		this._register(toDisposable(() => mainWindow.clearInterval(every)));
		// a step belongs to one session: another session on screen shows all of its own changes
		this._register(autorun(reader => {
			const session = sessions.activeSession.read(reader);
			const id = changesView.activeSessionChangesetObs.read(reader)?.id;
			if (stepOfChangeset(id) && session && session.resource.toString() !== shownFor) {
				log.info(`[dispatchAttribution] ${id} belongs to ${shownFor ?? 'no session'}: ${session.resource.toString()} shows all of its changes`);
				shownFor = undefined;
				changesView.setChangesetId(undefined);
			}
		}));
	}
}

registerWorkbenchContribution2(DispatchAttributionStepsContribution.ID, DispatchAttributionStepsContribution, WorkbenchPhase.AfterRestored);
