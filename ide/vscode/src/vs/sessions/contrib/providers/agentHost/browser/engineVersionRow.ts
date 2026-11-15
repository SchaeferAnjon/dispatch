/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the engine's version as the first row of the first card on the Claude and Codex
 *  pages of Customizations ("Claude Code 2.1.283 / Up to date · installed with npm", an Update
 *  button when npm has a newer one). The data and the update come from dispatch-bridge
 *  (`dispatch.engines` → `dispatch engines --json` / `dispatch engines upgrade <id>`), which knows
 *  how the engine was installed (Claude Code's installer, npm, bun, Homebrew).
 *
 *  The pages re-render their whole content on every change, so the row is not part of them: it keeps
 *  its own element and puts it back at the top of the first card whenever the page redraws.
 *--------------------------------------------------------------------------------------------*/

import './media/engineVersionRow.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { IAICustomizationManagementSectionWidget } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import type { Dimension } from '../../../../../base/browser/dom.js';

export type EngineId = 'claude' | 'codex' | 'opencode';

/** One row of `dispatch engines --json`. */
export interface IEngineStatus {
	readonly id: string;
	readonly installed: boolean;
	readonly version: string;
	readonly latest: string;
	readonly update_available: boolean;
	readonly method: string;
	readonly command: string;
}

interface IUpgradeAnswer {
	readonly ok?: boolean;
	readonly after?: string;
	readonly command?: string;
	readonly message?: string;
}

const NAMES: Record<EngineId, string> = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' };

const METHODS: Record<string, string> = {
	native: localize('engineVersion.method.native', "installed with its own installer"),
	npm: localize('engineVersion.method.npm', "installed with npm"),
	bun: localize('engineVersion.method.bun', "installed with bun"),
	brew: localize('engineVersion.method.brew', "installed with Homebrew"),
};

export type RowState =
	| { kind: 'loading' }
	| { kind: 'unavailable' }
	| { kind: 'status'; status: IEngineStatus }
	| { kind: 'updating'; status: IEngineStatus }
	| { kind: 'failed'; status: IEngineStatus; command: string; message?: string };

/** What the row says: label, description (with the command in mono when it failed) and the button. */
export function engineRowText(engine: EngineId, state: RowState): { label: string; description: string; command?: string; button?: string; buttonEnabled?: boolean; busy?: boolean } {
	const name = NAMES[engine];
	if (state.kind === 'loading') {
		return { label: name, description: localize('engineVersion.checking', "Checking for updates…"), busy: true };
	}
	if (state.kind === 'unavailable') {
		return { label: name, description: localize('engineVersion.offline', "Couldn't check for updates") };
	}
	const s = state.status;
	const label = s.installed && s.version ? `${name} ${s.version}` : name;
	const how = METHODS[s.method];
	if (state.kind === 'updating') {
		return {
			label, button: s.installed ? localize('engineVersion.updating', "Updating…") : localize('engineVersion.installing', "Installing…"), buttonEnabled: false, busy: true,
			description: s.installed
				? (s.latest ? localize('engineVersion.updatingTo', "Updating to {0}…", s.latest) : localize('engineVersion.updatingPlain', "Updating…"))
				: localize('engineVersion.installing', "Installing…"),
		};
	}
	if (state.kind === 'failed') {
		// Dispatch IDE (kanban task-jvtg): the reason, and the command only when there is one; a new Mac without Node.js
		// read "Install failed. Run" with nothing after it
		const why = (state.message ?? '').trim().replace(/\.?$/, '.');
		const failed = s.installed ? localize('engineVersion.failedPlain', "Update failed.") : localize('engineVersion.installFailedPlain', "Install failed.");
		return {
			label, button: s.installed ? localize('engineVersion.update', "Update") : localize('engineVersion.install', "Install"), buttonEnabled: true,
			description: why.length > 1 ? `${failed} ${why}` : failed,
			command: state.command || undefined,
		};
	}
	if (!s.installed) {
		return { label, description: localize('engineVersion.notInstalled', "Not installed. Install it to start sessions."), button: localize('engineVersion.install', "Install"), buttonEnabled: true };
	}
	if (s.update_available) {
		return {
			label, button: localize('engineVersion.update', "Update"), buttonEnabled: true,
			description: how ? localize('engineVersion.availableHow', "{0} available · {1}", s.latest, how) : localize('engineVersion.available', "{0} available", s.latest),
		};
	}
	if (!s.latest) {
		return { label, description: localize('engineVersion.offline', "Couldn't check for updates") };
	}
	return { label, description: how ? localize('engineVersion.upToDateHow', "Up to date · {0}", how) : localize('engineVersion.upToDate', "Up to date") };
}

class EngineVersionRow extends Disposable {
	private readonly row: HTMLElement;
	private readonly label: HTMLElement;
	private readonly description: HTMLElement;
	private readonly action: HTMLElement;
	private readonly button: Button;
	private state: RowState = { kind: 'loading' };

	constructor(
		private readonly page: HTMLElement,
		private readonly engine: EngineId,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.row = DOM.$('.agent-global-configuration-settings-row.engine-version-row');
		const labels = DOM.append(this.row, DOM.$('.agent-global-configuration-settings-labels'));
		this.label = DOM.append(labels, DOM.$('.agent-global-configuration-settings-label'));
		this.description = DOM.append(labels, DOM.$('.agent-global-configuration-settings-description'));
		this.action = DOM.append(this.row, DOM.$('.agent-global-configuration-settings-action'));
		this.button = this._register(new Button(this.action, { ...defaultButtonStyles, secondary: true }));
		this._register(this.button.onDidClick(() => void this.upgrade()));

		// the page redraws itself (a settings change, the agent host reconnecting): put the row back
		const observer = new MutationObserver(() => this.place());
		observer.observe(page, { childList: true, subtree: true });
		this._register(toDisposable(() => observer.disconnect()));
		this.render();
		this.place();
		void this.load();
	}

	private place(): void {
		const card = this.page.querySelector('.agent-global-configuration-settings-card');
		if (card && card.firstElementChild !== this.row) {
			card.insertBefore(this.row, card.firstElementChild);
		}
	}

	private async ask<T>(op: string): Promise<T | undefined> {
		// the bridge activates after startup: a page opened before that waits for it a little
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await this.commandService.executeCommand<T>('dispatch.engines', op, this.engine);
			} catch (error) {
				if (op !== 'list' || this._store.isDisposed) {
					throw error;
				}
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}
		return undefined;
	}

	private async load(): Promise<void> {
		let rows: IEngineStatus[] | undefined;
		try {
			rows = await this.ask<IEngineStatus[]>('list');
		} catch {
			rows = undefined;
		}
		if (this._store.isDisposed || this.state.kind === 'updating') {
			return;
		}
		const status = rows?.find(r => r.id === this.engine);
		this.state = status ? { kind: 'status', status } : { kind: 'unavailable' };
		this.render();
	}

	private async upgrade(): Promise<void> {
		if (this.state.kind !== 'status' && this.state.kind !== 'failed') {
			return;
		}
		const status = this.state.status;
		this.state = { kind: 'updating', status };
		this.render();
		let answer: IUpgradeAnswer | undefined;
		try {
			answer = await this.ask<IUpgradeAnswer>('upgrade');
		} catch (error) {
			answer = { ok: false, message: String(error) };
		}
		if (this._store.isDisposed) {
			return;
		}
		if (answer?.ok) {
			this.state = { kind: 'loading' };
			this.render();
			await this.load();
			return;
		}
		this.state = { kind: 'failed', status, command: answer?.command ?? status.command, message: answer?.message };
		this.render();
	}

	private render(): void {
		const text = engineRowText(this.engine, this.state);
		this.label.textContent = text.label;
		DOM.clearNode(this.description);
		if (text.busy && this.state.kind === 'updating') {
			// Dispatch IDE (DESIGN.md「安装或更新」): installing or updating shows a 4px capsule with a band
			// sweeping across it, and the step in words next to it
			const bar = DOM.append(this.description, DOM.$('span.engine-version-progress'));
			bar.setAttribute('role', 'progressbar');
			DOM.append(bar, DOM.$('span.engine-version-progress-band'));
		} else if (text.busy) {
			// the one moving thing while it waits: VS Code's own spinning loading codicon
			this.description.append(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')), ' ');
		}
		this.description.append(text.description);
		if (text.command) {
			this.description.append(' ', localize('engineVersion.run', "Run"), ' ');
			DOM.append(this.description, DOM.$('code.engine-version-command')).textContent = text.command;
			this.description.append(localize('engineVersion.inTerminal', " in a terminal."));
		}
		this.action.style.display = text.button ? '' : 'none';
		if (text.button) {
			this.button.label = text.button;
			this.button.enabled = !!text.buttonEnabled;
		}
	}
}

/**
 * Wraps a Claude / Codex page widget so its first card starts with the engine's version row.
 * `container` is the element the page was created in.
 */
export function withEngineVersion(instantiationService: IInstantiationService, container: HTMLElement, engine: EngineId, widget: IAICustomizationManagementSectionWidget): IAICustomizationManagementSectionWidget {
	const row = instantiationService.createInstance(EngineVersionRow, container, engine);
	return {
		layout: (dimension: Dimension) => widget.layout?.(dimension),
		focus: () => widget.focus?.(),
		dispose: () => {
			row.dispose();
			widget.dispose();
		},
	};
}
