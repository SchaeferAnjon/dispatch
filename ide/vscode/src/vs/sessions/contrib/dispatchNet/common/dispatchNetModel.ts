/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the network the engines use, the plain part (patches/270-network.patch).
 *  kanban app/cli/net.py is the source: what `dispatch net status` answers, which errors mean the connection
 *  dropped (the same words as net.is_network_error), the proxy variables the agent host takes from `dispatch net env`,
 *  and the words the person reads. No services in here: the agent host, the new-session notice, the setup wizard,
 *  Settings > Network and the tests use it.
 *--------------------------------------------------------------------------------------------*/

/** A Chinese model maker OpenCode reaches without a proxy (net.CHINA_MODELS). */
export interface IChinaModel {
	readonly id: string;
	readonly name: string;
	readonly providers: readonly string[];
	/** What account or key it needs, in plain words. */
	readonly account: string;
	readonly key_url: string;
	readonly plan_url: string;
	/** OpenCode already has a key or a sign-in for one of its providers. */
	readonly ready: boolean;
	readonly ready_provider: string;
}

export interface INetReach {
	readonly ok: boolean;
	readonly why: string;
	readonly ms: number;
	readonly label: string;
}

/** `dispatch net status --json`. */
export interface INetStatus {
	readonly ok: boolean;
	readonly proxy: {
		/** auto | off | an address */
		readonly setting: string;
		readonly mode: 'auto' | 'off' | 'custom';
		readonly source: string;
		readonly source_text: string;
		readonly address: string;
		readonly socks_only: boolean;
		readonly note: string;
	};
	readonly reach: Readonly<Record<string, INetReach>>;
	readonly checked_at: number;
	readonly blocked: { readonly anthropic: boolean | null; readonly openai: boolean | null };
	/** 'opencode' when Claude Code's and Codex's servers cannot be reached from here. */
	readonly recommend: string;
	readonly mirror: { readonly setting: 'auto' | 'official' | 'china'; readonly use: 'official' | 'china'; readonly text: string };
	readonly china_models: readonly IChinaModel[];
}

/** What the setup wizard gets in `dispatch onboard status` (onboarding.network_snapshot). */
export type IOnboardingNetwork = Pick<INetStatus, 'blocked' | 'recommend' | 'china_models' | 'proxy' | 'checked_at'>;

// ---- the engines' servers -------------------------------------------------------------------------------

export type ServerEngine = 'claude' | 'codex';

export const ENGINE_SERVER: Readonly<Record<ServerEngine, { readonly engine: string; readonly company: string; readonly target: 'anthropic' | 'openai' }>> = {
	claude: { engine: 'Claude Code', company: 'Anthropic', target: 'anthropic' },
	codex: { engine: 'Codex', company: 'OpenAI', target: 'openai' },
};

/** The engines whose servers the last check could not reach. */
export function blockedEngines(blocked: INetStatus['blocked'] | undefined): ServerEngine[] {
	if (!blocked) {
		return [];
	}
	return (Object.keys(ENGINE_SERVER) as ServerEngine[]).filter(e => blocked[ENGINE_SERVER[e].target] === true);
}

