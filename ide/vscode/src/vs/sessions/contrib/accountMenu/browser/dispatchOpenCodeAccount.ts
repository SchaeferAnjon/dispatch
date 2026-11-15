/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the account panel's OpenCode section, after Claude's and ChatGPT's and built like the
 *  ChatGPT one. OpenCode has no account of its own: it has providers (keys in its auth.json, the
 *  environment, its config). The section says how many, lists the allowance of those that report one
 *  (DeepSeek's balance, Zhipu AI Coding Plan's weekly limit) and has two buttons: Add Provider
 *  (`opencode auth login` in a terminal) and Agent Customizations for OpenCode (its page, where the
 *  providers are listed). Shown only when OpenCode is installed. The data is dispatch-bridge's
 *  `dispatch.opencodeStatus` (opencodeStatus.ts): drawn at once from the last answer, again when a
 *  fresh one comes back.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AICustomizationManagementCommands } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.js';
import { openCodeIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { fetchOpenCodeStatus, IOpenCodeStatus, lastOpenCodeStatus, OPENCODE_ADD_PROVIDER_COMMAND, openCodeAccountRows, openCodeProviderCount } from '../../../../workbench/contrib/chat/browser/agentSessions/opencodeStatus.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

/**
 * Appends the section to the panel's identities. `hidePanel` closes the panel before an action runs,
 * as the other sections' buttons do.
 */
export function appendDispatchOpenCodeAccount(identities: HTMLElement, panelStore: DisposableStore, commandService: ICommandService, hidePanel: () => void): void {
	const section = append(identities, $('section.sessions-account-titlebar-panel-provider-account.dispatch-opencode-account', {
		'aria-label': localize('dispatch.opencodeAccountSectionLabel', "OpenCode"),
	}));
	const sectionStore = panelStore.add(new DisposableStore());

	const draw = (status: IOpenCodeStatus | undefined) => {
		sectionStore.clear();
		clearNode(section);
		// not installed (or no answer yet): no section, as the engine menu has no OpenCode then
		section.style.display = status?.installed ? '' : 'none';
		if (!status?.installed) {
			return;
		}
		const hasProviders = status.providers.length > 0;
		section.classList.toggle('signed-out', !hasProviders);
		const identity = append(section, $('.sessions-account-titlebar-panel-provider-identity'));
		const icon = append(identity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
		icon.classList.add(...ThemeIcon.asClassNameArray(openCodeIcon));
		if (hasProviders) {
			append(identity, $('.sessions-account-titlebar-panel-provider-name')).textContent = localize('dispatch.opencodeAccountName', "OpenCode · {0}", openCodeProviderCount(status));
		}
		const actions = append(identity, $(hasProviders ? '.sessions-account-titlebar-panel-provider-actions' : '.sessions-account-titlebar-panel-provider-sign-in-actions'));
		const actionBar = sectionStore.add(new ActionBar(actions));
		sectionStore.add(actionBar.onWillRun(() => hidePanel()));
		const addProvider = () => commandService.executeCommand(OPENCODE_ADD_PROVIDER_COMMAND);
		if (!hasProviders) {
			actionBar.push(sectionStore.add(new Action(
				'dispatch.opencodeAddFirstProvider',
				localize('dispatch.opencodeAddFirstProvider', "Add a provider to OpenCode…"),
				undefined,
				true,
				addProvider,
			)), { icon: false, label: true });
			return;
		}
		actionBar.push(sectionStore.add(new Action(
			'dispatch.opencodeAddProvider',
			localize('dispatch.opencodeAddProvider', "Add Provider"),
			ThemeIcon.asClassName(Codicon.add),
			true,
			addProvider,
		)), { icon: true, label: false });
		actionBar.push(sectionStore.add(new Action(
			'dispatch.opencodeOpenAgentCustomizations',
			localize('dispatch.opencodeOpenAgentCustomizations', "Agent Customizations for OpenCode"),
			ThemeIcon.asClassName(Codicon.settingsGear),
			true,
			() => commandService.executeCommand(AICustomizationManagementCommands.OpenEditor, {
				sessionType: SessionType.AgentHostOpenCode,
				section: AICustomizationManagementSection.HarnessSettings,
			}),
		)), { icon: true, label: false });
		for (const row of openCodeAccountRows(status)) {
			const usage = append(section, $('.sessions-account-titlebar-panel-provider-usage'));
			const primary = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
			append(primary, $('span.sessions-account-titlebar-panel-provider-plan', undefined, row.title));
			append(primary, $('span.sessions-account-titlebar-panel-provider-usage-value', { 'aria-label': row.valueAriaLabel }, row.value));
			const secondary = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.secondary'));
			if (row.detail) {
				append(secondary, $('span.sessions-account-titlebar-panel-provider-reset', undefined, row.detail));
			} else {
				secondary.classList.add('without-reset');
			}
			append(secondary, $('span.sessions-account-titlebar-panel-provider-usage-label', undefined, row.label));
		}
	};

	draw(lastOpenCodeStatus());
	void fetchOpenCodeStatus(commandService).then(status => {
		if (status && section.isConnected) {
			draw(status);
		}
	});
}
