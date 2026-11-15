/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the first-run choices again, on Customizations > Overview (the wizard asks them once):
 *  how much agents may do on their own, notifications on this Mac, and keeping the Mac awake while an
 *  agent works. Same rows and switches as the rest of the page; the data and the changes go through
 *  dispatch-bridge's `dispatch.firstRun` (kanban app/cli/autonomy.py, awake.py, firstrun.py).
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AWAKE_TEXT, DEFAULT_AUTONOMY, IAutonomy, NOTIFY_TEXT } from '../../dispatchAgents/browser/dispatchFirstRunModel.js';
import { DISPATCH_NOTIFY_TEST_COMMAND, INotifyTestAnswer } from '../../dispatchAgents/browser/dispatchNotifyTest.js';
import './media/dispatchFirstRunSettings.css';

const $ = DOM.$;

interface IAnswer { readonly ok?: boolean; readonly message?: string }

/** `dispatch settings --json`, the two settings this page reads. */
interface ISettings { readonly keep_awake?: number; readonly notify_desktop?: number }

export function renderFirstRunSettings(parent: HTMLElement, commands: ICommandService, store: DisposableStore, layout: () => void): void {
	const row = (host: HTMLElement, title: string, description: string) => {
		const r = DOM.append(host, $('.dispatch-customization-row'));
		const text = DOM.append(r, $('.dispatch-customization-text'));
		DOM.append(text, $('div.dispatch-customization-name', {}, title));
		DOM.append(text, $('div.dispatch-customization-description', {}, description));
		return { row: r, text, actions: DOM.append(r, $('.dispatch-customization-actions')) };
	};
	const alert = (text: HTMLElement, message: string) => {
		for (const old of text.querySelectorAll('[role=alert]')) { old.remove(); }
		DOM.append(text, $('div.dispatch-customization-description', { role: 'alert' }, message));
		layout();
	};
	const switchRow = (host: HTMLElement, title: string, description: string, on: boolean, save: (on: boolean) => Promise<void>, ariaLabel = title) => {
		const r = row(host, title, description);
		const check = store.add(new Checkbox(ariaLabel, on, defaultCheckboxStyles));
		const wrap = DOM.append(r.actions, $('.dispatch-hook-agent'));
		wrap.appendChild(check.domNode);
		const state = DOM.append(wrap, $('span', {}, on ? 'On' : 'Off'));
		store.add(check.onChange(async () => {
			const want = check.checked;
			check.disable();
			try {
				await save(want);
				state.textContent = want ? 'On' : 'Off';
			} catch (error) {
				check.checked = !want;
				alert(r.text, error instanceof Error ? error.message : String(error));
			}
			check.enable();
		}));
		return r;
	};
	const ask = async <T extends IAnswer>(op: string, arg?: unknown): Promise<T> => {
		const answer = await commands.executeCommand<T>('dispatch.firstRun', op, arg);
		if (!answer || answer.ok === false) { throw new Error(answer?.message || 'Dispatch could not do that.'); }
		return answer;
	};

	void (async () => {
		const [autonomy, settings] = await Promise.all([ask<IAutonomy & IAnswer>('autonomy'), ask<ISettings & IAnswer>('state').catch(() => ({} as ISettings))]);
		if (!parent.isConnected) { return; }

		// 1 how much agents may do on their own: one of three, single-choice rows like the wizard's (the tick in
		// front, the title over its one line, no On / Off)
		DOM.append(parent, $('h3.plugin-card-section-title', {}, 'Agent permissions'));
		const level = { id: autonomy.level };
		const boxes: { id: string; check: Checkbox }[] = [];
		for (const l of autonomy.levels) {
			const r = row(parent, l.title, l.detail);
			r.row.classList.add('dispatch-autonomy-row');
			r.row.dataset.dispatchAutonomy = l.id;
			if (l.id === DEFAULT_AUTONOMY) {
				r.text.querySelector('.dispatch-customization-name')?.appendChild($('span.dispatch-customization-tag', {}, 'Default'));
			}
			const check = store.add(new Checkbox(l.title, l.id === level.id, defaultCheckboxStyles));
			r.row.insertBefore(check.domNode, r.text);
			boxes.push({ id: l.id, check });
			const pick = async () => {
				const previous = level.id;
				const show = (id: string) => { for (const b of boxes) { b.check.checked = b.id === id; } };
				show(l.id);
				if (previous === l.id) { return; }   // one is always picked: a click on it keeps it
				try {
					await commands.executeCommand('_dispatch.autonomy.apply', l.id);
					level.id = l.id;
				} catch (error) {
					show(previous);
					alert(r.text, error instanceof Error ? error.message : String(error));
				}
			};
			store.add(check.onChange(() => void pick()));
			store.add(DOM.addDisposableListener(r.text, DOM.EventType.CLICK, () => void pick()));
		}

		// 2 notifications on this Mac
		DOM.append(parent, $('h3.plugin-card-section-title', {}, 'Notifications on this Mac'));
		const n = switchRow(parent, NOTIFY_TEXT.title, NOTIFY_TEXT.detail, settings.notify_desktop === 1, async on => { await ask('notify-set', { on }); });
		n.row.dataset.dispatchNotify = 'desktop';
		const test = store.add(new Button(n.actions, { ...defaultButtonStyles, secondary: true }));
		test.label = 'Send a test notification';
		store.add(test.onDidClick(async () => {
			try { alert(n.text, (await commands.executeCommand<INotifyTestAnswer>(DISPATCH_NOTIFY_TEST_COMMAND))!.message); } catch (error) { alert(n.text, error instanceof Error ? error.message : String(error)); }
		}));
		const open = store.add(new Button(n.actions, { ...defaultButtonStyles, secondary: true }));
		open.label = 'Open System Settings';
		store.add(open.onDidClick(() => { void ask('notify-open').catch(error => alert(n.text, error instanceof Error ? error.message : String(error))); }));

		// 3 keep the Mac awake
		DOM.append(parent, $('h3.plugin-card-section-title', {}, 'While agents work'));
		const a = switchRow(parent, AWAKE_TEXT.title, AWAKE_TEXT.detail, settings.keep_awake !== 0, async on => { await ask('awake-set', { on }); });
		a.row.dataset.dispatchAwake = 'keep-awake';
		layout();
	})().catch(error => {
		if (!parent.isConnected) { return; }
		DOM.append(parent, $('p', { role: 'alert' }, error instanceof Error ? error.message : String(error)));
		layout();
	});
}
