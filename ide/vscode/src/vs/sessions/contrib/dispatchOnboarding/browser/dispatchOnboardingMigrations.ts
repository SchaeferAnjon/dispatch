/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

let host: { commands: ICommandService; notifications: INotificationService } | undefined;

export function registerOnboardingMigrations(commands: ICommandService, notifications: INotificationService): IDisposable {
	const current = host = { commands, notifications };
	return toDisposable(() => { if (host === current) { host = undefined; } });
}

export function renderOnboardingMigrations(parent: HTMLElement, changed: () => void): IDisposable | undefined {
	return host ? new DispatchOnboardingMigrations(parent, host.commands, host.notifications, changed) : undefined;
}

interface ImportRow {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
	readonly kind?: string;
	readonly step?: string;
	readonly undone?: boolean;
	readonly projects?: readonly { readonly name: string; readonly dir: string; readonly git_init: boolean }[];
}

/** What else Dispatch brought in (`dispatch customizations list`: rule blocks, hooks, moved folders, older preference imports). */
interface InventoryImport {
	readonly id: string;
	readonly kind?: string;
	readonly name: string;
	readonly from: string;
	readonly to: string;
	readonly detail: string;
	readonly can_undo: boolean;
	readonly reason: string;
	readonly undone?: boolean;
}

/**
 * The Migrations page's one list of what Dispatch imported: setup's receipts and every other import, under one
 * "Imported by Dispatch" (it used to be two lists with the same name, one of them saying nothing was imported),
 * then the setup steps still available.
 */
export class DispatchOnboardingMigrations extends Disposable {
	private readonly element: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private disposed = false;

	constructor(parent: HTMLElement, private readonly commands: ICommandService, private readonly notifications: INotificationService, private readonly onDidChangeContent: () => void = () => {}) {
		super();
		this.element = DOM.append(parent, DOM.$('section.dispatch-onboarding-migrations', { 'aria-label': 'Dispatch imports' }));
		this._register({ dispose: () => { this.disposed = true; } });
		// the dashboard is made with the customizations editor, which Settings makes for every first ability page; its
		// three reads (CLI runs) wait until it is on screen (design/settings-fast)
		const io = new IntersectionObserver(entries => {
			if (entries.some(e => e.isIntersecting)) {
				io.disconnect();
				void this.load();
			}
		});
		io.observe(this.element);
		this._register({ dispose: () => io.disconnect() });
	}

	private async load(): Promise<void> {
		try {
			const [log, available, inventory] = await Promise.all([
				this.commands.executeCommand<{ items: ImportRow[] }>('dispatch.onboarding', 'log'),
				this.commands.executeCommand<{ items: ImportRow[] }>('dispatch.onboarding', 'available'),
				// the rest of the imports; setup's own receipts come from the log above (with their projects and Undo)
				this.commands.executeCommand<{ ok: boolean; result?: { imports?: InventoryImport[] } }>('dispatch.customizations', 'list')
					.then(answer => (answer?.ok ? answer.result?.imports ?? [] : []).filter(entry => entry.kind !== 'setup'), () => [] as InventoryImport[]),
			]);
			if (this.disposed) { return; }
			if (!log || !available) { throw new Error('Dispatch did not answer.'); }
			this.renderStore.clear();
			DOM.clearNode(this.element);
			DOM.append(this.element, DOM.$('h2', undefined, 'Imported by Dispatch'));
			if (!log.items.length && !inventory.length) { DOM.append(this.element, DOM.$('p.migration-empty', undefined, 'Nothing imported yet. Set up Dispatch to bring in projects and preferences.')); }
			for (const item of log.items) { this.row(item, false); }
			for (const entry of inventory) { this.importRow(entry); }
			if (available.items.length) {
				DOM.append(this.element, DOM.$('h2', undefined, 'Available'));
				for (const item of available.items) { this.row(item, true); }
			}
			this.onDidChangeContent();
		} catch (e) {
			if (this.disposed) { return; }
			DOM.clearNode(this.element);
			DOM.append(this.element, DOM.$('p.migration-empty', undefined, 'Could not read Dispatch imports.'));
			this.button(this.element, 'Retry', () => this.load());
		}
	}

