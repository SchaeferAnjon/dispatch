/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's Customize page (patches/445-project-custom.patch).
 *
 *  A custom view in the middle of the Agents window, like the project page it comes from: the project
 *  page's Customize button, or Customize Project... on the project's row in the sessions list.
 *  "‹ <project>" goes back. Everything here is the project's own and is saved as soon as it is picked:
 *  - Icon (kanban task-7gtm): Folder (the default, no colour), Symbol, Emoji or Picture, and a colour
 *    for the icon only. The sessions list's project row shows it (dispatchProjectLook.ts).
 *  - Tools agents can use here (kanban task-gsmh): every MCP server the agents in this folder get (set up
 *    for every project, in the project's own files, or Cursor's only) with an engine pill each for Claude
 *    Code, Codex and OpenCode; a click turns it on or off for that engine in this project only.
 *  - Copies for parallel work (kanban task-am1t): one switch, "Get copies ready on their own" (on), and what
 *    that does here (the files it brings, the folders it shares, the install), and how the last copy went.
 *  - Its own instructions and hooks (kanban task-6yrk): the project's CLAUDE.md, AGENTS.md, .claude/settings
 *    hooks and plugins, then what Dispatch adds in the user's settings (marked, merged, never replacing), and
 *    a line for each setting of theirs that changes what Dispatch can do here (all hooks off, own status line).
 *  The data is `dispatch project-custom show <project> --json` through dispatch-bridge's
 *  `dispatch.projects` (`custom`, `look`, `tool`, `copies`); kanban app/cli/project_custom.py.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchProjectCustom.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { dispatchProjectsRegistry, refreshDispatchProjectsRegistry } from '../../sessions/browser/dispatchProjectsModel.js';
import { currentDispatchProject, DispatchProjectRegisteredContext, DispatchProjectViewMenu, showDispatchProject } from '../../sessions/browser/dispatchProjects.js';
import { paintDispatchProjectLook } from './dispatchProjectLook.js';
import { DISPATCH_PROJECT_COLORS, DispatchProjectIconKind, dispatchProjectLook, IDispatchProjectLook } from './dispatchProjectLookModel.js';

const $ = DOM.$;

export const DISPATCH_PROJECT_CUSTOM_VIEW_ID = 'dispatch.projectCustom';
export const DISPATCH_PROJECT_CUSTOMIZE_COMMAND = 'dispatch.project.customize';

export interface IDispatchProjectPicture {
	readonly path: string;
	readonly rel: string;
	/** A preview, inline ('' for a kind the window cannot draw as it is: ICO, ICNS). */
	readonly data: string;
}

export interface IDispatchProjectCustom {
	readonly ok: boolean;
	readonly message?: string;
	readonly name: string;
	readonly label: string;
	readonly dir: string;
	readonly host: string;
	readonly machine: string;
	readonly local: boolean;
	readonly look: unknown;
	readonly picture_from?: string;
	readonly pictures: readonly IDispatchProjectPicture[];
	readonly choices: { readonly symbols: readonly string[]; readonly emoji: readonly string[]; readonly colors: readonly { id: string; label: string }[] };
	/** null for a project on another Mac. */
	readonly tools?: IDispatchProjectTools | null;
	readonly agent_files?: IDispatchAgentFiles | null;
	/** null when the project is not a git repository here (no copies). */
	readonly copies?: IDispatchProjectCopies | null;
}

interface ILookAnswer { readonly ok?: boolean; readonly message?: string; readonly look?: unknown }

export type DispatchToolState = 'on' | 'off' | 'ask' | 'none';
export interface IDispatchProjectTool {
	readonly name: string;
	/** Its command or address. */
	readonly what: string;
	readonly transport: string;
	/** Set up for every project, in this project's own files, or only in Cursor's. */
	readonly from: 'everyone' | 'project' | 'cursor';
	readonly engines: Readonly<Record<string, { readonly has: boolean; readonly on: boolean; readonly state: DispatchToolState; readonly where: string }>>;
}
export interface IDispatchProjectTools {
	readonly codex_trusted?: boolean;
	readonly error?: string;
	readonly tools: readonly IDispatchProjectTool[];
}
interface IToolAnswer { readonly ok?: boolean; readonly message?: string; readonly note?: string; readonly tools?: IDispatchProjectTools }

export interface IDispatchAgentFiles {
	readonly error?: string;
	readonly own: readonly { readonly kind: 'instructions' | 'hooks' | 'plugins'; readonly file: string; readonly rel: string; readonly agents: readonly string[]; readonly count?: number; readonly events?: readonly string[]; readonly invalid?: boolean }[];
	readonly dispatch: readonly { readonly what: string; readonly file: string; readonly count: number; readonly yours?: number }[];
	readonly in_folder: readonly string[];
	readonly notes: readonly { readonly id: string; readonly text: string }[];
}

