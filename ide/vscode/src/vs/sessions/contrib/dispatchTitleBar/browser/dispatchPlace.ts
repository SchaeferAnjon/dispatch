/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "where you are" in the middle of the title bar (patches/110-title-bar.patch, kanban
 *  design/bars direction B, "在哪"): the folder, ›, the session's name and its state block, and a click opens this
 *  session's menu: its side chats on top (each opens in its card in the side pane, task-23iin), Rename…, Open in Editor,
 *  Copy Link, the session's own ⋯ actions (New Chat in This Session, Show Chat Tabs, Pin, Close), Archive, and Switch
 *  Session… for the list it used to open.
 *  On the new session page it says "<folder> › New session" and a click still lists the sessions.
 *
 *  The title bar's own widget (contrib/sessions/browser/sessionsTitleBarWidget.ts) draws its usual pill for the
 *  states that need you (sessions waiting for input, approvals); for an active session it hands the drawing here.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTitleBar.css';
import * as DOM from '../../../../base/browser/dom.js';
import { dispatchStateBlocks } from '../../../browser/dispatchStatusBlocks.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ANY_AGENT_HOST_PROVIDER_RE } from '../../../common/agentHostSessionsProvider.js';
import { ARCHIVE_SESSION_COMMAND_ID, COPY_AGENT_HOST_SESSION_LINK_COMMAND_ID } from '../../../common/sessionCommands.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { setActiveSessionContextKeys } from '../../../services/sessions/common/sessionContextKeys.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { DispatchBlockState, stateBlock } from '../../dispatchBlocks/browser/dispatchBlocks.js';
import { isSessionConversationSideChat } from '../../../browser/sessionConversationGroups.js';
import { DISPATCH_SIDE_CHAT_OPEN_COMMAND, IDispatchSideChatService } from '../../dispatchSideChat/browser/dispatchSideChatService.js';
import { fileName } from '../../dispatchSideChat/common/dispatchSideChatModel.js';
import { stateMark } from '../../dispatchBlocks/browser/dispatchMarks.js';
import { DISPATCH_OPEN_IN_EDITOR } from './dispatchEditorEntry.js';

const RENAME = 'sessions.sessionHeader.rename';
const SWITCH = 'sessions.showSessionsPicker';

/** What the title bar knows about the place: the folder's name and icon. */
export interface IDispatchPlaceInfo {
	readonly folder: string | undefined;
	readonly folderIcon: ThemeIcon | undefined;
}

/** The title bar widget's hook: draws "where you are" into `container` and returns true, or false to draw its own. */
export const dispatchPlaceHook: { render?: (container: HTMLElement, info: IDispatchPlaceInfo, store: DisposableStore) => boolean } = {};

/** A session's state in the title bar: working the breathing block; waiting, stopped and done the session row's marks. */
export function placeState(status: SessionStatus): DispatchBlockState | undefined {
	switch (status) {
		case SessionStatus.InProgress: return 'working';
		case SessionStatus.NeedsInput: return 'waiting';
		case SessionStatus.Completed: return 'done';
		case SessionStatus.Error: return 'stopped';
		default: return undefined;
	}
}

