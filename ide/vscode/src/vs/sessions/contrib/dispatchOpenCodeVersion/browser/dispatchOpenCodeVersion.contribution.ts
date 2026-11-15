/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a notice above the input when the OpenCode on this machine is older than Dispatch can
 *  drive (patches/225-opencode-version.patch).
 *
 *  OpenCode 1.14.x fails every new session with 401 (its `opencode acp` sends no auth header to its own
 *  server); 1.18 fixed it. The agent host picks the first copy that is new enough (opencodeVersion.ts).
 *  When every copy is older, the harness would only answer the first message with an error, so the
 *  new-session page and OpenCode sessions say it up front, in the chat input's own notification slot
 *  (an error, as the input's other notices): "OpenCode 1.14.31 is too old" with an Upgrade button that runs
 *  `dispatch engines upgrade opencode` through dispatch-bridge, the same update the Customizations
 *  version row runs. The state comes from `dispatch.engines check` (installed versions, no npm), read
 *  at start, whenever the window gets focus back (the person may have upgraded in a terminal) and after
 *  the Upgrade button. The minimum is the CLI's (`min_version`), one number for chatd, the CLI and the IDE.
 *
 *  Layout (media/dispatchOpenCodeVersion.css): the new-session page centres its content, so a notice above
 *  the input would push the input down. While the notice shows, this contribution publishes its height as
 *  --dispatch-notice-height on the page content, and the CSS pulls the content up by that much.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchOpenCodeVersion.css';
import { mainWindow } from '../../../../base/browser/window.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { LOCAL_AGENT_HOST_SCHEME_PREFIX } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotification, IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { IEngineVersionRow, OPENCODE_ENGINE_ID, openCodeTooOld } from './dispatchOpenCodeVersionModel.js';

const NOTIFICATION_ID = 'dispatch.opencodeVersion';
const UPGRADE_COMMAND = '_dispatch.opencodeVersion.upgrade';
const ENGINES_COMMAND = 'dispatch.engines';
/** Focus can come back often; the check runs `opencode --version` once per changed file, but not more than this often. */
const FOCUS_CHECK_MS = 20_000;
const NOTICE_HEIGHT_VAR = '--dispatch-notice-height';
const NOTICE_SLOT = '.new-chat-input-container > .chat-input-notification-container';
const NEW_SESSION_CONTENT = '.new-chat-widget-content';

interface IUpgradeAnswer {
	readonly ok?: boolean;
	readonly command?: string;
	readonly message?: string;
}

class DispatchOpenCodeVersionNotice extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchOpenCodeVersion';

	private _row: IEngineVersionRow | undefined;
	private _upgrading = false;
	private _failedCommand: string | undefined;
	private _lastCheck = 0;
	private _checking: Promise<void> | undefined;
	private _layoutWatch: IDisposable | undefined;

	constructor(
		@IChatInputNotificationService private readonly _notifications: IChatInputNotificationService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(UPGRADE_COMMAND, () => this._upgrade()));
		const onFocus = () => {
			if (!this._upgrading && Date.now() - this._lastCheck > FOCUS_CHECK_MS) {
				void this._check();
			}
		};
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => mainWindow.removeEventListener('focus', onFocus) });
		this._register({ dispose: () => this._layoutWatch?.dispose() });
		void this._check(true);
	}

	/**
	 * Keeps --dispatch-notice-height on the new-session page equal to the height of the notice slot.
	 * Runs only while this notice is up: a MutationObserver finds the slot when the page is built later
	 * (a new session opened after the notice was published), a ResizeObserver follows the slot when the
	 * text changes or wraps. Both run before the frame is painted, so the input never shows a jump.
	 */
	private _watchLayout(active: boolean): void {
		if (!active) {
			this._layoutWatch?.dispose();
			this._layoutWatch = undefined;
			return;
		}
		if (this._layoutWatch) {
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
		this._layoutWatch = toDisposable(() => {
			mutations.disconnect();
			resize.disconnect();
			doc.querySelector<HTMLElement>(NEW_SESSION_CONTENT)?.style.removeProperty(NOTICE_HEIGHT_VAR);
		});
	}

	/** Reads the versions again. At start the bridge may not be up yet: a few tries, two seconds apart. */
	private _check(retry = false): Promise<void> {
		this._checking ??= (async () => {
			for (let attempt = 0; attempt < (retry ? 15 : 1); attempt++) {
				try {
					const rows = await this._commands.executeCommand<IEngineVersionRow[]>(ENGINES_COMMAND, 'check', OPENCODE_ENGINE_ID);
					this._lastCheck = Date.now();
					this._row = openCodeTooOld(rows);
					if (!this._upgrading) {
						this._failedCommand = this._row ? this._failedCommand : undefined;
						this._publish();
					}
					return;
				} catch (error) {
					if (this._store.isDisposed) {
						return;
					}
					if (attempt === (retry ? 14 : 0)) {
						this._log.info(`[DispatchOpenCodeVersion] could not read the engine versions: ${String(error)}`);
						return;
					}
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}
		})().finally(() => { this._checking = undefined; });
		return this._checking;
	}

	private async _upgrade(): Promise<void> {
		if (this._upgrading || !this._row) {
			return;
		}
		this._upgrading = true;
		this._failedCommand = undefined;
		this._publish();
		let answer: IUpgradeAnswer | undefined;
		try {
			answer = await this._commands.executeCommand<IUpgradeAnswer>(ENGINES_COMMAND, 'upgrade', OPENCODE_ENGINE_ID);
		} catch (error) {
			answer = { ok: false, message: String(error) };
		}
		this._upgrading = false;
		if (this._store.isDisposed) {
			return;
		}
		if (!answer?.ok) {
			this._failedCommand = answer?.command || this._row?.command || 'dispatch engines upgrade opencode';
			this._log.warn(`[DispatchOpenCodeVersion] upgrade failed: ${answer?.message ?? ''}`);
		}
		await this._check();
		this._publish();
	}

	private _publish(): void {
		const row = this._row;
		this._watchLayout(!!row);
		if (!row) {
			this._notifications.deleteNotification(NOTIFICATION_ID);
			return;
		}
		const need = row.min_version ?? '';
		const base = {
			id: NOTIFICATION_ID,
			severity: ChatInputNotificationSeverity.Error,
			// state, not history: it goes away when the version is fine
			dismissible: false,
			autoDismissOnMessage: false,
			sessionTypes: [`${LOCAL_AGENT_HOST_SCHEME_PREFIX}${OPENCODE_ENGINE_ID}`],
		} as const;
		let notification: IChatInputNotification;
		if (this._upgrading) {
			notification = {
				...base,
				message: localize('dispatchOpenCodeVersion.upgradingTitle', "Upgrading OpenCode…"),
				description: row.command
					? new MarkdownString(localize('dispatchOpenCodeVersion.upgradingStep', "Running `{0}`. This can take a minute.", row.command))
					: localize('dispatchOpenCodeVersion.upgradingBody', "OpenCode {0} is being upgraded to {1} or newer. This can take a minute.", row.version, need),
				actions: [],
				progress: true,
			};
		} else {
			const failed = this._failedCommand;
			notification = {
				...base,
				message: localize('dispatchOpenCodeVersion.title', "OpenCode {0} is too old", row.version || '?'),
				description: failed
					? new MarkdownString(localize('dispatchOpenCodeVersion.failedBody', "The upgrade did not finish. Run `{0}` in a terminal, then try again.", failed))
					: localize('dispatchOpenCodeVersion.body', "Dispatch IDE needs OpenCode {0} or newer to start a session.", need),
				actions: [{
					kind: ChatInputNotificationActionKind.Command,
					label: failed ? localize('dispatchOpenCodeVersion.retry', "Retry") : localize('dispatchOpenCodeVersion.upgrade', "Upgrade"),
					commandId: UPGRADE_COMMAND,
					primary: true,
					keepOpen: true,
				}],
			};
		}
		this._notifications.setNotification(notification);
	}
}

registerWorkbenchContribution2(DispatchOpenCodeVersionNotice.ID, DispatchOpenCodeVersionNotice, WorkbenchPhase.AfterRestored);