export interface IDispatchProjectCopies {
	readonly auto: boolean;
	readonly error?: string;
	readonly copy?: readonly string[];
	readonly link?: readonly string[];
	readonly install?: string;
	readonly last?: {
		readonly copy: string; readonly at: number; readonly copied: readonly string[]; readonly linked: readonly string[]; readonly exists?: boolean;
		readonly install?: { readonly label?: string; readonly state?: 'running' | 'done' | 'failed' | 'none'; readonly log?: string };
	} | null;
}
interface ICopiesAnswer { readonly ok?: boolean; readonly message?: string; readonly copies?: IDispatchProjectCopies | null }

const ENGINES: readonly (readonly [string, string])[] = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode']];

/** The project this page shows (its name). */
const shownProject = observableValue<string | undefined>('dispatchProjectCustomName', undefined);
const shownData = observableValue<IDispatchProjectCustom | undefined>('dispatchProjectCustomData', undefined);
const loadError = observableValue<string | undefined>('dispatchProjectCustomError', undefined);

let commands: ICommandService | undefined;
/** The page's writes, one at a time in the order they were made; a read (load) waits for them, so a page
 * opened again right after a change never shows what was there before it. */
let writes: Promise<unknown> = Promise.resolve();

async function load(name: string): Promise<void> {
	if (!commands) {
		return;
	}
	try {
		await writes;
		const answer = await commands.executeCommand<IDispatchProjectCustom>('dispatch.projects', 'custom', name);
		if (shownProject.get() !== name) {
			return;
		}
		if (!answer || answer.ok === false) {
			loadError.set(answer?.message || localize('dispatchProjectCustom.loadFailed', "Dispatch could not read this project's settings."), undefined);
			return;
		}
		loadError.set(undefined, undefined);
		shownData.set(answer, undefined);
	} catch (e) {
		loadError.set(String((e as Error)?.message ?? e), undefined);
	}
}

export function showDispatchProjectCustom(customViewService: ICustomViewService, name: string): void {
	if (shownProject.get() !== name) {
		shownData.set(undefined, undefined);
		loadError.set(undefined, undefined);
	}
	shownProject.set(name, undefined);
	void load(name);
	customViewService.showCustomView(DISPATCH_PROJECT_CUSTOM_VIEW_ID);
}

class DispatchProjectCustomView extends AbstractCustomView {

	readonly title: IObservable<string>;
	override readonly description: IObservable<string | undefined>;
	override readonly maxWidth = 880;