	private button(parent: HTMLElement, label: string, run: () => Promise<unknown>, ariaLabel = label): void {
		const button = this.renderStore.add(new Button(parent, { ...defaultButtonStyles, secondary: true, ariaLabel }));
		button.label = label;
		this.renderStore.add(button.onDidClick(async () => {
			button.enabled = false;
			try { await run(); } catch (e) { this.notifications.warn(String((e as Error)?.message ?? e)); }
			finally { if (!this.disposed) { button.enabled = true; } }
		}));
	}

	/** Another import: what it is, where from and to, Undo (or why it cannot be undone). */
	private importRow(entry: InventoryImport): void {
		const row = DOM.append(this.element, DOM.$('.dispatch-import-row'));
		row.dataset.dispatchImport = entry.id;
		const text = DOM.append(row, DOM.$('.dispatch-import-text'));
		DOM.append(text, DOM.$('span', undefined, entry.name));
		if (!entry.undone && entry.detail) { DOM.append(text, DOM.$('p', undefined, entry.detail)); }
		DOM.append(text, DOM.$('p', undefined, `From ${entry.from}`));
		DOM.append(text, DOM.$('p', undefined, `To ${entry.to}`));
		if (entry.reason && !entry.undone) { DOM.append(text, DOM.$('p', undefined, entry.reason)); }
		const actions = DOM.append(row, DOM.$('.dispatch-import-actions'));
		if (entry.undone) { DOM.append(actions, DOM.$('span', undefined, 'Undone')); return; }
		if (!entry.can_undo) { return; }
		this.button(actions, 'Undo', async () => {
			const answer = await this.commands.executeCommand<{ ok: boolean; error?: string }>('dispatch.customizations', 'undo', { id: entry.id });
			if (!answer?.ok) { throw new Error(answer?.error || 'Dispatch did not answer.'); }
			await this.load();
		}, `Undo ${entry.name}`);
	}

	private row(item: ImportRow, available: boolean): void {
		const row = DOM.append(this.element, DOM.$('.dispatch-import-row'));
		const text = DOM.append(row, DOM.$('.dispatch-import-text'));
		DOM.append(text, DOM.$('span', undefined, item.title));
		DOM.append(text, DOM.$('p', undefined, item.detail));
		let alsoGit = false;
		if (item.projects?.length) {
			const details = DOM.append(text, DOM.$('details'));
			this.renderStore.add(DOM.addDisposableListener(details, 'toggle', () => this.onDidChangeContent()));
			DOM.append(details, DOM.$('summary', undefined, `${item.projects.length} projects`));
			for (const project of item.projects) {
				DOM.append(details, DOM.$('p', undefined, `${project.name} · ${project.dir}`));
			}
			if (!item.undone && item.projects.some(p => p.git_init)) {
				const line = DOM.append(details, DOM.$('.dispatch-import-git'));
				const cb = this.renderStore.add(new Checkbox('Also remove empty git repositories created by Dispatch', false, defaultCheckboxStyles));
				line.appendChild(cb.domNode);
				DOM.append(line, DOM.$('span', undefined, 'Also remove empty git repositories created by Dispatch'));
				this.renderStore.add(cb.onChange(() => alsoGit = cb.checked));
			}
		}
		const actions = DOM.append(row, DOM.$('.dispatch-import-actions'));
		if (item.undone) { DOM.append(actions, DOM.$('span', undefined, 'Undone')); }
		else if (available) {
			this.button(actions, 'Review', async () => {
				await this.commands.executeCommand('workbench.action.closeActiveEditor');
				await this.commands.executeCommand('dispatch.onboarding.show', item.step);
			}, `Review ${item.title}`);
		} else {
			this.button(actions, 'Undo', async () => {
				const result = await this.commands.executeCommand<{ ok: boolean; message: string }>('dispatch.onboarding', 'undo', item.id, alsoGit);
				if (!result?.ok) { throw new Error(result?.message || 'Dispatch did not answer.'); }
				this.notifications.info(result.message);
				await this.load();
			}, `Undo ${item.title}`);
		}
	}
}
