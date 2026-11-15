/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the new-session page on a Mac with none of the agents Dispatch runs (kanban task-6vw2,
 *  patches/245-agents-choice.patch).
 *
 *  A new Mac has no Claude Code, Codex or OpenCode. The page used to start a Claude Code session anyway and the
 *  first message waited for an answer that never came. Now the input's notification slot says so up front, in the
 *  same shell as the OpenCode version notice: "No agent on this Mac yet", one line on what each one needs, and an
 *  Install button for OpenCode and for Claude Code (`dispatch engines upgrade <id>` through dispatch-bridge: their
 *  own installer script, no Node.js needed). While it installs the notice shows the step with the wait bar; when
 *  it fails it says why and keeps a Retry. Once one is here the notice goes, the agent host offers it within
 *  seconds (agentHostMain.ts) and new sessions start with it (`effective` in `dispatch engines enabled`).
 *
 *  The state is the agent choice the window already keeps (dispatchAgents.ts: read at start and whenever the
 *  window gets focus back), so an agent installed in a Terminal also clears the notice.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotificationCommandAction, IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { getAgentChoice, loadAgentChoice, onDidChangeAgentChoice } from './dispatchAgents.js';
import { noAgentInstalled } from './dispatchAgentsModel.js';

const NOTIFICATION_ID = 'dispatch.noAgent';
const INSTALL_COMMAND = '_dispatch.noAgent.install';
const EXPLAIN_COMMAND = '_dispatch.noAgent.explain';
const NOTICE_HEIGHT_VAR = '--dispatch-notice-height';
const NOTICE_SLOT = '.new-chat-input-container > .chat-input-notification-container';
const NEW_SESSION_CONTENT = '.new-chat-widget-content';

type InstallId = 'opencode' | 'claude';
const NAMES: Record<InstallId, string> = { opencode: 'OpenCode', claude: 'Claude Code' };

interface IUpgradeAnswer {
	readonly ok?: boolean;
	readonly command?: string;
	readonly message?: string;
}

