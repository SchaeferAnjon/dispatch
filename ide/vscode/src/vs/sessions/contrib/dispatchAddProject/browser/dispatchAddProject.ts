/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the "Add a project" dialog (kanban design/orca-study, gap G5; patches/440-projects.patch).
 *
 *  One dialog for every way of getting a project into Dispatch, opened from the Projects page's New Project
 *  and from the new session's folder menu. Where: this Mac, or another Mac Dispatch knows (adding there is
 *  not supported yet, and it says so). Three ways: Choose a folder (the system folder picker, as before),
 *  Start a new project (a name: Dispatch makes the folder and starts its history), Copy a project from the
 *  internet (a web address: Dispatch downloads it and shows how far it is). The work is the CLI's
 *  (`dispatch projects-view add | new | clone`, through dispatch-bridge's `dispatch.projects`); the dialog
 *  only collects the choices and shows what comes back, in plain words.
 *
 *  The three ways and their wording follow Orca's add-project dialog (https://github.com/stablyai/orca, MIT,
 *  Copyright (c) 2026 Lovecast Inc.): Browse folder, Clone from URL, Create new project, with a Host on top.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchAddProject.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IDispatchGitIdentity, readGitIdentity, saveGitIdentity } from '../../dispatchCommon/browser/dispatchGitIdentity.js';
import { AddProjectWay, addressName, createBlocker, destination, failureMessage, IAddProjectAnswer, IAddProjectDefaults, IClonePhase, IdentityState, looksLikeAddress, nameProblem, NO_IDENTITY_MESSAGE, progressLine, tildePath } from './dispatchAddProjectModel.js';

const $ = DOM.$;

/** git had a name and email once: it still has, for as long as the window is open (no check, no wait next time). */
let knownIdentity = false;

interface IMachine {
	readonly id: string;
	readonly name?: string;
	readonly label?: string;
	readonly local?: boolean;
	readonly online?: boolean;
}

type View = 'home' | 'new' | 'copy';

interface IBusy {
	readonly way: AddProjectWay;
	readonly label: string;
	readonly copyId?: string;
}

export class AddProjectDialog extends Disposable {

	private readonly result = new DeferredPromise<IAddProjectAnswer | undefined>();
	private readonly scrim: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly before: HTMLElement | null;
	private readonly renders = this._register(new DisposableStore());

	private view: View = 'home';
	private machines: IMachine[] = [];
	private machine = 'local';
	private defaults: IAddProjectDefaults | undefined;
	/** Where the project goes. The CLI's default until the person picks another folder (then `parentTouched`). */
	private parent = '~/Projects';
	private parentTouched = false;
	private name = '';
	private address = '';
	private folderName = '';
	private folderNameTouched = false;
	private busy: IBusy | undefined;
	private progress: IClonePhase | undefined;
	private error: string | undefined;
	private closed = false;
	/** git has no name and email for the person yet: the new project's first commit needs them, so the form asks
	 *  (prefilled with what this Mac knows), instead of the commit carrying a made-up one (kanban task-pog4t) */
	private identity: { name: string; email: string } | undefined;
	/** Whether that is known yet: read when the dialog opens, so the form has its fields from the start (task-lj06.35) */
	private identityState: IdentityState = knownIdentity ? 'known' : 'checking';

