/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Find Skills on the Customizations overview. A search box like the overview's own
 *  input, then the results as rows of the Skills list: the skill pool (~/.dispatch/skills) first, then
 *  public skills from GitHub (the skills.sh index). The data and the install go through dispatch-bridge
 *  (`dispatch.skillsFind`, `dispatch.skillsInstall`, which asks before it installs anything).
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchFindSkills.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

const $ = DOM.$;

interface IFoundSkill {
	readonly name: string;
	readonly skill_id?: string;
	readonly description?: string;
	readonly source: 'pool' | 'local' | 'skills.sh' | 'github';
	readonly repo?: string;
	readonly installs?: number;
	readonly installed?: boolean;
	readonly mounted?: Record<string, boolean>;
	readonly url?: string;
}

interface IFindResult {
	readonly local: readonly IFoundSkill[];
	readonly online: readonly IFoundSkill[];
	readonly online_source?: string;
	readonly error?: string;
}

interface IBridgeAnswer<T> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: string;
	readonly cancelled?: boolean;
}

/** 12345 → 12.3k installs */
export function formatInstalls(n: number | undefined): string {
	if (!n) {
		return '';
	}
	const short = n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
	return localize('dispatchFindSkills.installs', "{0} installs", short);
}

export class DispatchFindSkills extends Disposable {
	private readonly rows = this._register(new DisposableStore());
	private readonly input: HTMLInputElement;
	private readonly results: HTMLElement;
	private query = '';
	private generation = 0;

