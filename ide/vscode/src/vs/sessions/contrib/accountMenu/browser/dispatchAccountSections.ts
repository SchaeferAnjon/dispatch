/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the account panel's Claude section and the subscriptions' limit windows (290-accounts.patch).
 *  account.contribution.ts calls appendDispatchClaudeAccount and appendDispatchCodexLimits.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchAccountLimits.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow, safeIntl } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
// a Turbo run's bolt and stripes under the agent it uses (420-turbo.patch)
import { appendTurboUsage } from '../../dispatchTurbo/browser/dispatchTurboUsage.js';
import { fetchOpenCodeStatus } from '../../../../workbench/contrib/chat/browser/agentSessions/opencodeStatus.js';

// Dispatch IDE: the Claude login as dispatch-bridge reads it (`claude auth status`, `dispatch quota`)
interface IDispatchClaudeState {
	readonly loggedIn: boolean;
	readonly email?: string;
	readonly subscriptionType?: string;
	readonly weekly?: { readonly usedPercent: number; readonly resetsAt?: number };
	/** Every limit window `dispatch quota` reports: the 5-hour one, the weekly one, a model's weekly one. */
	readonly windows?: readonly IDispatchLimitWindow[];
}
let dispatchClaudeState: IDispatchClaudeState | undefined;

// Dispatch IDE: a subscription's limit windows, one row each (kanban design/machines/redesign: both the
// weekly and the 5-hour window, and Claude's model window like "Fable · weekly")
interface IDispatchLimitWindow {
	readonly kind?: string;
	readonly label?: string;
	readonly usedPercent: number;
	readonly resetsAt?: number | null;
}
let dispatchCodexLimits: readonly IDispatchLimitWindow[] | undefined;

function dispatchLimitLabel(w: IDispatchLimitWindow): string {
	if (w.kind === 'session') {
		return localize('dispatch.limit5h', "5-hour");
	}
	if (w.kind === 'weekly') {
		return localize('dispatch.limitWeekly', "Weekly");
	}
	const model = (w.label ?? '').split('·').pop()?.trim();
	return model && /^[\x20-\x7e]+$/.test(model) ? localize('dispatch.limitModelWeekly', "{0} · weekly", model) : localize('dispatch.limitOther', "Model · weekly");
}

/** One row per limit window, the weekly one first: label, when it resets, how much is used. */
function appendDispatchLimitRows(parent: HTMLElement, windows: readonly IDispatchLimitWindow[]): void {
	const order = (w: IDispatchLimitWindow) => w.kind === 'weekly' ? 0 : w.kind === 'session' ? 1 : 2;
	const format = safeIntl.NumberFormat(language, { maximumFractionDigits: 0 }).value;
	// the plan's row heads the column: the numbers are what is used
	const head = parent.querySelector<HTMLElement>('.sessions-account-titlebar-panel-provider-metric-row.primary');
	if (head && !head.querySelector('.dispatch-limit-head')) {
		append(head, $('span.dispatch-limit-head', undefined, localize('dispatch.limitUsedHead', "Used")));
	}
	for (const w of [...windows].sort((a, b) => order(a) - order(b))) {
		const row = append(parent, $('.dispatch-limit-row'));
		append(row, $('span.dispatch-limit-label', undefined, dispatchLimitLabel(w)));
		append(row, $('span.dispatch-limit-reset', undefined, w.resetsAt ? localize('dispatch.limitResets', "resets {0}", fromNow(w.resetsAt * 1000, true, true)) : ''));
		const used = format.format(w.usedPercent);
		append(row, $('span.dispatch-limit-value', { 'aria-label': localize('dispatch.limitUsedAria', "{0}% used", used) }, localize('dispatch.limitUsed', "{0}%", used)));
	}
}

/**
 * Dispatch IDE: the Claude section. Drawn at once from the last state read, then again when a fresh
 * `dispatch.claudeStatus` comes back. Signed in: email, plan, the weekly limit and when it resets, a
 * sign-out icon (`claude auth logout`). Signed out: "Sign in to Claude", which runs `claude auth login`
 * in a terminal (the browser does the OAuth; the terminal closes when the login is there).
 */
/**
 * Ask for both accounts' state in the background (the window's start, then every few minutes, keeping the newest): the panel opens
 * drawn at its full size, instead of growing when the answers come and moving the menu under the pointer (10-08: a
 * click meant for Replay Tips landed on Getting Started, the row above it).
 */
export async function warmDispatchAccountSections(commandService: ICommandService): Promise<boolean> {
	const [claude] = await Promise.all([
		commandService.executeCommand<IDispatchClaudeState>('dispatch.claudeStatus').then(state => {
			if (state) {
				dispatchClaudeState = state;
			}
			return state;
		}, () => undefined),
		commandService.executeCommand<IDispatchLimitWindow[]>('dispatch.codexLimits').then(w => {
			if (Array.isArray(w) && w.length) {
				dispatchCodexLimits = w;
			}
		}, () => undefined),
		// the OpenCode section (dispatchOpenCodeAccount.ts) draws from the last answer this keeps
		fetchOpenCodeStatus(commandService).catch(() => undefined),
	]);
	// complete: the answer the panel would draw (a signed-in Claude with its limit rows; a busy start's first answer
	// may come without them)
	return !!claude && (!claude.loggedIn || !!claude.windows?.length || !!claude.weekly);
}

