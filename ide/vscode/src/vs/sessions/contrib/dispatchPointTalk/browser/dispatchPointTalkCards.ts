/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the card above the message box the first time Point and talk needs something (task-0y0km; kanban
 *  design/screen-talk A0: as wide as the box, right above it, like the sub-agent strip).
 *
 *  - Permissions: a row for the microphone (Allow: macOS's own dialog) and one for Screen Recording (Open Settings:
 *    System Settings at that list, with a small panel holding Dispatch's icon to drag in). Each row says Allowed with
 *    a grey check once it is; when Screen Recording was turned on while Dispatch runs, its row offers Quit & Reopen
 *    (macOS wants that) and a line says the sessions come back as they were. Not now closes it.
 *  - No Soniox key: what it is for and how to add it: Open Keys opens Settings › Keys with the form for SONIOX_API_KEY
 *    open, the cursor in Value; the card goes by itself once the key is saved (task-5wvgj).
 *  Buttons keep their words on one line.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import type { PointTalkAccessState } from '../../../../platform/dispatchPointTalk/common/dispatchPointTalk.js';

const $ = dom.$;

export interface IPointTalkPermissionState {
	readonly microphone: PointTalkAccessState;
	readonly screen: PointTalkAccessState;
	/** Screen Recording was turned on while Dispatch runs: it has to reopen once. */
	readonly relaunch: boolean;
}

export interface IPointTalkCardActions {
	allowMicrophone(): void;
	openScreenSettings(): void;
	relaunch(): void;
	openKeys(): void;
	close(): void;
}

/** The card's slot: first in the input part, above the box (and above the sub-agent strip's slot). */
export class PointTalkCard extends Disposable {

	private readonly slot: HTMLElement;
	private readonly draw = this._register(new DisposableStore());
	private kind: 'permissions' | 'key' | undefined;
	private sig = '';

	constructor(inputPart: HTMLElement, private readonly actions: IPointTalkCardActions) {
		super();
		this.slot = $('.dispatch-pt-card-slot');
		inputPart.prepend(this.slot);
		this._register(toDisposable(() => this.slot.remove()));
	}

	get element(): HTMLElement {
		return this.slot;
	}

	get showing(): 'permissions' | 'key' | undefined {
		return this.kind;
	}

	showPermissions(s: IPointTalkPermissionState): void {
		const sig = JSON.stringify(s);
		if (this.kind === 'permissions' && sig === this.sig) {
			return;
		}
		const enter = this.kind !== 'permissions';
		this.kind = 'permissions';
		this.sig = sig;
		this.draw.clear();
		dom.clearNode(this.slot);
		const card = dom.append(this.slot, $('.dispatch-pt-card', { role: 'region', 'aria-label': localize('dispatchPointTalk.permsLabel', "Point and talk permissions") }));
		card.classList.toggle('enter', enter);
		dom.append(card, $('.pt-ct', undefined, localize('dispatchPointTalk.permsTitle', "Point and talk needs two permissions")));
		dom.append(card, $('p', undefined, localize('dispatchPointTalk.permsWhy', "So Dispatch can hear you and see the screen under your pointer. Your voice is transcribed by Soniox.")));
		this.row(card, Codicon.mic, localize('dispatchPointTalk.mic', "Microphone"), s.microphone === 'granted' ? 'allowed'
			: { label: localize('dispatchPointTalk.allow', "Allow"), run: () => this.actions.allowMicrophone() });
		this.row(card, Codicon.deviceCameraVideo, localize('dispatchPointTalk.screen', "Screen Recording"), s.relaunch
			? { label: localize('dispatchPointTalk.reopen', "Quit & Reopen"), run: () => this.actions.relaunch(), fill: true }
			: s.screen === 'granted' ? 'allowed' : { label: localize('dispatchPointTalk.openSettings', "Open Settings"), run: () => this.actions.openScreenSettings() });
		if (s.relaunch) {
			dom.append(card, $('p.pt-after', undefined, localize('dispatchPointTalk.reopenWhy', "macOS needs Dispatch to reopen once. Your sessions come back as they were.")));
		} else {
			this.foot(card);
		}
	}

	showKey(): void {
		if (this.kind === 'key') {
			return;
		}
		this.kind = 'key';
		this.sig = '';
		this.draw.clear();
		dom.clearNode(this.slot);
		const card = dom.append(this.slot, $('.dispatch-pt-card.enter', { role: 'region', 'aria-label': localize('dispatchPointTalk.keyLabel', "Point and talk needs a Soniox key") }));
		dom.append(card, $('.pt-ct', undefined, localize('dispatchPointTalk.keyTitle', "Point and talk needs a Soniox key")));
		dom.append(card, $('p', undefined, localize('dispatchPointTalk.keyWhy', "Your voice is transcribed by Soniox with your own key. Press Open Keys, paste your Soniox key and save it. Then press the camera to record.")));
		this.row(card, Codicon.key, 'SONIOX_API_KEY', { label: localize('dispatchPointTalk.openKeys', "Open Keys"), run: () => this.actions.openKeys() });
		this.foot(card);
	}

	hide(): void {
		this.kind = undefined;
		this.sig = '';
		this.draw.clear();
		dom.clearNode(this.slot);
	}

	private row(card: HTMLElement, icon: ThemeIcon, name: string, right: 'allowed' | { label: string; run: () => void; fill?: boolean }): void {
		const row = dom.append(card, $('.pt-pr'));
		dom.append(row, $(`span${ThemeIcon.asCSSSelector(icon)}`, { 'aria-hidden': 'true' }));
		dom.append(row, $('span.pt-name', undefined, name));
		const r = dom.append(row, $('span.pt-r'));
		if (right === 'allowed') {
			dom.append(r, $(`span${ThemeIcon.asCSSSelector(Codicon.passFilled)}`, { 'aria-hidden': 'true' }));
			dom.append(r, $('span', undefined, localize('dispatchPointTalk.allowed', "Allowed")));
			return;
		}
		const b = dom.append(r, $(right.fill ? 'button.pt-btn.fill' : 'button.pt-btn.line', { type: 'button' }, right.label));
		this.draw.add(dom.addDisposableListener(b, dom.EventType.CLICK, e => {
			e.preventDefault();
			right.run();
		}));
	}

	private foot(card: HTMLElement): void {
		const foot = dom.append(card, $('.pt-foot'));
		dom.append(foot, $('span.pt-grow'));
		const later = dom.append(foot, $('button.pt-link', { type: 'button' }, localize('dispatchPointTalk.notNow', "Not now")));
		this.draw.add(dom.addDisposableListener(later, dom.EventType.CLICK, e => {
			e.preventDefault();
			this.actions.close();
		}));
	}
}
