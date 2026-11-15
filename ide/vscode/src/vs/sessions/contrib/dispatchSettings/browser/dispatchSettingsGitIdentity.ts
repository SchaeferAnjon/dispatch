/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Agents › Commits, "Your name on commits" (kanban task-pog4t): what git puts on every
 *  commit made on this Mac, with Change (or Add, while git has none: agents then ask before their first commit
 *  instead of making a name up). The asking and saving are dispatchCommon/browser/dispatchGitIdentity.ts.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { askGitIdentity, gitIdentityLine, IDispatchGitIdentity, saveGitIdentity } from '../../dispatchCommon/browser/dispatchGitIdentity.js';
import { settingsData } from './dispatchSettingsData.js';
import { button, row } from './dispatchSettingsDom.js';

export interface IGitIdentityRowDeps {
	readonly commandService: ICommandService;
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	readonly relayout: () => void;
}

export function renderGitIdentityRow(block: HTMLElement, store: DisposableStore, deps: IGitIdentityRowDeps): void {
	const r = row(block, {
		key: 'git-identity',
		label: localize('dispatchSettings.gitIdentity', "Your name on commits"),
		detail: localize('dispatchSettings.gitIdentityReading', "Reading what git has…"),
	}, store);
	let current: IDispatchGitIdentity | undefined;
	const draw = (g: IDispatchGitIdentity | undefined) => {
		current = g;
		r.ctl.replaceChildren();
		r.detail.hidden = false;
		if (!g) {
			r.detail.textContent = localize('dispatchSettings.gitIdentityUnread', "Dispatch could not read this just now.");
			deps.relayout();
			return;
		}
		r.detail.textContent = g.known
			? localize('dispatchSettings.gitIdentityIs', "{0}. Git puts it on every commit made on this Mac, yours and your agents'.", gitIdentityLine(g))
			: localize('dispatchSettings.gitIdentityNone', "Not set yet. Agents ask you before their first commit; add it here and they will not need to.");
		button(r.ctl, g.known ? localize('dispatchSettings.gitIdentityChange', "Change") : localize('dispatchSettings.gitIdentityAdd', "Add"), async () => {
			const start = current?.known ? current : { name: current?.name || current?.suggest?.name || '', email: current?.email || current?.suggest?.email || '' };
			const v = await askGitIdentity(deps.quickInputService, start);
			if (!v) {
				return;
			}
			const saved = await saveGitIdentity(deps.commandService, v);
			if (saved.ok === false) {
				deps.notificationService.warn(saved.message || localize('dispatchSettings.gitIdentityFailed', "Could not save it."));
				return;
			}
			settingsData.set('gitIdentity', saved);
			if (r.row.isConnected) {
				draw(saved);
			}
		}, store, !g.known);
		deps.relayout();
	};
	// what was read last (Settings reads it with everything else kept on this Mac, design/settings-fast)
	const kept = settingsData.get<IDispatchGitIdentity>('gitIdentity');
	if (kept) {
		draw(kept);
	}
}
