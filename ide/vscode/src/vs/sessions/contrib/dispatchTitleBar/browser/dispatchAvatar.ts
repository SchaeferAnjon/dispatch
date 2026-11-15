/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: your picture at the top right of the Agents window (patches/110-title-bar.patch,
 *  kanban design/bars: "your GitHub picture, not letters"). Dispatch has no GitHub sign-in of its own, so the
 *  account comes from `dispatch me` (the GitHub CLI's login file, else git's github.user) through dispatch-bridge's
 *  `dispatch.me`, asked once per window. The account widget (contrib/accountMenu) shows it when it has no picture
 *  of its own.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

interface IMe {
	readonly github?: string;
	readonly name?: string;
	readonly avatar?: string;
}

let me: IMe | undefined;
let asked = false;
const onDidChange = new Emitter<void>();

/** The picture's address, once known; undefined before that or when this Mac has no GitHub account. */
export function dispatchAvatarUrl(): string | undefined {
	return me?.avatar && /^https:\/\/github\.com\/[A-Za-z0-9-]+\.png\?size=\d+$/.test(me.avatar) ? me.avatar : undefined;
}

/** Who uses this Mac as `dispatch me` says it: the GitHub account and the name (git's user.name, else the account). */
export function dispatchMe(): { readonly github: string; readonly name: string } | undefined {
	return me ? { github: me.github ?? '', name: me.name || me.github || '' } : undefined;
}

/** Whose picture it is, for its alt text. */
export function dispatchAvatarName(): string | undefined {
	return me?.github || undefined;
}

export const onDidChangeDispatchAvatar: Event<void> = onDidChange.event;

/** Ask the bridge once (again a few times while it is still starting); later calls do nothing. */
export function askDispatchAvatar(commandService: ICommandService, tries = 6): void {
	if (asked) {
		return;
	}
	asked = true;
	commandService.executeCommand<IMe>('dispatch.me').then(r => {
		if (r && typeof r === 'object') {
			me = r;
			onDidChange.fire();
		}
	}, () => {
		// the bridge is not up yet
		if (tries > 1) {
			mainWindow.setTimeout(() => {
				asked = false;
				askDispatchAvatar(commandService, tries - 1);
			}, 5000);
		}
	});
}
