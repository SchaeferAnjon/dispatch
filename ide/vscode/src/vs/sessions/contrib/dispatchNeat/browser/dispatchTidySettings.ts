/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Tidy up after work, on the Settings page's Agents page (patches/535-tidy-up.patch,
 *  kanban task-uf2dy). The built-in neat-freak skill run by itself, read only: off (the default), after each finished
 *  task, or once a day; and the agent it runs with. Read and written through `dispatch neat status | auto`
 *  (kanban app/cli/neat_auto.py, ~/.dispatch/config.json); nothing is kept in the window. A run ends in the bell.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { groupHead, pending, problem, row, rowsBlock, segmented } from '../../dispatchSettings/browser/dispatchSettingsDom.js';
import { settingsData } from '../../dispatchSettings/browser/dispatchSettingsData.js';
import { tidyLastLine } from './dispatchTidyModel.js';

interface ITidySettings {
	readonly auto: 'off' | 'task' | 'daily';
	readonly engine: string;
	readonly last?: { readonly project?: string; readonly at?: number; readonly line?: string; readonly status?: string } | null;
	readonly ok?: boolean;
	readonly error?: string;
}

interface ITidyAgent {
	readonly id: string;
	readonly name: string;
}

/** The Agents page's ids (claude-code …) as `dispatch neat auto --engine` takes them. */
const ENGINE_OF: Record<string, string> = { 'claude-code': 'claude', claude: 'claude', codex: 'codex', opencode: 'opencode' };

export function renderTidySettings(body: HTMLElement, store: DisposableStore, commandService: ICommandService, notificationService: INotificationService, agents: readonly ITidyAgent[], relayout: () => void): void {
	groupHead(body, localize('tidySettings.head', "Tidy up after work"), Codicon.sparkle);
	DOM.append(body, DOM.$('.dset-sub', undefined, localize('tidySettings.sub', "An agent checks a project's docs, rules and what Dispatch knows against the code, and tells you in the bell what is out of date. It only reads and changes nothing. Each check uses some of that agent's usage.")));
	const block = rowsBlock(body, 'tidy');

	const ask = async <T>(op: string, arg?: object): Promise<T | undefined> => {
		try {
			const r = await commandService.executeCommand<{ ok?: boolean; result?: T; error?: string }>('dispatch.customizations', op, arg ?? {});
			return r?.ok ? r.result : ({ ok: false, error: r?.error } as T);
		} catch (e) {
			return { ok: false, error: String((e as Error)?.message ?? e) } as T;
		}
	};
	const write = async (arg: object): Promise<void> => {
		const r = await ask<ITidySettings>('neat-set', arg);
		if (!r || r.ok === false) {
			notificationService.warn(r?.error || localize('tidySettings.failed', "Dispatch could not change that just now."));
			return;
		}
		settingsData.set('neat', r);
	};

	// what was read last: Settings reads it with everything else kept on this Mac (design/settings-fast)
	const s = settingsData.get<ITidySettings>('neat');
	if (!s) {
		pending(block);
		return;
	}

	if (s.ok === false || !s.auto) {
		problem(block, localize('tidySettings.cannotRead', "Dispatch could not read this just now."));
		relayout();
		return;
	}
	const when = row(block, {
		label: localize('tidySettings.when', "Check by itself"),
		detail: localize('tidySettings.whenDetail', "Off until you turn it on. You can also type /neat-freak in a session: the agent reports first and changes only what you pick."),
		key: 'tidy-auto',
	}, store);
	segmented(when.ctl, localize('tidySettings.when2', "Check by itself"), [
		{ id: 'off', label: localize('tidySettings.off', "Off") },
		{ id: 'task', label: localize('tidySettings.task', "After each task") },
		{ id: 'daily', label: localize('tidySettings.daily', "Once a day") },
	], s.auto, id => void write({ auto: id }), store);

	const engine = row(block, {
		label: localize('tidySettings.with', "Checks with"),
		detail: localize('tidySettings.withDetail', "The agent that does the check. Default follows the agent new sessions start with."),
		key: 'tidy-engine',
	}, store);
	const options = [{ id: 'default', label: localize('tidySettings.default', "Default") }];
	for (const a of agents) {
		const id = ENGINE_OF[a.id];
		if (id && !options.some(o => o.id === id)) {
			options.push({ id, label: a.name });
		}
	}
	const current = s.engine || 'default';
	if (!options.some(o => o.id === current)) {
		options.push({ id: current, label: current });
	}
	segmented(engine.ctl, localize('tidySettings.with2', "Checks with"), options, current, id => void write({ engine: id }), store);

	const last = tidyLastLine(s.last ?? undefined, Date.now());
	if (last) {
		DOM.append(body, DOM.$('.dset-foot', undefined, last));
	}
}
