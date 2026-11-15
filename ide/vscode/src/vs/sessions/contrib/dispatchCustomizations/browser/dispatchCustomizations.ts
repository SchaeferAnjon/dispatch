/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchCustomizations.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AICustomizationManagementSection as Section, AICustomizationSources } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { IAICustomizationListItem } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationItemSource.js';
import { renderFirstRunSettings } from './dispatchFirstRunSettings.js';
import { detectAgents, getDefaultAgent, saveAgentChoice } from '../../dispatchAgents/browser/dispatchAgents.js';
import { choiceAfterToggle, IAgentRow, isLastRunnable, recomputeDefault } from '../../dispatchAgents/browser/dispatchAgentsModel.js';
import '../../dispatchAgents/browser/media/dispatchAgentsList.css';
import { agentIcon } from '../../dispatchAgents/browser/dispatchAgentIcons.js';
import { BuiltinAgent } from './dispatchBuiltinAgentsModel.js';
import { settingsData } from '../../dispatchSettings/browser/dispatchSettingsData.js';
import { agentOrigin, withoutBuiltinPrefix } from '../common/dispatchAgentOrigin.js';
import { dispatchAgentCopies } from './dispatchAgentCopies.js';
import { guide } from '../../dispatchSettings/browser/dispatchSettingsDom.js';
import { goToSettingsPage } from '../../dispatchSettings/browser/dispatchSettingsState.js';

const $ = DOM.$;
interface Target { agent: string; path: string; state: string }
interface HookAgent { enabled: boolean; available: boolean; supported?: boolean; count: number; path: string; events: string[] }
interface Hook { id: string; name: string; event: string; if_off: string; agents: Record<string, HookAgent> }

/** When a hook runs, in plain words instead of the agents' event names ("PostToolUse"); "PreToolUse / PostToolUse"
 *  becomes both, and an event without plain words keeps its own name. */
const HOOK_WHEN: Record<string, string> = {
	SessionStart: 'When a session starts', SessionEnd: 'When a session ends', UserPromptSubmit: 'When you send a message',
	PreToolUse: 'Before the agent edits a file or runs a command', PostToolUse: 'After the agent edits a file or runs a command',
	Stop: 'When the agent finishes its reply', SubagentStop: 'When a sub-agent finishes', Notification: 'When the agent asks for you',
	PreCompact: 'Before a long conversation is shortened',
};
export function hookWhen(event: string): string {
	const parts = event.split('/').map(e => e.trim()).filter(Boolean);
	if (parts.length === 2 && parts[0] === 'PreToolUse' && parts[1] === 'PostToolUse') {
		return 'Before and after the agent edits a file or runs a command';
	}
	return parts.map(e => HOOK_WHEN[e] ?? e).join(' · ');
}
interface Skill { name: string; path: string; description: string; builtin: boolean; in_pool: boolean; agents: Record<string, boolean>; mounts: Record<string, string | null> }
interface Import { id: string; kind?: string; name: string; from: string; to: string; detail: string; can_undo: boolean; reason: string; undone?: boolean }
export interface DispatchInventory {
	rules: { source: string; exists: boolean; dispatch: string; dispatch_installed: boolean; targets: Target[] };
	hooks: { groups: Hook[]; others: { agent: string; event: string; count: number; path: string }[]; errors: string[] };
	skills: Skill[];
	imports: Import[];
	agents?: BuiltinAgent[];
}
interface Answer<T> { ok: boolean; result?: T; error?: string }
interface McpServer { name: string; engine: string; scope: string; transport: string; command: string; args: string[]; url: string; env: string[]; headers: string[]; enabled: boolean; path: string; builtin?: boolean }
type McpList = { servers: McpServer[]; configs: Record<string, { path: string; exists: boolean }> };
interface McpChange { name: string; changed: { engine: string; path: string; backup: string | null; action: string }[]; skipped: { engine: string; reason: string }[] }
type PluginList = { plugins: AgentPlugin[]; settings: string };
interface AgentPlugin { name: string; plugin: string; marketplace: string; version: string; enabled: boolean; description: string; skills: number; agents: number; commands: number; hooks: boolean; mcp: boolean; lsp: boolean; missing?: boolean }
const ENGINES: [string, string][] = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode']];
const engineLabel = (engine: string) => ENGINES.find(([id]) => id === engine)?.[1] ?? engine;
const changed = new Emitter<void>();
export const onDidChangeDispatchCustomizations = changed.event;
let pending: Promise<DispatchInventory> | undefined;
/** The last inventory read: a list drawn again (a page rebuilt after a change) shows it at once, not a blank while it reloads. */
let lastInventory: DispatchInventory | undefined;
let agentsFound: { rows: readonly IAgentRow[]; at: number } | undefined;
/** The folded agent groups of Customizations > Overview that are open (for as long as the window is). */
const openAgentGroups = new Set<string>();
let loadedAt = 0;
/** Something was just changed here: the next list waits for the inventory read after it, not the last one. */
let changedHere = false;

export async function loadDispatchInventory(commands: ICommandService): Promise<DispatchInventory> {
	if (!pending || Date.now() - loadedAt > 2000) {
		loadedAt = Date.now();
		pending = commands.executeCommand<Answer<DispatchInventory>>('dispatch.customizations', 'list').then(answer => {
			if (!answer?.ok || !answer.result) {
				pending = undefined;
				throw new Error(answer?.error || 'Dispatch customizations could not be loaded.');
			}
			lastInventory = answer.result;
			changedHere = false;
			settingsData.set('inventory', answer.result);
			return answer.result;
		});
	}
	return pending;
}

