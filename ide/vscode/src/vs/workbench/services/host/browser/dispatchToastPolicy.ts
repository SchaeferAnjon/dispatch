/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: one place that decides what a banner on this Mac does (kanban app/cli/notify_prefs.py,
 *  Settings › Notifications). Every toast of the window goes through the host service; Dispatch's bell
 *  (dispatchInbox.contribution.ts) installs a policy that drops the kinds the person turned off and plays the
 *  sound they picked. A toast that is not about an agent (no kind) passes untouched.
 *
 *  The kind is read from the toast's dedupe key: VS Code's own chat notifiers key theirs
 *  `chat-session:<resource>:needsInput|idle` (chatNotification.ts), the bell keys its own
 *  `dispatch-inbox:<kind>:<session>`.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IToastOptions } from './host.js';

export type DispatchToastKind = 'finished' | 'needs_you' | 'stopped';

/** What to show instead (a changed copy), or undefined to show nothing. */
export type DispatchToastPolicy = (options: IToastOptions, kind: DispatchToastKind) => IToastOptions | undefined;

let current: DispatchToastPolicy | undefined;

export function setDispatchToastPolicy(policy: DispatchToastPolicy): IDisposable {
	current = policy;
	return toDisposable(() => {
		if (current === policy) {
			current = undefined;
		}
	});
}

export function dispatchToastKind(options: Pick<IToastOptions, 'dedupeKey'>): DispatchToastKind | undefined {
	const key = options.dedupeKey ?? '';
	const own = /^dispatch-inbox:(finished|needs_you|stopped):/.exec(key);
	if (own) {
		return own[1] as DispatchToastKind;
	}
	if (key.startsWith('chat-session:')) {
		return key.endsWith(':needsInput') ? 'needs_you' : key.endsWith(':idle') ? 'finished' : undefined;
	}
	return undefined;
}

/** The toast to show for `options` under the installed policy; undefined when the person turned its kind off. */
export function applyDispatchToastPolicy(options: IToastOptions): IToastOptions | undefined {
	const kind = dispatchToastKind(options);
	return kind && current ? current(options, kind) : options;
}
