/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: when Claude Code's or Codex's servers cannot be reached from this network (patches/270-network.patch).
 *
 *  A new Claude Code or Codex session says so above the input, in the chat input's own notification slot (the same
 *  shell as the OpenCode version notice): "Claude Code cannot reach Anthropic from this network", with a line on what
 *  works here (OpenCode with DeepSeek, Zhipu GLM, Kimi or Qwen; a proxy) and two buttons: Use OpenCode (installing
 *  it first when it is not on this Mac; new sessions then start with it) and Network settings. The state comes from
 *  `dispatch net status` through dispatch-bridge (kanban app/cli/net.py: the CLI asks the servers through the proxy
 *  the engines get, and keeps the answer ten minutes): read at start, when the window gets focus back after a
 *  minute, and after Settings > Network changed something. The notice can be closed; it comes back only when the
 *  answer changes.
 *
 *  `dispatchNetActions` is what the setup wizard's card and Settings > Network call to open a maker's key page, add a
 *  key to OpenCode, or start new sessions with OpenCode.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { LOCAL_AGENT_HOST_SCHEME_PREFIX } from '../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { OPENCODE_ADD_PROVIDER_COMMAND } from '../../../../workbench/contrib/chat/browser/agentSessions/opencodeStatus.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { saveAgentChoice } from '../../dispatchAgents/browser/dispatchAgents.js';
import { blockedEngines, ENGINE_SERVER, INetStatus, noticeBody, ServerEngine } from '../common/dispatchNetModel.js';

const USE_OPENCODE = '_dispatch.net.useOpenCode';
const OPEN_SETTINGS = '_dispatch.net.settings';
/** Settings > Network changed the proxy: read the state again. */
export const DISPATCH_NET_CHANGED = '_dispatch.net.changed';
const FOCUS_CHECK_MS = 60_000;
const NOTICE_HEIGHT_VAR = '--dispatch-notice-height';
const NOTICE_SLOT = '.new-chat-input-container > .chat-input-notification-container';
const NEW_SESSION_CONTENT = '.new-chat-widget-content';

export interface IDispatchNetActions {
	openUrl(url: string): void;
	/** `opencode auth login` in a terminal: OpenCode asks for the provider and the key itself. */
	addKey(): void;
	/** New sessions start with OpenCode (installing it first when it is missing). */
	useOpenCode(): Promise<boolean>;
	/** Read the state again (after a change in Settings > Network). */
	changed(): void;
}

let actions: IDispatchNetActions | undefined;

/** For the setup wizard and Settings: undefined until the contribution is up. */
export function dispatchNetActions(): IDispatchNetActions | undefined {
	return actions;
}

