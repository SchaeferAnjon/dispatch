/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Ask Question on the terminal's output (task-q9x2r, kanban design/learn-scene frame 3). Words selected
 *  with the mouse in the terminal under the conversation bring up the box a reply's selection does (the output is read,
 *  not edited, as a reply is): Quote, a line, then Ask Question to type in. Enter opens the side chat card on those
 *  words with the question (its quote says Terminal); Quote puts them in the conversation's input as a quote card. The
 *  box sits 6 under the selection, its left edge at where the selection starts, as the reply's does.
 *--------------------------------------------------------------------------------------------*/

import '../../agentFeedback/browser/media/dispatchQuote.css';
import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { FeedbackInputWidget } from '../../agentFeedback/browser/feedbackInputWidget.js';
import { addQuoteToWidget, askLabel, quoteIcon, quoteLabel, quoteTitle, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { DISPATCH_SIDE_CHAT_ASK_COMMAND, ISideChatAsk } from '../../dispatchSideChat/browser/dispatchSideChatAsk.js';

class DispatchTerminalAsk extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchTerminalAsk';

	private readonly _box: FeedbackInputWidget;
	private readonly _host: HTMLElement;
	private readonly _instances = this._register(new DisposableMap<number, DisposableStore>());
	/** The terminal and the words the box is for. */
	private _for: { readonly instance: ITerminalInstance; readonly text: string } | undefined;
	/** Where the selection started and where the mouse came up, to put the box under it. */
	private _at: { x: number; y: number } | undefined;
	private _down: { x: number; y: number } | undefined;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ICommandService private readonly _commandService: ICommandService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		this._host = dom.$('.dispatch-terminal-ask', { 'data-part': 'terminal-ask' });
		layoutService.mainContainer.appendChild(this._host);
		this._register(toDisposable(() => this._host.remove()));

		this._box = this._register(new FeedbackInputWidget({
			placeholder: askLabel(),
			ariaLabel: localize('dispatchLearn.terminalAskAria', "Ask a question about the selected terminal output"),
			getMaxContentWidth: () => Math.min(560, mainWindow.innerWidth - 32),
			primaryAction: { label: askLabel(), icon: Codicon.arrowUpCompact, keybindingLabel: localize('dispatchLearn.enter', "Enter") },
			// as the reply's box: Quote in front, the field is Ask Question
			leadingActions: [{ id: 'quote', label: quoteLabel(), icon: quoteIcon, title: quoteTitle(), run: () => this.quote() }],
		}));
		this._host.appendChild(this._box.domNode);
		this._register(this._box.onDidTriggerPrimary(() => this.ask()));
		this._register(dom.addStandardDisposableListener(this._box.inputElement, 'keydown', e => {
			if (e.keyCode === KeyCode.Escape) {
				dom.EventHelper.stop(e, true);
				this.hide();
				this._for?.instance.focus();
				return;
			}
			if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.browserEvent.isComposing) {
				dom.EventHelper.stop(e, true);
				this.ask();
			}
		}));
		this._register(dom.addStandardDisposableListener(this._box.inputElement, 'input', () => {
			this._box.autoSize();
			this._box.updateActionEnabled();
		}));
		// a click anywhere else closes it (the terminal keeps its selection)
		this._register(dom.addDisposableListener(mainWindow.document, 'mousedown', e => {
			if (this._for && !this._host.contains(e.target as Node)) {
				this.hide();
			}
		}, true));

		for (const instance of this._terminalService.instances) {
			this.watch(instance);
		}
		this._register(this._terminalService.onDidCreateInstance(i => this.watch(i)));
		this._register(this._terminalService.onDidDisposeInstance(i => {
			this._instances.deleteAndDispose(i.instanceId);
			if (this._for?.instance === i) {
				this.hide();
			}
		}));
	}

	private watch(instance: ITerminalInstance): void {
		if (this._instances.has(instance.instanceId)) {
			return;
		}
		const store = new DisposableStore();
		this._instances.set(instance.instanceId, store);
		store.add(dom.addDisposableListener(mainWindow.document, 'mousedown', e => {
			const el = instance.domElement;
			if (el?.isConnected && el.contains(e.target as Node) && e.button === 0) {
				this._down = { x: e.clientX, y: e.clientY };
			}
		}, true));
		// the box comes when the mouse comes up on a selection, never mid-drag
		store.add(dom.addDisposableListener(mainWindow.document, 'mouseup', e => {
			const el = instance.domElement;
			if (!el || !el.isConnected || !el.contains(e.target as Node) || e.button !== 0) {
				return;
			}
			this._at = { x: e.clientX, y: e.clientY };
			// xterm settles its selection after the mouseup
			setTimeout(() => this.showFor(instance), 0);
		}, true));
		store.add(instance.onDidChangeSelection(() => {
			if (this._for?.instance === instance && !instance.hasSelection()) {
				this.hide();
			}
		}));
	}

	private showFor(instance: ITerminalInstance): void {
		const text = instance.hasSelection() ? instance.selection ?? '' : '';
		if (!text.trim() || !this._at) {
			if (this._for?.instance === instance) {
				this.hide();
			}
			return;
		}
		this._for = { instance, text };
		this._box.clearInput();
		this._box.show();
		this._box.autoSize();
		this._box.updateActionEnabled();
		// 6 under the selection's last row, its left edge where the selection starts; above it when there is no room
		const font = instance.xterm?.getFont();
		const row = font ? Math.round((font.charHeight ?? font.fontSize) * font.lineHeight) : 18;
		const down = this._down ?? this._at, up = this._at;
		const start = down.y < up.y - row / 2 || (Math.abs(down.y - up.y) <= row / 2 && down.x <= up.x) ? down : up;
		const bottom = Math.max(down.y, up.y) + row / 2;
		const w = this._box.domNode.offsetWidth, h = this._box.domNode.offsetHeight;
		const left = Math.max(8, Math.min(start.x, mainWindow.innerWidth - w - 8));
		let top = bottom + 6;
		if (top + h > mainWindow.innerHeight - 8) {
			top = Math.max(8, Math.min(down.y, up.y) - row / 2 - h - 6);
		}
		this._box.domNode.style.left = `${left}px`;
		this._box.domNode.style.top = `${top}px`;
	}

	private hide(): void {
		this._for = undefined;
		this._box.hide();
	}

	private ask(): void {
		const f = this._for;
		if (!f) {
			return;
		}
		const ask: ISideChatAsk = {
			selection: `Terminal\n${f.text}`,
			passage: { path: '', start: 0, end: 0, text: f.text, inDocs: false, from: 'terminal' },
			question: this._box.inputElement.value.trim(),
		};
		this.hide();
		void this._commandService.executeCommand(DISPATCH_SIDE_CHAT_ASK_COMMAND, ask);
	}

	private quote(): void {
		const f = this._for;
		const session = this._sessionsService.activeSession.get();
		const widget = session && this._chatWidgetService.getWidgetBySessionResource(session.activeChat.get().resource);
		if (!f || !widget) {
			return;
		}
		this.hide();
		addQuoteToWidget(widget, toQuoteEntry(f.text, { from: 'file', label: localize('dispatchLearn.terminal', "Terminal"), icon: Codicon.terminal.id, file: localize('dispatchLearn.terminal', "Terminal") }));
	}
}

registerWorkbenchContribution2(DispatchTerminalAsk.ID, DispatchTerminalAsk, WorkbenchPhase.AfterRestored);
