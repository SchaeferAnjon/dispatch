/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: you, at the top of Settings' Overview (patches/510-settings.patch, kanban design/
 *  settings direction B: "Overview：头像和名字"). Your GitHub picture and name from `dispatch me` (the same as the
 *  title bar's picture, contrib/dispatchTitleBar/browser/dispatchAvatar.ts), then which Dispatch on which Mac. No
 *  GitHub account on this Mac: an outline person and a line saying where the picture comes from; never letters.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSettingsMe.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { dispatchMachines } from '../../../../workbench/contrib/dispatchMachines/browser/dispatchMachines.js';
import { askDispatchAvatar, dispatchAvatarUrl, dispatchMe, onDidChangeDispatchAvatar } from '../../dispatchTitleBar/browser/dispatchAvatar.js';

const $ = DOM.$;

export function renderSettingsMe(root: HTMLElement, store: DisposableStore, commandService: ICommandService): void {
	const box = DOM.append(root, $('.dset-me'));
	box.dataset.k = 'picture';
	box.dataset.part = 'settings-me';
	const pic = DOM.append(box, $('.dset-me-pic'));
	const text = DOM.append(box, $('.dset-me-t'));
	const name = DOM.append(text, $('.dset-me-name'));
	const sub = DOM.append(text, $('.dset-me-sub'));
	let mac = '';
	// Dispatch's own version, the one the Macs page and the updates show (0.9.0), not the editor's (1.139.1-dispatch,
	// kanban task-eibd9); the window learns it with the list of Macs, nothing is shown until then
	let version = '';
	const draw = () => {
		const me = dispatchMe();
		const url = dispatchAvatarUrl();
		DOM.clearNode(pic);
		if (url) {
			const img = DOM.append(pic, $('img', { src: url, alt: localize('dispatchSettingsMe.alt', "{0}'s picture on GitHub", me?.github ?? '') })) as HTMLImageElement;
			img.referrerPolicy = 'no-referrer';
			img.onerror = () => {
				// offline: the outline person instead of a broken picture
				DOM.clearNode(pic);
				DOM.append(pic, $(`span${ThemeIcon.asCSSSelector(Codicon.account)}`));
			};
		} else {
			DOM.append(pic, $(`span${ThemeIcon.asCSSSelector(Codicon.account)}`));
		}
		name.textContent = me?.name || localize('dispatchSettingsMe.you', "You");
		const where = mac
			? (version ? localize('dispatchSettingsMe.onMac', "Dispatch {0} on {1}", version, mac) : localize('dispatchSettingsMe.onMacNoVersion', "Dispatch on {0}", mac))
			: (version ? localize('dispatchSettingsMe.version', "Dispatch {0}", version) : localize('dispatchSettingsMe.noVersion', "Dispatch"));
		sub.textContent = !me
			? where
			: url
				? `${where} · ${localize('dispatchSettingsMe.fromGitHub', "picture from GitHub")}`
				: `${where} · ${localize('dispatchSettingsMe.noGitHub', "your picture shows here once GitHub is set up on this Mac")}`;
	};
	store.add(onDidChangeDispatchAvatar(draw));
	store.add(autorun(reader => {
		const local = dispatchMachines.read(reader)?.find(m => m.local);
		mac = local?.name ?? '';
		version = local?.dispatch_version ?? '';
		draw();
	}));
	askDispatchAvatar(commandService);
}
