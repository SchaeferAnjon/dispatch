/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the editor window's Accounts menu (the activity bar's account button) shows the Claude
 *  login next to ChatGPT, like the Agents window's account panel (290-accounts.patch): signed in,
 *  "email (Claude)" with the plan, the weekly limit and when it resets, and Sign Out; signed out, "Sign in to
 *  Claude...". The state comes from dispatch-bridge (dispatch.claudeStatus, the same source as the Agents
 *  window); sign in / out run the bridge's `claude auth login` / `logout`.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';

interface IClaudeState {
	readonly loggedIn: boolean;
	readonly email?: string;
	readonly subscriptionType?: string;
	readonly weekly?: { readonly usedPercent: number; readonly resetsAt?: number };
}

const REFRESH_MS = 5 * 60 * 1000;
const ClaudeSubmenu = new MenuId('DispatchClaudeAccountSubmenu');
const INFO_COMMAND = '_dispatch.claudeAccountInfo';
const SIGN_IN = '_dispatch.claudeAccountSignIn';
const SIGN_OUT = '_dispatch.claudeAccountSignOut';
CommandsRegistry.registerCommand(INFO_COMMAND, () => { /* a line of information */ });

class DispatchClaudeAccountMenu extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchClaudeAccountMenu';

	private readonly items = this._register(new MutableDisposable<DisposableStore>());
	private shown = '';

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		if (environmentService.isSessionsWindow) {
			return; // the Agents window has its own account panel
		}
		this.render(undefined);
		void this.refresh();
		const timer = mainWindow.setInterval(() => void this.refresh(), REFRESH_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
		const onFocus = () => void this.refresh();
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => mainWindow.removeEventListener('focus', onFocus) });
		// sign in / out through the bridge, then show what it reports
		for (const [id, bridge] of [[SIGN_IN, 'dispatch.claudeSignIn'], [SIGN_OUT, 'dispatch.claudeSignOut']]) {
			this._register(CommandsRegistry.registerCommand(id, async () => {
				const state = await this.commandService.executeCommand<IClaudeState>(bridge);
				if (state) {
					this.render(state);
				}
			}));
		}
	}

	private async refresh(): Promise<void> {
		try {
			const state = await this.commandService.executeCommand<IClaudeState>('dispatch.claudeStatus');
			if (state) {
				this.render(state);
			}
		} catch {
			// no bridge yet: keep what is shown
		}
	}

	private render(state: IClaudeState | undefined): void {
		const key = JSON.stringify(state ?? null);
		if (key === this.shown) {
			return;
		}
		this.shown = key;
		const store = new DisposableStore();
		if (state?.loggedIn) {
			const plan = state.subscriptionType ? `Claude ${state.subscriptionType.charAt(0).toUpperCase()}${state.subscriptionType.slice(1)}` : localize('dispatch.claude.subscription', "Claude subscription");
			store.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
				submenu: ClaudeSubmenu,
				title: state.email ? localize('dispatch.claude.account', "{0} (Claude)", state.email) : localize('dispatch.claude.accountNoEmail', "Claude"),
				group: '1_accounts',
				order: 0,
			}));
			const limit = state.weekly
				? state.weekly.resetsAt
					? localize('dispatch.claude.limitReset', "{0}: {1}% of the weekly limit used, resets {2}", plan, Math.round(state.weekly.usedPercent), fromNow(state.weekly.resetsAt * 1000, true, true))
					: localize('dispatch.claude.limit', "{0}: {1}% of the weekly limit used", plan, Math.round(state.weekly.usedPercent))
				: plan;
			store.add(MenuRegistry.appendMenuItem(ClaudeSubmenu, { command: { id: INFO_COMMAND, title: limit, precondition: undefined }, group: '1_info', order: 0 }));
			store.add(MenuRegistry.appendMenuItem(ClaudeSubmenu, { command: { id: SIGN_OUT, title: localize('dispatch.claude.signOut', "Sign Out") }, group: '2_signout', order: 0 }));
		} else {
			store.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
				command: { id: SIGN_IN, title: localize('dispatch.claude.signIn', "Sign in to Claude...") },
				group: '1_accounts',
				order: 0,
			}));
		}
		this.items.value = store;
	}
}

registerWorkbenchContribution2(DispatchClaudeAccountMenu.ID, DispatchClaudeAccountMenu, WorkbenchPhase.Eventually);