class DispatchNetNotice extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchNet';

	private status: INetStatus | undefined;
	private lastCheck = 0;
	private checking: Promise<void> | undefined;
	private busy: string | undefined;
	private failed: string | undefined;
	private dismissed = new Set<ServerEngine>();
	private layoutWatch: IDisposable | undefined;

	constructor(
		@IChatInputNotificationService private readonly notifications: IChatInputNotificationService,
		@ICommandService private readonly commands: ICommandService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		actions = {
			openUrl: url => void this.opener.open(URI.parse(url), { openExternal: true }),
			addKey: () => void this.commands.executeCommand(OPENCODE_ADD_PROVIDER_COMMAND),
			useOpenCode: () => this.useOpenCode(),
			changed: () => void this.check(false, true),
		};
		this._register(toDisposable(() => { actions = undefined; this.layoutWatch?.dispose(); }));
		this._register(CommandsRegistry.registerCommand(USE_OPENCODE, () => this.useOpenCode()));
		this._register(CommandsRegistry.registerCommand(OPEN_SETTINGS, () => this.commands.executeCommand('dispatch.settings.open', 'network')));
		this._register(CommandsRegistry.registerCommand(DISPATCH_NET_CHANGED, () => this.check(false, true)));
		const onFocus = () => {
			if (!this.busy && Date.now() - this.lastCheck > FOCUS_CHECK_MS) {
				void this.check();
			}
		};
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => mainWindow.removeEventListener('focus', onFocus) });
		const timer = mainWindow.setTimeout(() => void this.check(true), 2500);
		this._register({ dispose: () => mainWindow.clearTimeout(timer) });
	}

	/** At start the bridge may not be up yet: a few tries, two seconds apart. */
	private check(retry = false, fresh = false): Promise<void> {
		this.checking ??= (async () => {
			for (let attempt = 0; attempt < (retry ? 15 : 1); attempt++) {
				try {
					const s = await this.commands.executeCommand<INetStatus>('dispatch.net', fresh ? 'refresh' : 'status');
					if (!s || this._store.isDisposed) {
						return;
					}
					const before = blockedEngines(this.status?.blocked);
					this.status = s;
					this.lastCheck = Date.now();
					for (const e of [...this.dismissed]) {
						if (!before.includes(e) || !blockedEngines(s.blocked).includes(e)) {
							this.dismissed.delete(e); // closed while it was another answer: it may come back
						}
					}
					this.publish();
					return;
				} catch (error) {
					if (this._store.isDisposed) {
						return;
					}
					if (attempt === (retry ? 14 : 0)) {
						this.log.info(`[DispatchNet] could not read the network state: ${String(error)}`);
						return;
					}
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}
		})().finally(() => { this.checking = undefined; });
		return this.checking;
	}

	private async openCodeInstalled(): Promise<boolean> {
		try {
			const rows = await this.commands.executeCommand<{ id: string; installed: boolean }[]>('dispatch.engines', 'check', 'opencode');
			return !!rows?.find(r => r.id === 'opencode')?.installed;
		} catch {
			return false;
		}
	}

	private async useOpenCode(): Promise<boolean> {
		if (this.busy) {
			return false;
		}
		this.failed = undefined;
		try {
			if (!await this.openCodeInstalled()) {
				this.busy = localize('dispatchNet.installing', "Installing OpenCode…");
				this.publish();
				const answer = await this.commands.executeCommand<{ ok?: boolean; message?: string; command?: string }>('dispatch.engines', 'upgrade', 'opencode');
				if (!answer?.ok) {
					throw new Error(answer?.message || localize('dispatchNet.installFailed', "OpenCode could not be installed."));
				}
			}
			this.busy = localize('dispatchNet.switching', "Switching to OpenCode…");
			this.publish();
			await saveAgentChoice(this.commands, { default: 'opencode' });
			return true;
		} catch (error) {
			this.failed = String((error as Error)?.message ?? error);
			this.notificationService.warn(this.failed);
			return false;
		} finally {
			this.busy = undefined;
			this.publish();
		}
	}

	private publish(): void {
		const blocked = blockedEngines(this.status?.blocked).filter(e => !this.dismissed.has(e));
		this.watchLayout(blocked.length > 0);
		for (const engine of Object.keys(ENGINE_SERVER) as ServerEngine[]) {
			const id = `dispatch.net.${engine}`;
			if (!blocked.includes(engine) || !this.status) {
				this.notifications.deleteNotification(id);
				continue;
			}
			const who = ENGINE_SERVER[engine];
			const models = this.status.china_models;
			this.notifications.setNotification({
				id,
				severity: ChatInputNotificationSeverity.Error,
				dismissible: !this.busy,
				onDismiss: () => { this.dismissed.add(engine); this.publish(); },
				autoDismissOnMessage: false,
				sessionTypes: [`${LOCAL_AGENT_HOST_SCHEME_PREFIX}${engine}`],
				message: localize('dispatchNet.title', "{0} cannot reach {1} from this network", who.engine, who.company),
				description: this.busy ?? noticeBody(models),
				progress: !!this.busy,
				actions: this.busy ? [] : [
					{ kind: ChatInputNotificationActionKind.Command, label: localize('dispatchNet.useOpenCode', "Use OpenCode"), commandId: USE_OPENCODE, primary: true, keepOpen: true },
					{ kind: ChatInputNotificationActionKind.Command, label: localize('dispatchNet.settings', "Network settings"), commandId: OPEN_SETTINGS },
				],
			});
		}
	}

	/**
	 * Keeps --dispatch-notice-height on the new-session page equal to the notice slot's height while a notice is up,
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
			if (height) {
				doc.querySelector<HTMLElement>(NEW_SESSION_CONTENT)?.style.setProperty(NOTICE_HEIGHT_VAR, `${height}px`);
			} else {
				doc.querySelector<HTMLElement>(NEW_SESSION_CONTENT)?.style.removeProperty(NOTICE_HEIGHT_VAR);
			}
		});
	}
}

registerWorkbenchContribution2(DispatchNetNotice.ID, DispatchNetNotice, WorkbenchPhase.AfterRestored);
