/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'fs';
import { delimiter, dirname, join, resolve } from '../../../../base/common/path.js';
import { AiAgentEnvValue, AiAgentEnvVar } from '../../../chat/common/aiAgentEnv.js';
import type { IAgentHostNativeOTelConfig } from '../../common/otel/agentHostOTelService.js';
import type { ThreadResumeParams } from './protocol/generated/v2/ThreadResumeParams.js';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue.js';
import type { SandboxMode } from './protocol/generated/v2/SandboxMode.js';

const CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE = 'vscode-workspace';
const CODEX_VSCODE_WORKSPACE_NETWORK_PERMISSION_PROFILE = 'vscode-workspace-network';
const CODEX_VSCODE_WORKSPACE_READ_ONLY_PERMISSION_PROFILE = 'vscode-workspace-read-only';

/**
 * Dispatch: the whole disk stays unreadable as upstream has it. The Python an agent runs is opened for reading
 * (`toolDirs`: the interpreter, the links on the way to it, its standard library and packages), so a script in
 * the project runs in the sandbox. Dispatch's own records (the task board, preferences, handoffs) are not
 * written from in here: the agent uses Dispatch's MCP server, which Codex starts outside the sandbox
 * (kanban app/cli/dispatch_mcp.py).
 *
 * Dispatch IDE (codex-approved-runs): git can read its own settings (`gitReads`: ~/.gitconfig and the file it
 * links to, ~/.config/git, the system gitconfigs), or every git command stops at "unable to access
 * ~/.gitconfig". Keys, tokens and private folders are denied by name (`DISPATCH_CODEX_DENIED`): Codex never
 * lets an approval reach a denied path, so no answer to the agent can hand it ~/.ssh or Dispatch's secrets.
 * Anything else the agent needs outside the project (a push to a folder, the network, a token file) it asks
 * for with Codex's permission request, which the person grants for the turn; `require_escalated` does not
 * help here, Codex keeps such a command in the sandbox whenever the profile denies anything.
 */
export const DISPATCH_CODEX_DENIED: readonly string[] = [
	'.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.netrc', '.password-store',
	'.config/dispatch', 'Library/Keychains', 'Documents', 'Desktop',
];

export function codexPermissionProfileOverrides(platform: NodeJS.Platform = process.platform, toolDirs: readonly string[] = [], home = homedir(), gitReads: readonly string[] = []): string[] {
	// Codex materializes its Linux sandbox helper below /tmp before entering bwrap.
	// Keep it executable from inside the sandbox without granting shared temp write access.
	const slashTmpAccess = platform === 'linux' ? 'read' : 'deny';
	const fileSystemOverride = platform === 'win32'
		? ''
		: `, filesystem = { ${[
			`":root" = "deny"`,
			`":minimal" = "read"`,
			...toolDirs.map(dir => `${JSON.stringify(dir)} = "read"`),
			...gitReads.map(path => `${JSON.stringify(path)} = "read"`),
			`":tmpdir" = "write"`,
			`":slash_tmp" = "${slashTmpAccess}"`,
			...DISPATCH_CODEX_DENIED.map(rel => `${JSON.stringify(join(home, rel))} = "deny"`),
		].join(', ')} }`;
	const readOnlyProfile = platform === 'win32'
		? `permissions.${CODEX_VSCODE_WORKSPACE_READ_ONLY_PERMISSION_PROFILE}={ extends = ":read-only" }`
		: `permissions.${CODEX_VSCODE_WORKSPACE_READ_ONLY_PERMISSION_PROFILE}={ extends = "${CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE}", filesystem = { ":workspace_roots" = { "." = "read" } } }`;
	return [
		`default_permissions="${CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE}"`,
		`permissions.${CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE}={ extends = ":workspace"${fileSystemOverride}, network = { enabled = false } }`,
		`permissions.${CODEX_VSCODE_WORKSPACE_NETWORK_PERMISSION_PROFILE}={ extends = "${CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE}", network = { enabled = true } }`,
		readOnlyProfile,
		// the agent asks for what one step needs beyond the profile, and the person grants it (see above)
		'features.request_permissions_tool=true',
		'features.exec_permission_approvals=true',
	];
}

/**
 * The file ~/.gitconfig links to, when it is a link and GIT_CONFIG_GLOBAL is not set: Codex resolves the paths of
 * its profile, so the link's own name is never readable in the sandbox and git stops at "unable to access
 * ~/.gitconfig". Pointing GIT_CONFIG_GLOBAL at the real file lets git read it there.
 */
export function dispatchGitGlobalTarget(env: NodeJS.ProcessEnv = process.env, home = homedir(), isLink: (path: string) => boolean = p => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }, real: (path: string) => string = realpathSync): string | undefined {
	if (env.GIT_CONFIG_GLOBAL) {
		return undefined;
	}
	const global = join(home, '.gitconfig');
	if (!isLink(global)) {
		return undefined;
	}
	try {
		return real(global);
	} catch {
		return undefined;
	}
}

