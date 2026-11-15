/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the editor window's Accounts menu shows OpenCode next to Claude
 *  (dispatchClaudeAccountMenu.ts), like the Agents window's account panel (dispatchOpenCodeAccount.ts):
 *  a submenu "OpenCode (19 providers)" with one line per provider that reports an allowance
 *  ("DeepSeek: 45.15 CNY left") and Add Provider...; without providers only "Add a provider to
 *  OpenCode..."; nothing when OpenCode is not installed. The state comes from dispatch-bridge
 *  (dispatch.opencodeStatus); Add Provider runs OpenCode's own `opencode auth login` in a terminal.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { fetchOpenCodeStatus, IOpenCodeStatus, OPENCODE_ADD_PROVIDER_COMMAND, openCodeAccountRows, openCodeProviderCount } from './agentSessions/opencodeStatus.js';

const REFRESH_MS = 5 * 60 * 1000;
const OpenCodeSubmenu = new MenuId('DispatchOpenCodeAccountSubmenu');
const INFO_COMMAND = '_dispatch.opencodeAccountInfo';
const ADD_PROVIDER = '_dispatch.opencodeAccountAddProvider';
CommandsRegistry.registerCommand(INFO_COMMAND, () => { /* a line of information */ });

class DispatchOpenCodeAccountMenu extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchOpenCodeAccountMenu';

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
		void this.refresh();
		const timer = mainWindow.setInterval(() => void this.refresh(), REFRESH_MS);
		this._register({ dispose: () => mainWindow.clearInterval(timer) });
		const onFocus = () => void this.refresh();
		mainWindow.addEventListener('focus', onFocus);
		this._register({ dispose: () => mainWindow.removeEventListener('focus', onFocus) });
		this._register(CommandsRegistry.registerCommand(ADD_PROVIDER, async () => {
			await this.commandService.executeCommand(OPENCODE_ADD_PROVIDER_COMMAND);
			await this.refresh();
		}));
	}

	private async refresh(): Promise<void> {
		// the bridge activates after the window: the first look waits for it a little
		const status = await fetchOpenCodeStatus(this.commandService, { attempts: this.shown ? 1 : 5, isDisposed: () => this._store.isDisposed });
		if (status) {
			this.render(status);
		}
	}

	private render(status: IOpenCodeStatus): void {
		const rows = openCodeAccountRows(status);
		const key = JSON.stringify([status.installed, status.providers.length, rows.map(r => r.menuText)]);
		if (key === this.shown) {
			return;
		}
		this.shown = key;
		const store = new DisposableStore();
		if (!status.installed) {
			this.items.value = store;
			return;
		}
		if (!status.providers.length) {
			store.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
				command: { id: ADD_PROVIDER, title: localize('dispatch.opencode.addFirst', "Add a provider to OpenCode...") },
				group: '1_accounts',
				order: 1,
			}));
			this.items.value = store;
			return;
		}
		store.add(MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
			submenu: OpenCodeSubmenu,
			title: localize('dispatch.opencode.account', "OpenCode ({0})", openCodeProviderCount(status)),
			group: '1_accounts',
			order: 1,
		}));
		rows.forEach((row, index) => {
			store.add(MenuRegistry.appendMenuItem(OpenCodeSubmenu, { command: { id: INFO_COMMAND, title: row.menuText, precondition: undefined }, group: '1_info', order: index }));
		});
		store.add(MenuRegistry.appendMenuItem(OpenCodeSubmenu, { command: { id: ADD_PROVIDER, title: localize('dispatch.opencode.addProvider', "Add Provider...") }, group: '2_providers', order: 0 }));
		this.items.value = store;
	}
}

registerWorkbenchContribution2(DispatchOpenCodeAccountMenu.ID, DispatchOpenCodeAccountMenu, WorkbenchPhase.Eventually);