class DispatchNoAgentNotice extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchNoAgent';

	private installing: InstallId | undefined;
	private failed: { id: InstallId; message: string; command: string } | undefined;
	private layoutWatch: IDisposable | undefined;

	constructor(
		@IChatInputNotificationService private readonly notifications: IChatInputNotificationService,
		@ICommandService private readonly commands: ICommandService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(INSTALL_COMMAND, (_accessor, id: InstallId) => this.install(id)));
		// the new-session input's Enter with no agent here (newChatInput.ts): the reason, at once
		this._register(CommandsRegistry.registerCommand(EXPLAIN_COMMAND, (_accessor, reason: string) => this.notificationService.error(String(reason))));
		this._register(onDidChangeAgentChoice(() => this.publish()));
		this._register(toDisposable(() => this.layoutWatch?.dispose()));
		this.publish();
	}

	private async install(id: InstallId): Promise<void> {
		if (this.installing || (id !== 'opencode' && id !== 'claude')) {
			return;
		}
		this.installing = id;
		this.failed = undefined;
		this.publish();
		let answer: IUpgradeAnswer | undefined;
		try {
			answer = await this.commands.executeCommand<IUpgradeAnswer>('dispatch.engines', 'upgrade', id);
		} catch (error) {
			answer = { ok: false, message: String((error as Error)?.message ?? error) };
		}
		if (this._store.isDisposed) {
			return;
		}
		if (!answer?.ok) {
			this.failed = { id, message: answer?.message || localize('dispatchNoAgent.noAnswer', "Dispatch did not answer."), command: answer?.command ?? '' };
			this.log.warn(`[DispatchNoAgent] installing ${id} failed: ${this.failed.message}`);
		}
		this.installing = undefined;
		// the choice says what is here now: the notice goes once an agent is
		await loadAgentChoice(this.commands).catch(() => false);
		this.publish();
	}

	private publish(): void {
		const show = noAgentInstalled(getAgentChoice()) || !!this.installing;
		this.watchLayout(show);
		if (!show) {
			this.failed = undefined;
			this.notifications.deleteNotification(NOTIFICATION_ID);
			return;
		}
		const base = {
			id: NOTIFICATION_ID,
			severity: ChatInputNotificationSeverity.Error,
			// state, not history: it goes away when an agent is here
			dismissible: false,
			autoDismissOnMessage: false,
		} as const;
		if (this.installing) {
			this.notifications.setNotification({
				...base,
				message: localize('dispatchNoAgent.installing', "Installing {0}…", NAMES[this.installing]),
				description: localize('dispatchNoAgent.installingBody', "This takes a minute or so. The input box is ready when it is done."),
				actions: [],
				progress: true,
			});
			return;
		}
		const failed = this.failed;
		const install = (id: InstallId, primary: boolean): IChatInputNotificationCommandAction => ({
			kind: ChatInputNotificationActionKind.Command,
			label: failed?.id === id ? localize('dispatchNoAgent.retry', "Retry {0}", NAMES[id]) : localize('dispatchNoAgent.install', "Install {0}", NAMES[id]),
			commandId: INSTALL_COMMAND,
			commandArgs: [id],
			primary,
			keepOpen: true,
		});
		this.notifications.setNotification({
			...base,
			message: failed
				? localize('dispatchNoAgent.failedTitle', "{0} could not be installed", NAMES[failed.id])
				: localize('dispatchNoAgent.title', "No agent on this Mac yet"),
			description: failed
				? (failed.command
					? localize('dispatchNoAgent.failedBodyCommand', "{0} You can also run {1} in a terminal.", failed.message, failed.command)
					: failed.message)
				: localize('dispatchNoAgent.body', "Dispatch starts sessions with Claude Code, Codex or OpenCode. Install one to send your first message: OpenCode works without an account, Claude Code needs a Claude plan."),
			actions: [install('opencode', true), install('claude', false)],
		});
	}

	/**
	 * Keeps --dispatch-notice-height on the new-session page equal to the notice slot's height while the notice is up,
	 * as the OpenCode version notice does (dispatchOpenCodeVersion.contribution.ts): the input stays where it was and
	 * the notice takes the room above it.
	 */
	private watchLayout(active: boolean): void {
		if (!active) {
			this.layoutWatch?.dispose();
			this.layoutWatch = undefined;
			return;
		}
		if (this.layoutWatch) {
			return;
		}
		const doc = mainWindow.document;
		let slot: Element | null = null;
		const apply = () => {
			const height = slot?.classList.contains('chat-input-stack-docked') ? slot.getBoundingClientRect().height : 0;
			doc.querySelector<HTMLElement>(NEW_SESSION_CONTENT)?.style.setProperty(NOTICE_HEIGHT_VAR, `${height}px`);
		};
		const resize = new ResizeObserver(apply);
		const sync = () => {
			const found = doc.querySelector(NOTICE_SLOT);
			if (found !== slot) {
				if (slot) {
					resize.unobserve(slot);
				}
				slot = found;
				if (slot) {
					resize.observe(slot);
				}
			}
			apply();
		};
		const mutations = new MutationObserver(sync);
		mutations.observe(doc.body, { childList: true, subtree: true });
		sync();
		this.layoutWatch = toDisposable(() => {
			mutations.disconnect();
			resize.disconnect();
			// another notice may still be up in the slot: measure once more rather than dropping the room it takes
			const left = doc.querySelector(NOTICE_SLOT);
			const height = left?.classList.contains('chat-input-stack-docked') ? left.getBoundingClientRect().height : 0;
			const content = doc.querySelector<HTMLElement>(NEW_SESSION_CONTENT);
			if (height) {
				content?.style.setProperty(NOTICE_HEIGHT_VAR, `${height}px`);
			} else {
				content?.style.removeProperty(NOTICE_HEIGHT_VAR);
			}
		});
	}
}

registerWorkbenchContribution2(DispatchNoAgentNotice.ID, DispatchNoAgentNotice, WorkbenchPhase.AfterRestored);
