/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the line's settings on the Settings page's Agents page (patches/415-next-up.patch;
 *  kanban design/chat-capture direction B, task-tix5). How many sessions may work at once before the next thing in
 *  line waits, which agent a lined-up thing starts with, and whether it starts by itself at all (the same switch as
 *  Pause). Read and written through `dispatch nextup settings | limit | engine | pause | resume`, the very values
 *  the command line changes (DISPATCH_DIR/capture/queue.json); nothing is kept in the window.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { groupHead, pending, problem, row, rowsBlock, segmented, toggle } from '../../dispatchSettings/browser/dispatchSettingsDom.js';
import { settingsData } from '../../dispatchSettings/browser/dispatchSettingsData.js';
import { CAPTURE_COMMAND, onDidChangeNextUp } from './dispatchCaptureModel.js';

interface INextUpSettings {
	readonly paused: boolean;
	readonly limit: number;
	readonly engine: string;
	readonly default_engine?: string;
	/** A start that did not happen, in plain words (capture.py failed_view). */
	readonly failed?: { readonly title?: string; readonly why?: string; readonly stuck?: boolean };
	readonly ok?: boolean;
	readonly error?: string;
}

/** An agent the line can start: the ones that are on (the Agents page's own rows). */
export interface INextUpAgent {
	readonly id: string;
	readonly name: string;
}

const AT_ONCE = [1, 2, 3, 4, 5];
/** The Agents page's ids (claude-code …) as `dispatch nextup engine` takes them. */
const ENGINE_OF: Record<string, string> = { 'claude-code': 'claude', claude: 'claude', codex: 'codex', opencode: 'opencode' };

export function renderNextUpSettings(body: HTMLElement, store: DisposableStore, commandService: ICommandService, notificationService: INotificationService, agents: readonly INextUpAgent[], relayout: () => void): void {
	groupHead(body, localize('nextUpSettings.head', "Next up"), Codicon.listOrdered);
	DOM.append(body, DOM.$('.dset-sub', undefined, localize('nextUpSettings.sub', "What you ask for in a chat goes on the board and lines up behind the work already running; what you say is for later waits in Later. With Start by itself on, the next one starts once nothing else works in its project.")));
	const block = rowsBlock(body, 'nextup');

	const ask = async <T>(op: string, arg?: object): Promise<T | undefined> => {
		try {
			return await commandService.executeCommand<T>(CAPTURE_COMMAND, op, arg ?? {});
		} catch (e) {
			return { ok: false, error: String((e as Error)?.message ?? e) } as T;
		}
	};
	const write = async (op: string, arg?: object): Promise<boolean> => {
		const r = await ask<{ ok?: boolean; error?: string }>(op, arg);
		if (!r || r.ok === false) {
			notificationService.warn(r?.error || localize('nextUpSettings.failed', "Dispatch could not change that just now."));
			return false;
		}
		onDidChangeNextUp.fire();
		// what it is now, for the next time the page is drawn
		const now = await ask<INextUpSettings>('settings');
		if (now && now.ok !== false) {
			settingsData.set('nextup', now);
		}
		return true;
	};

	// what was read last: Settings reads it with everything else kept on this Mac (design/settings-fast)
	const s = settingsData.get<INextUpSettings>('nextup');
	if (!s) {
		pending(block);
		return;
	}

	if (s.ok === false || typeof s.limit !== 'number') {
		problem(block, localize('nextUpSettings.cannotRead', "Dispatch could not read these just now."));
		relayout();
		return;
	}

	// 1. how many at once
	const once = row(block, {
		label: localize('nextUpSettings.atOnce', "Work at once"),
		detail: localize('nextUpSettings.atOnceDetail', "How many sessions may work at the same time. The next thing in line waits for one to finish."),
		key: 'nextup-limit',
	}, store);
	const counts = AT_ONCE.includes(s.limit) ? AT_ONCE : [...AT_ONCE, s.limit].sort((a, b) => a - b);
	segmented(once.ctl, localize('nextUpSettings.atOnce2', "Work at once"), counts.map(n => ({ id: String(n), label: String(n) })), String(s.limit), id => void write('limit', { limit: Number(id) }), store);

	// 2. which agent starts them
	const engine = row(block, {
		label: localize('nextUpSettings.startsWith', "Starts with"),
		detail: localize('nextUpSettings.startsWithDetail', "The agent a thing in line starts with. Default follows the agent new sessions start with."),
		key: 'nextup-engine',
	}, store);
	const options = [{ id: 'default', label: localize('nextUpSettings.default', "Default") }];
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
	segmented(engine.ctl, localize('nextUpSettings.startsWith2', "Starts with"), options, current, id => void write('engine', { engine: id }), store);

	// 3. by itself, or only when you say (Pause)
	const auto = row(block, {
		label: localize('nextUpSettings.byItself', "Start by itself"),
		detail: localize('nextUpSettings.byItselfDetail2', "Off until you turn it on. Off is the same as Pause: things wait in Next up, work already running goes on."),
		key: 'nextup-auto',
	}, store);
	toggle(auto.ctl, localize('nextUpSettings.byItself2', "Start by itself"), !s.paused, on => write(on ? 'resume' : 'pause'), store);
	if (s.failed?.why && !s.paused) {
		problem(block, localize('nextUpSettings.failedLine', "\"{0}\" did not start. {1}", s.failed.title ?? '', s.failed.why));
	}
}