/** What git reads for its settings, where it exists: the global file (and the file it links to), the XDG one, the system ones. */
export function dispatchGitReadPaths(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists: (path: string) => boolean = existsSync, real: (path: string) => string = realpathSync): string[] {
	const out: string[] = [];
	const add = (path: string | undefined) => {
		if (!path || !exists(path)) {
			return;
		}
		out.push(path);
		try {
			const target = real(path);
			if (target !== path) {
				out.push(target);
			}
		} catch {
			// a dangling link: git cannot read it either
		}
	};
	add(env.GIT_CONFIG_GLOBAL);
	add(join(home, '.gitconfig'));
	add(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git'));
	for (const system of ['/etc/gitconfig', '/opt/homebrew/etc/gitconfig', '/usr/local/etc/gitconfig', '/Applications/Xcode.app/Contents/Developer/usr/share/git-core', '/Library/Developer/CommandLineTools/usr/share/git-core']) {
		add(system);
	}
	return [...new Set(out)];
}

export function codexPermissionProfile(mode: SandboxMode, networkAccess: boolean): string {
	if (mode === 'danger-full-access') {
		return ':danger-full-access';
	}
	if (mode === 'read-only') {
		return CODEX_VSCODE_WORKSPACE_READ_ONLY_PERMISSION_PROFILE;
	}
	return networkAccess ? CODEX_VSCODE_WORKSPACE_NETWORK_PERMISSION_PROFILE : CODEX_VSCODE_WORKSPACE_PERMISSION_PROFILE;
}

export interface ICodexLaunchProxy {
	readonly baseUrl: string;
	readonly nonce: string;
}

export interface ICodexLaunchConfig {
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
}

export const CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG_KEY = 'features.default_mode_request_user_input';

export function buildCodexResumeParams(
	model: { readonly modelProvider: string; readonly modelId: string },
	threadId: string,
	mcpServers: Readonly<Record<string, unknown>>,
	workingDirectories?: readonly string[],
	configOverrides: Readonly<Record<string, JsonValue>> = {},
	developerInstructions?: string,
	imageGenerationEnabled = false,
	permissionOverrides: Pick<ThreadResumeParams, 'approvalPolicy' | 'approvalsReviewer' | 'permissions'> = {},
): ThreadResumeParams {
	const config = {
		...configOverrides,
		[CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG_KEY]: true,
		'features.image_generation': imageGenerationEnabled,
		...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers as JsonValue } : {}),
	};
	return {
		threadId,
		model: model.modelId,
		modelProvider: model.modelProvider,
		...(workingDirectories?.length ? {
			cwd: workingDirectories[0],
			runtimeWorkspaceRoots: [...workingDirectories],
		} : {}),
		...permissionOverrides,
		...(Object.keys(config).length > 0 ? { config } : {}),
		...(developerInstructions ? { developerInstructions } : {}),
	};
}

export function buildCodexLaunchConfig(
	inheritedEnv: NodeJS.ProcessEnv,
	proxy: ICodexLaunchProxy,
	extraArgs: readonly string[],
	telemetry?: IAgentHostNativeOTelConfig,
): ICodexLaunchConfig {
	const env: NodeJS.ProcessEnv = { ...inheritedEnv, [AiAgentEnvVar]: AiAgentEnvValue, PYTHONDONTWRITEBYTECODE: '1' };
	if (telemetry) {
		delete env.OTEL_SERVICE_NAME;
		env.OTEL_RESOURCE_ATTRIBUTES = serializeResourceAttributes(telemetry.resourceAttributes);
	}
	env.OPENAI_API_KEY = proxy.nonce;
	const gitGlobal = dispatchGitGlobalTarget(inheritedEnv, inheritedEnv.HOME || homedir());
	const overrides = [
		`model_providers.vscode-proxy.name="VS Code Proxy"`,
		`model_providers.vscode-proxy.base_url="${proxy.baseUrl}/v1"`,
		`model_providers.vscode-proxy.wire_api="responses"`,
		`model_providers.vscode-proxy.env_key="OPENAI_API_KEY"`,
		`model_providers.vscode-proxy.requires_openai_auth=false`,
		`model_providers.vscode-proxy.supports_websockets=false`,
		// Codex filters its shell tool's env through `shell_environment_policy`,
		// so pin the marker there too — a user policy (e.g. `inherit = "core"`)
		// would otherwise drop it.
		`shell_environment_policy.set.${AiAgentEnvVar}="${AiAgentEnvValue}"`,
		...(gitGlobal ? [`shell_environment_policy.set.GIT_CONFIG_GLOBAL=${JSON.stringify(gitGlobal)}`] : []),
		// Python cannot write its caches beside a module it may only read
		`shell_environment_policy.set.PYTHONDONTWRITEBYTECODE="1"`,
		`features.tool_call_mcp_elicitation=false`,
		// Keep image generation disabled for the Copilot/CAPI proxy by default.
		// ChatGPT subscription threads opt in with a per-thread override.
		`features.image_generation=false`,
	];
	const permissionOverrides = codexPermissionProfileOverrides(process.platform, pythonToolDirs(inheritedEnv), inheritedEnv.HOME || homedir(), dispatchGitReadPaths(inheritedEnv, inheritedEnv.HOME || homedir()));
	const telemetryOverrides = codexTelemetryOverrides(telemetry);
	return {
		env,
		args: ['app-server', ...overrides.flatMap(value => ['-c', value]), ...extraArgs, ...permissionOverrides.flatMap(value => ['-c', value]), ...telemetryOverrides.flatMap(value => ['-c', value])],
	};
}

