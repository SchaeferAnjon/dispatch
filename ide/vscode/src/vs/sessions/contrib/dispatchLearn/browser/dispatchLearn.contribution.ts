/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: learning while the agent works (direction B「Talk while new」, user 2026-11-15, task-q9x2r, kanban
 *  design/learn-scene; the person: "这个软件不只是让 AI 去工作的地方，也是让人类去学习的地方"). The first part:
 *
 *  - Talk (the default) or Quiet, one setting (`dispatch.learning.whileWorking`), switched in the side chat card's ⋯
 *    and in Settings › Learning.
 *  - Talk: while the agent of the session on screen works, a new file, an install or a deletion gets a small card in
 *    the side pane's corner (dispatchTalkCards.ts), one per kind per turn, several of a kind on one card. What it says
 *    comes from the agent's own calls (dispatchLearnTurn.ts); no model is asked. A click asks about it in the side
 *    chat card; where side chats are not there (OpenCode), the click quotes it into the conversation's input.
 *  - Ask Question on the terminal's output (dispatchTerminalAsk.ts), next to the ones a reply, a file, a diff in
 *    Changes and the Docs reader already had: all of them open the same side chat card.
 *  - Walk me through (task-fktjx, dispatchWalk.ts): a turn that changed files is walked stop by stop, its file open
 *    and the lines lit, one sentence each; under Talk a pill offers it when the turn ends, Now and the side chat
 *    card's ⋯ offer it always.
 *  Words you know (the prototype's frame 7) is only a seam this time: ILearnKnownWords in dispatchLearnModel.ts.
 *  - The third part (task-39x97): Now's why line (dispatchNowEditor.ts, the sums in common/dispatchExplainModel.ts),
 *    Explain terms (the dotted line under a developer word, workbench/.../dispatchTermMarks.ts; Ask more is
 *    dispatchAskTerm.ts) and Why / More on every block of Changes (dispatchHunkWhy.ts, the words from
 *    IDispatchWalkService.why).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchLearn.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService, IChatToolInvocation } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel, IChatResponseModel } from '../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { addQuoteToWidget, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { DISPATCH_SIDE_CHAT_ASK_COMMAND, ISideChatAsk } from '../../dispatchSideChat/browser/dispatchSideChatAsk.js';
import { IDispatchSideChatService } from '../../dispatchSideChat/browser/dispatchSideChatService.js';
import { cornerFloor } from '../../dispatchSideChat/common/dispatchSideChatModel.js';
import { askText, cardFor, ILearnCard, ILearnEvent, LEARN_MODE_SETTING, learnMode, LearnKind, mergeEvents, NO_KNOWN_WORDS, shouldTalk } from '../common/dispatchLearnModel.js';
import { eventsOfCall, eventsOfEdit, ITurnContext, localRoots } from './dispatchLearnTurn.js';
import { DispatchTalkCards } from './dispatchTalkCards.js';
import './dispatchTerminalAsk.js';
import './dispatchWalk.js';
import './dispatchHunkWhy.js';
import './dispatchAskTerm.js';
import { EXPLAIN_TERMS_SETTING } from '../../../../workbench/contrib/chat/common/dispatchTerms.js';
import { IDispatchWalkService } from './dispatchWalkService.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'dispatchLearning',
	order: 101,
	title: localize('dispatchLearn.title', "Dispatch"),
	type: 'object',
	properties: {
		[LEARN_MODE_SETTING]: {
			type: 'string',
			enum: ['talk', 'quiet'],
			enumDescriptions: [
				localize('dispatchLearn.talk', "A small card when the agent adds a file, installs or deletes something. It never takes the cursor and fades in 7 seconds."),
				localize('dispatchLearn.quiet', "Nothing shows up by itself. Select anything and choose Ask Question."),
			],
			default: 'talk',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('dispatchLearn.description', "While an agent works in the Agents window: Talk, or Quiet."),
		},
		[EXPLAIN_TERMS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('dispatchLearn.explainTerms', "A faint dotted line under common developer words in replies and in Now; point at one for a sentence in plain words."),
		},
	},
});

/** A turn already running when its conversation came on screen still talks when it began this recently. */
const LIVE_WINDOW_MS = 30_000;

/** The things of one kind in one turn: their card, and whether × sent it away. */
interface IGroup {
	events: ILearnEvent[];
	dismissed: boolean;
}