/** "DeepSeek, Zhipu GLM, Kimi or Qwen (Tongyi)". */
export function makerList(models: readonly IChinaModel[], joiner = 'or'): string {
	const names = models.map(m => m.name);
	return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

/** The one line under "Claude Code cannot reach Anthropic from this network". */
export function noticeBody(models: readonly IChinaModel[]): string {
	const ready = models.filter(m => m.ready);
	const proxy = 'A proxy works too: Settings > Network.';
	if (ready.length) {
		return `OpenCode works here with ${makerList(ready, 'and')}, already set up on this Mac. ${proxy}`;
	}
	const list = makerList(models);
	return `OpenCode works here with Chinese models such as ${list}. Each needs an account and an API key from its maker. ${proxy}`;
}

/** The setup wizard's default when nothing was chosen by hand: OpenCode when the other two cannot reach their servers. */
export function wizardDefault(chosen: string, network: IOnboardingNetwork | null | undefined, installed: readonly string[]): string {
	if (chosen) {
		return chosen;
	}
	return network?.recommend === 'opencode' && installed.includes('opencode') ? 'opencode' : '';
}

// ---- reconnecting ---------------------------------------------------------------------------------------

/** Seconds before tries 2, 3, 4 and 5 (kanban chat_retry.RETRY_DELAYS). */
export const RETRY_DELAYS: readonly number[] = [3, 10, 30, 60];

/** In front of the person's words when they go out again, so the agent knows why it sees them twice. */
export const RETRY_PREFIX = '[system] The connection dropped before you finished, so Dispatch sends my last message again:\n\n';

const NET_ERRORS = new RegExp([
	'connection error', 'connection (?:was )?(?:reset|refused|closed|aborted|lost|dropped)', 'econnreset', 'econnrefused',
	'econnaborted', 'etimedout', 'enotfound', 'eai_again', 'ehostunreach', 'enetunreach', 'epipe', 'socket hang up',
	'socket connection was closed', 'other side closed', 'fetch failed', 'network ?error', 'network is unreachable',
	'stream disconnected', 'error sending request', 'error trying to connect', 'unable to connect',
	'poor internet connection', 'request timed out', 'connect(?:ion)? timed? ?out', 'timed out waiting',
	'und_err_(?:socket|connect_timeout|headers_timeout|body_timeout)', 'tls handshake', 'proxy ?error',
	'tunnel(?:ing)? (?:socket|connection) could not be established', 'failed to connect', 'dns error',
	'name or service not known', 'nodename nor servname', 'temporary failure in name resolution',
	'httpconnectionfailed', 'responsestreamdisconnected', 'responsestreamconnectionfailed',
].join('|'), 'i');
const NOT_NET = /\b(?:401|403|invalid api key|authentication|unauthori[sz]ed|permission denied|quota|insufficient|billing|overloaded|rate.?limit|context (?:length|window)|prompt is too long)\b/i;
const SURELY_NET = /connection error|econnreset|stream disconnected|socket hang up/i;

/** True when an engine's error text means the connection dropped or could not be made (net.is_network_error). */
export function isNetworkError(text: string | undefined | null): boolean {
	const t = String(text ?? '');
	if (!t || !NET_ERRORS.test(t)) {
		return false;
	}
	return !NOT_NET.test(t) || SURELY_NET.test(t);
}

/** The scheme of an agent host session (`claude:/…`) → whose servers it talks to, in words. */
export function serverOf(session: string): string {
	const scheme = /^([a-z]+):/.exec(session)?.[1];
	return scheme === 'claude' ? 'Claude\'s servers' : scheme === 'codex' ? 'OpenAI\'s servers' : 'the model\'s server';
}

function seconds(n: number): string {
	return `${n} second${n === 1 ? '' : 's'}`;
}

/** The line the conversation shows while it waits to send the message again. `tries`: how many went out so far. */
export function reconnectNotice(session: string, delay: number, tries: number): string {
	return `Lost the connection to ${serverOf(session)}. Trying again in ${seconds(delay)} (${tries + 1} of ${RETRY_DELAYS.length + 1}). Your message is kept and goes out again on its own.`;
}

export function gaveUpNotice(session: string, tries: number): string {
	return `Still no connection to ${serverOf(session)} after ${tries} tries. Your message stays in the conversation: send it again when the network is back. In mainland China, a proxy (Settings > Network) or a Chinese model in OpenCode helps.`;
}

// ---- the proxy variables ---------------------------------------------------------------------------------

/**
 * The variables `dispatch net env` manages for the engines: the proxy, and npm's registry when downloads go to the
 * mirrors in China (patches/270-network.patch, kanban net.py npm_mirror_env): OpenCode
 * installs plugins and language servers from npm itself.
 */
export const PROXY_KEYS: readonly string[] = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'npm_config_registry'];

/** `dispatch net env --json`. */
export interface INetEnv {
	readonly set?: Readonly<Record<string, string>>;
	readonly unset?: readonly string[];
}

/** The proxy variables the agent host's engines get: what the app started with, changed as `dispatch net env` says. */
export function proxyVariables(original: Readonly<Record<string, string | undefined>>, answer: INetEnv | undefined): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const k of PROXY_KEYS) {
		out[k] = original[k];
	}
	for (const k of answer?.unset ?? []) {
		if (PROXY_KEYS.includes(k)) {
			out[k] = undefined;
		}
	}
	for (const [k, v] of Object.entries(answer?.set ?? {})) {
		if (PROXY_KEYS.includes(k) && typeof v === 'string') {
			out[k] = v;
		}
	}
	return out;
}
