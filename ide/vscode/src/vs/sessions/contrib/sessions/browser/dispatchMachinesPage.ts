/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Machines page of the Agents window (the machines panel's Manage...). A custom view
 *  like Waiting for you, with its rows: every machine with its address, whether it is online and the
 *  dispatch version there; Rename, Address and Remove on each (the last two not on this Mac); Add machine
 *  at the top right. Edits go through dispatch-bridge's `dispatch.machines` (set / remove), the four step
 *  Add is the machines panel's own.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, IObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { clockTime, DISPATCH_MACHINES_ADD, dispatchMachines, editMachine, IDispatchMachine, machineMark, refreshDispatchMachines, setManageMachinesHandler } from '../../../../workbench/contrib/dispatchMachines/browser/dispatchMachines.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';

const $ = DOM.$;
export const DISPATCH_MACHINES_VIEW_ID = 'dispatch.machinesPage';
const MachinesViewMenu = new MenuId('DispatchMachinesView');

class DispatchMachinesPageContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'dispatch.contrib.machinesPage';
	constructor(@ICustomViewService customViewService: ICustomViewService) {
		super();
		this._register(customViewService.registerCustomView({
			id: DISPATCH_MACHINES_VIEW_ID,
			ctor: new SyncDescriptor(DispatchMachinesView),
			actions: { style: 'buttonBar', menuId: MachinesViewMenu },
		}, { restore: false }));
		setManageMachinesHandler(accessor => accessor.get(ICustomViewService).showCustomView(DISPATCH_MACHINES_VIEW_ID));
	}
}
registerWorkbenchContribution2(DispatchMachinesPageContribution.ID, DispatchMachinesPageContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.machines.page.add',
			title: localize2('dispatchMachinesPage.add', "Add machine"),
			menu: [{ id: MachinesViewMenu, group: 'navigation', order: 1 }],
		});
	}
	override run(accessor: ServicesAccessor): unknown {
		return accessor.get(ICommandService).executeCommand(DISPATCH_MACHINES_ADD);
	}
});

class DispatchMachinesView extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('dispatchMachinesPage.title', "Machines"));
	override readonly description: IObservable<string | undefined> = constObservable(
		localize('dispatchMachinesPage.description', "Your Macs. Each one opens in its own window with only its own sessions, projects and waiting items."));
	override readonly maxWidth = 880;
	private root: HTMLElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-waiting-page', 'dispatch-machines-page');
		this.root = container;
		const list = DOM.append(container, $('.dispatch-waiting-list'));
		const store = this._register(new DisposableStore());
		void refreshDispatchMachines(this.commandService);
		this._register(autorun(reader => {
			const machines = dispatchMachines.read(reader);
			store.clear();
			DOM.clearNode(list);
			if (!machines) {
				DOM.append(list, $('.dispatch-waiting-empty', undefined, localize('dispatchMachinesPage.loading', "Looking...")));
				return;
			}
			const group = DOM.append(list, $('.dispatch-waiting-group'));
			for (const m of [...machines].sort((a, b) => (b.local ? 1 : 0) - (a.local ? 1 : 0))) {
				this.renderRow(group, m, store);
			}
		}));
	}

	private renderRow(parent: HTMLElement, m: IDispatchMachine, store: DisposableStore): void {
		const row = DOM.append(parent, $('.dispatch-waiting-row.dispatch-machines-page-row'));
		const icon = DOM.append(row, $(`span.dispatch-waiting-icon${ThemeIcon.asCSSSelector(Codicon.vm)}`));
		icon.setAttribute('aria-hidden', 'true');
		const text = DOM.append(row, $('span.dispatch-waiting-text'));
		DOM.append(text, $('span.dispatch-waiting-title', undefined, m.name));
		const facts = [
			m.local ? localize('dispatchMachinesPage.thisMac', "This Mac") : m.ssh,
			m.dispatch_version ? localize('dispatchMachinesPage.version', "Dispatch {0}", m.dispatch_version) : undefined,
		].filter(Boolean);
		DOM.append(text, $('span.dispatch-waiting-phrase', undefined, ` · ${facts.join(' · ')}`));
		// the state as the machines panel shows it: the green filled circle online, the large ring offline
		const state = DOM.append(row, $('span.dispatch-machines-page-state'));
		DOM.append(state, machineMark(m.online ? 'online' : 'offline'));
		DOM.append(state, $('span', undefined, m.online
			? localize('dispatchMachinesPage.online', "Online")
			: m.last_seen ? localize('dispatchMachinesPage.lastSeen', "Offline · last seen {0}", clockTime(m.last_seen)) : localize('dispatchMachinesPage.offline', "Offline")));
		const buttons = DOM.append(row, $('span.dispatch-waiting-actions'));
		const add = (what: 'rename' | 'address' | 'remove', label: string) => {
			const b = DOM.append(buttons, $('button.dispatch-waiting-btn', undefined, label));
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => void this.instantiationService.invokeFunction(a => editMachine(a, m, what))));
		};
		add('rename', localize('dispatchMachinesPage.rename', "Rename"));
		if (!m.local) {
			add('address', localize('dispatchMachinesPage.address', "Address"));
			add('remove', localize('dispatchMachinesPage.remove', "Remove"));
		}
	}

	layout(_width: number, _height: number): void { }

	override focus(): void {
		this.root?.querySelector<HTMLElement>('.dispatch-waiting-btn')?.focus();
	}
}
