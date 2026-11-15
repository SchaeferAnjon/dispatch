/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Notifications, "On this Mac" (kanban app/cli/notify_prefs.py, task-k1js2). Which of
 *  the bell's three kinds also show a banner here (finished, needs you, stopped; a stop is off by default, the
 *  bell lists it either way), the banner's sound (the Mac's own alert sound, none, or one of the Mac's sounds;
 *  moving through the list plays each one), and banners for agents outside the window (notify_desktop, the
 *  first-run wizard's switch). Built from the page's own rows, switches and buttons; saved through
 *  `dispatch.settings save`, after which the window's banners follow at once (DISPATCH_NOTIFY_PREFS_CHANGED).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { button, iconButton, row, rowsBlock, toggle } from './dispatchSettingsDom.js';

/** The bell's settings command (dispatchInbox.contribution.ts): read the prefs again after a save. */
const PREFS_CHANGED = '_dispatch.inbox.prefsChanged';

export type MacKindKey = 'notify_mac_finished' | 'notify_mac_needs_you' | 'notify_mac_stopped';

export interface IMacNotifyValues {
	readonly notify_mac_finished: boolean;
	readonly notify_mac_needs_you: boolean;
	readonly notify_mac_stopped: boolean;
	readonly notify_sound: string;
}

interface IPrefs { readonly sounds?: readonly string[] }

export interface IMacNotifyHost {
	readonly commandService: ICommandService;
	readonly quickInputService: IQuickInputService;
	save(patch: Record<string, boolean | string>): Promise<boolean>;
}

/** What a sound setting reads as. */
export function soundLabel(name: string): string {
	return name === 'none' ? localize('dispatchSettings.soundNone', "None")
		: name === 'default' ? localize('dispatchSettings.soundDefault', "Mac alert sound")
			: name;
}

/** The kind rows and the sound row, into `parent` (the "On this Mac" group). */
export function renderMacNotify(parent: HTMLElement, values: IMacNotifyValues, store: DisposableStore, host: IMacNotifyHost): void {
	const kinds = rowsBlock(parent, 'mac-kinds');
	const rows: [MacKindKey, string, string][] = [
		['notify_mac_finished', localize('dispatchSettings.kFinished', "An agent finished"), localize('dispatchSettings.kFinishedD', "Its turn is over and the answer is ready to read.")],
		['notify_mac_needs_you', localize('dispatchSettings.kNeedsYou', "An agent needs you"), localize('dispatchSettings.kNeedsYouD', "It waits for your OK, or asks you something.")],
		['notify_mac_stopped', localize('dispatchSettings.kStopped', "An agent stopped without finishing"), localize('dispatchSettings.kStoppedD', "An error, a usage limit, or its process ended. The bell lists it either way.")],
	];
	const changed = () => void host.commandService.executeCommand(PREFS_CHANGED).catch(() => undefined);
	for (const [key, label, detail] of rows) {
		const r = row(kinds, { label, detail }, store);
		r.row.dataset.notify = key;
		toggle(r.ctl, label, values[key], async want => {
			const ok = await host.save({ [key]: want });
			if (ok) {
				changed();
			}
			return ok;
		}, store);
	}

	const soundBlock = rowsBlock(parent, 'mac-sound');
	const s = row(soundBlock, { label: localize('dispatchSettings.sound', "Sound"), detail: localize('dispatchSettings.soundD', "Plays with the banner.") }, store);
	s.row.dataset.notify = 'notify_sound';
	let current = values.notify_sound || 'default';
	const pick = button(s.ctl, '', () => choose(), store);
	pick.element.classList.add('dset-sound-pick');
	const show = () => {
		pick.label = `${soundLabel(current)} $(chevron-down)`;
		pick.element.title = localize('dispatchSettings.soundPick', "Choose the sound");
		pick.element.dataset.sound = current;
	};
	show();
	const play = (name: string) => void host.commandService.executeCommand('dispatch.inbox', 'sound', name).catch(() => undefined);
	iconButton(s.ctl, Codicon.play, localize('dispatchSettings.soundPlay', "Play it"), () => play(current), store).classList.add('dset-sound-play');

	const choose = async () => {
		const prefs = await host.commandService.executeCommand<IPrefs>('dispatch.inbox', 'prefs').catch(() => undefined);
		const names = ['default', 'none', ...(prefs?.sounds ?? [])];
		const items: (IQuickPickItem & { name: string })[] = names.map(name => ({
			name,
			label: soundLabel(name),
			description: name === 'default' ? localize('dispatchSettings.soundDefaultD', "the one in System Settings › Sound") : undefined,
			picked: name === current,
		}));
		const qp = store.add(host.quickInputService.createQuickPick<IQuickPickItem & { name: string }>());
		qp.title = localize('dispatchSettings.soundTitle', "Banner sound");
		qp.placeholder = localize('dispatchSettings.soundHint', "Move through the list to hear each one");
		qp.items = items;
		qp.activeItems = items.filter(i => i.name === current);
		let first = true;
		store.add(qp.onDidChangeActive(active => {
			// the list opening on the current one is not a choice: no sound yet
			if (first) {
				first = false;
				return;
			}
			const n = active[0]?.name;
			if (n && n !== 'none') {
				play(n);
			}
		}));
		store.add(qp.onDidAccept(async () => {
			const n = qp.selectedItems[0]?.name ?? qp.activeItems[0]?.name;
			qp.hide();
			if (!n || n === current) {
				return;
			}
			const before = current;
			current = n;
			show();
			if (await host.save({ notify_sound: n })) {
				changed();
			} else {
				current = before;
				show();
			}
		}));
		store.add(qp.onDidHide(() => qp.dispose()));
		qp.show();
	};
}