/** Settings read it a moment ago (it reads these as it opens): drawn as it is, not read once more. */
function readJustNow(key: 'inventory' | 'mcpFull' | 'plugins'): boolean {
	return Date.now() - (settingsData.at(key) ?? 0) < 10_000;
}

/** The inventory for a list being drawn: the last one read (in this window, or kept by Settings, design/settings-fast)
 *  at once, read again in the background; a fresh one that differs fires the change, and the lists draw it then. */
export async function dispatchInventoryNow(commands: ICommandService): Promise<DispatchInventory> {
	const kept = lastInventory ?? settingsData.get<DispatchInventory>('inventory');
	if (!kept || changedHere) {
		return loadDispatchInventory(commands);
	}
	if (!readJustNow('inventory') && (!pending || Date.now() - loadedAt > 2000)) {
		void loadDispatchInventory(commands).then(fresh => {
			if (JSON.stringify(fresh) !== JSON.stringify(kept)) {
				changed.fire();
			}
		}, () => undefined);
	}
	return kept;
}

function item(path: string, name: string, type: PromptsType, description: string): IAICustomizationListItem {
	return { id: `dispatch:${type}:${path}`, uri: URI.file(path), name, displayName: name, filename: path,
		promptType: type, disabled: false, source: AICustomizationSources.user, isBuiltin: false, description };
}

/** Add canonical files to the existing native Built-in / User groups. What comes with Dispatch (its skills, dispatch.md
 *  and Soul, its hook, its helper agents) is listed on Settings › Soul instead, once (kanban pref "内置的放 Soul"). */
export function mergeDispatchItems(section: string, items: readonly IAICustomizationListItem[], data: DispatchInventory): IAICustomizationListItem[] {
	if (section === Section.Skills) {
		const skills = data.skills;
		const aliases = new Set(skills.flatMap(s => [s.path, `${s.path}/SKILL.md`, ...Object.values(s.mounts || {}).filter((p): p is string => !!p).map(p => `${p}/SKILL.md`)]));
		return [...items.filter(i => !aliases.has(i.uri.fsPath) && !(i.source === AICustomizationSources.user && skills.some(s => i.name === s.name))),
			...skills.filter(s => !s.builtin).map(s => ({ ...item(`${s.path}/SKILL.md`, s.name, PromptsType.skill, s.description),
				groupKey: s.in_pool ? AICustomizationSources.user : 'outside-the-pool', dispatchSkill: s }))];
	}
	if (section === Section.Instructions) {
		const rules = data.rules;
		const soul = rules.dispatch.replace(/dispatch\.md$/, 'SOUL.md');
		return [...items.filter(i => i.uri.fsPath !== rules.source && i.uri.fsPath !== rules.dispatch && i.uri.fsPath !== soul),
			...(rules.exists ? [{ ...item(rules.source, 'GLOBAL.md', PromptsType.instructions, 'Your shared rules.'), id: 'dispatch:shared-rules' }] : [])];
	}
	if (section === Section.Hooks) {
		const paths = new Set(data.hooks.groups.flatMap(g => Object.values(g.agents).map(a => a.path)));
		const others = data.hooks.others.map(h => ({ ...item(h.path, `${hookWhen(h.event)} · ${h.agent}`, PromptsType.hook, h.count === 1 ? `1 command from your ${h.agent} settings. Open to see it.` : `${h.count} commands from your ${h.agent} settings. Open to see them.`), id: `dispatch:other:${h.agent}:${h.event}` }));
		return [...items.filter(i => !paths.has(i.uri.fsPath)), ...others];
	}
	if (section === Section.Agents) {
		// The engine's own agents (not files anyone can edit) go to Built-in; a sub-agent whose method is a skill of
		// the same name (designer, designer-high) says so. Dispatch's unchanged copies of its helpers are on Soul.
		const skills = new Set(data.skills.map(sk => sk.name));
		const copies = dispatchAgentCopies(data.agents);
		const origin = (i: IAICustomizationListItem) => agentOrigin(i.uri.toString(), i.description, copies);
		return items.filter(i => origin(i) !== 'dispatch').map(i => {
			const skill = [i.name, i.name.replace(/-(low|medium|high|xhigh|max)$/, '')].find(n => skills.has(n));
			if (origin(i) === 'engine') {
				return { ...i, groupKey: AICustomizationSources.builtin, description: withoutBuiltinPrefix(i.description), badge: 'Claude Code', badgeTooltip: 'Comes with Claude Code. Read-only.' };
			}
			return skill ? { ...i, badge: `skill: ${skill}`, badgeTooltip: `The method is written in the skill ${skill}` } : i;
		});
	}
	return [...items];
}