	constructor(
		way: AddProjectWay | undefined,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceTrustManagementService private readonly workspaceTrust: IWorkspaceTrustManagementService,
	) {
		super();
		const container = this.layoutService.activeContainer;
		this.before = container.ownerDocument.activeElement as HTMLElement | null;
		this.scrim = DOM.append(container, $('.dispatch-ap-scrim'));
		this.panel = DOM.append(this.scrim, $('.dispatch-ap'));
		this.panel.setAttribute('role', 'dialog');
		this.panel.setAttribute('aria-modal', 'true');
		this._register(DOM.addDisposableListener(this.scrim, DOM.EventType.MOUSE_DOWN, e => {
			// a click beside the dialog closes it, unless something was typed in it: a click that missed a button
			// lost the form without a word (task-lj06.20)
			if (e.target === this.scrim && !this.busy && !this.typed()) {
				this.close(undefined);
			}
		}));
		this._register(DOM.addDisposableListener(this.scrim, DOM.EventType.KEY_DOWN, e => this.onKey(e)));
		this._register({ dispose: () => this.scrim.remove() });
		if (way === 'new' || way === 'copy') {
			this.view = way;
		}
		this.render();
		// what git knows is read at once, next to the rest (it used to wait for them): the form for a new project
		// has its fields before the person gets there
		void this.loadIdentity();
		void this.load();
	}

	private typed(): boolean {
		return this.view === 'new' ? !!this.name.trim() : this.view === 'copy' ? !!this.address.trim() : false;
	}

	/** Resolves with the project that was added, or undefined when the person closed the dialog. */
	show(): Promise<IAddProjectAnswer | undefined> {
		return this.result.p;
	}

	// ------------------------------------------------------------ data

	private async load(): Promise<void> {
		const [defaults, machines] = await Promise.all([
			this.commandService.executeCommand<IAddProjectDefaults & { ok?: boolean }>('dispatch.projects', 'defaults').catch(e => { this.logService.warn('[dispatch] add project defaults', e); return undefined; }),
			this.commandService.executeCommand<IMachine[]>('dispatch.machines').catch(() => undefined),
		]);
		if (this.closed) {
			return;
		}
		if (defaults && defaults.parent) {
			this.defaults = defaults;
			if (!this.parentTouched) {
				this.parent = defaults.parent;
			}
		}
		this.machines = Array.isArray(machines) ? machines : [];
		this.render(true);
	}

	private async loadIdentity(): Promise<void> {
		if (knownIdentity) {
			return;
		}
		const g: IDispatchGitIdentity | undefined = await readGitIdentity(this.commandService);
		if (this.closed) {
			return;
		}
		if (!g || g.known) {
			// known, or the CLI could not be asked: the CLI says so when the project is made, and the form asks then
			knownIdentity = !!g;
			this.identityState = 'known';
		} else {
			this.identityState = 'ask';
			this.identity = { name: g.name || g.suggest?.name || '', email: g.email || g.suggest?.email || '' };
		}
		if (this.view === 'new' && !this.busy) {
			this.render(true);
		}
	}

	private get home(): string {
		return this.defaults?.home ?? '';
	}

	private get elsewhere(): IMachine | undefined {
		return this.machine === 'local' ? undefined : this.machines.find(m => m.id === this.machine);
	}

	private machineName(m: IMachine): string {
		return m.local ? localize('dispatchAddProject.thisMac', "This Mac") : (m.label || m.name || m.id);
	}

	private get gitMissing(): string | undefined {
		return this.defaults?.git && this.defaults.git.ok === false ? (this.defaults.git.message || undefined) : undefined;
	}

	// ------------------------------------------------------------ render