class DispatchLearn extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchLearn';

	private readonly _cards: DispatchTalkCards;
	private readonly _watch = this._register(new MutableDisposable<DisposableStore>());
	private readonly _response = this._register(new MutableDisposable<DisposableStore>());
	private _session: IActiveSession | undefined;
	private _model: IChatModel | undefined;
	private _boundResponse: IChatResponseModel | undefined;
	/** Calls already read (or there before this window looked: an older turn says nothing). */
	private readonly _seen = new Set<string>();
	/** Requests this window saw start: only their calls get cards. */
	private readonly _live = new Set<string>();
	private readonly _groups = new Map<string, IGroup>();
	private _scanning = false;
	private _again = false;
	/** A call of the turn is still running: looked at again. */
	private _pending = false;

	constructor(
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IChatService private readonly _chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDispatchSideChatService private readonly _sideChats: IDispatchSideChatService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
		@IDispatchWalkService private readonly _walk: IDispatchWalkService,
	) {
		super();
		this._cards = this._register(new DispatchTalkCards({
			container: () => {
				const part = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
				// put away, the pane has no size (the layout's isVisible says false for the side pane on screen)
				const box = part?.getBoundingClientRect();
				return part && box && box.width > 0 && box.height > 0 ? part : undefined;
			},
			pillShown: () => this._walk.pillShown.get() ? 1 : 0,
			// 8 over the side chat's folded head at the side pane's bottom (task-5im8n)
			floor: () => cornerFloor(this.cardMode(), mainWindow.innerWidth),
			activate: (_key, card) => void this.ask(card),
			dismissed: key => { const g = this._groups.get(key); if (g) { g.dismissed = true; } },
		}));

		// the session on screen: its conversation is watched, the cards of another one go
		this._register(autorun(reader => {
			const session = this._sessionsService.activeSession.read(reader);
			session?.mainChat.read(reader);
			this.attach(session);
		}));
		// the conversation's model comes after the session is on screen; a turn's calls finish without a word to the
		// response: looked at again every 700ms while a turn runs
		const timer = mainWindow.setInterval(() => {
			if (this._session && (!this._model || this._model !== this._chatService.getSession(this._session.mainChat.get().resource))) {
				this.attach(this._session);
			}
			if (this._boundResponse && (this._boundResponse.isIncomplete.get() || this._pending)) {
				this.scan();
			}
		}, 700);
		this._register(toDisposable(() => mainWindow.clearInterval(timer)));

		// Quiet: every card goes; the side chat card opened over the corner: the cards go too
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LEARN_MODE_SETTING) && this.mode() === 'quiet') {
				this._cards.clear();
			}
		}));
		this._register(autorun(reader => {
			this._sideChats.cards.read(reader);
			this._walk.pillShown.read(reader);
			// the side chat card or a walk (task-fktjx) took the corner: the cards go
			if (this.cardMode() === 'open' || this._walk.walking.read(reader)) {
				this._cards.clear();
			} else {
				this._cards.layout();
			}
		}));
	}

	private mode() {
		return learnMode(this._configurationService.getValue(LEARN_MODE_SETTING));
	}

	/** The side chat card of the session on screen: open, folded into its pill, or not there. */
	private cardMode(): 'open' | 'min' | undefined {
		const id = this._session?.sessionId;
		const card = id ? this._sideChats.cards.get().get(id) : undefined;
		return card?.mode === 'open' || card?.mode === 'min' ? card.mode : undefined;
	}

	private attach(session: IActiveSession | undefined): void {
		const model = session ? this._chatService.getSession(session.mainChat.get().resource) : undefined;
		// the session on screen comes as a new object now and then: it is the same session by its id
		if (session?.sessionId === this._session?.sessionId && model === this._model) {
			this._session = session;
			return;
		}
		if (session?.sessionId !== this._session?.sessionId) {
			this._cards.clear();
			this._groups.clear();
		}
		this._session = session;
		this._model = model;
		this._boundResponse = undefined;
		this._response.clear();
		const store = new DisposableStore();
		this._watch.value = store;
		if (!model) {
			return;
		}
		// what is there now was said before this window looked; a turn that began just now is live (a new session's first
		// message is in its conversation before the conversation is on screen)
		const last = model.lastRequest;
		if (last?.response?.isIncomplete.get() && Date.now() - last.timestamp < LIVE_WINDOW_MS) {
			this._live.add(last.id);
		}
		for (const request of model.getRequests()) {
			if (this._live.has(request.id)) {
				continue;
			}
			for (const part of request.response?.response.value ?? []) {
				const id = partId(part);
				if (id) {
					this._seen.add(id);
				}
			}
		}
		store.add(model.onDidChange(e => {
			if (e.kind === 'addRequest') {
				this._live.add(e.request.id);
			}
			this.bind();
		}));
		this.bind();
	}

	/** Follows the last reply of the conversation. */
	private bind(): void {
		const response = this._model?.lastRequest?.response;
		if (response === this._boundResponse) {
			return;
		}
		this._boundResponse = response;
		const store = new DisposableStore();
		this._response.value = store;
		if (response) {
			store.add(response.onDidChange(() => this.scan()));
			this.scan();
		}
	}

	private scan(): void {
		if (this._scanning) {
			this._again = true;
			return;
		}
		this._scanning = true;
		this.read().catch(err => this._logService.error('[dispatch] learn: reading the turn failed', err)).finally(() => {
			this._scanning = false;
			if (this._again) {
				this._again = false;
				this.scan();
			}
		});
	}

	private async read(): Promise<void> {
		const session = this._session, request = this._model?.lastRequest, response = request?.response;
		if (!session || !request || !response || !this._live.has(request.id)) {
			this._pending = false;
			return;
		}
		const parts = response.response.value;
		const folders = session.workspace.get()?.folders ?? [];
		const ctx: ITurnContext = {
			parts,
			start: request.timestamp,
			roots: localRoots(folders.flatMap(f => [f.workingDirectory, f.gitRepository?.workTreeUri, f.root])),
			fileService: this._fileService,
		};
		let pending = false;
		const found: ILearnEvent[] = [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const id = partId(part);
			if (!id || this._seen.has(id)) {
				continue;
			}
			if (part.kind === 'toolInvocation' && !IChatToolInvocation.isComplete(part)) {
				pending = true;
				continue;
			}
			this._seen.add(id);
			if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
				found.push(...await eventsOfCall(part, i, ctx));
			} else if (part.kind === 'externalEdit') {
				const e = await eventsOfEdit(part.uri, part.editKind, i, ctx);
				if (e) {
					found.push(e);
				}
			}
		}
		this._pending = pending;
		if (found.length) {
			this._logService.trace(`[dispatch] learn: ${request.id} did ${JSON.stringify(found.map(e => [e.kind, e.subject]))}`);
		}
		if (session.sessionId !== this._session?.sessionId) {
			return;
		}
		for (const kind of ['create', 'install', 'delete'] as LearnKind[]) {
			const more = found.filter(e => e.kind === kind && shouldTalk('talk', e, NO_KNOWN_WORDS));
			if (more.length) {
				this.add(`${request.id}:${kind}`, kind, more);
			}
		}
	}

	private add(key: string, kind: LearnKind, more: ILearnEvent[]): void {
		const group = this._groups.get(key) ?? { events: [], dismissed: false };
		group.events = mergeEvents(group.events, more);
		this._groups.set(key, group);
		if (group.dismissed || this.mode() === 'quiet' || this.cardMode() === 'open' || this._walk.walking.get()) {
			return;
		}
		this._cards.show(key, cardFor(kind, group.events));
	}

	/** A click on a card: a side chat about the file or the command; where side chats are not there, a quote. */
	private async ask(card: ILearnCard): Promise<void> {
		const session = this._session;
		if (!session) {
			return;
		}
		const { text, where } = askText(card);
		const file = card.kind !== 'install' && card.events.length === 1 ? card.events[0].subject : '';
		if (session.capabilities.get().supportsSideChat) {
			const ask: ISideChatAsk = {
				selection: `${where}\n${text}`,
				passage: { path: card.kind === 'create' ? file : '', start: 1, end: 1, text, inDocs: false, from: 'learn', where },
			};
			await this._commandService.executeCommand(DISPATCH_SIDE_CHAT_ASK_COMMAND, ask);
			return;
		}
		const widget = this._chatWidgetService.getWidgetBySessionResource(session.mainChat.get().resource);
		if (!widget) {
			return;
		}
		const icon = card.kind === 'install' ? Codicon.package.id : card.kind === 'delete' ? Codicon.trash.id : Codicon.newFile.id;
		addQuoteToWidget(widget, toQuoteEntry(text, file && card.kind === 'create'
			? { from: 'file', label: where, icon, uri: URI.file(file).toString(), file: card.events[0].rel ?? file, startLine: 1, endLine: 1 }
			: { from: 'file', label: where, icon, file: where }));
	}
}

function partId(part: { kind: string; toolCallId?: string; uri?: URI; editKind?: string }): string | undefined {
	if (part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') {
		return part.toolCallId;
	}
	if (part.kind === 'externalEdit' && part.uri) {
		return `edit:${part.uri.toString()}:${part.editKind}`;
	}
	return undefined;
}

registerWorkbenchContribution2(DispatchLearn.ID, DispatchLearn, WorkbenchPhase.AfterRestored);
