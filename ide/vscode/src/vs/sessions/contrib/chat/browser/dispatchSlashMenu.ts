/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the slash menu of the Agents window's input, for Claude Code, Codex and OpenCode
 *  sessions (the new-session page and a running session). Typing `/` as the first character opens one
 *  menu, as wide as the input and just above it, grouped: Commands, Skills, MCP, Plugins, Agents, Model.
 *  Choosing an entry does one of four things, written on the selected row: Run (send it now), Insert
 *  (put it in the input, the person writes the rest), Open (its Customizations page or the model
 *  picker), Switch (the session's model or agent). A command this engine has only elsewhere gets a grey
 *  row with why and where (`dispatch slash`, through dispatch-bridge). The last line names the engine.
 *
 *  Where the entries come from: Commands and Skills from the agent host's `completions` (the engine's
 *  own commands, Dispatch's /clear and /rename, the skills the Skills page lists); MCP, Plugins and
 *  Agents from the session's customizations (the same data as Customizations and the Agent picker);
 *  Model from the input's model picker. Monaco's own suggest widget stays out of the way while the
 *  input is a leading `/token` (suggestOnTriggerCharacters off for that time).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSlashMenu.css';
import * as dom from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import type { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { SuggestController } from '../../../../editor/contrib/suggest/browser/suggestController.js';
import { localize } from '../../../../nls.js';
import { agentHostAgentPickerStorageKey } from '../../../../platform/agentHost/common/customAgents.js';
import { CustomizationType, type Customization } from '../../../../platform/agentHost/common/state/sessionState.js';
import { McpServerStatus } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AICustomizationManagementEditor } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { agentIcon, hookIcon, instructionsIcon, mcpServerIcon, pluginIcon, skillIcon } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { openCodeIcon } from '../../../../workbench/contrib/chat/browser/agentSessions/dispatchEngineIcons.js';
import { AICustomizationManagementSection } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { IChatInputCompletionItem, IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { getChatSessionType } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { isAgentHostProvider, type IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { buildSlashRows, firstSelectable, isGroupAlias, ISlashEntry, ISlashGrayEntry, isSelectableRow, nextSelectable, parseSlashQuery, SlashAction, SlashGroupId, SlashRow, BROWSE_CAP, FILTER_CAP } from './dispatchSlashMenuModel.js';

export type DispatchEngine = 'claude' | 'codex' | 'opencode';

const ENGINES: readonly DispatchEngine[] = ['claude', 'codex', 'opencode'];

/** Claude Code, Codex or OpenCode for an agent-host session of theirs, else undefined (no menu). */
export function dispatchEngineOf(session: ISession | undefined): DispatchEngine | undefined {
	if (!session) {
		return undefined;
	}
	const type = getChatSessionType(session.resource);
	return ENGINES.find(engine => type === `agent-host-${engine}` || (type.startsWith('remote-') && type.endsWith(`-${engine}`)));
}

function engineName(engine: DispatchEngine): string {
	switch (engine) {
		case 'claude': return localize('dispatchSlash.claude', "Claude Code");
		case 'codex': return localize('dispatchSlash.codex', "Codex");
		case 'opencode': return localize('dispatchSlash.opencode', "OpenCode");
	}
}

function engineIcon(engine: DispatchEngine): ThemeIcon {
	switch (engine) {
		case 'claude': return Codicon.claude;
		case 'codex': return Codicon.openai;
		case 'opencode': return openCodeIcon;
	}
}

export interface ISlashModelChoice {
	readonly identifier: string;
	readonly name: string;
	readonly detail?: string;
	readonly current: boolean;
}

/** What an input gives the menu. */
export interface IDispatchSlashMenuHost {
	readonly editor: ICodeEditor;
	/** The input box: the menu is as wide as it and sits just above it. */
	readonly anchor: HTMLElement;
	readonly session: IObservable<ISession | undefined>;
	/** The resource `completions` are asked for (a running chat's session resource; the session's otherwise). */
	completionResource(): ISession['resource'] | undefined;
	/** Run: send `text` as the message now. */
	submit(text: string): void;
	/** Insert: put an agent-host completion into the input the way accepting it from a suggestion does. */
	insertItem(item: IChatInputCompletionItem): void;
	getModels(): readonly ISlashModelChoice[];
	switchModel(identifier: string): boolean;
	openModelPicker(): void;
	/**
	 * The workbench's own commands that work in this session (`/fork`, `/btw`): they run in the
	 * window, never reach the engine. A running session has them; the new-session page does not.
	 */
	getWorkbenchCommands?(): readonly ISlashWorkbenchCommand[];
}

export interface ISlashWorkbenchCommand {
	readonly name: string;
	readonly description: string;
	/** Sent at once; otherwise it goes into the input with this hint after it. */
	readonly argumentHint?: string;
}

type Payload =
	| { readonly kind: 'host'; readonly item: IChatInputCompletionItem }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'page'; readonly section: AICustomizationManagementSection }
	| { readonly kind: 'model'; readonly identifier: string }
	| { readonly kind: 'modelPicker' }
	| { readonly kind: 'agent'; readonly uri: string | undefined; readonly name: string };

interface IMenuEntry extends ISlashEntry {
	readonly payload: Payload;
	readonly icon: ThemeIcon;
	readonly argumentHint?: string;
}

const GROUP_ICON: Record<SlashGroupId, ThemeIcon> = {
	[SlashGroupId.Commands]: Codicon.terminal,
	[SlashGroupId.Skills]: skillIcon,
	[SlashGroupId.Mcp]: mcpServerIcon,
	[SlashGroupId.Plugins]: pluginIcon,
	[SlashGroupId.Agents]: agentIcon,
	[SlashGroupId.Model]: Codicon.chip,
};

function groupName(group: SlashGroupId): string {
	switch (group) {
		case SlashGroupId.Commands: return localize('dispatchSlash.group.commands', "Commands");
		case SlashGroupId.Skills: return localize('dispatchSlash.group.skills', "Skills");
		case SlashGroupId.Mcp: return localize('dispatchSlash.group.mcp', "MCP");
		case SlashGroupId.Plugins: return localize('dispatchSlash.group.plugins', "Plugins");
		case SlashGroupId.Agents: return localize('dispatchSlash.group.agents', "Agents");
		case SlashGroupId.Model: return localize('dispatchSlash.group.model', "Model");
	}
}

function groupWhat(group: SlashGroupId, engine: DispatchEngine): string {
	switch (group) {
		case SlashGroupId.Commands: return localize('dispatchSlash.what.commands', "{0} runs these on this session", engineName(engine));
		case SlashGroupId.Skills: return localize('dispatchSlash.what.skills', "Adds the skill to your message, then you write the rest");
		case SlashGroupId.Mcp: return localize('dispatchSlash.what.mcp', "Servers this session can call");
		case SlashGroupId.Plugins: return localize('dispatchSlash.what.plugins', "Installed plugins");
		case SlashGroupId.Agents: return localize('dispatchSlash.what.agents', "Switches the agent for this session");
		case SlashGroupId.Model: return localize('dispatchSlash.what.model', "Switches the model for this session");
	}
}

function showAllLabel(group: SlashGroupId, total: number, matches: boolean): string {
	if (matches) {
		return localize('dispatchSlash.more.matches', "Show all {0} matches", total);
	}
	switch (group) {
		case SlashGroupId.Commands: return localize('dispatchSlash.more.commands', "Show all {0} commands", total);
		case SlashGroupId.Skills: return localize('dispatchSlash.more.skills', "Show all {0} skills", total);
		case SlashGroupId.Mcp: return localize('dispatchSlash.more.mcp', "Show all {0} servers", total);
		case SlashGroupId.Plugins: return localize('dispatchSlash.more.plugins', "Show all {0} plugins", total);
		case SlashGroupId.Agents: return localize('dispatchSlash.more.agents', "Show all {0} agents", total);
		case SlashGroupId.Model: return localize('dispatchSlash.more.model', "Show all {0} models", total);
	}
}

function actionLabel(action: SlashAction): string {
	switch (action) {
		case SlashAction.Run: return localize('dispatchSlash.action.run', "Run");
		case SlashAction.Insert: return localize('dispatchSlash.action.insert', "Insert");
		case SlashAction.Open: return localize('dispatchSlash.action.open', "Open");
		case SlashAction.Switch: return localize('dispatchSlash.action.switch', "Switch");
	}
}

function mcpStatusText(status: McpServerStatus, enabled: boolean): string {
	if (!enabled) {
		return localize('dispatchSlash.mcp.off', "Turned off");
	}
	switch (status) {
		case McpServerStatus.Ready: return localize('dispatchSlash.mcp.ready', "Connected");
		case McpServerStatus.Starting: return localize('dispatchSlash.mcp.starting', "Starting");
		case McpServerStatus.AuthRequired: return localize('dispatchSlash.mcp.auth', "Needs sign-in");
		case McpServerStatus.Error: return localize('dispatchSlash.mcp.error', "Could not start");
		default: return localize('dispatchSlash.mcp.stopped', "Not started");
	}
}

/** The gray rows each engine has, read once per window through dispatch-bridge (`dispatch slash`). */
const grayTables = new Map<DispatchEngine, Promise<readonly ISlashGrayEntry[]>>();

interface ICommandMeta {
	readonly action?: SlashAction;
	readonly argumentHint?: string;
	/** a permission or mode toggle of GitHub Copilot's (`/yolo`), not a command of these engines */
	readonly configAction: boolean;
}

function readCommandMeta(meta: Record<string, unknown> | undefined): ICommandMeta {
	if (!meta) {
		return { configAction: false };
	}
	const action = meta['dispatchAction'];
	const hint = meta['argumentHint'];
	return {
		action: action === 'run' ? SlashAction.Run : action === 'insert' ? SlashAction.Insert : undefined,
		argumentHint: typeof hint === 'string' && hint ? hint : undefined,
		configAction: !!meta['action'],
	};
}

/**
 * The menu for one input. Created by the input (NewChatInputWidget, the Agents window's ChatView);
 * does nothing for sessions of other harnesses.
 */
export class DispatchSlashMenu extends Disposable {

	private readonly _root: HTMLElement;
	private readonly _list: HTMLElement;
	private readonly _footer: HTMLElement;
	private _isOpen = false;
	private _rows: SlashRow[] = [];
	private _rowElements: HTMLElement[] = [];
	private _selected = -1;
	private _query = '';
	private readonly _expanded = new Set<SlashGroupId>();
	/** Esc closes the menu until the text changes. */
	private _dismissedText: string | undefined;
	/** Entries of the session they were read for. */
	private _data: { readonly key: string; readonly entries: readonly IMenuEntry[]; readonly gray: readonly ISlashGrayEntry[]; readonly items: readonly IChatInputCompletionItem[] } | undefined;
	private _loadingKey: string | undefined;
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());
	/** The suggest options before the menu turned them off; set while they are off. */
	private _savedSuggest: { readonly onTrigger: boolean; readonly quick: unknown } | undefined;
	private readonly _openStore = this._register(new MutableDisposable());
	/** The engine's list was not there yet (OpenCode starting): read again while the menu is open. */
	private readonly _retry = this._register(new MutableDisposable());
	private _retries = 0;

	constructor(
		private readonly _host: IDispatchSlashMenuHost,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@ICommandService private readonly _commandService: ICommandService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILayoutService private readonly _layoutService: ILayoutService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICustomizationHarnessService private readonly _harnessService: ICustomizationHarnessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._root = dom.$('.dispatch-slash-menu');
		this._root.setAttribute('role', 'dialog');
		this._root.setAttribute('aria-label', localize('dispatchSlash.aria', "Slash commands"));
		this._list = dom.append(this._root, dom.$('.dsm-list'));
		this._list.setAttribute('role', 'listbox');
		this._list.id = `dispatch-slash-menu-${Math.random().toString(36).slice(2, 10)}`;
		this._footer = dom.append(this._root, dom.$('.dsm-foot'));
		// clicks in the menu keep the focus in the input
		this._register(dom.addDisposableListener(this._root, dom.EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(toDisposable(() => this._root.remove()));

		const editor = this._host.editor;
		this._register(editor.onDidChangeModelContent(() => this._update()));
		this._register(editor.onDidBlurEditorText(() => this._close()));
		this._register(editor.onDidFocusEditorText(() => this._update()));
		// capture phase on the editor's container: runs before Monaco and the keybinding service see the key
		this._register(dom.addDisposableListener(editor.getContainerDomNode(), dom.EventType.KEY_DOWN, e => this._onKeyDown(e), true));
		this._register(autorun(reader => {
			const session = this._host.session.read(reader);
			if (this._data && this._data.key !== dataKey(session)) {
				this._data = undefined;
			}
			this._update();
		}));
	}

	// ---- open / close ------------------------------------------------------------------------

	private _update(): void {
		const session = this._host.session.get();
		const engine = dispatchEngineOf(session);
		const model = this._host.editor.getModel();
		const text = model?.getValue() ?? '';
		const query = engine && this._host.editor.hasTextFocus() ? parseSlashQuery(text) : undefined;
		this._setSuggestSuppressed(query !== undefined && !!engine);
		if (query === undefined || !engine || !session) {
			this._dismissedText = undefined;
			this._close();
			return;
		}
		if (this._dismissedText !== undefined) {
			if (this._dismissedText === text) {
				return;
			}
			this._dismissedText = undefined;
		}
		if (query !== this._query) {
			// another query: its best match is selected, not the row the last one had
			this._expanded.clear();
			this._selected = -1;
		}
		this._query = query;
		const opened = this._open(engine);
		// read the lists again each time the menu opens (the engine's list grows once the session has run):
		// the last lists show meanwhile
		if (opened || !this._data || this._data.key !== dataKey(session)) {
			void this._load(session, engine);
		}
		this._render(engine);
	}

	/** Shows the menu; true when it was closed before. */
	private _open(engine: DispatchEngine): boolean {
		if (this._isOpen) {
			return false;
		}
		this._isOpen = true;
		this._retries = 0;
		const container = this._layoutService.getContainer(dom.getWindow(this._host.anchor));
		container.appendChild(this._root);
		this._root.classList.add('dsm-opening');
		const win = dom.getWindow(this._host.anchor);
		const store = new DisposableStore();
		store.add(dom.addDisposableListener(win, dom.EventType.RESIZE, () => this._position()));
		const resize = store.add(new dom.DisposableResizeObserver('DispatchSlashMenu.anchor', () => this._position(), win));
		store.add(resize.observe(this._host.anchor));
		const timer = win.setTimeout(() => this._root.classList.remove('dsm-opening'), 120);
		store.add(toDisposable(() => win.clearTimeout(timer)));
		// the models, servers, plugins and agents are read from the window as they are: an engine that
		// lists its models in batches (OpenCode) adds them to the open menu
		const refresh = win.setInterval(() => this._refreshLocal(engine), 1000);
		store.add(toDisposable(() => win.clearInterval(refresh)));
		this._openStore.value = store;
		this._renderFooter(engine);
		const textArea = this._host.editor.getDomNode()?.querySelector('textarea');
		textArea?.setAttribute('aria-controls', this._list.id);
		textArea?.setAttribute('aria-expanded', 'true');
		return true;
	}

	private _refreshLocal(engine: DispatchEngine): void {
		const session = this._host.session.get();
		const data = this._data;
		if (!this._isOpen || !session || !data || data.key !== dataKey(session)) {
			return;
		}
		const entries = this._entries(session, data.items);
		const ids = (list: readonly IMenuEntry[]) => list.map(e => `${e.id}\0${e.current ? 1 : 0}\0${e.description}`).join('\n');
		if (ids(entries) !== ids(data.entries)) {
			this._data = { ...data, entries };
			this._render(engine);
		}
	}

	private _close(): void {
		if (!this._isOpen) {
			return;
		}
		this._isOpen = false;
		this._openStore.clear();
		this._retry.clear();
		this._root.remove();
		this._selected = -1;
		this._expanded.clear();
		const textArea = this._host.editor.getDomNode()?.querySelector('textarea');
		textArea?.removeAttribute('aria-activedescendant');
		textArea?.setAttribute('aria-expanded', 'false');
	}

	/** Monaco's suggest widget stays closed while the menu owns the leading `/token`. */
	private _setSuggestSuppressed(suppressed: boolean): void {
		const editor = this._host.editor;
		if (suppressed && !this._savedSuggest) {
			this._savedSuggest = { onTrigger: editor.getOption(EditorOption.suggestOnTriggerCharacters), quick: editor.getOption(EditorOption.quickSuggestions) };
			editor.updateOptions({ suggestOnTriggerCharacters: false, quickSuggestions: false });
			SuggestController.get(editor)?.cancelSuggestWidget();
		} else if (!suppressed && this._savedSuggest) {
			const saved = this._savedSuggest;
			this._savedSuggest = undefined;
			editor.updateOptions({ suggestOnTriggerCharacters: saved.onTrigger, quickSuggestions: saved.quick as never });
		}
	}

	private _position(): void {
		if (!this._isOpen) {
			return;
		}
		const rect = this._host.anchor.getBoundingClientRect();
		const win = dom.getWindow(this._host.anchor);
		// the room above the input, under the title bar
		const titleBar = this._layoutService.getContainer(win).querySelector('.part.titlebar');
		const top = titleBar ? Math.max(0, titleBar.getBoundingClientRect().bottom) : 0;
		const room = Math.max(120, rect.top - top - 16);
		this._root.style.left = `${Math.round(rect.left)}px`;
		this._root.style.width = `${Math.round(rect.width)}px`;
		this._root.style.bottom = `${Math.round(win.innerHeight - rect.top + 8)}px`;
		this._list.style.maxHeight = `${Math.min(360, room - 44)}px`;
	}

	// ---- data --------------------------------------------------------------------------------

	private async _load(session: ISession, engine: DispatchEngine): Promise<void> {
		const key = dataKey(session);
		if (this._loadingKey === key) {
			return;
		}
		this._loadingKey = key;
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		try {
			const [items, gray] = await Promise.all([
				this._loadHostItems(cts),
				this._loadGray(engine),
			]);
			if (cts.token.isCancellationRequested) {
				return;
			}
			const current = this._host.session.get();
			if (dataKey(current) !== key) {
				return;
			}
			this._data = { key, entries: this._entries(session, items), gray, items };
			this._retryUntilComplete(items, this._data.entries, session, engine);
		} catch (err) {
			this._logService.warn('[DispatchSlashMenu] could not read the commands', err);
			this._data = { key, entries: this._entries(session, []), gray: [], items: [] };
		} finally {
			if (this._loadingKey === key) {
				this._loadingKey = undefined;
			}
		}
		if (this._isOpen) {
			this._render(engine);
		}
	}

	/**
	 * Part of the lists has not come yet (the engine's process still starting, as OpenCode's does for a
	 * few seconds; in a new window Claude Code's skills, servers and models arrive after its built-in
	 * commands): the open menu reads the lists again every two seconds, for half a minute at most, and
	 * shows what came.
	 */
	private _retryUntilComplete(items: readonly IChatInputCompletionItem[], entries: readonly IMenuEntry[], session: ISession, engine: DispatchEngine): void {
		const hasEngineCommands = items.some(item => item.attachment.kind === 'command' && item.attachment.command !== 'clear' && item.attachment.command !== 'rename');
		const complete = hasEngineCommands && entries.some(e => e.group === SlashGroupId.Skills) && entries.some(e => e.group === SlashGroupId.Model);
		if (complete || !this._isOpen || this._retries >= 15) {
			return;
		}
		this._retries++;
		const win = dom.getWindow(this._host.anchor);
		const handle = win.setTimeout(() => {
			if (this._isOpen && dataKey(this._host.session.get()) === dataKey(session)) {
				void this._load(session, engine);
			}
		}, 2000);
		this._retry.value = toDisposable(() => win.clearTimeout(handle));
	}

	private async _loadHostItems(cts: CancellationTokenSource): Promise<readonly IChatInputCompletionItem[]> {
		const resource = this._host.completionResource();
		if (!resource) {
			return [];
		}
		// a new session's completions wait for its provisional session: past a few seconds the menu goes on
		// without them rather than read forever
		const result = await raceTimeout(this._chatSessionsService.provideChatInputCompletions(resource, { text: '/', offset: 1 }, cts.token), 4000);
		return result?.items ?? [];
	}

	private _loadGray(engine: DispatchEngine): Promise<readonly ISlashGrayEntry[]> {
		let p = grayTables.get(engine);
		if (!p) {
			p = Promise.resolve(this._commandService.executeCommand<{ rows?: ISlashGrayEntry[] }>('dispatch.slash', engine)).then(t => t?.rows ?? [], () => []);
			grayTables.set(engine, p);
			void p.then(rows => {
				if (!rows.length) {
					grayTables.delete(engine); // dispatch-bridge not up yet: ask again next time
				}
			});
		}
		return p;
	}

	private _entries(session: ISession, items: readonly IChatInputCompletionItem[]): IMenuEntry[] {
		const out: IMenuEntry[] = [];
		const seen = new Set<string>();
		const add = (entry: IMenuEntry) => {
			const key = `${entry.group}\0${entry.name.toLowerCase()}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push(entry);
			}
		};

		// Commands and Skills: the agent host's completions for a leading `/`. A skill named like one of
		// the engine's commands stays out of Skills (Claude Code reports `/init` among both); the person's
		// own command files (`~/.claude/commands/*.md`) are commands
		const commands: IMenuEntry[] = [];
		const skills: IMenuEntry[] = [];
		for (const item of items) {
			const a = item.attachment;
			// a config toggle (`/yolo`, `Allow all`) has no text or a label of its own: not for this menu
			if (!item.insertText.startsWith('/') || (item.label !== undefined && item.label.trim() !== item.insertText.trim())) {
				continue;
			}
			if (a.kind === 'command' && !a.isSkill) {
				const meta = readCommandMeta(a._meta);
				if (meta.configAction || isGroupAlias(a.command)) {
					continue; // `/model`, `/mcp`, `/agents`: typing them shows the group
				}
				commands.push({
					id: `cmd:${a.command}`, group: SlashGroupId.Commands, name: a.command, slash: true,
					description: a.description, action: meta.action ?? (meta.argumentHint ? SlashAction.Insert : SlashAction.Run),
					argumentHint: meta.argumentHint, icon: GROUP_ICON[SlashGroupId.Commands], payload: { kind: 'host', item },
				});
			} else if (a.kind === 'skill' && isCommandFile(a.uri)) {
				const name = a.displayName ?? item.insertText.trim().slice(1);
				commands.push({
					id: `cmd:${name}`, group: SlashGroupId.Commands, name, slash: true,
					description: a.description ?? '', action: SlashAction.Run,
					icon: GROUP_ICON[SlashGroupId.Commands], payload: { kind: 'host', item },
				});
			} else if (a.kind === 'skill' || (a.kind === 'command' && a.isSkill)) {
				const name = a.kind === 'skill' ? (a.displayName ?? item.insertText.trim().slice(1)) : a.command;
				skills.push({
					id: `skill:${name}`, group: SlashGroupId.Skills, name, slash: true,
					description: a.description ?? '', action: SlashAction.Insert,
					icon: GROUP_ICON[SlashGroupId.Skills], payload: { kind: 'host', item },
				});
			}
		}
		// the engine's everyday commands first, Dispatch's /clear after its first three, /rename last
		const take = (name: string) => {
			const index = commands.findIndex(c => c.name === name);
			return index >= 0 ? commands.splice(index, 1)[0] : undefined;
		};
		const rename = take('rename');
		const clear = take('clear');
		if (clear) {
			commands.splice(Math.min(3, commands.length), 0, clear);
		}
		if (rename) {
			commands.push(rename);
		}
		commands.forEach(add);
		const commandNames = new Set(commands.map(e => e.name.toLowerCase()));
		for (const skill of skills) {
			if (!commandNames.has(skill.name.toLowerCase())) {
				add(skill);
			}
		}
		// the workbench's own commands that work here (`/fork`, `/btw`)
		for (const command of this._host.getWorkbenchCommands?.() ?? []) {
			add({
				id: `wb:${command.name}`, group: SlashGroupId.Commands, name: command.name, slash: true,
				description: command.description, action: command.argumentHint ? SlashAction.Insert : SlashAction.Run,
				argumentHint: command.argumentHint, icon: GROUP_ICON[SlashGroupId.Commands],
				payload: { kind: 'text', text: `/${command.name}` },
			});
		}
		// Dispatch's own ways to the pages the terminal commands open
		add({ id: 'cmd:hooks', group: SlashGroupId.Commands, name: 'hooks', slash: true, description: localize('dispatchSlash.hooks', "Open Hooks in Settings"), action: SlashAction.Open, icon: hookIcon, payload: { kind: 'page', section: AICustomizationManagementSection.Hooks } });
		add({ id: 'cmd:instructions', group: SlashGroupId.Commands, name: 'instructions', slash: true, description: localize('dispatchSlash.instructions', "Open Instructions in Settings"), action: SlashAction.Open, icon: instructionsIcon, payload: { kind: 'page', section: AICustomizationManagementSection.Instructions } });

		// MCP, Plugins, Agents: the session's customizations
		const provider = this._provider(session);
		if (provider) {
			for (const server of provider.getMcpServers(session.sessionId)) {
				add({
					id: `mcp:${server.id}`, group: SlashGroupId.Mcp, name: server.name, slash: false,
					description: mcpStatusText(server.status, server.enabled), action: SlashAction.Open,
					icon: GROUP_ICON[SlashGroupId.Mcp], payload: { kind: 'page', section: AICustomizationManagementSection.McpServers },
				});
			}
			for (const plugin of provider.getCustomizations(session.sessionId)) {
				if (plugin.type !== CustomizationType.Plugin || plugin.uri.startsWith('vscode-synced-customization:')) {
					continue;
				}
				add({
					id: `plugin:${plugin.id}`, group: SlashGroupId.Plugins, name: plugin.name, slash: false,
					description: pluginSummary(plugin), action: SlashAction.Open,
					icon: GROUP_ICON[SlashGroupId.Plugins], payload: { kind: 'page', section: AICustomizationManagementSection.Plugins },
				});
			}
			const currentAgent = session.mode.get()?.id;
			const agents = provider.getCustomAgents(session.sessionId);
			if (agents.length && provider.setAgent) {
				// back to no custom agent, as the picker's first entry
				add({
					id: 'agent:default', group: SlashGroupId.Agents, name: localize('dispatchSlash.defaultAgent', "Agent"), slash: false,
					description: localize('dispatchSlash.defaultAgent.detail', "{0} without a custom agent", engineName(dispatchEngineOf(session) ?? 'claude')),
					action: SlashAction.Switch, current: !agents.some(agent => agent.uri === currentAgent),
					icon: GROUP_ICON[SlashGroupId.Agents], payload: { kind: 'agent', uri: undefined, name: '' },
				});
			}
			for (const agent of agents) {
				add({
					id: `agent:${agent.uri}`, group: SlashGroupId.Agents, name: agent.name, slash: false,
					description: agent.description ?? '', action: SlashAction.Switch, current: agent.uri === currentAgent,
					icon: GROUP_ICON[SlashGroupId.Agents], payload: { kind: 'agent', uri: agent.uri, name: agent.name },
				});
			}
		}

		// Model: the input's model picker
		const models = this._host.getModels();
		for (const model of models) {
			add({
				id: `model:${model.identifier}`, group: SlashGroupId.Model, name: model.name, slash: false,
				description: model.detail ?? '', action: SlashAction.Switch, current: model.current,
				icon: GROUP_ICON[SlashGroupId.Model], payload: { kind: 'model', identifier: model.identifier },
			});
		}
		if (models.length) {
			add({
				id: 'model:picker', group: SlashGroupId.Model, name: localize('dispatchSlash.allModels', "All models and effort"), slash: false,
				description: localize('dispatchSlash.allModels.detail', "Open the model picker"), action: SlashAction.Open, trailing: true,
				icon: GROUP_ICON[SlashGroupId.Model], payload: { kind: 'modelPicker' },
			});
		}
		return out;
	}

	private _provider(session: ISession): IAgentHostSessionsProvider | undefined {
		const provider = this._sessionsProvidersService.getProvider(session.providerId);
		return provider && isAgentHostProvider(provider) ? provider : undefined;
	}

	// ---- rendering ---------------------------------------------------------------------------

	private _render(engine: DispatchEngine): void {
		if (!this._isOpen) {
			return;
		}
		const previous = this._selected >= 0 ? rowKey(this._rows[this._selected]) : undefined;
		dom.clearNode(this._list);
		this._rowElements = [];
		if (!this._data) {
			this._rows = [];
			const loading = dom.append(this._list, dom.$('.dsm-loading'));
			loading.textContent = localize('dispatchSlash.loading', "Reading {0}'s commands", engineName(engine));
			this._position();
			return;
		}
		// the models and the current agent change while the menu is open (a switch): read them again
		const entries = this._data.entries;
		this._rows = buildSlashRows(entries, this._data.gray, this._query, this._expanded);
		this._rows.forEach((row, index) => {
			const el = this._renderRow(row, index, engine);
			this._rowElements.push(el);
			this._list.appendChild(el);
		});
		const kept = previous !== undefined ? this._rows.findIndex(r => rowKey(r) === previous) : -1;
		this._select(kept >= 0 ? kept : firstSelectable(this._rows), false);
		this._position();
	}

	private _renderRow(row: SlashRow, index: number, engine: DispatchEngine): HTMLElement {
		switch (row.kind) {
			case 'header': {
				const el = dom.$('.dsm-head');
				dom.append(el, dom.$('span.dsm-head-name')).textContent = groupName(row.group);
				dom.append(el, dom.$('span.dsm-head-count')).textContent = String(row.count);
				dom.append(el, dom.$('span.dsm-head-what')).textContent = groupWhat(row.group, engine);
				return el;
			}
			case 'grayHeader': {
				const el = dom.$('.dsm-head');
				dom.append(el, dom.$('span.dsm-head-name')).textContent = localize('dispatchSlash.gray.head', "Not in {0}", engineName(engine));
				dom.append(el, dom.$('span.dsm-head-what')).textContent = localize('dispatchSlash.gray.what', "Why, and where to do it instead");
				return el;
			}
			case 'empty': {
				const el = dom.$('.dsm-empty');
				el.textContent = localize('dispatchSlash.empty', "Nothing matches /{0}. Enter sends it as plain text.", row.query);
				return el;
			}
			case 'more': {
				const el = this._rowShell(index, 'dsm-row.dsm-more');
				dom.append(el, dom.$(ThemeIcon.asCSSSelector(Codicon.chevronDown)));
				dom.append(el, dom.$('span.dsm-name')).textContent = showAllLabel(row.group, row.total, row.matches);
				this._appendAction(el, localize('dispatchSlash.action.expand', "Expand"));
				return el;
			}
			case 'gray': {
				const el = this._rowShell(index, 'dsm-row.dsm-gray');
				dom.append(el, dom.$(ThemeIcon.asCSSSelector(Codicon.circleSlash)));
				dom.append(el, dom.$('span.dsm-name')).textContent = `/${row.entry.name}`;
				dom.append(el, dom.$('span.dsm-desc')).textContent = row.entry.where ? `${row.entry.why} · ${row.entry.where}` : row.entry.why;
				if (row.entry.go) {
					this._appendAction(el, localize('dispatchSlash.action.go', "Go"));
				}
				el.title = row.entry.where ? `${row.entry.why}. ${row.entry.where}.` : `${row.entry.why}.`;
				return el;
			}
			case 'item': {
				const entry = row.entry as IMenuEntry;
				const el = this._rowShell(index, 'dsm-row');
				dom.append(el, dom.$(ThemeIcon.asCSSSelector(entry.icon)));
				dom.append(el, dom.$('span.dsm-name')).textContent = entry.slash ? `/${entry.name}` : entry.name;
				const desc = dom.append(el, dom.$('span.dsm-desc'));
				desc.textContent = entry.description;
				if (entry.description) {
					desc.title = entry.description;
				}
				this._appendAction(el, actionLabel(entry.action));
				if (entry.current) {
					dom.append(el, dom.$('span.dsm-current')).textContent = localize('dispatchSlash.current', "Current");
				}
				return el;
			}
		}
	}

	private _rowShell(index: number, selector: string): HTMLElement {
		const el = dom.$(`.${selector}`);
		el.setAttribute('role', 'option');
		el.id = `${this._list.id}-${index}`;
		el.addEventListener('mousemove', () => {
			if (this._selected !== index) {
				this._select(index, false);
			}
		});
		el.addEventListener('click', () => this._activate(index));
		return el;
	}

	private _appendAction(el: HTMLElement, label: string): void {
		const act = dom.append(el, dom.$('span.dsm-act'));
		dom.append(act, dom.$('span')).textContent = label;
		dom.append(act, dom.$('kbd')).textContent = '↵';
	}

	private _renderFooter(engine: DispatchEngine): void {
		dom.clearNode(this._footer);
		const eng = dom.append(this._footer, dom.$('span.dsm-engine'));
		dom.append(eng, dom.$(ThemeIcon.asCSSSelector(engineIcon(engine))));
		dom.append(eng, dom.$('span')).textContent = engineName(engine);
		dom.append(this._footer, dom.$('span.dsm-keys')).textContent = localize('dispatchSlash.keys', "↑↓ Move · ↵ Do it · Tab Complete · Esc Close");
	}

	private _select(index: number, reveal = true): void {
		if (this._selected >= 0) {
			this._rowElements[this._selected]?.classList.remove('selected');
			this._rowElements[this._selected]?.setAttribute('aria-selected', 'false');
		}
		this._selected = index;
		const el = index >= 0 ? this._rowElements[index] : undefined;
		const textArea = this._host.editor.getDomNode()?.querySelector('textarea');
		if (el) {
			el.classList.add('selected');
			el.setAttribute('aria-selected', 'true');
			textArea?.setAttribute('aria-activedescendant', el.id);
			if (reveal) {
				el.scrollIntoView({ block: 'nearest' });
			}
		} else {
			textArea?.removeAttribute('aria-activedescendant');
		}
	}

	// ---- keys and choices --------------------------------------------------------------------

	private _onKeyDown(e: KeyboardEvent): void {
		if (!this._isOpen || e.isComposing || e.keyCode === 229) {
			return;
		}
		const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
		const handled = (() => {
			switch (e.key) {
				case 'ArrowDown':
					if (!plain || e.shiftKey) {
						return false;
					}
					this._select(nextSelectable(this._rows, this._selected, 1));
					return true;
				case 'ArrowUp':
					if (!plain || e.shiftKey) {
						return false;
					}
					this._select(nextSelectable(this._rows, this._selected < 0 ? 0 : this._selected, -1));
					return true;
				case 'Enter':
					if (!plain || e.shiftKey || this._selected < 0) {
						return false; // nothing to choose: Enter sends the text as it is
					}
					this._activate(this._selected);
					return true;
				case 'Tab':
					if (!plain || e.shiftKey) {
						return false;
					}
					this._complete();
					return true;
				case 'Escape':
					this._dismissedText = this._host.editor.getModel()?.getValue();
					this._close();
					return true;
			}
			return false;
		})();
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** Tab: the name only, nothing runs (`/comp` → `/compact `), so an argument can follow. */
	private _complete(): void {
		const row = this._rows[this._selected];
		if (row?.kind !== 'item') {
			return;
		}
		const payload = (row.entry as IMenuEntry).payload;
		if (payload.kind === 'host') {
			this._host.insertItem(payload.item);
		} else if (payload.kind === 'text') {
			this._insertText(`${payload.text} `);
		}
	}

	private _insertText(text: string): void {
		const model = this._host.editor.getModel();
		if (model) {
			model.setValue(text);
			this._host.editor.setPosition(model.getPositionAt(text.length));
			this._host.editor.focus();
		}
	}

	private _activate(index: number): void {
		const row = this._rows[index];
		if (!row || !isSelectableRow(row)) {
			return;
		}
		const engine = dispatchEngineOf(this._host.session.get());
		if (row.kind === 'more') {
			this._expanded.add(row.group);
			if (engine) {
				this._render(engine);
			}
			// the first entry that was hidden
			const cap = row.matches ? FILTER_CAP : BROWSE_CAP;
			let seen = 0;
			for (let i = 0; i < this._rows.length; i++) {
				const r = this._rows[i];
				if (r.kind === 'item' && r.entry.group === row.group && seen++ === cap) {
					this._select(i);
					break;
				}
			}
			return;
		}
		if (row.kind === 'gray') {
			this._go(row.entry);
			return;
		}
		const entry = row.entry as IMenuEntry;
		const payload = entry.payload;
		switch (payload.kind) {
			case 'text':
				if (entry.action === SlashAction.Run) {
					this._close();
					this._host.submit(payload.text);
				} else {
					this._insertText(`${payload.text} `);
				}
				return;
			case 'host':
				if (entry.action === SlashAction.Run) {
					this._close();
					this._host.submit(payload.item.insertText.trim());
				} else {
					this._host.insertItem(payload.item);
				}
				return;
			case 'page':
				this._clearInput();
				void this._openPage(payload.section);
				return;
			case 'model':
				this._clearInput();
				this._host.switchModel(payload.identifier);
				return;
			case 'modelPicker':
				this._clearInput();
				this._host.openModelPicker();
				return;
			case 'agent': {
				this._clearInput();
				const session = this._host.session.get();
				const provider = session && this._provider(session);
				if (session && provider?.setAgent) {
					// as the Agent picker does (agentHostAgentPicker.ts)
					const key = agentHostAgentPickerStorageKey(session.resource.scheme);
					if (payload.uri) {
						this._storageService.store(key, payload.uri, StorageScope.PROFILE, StorageTarget.MACHINE);
						provider.setAgent(session.sessionId, { uri: payload.uri, name: payload.name });
					} else {
						this._storageService.remove(key, StorageScope.PROFILE);
						provider.setAgent(session.sessionId, undefined);
					}
				}
				return;
			}
		}
	}

	/** Enter on a grey row: Dispatch's own way to the same thing, when there is one. */
	private _go(entry: ISlashGrayEntry): void {
		const go = entry.go;
		if (!go) {
			return; // the row only explains
		}
		if (go.startsWith('alias:')) {
			const model = this._host.editor.getModel();
			if (model) {
				const text = `/${go.slice('alias:'.length)}`;
				model.setValue(text);
				this._host.editor.setPosition(model.getPositionAt(text.length));
			}
			return;
		}
		this._clearInput();
		if (go.startsWith('customizations:')) {
			void this._openPage(go.slice('customizations:'.length) as AICustomizationManagementSection);
			return;
		}
		switch (go) {
			case 'changes':
				void this._commandService.executeCommand('workbench.action.agentSessions.openChangesView');
				return;
			case 'new':
				void this._commandService.executeCommand('workbench.action.sessions.newChat');
				return;
			case 'sessions':
				void this._commandService.executeCommand('workbench.action.chat.focusAgentSessionsViewer').catch(() => { /* the list is on the left anyway */ });
				return;
			case 'accounts':
				this._clickNear('.dispatch-accounts-button, .account-titlebar-button, [aria-label^="Accounts"]', true);
				return;
			case 'permissions':
				this._clickNear('.sessions-chat-agent-host-config-host .monaco-dropdown-label, .sessions-chat-agent-host-config-host a[role="button"], .sessions-chat-agent-host-config .action-label', false);
				return;
		}
	}

	/** Clicks the first match: under the input (the permission picker) or anywhere in the window (the title bar). */
	private _clickNear(selector: string, window: boolean): void {
		const scope = window ? this._layoutService.getContainer(dom.getWindow(this._host.anchor)) : (this._host.anchor.closest('.interactive-input-part, .sessions-chat-composer, .new-chat-input, .chat-view-widget') ?? this._host.anchor.parentElement ?? this._host.anchor);
		const target = scope.querySelector<HTMLElement>(selector) ?? this._layoutService.getContainer(dom.getWindow(this._host.anchor)).querySelector<HTMLElement>(selector);
		target?.click();
	}

	private async _openPage(section: AICustomizationManagementSection): Promise<void> {
		const session = this._host.session.get();
		if (session) {
			this._harnessService.setActiveSession(session.resource);
		}
		const input = AICustomizationManagementEditorInput.getOrCreate();
		input.setTargetLabels(this._harnessService.getActiveDescriptor().label, session?.workspace.get()?.folders[0]?.name);
		const pane = await this._editorService.openEditor(input, { pinned: true });
		if (pane instanceof AICustomizationManagementEditor) {
			pane.selectSectionById(section);
		}
	}

	private _clearInput(): void {
		this._close();
		this._host.editor.getModel()?.setValue('');
	}
}

/** A command file of the person's (`~/.claude/commands/x.md`, a project's `.claude/commands/`): a command, not a skill. */
function isCommandFile(uri: URI): boolean {
	return /\/\.claude\/commands\/[^/]+\.md$/i.test(uri.path);
}

function dataKey(session: ISession | undefined): string {
	return session ? `${session.providerId}/${session.sessionId}/${session.resource.toString()}` : '';
}

function rowKey(row: SlashRow | undefined): string | undefined {
	switch (row?.kind) {
		case 'item': return row.entry.id;
		case 'gray': return `gray:${row.entry.name}`;
		case 'more': return `more:${row.group}`;
		default: return undefined;
	}
}

function pluginSummary(plugin: Customization): string {
	const children = 'children' in plugin ? plugin.children ?? [] : [];
	const count = (type: CustomizationType) => children.filter(c => c.type === type).length;
	const parts: string[] = [];
	const skills = count(CustomizationType.Skill);
	const agents = count(CustomizationType.Agent);
	const servers = count(CustomizationType.McpServer);
	const hooks = count(CustomizationType.Hook);
	if (skills) {
		parts.push(skills === 1 ? localize('dispatchSlash.plugin.skill', "1 skill") : localize('dispatchSlash.plugin.skills', "{0} skills", skills));
	}
	if (agents) {
		parts.push(agents === 1 ? localize('dispatchSlash.plugin.agent', "1 agent") : localize('dispatchSlash.plugin.agents', "{0} agents", agents));
	}
	if (servers) {
		parts.push(servers === 1 ? localize('dispatchSlash.plugin.server', "1 MCP server") : localize('dispatchSlash.plugin.servers', "{0} MCP servers", servers));
	}
	if (hooks) {
		parts.push(hooks === 1 ? localize('dispatchSlash.plugin.hook', "1 hook") : localize('dispatchSlash.plugin.hooks', "{0} hooks", hooks));
	}
	const version = 'version' in plugin && typeof plugin.version === 'string' ? plugin.version : '';
	return [parts.join(', '), version].filter(Boolean).join(' · ');
}
