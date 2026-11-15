/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the OpenCode page of Customizations, the Agents window's account panel and the
 *  editor's Accounts menu show about OpenCode. dispatch-bridge answers `dispatch.opencodeStatus` with
 *  `dispatch engines status opencode` (app/cli/opencode_engine.py): the providers OpenCode can use and
 *  where each key comes from (never the key), its default model, the allowance DeepSeek and Zhipu
 *  report, and Dispatch's OpenCode plugin. The texts are made here, in the window's language.
 *--------------------------------------------------------------------------------------------*/

import { fromNow, safeIntl } from '../../../../../base/common/date.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

/** dispatch-bridge (app/ide-ext/src/opencode.ts) */
export const OPENCODE_STATUS_COMMAND = 'dispatch.opencodeStatus';
export const OPENCODE_ADD_PROVIDER_COMMAND = 'dispatch.opencodeAddProvider';
export const OPENCODE_INSTALL_PLUGIN_COMMAND = 'dispatch.opencodeInstallPlugin';
/** What to run by hand when the plugin could not be installed. */
export const OPENCODE_INSTALL_PLUGIN_CLI = 'dispatch engines install-plugin opencode';

export interface IOpenCodeKeySource {
	/** api (auth.json) | oauth (auth.json) | env | config (opencode.json) | free (OpenCode Zen) */
	readonly kind: string;
	/** the file or the environment variable */
	readonly detail: string;
}

export interface IOpenCodeQuota {
	/** balance (money left) | window (a share of a time window's limit used) */
	readonly kind: string;
	readonly label: string;
	readonly amount?: number;
	readonly currency?: string;
	readonly used_percent?: number;
	/** seconds since 1970 */
	readonly resets_at?: number | null;
	/** the plan the key is on ("lite") */
	readonly plan?: string;
}

export interface IOpenCodeProvider {
	readonly id: string;
	readonly name: string;
	readonly sources: readonly IOpenCodeKeySource[];
	readonly quota: readonly IOpenCodeQuota[];
	/** another provider reports the same allowance (two keys of one account): the account menu shows it once */
	readonly same_quota_as?: string;
}

export interface IOpenCodeStatus {
	readonly installed: boolean;
	readonly version: string;
	readonly config: { readonly path: string; readonly exists: boolean; readonly dir: string };
	/** OpenCode's credentials file (`opencode auth login` writes it); watched, never read here */
	readonly auth_path?: string;
	readonly default_model: string;
	readonly providers: readonly IOpenCodeProvider[];
	readonly plugin: { readonly installed: boolean; readonly current: boolean; readonly path: string };
	/** Dispatch IDE (opencode-guarded-folders): files the config names in Desktop / Documents / Downloads / iCloud Drive, which macOS can keep OpenCode from reading, said in a sentence ("" when none) */
	readonly protected_text?: string;
}

let lastStatus: IOpenCodeStatus | undefined;

/** The last answer, for drawing at once while a fresh one is on its way. */
export function lastOpenCodeStatus(): IOpenCodeStatus | undefined {
	return lastStatus;
}

/**
 * Asks dispatch-bridge. The bridge activates after the window: a caller that is early waits for it a
 * little (`attempts` times two seconds). undefined when there is no bridge or the CLI failed.
 */
export async function fetchOpenCodeStatus(commandService: ICommandService, options?: { refresh?: boolean; attempts?: number; isDisposed?: () => boolean }): Promise<IOpenCodeStatus | undefined> {
	const attempts = options?.attempts ?? 1;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const status = await commandService.executeCommand<IOpenCodeStatus>(OPENCODE_STATUS_COMMAND, options?.refresh === true);
			if (status && typeof status === 'object' && Array.isArray(status.providers)) {
				lastStatus = status;
				return status;
			}
			return undefined;
		} catch {
			if (options?.isDisposed?.() || attempt === attempts - 1) {
				return undefined;
			}
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}
	return undefined;
}

/** "API key in auth.json", "ZHIPU_API_KEY from the environment", "Free, no key needed". */
export function openCodeSourceText(source: IOpenCodeKeySource | undefined): string {
	switch (source?.kind) {
		case 'api': return localize('opencode.source.api', "API key in auth.json");
		case 'oauth': return localize('opencode.source.oauth', "Signed in with OAuth");
		case 'env': return localize('opencode.source.env', "{0} from the environment", source.detail);
		case 'config': return localize('opencode.source.config', "API key in {0}", source.detail || 'opencode.json');
		case 'free': return localize('opencode.source.free', "Free, no key needed");
		default: return '';
	}
}

/** The plan a provider's key is on ("Lite"), when its allowance says. */
export function openCodePlan(provider: IOpenCodeProvider): string | undefined {
	const plan = provider.quota.find(q => typeof q.plan === 'string' && q.plan.trim())?.plan?.trim();
	return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
}

/** A window's length in minutes, to put the long ones first: "weekly" 10080, "5-hour" 300. */
function windowMinutes(label: string): number {
	const named: Record<string, number> = { hourly: 60, daily: 1440, weekly: 10080, monthly: 43200 };
	if (named[label]) {
		return named[label];
	}
	const m = /^(\d+)-(minute|hour|day|week|month)$/.exec(label);
	const unit: Record<string, number> = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 };
	return m ? Number(m[1]) * unit[m[2]] : 0;
}