/** Engine controls remain part of the native skill row, beside its native menu. */
export function renderDispatchSkillControls(item: IAICustomizationListItem, parent: HTMLElement, store: DisposableStore, commands: ICommandService): void {
	const skill = (item as IAICustomizationListItem & { dispatchSkill?: Skill }).dispatchSkill;
	if (!skill || skill.builtin) { return; }
	const host = DOM.append(parent, $('.dispatch-skill-engines'));
	store.add(toDisposable(() => host.remove()));
	store.add(DOM.addDisposableListener(host, 'click', e => e.stopPropagation()));
	const run = async (op: string, args: unknown, button: Button) => {
		button.enabled = false;
		try {
			const answer = await commands.executeCommand<Answer<unknown>>('dispatch.customizations', op, args);
			if (!answer?.ok) { throw new Error(answer?.error || 'The skill could not be updated.'); }
			pending = undefined; changedHere = true;
			changed.fire();
		} catch (error) {
			button.setTitle(error instanceof Error ? error.message : String(error));
			button.label = 'Retry';
		} finally { button.enabled = true; }
	};
	if (!skill.in_pool) {
		const button = store.add(new Button(host, { ...defaultButtonStyles, secondary: true }));
		button.label = 'Add to pool';
		store.add(button.onDidClick(() => { void run('adopt', { name: skill.name }, button); }));
	} else {
		for (const [agent, label] of [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode']]) {
			const button = store.add(new Button(host, { ...defaultButtonStyles, secondary: true }));
			button.label = label;
			button.element.setAttribute('aria-pressed', String(!!skill.agents[agent]));
			button.element.setAttribute('aria-label', `${label}: ${skill.name}`);
			button.setTitle(`${skill.agents[agent] ? 'Disable' : 'Enable'} ${skill.name} for ${label}`);
			store.add(button.onDidClick(() => { void run('skill', { name: skill.name, agent, enabled: !skill.agents[agent] }, button); }));
		}
	}
}

type Mode = 'overview' | 'rules' | 'hooks' | 'mcp' | 'plugins' | 'agents' | 'skills';

/** The sections of the list that get Dispatch's part on top. */
export function dispatchSectionMode(section: string): Mode | undefined {
	switch (section) {
		case Section.Instructions: return 'rules';
		case Section.Hooks: return 'hooks';
		case Section.Agents: return 'agents';
		case Section.Skills: return 'skills';
	}
	return undefined;
}

/** What comes with Dispatch is on Settings › Soul (dispatchSettingsBuiltins.ts): the line on an Advanced page that goes there. */
function soulLink(parent: HTMLElement, store: DisposableStore, text: string, flash: string): HTMLElement {
	const g = guide(parent, Codicon.heart, text, 'Soul', () => goToSettingsPage('soul', flash), store);
	g.classList.add('dispatch-soul-link');
	g.dataset.soulLink = flash;
	return g;
}

/** "Dispatch's skills (9)": the number the Soul page lists, when Settings has read it. */
function counted(what: string, key: 'skills' | 'agents'): string {
	const n = settingsData.get<{ skills?: unknown[]; agents?: unknown[] }>('builtins')?.[key]?.length;
	return n ? `${what} (${n})` : what;
}

export class DispatchCustomizationSection extends Disposable {
	private readonly contents = this._register(new DisposableStore());
	private readonly agentsStore = this._register(new DisposableStore());
	private readonly host: HTMLElement;
	private disposed = false;
	private generation = 0;
	/** What the list now shows: the same inventory read again is not drawn again (an open <details> stays open). */
	private drawnKey: string | undefined;

	constructor(parent: HTMLElement, private readonly mode: Mode, private readonly commands: ICommandService,
		private readonly layout: () => void, private readonly navigate?: (section: Section | 'migrations') => void, private readonly query = '', private readonly openItem?: (item: IAICustomizationListItem) => void, private readonly contextViews?: IContextViewService) {
		super();
		this.host = DOM.append(parent, $(`.dispatch-customizations.dispatch-${mode}`));
		this._register(onDidChangeDispatchCustomizations(() => { void this.render(); }));
		if (mode === 'overview') {
			// the welcome page is made with the editor and mostly never shown (Settings shows it for Find skills): what it
			// reads (the agents on this Mac, the first-run choices, what was imported: a CLI run each) waits until it is on
			// screen, instead of running with every first ability page opened (design/settings-fast)
			this.shown = false;
			const io = new IntersectionObserver(entries => {
				if (entries.some(e => e.isIntersecting)) {
					io.disconnect();
					this.shown = true;
					void this.render();
				}
			});
			io.observe(this.host);
			this._register(toDisposable(() => io.disconnect()));
		} else {
			void this.render();
		}
	}

	/** The welcome page's part is drawn once it shows (see the constructor). */
	private shown = true;

	private button(parent: HTMLElement, label: string, action: () => Promise<unknown> | void, enabled = true): Button {
		const button = this.contents.add(new Button(parent, { ...defaultButtonStyles, secondary: true }));
		button.label = label;
		button.enabled = enabled;
		this.contents.add(button.onDidClick(() => { void action(); }));
		return button;
	}

	private async action(op: string, args: unknown, button?: Button): Promise<boolean> {
		if (button) { button.enabled = false; }
		try {
			const answer = await this.commands.executeCommand<Answer<unknown>>('dispatch.customizations', op, args);
			if (!answer?.ok) { throw new Error(answer?.error || 'The change could not be saved.'); }
			pending = undefined; changedHere = true;
			changed.fire();
			return true;
		} catch (error) {
			if (!this.disposed) {
				const status = DOM.append(this.host, $('p.dispatch-customizations-status', { role: 'alert' }));
				status.textContent = error instanceof Error ? error.message : String(error);
				this.layout();
			}
			return false;
		} finally { if (button && !this.disposed) { button.enabled = true; } }
	}

	private row(parent: HTMLElement, title: string, description: string): { row: HTMLElement; text: HTMLElement; actions: HTMLElement } {
		const row = DOM.append(parent, $('.dispatch-customization-row'));
		const text = DOM.append(row, $('.dispatch-customization-text'));
		DOM.append(text, $('div.dispatch-customization-name', {}, title));
		if (description) { DOM.append(text, $('div.dispatch-customization-description', {}, description)); }
		return { row, text, actions: DOM.append(row, $('.dispatch-customization-actions')) };
	}

	private note(parent: HTMLElement, bold: string, text: string): void {
		const note = DOM.append(parent, $('.dispatch-customizations-note'));
		DOM.append(note, $(`span${ThemeIcon.asCSSSelector(Codicon.info)}`));
		const body = DOM.append(note, $('span'));
		DOM.append(body, $('strong', {}, bold));
		body.append(` ${text}`);
	}

	private async call<T>(op: string, args?: unknown): Promise<T> {
		const answer = await this.commands.executeCommand<Answer<T>>('dispatch.customizations', op, args);
		if (!answer?.ok || answer.result === undefined) { throw new Error(answer?.error || 'Dispatch could not answer.'); }
		return answer.result;
	}

	/** MCP servers: Dispatch's own server on top (Built-in, with its switch), then every agent's servers in one list;
	 *  a pill copies a server into that agent, in its own format. */
	private async renderMcp(): Promise<void> {
		// the last answer at once (Settings reads it as it opens, design/settings-fast), then the fresh one if it differs
		const kept = this.drawnKey === undefined ? settingsData.get<McpList>('mcpFull') : undefined;
		if (kept) {
			this.drawMcp(kept);
			if (readJustNow('mcpFull')) { return; }
		}
		const data = await this.call<McpList>('mcp');
		if (this.disposed) { return; }
		settingsData.set('mcpFull', data);
		if (JSON.stringify(data) !== this.drawnKey) { this.drawMcp(data); }
	}

	private drawMcp(data: McpList): void {
		this.drawnKey = JSON.stringify(data);
		this.contents.clear();
		DOM.clearNode(this.host);
		soulLink(this.host, this.contents, 'Dispatch\'s own tools, with their switch', 'builtin-tools');
		this.note(this.host, 'Each agent keeps its own MCP config.', 'This list reads Claude Code, Codex and OpenCode. Click an agent to copy a server there, written in that agent\'s format; the file as it was is kept as a backup. Secret values are copied, never shown.');
		const byName = new Map<string, McpServer[]>();
		// Dispatch's own server is the Built-in card above, not one of yours to copy around
		for (const server of data.servers.filter(sv => sv.scope === 'user' && !sv.builtin && sv.name.toLowerCase().includes(this.query.toLowerCase()))) {
			byName.set(server.name, [...(byName.get(server.name) ?? []), server]);
		}
		this.drawMcpAdd(this.host, data);
		DOM.append(this.host, $('h3.plugin-card-section-title', {}, `All agents · ${byName.size}`));
		if (!byName.size) { DOM.append(this.host, $('p.dispatch-customizations-status', {}, 'No MCP servers in Claude Code, Codex or OpenCode yet.')); }
		for (const [name, copies] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
			const first = copies[0];
			const r = this.row(this.host, name, first.url || [first.command, ...first.args].join(' '));
			r.row.dataset.dispatchMcp = name;
			r.row.classList.add('dispatch-mcp-row');
			DOM.append(r.text.firstElementChild as HTMLElement, $('span.dispatch-customization-tag', {}, first.transport));
			const secrets = [...first.env.map(k => `env ${k}`), ...first.headers.map(k => `header ${k}`)];
			if (secrets.length) { DOM.append(r.text, $('div.dispatch-customization-description', {}, `${secrets.join(', ')} · values hidden`)); }
			const note = DOM.append(r.text, $('div.dispatch-customization-description.dispatch-mcp-note'));
			const pills = DOM.append(r.actions, $('.dispatch-skill-engines', { role: 'group', 'aria-label': `Agents using ${name}` }));
			for (const [engine, label] of ENGINES) {
				const configured = copies.some(c => c.engine === engine);
				const button = this.contents.add(new Button(pills, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
				button.label = configured ? `$(check) ${label}` : label;
				button.element.setAttribute('aria-pressed', String(configured));
				button.element.setAttribute('aria-label', `${label}: ${name}`);
				button.setTitle(configured ? `Configured in ${label}: ${copies.find(c => c.engine === engine)!.path}` : `Copy ${name} to ${label}`);
				if (configured) { button.element.classList.add('dispatch-pill-on'); continue; }
				this.contents.add(button.onDidClick(async () => {
					button.enabled = false;
					DOM.clearNode(note);
					try {
						const result = await this.call<McpChange>('mcp-copy', { name, from: first.engine, to: engine });
						const done = result.changed.find(c => c.engine === engine);
						if (!done) { throw new Error(result.skipped.find(sk => sk.engine === engine)?.reason || `${name} was not added to ${label}.`); }
						await this.renderMcp();
						const again = this.host.querySelector<HTMLElement>(`[data-dispatch-mcp="${CSS.escape(name)}"] .dispatch-mcp-note`);
						if (again) { this.added(again, name, engine, done); }
					} catch (error) {
						note.textContent = error instanceof Error ? error.message : String(error);
						button.enabled = true;
					}
					this.layout();
				}));
			}
		}
		const files = DOM.append(this.host, $('div.dispatch-customization-description.dispatch-mcp-files'));
		files.textContent = ENGINES.map(([id, label]) => `${label}: ${data.configs[id]?.path ?? ''}${data.configs[id]?.exists ? '' : ' (none yet)'}`).join(' · ');
		this.layout();
	}

	/** "Add an MCP server…": a name, the server's web address or the command that starts it, and the agents to add it to. */
	private drawMcpAdd(parent: HTMLElement, data: McpList): void {
		const views = this.contextViews;
		if (!views) { return; }
		const slot = DOM.append(parent, $('.dispatch-mcp-add'));
		const open = DOM.append(slot, $('button.dset-addrow', { type: 'button' }));
		open.dataset.mcp = 'add';
		open.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		DOM.append(open, $('span', {}, 'Add an MCP server…'));
		this.contents.add(DOM.addDisposableListener(open, DOM.EventType.CLICK, () => {
			open.remove();
			const form = this.contents.add(new DisposableStore());
			const f = DOM.append(slot, $('form.dset-keys-form', { autocomplete: 'off' }));
			f.dataset.mcp = 'add-form';
			const field = (cls: string, label: string) => {
				const w = DOM.append(f, $(`label.dset-keys-field.${cls}`));
				DOM.append(w, $('span.dset-keys-l', {}, label));
				return DOM.append(w, $('.dset-keys-in'));
			};
			const input = (host: HTMLElement, placeholder: string, label: string) => {
				const box = form.add(new InputBox(host, views, { placeholder, ariaLabel: label, inputBoxStyles: defaultInputBoxStyles }));
				box.inputElement.spellcheck = false;
				box.inputElement.autocomplete = 'off';
				return box;
			};
			const nameBox = input(field('name', 'Name'), 'playwright', 'Name');
			nameBox.inputElement.dataset.mcp = 'name';
			const targetBox = input(field('note', 'Web address or command'), 'https://example.com/mcp  or  npx -y @playwright/mcp@latest', 'Web address or command');
			targetBox.inputElement.dataset.mcp = 'target';
			const picked = new Set<string>(ENGINES.filter(([id]) => data.configs[id]?.exists).map(([id]) => id));
			if (!picked.size) { picked.add(ENGINES[0][0]); }
			const where = DOM.append(DOM.append(f, $('.dset-keys-field.value')), $('.dispatch-skill-engines', { role: 'group', 'aria-label': 'Add to' }));
			where.dataset.mcp = 'engines';
			for (const [id, label] of ENGINES) {
				const pill = form.add(new Button(where, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
				const draw = () => { pill.label = picked.has(id) ? `$(check) ${label}` : label; pill.element.setAttribute('aria-pressed', String(picked.has(id))); pill.element.classList.toggle('dispatch-pill-on', picked.has(id)); };
				draw();
				pill.element.setAttribute('aria-label', `Add to ${label}`);
				form.add(pill.onDidClick(() => { if (picked.has(id)) { picked.delete(id); } else { picked.add(id); } draw(); }));
			}
			const actions = DOM.append(f, $('.dset-keys-actions'));
			const hint = DOM.append(actions, $('span.dset-keys-hint'));
			const close = () => { form.dispose(); f.remove(); slot.appendChild(open); this.layout(); };
			const submit = async () => {
				hint.classList.remove('bad');
				hint.textContent = '';
				if (!nameBox.value.trim()) { hint.classList.add('bad'); hint.textContent = 'Give it a name, like playwright.'; nameBox.focus(); return; }
				if (!targetBox.value.trim()) { hint.classList.add('bad'); hint.textContent = 'Paste the server\'s web address or the command that starts it.'; targetBox.focus(); return; }
				if (!picked.size) { hint.classList.add('bad'); hint.textContent = 'Pick at least one agent.'; return; }
				add.enabled = false;
				hint.textContent = 'Adding…';
				const name = nameBox.value.trim();
				try {
					const result = await this.call<McpChange>('mcp-add', { name, target: targetBox.value, engines: [...picked] });
					if (!result.changed.length) { throw new Error(result.skipped[0]?.reason || `${name} was not added.`); }
					await this.renderMcp();
					const note = this.host.querySelector<HTMLElement>(`[data-dispatch-mcp="${CSS.escape(name)}"] .dispatch-mcp-note`);
					if (note) { this.addedTo(note, name, result); }
					this.layout();
				} catch (error) {
					if (!this.disposed) { hint.classList.add('bad'); hint.textContent = error instanceof Error ? error.message : String(error); add.enabled = true; }
				}
			};
			const add = form.add(new Button(actions, { ...defaultButtonStyles }));
			add.label = 'Add server';
			add.element.dataset.mcp = 'save';
			form.add(add.onDidClick(() => { void submit(); }));
			const cancel = form.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			cancel.label = 'Cancel';
			cancel.element.dataset.mcp = 'cancel';
			form.add(cancel.onDidClick(close));
			form.add(DOM.addDisposableListener(f, DOM.EventType.SUBMIT, e => { e.preventDefault(); void submit(); }));
			nameBox.focus();
			this.layout();
		}));
	}

	/** After Add: where it went, and Undo to take it out of every agent it was just added to. */
	private addedTo(note: HTMLElement, name: string, result: McpChange): void {
		DOM.clearNode(note);
		DOM.append(note, $('span', {}, `Added to ${result.changed.map(c => engineLabel(c.engine)).join(', ')}.`));
		const undo = this.button(note, 'Undo', async () => {
			undo.enabled = false;
			try {
				for (const c of result.changed) { await this.call<McpChange>('mcp-remove', { name, engine: c.engine }); }
				await this.renderMcp();
			} catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
		});
		undo.element.setAttribute('aria-label', `Undo: remove ${name} from the agents it was added to`);
	}

	private added(note: HTMLElement, name: string, engine: string, done: McpChange['changed'][number]): void {
		DOM.clearNode(note);
		DOM.append(note, $('span', {}, `Added to ${engineLabel(engine)}.${done.backup ? ` The file as it was is kept as ${done.backup}.` : ''}`));
		const undo = this.button(note, 'Undo', async () => {
			undo.enabled = false;
			try {
				await this.call<McpChange>('mcp-remove', { name, engine });
				await this.renderMcp();
			} catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
		});
		undo.element.setAttribute('aria-label', `Undo: remove ${name} from ${engineLabel(engine)}`);
	}

	/** Plugins: Claude Code's plugins as they are on disk, each with its switch. */
	private async renderPlugins(): Promise<void> {
		const kept = this.drawnKey === undefined ? settingsData.get<PluginList>('plugins') : undefined;
		if (kept) {
			this.drawPlugins(kept);
			if (readJustNow('plugins')) { return; }
		}
		const data = await this.call<PluginList>('plugins');
		if (this.disposed) { return; }
		settingsData.set('plugins', data);
		if (JSON.stringify(data) !== this.drawnKey) { this.drawPlugins(data); }
	}

	private drawPlugins(data: PluginList): void {
		this.drawnKey = JSON.stringify(data);
		this.contents.clear();
		DOM.clearNode(this.host);
		this.note(this.host, 'These are agent plugins, not VS Code extensions.', 'Extensions are in the Extensions view of the editor window. Claude Code plugins are listed as they are on disk, not only the ones a running session loaded.');
		const shown = data.plugins.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(this.query.toLowerCase()));
		DOM.append(this.host, $('h3.plugin-card-section-title', {}, `Claude Code plugins · ${data.plugins.length}`));
		DOM.append(this.host, $('p.dispatch-customization-description', {}, `From ~/.claude/plugins. ${data.plugins.filter(p => p.enabled).length} on. A plugin that is off adds nothing to a session.`));
		if (!data.plugins.length) { DOM.append(this.host, $('p.dispatch-customizations-status', {}, 'No Claude Code plugins are installed.')); }
		for (const plugin of shown) {
			const has = [plugin.skills ? `${plugin.skills} skill${plugin.skills === 1 ? '' : 's'}` : '', plugin.agents ? `${plugin.agents} agent${plugin.agents === 1 ? '' : 's'}` : '',
				plugin.commands ? `${plugin.commands} command${plugin.commands === 1 ? '' : 's'}` : '', plugin.mcp ? 'MCP server' : '', plugin.hooks ? 'hooks' : '', plugin.lsp ? 'language server' : ''].filter(Boolean).join(' · ') || 'settings only';
			const r = this.row(this.host, plugin.plugin, plugin.missing ? `${plugin.marketplace} · the installed folder is missing` : `${plugin.marketplace} · ${has}`);
			r.row.dataset.dispatchPlugin = plugin.name;
			if (plugin.version) { DOM.append(r.text.firstElementChild as HTMLElement, $('span.dispatch-customization-tag', {}, /^\d+\.\d+/.test(plugin.version) ? `v${plugin.version}` : plugin.version.slice(0, 7))); }
			if (plugin.description) { DOM.append(r.text, $('div.dispatch-customization-description', {}, plugin.description)); }
			const check = this.contents.add(new Checkbox(`Claude Code: ${plugin.plugin}`, plugin.enabled, defaultCheckboxStyles));
			const wrap = DOM.append(r.actions, $('.dispatch-hook-agent'));
			wrap.appendChild(check.domNode);
			DOM.append(wrap, $('span', {}, plugin.enabled ? 'On' : 'Off'));
			this.contents.add(check.onChange(async () => {
				check.disable();
				try {
					await this.call('plugin', { name: plugin.name, enabled: check.checked });
					await this.renderPlugins();
				} catch (error) {
					if (!this.disposed && check.domNode.isConnected) { check.checked = plugin.enabled; check.enable(); }
					DOM.append(r.text, $('div.dispatch-customization-description', { role: 'alert' }, error instanceof Error ? error.message : String(error)));
					this.layout();
				}
			}));
		}
		this.layout();
	}

	private async render(): Promise<void> {
		if (!this.shown) { return; }
		const generation = ++this.generation;
		if (this.mode === 'skills' || this.mode === 'agents') {
			// what comes with Dispatch is on Settings › Soul; the list below is the person's own
			this.contents.clear();
			DOM.clearNode(this.host);
			if (this.mode === 'skills') {
				soulLink(this.host, this.contents, counted('Dispatch\'s own skills', 'skills'), 'builtin-skills');
			} else {
				soulLink(this.host, this.contents, counted('Dispatch\'s sub-agents', 'agents'), 'builtin-agents');
				this.note(this.host, 'Yours live in one folder.', 'Dispatch keeps your sub-agents in ~/.dispatch/agents and links it from ~/.claude/agents, so Claude Code sees them. Run as a Session starts one as its own session with any agent.');
			}
			this.layout();
			return;
		}
		if (this.mode === 'mcp' || this.mode === 'plugins') {
			try {
				if (this.mode === 'mcp') {
					// one quiet second try: a read that timed out while the Mac was busy is usually fine a moment later
					await this.renderMcp().catch(async () => {
						await new Promise(resolve => setTimeout(resolve, 1500));
						if (this.disposed || generation !== this.generation) { return; }
						await this.renderMcp();
					});
				}
				else { await this.renderPlugins(); }
			} catch (error) {
				if (this.disposed || generation !== this.generation) { return; }
				DOM.clearNode(this.host);
				DOM.append(this.host, $('p', { role: 'alert' }, error instanceof Error ? error.message : String(error)));
				this.button(this.host, 'Retry', () => this.render());
				this.layout();
			}
			return;
		}
		try {
			// a new list (the page was rebuilt after a change) starts from the last inventory read, then checks it
			const cached = this.drawnKey === undefined ? lastInventory ?? settingsData.get<DispatchInventory>('inventory') : undefined;
			const data = cached ?? await loadDispatchInventory(this.commands);
			if (this.disposed || generation !== this.generation) { return; }
			const key = JSON.stringify(data);
			if (key === this.drawnKey) { return; }
			this.drawnKey = key;
			if (cached) { void this.render(); }
			this.contents.clear();
			DOM.clearNode(this.host);
			if (this.mode === 'overview') {
				void this.renderAgents(DOM.append(this.host, $('.dispatch-agents-choice')), false);
				renderFirstRunSettings(DOM.append(this.host, $('.dispatch-first-run')), this.commands, this.contents, () => this.layout());
			}
			if (this.mode === 'overview') {
				DOM.append(this.host, $('h3.plugin-card-section-title', {}, 'Installed by Dispatch'));
				soulLink(this.host, this.contents, 'Rules, session brief, hooks, tools, skills and sub-agents Dispatch gives every agent', 'soul');
				const r = this.row(this.host, 'Imported', `${data.imports.filter(i => !i.undone).length} records`);
				this.button(r.actions, 'View', () => this.navigate?.('migrations')).element.setAttribute('aria-label', 'View Imported');
			} else if (this.mode === 'rules') {
				soulLink(this.host, this.contents, 'Soul and Dispatch\'s rules (dispatch.md)', 'builtin-rules');
				DOM.append(this.host, $('h3.plugin-card-section-title', {}, 'Shared rules'));
				const r = this.row(this.host, 'GLOBAL.md', 'Your shared rules. Sync now updates only the managed block in each agent file.');
				this.button(r.actions, 'Edit', () => this.openItem?.(item(data.rules.source, 'GLOBAL.md', PromptsType.instructions, 'Your shared rules.')), data.rules.exists);
				let button: Button;
				button = this.button(r.actions, 'Sync now', () => this.action('sync', {}, button), data.rules.exists);
				const details = DOM.append(r.text, $('details.dispatch-rule-targets'));
				DOM.append(details, $('summary', {}, `${data.rules.targets.length} agent files`));
				for (const t of data.rules.targets) {
					const target = DOM.append(details, $('.dispatch-rule-target'));
					DOM.append(target, $('span', {}, `${({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode', pi: 'Pi', gemini: 'Gemini' } as Record<string, string>)[t.agent] || t.agent} · ${t.state}`));
					DOM.append(target, $('span.dispatch-customization-description', {}, t.path));
				}
			} else if (this.mode === 'hooks') {
				soulLink(this.host, this.contents, 'Dispatch\'s hook: session brief, activity, task plans, file ownership', 'builtin-hooks');
				for (const error of data.hooks.errors) { DOM.append(this.host, $('p', { role: 'alert' }, error)); }
			}
			// what Dispatch imported is one list on the Migrations page (dispatchOnboardingMigrations.ts)
			this.layout();
		} catch (error) {
			if (this.disposed || generation !== this.generation) { return; }
			this.drawnKey = undefined;
			DOM.clearNode(this.host);
			DOM.append(this.host, $('p', { role: 'alert' }, error instanceof Error ? error.message : String(error)));
			this.button(this.host, 'Retry', () => this.render());
			this.layout();
		}
	}

	/** Overview: every agent CLI found on this Mac, each with a switch for whether Dispatch uses it (`dispatch engines detect | use`). */
	private async renderAgents(parent: HTMLElement, rescan: boolean): Promise<void> {
		this.agentsStore.clear();
		DOM.clearNode(parent);
		let rows = !rescan && agentsFound && Date.now() - agentsFound.at < 30000 ? agentsFound.rows : undefined;
		if (!rows) {
			DOM.append(parent, $('h3.plugin-card-section-title', {}, 'Agents on this Mac'));
			DOM.append(parent, $('p.dispatch-customizations-status', { role: 'status' }, 'Looking for agents on this Mac...'));
			try {
				rows = await detectAgents(this.commands);
				agentsFound = { rows, at: Date.now() };
			} catch (error) {
				if (this.disposed) { return; }
				DOM.clearNode(parent);
				DOM.append(parent, $('h3.plugin-card-section-title', {}, 'Agents on this Mac'));
				DOM.append(parent, $('p', { role: 'alert' }, error instanceof Error ? error.message : String(error)));
				const retry = this.agentsStore.add(new Button(parent, { ...defaultButtonStyles, secondary: true }));
				retry.label = 'Retry';
				this.agentsStore.add(retry.onDidClick(() => { void this.renderAgents(parent, true); }));
				return;
			}
			if (this.disposed || !parent.isConnected) { return; }
			this.agentsStore.clear();
			DOM.clearNode(parent);
		}
		const all = rows;
		const used = all.filter(a => a.runnable && a.installed);
		const others = all.filter(a => !a.runnable && a.installed);
		const missing = all.filter(a => a.runnable && !a.installed);
		// like Orca's Agents settings: the agents sessions start with on top, the rest folded away
		const head = DOM.append(parent, $('.dispatch-agents-head'));
		DOM.append(head, $('h3.plugin-card-section-title', {}, 'Agents'));
		DOM.append(head, $('span.dispatch-agents-count', {}, `${all.filter(a => a.installed).length} on this Mac`));
		const scan = this.agentsStore.add(new Button(head, { ...defaultButtonStyles, secondary: true }));
		scan.label = 'Scan again';
		scan.setTitle('Look for agents on this Mac again');
		this.agentsStore.add(scan.onDidClick(() => { void this.renderAgents(parent, true); }));
		DOM.append(parent, $('div.dispatch-customization-description.dispatch-agents-lead', {}, 'New sessions start with the default. An agent that is off does not show up when you start one.'));
		const list = DOM.append(parent, $('.dispatch-agents-list'));
		for (const agent of used) {
			const r = this.agentRow(list, agent, [agent.account, agent.version].filter(Boolean)[0] ?? '');
			const on = agent.enabled;
			if (on && agent.is_default) {
				r.text.querySelector('.dispatch-customization-name')?.appendChild($('span.dispatch-customization-tag', {}, 'Default'));
			} else if (on) {
				// shown while the row is pointed at or has the keyboard, so the right-hand side is only the switch
				const set = DOM.append(r.actions, $<HTMLButtonElement>('button.dispatch-agents-set-default', { type: 'button', 'aria-label': `Set ${agent.name} as the default`, title: `New sessions start with ${agent.name}` }, 'Set default'));
				this.agentsStore.add(DOM.addDisposableListener(set, DOM.EventType.CLICK, async () => {
					set.disabled = true;
					try {
						await saveAgentChoice(this.commands, { default: agent.id });
						agentsFound = { rows: recomputeDefault(all, getDefaultAgent()), at: Date.now() };
						void this.renderAgents(parent, false);
					} catch (error) {
						set.disabled = false;
						this.agentAlert(r.text, error);
					}
				}));
			}
			this.agentSwitch(parent, r, all, agent);
		}
		if (others.length) {
			const body = this.agentGroup(list, 'others', 'Other agents on this Mac', others.length);
			if (body) {
				DOM.append(body, $('div.dispatch-customization-description.dispatch-agents-lead', {}, 'Dispatch cannot start sessions with these yet. Turning one on keeps it in your list.'));
				for (const agent of others) {
					this.agentSwitch(parent, this.agentRow(body, agent, agent.about), all, agent);
				}
			}
		}
		if (missing.length) {
			const body = this.agentGroup(list, 'missing', 'Not installed', missing.length);
			for (const agent of body ? missing : []) {
				const r = this.agentRow(body!, agent, agent.about);
				const install = this.agentsStore.add(new Button(r.actions, { ...defaultButtonStyles, secondary: true }));
				install.label = 'Install';
				install.element.setAttribute('aria-label', `Install ${agent.name}`);
				install.setTitle(`Adds ${agent.name} to this Mac so Dispatch can start sessions with it`);
				this.agentsStore.add(install.onDidClick(async () => {
					install.enabled = false;
					install.label = 'Installing...';
					try {
						await this.commands.executeCommand('dispatch.engines', 'upgrade', agent.id);
						if (!this.disposed) { void this.renderAgents(parent, true); }
					} catch (error) {
						install.enabled = true;
						install.label = 'Install';
						this.agentAlert(r.text, error, 'Could not install: ');
					}
				}));
			}
		}
		this.layout();
	}

	/** One agent: its name and one grey line, the actions at the right. */
	private agentRow(parent: HTMLElement, agent: IAgentRow, line: string): { row: HTMLElement; text: HTMLElement; actions: HTMLElement } {
		const r = this.row(parent, agent.name, line);
		r.row.classList.add('dispatch-agent-row');
		r.row.insertBefore($(`span.dispatch-agent-icon${ThemeIcon.asCSSSelector(agentIcon(agent.id))}`, { 'aria-hidden': 'true' }), r.text);
		r.row.dataset.dispatchAgent = agent.id;
		r.row.title = agent.about;
		return r;
	}

	/** A folded group of agents: its head toggles it; the body to fill while it is open. */
	private agentGroup(parent: HTMLElement, id: string, title: string, count: number): HTMLElement | undefined {
		const open = openAgentGroups.has(id);
		const head = DOM.append(parent, $('button.dispatch-agents-fold', { type: 'button', 'aria-expanded': String(open) }));
		DOM.append(head, $(`span${ThemeIcon.asCSSSelector(open ? Codicon.chevronDown : Codicon.chevronRight)}`));
		DOM.append(head, $('span.dispatch-agents-fold-title', {}, title));
		DOM.append(head, $('span.dispatch-agents-count', {}, String(count)));
		this.agentsStore.add(DOM.addDisposableListener(head, DOM.EventType.CLICK, () => {
			if (open) { openAgentGroups.delete(id); } else { openAgentGroups.add(id); }
			if (agentsFound) { agentsFound = { ...agentsFound, at: Date.now() }; }   // folding is not a reason to look again
			const section = parent.parentElement;
			if (section) { void this.renderAgents(section, false); }
		}));
		return open ? DOM.append(parent, $('.dispatch-agents-group')) : undefined;
	}

	private agentAlert(text: HTMLElement, error: unknown, prefix = ''): void {
		for (const old of text.querySelectorAll('[role=alert]')) { old.remove(); }
		DOM.append(text, $('div.dispatch-customization-description', { role: 'alert' }, prefix + (error instanceof Error ? error.message : String(error))));
		this.layout();
	}

	/** Whether Dispatch uses this agent (`dispatch engines use`); the last one it can start sessions with stays on. */
	private agentSwitch(section: HTMLElement, r: { text: HTMLElement; actions: HTMLElement }, all: readonly IAgentRow[], agent: IAgentRow): void {
		const on = agent.installed && agent.enabled;
		const check = this.agentsStore.add(new Checkbox(`Use ${agent.name} with Dispatch`, on, defaultCheckboxStyles));
		r.actions.appendChild(check.domNode);
		this.agentsStore.add(check.onChange(async () => {
			const want = check.checked;
			for (const old of r.text.querySelectorAll('[role=alert]')) { old.remove(); }
			if (!want && isLastRunnable(all, agent.id)) {
				check.checked = true;
				return this.agentAlert(r.text, new Error('Keep at least one agent on: Dispatch needs one to start a session.'));
			}
			check.disable();
			try {
				await saveAgentChoice(this.commands, choiceAfterToggle(all, agent.id, want));
				agentsFound = { rows: recomputeDefault(all.map(a => a.id === agent.id ? { ...a, enabled: want } : a), getDefaultAgent()), at: Date.now() };
				void this.renderAgents(section, false);
			} catch (error) {
				if (!this.disposed && check.domNode.isConnected) { check.enable(); check.checked = !want; this.agentAlert(r.text, error); }
			}
		}));
	}

	refresh(): void { void this.render(); }

	override dispose(): void { this.disposed = true; this.host.remove(); super.dispose(); }
}
