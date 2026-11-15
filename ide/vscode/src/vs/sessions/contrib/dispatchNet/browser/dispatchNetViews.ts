/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the setup wizard and Settings show about the network (patches/270-network.patch).
 *
 *  Wizard (first screen, Agents): when Claude Code's or Codex's servers cannot be reached from here, a group
 *  "From this network" under the agents: one line saying so, then the Chinese model makers OpenCode can use, each
 *  with what account or key it needs and a link to the page where you get it ("Ready" when OpenCode has one already),
 *  and a button that hands OpenCode's own key prompt to a terminal. New sessions then start with OpenCode unless the
 *  person picked another default (wizardDefault). Built from the wizard's own row and well classes.
 *
 *  Settings > Network: the servers and whether they answer, the proxy (this Mac's, none, or one typed in), where
 *  downloads come from (official servers or mirrors in China), and the same list of Chinese models. Built from the
 *  Settings page's own rows, radio rows and buttons; every change goes through `dispatch net set`.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchNet.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { button, freshness, groupHead, note, pending, problem, row, rowsBlock, tag } from '../../dispatchSettings/browser/dispatchSettingsDom.js';
import { settingsData } from '../../dispatchSettings/browser/dispatchSettingsData.js';
import { blockedEngines, ENGINE_SERVER, IChinaModel, INetStatus, IOnboardingNetwork, makerList } from '../common/dispatchNetModel.js';
import { dispatchNetActions } from './dispatchNet.contribution.js';

const $ = DOM.$;
/** VS Code's own "Restart Local Agent Host" (restartAgentHostAction.ts): Claude Code, Codex and OpenCode start again with the new environment. */
const RESTART_AGENTS = 'workbench.action.chat.restartLocalAgentHost';

// ---- the setup wizard ----------------------------------------------------------------------------------

export interface IWizardParts {
	groupHead(parent: HTMLElement, label: string, count?: string | number): void;
	well(parent: HTMLElement): HTMLElement;
	button(label: string, kind: 'fill' | 'ghost' | 'plain' | 'xs', run: () => void, disabled?: boolean): HTMLElement;
}

/** The "From this network" group, or nothing when both servers answer (or nothing is known). */
export function appendWizardNetwork(body: HTMLElement, network: IOnboardingNetwork | null | undefined, openCodeInstalled: boolean, parts: IWizardParts): void {
	const blocked = blockedEngines(network?.blocked);
	if (!network || !blocked.length) {
		return;
	}
	const sentence = blocked.length === 2
		? localize('dispatchNet.wizardBoth', "Claude Code cannot reach Anthropic and Codex cannot reach OpenAI from this network.")
		: localize('dispatchNet.wizardOne', "{0} cannot reach {1} from this network.", ENGINE_SERVER[blocked[0]].engine, ENGINE_SERVER[blocked[0]].company);
	const then = network.recommend === 'opencode'
		? (openCodeInstalled
			? localize('dispatchNet.wizardThenOpenCode', "OpenCode works here with the Chinese models below, so new sessions start with OpenCode. Each needs an account and an API key from its maker.")
			: localize('dispatchNet.wizardThenInstall', "OpenCode works here with the Chinese models below: install it above, then add a key from one of them."))
		: localize('dispatchNet.wizardThenOther', "OpenCode with one of the Chinese models below works here too.");
	parts.groupHead(body, localize('dispatchNet.wizardHead', "From this network"));
	DOM.append(body, $('p.dob-note.dnet-say', { role: 'status' }, `${sentence} ${then}`));
	const well = parts.well(body);
	well.classList.add('dnet-models');
	for (const m of network.china_models) {
		const r = DOM.append(well, $('.dob-row.with-why'));
		r.dataset.maker = m.id;
		const main = DOM.append(r, $('.dob-main'));
		const line = DOM.append(main, $('.dob-line'));
		DOM.append(line, $('span.dob-n', undefined, m.name));
		DOM.append(main, $('.dob-why', undefined, m.account));
		const right = DOM.append(r, $('.dob-r'));
		if (m.ready) {
			DOM.append(right, $('span.dob-tag', undefined, localize('dispatchNet.ready', "Ready")));
		} else {
			const b = parts.button(localize('dispatchNet.getKey', "Get a key"), 'xs', () => dispatchNetActions()?.openUrl(m.key_url));
			b.title = m.key_url;
			right.appendChild(b);
		}
	}
	const foot = DOM.append(body, $('.dob-r.dnet-foot'));
	if (openCodeInstalled) {
		const add = parts.button(localize('dispatchNet.addKey', "Add a key to OpenCode"), 'xs', () => dispatchNetActions()?.addKey());
		add.title = localize('dispatchNet.addKeyTip', "Opens a terminal where OpenCode asks which maker and the key");
		foot.appendChild(add);
	}
	DOM.append(foot, $('span', undefined, localize('dispatchNet.wizardProxy', "A proxy works too: Settings > Network.")));
}

// ---- Settings > Network -------------------------------------------------------------------------------------

export interface INetworkPageHost {
	readonly commandService: ICommandService;
	readonly quickInputService: IQuickInputService;
	readonly notificationService: INotificationService;
	/** The Settings page's radio rows (one is always picked). */
	choiceRows<T extends string>(parent: HTMLElement, key: string, choices: readonly [T, string, string][], current: T, pick: (id: T) => Promise<boolean>, store: DisposableStore, tagged?: T): void;
	alive(root: HTMLElement, store: DisposableStore): boolean;
	relayout(): void;
}

type ProxyChoice = 'auto' | 'off' | 'custom';

function reachLine(s: INetStatus, key: string): string {
	const r = s.reach[key];
	if (!r) {
		return localize('dispatchNet.notAsked', "Not asked yet");
	}
	return r.ok ? localize('dispatchNet.answers', "Answers ({0} ms)", r.ms) : localize('dispatchNet.noAnswer', "Does not answer: {0}", r.why || 'no reply');
}

export function renderNetworkPage(root: HTMLElement, store: DisposableStore, host: INetworkPageHost): void {
	// the last check at once, checked again in the background (design/settings-fast): the check asks the servers
	const reading = settingsData.refresh('net', 30_000);
	const s = settingsData.get<INetStatus>('net');
	if (s) {
		draw(root, store, host, s);
		return;
	}
	const wait = pending(root, localize('dispatchNet.firstCheck', "Checking the network for the first time"));
	void reading.then(() => {
		if (host.alive(root, store) && !settingsData.get('net')) {
			wait.remove();
			problem(root, localize('dispatchNet.failed', "Dispatch could not look at the network just now."));
			button(root, localize('dispatchNet.retry', "Try again"), () => void settingsData.refresh('net', 0, 'refresh'), store);
			host.relayout();
		}
	});
}

function draw(root: HTMLElement, store: DisposableStore, host: INetworkPageHost, s: INetStatus): void {
	const again = () => void settingsData.refresh('net', 0, 'refresh');
	const saved = async (what: 'proxy' | 'mirror', value: string): Promise<boolean> => {
		const answer = await host.commandService.executeCommand<{ ok?: boolean; message?: string }>('dispatch.net', 'set', what, value).catch(e => ({ ok: false, message: String((e as Error)?.message ?? e) }));
		if (!answer || answer.ok === false) {
			host.notificationService.warn(answer?.message || localize('dispatchNet.notSaved', "Dispatch could not save that."));
			return false;
		}
		dispatchNetActions()?.changed();
		setTimeout(again, 300);
		return true;
	};

	// the servers
	const head = groupHead(root, localize('dispatchNet.servers', "Can the agents reach their servers"), Codicon.globe);
	freshness(DOM.append(head, $('span.dset-gh-r')), 'net', store, () => s.checked_at ? s.checked_at * 1000 : undefined, 'checked');
	const servers = rowsBlock(root, 'net-servers');
	for (const [key, label] of [['anthropic', localize('dispatchNet.anthropic', "Anthropic, for Claude Code")], ['openai', localize('dispatchNet.openai', "OpenAI, for Codex")], ['npm', localize('dispatchNet.npm', "npm, for installs and updates")]] as const) {
		const r = row(servers, { label, detail: reachLine(s, key) }, store);
		r.row.dataset.server = key;
		r.row.dataset.ok = String(!!s.reach[key]?.ok);
		if (s.reach[key] && !s.reach[key].ok) {
			tag(r.label, localize('dispatchNet.blocked', "Not reachable"), 'amber');
		}
	}
	const check = DOM.append(root, $('.dset-actions'));
	button(check, localize('dispatchNet.checkAgain', "Check again"), again, store);

	// the proxy
	groupHead(root, localize('dispatchNet.proxy', "Proxy"), Codicon.shield);
	const current: ProxyChoice = s.proxy.setting === 'auto' || s.proxy.setting === 'off' ? s.proxy.setting : 'custom';
	const inUse = s.proxy.address ? `${s.proxy.source_text}: ${s.proxy.address}` : s.proxy.source_text;
	const choices: [ProxyChoice, string, string][] = [
		['auto', localize('dispatchNet.proxyAuto', "Use this Mac's proxy settings"), current === 'auto' ? localize('dispatchNet.now', "Now: {0}", inUse) : localize('dispatchNet.proxyAutoDetail', "What System Settings > Network > Proxies says, an automatic configuration file included.")],
		['off', localize('dispatchNet.proxyOff', "No proxy"), localize('dispatchNet.proxyOffDetail', "The agents connect directly, even when this Mac has a proxy.")],
		['custom', localize('dispatchNet.proxyCustom', "Use this proxy…"), current === 'custom' ? s.proxy.address || s.proxy.setting : localize('dispatchNet.proxyCustomDetail', "An address such as http://127.0.0.1:7890, or a configuration file's address.")],
	];
	host.choiceRows(root, 'netProxy', choices, current, async id => {
		if (id !== 'custom') {
			return saved('proxy', id);
		}
		const value = await host.quickInputService.input({
			title: localize('dispatchNet.proxyAsk', "Proxy for the agents"),
			prompt: localize('dispatchNet.proxyPrompt', "The proxy app's address, such as http://127.0.0.1:7890 or socks5://127.0.0.1:7891, or a PAC file's address"),
			value: current === 'custom' ? s.proxy.setting : 'http://127.0.0.1:7890',
		});
		return value ? saved('proxy', value) : false;
	}, store, 'auto');
	if (s.proxy.note) {
		note(root, localize('dispatchNet.heads', "Heads up:"), s.proxy.note, Codicon.warning);
	}
	note(root, localize('dispatchNet.applies', "Agents started from now on use it."), localize('dispatchNet.appliesDetail', "The ones already running keep their old connection until they restart, which stops what they are doing."));
	const restart = DOM.append(root, $('.dset-actions'));
	button(restart, localize('dispatchNet.restart', "Restart agents now"), () => host.commandService.executeCommand(RESTART_AGENTS), store);

	// downloads
	groupHead(root, localize('dispatchNet.downloads', "Downloads"), Codicon.cloudDownload);
	const mirrorChoices: ['auto' | 'official' | 'china', string, string][] = [
		['auto', localize('dispatchNet.mirrorAuto', "Automatic"), localize('dispatchNet.mirrorAutoDetail', "The official servers; mirrors in China when they do not answer.")],
		['official', localize('dispatchNet.mirrorOfficial', "Official servers"), localize('dispatchNet.mirrorOfficialDetail', "npm, PyPI and Homebrew themselves.")],
		['china', localize('dispatchNet.mirrorChina', "Mirrors in China"), localize('dispatchNet.mirrorChinaDetail', "npmmirror and Tsinghua University's TUNA: public copies that are fast in mainland China.")],
	];
	host.choiceRows(root, 'netMirror', mirrorChoices, s.mirror.setting, id => saved('mirror', id), store, 'auto');

	// models that work from China
	appendModels(root, store, s.china_models, blockedEngines(s.blocked).length > 0);
}

function appendModels(root: HTMLElement, store: DisposableStore, models: readonly IChinaModel[], blocked: boolean): void {
	groupHead(root, localize('dispatchNet.models', "Chinese models in OpenCode"), Codicon.sparkle);
	if (blocked) {
		note(root, localize('dispatchNet.modelsWhyBold', "From this network,"), localize('dispatchNet.modelsWhy', "Claude Code or Codex cannot reach their servers. OpenCode works with {0} without a proxy.", makerList(models)));
	}
	const block = rowsBlock(root, 'net-models');
	for (const m of models) {
		const r = row(block, { label: m.name, detail: m.account }, store);
		r.row.dataset.maker = m.id;
		if (m.ready) {
			tag(r.label, localize('dispatchNet.ready', "Ready"));
			continue;
		}
		const b = button(r.ctl, localize('dispatchNet.getKey', "Get a key"), () => dispatchNetActions()?.openUrl(m.key_url), store);
		b.setTitle(m.key_url);
	}
	const line = DOM.append(root, $('.dset-actions'));
	button(line, localize('dispatchNet.addKey', "Add a key to OpenCode"), () => dispatchNetActions()?.addKey(), store);
	button(line, localize('dispatchNet.useOpenCode', "Use OpenCode"), () => dispatchNetActions()?.useOpenCode(), store);
}