export function codexTelemetryOverrides(config: IAgentHostNativeOTelConfig | undefined): string[] {
	return [
		// Codex analytics are independent from its OTel exporters and post to an
		// OpenAI-owned endpoint. Keep them disabled even when the user configures
		// Agent Host OTel, whose destinations are supplied explicitly below. Codex
		// currently uses this same flag to gate its metrics exporter, so preventing
		// product analytics also suppresses its otherwise user-directed metrics.
		'analytics.enabled=false',
		// Agent Host does not expose Codex's feedback flow. Disable its Sentry
		// upload path rather than leaving an unused outbound channel available.
		'feedback.enabled=false',
		`otel.log_user_prompt=${config?.captureContent ?? false}`,
		config?.traces ? `otel.trace_exporter=${codexExporter(config.traces)}` : 'otel.trace_exporter="none"',
		config?.external ? `otel.exporter=${codexExporter({ ...config.external, endpoint: resolveSignalEndpoint(config.external.endpoint, 'logs', config.external.protocol) })}` : 'otel.exporter="none"',
		config?.external ? `otel.metrics_exporter=${codexExporter({ ...config.external, endpoint: resolveSignalEndpoint(config.external.endpoint, 'metrics', config.external.protocol) })}` : 'otel.metrics_exporter="none"',
	];
}

function codexExporter(config: { endpoint: string; protocol: 'http/json' | 'http/protobuf' | 'grpc'; headers?: Readonly<Record<string, string>> }): string {
	const headers = config.headers && Object.keys(config.headers).length > 0
		? `, headers = { ${Object.entries(config.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }`
		: '';
	if (config.protocol === 'grpc') {
		return `{ otlp-grpc = { endpoint = ${JSON.stringify(config.endpoint)}${headers} } }`;
	}
	const protocol = config.protocol === 'http/json' ? 'json' : 'binary';
	return `{ otlp-http = { endpoint = ${JSON.stringify(config.endpoint)}, protocol = ${JSON.stringify(protocol)}${headers} } }`;
}

function serializeResourceAttributes(attributes: Readonly<Record<string, string>>): string {
	return Object.entries(attributes).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(',');
}

function resolveSignalEndpoint(endpoint: string, signal: 'logs' | 'metrics', protocol: 'http/json' | 'http/protobuf' | 'grpc'): string {
	if (protocol === 'grpc') {
		return endpoint;
	}
	try {
		const url = new URL(endpoint);
		if (url.pathname === '' || url.pathname === '/') {
			url.pathname = `/v1/${signal}`;
		} else if (url.pathname.endsWith('/v1/traces')) {
			url.pathname = `${url.pathname.slice(0, -'/v1/traces'.length)}/v1/${signal}`;
		}
		return url.toString().replace(/\/$/, '');
	} catch {
		return endpoint;
	}
}

let cachedToolDirs: { key: string; dirs: readonly string[] } | undefined;

/** The folders of the python3 on PATH: the links on the way to it, the install it is part of and its packages. */
export function pythonToolDirs(env: NodeJS.ProcessEnv): readonly string[] {
	const key = env.PATH || '';
	if (cachedToolDirs?.key === key) {
		return cachedToolDirs.dirs;
	}
	const dirs = new Set<string>();
	const real = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };
	const add = (path: string | undefined) => { if (path && path !== '/' && path.startsWith('/')) { dirs.add(path); } };
	// the folder of every link on the way to the file (Homebrew's python3 is three links deep), and the file's own
	const addChain = (path: string) => {
		for (let hop = 0; hop < 16; hop++) {
			add(dirname(path));
			let link: string;
			try {
				if (!lstatSync(path).isSymbolicLink()) { break; }
				link = readlinkSync(path);
			} catch { break; }
			path = resolve(dirname(path), link);
		}
		const target = real(path);
		add(target && dirname(target));
	};
	const python = (env.PATH || '').split(delimiter).map(dir => join(dir, 'python3')).find(path => existsSync(path));
	if (python) {
		addChain(python);
		try {
			// sys.base_prefix holds the standard library, purelib the packages it imports
			const out = execFileSync(python, ['-c', 'import sys, sysconfig; print(sys.base_prefix); print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8', timeout: 5000, env: { PATH: env.PATH } });
			for (const line of out.split('\n').map(l => l.trim()).filter(Boolean)) {
				add(line);
				add(real(line));
			}
		} catch {
			// no Python there: a script fails the same way outside the sandbox
		}
	}
	cachedToolDirs = { key, dirs: [...dirs] };
	return cachedToolDirs.dirs;
}