	constructor(
		parent: HTMLElement,
		private readonly commandService: ICommandService,
		private readonly harness: () => string,
		private readonly openSkills: () => void,
		private readonly onDidLayout: () => void,
	) {
		super();
		const section = DOM.append(parent, $('.welcome-prompts-overview-section.dispatch-find-skills'));
		DOM.append(section, $('h3.welcome-prompts-overview-section-title')).textContent = localize('dispatchFindSkills.title', "Find Skills");
		DOM.append(section, $('p.welcome-prompts-overview-section-description')).textContent = localize('dispatchFindSkills.description', "Search your skill pool first, then public skills on GitHub.");

		const row = DOM.append(section, $('.welcome-prompts-input-row.dispatch-find-skills-input-row'));
		const icon = DOM.append(row, $('span.dispatch-find-skills-search-icon.codicon.codicon-search'));
		icon.setAttribute('aria-hidden', 'true');
		this.input = DOM.append(row, $('input.welcome-prompts-input')) as HTMLInputElement;
		this.input.type = 'text';
		this.input.placeholder = localize('dispatchFindSkills.placeholder', "Search skills, e.g. pdf, slides, code review");
		this.input.setAttribute('aria-label', localize('dispatchFindSkills.ariaLabel', "Search skills"));
		this.results = DOM.append(section, $('.dispatch-find-skills-results'));
		this.results.setAttribute('aria-live', 'polite');

		this._register(DOM.addDisposableListener(this.input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.search(this.input.value);
			} else if (e.key === 'Escape' && this.input.value) {
				e.preventDefault();
				e.stopPropagation();
				this.input.value = '';
				this.clear();
			}
		}));
		this._register(DOM.addDisposableListener(this.input, 'input', () => {
			if (!this.input.value.trim()) {
				this.clear();
			}
		}));
	}

	private clear(): void {
		this.generation++;
		this.query = '';
		this.rows.clear();
		DOM.clearNode(this.results);
		this.onDidLayout();
	}

	private status(text: string): void {
		this.rows.clear();
		DOM.clearNode(this.results);
		DOM.append(this.results, $('p.dispatch-find-skills-status')).textContent = text;
		this.onDidLayout();
	}

	async search(query: string): Promise<void> {
		const q = query.trim();
		if (!q) {
			this.clear();
			return;
		}
		this.query = q;
		const generation = ++this.generation;
		this.status(localize('dispatchFindSkills.searching', "Searching for \"{0}\"...", q));
		let answer: IBridgeAnswer<IFindResult> | undefined;
		try {
			answer = await this.commandService.executeCommand<IBridgeAnswer<IFindResult>>('dispatch.skillsFind', q);
		} catch (error) {
			answer = { ok: false, error: String(error) };
		}
		if (generation !== this.generation) {
			return;
		}
		if (!answer?.ok || !answer.result) {
			this.status(localize('dispatchFindSkills.failed', "Search failed: {0}", answer?.error ?? localize('dispatchFindSkills.noBridge', "Dispatch is not available in this window.")));
			return;
		}
		this.render(answer.result);
	}

	private render(result: IFindResult): void {
		this.rows.clear();
		DOM.clearNode(this.results);
		if (!result.local.length && !result.online.length) {
			DOM.append(this.results, $('p.dispatch-find-skills-status')).textContent = result.error
				? localize('dispatchFindSkills.nothingOffline', "No skills match \"{0}\". Public skills could not be searched: {1}", this.query, result.error)
				: localize('dispatchFindSkills.nothing', "No skills match \"{0}\".", this.query);
			this.onDidLayout();
			return;
		}
		if (result.local.length) {
			this.group(localize('dispatchFindSkills.inPool', "In your pool"), result.local);
		}
		if (result.online.length) {
			this.group(localize('dispatchFindSkills.onGitHub', "On GitHub"), result.online);
		} else if (result.error) {
			DOM.append(this.results, $('p.dispatch-find-skills-status')).textContent = localize('dispatchFindSkills.offline', "Public skills could not be searched: {0}", result.error);
		}
		this.onDidLayout();
	}

	private group(label: string, skills: readonly IFoundSkill[]): void {
		const header = DOM.append(this.results, $('.dispatch-find-skills-group'));
		DOM.append(header, $('span.dispatch-find-skills-group-label')).textContent = label;
		DOM.append(header, $('span.dispatch-find-skills-group-count')).textContent = String(skills.length);
		const list = DOM.append(this.results, $('.dispatch-find-skills-list'));
		for (const skill of skills) {
			this.row(list, skill);
		}
	}

	private row(list: HTMLElement, skill: IFoundSkill): void {
		const harness = this.harness();
		const engine = /opencode/i.test(harness) ? 'opencode' : /codex/i.test(harness) ? 'codex' : 'claude';
		const fromPool = skill.source === 'pool' || skill.source === 'local';
		const item = DOM.append(list, $('.ai-customization-list-item.dispatch-find-skills-item'));
		const left = DOM.append(item, $('.item-left'));
		const text = DOM.append(left, $('.item-text'));
		const nameRow = DOM.append(text, $('.item-name-row'));
		DOM.append(nameRow, $('span.item-name')).textContent = skill.name;
		const description = fromPool
			? (skill.description || localize('dispatchFindSkills.noDescription', "No description"))
			: [skill.repo, formatInstalls(skill.installs)].filter(Boolean).join(' · ');
		DOM.append(text, $('span.item-description')).textContent = description;
		item.title = fromPool ? skill.name : (skill.url ?? '');

		const right = DOM.append(item, $('.item-right.dispatch-find-skills-actions'));
		const mounted = !!skill.mounted?.[engine];
		if ((fromPool && mounted) || (!fromPool && skill.installed)) {
			DOM.append(right, $('span.dispatch-find-skills-state')).textContent = fromPool
				? localize('dispatchFindSkills.enabled', "Enabled")
				: localize('dispatchFindSkills.installed', "In your pool");
		} else {
			const button = this.rows.add(new Button(right, { ...defaultButtonStyles, secondary: true, title: fromPool ? localize('dispatchFindSkills.enableTitle', "Mount {0} for new sessions", skill.name) : localize('dispatchFindSkills.installTitle', "Copy {0} into your pool from {1}", skill.name, skill.repo ?? '') }));
			button.label = fromPool ? localize('dispatchFindSkills.enable', "Enable") : localize('dispatchFindSkills.install', "Install");
			this.rows.add(button.onDidClick(async () => {
				// ask first (dispatch-bridge's modal); the button only says Installing... once the person agreed
				let go = false;
				try {
					go = !!(await this.commandService.executeCommand<boolean>('dispatch.skillsConfirmInstall', skill, harness));
				} catch {
					go = false;
				}
				if (!go) {
					return;
				}
				button.enabled = false;
				button.label = fromPool ? localize('dispatchFindSkills.enabling', "Enabling...") : localize('dispatchFindSkills.installing', "Installing...");
				let answer: IBridgeAnswer<unknown> | undefined;
				try {
					answer = await this.commandService.executeCommand<IBridgeAnswer<unknown>>('dispatch.skillsInstall', skill, harness, true);
				} catch (error) {
					answer = { ok: false, error: String(error) };
				}
				if (answer?.ok) {
					void this.search(this.query);
					return;
				}
				button.enabled = true;
				button.label = fromPool ? localize('dispatchFindSkills.enable', "Enable") : localize('dispatchFindSkills.install', "Install");
				if (answer && !answer.cancelled) {
					button.element.title = answer.error ?? '';
					right.querySelector('.dispatch-find-skills-state')?.remove();
					const error = DOM.append(right, $('span.dispatch-find-skills-state'));
					error.textContent = localize('dispatchFindSkills.installFailed', "Failed");
					error.title = answer.error ?? '';
				}
			}));
		}

		this.rows.add(DOM.addDisposableListener(item, 'click', e => {
			if ((e.target as HTMLElement).closest('.monaco-button')) {
				return;
			}
			if (fromPool) {
				this.openSkills();
			} else if (skill.url) {
				void this.commandService.executeCommand('vscode.open', URI.parse(skill.url));
			}
		}));
	}
}
