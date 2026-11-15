/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a Turbo run in the account menu (patches/420-turbo.patch; kanban design/frenzy:
 *  "while Turbo runs a bolt is in front, the stripes are what the run still plans to use"). Under the limits of
 *  the agent the run uses, one line: a bolt, a small meter (used, then striped what the run still plans to use)
 *  and a few words. Nothing when no run goes on that agent.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { dispatchTurboHooks, turboGoing } from './dispatchTurboHooks.js';

function hm(epoch: number | null | undefined): string {
	if (!epoch) {
		return '';
	}
	const d = new Date(epoch * 1000);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The line under `engine`'s limits while a Turbo run uses that agent; returns it, or undefined. */
export function appendTurboUsage(parent: HTMLElement, engine: string): HTMLElement | undefined {
	const live = dispatchTurboHooks.live;
	parent.querySelector('.dispatch-turbo-usage')?.remove();
	if (!turboGoing(live) || live.engine !== engine) {
		return undefined;
	}
	const row = DOM.append(parent, DOM.$('.dispatch-turbo-usage'));
	row.appendChild(DOM.$(ThemeIcon.asCSSSelector(Codicon.zap)));
	if (typeof live.used === 'number') {
		const meter = DOM.append(row, DOM.$('span.dispatch-turbo-usage-meter'));
		const used = Math.max(0, Math.min(100, live.used));
		DOM.append(meter, DOM.$('span.used')).style.width = `${used}%`;
		const plan = Math.max(0, Math.min(100 - used, live.plans_more ?? 0));
		if (plan > 0) {
			const p = DOM.append(meter, DOM.$('span.plan'));
			p.style.left = `${used}%`;
			p.style.width = `${plan}%`;
		}
	}
	DOM.append(row, DOM.$('span.dispatch-turbo-usage-words', undefined, live.paused
		? localize('dispatchTurboUsage.stopped', "Turbo stopped here · carries on at {0}", hm(live.resume_at))
		: live.plans_more
			? localize('dispatchTurboUsage.plans', "Turbo · about {0}% more until done", live.plans_more)
			: localize('dispatchTurboUsage.uses', "Turbo is using this")));
	row.title = localize('dispatchTurboUsage.tip', "{0}: the striped part is what the Turbo run still plans to use.", live.title);
	return row;
}
