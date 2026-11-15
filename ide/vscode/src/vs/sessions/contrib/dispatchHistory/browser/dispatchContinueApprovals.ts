/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a conversation History continues in the chat starts with the approvals chosen for new
 *  sessions (Settings > Agents, kanban app/cli/autonomy.py), as a new session does (450-history.patch).
 *  It came in on the agent's own default ("Always ask") while Settings said Full auto (task-lj06.33).
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SessionConfigKey } from '../../../../platform/agentHost/common/sessionConfigKeys.js';
import { ChatConfiguration, getChatPermissionLevelFromDefaultConfiguration, isChatPermissionLevel, type IChatDefaultConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { claudePermissionModeFor, codexPermissionsPresetFor } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';

/** The session's approvals settings for the window's default approvals (`chat.defaultConfiguration`), per axis it has. */
export function continuedApprovals(approvals: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	// the setting says "allowAll", a session's own value is the permission level it stands for ("autoApprove")
	const level = getChatPermissionLevelFromDefaultConfiguration(approvals) ?? (isChatPermissionLevel(approvals) ? approvals : undefined);
	if (level) {
		out[SessionConfigKey.AutoApprove] = level;
	}
	const claude = claudePermissionModeFor(approvals, false);
	if (claude) {
		out['permissionMode'] = claude;
	}
	const codex = codexPermissionsPresetFor(approvals, false);
	if (codex) {
		out['codex.permissionsPreset'] = codex;
	}
	return out;
}

/** Sets the default approvals on a session History just took in, once its settings are known (10 s at most). */
export async function applyContinuedApprovals(session: ISession, providers: ISessionsProvidersService, configuration: IConfigurationService, log: (message: string) => void = () => { }): Promise<void> {
	const provider = providers.getProvider(session.providerId);
	if (!provider || !isAgentHostProvider(provider)) {
		log(`[dispatch] continued ${session.resource.toString()}: provider ${session.providerId} takes no approvals`);
		return;
	}
	const wanted = continuedApprovals(configuration.getValue<IChatDefaultConfiguration>(ChatConfiguration.DefaultConfiguration)?.approvals);
	// the config arrives with the session's state; the picker asks for it the same way
	// (any of the axes it wants: Claude Code has `permissionMode` and no `autoApprove`, and waiting for that one kept
	// its sessions on "Always ask" for the full 20 s)
	const known = () => { const properties = provider.getSessionConfig(session.sessionId)?.schema.properties; return !!properties && Object.keys(wanted).some(k => !!properties[k]); };
	for (let waited = 0; waited <= 20000 && !known(); waited += 250) {
		await timeout(250);
	}
	const config = provider.getSessionConfig(session.sessionId);
	log(`[dispatch] continued ${session.resource.toString()}: wants ${JSON.stringify(wanted)}, has ${JSON.stringify(config?.values ?? null)}, mutable ${JSON.stringify(Object.keys(config?.schema.properties ?? {}).filter(k => config?.schema.properties[k]?.sessionMutable))}`);
	for (const [property, value] of Object.entries(wanted)) {
		const now = provider.getSessionConfig(session.sessionId);
		const schema = now?.schema.properties[property];
		if (now && schema && !schema.readOnly && now.values[property] !== value) {
			await provider.setSessionConfigValue(session.sessionId, property, value);
		}
	}
}
