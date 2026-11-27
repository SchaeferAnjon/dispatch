/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: where a chat would be, a terminal session shows its terminal.
 *
 *  The session view asks the views registered with `registerDispatchSessionView` (browser/dispatchSessionViews.ts)
 *  before it builds a chat. This one answers for the terminal sessions (dispatchTerminalSessionsProvider.ts) and
 *  puts the session's screen (dispatchTerminalController.ts) in the whole area. The screen outlives the view:
 *  showing the session again reuses it.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTerminalView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { $ } from '../../../../base/browser/dom.js';
import { chatUnavailableReason, DispatchTerminalChat } from './dispatchTerminalChat.js';
import { ISubAgent, PaneLayout, paneIds } from './dispatchTerminalModel.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

const BAR_HEIGHT = 32;
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractChatView, ChatViewKind } from '../../../browser/parts/chatView.js';
import { registerDispatchSessionView } from '../../../browser/dispatchSessionViews.js';
import { registerDispatchRowMark } from '../../../browser/dispatchSessionRowMarks.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { autorun } from '../../../../base/common/observable.js';
import { modelLabel, registerSubAgentOpener } from '../../../browser/dispatchSubAgents.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { DISPATCH_TERMINAL_PROVIDER_ID, DispatchTerminalSession, DispatchTerminalSessionsProvider } from './dispatchTerminalSessionsProvider.js';
import { DispatchTerminalPanes } from './dispatchTerminalPanes.js';
import { stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';

export class DispatchTerminalView extends AbstractChatView {
	readonly kind: ChatViewKind = 'chat';

	private readonly _host: HTMLElement;
	private _visible = false;
	private _shown = false;

	private readonly _bar: HTMLElement;
	private readonly _chat: DispatchTerminalChat;
	private readonly _tabs: { chat: HTMLButtonElement; terminal: HTMLButtonElement };
	private _size: { width: number; height: number } | undefined;

	private readonly _panes: DispatchTerminalPanes;

	constructor(private readonly _session: DispatchTerminalSession, instantiation: IInstantiationService, _provider: DispatchTerminalSessionsProvider) {
		super();
		this.element.classList.add('dispatch-terminal-view');
		// "Chat / Terminal": two views of the same session, the agent keeps running (direction A, A4)
		this._bar = $('.dispatch-terminal-bar');
		this.element.appendChild(this._bar);
		const sw = DOM.append(this._bar, $('.dispatch-terminal-switch'));
		sw.setAttribute('role', 'tablist');
		this._tabs = {
			chat: DOM.append(sw, $<HTMLButtonElement>('button.dts-tab', { type: 'button', role: 'tab' })),
			terminal: DOM.append(sw, $<HTMLButtonElement>('button.dts-tab', { type: 'button', role: 'tab' })),
		};
		this._tabs.chat.textContent = 'Chat';
		this._tabs.terminal.textContent = 'Terminal';
		const why = chatUnavailableReason(_session);
		this._tabs.chat.disabled = !!why;
		this._tabs.chat.title = why ?? 'The same conversation as a chat; the agent keeps running in the terminal';
		// either tab leaves a sub-agent's record and shows the session itself again
		this._register(DOM.addDisposableListener(this._tabs.chat, DOM.EventType.CLICK, () => { _session.reading.set(undefined, undefined); this._setMode('chat'); }));
		this._register(DOM.addDisposableListener(this._tabs.terminal, DOM.EventType.CLICK, () => { _session.reading.set(undefined, undefined); this._setMode('terminal'); }));
		this._subs = DOM.append(this._bar, $('.dispatch-terminal-subs'));
		this._bar.insertBefore(this._subs, sw);
		// the session's own terminals as tabs (direction A, A5): its agent's, the shells it opened, "+ Shell", and
		// side by side or one at a time
		this._paneTabs = $('.dispatch-terminal-tabs');
		this._bar.insertBefore(this._paneTabs, this._subs);
		this._register(autorun(reader => this._drawPaneTabs(_session.layout.read(reader), _session.focusedPane.read(reader), _session.expanded.read(reader), _provider)));
		this._host = $('.dispatch-terminal-host');
		this.element.appendChild(this._host);
		// the sub-agents it sent out, as blocks: purple while one works, teal when it came back (the provider reads
		// them from Claude Code's record; the sessions list shows them as rows under the session too)
		this._register(autorun(reader => this._drawSubAgents(_session.subAgentList.read(reader))));
		this._chat = this._register(instantiation.createInstance(DispatchTerminalChat, _session));
		// a sub-agent opened from its row under the session: its own record, read only, in the chat view
		this._register(this._chat.onDidRequestBack(() => _session.reading.set(undefined, undefined)));
		let reading = false;
		this._register(autorun(reader => {
			const sub = _session.reading.read(reader);
			if (sub) {
				reading = true;
				const model = modelLabel(sub.modelId.read(reader));
				const status = sub.status.read(reader);
				const state = status === SessionStatus.InProgress ? 'Working' : status === SessionStatus.Error ? 'Stopped' : 'Done';
				this._chat.showRecord({ file: sub.file ?? '', title: sub.title.read(reader), detail: ['Sub-agent', model, state].filter(Boolean).join(' · ') });
				this._setMode('chat', true);
			} else if (reading) {
				reading = false;
				this._chat.showRecord(undefined);
				this._setMode(this._session.controller.viewMode);
			}
		}));
		this.element.appendChild(this._chat.element);
		this._register(this._session.controller.onAway(away => this._showAway(away)));
		this._register(this._session.controller.onDidRequestView(mode => this._setMode(mode)));
		if (this._session.controller.away) {
			this._showAway(this._session.controller.away);
		}
		this._setMode(this._session.controller.viewMode === 'chat' && !why ? 'chat' : 'terminal');
		// the session's panes (one terminal, or several side by side: dispatchTerminalPanes.ts)
		this._panes = this._register(instantiation.createInstance(DispatchTerminalPanes, _session, this._host, layout => _provider.setPaneSizes(_session, layout), (id, target, side) => _provider.movePane(_session, id, target, side)));
		void this._panes.ready.then(() => {
			this._shown = true;
			if (this._visible) {
				this._panes.focus();
			}
		});
	}

	/** One line over the terminal: it kept running while Dispatch was closed, from when to when. */
	private _showAway(away: { from: number; to: number }): void {
		const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		const banner = $('.dispatch-terminal-banner');
		banner.setAttribute('role', 'status');
		banner.textContent = `Dispatch reopened. This terminal kept running while Dispatch was closed, ${time(away.from)} to ${time(away.to)}. Nothing was lost.`;
		this.element.appendChild(banner);
		const remove = () => banner.remove();
		banner.addEventListener('click', remove);
		const timer = setTimeout(remove, 12000);
		this._register({ dispose: () => { clearTimeout(timer); remove(); } });
		this._session.controller.away = undefined;
	}

	private readonly _subs: HTMLElement;

	private readonly _paneTabs: HTMLElement;
	private readonly _paneTabsStore = this._register(new DisposableStore());

	private _drawPaneTabs(layout: PaneLayout, focused: string, expanded: string | undefined, provider: DispatchTerminalSessionsProvider): void {
		this._paneTabsStore.clear();
		DOM.clearNode(this._paneTabs);
		const ids = paneIds(layout);
		const tabs = DOM.append(this._paneTabs, $('.dtt-list'));
		tabs.setAttribute('role', 'tablist');
		ids.forEach((id, i) => {
			const own = id === this._session.id;
			const tab = DOM.append(tabs, $<HTMLButtonElement>('button.dtt-tab', { type: 'button', role: 'tab' }));
			tab.textContent = own ? (this._session.agent?.name ?? 'Terminal') : (ids.length > 2 ? `Shell ${i}` : 'Shell');
			const on = ids.length > 1 && id === (expanded ?? focused);
			tab.classList.toggle('on', on);
			tab.setAttribute('aria-selected', String(on));
			tab.title = own ? 'This session\'s own terminal' : 'A shell this session opened; it closes with the session';
			this._paneTabsStore.add(DOM.addDisposableListener(tab, DOM.EventType.CLICK, () => {
				// one at a time: the tab's terminal takes the space; side by side: the keyboard goes to it
				if (this._session.expanded.get() && this._session.expanded.get() !== id) {
					this._session.toggleExpanded(id);
				}
				this._session.paneController(id)?.focus();
			}));
		});
		const add = DOM.append(this._paneTabs, $<HTMLButtonElement>('button.dtt-add', { type: 'button' }));
		DOM.append(add, $(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		DOM.append(add, $('span')).textContent = 'Shell';
		add.title = 'Open a shell for this session in the same folder (⌘D)';
		this._paneTabsStore.add(DOM.addDisposableListener(add, DOM.EventType.CLICK, () => {
			const from = this._session.paneController(this._session.focusedPane.get()) ?? this._session.controller;
			void provider.splitPane(this._session, from, 'row');
		}));
		if (ids.length > 1) {
			const toggle = DOM.append(this._paneTabs, $<HTMLButtonElement>('button.dtt-layout', { type: 'button' }));
			const one = !!expanded;
			DOM.append(toggle, $(`span${ThemeIcon.asCSSSelector(one ? Codicon.splitHorizontal : Codicon.screenNormal)}`));
			toggle.title = one ? 'Side by side (⇧⌘Enter)' : 'One at a time (⇧⌘Enter)';
			toggle.setAttribute('aria-label', toggle.title);
			this._paneTabsStore.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
				this._session.toggleExpanded(this._session.focusedPane.get());
				(this._session.paneController(this._session.focusedPane.get()) ?? this._session.controller).focus();
			}));
		}
	}

	private _drawSubAgents(subs: readonly ISubAgent[]): void {
		DOM.clearNode(this._subs);
		if (!subs.length) {
			return;
		}
		const working = subs.filter(s => !s.done).length;
		// Dispatch's own blocks (contrib/dispatchBlocks): the purple sub-agent block breathing while one works, done once back
		const blocks = DOM.append(this._subs, $('span.dts-blocks'));
		for (const s of subs.slice(-16)) {
			blocks.appendChild(stateBlock(s.done ? (s.failed ? 'stopped' : 'done') : 'sub-agent', { size: 12, breathe: !s.done, title: '' }));
		}
		DOM.append(this._subs, $('span.dts-subs-text')).textContent = working ? `${subs.length} sub-agents, ${working} working` : `${subs.length} sub-agents, all done`;
		this._subs.title = subs.map(s => `${s.done ? 'Done' : 'Working'}: ${s.name}${s.kind ? ` (${s.kind})` : ''}`).join('\n');
	}

	private _setMode(mode: 'chat' | 'terminal', record = false): void {
		if (mode === 'chat' && this._tabs.chat.disabled && !record) {
			return;
		}
		if (!record) {
			this._session.controller.viewMode = mode;
		}
		this._tabs.chat.classList.toggle('on', mode === 'chat');
		this._tabs.terminal.classList.toggle('on', mode === 'terminal');
		this._tabs.chat.setAttribute('aria-selected', String(mode === 'chat'));
		this._tabs.terminal.setAttribute('aria-selected', String(mode === 'terminal'));
		this._host.style.display = mode === 'terminal' ? '' : 'none';
		this._chat.setVisible(mode === 'chat');
		if (mode === 'terminal') {
			if (this._size) {
				this._panes?.layout(this._size.width, this._size.height);
			}
			this._panes?.focus();
		}
	}

	protected doLayout(width: number, height: number): void {
		if (width <= 0 || height <= 0) {
			return;
		}
		const h = Math.max(0, height - BAR_HEIGHT);
		this._size = { width, height: h };
		this._host.style.width = `${width}px`;
		this._host.style.height = `${h}px`;
		this._chat.element.style.height = `${h}px`;
		this._panes.layout(width, h);
	}

	override setVisible(visible: boolean): void {
		this._visible = visible;
		this._session.viewing = visible;
		if (!visible) {
			// a sub-agent's record is read on the way: coming back shows the session itself
			this._session.reading.set(undefined, undefined);
		}
		if (visible) {
			// on screen: what it had for the person has been seen (the bell hears this through isRead)
			this._session.setRead(true);
		}
	}

	focus(): void {
		if (this._visible && this._shown && this._session.controller.viewMode !== 'chat') {
			this._panes.focus();
		}
	}

	override dispose(): void {
		// the session is no longer on screen: a turn that ends now is something new for the person
		this._session.viewing = false;
		for (const c of [this._session.controller, ...this._session.panes.values()]) {
			if (this._host.contains(c.xterm?.element ?? null)) {
				c.hide();
			}
		}
		super.dispose();
	}

	toJSON(): object {
		return { type: 'dispatchTerminal' };
	}
}