	/** What the person picked last, shown until the CLI has answered (then its answer). */
	private readonly pending = observableValue<IDispatchProjectLook | undefined | null>(this, null);
	/** The icon kind whose choices are open (Picture without a picture yet stays open with nothing saved). */
	private readonly openKind = observableValue<DispatchProjectIconKind | undefined>(this, undefined);
	private crumb: HTMLElement | undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
	) {
		super();
		this.title = derived(this, () => localize('dispatchProjectCustom.title', "Customize"));
		this.description = derived(this, reader => {
			const data = shownData.read(reader);
			return data ? localize('dispatchProjectCustom.description', "How {0} looks in Dispatch and what its agents use. The folder itself stays as it is.", data.label) : undefined;
		});
	}

	render(container: HTMLElement): void {
		container.classList.add('dispatch-projects-page', 'dispatch-project-page', 'dispatch-pc-page');
		const crumb = this.crumb = DOM.append(container, $('.dispatch-projects-breadcrumb'));
		const body = DOM.append(container, $('.dispatch-project-body'));
		const store = this._register(new DisposableStore());
		this._register(autorun(reader => {
			const name = shownProject.read(reader);
			const data = shownData.read(reader);
			const error = loadError.read(reader);
			const pending = this.pending.read(reader);
			const open = this.openKind.read(reader);
			store.clear();
			this.renderCrumb(crumb, data?.label ?? name ?? '', name, store);
			DOM.clearNode(body);
			if (!data || data.name !== name) {
				DOM.append(body, $('.dispatch-projects-empty', undefined, error ?? localize('dispatchProjectCustom.loading', "Looking…")));
				return;
			}
			const look = pending === null ? dispatchProjectLook(data.look) : pending;
			this.renderIcon(body, data, look, open ?? look?.icon ?? 'folder', store);
			this.renderColor(body, data, look, store);
			this.renderTools(body, data, store);
			this.renderCopies(body, data, store);
			this.renderAgentFiles(body, data, store);
		}));
	}

	private renderCrumb(parent: HTMLElement, label: string, name: string | undefined, store: DisposableStore): void {
		DOM.clearNode(parent);
		const back = DOM.append(parent, $('button.dispatch-projects-crumb'));
		const caret = DOM.append(back, $(`span.dispatch-projects-crumb-sep${ThemeIcon.asCSSSelector(Codicon.chevronLeft)}`));
		caret.setAttribute('aria-hidden', 'true');
		DOM.append(back, $('span', undefined, label));
		back.title = localize('dispatchProjectCustom.back', "Back to {0}", label);
		store.add(DOM.addDisposableListener(back, DOM.EventType.CLICK, () => {
			if (name) {
				showDispatchProject(this.customViewService, name);
			}
		}));
	}

	private section(parent: HTMLElement, head: string, note?: string): HTMLElement {
		const section = DOM.append(parent, $('.dispatch-project-section.dispatch-pc-section'));
		const h = DOM.append(section, $('.dispatch-projects-group-head'));
		DOM.append(h, $('span', undefined, head));
		if (note) {
			DOM.append(section, $('.dispatch-pc-note', undefined, note));
		}
		return section;
	}

	// ---- Icon --------------------------------------------------------------------------------------------------

	private renderIcon(parent: HTMLElement, data: IDispatchProjectCustom, look: IDispatchProjectLook | undefined, kind: DispatchProjectIconKind, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProjectCustom.icon', "Icon"));
		section.dataset.section = 'icon';
		// what the sessions list will show: the project's row as it is there
		const preview = DOM.append(section, $('.dispatch-pc-preview'));
		DOM.append(preview, $('span.dispatch-pc-preview-label', undefined, localize('dispatchProjectCustom.inSidebar', "In the sidebar")));
		const row = DOM.append(preview, $('.dispatch-pc-preview-row'));
		const caret = DOM.append(row, $(`span.dispatch-pc-preview-caret${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		caret.setAttribute('aria-hidden', 'true');
		paintDispatchProjectLook(DOM.append(row, $('span.dispatch-pc-preview-icon')), look);
		DOM.append(row, $('span.dispatch-pc-preview-name', undefined, data.label));

		const modes = DOM.append(section, $('.dispatch-projects-modes.dispatch-pc-modes'));
		modes.setAttribute('role', 'tablist');
		modes.setAttribute('aria-label', localize('dispatchProjectCustom.iconKind', "Kind of icon"));
		const kinds: [DispatchProjectIconKind, string][] = [
			['folder', localize('dispatchProjectCustom.folder', "Folder")],
			['symbol', localize('dispatchProjectCustom.symbol', "Symbol")],
			['emoji', localize('dispatchProjectCustom.emoji', "Emoji")],
			['picture', localize('dispatchProjectCustom.picture', "Picture")],
		];
		for (const [k, label] of kinds) {
			const b = DOM.append(modes, $('button.dispatch-projects-chip', undefined, label));
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', String(k === kind));
			b.classList.toggle('selected', k === kind);
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.pickKind(data, look, k)));
		}

		if (kind === 'symbol') {
			const grid = DOM.append(section, $('.dispatch-pc-grid'));
			grid.setAttribute('role', 'listbox');
			for (const symbol of data.choices.symbols) {
				const selected = look?.icon === 'symbol' && look.symbol === symbol;
				const b = this.choice(grid, symbol.replace(/-/g, ' '), selected);
				paintDispatchProjectLook(DOM.append(b, $('span.dispatch-pc-choice-icon')), { icon: 'symbol', symbol, color: look?.color });
				store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.save(data, { icon: 'symbol', symbol, color: look?.color }, { symbol })));
			}
		} else if (kind === 'emoji') {
			const grid = DOM.append(section, $('.dispatch-pc-grid'));
			grid.setAttribute('role', 'listbox');
			for (const emoji of data.choices.emoji) {
				const b = this.choice(grid, emoji, look?.icon === 'emoji' && look.emoji === emoji);
				paintDispatchProjectLook(DOM.append(b, $('span.dispatch-pc-choice-icon')), { icon: 'emoji', emoji });
				store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.save(data, { icon: 'emoji', emoji, color: look?.color }, { emoji })));
			}
		} else if (kind === 'picture') {
			const grid = DOM.append(section, $('.dispatch-pc-grid.pictures'));
			grid.setAttribute('role', 'listbox');
			if (look?.icon === 'picture' && look.picture_data) {
				const b = this.choice(grid, data.picture_from || localize('dispatchProjectCustom.current', "The picture in use"), true);
				paintDispatchProjectLook(DOM.append(b, $('span.dispatch-pc-choice-icon.picture')), look);
			}
			for (const p of data.pictures) {
				if (look?.icon === 'picture' && data.picture_from && data.picture_from.endsWith('/' + p.rel)) {
					continue;
				}
				const b = this.choice(grid, p.rel, false);
				if (p.data) {
					paintDispatchProjectLook(DOM.append(b, $('span.dispatch-pc-choice-icon.picture')), { icon: 'picture', picture_data: p.data });
				} else {
					DOM.append(b, $(`span.dispatch-pc-choice-icon${ThemeIcon.asCSSSelector(Codicon.fileMedia)}`));
				}
				store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.save(data, { icon: 'picture', picture_data: p.data || undefined, color: look?.color }, { picture: p.path })));
			}
			const choose = DOM.append(grid, $('button.dispatch-pc-choose', undefined, localize('dispatchProjectCustom.choose', "Choose…")));
			choose.title = localize('dispatchProjectCustom.chooseTitle', "Pick any picture on this Mac. Dispatch keeps a small copy, so the file can move later.");
			store.add(DOM.addDisposableListener(choose, DOM.EventType.CLICK, () => void this.choosePicture(data, look)));
			if (!data.pictures.length && look?.icon !== 'picture') {
				DOM.append(section, $('.dispatch-pc-note', undefined, data.local
					? localize('dispatchProjectCustom.noPictures', "No icon or logo in this project's folder. Choose any picture instead.")
					: localize('dispatchProjectCustom.elsewhere', "This project lives on {0}. Choose a picture on this Mac.", data.machine)));
			}
		}
	}

	private choice(parent: HTMLElement, label: string, selected: boolean): HTMLButtonElement {
		const b = DOM.append(parent, $('button.dispatch-pc-choice')) as HTMLButtonElement;
		b.setAttribute('role', 'option');
		b.setAttribute('aria-selected', String(selected));
		b.setAttribute('aria-label', label);
		b.title = label;
		b.classList.toggle('selected', selected);
		return b;
	}

	private pickKind(data: IDispatchProjectCustom, look: IDispatchProjectLook | undefined, kind: DispatchProjectIconKind): void {
		const color = look?.color;
		if (kind === 'folder') {
			this.openKind.set(undefined, undefined);
			void this.save(data, color ? { icon: 'folder', color } : undefined, { icon: 'folder' });
		} else if (kind === look?.icon) {
			this.openKind.set(undefined, undefined);
		} else if (kind === 'symbol') {
			this.openKind.set(undefined, undefined);
			void this.save(data, { icon: 'symbol', symbol: data.choices.symbols[0], color }, { symbol: data.choices.symbols[0] });
		} else if (kind === 'emoji') {
			this.openKind.set(undefined, undefined);
			void this.save(data, { icon: 'emoji', emoji: data.choices.emoji[0], color }, { emoji: data.choices.emoji[0] });
		} else {
			// a picture found in the folder is the natural first pick; with none, open the choices and wait
			const first = data.pictures.find(p => p.data);
			if (first) {
				this.openKind.set(undefined, undefined);
				void this.save(data, { icon: 'picture', picture_data: first.data, color }, { picture: first.path });
			} else {
				this.openKind.set('picture', undefined);
			}
		}
	}

	private async choosePicture(data: IDispatchProjectCustom, look: IDispatchProjectLook | undefined): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('dispatchProjectCustom.pickTitle', "Choose a picture for {0}", data.label),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: data.local && data.dir ? URI.file(data.dir) : undefined,
			filters: [{ name: localize('dispatchProjectCustom.pictures', "Pictures"), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'icns'] }],
		});
		const file = picked?.[0];
		if (file && file.scheme === 'file') {
			await this.save(data, { icon: 'picture', color: look?.color }, { picture: file.fsPath });
		}
	}

	// ---- Color -------------------------------------------------------------------------------------------------

	private renderColor(parent: HTMLElement, data: IDispatchProjectCustom, look: IDispatchProjectLook | undefined, store: DisposableStore): void {
		const tints = !look || look.icon === 'folder' || look.icon === 'symbol';
		const section = this.section(parent, localize('dispatchProjectCustom.color', "Color"),
			tints ? localize('dispatchProjectCustom.colorNote', "Only the icon takes the color.") : localize('dispatchProjectCustom.colorOwn', "An emoji or a picture keeps its own colors."));
		section.dataset.section = 'color';
		const row = DOM.append(section, $('.dispatch-pc-swatches'));
		row.setAttribute('role', 'listbox');
		row.setAttribute('aria-label', localize('dispatchProjectCustom.color', "Color"));
		const none = this.choice(row, localize('dispatchProjectCustom.noColor', "No color"), !look?.color);
		none.classList.add('dispatch-pc-swatch', 'none');
		DOM.append(none, $(`span${ThemeIcon.asCSSSelector(Codicon.circleSlash)}`));
		none.disabled = !tints;
		store.add(DOM.addDisposableListener(none, DOM.EventType.CLICK, () => this.save(data, withColor(look, undefined), { color: 'none' })));
		for (const c of data.choices.colors) {
			const hex = DISPATCH_PROJECT_COLORS[c.id];
			if (!hex) {
				continue;
			}
			const b = this.choice(row, c.label, look?.color === c.id);
			b.classList.add('dispatch-pc-swatch');
			b.disabled = !tints;
			const dot = DOM.append(b, $('span.dispatch-pc-swatch-dot'));
			dot.style.setProperty('--dispatch-project-color', hex);
			store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => this.save(data, withColor(look, c.id), { color: c.id })));
		}
	}

	// ---- Tools (MCP servers) -------------------------------------------------------------------------------------

	private renderTools(parent: HTMLElement, data: IDispatchProjectCustom, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProjectCustom.tools', "Tools agents can use here"));
		section.dataset.section = 'tools';
		callout(section, localize('dispatchProjectCustom.toolsLead', "Extra tools an agent can call, like GitHub or a database (MCP servers)."),
			localize('dispatchProjectCustom.toolsRest', "Turn one off for an agent and it stops using that tool in this project only. Your other projects keep it."));
		const tools = data.tools;
		if (!tools) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.toolsElsewhere', "This project lives on {0}. Change its tools there.", data.machine)));
			return;
		}
		if (tools.error) {
			DOM.append(section, $('.dispatch-pc-note', undefined, tools.error));
		}
		if (!tools.tools.length) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.noTools', "No extra tools are set up. Add them in Settings › MCP servers.")));
			return;
		}
		for (const tool of tools.tools) {
			const row = DOM.append(section, $('.dispatch-project-item.dispatch-pc-tool'));
			row.dataset.tool = tool.name;
			DOM.append(row, $(`span.dispatch-project-item-icon${ThemeIcon.asCSSSelector(tool.transport === 'stdio' ? Codicon.tools : Codicon.globe)}`)).setAttribute('aria-hidden', 'true');
			const title = DOM.append(row, $('span.dispatch-project-item-title.dispatch-pc-tool-name', undefined, tool.name));
			title.title = tool.what;
			if (tool.from !== 'everyone') {
				DOM.append(row, $('span.dispatch-pc-tag', undefined, tool.from === 'project'
					? localize('dispatchProjectCustom.thisProject', "This project")
					: localize('dispatchProjectCustom.cursorOnly', "Cursor only")));
			}
			const pills = DOM.append(row, $('.dispatch-pc-engines'));
			pills.setAttribute('role', 'group');
			pills.setAttribute('aria-label', localize('dispatchProjectCustom.toolAgents', "Agents that use {0} here", tool.name));
			for (const [engine, label] of ENGINES) {
				const e = tool.engines[engine];
				const pill = DOM.append(pills, $('button.dispatch-pc-engine')) as HTMLButtonElement;
				pill.dataset.engine = engine;
				const on = !!e?.has && e.state === 'on';
				pill.setAttribute('aria-pressed', String(on));
				pill.classList.toggle('on', on);
				if (on) {
					DOM.append(pill, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`)).setAttribute('aria-hidden', 'true');
				}
				DOM.append(pill, $('span', undefined, label));
				if (!e?.has) {
					pill.disabled = true;
					pill.title = tool.from === 'cursor'
						? localize('dispatchProjectCustom.cursorTitle', "Only Cursor reads .cursor/mcp.json. To use {0} with your agents, add it in Settings › MCP servers.", tool.name)
						: localize('dispatchProjectCustom.notSetUp', "{0} is not set up for {1}. Add it in Settings › MCP servers.", tool.name, label);
					continue;
				}
				pill.title = e.state === 'ask'
					? localize('dispatchProjectCustom.askTitle', "{0} has not been allowed to use {1} yet and would ask the first time. Click to allow it here.", label, tool.name)
					: on
						? localize('dispatchProjectCustom.onTitle', "{0} uses {1} in this project. Click to turn it off here.", label, tool.name)
						: localize('dispatchProjectCustom.offTitle', "{0} does not use {1} in this project. Click to turn it on here.", label, tool.name);
				store.add(DOM.addDisposableListener(pill, DOM.EventType.CLICK, () => void this.setTool(data, tool, engine, !on)));
			}
		}
		if (tools.codex_trusted === false && tools.tools.some(t => t.engines['codex']?.has)) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.codexTrust', "Codex follows these switches once it trusts this folder. It asks the first time it works here.")));
		}
	}

	private async setTool(data: IDispatchProjectCustom, tool: IDispatchProjectTool, engine: string, on: boolean): Promise<void> {
		// show the switch at once; the answer brings the list as the files now say
		const flip = (t: IDispatchProjectTool): IDispatchProjectTool => t.name !== tool.name ? t
			: { ...t, engines: { ...t.engines, [engine]: { ...t.engines[engine], on, state: on ? 'on' : 'off' } } };
		const before = shownData.get();
		if (before?.name === data.name && before.tools) {
			shownData.set({ ...before, tools: { ...before.tools, tools: before.tools.tools.map(flip) } }, undefined);
		}
		try {
			const answer = await this.enqueue(() => this.commandService.executeCommand<IToolAnswer>('dispatch.projects', 'tool', data.name, { server: tool.name, engine, on }));
			if (!answer || answer.ok === false) {
				this.notificationService.warn(answer?.message || localize('dispatchProjectCustom.toolFailed', "Dispatch could not change {0} for this project.", tool.name));
				void load(data.name);
				return;
			}
			const now = shownData.get();
			if (now?.name === data.name && answer.tools) {
				shownData.set({ ...now, tools: answer.tools }, undefined);
			}
		} catch (e) {
			this.notificationService.warn(String((e as Error)?.message ?? e));
			void load(data.name);
		}
	}

	// ---- copies for parallel work -----------------------------------------------------------------------------

	private renderCopies(parent: HTMLElement, data: IDispatchProjectCustom, store: DisposableStore): void {
		const copies = data.copies;
		if (!copies) {
			return; // not a git repository here: agents work in the folder itself
		}
		const section = this.section(parent, localize('dispatchProjectCustom.copies', "Copies for parallel work"));
		section.dataset.section = 'copies';
		callout(section, localize('dispatchProjectCustom.copiesLead', "An agent can work in its own copy of this project, so your files stay as they are."),
			localize('dispatchProjectCustom.copiesRest', "Dispatch gets each copy ready before the agent starts: it brings the settings git leaves out, shares the installed packages and installs what is missing."));
		const toggle = DOM.append(section, $('.dispatch-project-item.clickable.dispatch-pc-switch-row'));
		const box = DOM.append(toggle, $('span.dispatch-pc-switch'));
		box.setAttribute('aria-hidden', 'true');
		if (copies.auto) {
			DOM.append(box, $(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
		}
		DOM.append(toggle, $('span.dispatch-project-item-title', undefined, localize('dispatchProjectCustom.copiesAuto', "Get copies ready on their own")));
		toggle.tabIndex = 0;
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(copies.auto));
		const flip = () => void this.setCopies(data, !copies.auto);
		store.add(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, flip));
		store.add(DOM.addDisposableListener(toggle, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } }));
		if (copies.error) {
			DOM.append(section, $('.dispatch-pc-note', undefined, copies.error));
			return;
		}
		if (!copies.auto) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.copiesOff', "Off: a copy has only what git keeps. The agent installs and sets up what it needs itself.")));
			return;
		}
		const what = DOM.append(section, $('.dispatch-pc-steps'));
		what.dataset.copy = (copies.copy ?? []).join(',');
		what.dataset.link = (copies.link ?? []).join(',');
		const step = (icon: ThemeIcon, text: string) => {
			const row = DOM.append(what, $('.dispatch-pc-step'));
			DOM.append(row, $(`span${ThemeIcon.asCSSSelector(icon)}`)).setAttribute('aria-hidden', 'true');
			DOM.append(row, $('span', undefined, text));
		};
		step(Codicon.files, copies.copy?.length
			? localize('dispatchProjectCustom.copiesCopy', "Brings {0}", listOf(copies.copy))
			: localize('dispatchProjectCustom.copiesNothing', "Nothing git leaves out needs bringing"));
		if (copies.link?.length) {
			step(Codicon.link, localize('dispatchProjectCustom.copiesLink', "Shares {0} with this folder, so nothing is installed twice", listOf(copies.link)));
		}
		if (copies.install) {
			step(Codicon.package, localize('dispatchProjectCustom.copiesInstall', "Installs packages with {0} in the background", copies.install));
		}
		const last = copies.last;
		if (last) {
			const name = last.copy.split('/').pop() || last.copy;
			const state = last.install?.state === 'running'
				? localize('dispatchProjectCustom.lastInstalling', "installing packages")
				: last.install?.state === 'failed'
					? localize('dispatchProjectCustom.lastFailed', "the install did not finish")
					: localize('dispatchProjectCustom.lastReady', "ready");
			const row = DOM.append(section, $('.dispatch-pc-note.dispatch-pc-last'));
			row.textContent = localize('dispatchProjectCustom.last', "Last copy: {0}, {1}, {2}.", name, timeAgo(last.at), state);
			row.title = last.copy;
		}
	}

	private async setCopies(data: IDispatchProjectCustom, auto: boolean): Promise<void> {
		const before = shownData.get();
		if (before?.name === data.name && before.copies) {
			shownData.set({ ...before, copies: { ...before.copies, auto } }, undefined);
		}
		try {
			const answer = await this.enqueue(() => this.commandService.executeCommand<ICopiesAnswer>('dispatch.projects', 'copies', data.name, { auto }));
			if (!answer || answer.ok === false) {
				this.notificationService.warn(answer?.message || localize('dispatchProjectCustom.copiesFailed', "Dispatch could not change this setting."));
				void load(data.name);
				return;
			}
			const now = shownData.get();
			if (now?.name === data.name && answer.copies !== undefined) {
				shownData.set({ ...now, copies: answer.copies }, undefined);
			}
		} catch (e) {
			this.notificationService.warn(String((e as Error)?.message ?? e));
			void load(data.name);
		}
	}

	// ---- the project's own instructions and hooks ----------------------------------------------------------------

	private renderAgentFiles(parent: HTMLElement, data: IDispatchProjectCustom, store: DisposableStore): void {
		const section = this.section(parent, localize('dispatchProjectCustom.agentFiles', "Its own instructions and hooks"));
		section.dataset.section = 'agent-files';
		callout(section, localize('dispatchProjectCustom.agentFilesLead', "Dispatch adds to these and never replaces them."),
			localize('dispatchProjectCustom.agentFilesRest', "Its own hooks and rules sit in your user settings next to yours, and it writes nothing in this folder. Your agents follow both."));
		const files = data.agent_files;
		if (!files) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.filesElsewhere', "This project lives on {0}.", data.machine)));
			return;
		}
		for (const n of files.notes) {
			const row = DOM.append(section, $('.dispatch-pc-warning'));
			row.dataset.note = n.id;
			DOM.append(row, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`)).setAttribute('aria-hidden', 'true');
			DOM.append(row, $('span', undefined, n.text));
		}
		if (!files.own.length) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.noOwnFiles', "This project has no instructions or hooks of its own. Your agents use your user settings here.")));
		}
		for (const o of files.own) {
			const icon = o.kind === 'instructions' ? Codicon.book : o.kind === 'hooks' ? Codicon.zap : Codicon.extensions;
			const meta = o.invalid
				? localize('dispatchProjectCustom.unreadable', "Cannot be read")
				: o.kind === 'hooks'
					? (o.count === 1 ? localize('dispatchProjectCustom.oneHook', "1 hook") : localize('dispatchProjectCustom.hooks', "{0} hooks", o.count ?? 0))
					: o.count ? localize('dispatchProjectCustom.files', "{0} files", o.count) : '';
			this.fileRow(section, icon, o.rel, [agentNames(o.agents), meta].filter(Boolean).join(' · '), o.file, o.kind === 'hooks' && o.events?.length ? o.events.join(', ') : undefined, store);
		}
		if (files.dispatch.length) {
			DOM.append(section, $('.dispatch-pc-subhead', undefined, localize('dispatchProjectCustom.dispatchAdds', "What Dispatch adds in your user settings")));
			for (const d of files.dispatch) {
				const meta = d.what.startsWith('Hooks')
					? (d.yours ? localize('dispatchProjectCustom.nextToYours', "{0} next to your {1}", d.count, d.yours) : String(d.count))
					: localize('dispatchProjectCustom.oneBlock', "one marked block");
				this.fileRow(section, Codicon.lock, d.what, meta, d.file, d.file, store);
			}
		}
		if (files.in_folder.length) {
			DOM.append(section, $('.dispatch-pc-note', undefined, localize('dispatchProjectCustom.inFolder', "These files here carry an entry marked as Dispatch's: {0}.", files.in_folder.join(', '))));
		}
	}

	private fileRow(parent: HTMLElement, icon: ThemeIcon, title: string, meta: string, file: string, hover: string | undefined, store: DisposableStore): void {
		const row = DOM.append(parent, $('.dispatch-project-item.clickable.dispatch-pc-file'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		DOM.append(row, $(`span.dispatch-project-item-icon${ThemeIcon.asCSSSelector(icon)}`)).setAttribute('aria-hidden', 'true');
		DOM.append(row, $('span.dispatch-project-item-title', undefined, title));
		if (meta) {
			DOM.append(row, $('span.dispatch-project-item-meta', undefined, meta));
		}
		row.title = hover ? `${hover}\n${file}` : file;
		const open = () => void this.commandService.executeCommand('_dispatch.openPath', file);
		store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
		store.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => { if (e.key === 'Enter') { open(); } }));
	}

	// ---- saving ------------------------------------------------------------------------------------------------

	private saves = 0;

	/**
	 * One write at a time, in the order they were picked: each is a separate CLI run that reads the board, changes
	 * it and saves it, so two at once (Symbol, then a symbol right after) could land in either order.
	 */
	private enqueue<T>(write: () => Promise<T>): Promise<T> {
		const next = writes.then(write, write);
		writes = next.catch(() => undefined);
		return next;
	}

	private save(data: IDispatchProjectCustom, expected: IDispatchProjectLook | undefined, change: Record<string, string>): Promise<void> {
		// the preview shows the latest pick at once and keeps it until the last write has answered
		const mine = ++this.saves;
		this.pending.set(expected, undefined);
		return this.enqueue(() => this.write(data, change, mine));
	}

	private async write(data: IDispatchProjectCustom, change: Record<string, string>, mine: number): Promise<void> {
		try {
			const answer = await this.commandService.executeCommand<ILookAnswer>('dispatch.projects', 'look', data.name, change);
			if (!answer || answer.ok === false) {
				this.notificationService.warn(answer?.message || localize('dispatchProjectCustom.saveFailed', "Dispatch could not change this project's icon."));
				return;
			}
			if (shownData.get()?.name === data.name) {
				shownData.set({ ...shownData.get()!, look: answer.look ?? { icon: 'folder' }, picture_from: change.picture ?? (dispatchProjectLook(answer.look)?.icon === 'picture' ? shownData.get()!.picture_from : '') }, undefined);
			}
			void this.showInSidebar(data.name, answer.look, mine);
			if (change.picture) {
				void load(data.name);
			}
		} catch (e) {
			this.notificationService.warn(String((e as Error)?.message ?? e));
		} finally {
			if (mine === this.saves) {
				this.pending.set(null, undefined);
			}
		}
	}

	/**
	 * The sidebar reads the projects again after a save. A refresh already under way read them before the save and
	 * answers for it, so this asks again until the sidebar has what was saved (else it shows an earlier pick until
	 * the next minute's poll). It runs outside the write queue: the page's own reads never wait for the sidebar.
	 */
	private async showInSidebar(name: string, look: unknown, mine: number): Promise<void> {
		const saved = JSON.stringify(dispatchProjectLook(look) ?? null);
		const shown = () => JSON.stringify(dispatchProjectLook((dispatchProjectsRegistry.get()?.find(p => p.name === name) as { look?: unknown } | undefined)?.look) ?? null);
		for (let i = 0; i < 4 && mine === this.saves && shown() !== saved; i++) {
			await refreshDispatchProjectsRegistry();
		}
	}

	layout(_width: number, _height: number): void { }

	override focus(): void {
		this.crumb?.querySelector<HTMLElement>('.dispatch-projects-crumb')?.focus();
	}
}

/** The page-top note of Customizations (DESIGN.md「页顶说明」): an info icon, the first sentence in bold. */
function callout(parent: HTMLElement, lead: string, rest: string): HTMLElement {
	const note = DOM.append(parent, $('.dispatch-pc-callout'));
	DOM.append(note, $(`span${ThemeIcon.asCSSSelector(Codicon.info)}`)).setAttribute('aria-hidden', 'true');
	const text = DOM.append(note, $('span'));
	DOM.append(text, $('strong', undefined, lead));
	text.append(' ' + rest);
	return note;
}

function listOf(items: readonly string[]): string {
	return items.length <= 3 ? items.join(', ') : localize('dispatchProjectCustom.andMore', "{0} and {1} more", items.slice(0, 3).join(', '), items.length - 3);
}

function timeAgo(at: number): string {
	const s = Math.max(0, Date.now() / 1000 - at);
	if (s < 90) {
		return localize('dispatchProjectCustom.justNow', "just now");
	}
	if (s < 3600) {
		return localize('dispatchProjectCustom.minutesAgo', "{0} min ago", Math.round(s / 60));
	}
	if (s < 86400) {
		return localize('dispatchProjectCustom.hoursAgo', "{0} h ago", Math.round(s / 3600));
	}
	return localize('dispatchProjectCustom.daysAgo', "{0} d ago", Math.round(s / 86400));
}

function agentNames(agents: readonly string[]): string {
	return agents.map(a => ENGINES.find(([id]) => id === a)?.[1] ?? a).join(', ');
}

function withColor(look: IDispatchProjectLook | undefined, color: string | undefined): IDispatchProjectLook | undefined {
	const base = look ?? { icon: 'folder' as const };
	return base.icon === 'folder' && !color ? undefined : { ...base, color };
}

class DispatchProjectCustomContribution extends Disposable {
	static readonly ID = 'dispatch.contrib.projectCustom';

	constructor(
		@ICommandService commandService: ICommandService,
		@ICustomViewService customViewService: ICustomViewService,
	) {
		super();
		commands = commandService;
		this._register(customViewService.registerCustomView({
			id: DISPATCH_PROJECT_CUSTOM_VIEW_ID,
			ctor: new SyncDescriptor(DispatchProjectCustomView),
		}, { restore: false }));
	}
}

registerWorkbenchContribution2(DispatchProjectCustomContribution.ID, DispatchProjectCustomContribution, WorkbenchPhase.AfterRestored);

// the project page's Customize, and Customize Project... on the project's row in the sessions list (sessionsList.ts)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_PROJECT_CUSTOMIZE_COMMAND,
			title: localize2('dispatchProjectCustom.customize', "Customize"),
			menu: [{ id: DispatchProjectViewMenu, group: 'navigation', order: 2.5, when: DispatchProjectRegisteredContext }],
		});
	}
	override run(accessor: ServicesAccessor, name?: unknown): void {
		const project = typeof name === 'string' && name ? name : currentDispatchProject()?.name;
		if (project) {
			showDispatchProjectCustom(accessor.get(ICustomViewService), project);
		}
	}
});