class DispatchPlace extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchPlace';

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IDispatchSideChatService private readonly sideChatService: IDispatchSideChatService,
	) {
		super();
		dispatchPlaceHook.render = (container, info, store) => this.render(container, info, store);
		this._register({ dispose: () => { dispatchPlaceHook.render = undefined; } });
	}

	private render(container: HTMLElement, info: IDispatchPlaceInfo, store: DisposableStore): boolean {
		const session = this.sessionsService.activeSession.get();
		if (!session) {
			return false;
		}
		let created = false;
		const pill = DOM.append(container, DOM.$('div.agent-sessions-titlebar-pill.dispatch-place'));
		pill.dataset.part = 'title-place';
		const row = DOM.append(pill, DOM.$('div.agent-sessions-titlebar-center.dispatch-place-row'));
		if (info.folder) {
			const fo = DOM.append(row, DOM.$('span.dispatch-place-folder'));
			DOM.append(fo, DOM.$(`span.dispatch-place-folder-ic${ThemeIcon.asCSSSelector(info.folderIcon ?? Codicon.folder)}`, { 'aria-hidden': 'true' }));
			DOM.append(fo, DOM.$('span.dispatch-place-folder-t', undefined, info.folder));
			DOM.append(row, DOM.$('span.dispatch-place-sep', { 'aria-hidden': 'true' }, '›'));
		}
		const title = DOM.append(row, DOM.$('span.dispatch-place-title'));
		const mark = DOM.append(row, DOM.$('span.dispatch-place-state'));
		const chev = DOM.append(row, DOM.$(`span.dispatch-place-chev${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`, { 'aria-hidden': 'true' }));
		let shownState: DispatchBlockState | undefined | null = null;
		store.add(autorun(reader => {
			// a new session becomes a session with its first message: the same pill, now with its menu
			created = session.isCreated.read(reader);
			pill.classList.toggle('created', created);
			chev.hidden = !created;
			const name = created ? (session.title.read(reader) || localize('dispatchPlace.untitled', "New session")) : localize('dispatchPlace.new', "New session");
			title.textContent = name;
			const state = created ? placeState(session.status.read(reader)) : undefined;
			if (state !== shownState) {
				shownState = state;
				DOM.clearNode(mark);
				if (state) {
					// waiting and stopped look as they do on the session's row: VS Code's filled circle in amber or coral; done is
					// the filled check in grey, the session being open is read (DESIGN.md「符号表」, task-o01fh)
					const rowMark = state === 'done' ? stateMark('seen') : state === 'waiting' || state === 'stopped' ? dispatchStateBlocks.render?.(state, false) : undefined;
					// the title next to it says which session; the row's words ("not read yet") are not true of the one open here
					for (const attr of ['title', 'role', 'aria-label']) {
						rowMark?.removeAttribute(attr);
					}
					rowMark?.setAttribute('aria-hidden', 'true');
					mark.appendChild(rowMark ?? stateBlock(state, { size: 12, breathe: state === 'working', title: '' }));
				}
			}
			const where = info.folder ? `${info.folder} › ${name}` : name;
			// the new session page keeps VS Code's own words: a click there still lists the sessions
			container.setAttribute('aria-label', created
				? localize('dispatchPlace.label', "{0}: rename, open in the editor, archive", where)
				: localize('dispatchPlace.labelNew', "Show Sessions: {0}", info.folder ?? name));
		}));
		store.add(this.hoverService.setupDelayedHover(pill, () => ({
			content: created
				? localize('dispatchPlace.tip', "This session: rename, open in the editor, archive")
				: localize('dispatchPlace.tipNew', "Show sessions"),
		})));
		const open = () => created ? this.showMenu(pill, session) : void this.commandService.executeCommand(SWITCH);
		store.add(DOM.addDisposableGenericMouseDownListener(pill, e => {
			e.preventDefault();
			e.stopPropagation();
		}));
		store.add(DOM.addDisposableListener(pill, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			open();
		}));
		store.add(DOM.addDisposableListener(container, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
				DOM.EventHelper.stop(e, true);
				open();
			}
		}));
		return true;
	}

	private showMenu(anchor: HTMLElement, session: IActiveSession): void {
		const run = (id: string, ...args: unknown[]) => async () => {
			try {
				await this.commandService.executeCommand(id, ...args);
			} catch (e) {
				this.notificationService.error(e);
			}
		};
		const actions = [
			new Action('dispatch.place.rename', localize('dispatchPlace.rename', "Rename…"), ThemeIcon.asClassName(Codicon.edit), true, run(RENAME, session)),
			new Action('dispatch.place.editor', localize('dispatchPlace.editor', "Open in Editor"), ThemeIcon.asClassName(Codicon.code), true, run(DISPATCH_OPEN_IN_EDITOR)),
		];
		if (ANY_AGENT_HOST_PROVIDER_RE.test(session.providerId)) {
			actions.push(new Action('dispatch.place.link', localize('dispatchPlace.link', "Copy Link"), ThemeIcon.asClassName(Codicon.link), true, run(COPY_AGENT_HOST_SESSION_LINK_COMMAND_ID, session)));
		}
		// the session's own ⋯ menu (Menus.SessionBarToolbar: New Chat in This Session, Side Chats, Show Chat Tabs, Pin,
		// Close, …) lived on the title row above the conversation; with one session on screen that row is gone
		// (task-wdjpl), so its actions come here, the same actions under the same session keys the row had
		const keys = this.contextKeyService.createScoped(DOM.$('div'));
		setActiveSessionContextKeys(session, keys, undefined);
		const more: IAction[] = [];
		for (const [group, items] of this.menuService.getMenuActions(Menus.SessionBarToolbar, keys, { arg: session, shouldForwardArgs: true })) {
			// navigation is the row's inline icons (Pin while pinned), the same actions as below; Rename and Archive are above;
			// the Side Chats submenu is the group of side chats on top (task-23iin)
			const kept = group === 'navigation' ? [] : items.filter(a => a.id !== RENAME && a.id !== ARCHIVE_SESSION_COMMAND_ID && a.id !== `submenuitem.${Menus.SessionConversations.id}`);
			if (kept.length) {
				more.push(new Separator(), ...kept);
			}
		}
		const tail: IAction[] = [];
		if (!session.isArchived.get()) {
			tail.push(new Separator(), new Action('dispatch.place.archive', localize('dispatchPlace.archive', "Archive"), ThemeIcon.asClassName(Codicon.archive), true, run(ARCHIVE_SESSION_COMMAND_ID, session)));
		}
		tail.push(new Separator(), new Action('dispatch.place.switch', localize('dispatchPlace.switch', "Switch Session…"), ThemeIcon.asClassName(Codicon.listUnordered), true, run(SWITCH)));
		// the session's side chats, on top (direction A of design/side-chat, task-23iin): one opens in its card in the side
		// pane; a closed card comes back from here
		const sideChats: IAction[] = [];
		const asked = session.chats.get().filter(c => isSessionConversationSideChat(c) && c.status.get() !== SessionStatus.Untitled);
		if (asked.length && !session.isArchived.get()) {
			sideChats.push(new Action('dispatch.place.sideChatsHead', localize('dispatchPlace.sideChats', "Side chats"), undefined, false));
			for (const c of asked) {
				const passage = this.sideChatService.passageOf(c.resource);
				const title = c.title.get() || localize('dispatchPlace.untitledSideChat', "Untitled side chat");
				sideChats.push(new Action(`dispatch.place.sideChat.${c.resource.toString()}`, passage ? `${title} · ${fileName(passage.path)}` : title,
					ThemeIcon.asClassName(Codicon.commentDiscussion), true, run(DISPATCH_SIDE_CHAT_OPEN_COMMAND, session.sessionId, c.resource.toString())));
			}
			sideChats.push(new Separator());
		}
		anchor.classList.add('open');
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [...sideChats, ...actions, ...more, ...tail],
			getKeyBinding: action => action.id === 'dispatch.place.switch' ? this.keybindingService.lookupKeybinding(SWITCH) : action.id === 'dispatch.place.rename' ? this.keybindingService.lookupKeybinding(RENAME) : this.keybindingService.lookupKeybinding(action.id),
			onHide: () => {
				anchor.classList.remove('open');
				keys.dispose();
			},
		});
	}
}

registerWorkbenchContribution2(DispatchPlace.ID, DispatchPlace, WorkbenchPhase.BlockRestore);