export function appendDispatchClaudeAccount(identities: HTMLElement, panelStore: DisposableStore, commandService: ICommandService, closePanel: () => void): void {
	const section = append(identities, $('section.sessions-account-titlebar-panel-provider-account', {
		'aria-label': localize('dispatch.claudeAccountSectionLabel', "Claude account")
	}));
	const sectionStore = panelStore.add(new DisposableStore());
	const run = async (command: string) => {
		try {
			dispatchClaudeState = await commandService.executeCommand<IDispatchClaudeState>(command) ?? dispatchClaudeState;
		} catch {
			// the bridge is not there: keep what is shown
		}
	};
	const draw = (state: IDispatchClaudeState | undefined) => {
		sectionStore.clear();
		clearNode(section);
		const signedIn = !!state?.loggedIn;
		const email = state?.email, subscriptionType = state?.subscriptionType, weekly = state?.weekly;
		section.classList.toggle('signed-out', !signedIn);
		const identity = append(section, $('.sessions-account-titlebar-panel-provider-identity'));
		const icon = append(identity, $('span.sessions-account-titlebar-panel-provider-icon', { 'aria-hidden': 'true' }));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.claude));
		if (signedIn) {
			append(identity, $('.sessions-account-titlebar-panel-provider-name')).textContent = email || localize('dispatch.claudeAccountName', "Claude");
		}
		const actions = append(identity, $(signedIn ? '.sessions-account-titlebar-panel-provider-actions' : '.sessions-account-titlebar-panel-provider-sign-in-actions'));
		const actionBar = sectionStore.add(new ActionBar(actions));
		sectionStore.add(actionBar.onWillRun(closePanel));
		if (signedIn) {
			actionBar.push(sectionStore.add(new Action(
				'dispatch.claudeSignOut',
				localize('dispatch.claudeSignOut', "Sign Out"),
				ThemeIcon.asClassName(Codicon.signOut),
				true,
				() => run('dispatch.claudeSignOut'),
			)), { icon: true, label: false });
			const usage = append(section, $('.sessions-account-titlebar-panel-provider-usage'));
			const planRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.primary'));
			const plan = subscriptionType ? subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1) : undefined;
			append(planRow, $('span.sessions-account-titlebar-panel-provider-plan', undefined, plan
				? localize('dispatch.claudePlan', "Claude {0}", plan)
				: localize('dispatch.claudeSubscription', "Claude subscription")));
			if (state?.windows?.length) {
				appendDispatchLimitRows(usage, state.windows);
				appendTurboUsage(usage, 'claude');
			} else if (weekly) {
				const used = safeIntl.NumberFormat(language, { maximumFractionDigits: 0 }).value.format(weekly.usedPercent);
				append(planRow, $('span.sessions-account-titlebar-panel-provider-usage-value', {
					'aria-label': localize('dispatch.claudeLimitUsedPercentage', "{0}% used", used),
				}, localize('dispatch.claudeLimitUsedPercentageValue', "{0}%", used)));
				const detailRow = append(usage, $('.sessions-account-titlebar-panel-provider-metric-row.secondary'));
				if (weekly.resetsAt) {
					append(detailRow, $('span.sessions-account-titlebar-panel-provider-reset', undefined,
						localize('dispatch.claudeWeeklyReset', "Weekly limit resets {0}", fromNow(weekly.resetsAt * 1000, false, true))));
				} else {
					detailRow.classList.add('without-reset');
				}
				append(detailRow, $('span.sessions-account-titlebar-panel-provider-usage-label', undefined, localize('dispatch.claudeLimitUsedLabel', "Limit used")));
			}
		} else {
			actionBar.push(sectionStore.add(new Action(
				'dispatch.claudeSignIn',
				localize('dispatch.claudeSignIn', "Sign in to Claude"),
				undefined,
				true,
				() => run('dispatch.claudeSignIn'),
			)), { icon: false, label: true });
		}
	};
	draw(dispatchClaudeState);
	void commandService.executeCommand<IDispatchClaudeState>('dispatch.claudeStatus').then(state => {
		if (state) {
			dispatchClaudeState = state;
			if (section.isConnected) {
				draw(state);
			}
		}
	}, () => { /* no bridge */ });
}

/**
 * Both limit windows of the ChatGPT account (weekly and 5-hour) as `dispatch quota` reads them from Codex's logs,
 * asked each time the panel opens and drawn from the last answer. True when the windows are drawn: the account's
 * own rate limit is then left out.
 */
export function appendDispatchCodexLimits(usage: HTMLElement, planRow: HTMLElement, commandService: ICommandService): boolean {
	void commandService.executeCommand<IDispatchLimitWindow[]>('dispatch.codexLimits').then(w => {
		if (Array.isArray(w) && w.length) {
			const first = !dispatchCodexLimits;
			dispatchCodexLimits = w;
			if (first && usage.isConnected) {
				clearNode(usage);
				// the plan name only: the windows below carry the numbers
				for (const child of [...planRow.children]) {
					if (!child.classList.contains('sessions-account-titlebar-panel-provider-plan')) {
						child.remove();
					}
				}
				usage.appendChild(planRow);
				appendDispatchLimitRows(usage, w);
				appendTurboUsage(usage, 'codex');
			}
		}
	}, () => { /* no bridge */ });
	if (dispatchCodexLimits?.length) {
		appendDispatchLimitRows(usage, dispatchCodexLimits);
		appendTurboUsage(usage, 'codex');
		return true;
	}
	return false;
}
