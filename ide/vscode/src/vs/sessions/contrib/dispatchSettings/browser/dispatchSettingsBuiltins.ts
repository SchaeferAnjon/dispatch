/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Settings › Soul, "Built into every agent" (kanban pref "内置的放 Soul"). Under the person's Soul, one
 *  place for everything else Dispatch puts into Claude Code, Codex and OpenCode: its rules (dispatch.md), the session
 *  brief, its tools (the MCP server), its hooks, its skills and its helper agents. Each card says what it is, when it
 *  reaches an agent and whether it can be changed; read-only texts open in place, the switches that were on the
 *  Advanced pages are here now (those pages keep only what is the person's own, with a line pointing here).
 *  What is listed is `dispatch builtins` (kanban app/cli/agent_builtins.py), read with the rest of Settings and drawn
 *  from the last answer at once (design/settings-fast); a text is read from its file when it is opened.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSettingsBuiltins.css';
import * as DOM from '../../../../base/browser/dom.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { builtinAgentStatus, type BuiltinAgent } from '../../dispatchCustomizations/browser/dispatchBuiltinAgentsModel.js';
import { hookWhen, onDidChangeDispatchCustomizations } from '../../dispatchCustomizations/browser/dispatchCustomizations.js';
import { button, groupHead, guide, pending, row, rowsBlock, tag, toggle } from './dispatchSettingsDom.js';
import { settingsData } from './dispatchSettingsData.js';
import { soulPathLabel } from './dispatchSettingsSoul.js';

const $ = DOM.$;
const ASK_MS = 60_000;

interface IHookAgent { readonly enabled: boolean; readonly available: boolean; readonly supported?: boolean; readonly events: readonly string[]; readonly path: string }
interface IHookGroup { readonly id: string; readonly name: string; readonly event: string; readonly if_off: string; readonly agents: Readonly<Record<string, IHookAgent>> }
interface ITool { readonly name: string; readonly title: string; readonly description: string }
interface ISkill { readonly name: string; readonly description: string; readonly path: string }

/** What `dispatch builtins --json` answers. */
export interface IBuiltins {
	readonly soul: { readonly path: string; readonly on: boolean };
	readonly rules: { readonly path: string; readonly installed: boolean; readonly targets: readonly { readonly agent: string; readonly path: string; readonly mode: string; readonly state: string }[] };
	readonly brief: { readonly command: string; readonly agents: readonly { readonly agent: string; readonly on: boolean; readonly events: readonly string[]; readonly via: string }[] };
	readonly hooks: { readonly entry: string; readonly groups: readonly IHookGroup[]; readonly errors: readonly string[] };
	readonly tools: { readonly name: string; readonly on: boolean; readonly engines: readonly string[]; readonly about: string; readonly if_off: string; readonly instructions: string; readonly error?: string; readonly tools: readonly ITool[] };
	readonly skills: readonly ISkill[];
	readonly agents: readonly BuiltinAgent[];
}

const ENGINE: Record<string, string> = { claude: 'Claude Code', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', zcode: 'ZCode', gemini: 'Gemini' };
const engineName = (id: string) => ENGINE[id] ?? id;
const names = (ids: readonly string[]) => ids.map(engineName).join(', ');

/** Texts read once in this window: opening one again shows it at once. */
const texts = new Map<string, string>();
/** The brief made last, while the window is open. */
let lastBrief: string | undefined;
/** The cards and texts that are open, for as long as the window is (the page drawn again keeps them open). */
const opened = new Set<string>();

export interface IBuiltinsHost {
	relayout(): void;
	alive(root: HTMLElement, store: DisposableStore): boolean;
	go(page: 'abilities'): void;
}

export class DispatchBuiltinsSection {

	constructor(
		private readonly host: IBuiltinsHost,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
	) { }

	render(root: HTMLElement, store: DisposableStore): void {
		groupHead(root, localize('dispatchBuiltins.head', "Built into every agent"), Codicon.package, localize('dispatchBuiltins.headR', "Comes with Dispatch"));
		DOM.append(root, $('.dset-sub', undefined, localize('dispatchBuiltins.sub', "Dispatch adds these to Claude Code, Codex and OpenCode. Yours (your rules, skills, hooks and sub-agents) stay under Advanced.")));
		const box = DOM.append(root, $('.dset-bi'));
		const parts = new DisposableStore();
		store.add(parts);
		let drawn = '';
		const draw = () => {
			const data = settingsData.get<IBuiltins>('builtins');
			const key = JSON.stringify(data ?? null);
			if (key === drawn) {
				return;
			}
			drawn = key;
			// drawn again in place (a switch saved, a fresh read): the block keeps its height while it is rebuilt, so the
			// page does not scroll away from the row just used
			box.style.minHeight = box.childElementCount ? `${box.offsetHeight}px` : '';
			// and the switch or button that had the keyboard keeps it
			const active = DOM.getActiveElement();
			const focused = active && box.contains(active) ? active.getAttribute('aria-label') : null;
			parts.clear();
			DOM.clearNode(box);
			if (!data?.rules) {
				// the first Settings on this Mac, before the first answer
				pending(box);
				return;
			}
			this.draw(box, parts, data);
			box.style.minHeight = '';
			if (focused) {
				[...box.querySelectorAll<HTMLElement>('[aria-label]')].find(e => e.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
			}
			this.host.relayout();
		};
		draw();
		store.add(settingsData.onDidChange(keys => {
			if (keys.has('builtins') && this.host.alive(root, store)) {
				draw();
			}
		}));
		// a switch changed on an Advanced page or by a command: read again
		store.add(onDidChangeDispatchCustomizations(() => void settingsData.refresh('builtins')));
		guide(root, Codicon.tools, localize('dispatchBuiltins.yours', "Your own rules, skills, hooks and sub-agents"), localize('dispatchBuiltins.yoursGo', "Advanced"), () => this.host.go('abilities'), store);
	}

	private draw(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const synced = d.rules.targets.map(t => t.agent);
		this.rules(box, store, d, synced);
		this.brief(box, store, d);
		this.tools(box, store, d);
		this.hooks(box, store, d);
		this.skills(box, store, d);
		this.agents(box, store, d);
	}

	// ---- the parts

	private rules(box: HTMLElement, store: DisposableStore, d: IBuiltins, synced: readonly string[]): void {
		const card = this.card(box, 'builtin-rules');
		const r = this.head(card, store, {
			id: 'rules',
			label: localize('dispatchBuiltins.rules', "Dispatch's rules"),
			kind: localize('dispatchBuiltins.readOnly', "Read-only"),
			what: localize('dispatchBuiltins.rulesWhat', "How agents work with Dispatch: tasks, plans, Waiting for you, preferences."),
			when: localize('dispatchBuiltins.rulesWhen', "Every new session, from each agent's rules file. Replaced when Dispatch updates."),
		});
		const where = synced.length ? localize('dispatchBuiltins.rulesIn', "{0} · in {1}", soulPathLabel(d.rules.path), names(synced)) : soulPathLabel(d.rules.path);
		this.textOpener(r, store, 'rules', d.rules.path, where);
	}

	private brief(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const card = this.card(box, 'builtin-brief');
		const on = d.brief.agents.filter(a => a.on);
		const how = on.map(a => a.via === 'plugin'
			? localize('dispatchBuiltins.viaPlugin', "{0} through Dispatch's plugin", engineName(a.agent))
			: localize('dispatchBuiltins.viaHook', "{0} through the hook", engineName(a.agent)));
		const r = this.head(card, store, {
			id: 'brief',
			label: localize('dispatchBuiltins.brief', "Session brief"),
			kind: localize('dispatchBuiltins.fresh', "Made each time"),
			what: localize('dispatchBuiltins.briefWhat', "This project's open tasks, nearby sessions, your preferences and the last handoff."),
			when: on.length
				? localize('dispatchBuiltins.briefWhen', "At each session start and after a long conversation is shortened. Off per agent in Hooks below.")
				: localize('dispatchBuiltins.briefOff', "Off for every agent. Turn it on per agent in Hooks below."),
		});
		this.opener(r, store, 'brief', localize('dispatchBuiltins.briefLabel', "the brief of this project"), async body => {
			DOM.append(body, $('.dset-bi-src', undefined, how.length
				? localize('dispatchBuiltins.briefNow', "What a new session gets now ({0}) · dispatch prime", how.join(', '))
				: localize('dispatchBuiltins.briefNowOff', "What a new session would get · dispatch prime")));
			const pre = DOM.append(body, $('pre.dset-bi-text'));
			if (lastBrief !== undefined) {
				pre.textContent = lastBrief;
				return;
			}
			const wait = pending(body, localize('dispatchBuiltins.making', "Making the brief"));
			pre.hidden = true;
			try {
				const ans = await raceTimeout(this.commandService.executeCommand<{ ok?: boolean; result?: { text?: string }; error?: string }>('dispatch.customizations', 'brief'), ASK_MS);
				if (ans?.ok && typeof ans.result?.text === 'string') {
					lastBrief = ans.result.text;
					pre.textContent = lastBrief || localize('dispatchBuiltins.briefEmpty', "Nothing to tell a new session here yet.");
				} else {
					pre.textContent = ans?.error || localize('dispatchBuiltins.briefFailed', "The brief could not be made.");
				}
			} catch (e) {
				pre.textContent = e instanceof Error ? e.message : String(e);
			}
			wait.remove();
			pre.hidden = false;
		});
	}

	private tools(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const card = this.card(box, 'builtin-tools');
		const t = d.tools;
		const r = this.head(card, store, {
			id: 'tools',
			label: localize('dispatchBuiltins.tools', "Dispatch's tools"),
			kind: localize('dispatchBuiltins.onOff', "On / Off"),
			what: localize('dispatchBuiltins.toolsWhat', "The task board's tools (MCP), on this Mac only: tasks, plans, Waiting for you, preferences, the wiki."),
			when: localize('dispatchBuiltins.toolsWhen', "Every session lists its {0} tools; an agent calls one to note a task, a plan or a delivery.", t.tools.length),
		});
		r.row.dataset.dispatchMcp = t.name;
		const state = DOM.append(r.text, $('.dset-row-detail.dset-bi-state'));
		const where = (on: boolean, engines: readonly string[]) => on && engines.length
			? localize('dispatchBuiltins.toolsIn', "In {0}. If off: {1}", names(engines), t.if_off)
			: localize('dispatchBuiltins.toolsOff', "Off. {0}", t.if_off);
		state.textContent = t.error || where(t.on, t.engines);
		const label = localize('dispatchBuiltins.toolsSwitch', "Dispatch's tools");
		toggle(r.ctl, label, t.on, async on => {
			const ans = await this.ask<{ on: boolean; changed: { engine: string }[]; same?: string[] }>('mcp-builtin', { enabled: on });
			if (typeof ans === 'string') {
				state.textContent = ans;
				state.setAttribute('role', 'alert');
				return false;
			}
			state.removeAttribute('role');
			state.textContent = where(on, on ? [...new Set([...ans.changed.map(c => c.engine), ...(ans.same ?? [])])] : []);
			void settingsData.refresh('builtins');
			return true;
		}, store);
		this.opener(r, store, 'tools', localize('dispatchBuiltins.toolsList', "the tools"), async body => {
			DOM.append(body, $('.dset-bi-src', undefined, localize('dispatchBuiltins.toolsSrc', "What every agent is told about the server, then each tool")));
			DOM.append(body, $('.dset-bi-lead', undefined, t.instructions));
			const list = DOM.append(body, $('.dset-bi-list'));
			for (const tool of t.tools) {
				const item = DOM.append(list, $('.dset-bi-item'));
				DOM.append(item, $('.dset-bi-name', undefined, tool.name));
				DOM.append(item, $('.dset-bi-desc', undefined, tool.description));
			}
		});
	}

	private hooks(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const card = this.card(box, 'builtin-hooks');
		const r = this.head(card, store, {
			id: 'hooks',
			label: localize('dispatchBuiltins.hooks', "Hooks"),
			kind: localize('dispatchBuiltins.perAgent', "On / Off per agent"),
			what: localize('dispatchBuiltins.hooksWhat', "One command in each agent's hook settings, run at the moments below."),
			when: localize('dispatchBuiltins.hooksWhen', "What it answers (the brief, a warning about a file) is added to the session."),
		});
		this.opener(r, store, 'hooks', localize('dispatchBuiltins.hooksWhere', "where the hook is"), async body => {
			DOM.append(body, $('.dset-bi-src', { title: d.hooks.entry }, localize('dispatchBuiltins.hooksSrc', "{0} · each agent's file and the moments it runs at", soulPathLabel(d.hooks.entry))));
			const list = DOM.append(body, $('.dset-bi-list'));
			const files = new Map<string, Set<string>>();
			for (const g of d.hooks.groups) {
				for (const [agent, s] of Object.entries(g.agents)) {
					const set = files.get(`${agent}\n${s.path}`) ?? new Set<string>();
					s.events.forEach(e => set.add(e));
					files.set(`${agent}\n${s.path}`, set);
				}
			}
			for (const [k, events] of files) {
				const [agent, path] = k.split('\n');
				const item = DOM.append(list, $('.dset-bi-item'));
				DOM.append(item, $('.dset-bi-name', undefined, `${engineName(agent)} · ${soulPathLabel(path)}`));
				DOM.append(item, $('.dset-bi-desc', undefined, events.size ? [...events].sort().join(', ') : localize('dispatchBuiltins.noEvents', "Not installed for this agent")));
			}
		});
		for (const g of d.hooks.groups) {
			const f = row(card, { label: g.name, detail: hookWhen(g.event) }, store);
			f.row.dataset.dispatchHook = g.id;
			f.row.classList.add('dset-bi-sub');
			DOM.append(f.text, $('.dset-row-detail', undefined, localize('dispatchBuiltins.ifOff', "If off: {0}", g.if_off)));
			const err = DOM.append(f.text, $('.dset-row-detail.dset-bi-err', { role: 'alert' }));
			err.hidden = true;
			for (const [agent, s] of Object.entries(g.agents)) {
				const label = engineName(agent);
				const wrap = DOM.append(f.ctl, $('.dset-bi-agent'));
				const c = toggle(wrap, `${label}: ${g.name}`, s.enabled, async on => {
					const ans = await this.ask('hook', { group: g.id, agent, enabled: on });
					err.hidden = typeof ans !== 'string';
					err.textContent = typeof ans === 'string' ? ans : '';
					if (typeof ans === 'string') {
						this.host.relayout();
						return false;
					}
					void settingsData.refresh('builtins');
					return true;
				}, store);
				DOM.append(wrap, $('span', undefined, label));
				if (s.supported === false) {
					c.disable();
					wrap.classList.add('dset-bi-na');
					wrap.title = localize('dispatchBuiltins.noSuchHook', "Dispatch has no {0} hook for {1}.", g.name, label);
				} else if (!s.available) {
					wrap.title = localize('dispatchBuiltins.notInstalled', "Not installed for {0}. Turn it on to install it.", label);
				}
			}
		}
		for (const e of d.hooks.errors) {
			DOM.append(card, $('.dset-row-detail.dset-bi-err', { role: 'alert' }, e));
		}
	}

	private skills(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const card = this.card(box, 'builtin-skills');
		this.head(card, store, {
			id: 'skills',
			label: localize('dispatchBuiltins.skills', "Skills"),
			count: d.skills.length,
			kind: localize('dispatchBuiltins.readOnly2', "Read-only"),
			what: localize('dispatchBuiltins.skillsWhat', "Methods for the board, delivery pages, the built-in browser, design and teaching reviews."),
			when: localize('dispatchBuiltins.skillsWhen', "Every session lists each in one line; an agent reads a whole skill only when it uses it."),
		});
		for (const s of d.skills) {
			const r = row(card, { label: s.name, detail: s.description }, store);
			r.row.classList.add('dset-bi-sub', 'dset-row-fixed');
			r.row.dataset.builtinSkill = s.name;
			r.label.title = s.name;
			r.detail.title = s.description;
			this.textOpener(r, store, `skill:${s.name}`, s.path, soulPathLabel(s.path), s.name);
		}
	}

	private agents(box: HTMLElement, store: DisposableStore, d: IBuiltins): void {
		const card = this.card(box, 'builtin-agents');
		this.head(card, store, {
			id: 'agents',
			label: localize('dispatchBuiltins.agents', "Sub-agents"),
			count: d.agents.length,
			kind: localize('dispatchBuiltins.onOff2', "On / Off"),
			what: localize('dispatchBuiltins.agentsWhat', "Helpers an agent hands part of a task to: build, test, research, review."),
			when: localize('dispatchBuiltins.agentsWhen', "Every session lists them; one starts only when an agent hands it work. Yours of the same name are never replaced."),
		});
		for (const a of d.agents) {
			const r = row(card, { label: a.name, detail: a.description }, store);
			r.row.classList.add('dset-bi-sub');
			r.row.dataset.dispatchBuiltinAgent = a.name;
			r.detail.classList.add('dset-bi-clamp');
			r.detail.title = a.description;
			const status = DOM.append(r.text, $('.dset-row-detail.dset-bi-state', undefined, builtinAgentStatus(a)));
			toggle(r.ctl, localize('dispatchBuiltins.agentSwitch', "{0}: on or off", a.name), a.enabled, async on => {
				const ans = await this.ask('builtin-agent', { name: a.name, enabled: on });
				if (typeof ans === 'string') {
					status.textContent = ans;
					status.setAttribute('role', 'alert');
					return false;
				}
				status.removeAttribute('role');
				status.textContent = on ? localize('dispatchBuiltins.agentOn', "On. Added for every agent on this Mac.") : builtinAgentStatus({ ...a, enabled: false });
				void settingsData.refresh('builtins');
				return true;
			}, store);
			this.textOpener(r, store, `agent:${a.name}`, a.path, soulPathLabel(a.path), a.name);
		}
	}

	// ---- the pieces

	private card(box: HTMLElement, key: string): HTMLElement {
		const c = rowsBlock(box, key);
		c.classList.add('dset-bi-card');
		return c;
	}

	/** A card's first row: the name with whether it can be changed, what it is, and when an agent gets it. */
	private head(card: HTMLElement, store: DisposableStore, o: { id: string; label: string; kind: string; what: string; when: string; count?: number }) {
		const r = row(card, { label: o.label, detail: o.what }, store);
		r.row.classList.add('dset-bi-head');
		r.row.dataset.builtin = o.id;
		if (o.count !== undefined) {
			DOM.append(r.label, $('span.dset-bi-count', undefined, String(o.count)));
		}
		tag(r.label, o.kind).classList.add('dset-bi-kind');
		DOM.append(r.text, $('.dset-row-detail.dset-bi-when', undefined, o.when));
		return r;
	}

	/** Show / Hide under a row: the body is made when it is first opened. */
	private opener(r: { row: HTMLElement; ctl: HTMLElement }, store: DisposableStore, id: string, what: string, fill: (body: HTMLElement) => Promise<void>): void {
		const body = $('.dset-bi-body');
		body.id = `dset-bi-${id.replace(/[^\w-]/g, '-')}`;
		r.row.after(body);
		let filled = false;
		const b = button(r.ctl, '', () => set(!open), store);
		b.element.classList.add('dset-bi-show');
		b.element.setAttribute('aria-controls', body.id);
		let open = false;
		const set = (want: boolean) => {
			open = want;
			if (want) { opened.add(id); } else { opened.delete(id); }
			body.hidden = !want;
			b.label = want ? localize('dispatchBuiltins.hide', "Hide") : localize('dispatchBuiltins.show', "Show");
			b.element.setAttribute('aria-expanded', String(want));
			b.element.setAttribute('aria-label', (want ? localize('dispatchBuiltins.hideA', "Hide {0}", what) : localize('dispatchBuiltins.showA', "Show {0}", what)));
			if (want && !filled) {
				filled = true;
				void fill(body).then(() => this.host.relayout());
			}
			this.host.relayout();
		};
		set(opened.has(id));
	}

	/** A file shown whole, read when it is opened (once a window). */
	private textOpener(r: { row: HTMLElement; ctl: HTMLElement }, store: DisposableStore, id: string, path: string, shown: string, what = ''): void {
		this.opener(r, store, id, what || shown, async body => {
			DOM.append(body, $('.dset-bi-src', { title: path }, shown));
			const pre = DOM.append(body, $('pre.dset-bi-text'));
			pre.tabIndex = 0;
			pre.setAttribute('aria-label', localize('dispatchBuiltins.textOf', "Text of {0}", shown));
			let text = texts.get(path);
			if (text === undefined) {
				try {
					text = (await this.fileService.readFile(URI.file(path))).value.toString();
					texts.set(path, text);
				} catch (e) {
					text = localize('dispatchBuiltins.unreadable', "Not on this Mac: {0}", e instanceof Error ? e.message : String(e));
				}
			}
			pre.textContent = text;
		});
	}

	/** A change through the bridge: its answer, or the error to show. */
	private async ask<T = unknown>(op: string, args: unknown): Promise<T | string> {
		try {
			const ans = await raceTimeout(this.commandService.executeCommand<{ ok?: boolean; result?: T; error?: string }>('dispatch.customizations', op, args), ASK_MS);
			if (ans?.ok) {
				return ans.result as T;
			}
			return ans?.error || localize('dispatchBuiltins.failed', "It could not be changed. Nothing changed.");
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	}
}