/** "Weekly limit", "5-hour limit". */
export function openCodeWindowName(label: string): string {
	switch (label) {
		case 'hourly': return localize('opencode.window.hourly', "Hourly limit");
		case 'daily': return localize('opencode.window.daily', "Daily limit");
		case 'weekly': return localize('opencode.window.weekly', "Weekly limit");
		case 'monthly': return localize('opencode.window.monthly', "Monthly limit");
		default: return localize('opencode.window.other', "{0} limit", label);
	}
}

/** The windows with a percentage, the longest first. */
export function openCodeWindows(provider: IOpenCodeProvider): IOpenCodeQuota[] {
	return provider.quota
		.filter(q => q.kind === 'window' && typeof q.used_percent === 'number')
		.sort((a, b) => windowMinutes(b.label) - windowMinutes(a.label));
}

/** The money left, when the provider tells it. */
export function openCodeBalance(provider: IOpenCodeProvider): IOpenCodeQuota | undefined {
	return provider.quota.find(q => q.kind === 'balance' && typeof q.amount === 'number');
}

export function formatOpenCodeAmount(amount: number): string {
	return safeIntl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).value.format(amount);
}

function resetsIn(q: IOpenCodeQuota, now: number): string | undefined {
	return q.resets_at && q.resets_at * 1000 > now ? fromNow(q.resets_at * 1000, false, true) : undefined;
}

/**
 * The provider row's right side on the OpenCode page, at most two lines: "45.15 CNY left";
 * "Weekly limit 90% used, resets in 2 days" and "5-hour limit 3% used".
 */
export function openCodeQuotaLines(provider: IOpenCodeProvider, now = Date.now()): string[] {
	const lines: string[] = [];
	const balance = openCodeBalance(provider);
	if (balance) {
		lines.push(localize('opencode.quota.balance', "{0} {1} left", formatOpenCodeAmount(balance.amount!), balance.currency ?? ''));
	}
	for (const w of openCodeWindows(provider)) {
		const used = Math.round(w.used_percent!);
		const reset = lines.length === 0 ? resetsIn(w, now) : undefined;
		lines.push(reset
			? localize('opencode.quota.windowReset', "{0} {1}% used, resets {2}", openCodeWindowName(w.label), used, reset)
			: localize('opencode.quota.window', "{0} {1}% used", openCodeWindowName(w.label), used));
	}
	return lines.slice(0, 2);
}

/** One provider's allowance in the account menus: a balance, or its longest window. */
export interface IOpenCodeAccountRow {
	/** "DeepSeek", "Zhipu AI Coding Plan Lite" */
	readonly title: string;
	/** "45.15 CNY", "90%" */
	readonly value: string;
	readonly valueAriaLabel: string;
	/** "Weekly limit resets in 2 days"; undefined for a balance */
	readonly detail?: string;
	/** "Balance", "Limit used" */
	readonly label: string;
	/** the editor's Accounts menu: "DeepSeek: 45.15 CNY left" */
	readonly menuText: string;
}

/**
 * The account menus' rows: the providers that report an allowance, one row each; two keys of one
 * account (the CLI marks the second `same_quota_as`) show once.
 */
export function openCodeAccountRows(status: IOpenCodeStatus | undefined, now = Date.now()): IOpenCodeAccountRow[] {
	const rows: IOpenCodeAccountRow[] = [];
	for (const provider of status?.providers ?? []) {
		if (provider.same_quota_as) {
			continue;
		}
		const balance = openCodeBalance(provider);
		if (balance) {
			const amount = `${formatOpenCodeAmount(balance.amount!)} ${balance.currency ?? ''}`.trim();
			rows.push({
				title: provider.name,
				value: amount,
				valueAriaLabel: localize('opencode.account.balanceAria', "{0} left", amount),
				label: localize('opencode.account.balance', "Balance"),
				menuText: localize('opencode.account.balanceMenu', "{0}: {1} left", provider.name, amount),
			});
			continue;
		}
		const window = openCodeWindows(provider)[0];
		if (!window) {
			continue;
		}
		const plan = openCodePlan(provider);
		const title = plan ? localize('opencode.account.plan', "{0} {1}", provider.name, plan) : provider.name;
		const used = Math.round(window.used_percent!);
		const reset = resetsIn(window, now);
		const name = openCodeWindowName(window.label);
		rows.push({
			title,
			value: localize('opencode.account.percent', "{0}%", used),
			valueAriaLabel: localize('opencode.account.percentAria', "{0}% used", used),
			detail: reset ? localize('opencode.account.reset', "{0} resets {1}", name, reset) : undefined,
			label: localize('opencode.account.limitUsed', "Limit used"),
			menuText: reset
				? localize('opencode.account.windowMenuReset', "{0}: {1} {2}% used, resets {3}", title, name, used, reset)
				: localize('opencode.account.windowMenu', "{0}: {1} {2}% used", title, name, used),
		});
	}
	return rows;
}

/** "2 providers set up", "1 provider set up": the ones with a key or a sign-in, as Settings › Agents counts them
 *  (OpenCode Zen's free models need neither and are not one; kanban task-eibd9 had 3 here and 2 there). */
export function openCodeProviderCount(status: IOpenCodeStatus): string {
	const n = status.providers.filter(p => p.sources.some(s => s.kind !== 'free')).length;
	return n === 0 ? localize('opencode.providers.none', "No provider set up") : n === 1 ? localize('opencode.providers.one', "1 provider set up") : localize('opencode.providers.many', "{0} providers set up", n);
}