class DispatchTerminalViews extends Disposable {
	static readonly ID = 'dispatch.contrib.terminalViews';

	constructor(
		@ISessionsProvidersService providers: ISessionsProvidersService,
		@ISessionsService sessions: ISessionsService,
	) {
		super();
		// a sub-agent of a terminal session (browser/dispatchSubAgents.ts): the session opens and its view
		// shows the sub-agent's record, read only
		this._register(registerSubAgentOpener((session, chat) => {
			if (session.providerId !== DISPATCH_TERMINAL_PROVIDER_ID) {
				return false;
			}
			const own = providers.getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID)?.getTerminalSession(session.sessionId);
			const sub = own?.subAgentChat(chat.resource);
			if (!own || !sub) {
				return false;
			}
			own.reading.set(sub, undefined);
			void sessions.openSession(session.resource);
			return true;
		}));
		const registration: IDisposable = registerDispatchSessionView({
			// the session view hands over the window's wrapper of the session (VisibleSession), not the provider's own object
			create: (session: ISession, instantiationService: IInstantiationService) => {
				if (session.providerId !== DISPATCH_TERMINAL_PROVIDER_ID) {
					return undefined;
				}
				const provider = instantiationService.invokeFunction(accessor => accessor.get(ISessionsProvidersService).getProvider<DispatchTerminalSessionsProvider>(DISPATCH_TERMINAL_PROVIDER_ID));
				const own = provider?.getTerminalSession(session.sessionId);
				return provider && own ? new DispatchTerminalView(own, instantiationService, provider) : undefined;
			},
		});
		this._register(registration);
		// the row in the sessions list: the agent's mark (none for a plain shell) and >_
		this._register(registerDispatchRowMark(session => {
			if (session.providerId !== DISPATCH_TERMINAL_PROVIDER_ID) {
				return undefined;
			}
			const agentIcon = session.icon && session.icon.id !== Codicon.terminal.id ? session.icon : undefined;
			const name = session.title.get().replace(/ \(terminal(, copy)?\)$/, '');
			return { icon: agentIcon, terminal: true, label: agentIcon ? `${name} in a terminal` : 'A terminal' };
		}));
	}
}

registerWorkbenchContribution2(DispatchTerminalViews.ID, DispatchTerminalViews, WorkbenchPhase.BlockStartup);