	private render(keepFocus = false): void {
		const focused = keepFocus ? this.panel.ownerDocument.activeElement : undefined;
		const keep = focused instanceof HTMLInputElement && this.panel.contains(focused) ? { id: focused.dataset.field, start: focused.selectionStart, end: focused.selectionEnd } : undefined;
		this.renders.clear();
		DOM.clearNode(this.panel);
		this.panel.setAttribute('aria-labelledby', 'dispatch-ap-title');

		const head = DOM.append(this.panel, $('.dap-head'));
		if (this.view !== 'home' && !this.busy) {
			const back = DOM.append(head, $('button.dap-icon-btn', { type: 'button', 'aria-label': localize('dispatchAddProject.back', "Back") }));
			DOM.append(back, $(`span${ThemeIcon.asCSSSelector(Codicon.arrowLeft)}`));
			this.renders.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => { this.view = 'home'; this.error = undefined; this.render(); }));
		}
		const title = DOM.append(head, $('h2.dap-title#dispatch-ap-title'));
		title.textContent = this.busy?.way === 'copy' ? localize('dispatchAddProject.copying', "Copying {0}", this.busy.label)
			: this.view === 'new' ? localize('dispatchAddProject.startTitle', "Start a new project")
				: this.view === 'copy' ? localize('dispatchAddProject.copyTitle', "Copy a project from the internet")
					: localize('dispatchAddProject.title', "Add a project");
		DOM.append(head, $('.dap-grow'));
		if (!this.busy) {
			const close = DOM.append(head, $('button.dap-icon-btn', { type: 'button', 'aria-label': localize('dispatchAddProject.close', "Close") }));
			DOM.append(close, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
			this.renders.add(DOM.addDisposableListener(close, DOM.EventType.CLICK, () => this.close(undefined)));
		}

		if (this.busy) {
			this.renderBusy();
		} else if (this.view === 'home') {
			this.renderHome();
		} else {
			this.renderForm(this.view);
		}

		const target = keep?.id ? this.panel.querySelector<HTMLInputElement>(`input[data-field="${keep.id}"]`) : null;
		if (target) {
			target.focus();
			target.setSelectionRange(keep!.start, keep!.end);
		} else {
			queueMicrotask(() => this.focusFirst());
		}
	}

	private focusFirst(): void {
		if (this.closed) {
			return;
		}
		// the first field when there is one (the Back button comes first in the page, and used to get the focus:
		// task-lj06.35), else the first way or button
		const first = this.panel.querySelector<HTMLElement>('input:not([disabled])')
			?? this.panel.querySelector<HTMLElement>('.dap-way:not([disabled]), .dap-foot a.monaco-button:not(.disabled), button:not([disabled])');
		first?.focus();
	}

	private renderWhere(): void {
		if (this.machines.length < 2) {
			if (this.view === 'home') {
				DOM.append(this.panel, $('p.dap-sub', undefined, localize('dispatchAddProject.sub', "A project is a folder your agents work in. It will be added on this Mac.")));
			}
			return;
		}
		DOM.append(this.panel, $('p.dap-sub', undefined, localize('dispatchAddProject.subWhere', "A project is a folder your agents work in. Where should it be?")));
		const row = DOM.append(this.panel, $('.dap-where'));
		DOM.append(row, $('span.dap-label', undefined, localize('dispatchAddProject.where', "Where")));
		const group = DOM.append(row, $('.dap-seg', { role: 'radiogroup', 'aria-label': localize('dispatchAddProject.where', "Where") }));
		for (const m of [...this.machines].sort((a, b) => Number(!!b.local) - Number(!!a.local))) {
			const id = m.local ? 'local' : m.id;
			const on = id === this.machine;
			const b = DOM.append(group, $('button.dap-seg-item', { type: 'button', role: 'radio', 'aria-checked': String(on) }));
			b.classList.toggle('on', on);
			DOM.append(b, $('span', undefined, this.machineName(m)));
			if (!m.local && m.online === false) {
				b.title = localize('dispatchAddProject.offline', "{0} is off or not reachable right now.", this.machineName(m));
				DOM.append(b, $('span.dap-off', undefined, localize('dispatchAddProject.offlineTag', "off")));
			}
			this.renders.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => { this.machine = id; this.error = undefined; this.render(); }));
		}
	}

	private renderHome(): void {
		this.renderWhere();
		const away = this.elsewhere;
		if (away) {
			this.note(localize('dispatchAddProject.awayHome', "Adding a project on {0} from here is not supported yet. Open Dispatch on {0} and add it there, or pick This Mac above.", this.machineName(away)), false);
		}
		const list = DOM.append(this.panel, $('.dap-ways'));
		const ways: { way: AddProjectWay; icon: ThemeIcon; title: string; text: string }[] = [
			{ way: 'folder', icon: Codicon.folderOpened, title: localize('dispatchAddProject.folder', "Choose a folder"), text: localize('dispatchAddProject.folderText', "Use a folder that is already on this Mac. Your files stay where they are.") },
			{ way: 'new', icon: Codicon.newFolder, title: localize('dispatchAddProject.new', "Start a new project"), text: localize('dispatchAddProject.newText', "Type a name and Dispatch makes the folder for you.") },
			{ way: 'copy', icon: Codicon.cloudDownload, title: localize('dispatchAddProject.copy', "Copy a project from the internet"), text: localize('dispatchAddProject.copyText', "From GitHub, GitLab or any web address. Dispatch downloads it to this Mac.") },
		];
		for (const w of ways) {
			const b = DOM.append(list, $<HTMLButtonElement>('button.dap-way', { type: 'button' }));
			b.dataset.way = w.way;
			b.disabled = !!away;
			const icon = DOM.append(b, $('span.dap-way-icon'));
			DOM.append(icon, $(`span${ThemeIcon.asCSSSelector(w.icon)}`));
			const text = DOM.append(b, $('span.dap-way-text'));
			DOM.append(text, $('span.dap-way-title', undefined, w.title));
			DOM.append(text, $('span.dap-way-desc', undefined, w.text));
			DOM.append(b, $(`span.dap-way-go${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`));
			this.renders.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => {
				this.error = undefined;
				if (w.way === 'folder') {
					void this.chooseFolder();
				} else {
					this.view = w.way;
					this.render();
				}
			}));
		}
		if (this.error) {
			this.note(this.error, true, true);
		}
	}

	private renderForm(way: 'new' | 'copy'): void {
		this.renderWhere();
		const away = this.elsewhere;
		const missingGit = this.gitMissing;
		const form = DOM.append(this.panel, $<HTMLFormElement>('form.dap-form'));
		form.noValidate = true;
		const primary = way === 'new' ? localize('dispatchAddProject.create', "Create project") : localize('dispatchAddProject.copyNow', "Copy project");
		let submit!: Button;
		const refresh = () => {
			const problem = way === 'new' ? nameProblem(this.name) : (this.folderName ? nameProblem(this.folderName) : undefined);
			hint.textContent = problem ?? '';
			hint.hidden = !problem;
			// why Create project is grey, next to it (task-lj06.20): a missing email, or the check still running
			const blocker = way === 'new' ? createBlocker(this.name, this.identityState, this.identity) : undefined;
			why.textContent = blocker ?? '';
			why.hidden = !blocker || !!away || !!missingGit;
			const ready = way === 'new' ? !!this.name.trim() && !problem && !blocker : looksLikeAddress(this.address) && !!this.folderName.trim() && !problem;
			submit.enabled = ready && !away && !missingGit;
			where.textContent = way === 'new'
				? (this.name.trim() ? localize('dispatchAddProject.willMake', "Dispatch will make {0} and start a history for it (Git), so every change can be undone.", destination(this.parent, this.name, this.home)) : '')
				: (looksLikeAddress(this.address) ? localize('dispatchAddProject.willSave', "It will be saved as {0}.", destination(this.parent, this.folderName, this.home)) : '');
		};

		if (way === 'new') {
			this.field(form, 'name', localize('dispatchAddProject.nameLabel', "Project name"), this.name, 'my-app', v => { this.name = v; refresh(); });
			const identity = this.identity;
			if (identity) {
				this.field(form, 'gitName', localize('dispatchAddProject.gitName', "Your name on commits"), identity.name, localize('dispatchAddProject.gitNamePlaceholder', "Your name"), v => { identity.name = v; refresh(); });
				this.field(form, 'gitEmail', localize('dispatchAddProject.gitEmail', "Your email on commits"), identity.email, 'you@example.com', v => { identity.email = v; refresh(); });
				DOM.append(form, $('p.dap-help', undefined, localize('dispatchAddProject.gitIdentityHelp', "Git does not know your name on this Mac yet. It goes on every commit, yours and your agents'. Change it later in Settings › Agents › Commits.")));
			}
		} else {
			this.field(form, 'address', localize('dispatchAddProject.addressLabel', "Web address"), this.address, 'https://github.com/octocat/Hello-World', v => {
				this.address = v;
				if (!this.folderNameTouched) {
					this.folderName = addressName(v);
					const input = this.panel.querySelector<HTMLInputElement>('input[data-field="folderName"]');
					if (input) {
						input.value = this.folderName;
					}
				}
				refresh();
			});
			DOM.append(form, $('p.dap-help', undefined, localize('dispatchAddProject.addressHelp', "Paste the address from the project's page. On GitHub, open the project, click the green Code button and copy the link.")));
			this.field(form, 'folderName', localize('dispatchAddProject.folderNameLabel', "Folder name"), this.folderName, 'Hello-World', v => { this.folderName = v; this.folderNameTouched = true; refresh(); });
		}
		const hint = DOM.append(form, $('p.dap-hint'));
		hint.hidden = true;

		const parent = DOM.append(form, $('.dap-parent'));
		DOM.append(parent, $('span.dap-label', undefined, localize('dispatchAddProject.saveIn', "Save in")));
		DOM.append(parent, $('span.dap-path', undefined, tildePath(this.parent, this.home)));
		const change = DOM.append(parent, $('button.dap-link', { type: 'button' }, localize('dispatchAddProject.change', "Change...")));
		this.renders.add(DOM.addDisposableListener(change, DOM.EventType.CLICK, () => void this.chooseParent()));
		const where = DOM.append(form, $('p.dap-help'));

		if (away) {
			this.note(localize('dispatchAddProject.awayForm', "Adding a project on {0} from here is not supported yet. Pick This Mac above, or open Dispatch on {0}.", this.machineName(away)), false);
		}
		if (missingGit) {
			this.note(missingGit, true);
		}
		if (this.error) {
			this.note(this.error, true, true);
		}

		const foot = DOM.append(form, $('.dap-foot'));
		const why = DOM.append(foot, $('span.dap-why', { role: 'status' }));
		why.hidden = true;
		DOM.append(foot, $('.dap-grow'));
		this.button(foot, localize('dispatchAddProject.cancel', "Cancel"), 'ghost', () => this.close(undefined));
		submit = this.button(foot, primary, 'fill', () => void (way === 'new' ? this.createNew() : this.copyFromInternet()));
		// Enter in a field adds, when the form is ready
		this.renders.add(DOM.addDisposableListener(form, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
				e.preventDefault();
				if (submit.enabled) {
					void (way === 'new' ? this.createNew() : this.copyFromInternet());
				}
			}
		}));
		this.renders.add(DOM.addDisposableListener(form, DOM.EventType.SUBMIT, e => e.preventDefault()));
		refresh();
	}

	private renderBusy(): void {
		const busy = this.busy!;
		const body = DOM.append(this.panel, $('.dap-busy', { role: 'status' }));
		if (busy.way === 'copy') {
			const bar = DOM.append(body, $('.dap-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(this.progress?.percent ?? 0) }));
			const fill = DOM.append(bar, $('.dap-bar-fill'));
			fill.style.width = `${Math.max(2, Math.min(100, this.progress?.percent ?? 0))}%`;
			DOM.append(body, $('.dap-phase', undefined, progressLine(this.progress)));
			DOM.append(body, $('p.dap-help', undefined, localize('dispatchAddProject.copyWait', "Big projects can take a few minutes. You can stop it at any time and nothing is left behind.")));
			const foot = DOM.append(body, $('.dap-foot'));
			DOM.append(foot, $('.dap-grow'));
			this.button(foot, localize('dispatchAddProject.stop', "Stop"), 'ghost', () => {
				if (busy.copyId) {
					void this.commandService.executeCommand('dispatch.projects', 'cloneCancel', busy.copyId);
				}
			});
		} else {
			DOM.append(body, $('.dap-bar.indeterminate')).appendChild($('.dap-bar-fill'));
			DOM.append(body, $('.dap-phase', undefined, busy.way === 'folder' ? localize('dispatchAddProject.adding', "Adding {0}", busy.label) : localize('dispatchAddProject.making', "Making {0}", busy.label)));
		}
	}

	private field(form: HTMLElement, id: string, label: string, value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
		const row = DOM.append(form, $('.dap-field'));
		const l = DOM.append(row, $<HTMLLabelElement>('label.dap-label', undefined, label));
		const input = DOM.append(row, $<HTMLInputElement>('input.dap-input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' }));
		input.id = `dispatch-ap-${id}`;
		input.dataset.field = id;
		l.htmlFor = input.id;
		input.value = value;
		this.renders.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => { this.error = undefined; this.panel.querySelector('.dap-note.dap-error')?.remove(); onInput(input.value); }));
		return input;
	}

	private note(text: string, warning: boolean, error = false): void {
		const n = DOM.append(this.panel.querySelector('.dap-form') ?? this.panel, $('.dap-note'));
		n.classList.toggle('dap-error', error);
		n.setAttribute('role', warning ? 'alert' : 'note');
		DOM.append(n, $(`span.dap-note-icon${ThemeIcon.asCSSSelector(warning ? Codicon.warning : Codicon.info)}`));
		DOM.append(n, $('span', undefined, text));
	}

	private button(parent: HTMLElement, label: string, kind: 'fill' | 'ghost', run: () => void): Button {
		const b = this.renders.add(new Button(parent, { ...defaultButtonStyles, secondary: kind !== 'fill', ariaLabel: label }));
		b.label = label;
		b.element.classList.add('dap-btn', kind);
		this.renders.add(b.onDidClick(() => run()));
		return b;
	}

	private onKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (!this.busy) {
				this.close(undefined);
			}
			return;
		}
		if (e.key !== 'Tab') {
			return;
		}
		// the dialog keeps the focus: Tab goes round its own controls
		const items = Array.from(this.panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a.monaco-button:not(.disabled)'));
		if (!items.length) {
			e.preventDefault();
			return;
		}
		const active = this.panel.ownerDocument.activeElement;
		const i = items.findIndex(x => x === active);
		const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
		e.preventDefault();
		items[next].focus();
	}

	// ------------------------------------------------------------ the three ways

	private async chooseFolder(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('dispatchAddProject.pickTitle', "Choose a project folder"),
			openLabel: localize('dispatchAddProject.pickOpen', "Add as Project"),
			defaultUri: this.defaults?.home ? URI.file(this.defaults.parent || this.defaults.home) : undefined,
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		const folder = picked?.[0];
		if (!folder || folder.scheme !== 'file' || this.closed) {
			return;
		}
		const label = folder.fsPath.split('/').filter(Boolean).pop() ?? folder.fsPath;
		await this.run({ way: 'folder', label }, () => this.commandService.executeCommand<IAddProjectAnswer>('dispatch.projects', 'add', folder.fsPath), 'home');
	}

	private async chooseParent(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('dispatchAddProject.parentTitle', "Choose where to save it"),
			openLabel: localize('dispatchAddProject.parentOpen', "Save Here"),
			defaultUri: URI.file(this.parent.startsWith('~') ? (this.defaults?.parent ?? this.home ?? '/') : this.parent),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		const folder = picked?.[0];
		if (folder && folder.scheme === 'file' && !this.closed) {
			this.parent = folder.fsPath;
			this.parentTouched = true;
			this.render(true);
		}
	}

	private async createNew(): Promise<void> {
		const name = this.name.trim();
		const machine = this.machine === 'local' ? undefined : this.machine;
		await this.run({ way: 'new', label: name }, async () => {
			if (this.identity && !machine) {
				// the name and email first: the project's first commit carries them
				const saved = await saveGitIdentity(this.commandService, this.identity);
				if (saved.ok === false) {
					return { ok: false, message: saved.message };
				}
				this.identity = undefined;
			}
			const answer = await this.commandService.executeCommand<IAddProjectAnswer>('dispatch.projects', 'create', { name, parent: this.parentTouched ? this.parent : undefined, machine });
			// a folder Dispatch just made on this Mac holds no one else's files: no "Do you trust the authors?" before the
			// first message (kanban task-lj06.12). A chosen folder and a copy from the internet are still asked about.
			if (answer && answer.ok !== false && answer.dir && !machine) {
				await this.workspaceTrust.setUrisTrust([URI.file(answer.dir)], true).catch(e => this.logService.warn('[dispatch] trust a new project', e));
			}
			return answer;
		}, 'new');
	}

	private async copyFromInternet(): Promise<void> {
		const address = this.address.trim();
		const name = this.folderName.trim();
		const copyId = generateUuid().slice(0, 18);
		const machine = this.machine === 'local' ? undefined : this.machine;
		this.progress = { state: 'running', phase: localize('dispatchAddProject.connecting', "Connecting"), percent: 0 };
		const timer = setInterval(async () => {
			const p = await this.commandService.executeCommand<IClonePhase | undefined>('dispatch.projects', 'cloneProgress', copyId).catch(() => undefined);
			if (p && this.busy?.copyId === copyId && p.state === 'running') {
				this.progress = p;
				this.updateProgress();
			}
		}, 400);
		try {
			await this.run({ way: 'copy', label: name, copyId }, () => this.commandService.executeCommand<IAddProjectAnswer>('dispatch.projects', 'clone', { address, name, parent: this.parentTouched ? this.parent : undefined, machine, progressId: copyId }), 'copy');
		} finally {
			clearInterval(timer);
		}
	}

	private updateProgress(): void {
		const fill = this.panel.querySelector<HTMLElement>('.dap-bar-fill');
		const bar = this.panel.querySelector<HTMLElement>('.dap-bar');
		const phase = this.panel.querySelector<HTMLElement>('.dap-phase');
		const percent = this.progress?.percent ?? 0;
		if (fill) {
			fill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
		}
		bar?.setAttribute('aria-valuenow', String(percent));
		if (phase) {
			phase.textContent = progressLine(this.progress);
		}
	}

	/** Runs one way of adding; the dialog shows its progress, closes on success and says what went wrong otherwise. */
	private async run(busy: IBusy, work: () => Thenable<IAddProjectAnswer | undefined>, back: View): Promise<void> {
		this.busy = busy;
		this.error = undefined;
		this.render();
		let answer: IAddProjectAnswer | undefined;
		try {
			answer = await work();
		} catch (e) {
			this.logService.warn('[dispatch] add project', e);
			answer = { ok: false, message: String((e as Error)?.message ?? e) };
		}
		this.busy = undefined;
		this.progress = undefined;
		if (this.closed) {
			return;
		}
		if (answer && answer.ok !== false && answer.name) {
			this.close(answer);
			return;
		}
		if (answer?.code === 'cancelled') {
			this.view = back;
			this.render();
			return;
		}
		if (answer?.code === 'no_identity' && back === 'new') {
			// git has no name for the person after all: the form asks for it, and says why it is back (task-lj06.20)
			knownIdentity = false;
			this.identityState = 'checking';
			this.view = back;
			this.error = NO_IDENTITY_MESSAGE;
			this.render();
			await this.loadIdentity();
			if ((this.identityState as IdentityState) !== 'ask') {
				// git still says it knows (another app changed it meanwhile): the CLI's own words, which say where to set it
				this.error = failureMessage(answer);
				this.render(true);
			}
			return;
		}
		this.view = back;
		this.error = failureMessage(answer);
		this.render();
	}

	private close(answer: IAddProjectAnswer | undefined): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.result.complete(answer);
		this.before?.focus?.();
		this.dispose();
	}
}
