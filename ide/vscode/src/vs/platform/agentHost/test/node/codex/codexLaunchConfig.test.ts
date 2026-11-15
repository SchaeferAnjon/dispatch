/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { homedir } from 'os';
import { buildCodexLaunchConfig, buildCodexResumeParams, codexPermissionProfile, codexPermissionProfileOverrides, DISPATCH_CODEX_DENIED, dispatchGitGlobalTarget, dispatchGitReadPaths, pythonToolDirs } from '../../../node/codex/codexLaunchConfig.js';

/** The filesystem table of the workspace profile, as [path, access] pairs. */
function profileEntries(profile: string): [string, string][] {
	const table = /filesystem = \{ (.*) \}, network/.exec(profile)?.[1] ?? '';
	return [...table.matchAll(/"([^"]+)" = "(read|write|deny)"/g)].map(m => [m[1], m[2]] as [string, string]);
}

/** What the profile gives one path: the most specific entry wins (a project inside a denied folder stays writable,
 *  as Codex does it); with none, `:root`. */
function accessOf(profile: string, path: string): string {
	const hit = profileEntries(profile).filter(([p]) => p.startsWith('/') && (path === p || path.startsWith(p + '/'))).sort((a, b) => b[0].length - a[0].length)[0];
	return hit ? hit[1] : (profileEntries(profile).find(([p]) => p === ':root')?.[1] ?? 'read');
}

suite('CodexLaunchConfig', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the Copilot proxy and enforces telemetry overrides after extra arguments', () => {
		const config = buildCodexLaunchConfig({ PATH: '/bin', OPENAI_API_KEY: 'personal' }, { baseUrl: 'http://127.0.0.1:1234', nonce: 'nonce' }, ['--log-level=debug', '-c', 'analytics.enabled=true']);
		assert.deepStrictEqual(config.env, { PATH: '/bin', OPENAI_API_KEY: 'nonce', AI_AGENT: 'github_copilot_vscode_agent', PYTHONDONTWRITEBYTECODE: '1' });
		assert.ok(config.args.includes('model_providers.vscode-proxy.name="VS Code Proxy"'));
		assert.ok(!config.args.some(argument => argument.startsWith('model_provider=')));
		assert.ok(config.args.includes('model_providers.vscode-proxy.requires_openai_auth=false'));
		assert.ok(config.args.includes('features.image_generation=false'));
		assert.ok(config.args.includes('shell_environment_policy.set.AI_AGENT="github_copilot_vscode_agent"'));
		assert.ok(config.args.includes('--log-level=debug'));
		assert.ok(config.args.indexOf('analytics.enabled=true') < config.args.lastIndexOf('analytics.enabled=false'));
		assert.deepStrictEqual(config.args.slice(-12), [
			'-c', 'analytics.enabled=false',
			'-c', 'feedback.enabled=false',
			'-c', 'otel.log_user_prompt=false',
			'-c', 'otel.trace_exporter="none"',
			'-c', 'otel.exporter="none"',
			'-c', 'otel.metrics_exporter="none"',
		]);
	});

	test('routes traces to loopback and logs/metrics directly to the external sink', () => {
		const config = buildCodexLaunchConfig({}, { baseUrl: 'http://127.0.0.1:1234', nonce: 'nonce' }, [], {
			traces: { endpoint: 'http://127.0.0.1:4567/v1/traces', protocol: 'http/json' },
			external: { endpoint: 'http://collector:4318', protocol: 'http/protobuf', headers: { authorization: 'Bearer test' } },
			captureContent: false,
			resourceAttributes: { 'service.namespace': 'vscode.agent-host', region: 'west us' },
		});
		assert.strictEqual(config.env.OTEL_SERVICE_NAME, undefined);
		assert.strictEqual(config.env.OTEL_RESOURCE_ATTRIBUTES, 'service.namespace=vscode.agent-host,region=west%20us');
		assert.ok(config.args.includes('analytics.enabled=false'));
		assert.ok(config.args.includes('feedback.enabled=false'));
		assert.ok(config.args.includes('otel.log_user_prompt=false'));
		assert.ok(config.args.includes('otel.trace_exporter={ otlp-http = { endpoint = "http://127.0.0.1:4567/v1/traces", protocol = "json" } }'));
		assert.ok(config.args.includes('otel.exporter={ otlp-http = { endpoint = "http://collector:4318/v1/logs", protocol = "binary", headers = { "authorization" = "Bearer test" } } }'));
		assert.ok(config.args.includes('otel.metrics_exporter={ otlp-http = { endpoint = "http://collector:4318/v1/metrics", protocol = "binary", headers = { "authorization" = "Bearer test" } } }'));
	});

	test('keeps gRPC signal endpoints unchanged and uses decoded headers', () => {
		const config = buildCodexLaunchConfig({}, { baseUrl: 'http://127.0.0.1:1234', nonce: 'nonce' }, [], {
			traces: { endpoint: 'https://collector:4317', protocol: 'grpc' },
			external: { endpoint: 'https://collector:4317', protocol: 'grpc', headers: { authorization: 'Bearer test/token' } },
			captureContent: false,
			resourceAttributes: {},
		});
		const expected = '{ otlp-grpc = { endpoint = "https://collector:4317", headers = { "authorization" = "Bearer test/token" } } }';
		assert.ok(config.args.includes(`otel.exporter=${expected}`));
		assert.ok(config.args.includes(`otel.metrics_exporter=${expected}`));
	});

	test('defines workspace-scoped permission profiles after extra arguments', () => {
		const config = buildCodexLaunchConfig({}, { baseUrl: 'http://127.0.0.1:1234', nonce: 'nonce' }, ['-c', 'default_permissions=":danger-full-access"', '-c', 'sandbox_mode="danger-full-access"']);
		const expectedOverrides = codexPermissionProfileOverrides(process.platform, pythonToolDirs({}), homedir(), dispatchGitReadPaths({}, homedir()));
		assert.deepStrictEqual({
			profiles: expectedOverrides.map(override => config.args.includes(override)),
			secureDefaultWins: config.args.indexOf('default_permissions=":danger-full-access"') < config.args.indexOf('default_permissions="vscode-workspace"'),
			selection: {
				workspace: codexPermissionProfile('workspace-write', false),
				workspaceWithNetwork: codexPermissionProfile('workspace-write', true),
				readOnly: codexPermissionProfile('read-only', true),
				fullAccess: codexPermissionProfile('danger-full-access', false),
			},
		}, {
			profiles: expectedOverrides.map(() => true),
			secureDefaultWins: true,
			selection: {
				workspace: 'vscode-workspace',
				workspaceWithNetwork: 'vscode-workspace-network',
				readOnly: 'vscode-workspace-read-only',
				fullAccess: ':danger-full-access',
			},
		});
	});

	test('keeps the disk unreadable, opens the Python an agent runs and what git needs, and denies keys and private folders by name', () => {
		const tools = ['/opt/homebrew/bin', '/opt/python/3.14'];
		const git = ['/home/u/.gitconfig', '/home/u/dotfiles/gitconfig'];
		const linuxProfile = codexPermissionProfileOverrides('linux', tools, '/home/u', git)[1];
		const macProfiles = codexPermissionProfileOverrides('darwin', tools, '/home/u', git);
		const windowsProfiles = codexPermissionProfileOverrides('win32', tools, '/home/u', git);
		const dispatchPaths = '"/opt/homebrew/bin" = "read", "/opt/python/3.14" = "read", "/home/u/.gitconfig" = "read", "/home/u/dotfiles/gitconfig" = "read"';
		const denied = DISPATCH_CODEX_DENIED.map(rel => `"/home/u/${rel}" = "deny"`).join(', ');
		const features = ['features.request_permissions_tool=true', 'features.exec_permission_approvals=true'];
		assert.deepStrictEqual({
			linux: linuxProfile,
			mac: macProfiles,
			windows: windowsProfiles,
		}, {
			linux: `permissions.vscode-workspace={ extends = ":workspace", filesystem = { ":root" = "deny", ":minimal" = "read", ${dispatchPaths}, ":tmpdir" = "write", ":slash_tmp" = "read", ${denied} }, network = { enabled = false } }`,
			mac: [
				'default_permissions="vscode-workspace"',
				`permissions.vscode-workspace={ extends = ":workspace", filesystem = { ":root" = "deny", ":minimal" = "read", ${dispatchPaths}, ":tmpdir" = "write", ":slash_tmp" = "deny", ${denied} }, network = { enabled = false } }`,
				'permissions.vscode-workspace-network={ extends = "vscode-workspace", network = { enabled = true } }',
				'permissions.vscode-workspace-read-only={ extends = "vscode-workspace", filesystem = { ":workspace_roots" = { "." = "read" } } }',
				...features,
			],
			windows: [
				'default_permissions="vscode-workspace"',
				'permissions.vscode-workspace={ extends = ":workspace", network = { enabled = false } }',
				'permissions.vscode-workspace-network={ extends = "vscode-workspace", network = { enabled = true } }',
				'permissions.vscode-workspace-read-only={ extends = ":read-only" }',
				...features,
			],
		});
	});

	test('in the default profile ~/.ssh keys and Dispatch\'s secrets are denied, git\'s settings are readable', () => {
		const home = '/Users/u';
		const profile = codexPermissionProfileOverrides('darwin', [], home, [`${home}/.gitconfig`, `${home}/dotfiles/git/gitconfig`, `${home}/.config/git`])[1];
		const paths = [
			`${home}/.ssh/id_ed25519`, `${home}/.ssh/id_rsa`, `${home}/.config/dispatch/env`, `${home}/.config/dispatch/env.sh`,
			`${home}/.gnupg/private-keys-v1.d/a.key`, `${home}/.aws/credentials`, `${home}/Library/Keychains/login.keychain-db`,
			`${home}/Documents/notes.txt`, `${home}/Desktop/a.png`, `${home}/Projects/another-repo/.env`,
			`${home}/.gitconfig`, `${home}/dotfiles/git/gitconfig`, `${home}/.config/git/ignore`,
		];
		assert.deepStrictEqual(Object.fromEntries(paths.map(p => [p.slice(home.length + 1), accessOf(profile, p)])), {
			'.ssh/id_ed25519': 'deny', '.ssh/id_rsa': 'deny', '.config/dispatch/env': 'deny', '.config/dispatch/env.sh': 'deny',
			'.gnupg/private-keys-v1.d/a.key': 'deny', '.aws/credentials': 'deny', 'Library/Keychains/login.keychain-db': 'deny',
			'Documents/notes.txt': 'deny', 'Desktop/a.png': 'deny', 'Projects/another-repo/.env': 'deny',
			'.gitconfig': 'read', 'dotfiles/git/gitconfig': 'read', '.config/git/ignore': 'read',
		});
	});

	test('git\'s settings: the global file and the file it links to, the XDG folder, the system files that exist', () => {
		const present = new Set(['/h/.gitconfig', '/h/.config/git', '/opt/homebrew/etc/gitconfig']);
		const paths = dispatchGitReadPaths({}, '/h', p => present.has(p), p => p === '/h/.gitconfig' ? '/h/dotfiles/gitconfig' : p);
		assert.deepStrictEqual(paths, ['/h/.gitconfig', '/h/dotfiles/gitconfig', '/h/.config/git', '/opt/homebrew/etc/gitconfig']);
	});

	test('a linked ~/.gitconfig: git is pointed at the real file, unless GIT_CONFIG_GLOBAL already says where', () => {
		const real = (p: string) => p === '/h/.gitconfig' ? '/h/dotfiles/gitconfig' : p;
		assert.deepStrictEqual([
			dispatchGitGlobalTarget({}, '/h', () => true, real),
			dispatchGitGlobalTarget({}, '/h', () => false, real),
			dispatchGitGlobalTarget({ GIT_CONFIG_GLOBAL: '/x/cfg' }, '/h', () => true, real),
		], ['/h/dotfiles/gitconfig', undefined, undefined]);
	});

	test('lists the folders of the python3 on PATH', () => {
		const dirs = pythonToolDirs({ PATH: '/usr/bin:/bin' });
		assert.ok(dirs.includes('/usr/bin'));
		assert.ok(!dirs.includes('/'));
		assert.ok(dirs.every(dir => dir.startsWith('/')));
	});

	test('resume explicitly binds each session model and provider', () => {
		assert.deepStrictEqual(buildCodexResumeParams({ modelProvider: 'openai', modelId: 'native-model' }, 'thread-a', {}, undefined, {}, undefined, true), {
			threadId: 'thread-a',
			model: 'native-model',
			modelProvider: 'openai',
			config: { 'features.default_mode_request_user_input': true, 'features.image_generation': true },
		});
		assert.deepStrictEqual(buildCodexResumeParams({ modelProvider: 'vscode-proxy', modelId: 'copilot-model' }, 'thread-b', { GitHub: { url: 'https://api.githubcopilot.com/mcp/' } }), {
			threadId: 'thread-b',
			model: 'copilot-model',
			modelProvider: 'vscode-proxy',
			config: { 'features.default_mode_request_user_input': true, 'features.image_generation': false, mcp_servers: { GitHub: { url: 'https://api.githubcopilot.com/mcp/' } } },
		});
		assert.deepStrictEqual(buildCodexResumeParams({ modelProvider: 'openai', modelId: 'native-model' }, 'thread-c', {}, undefined, {
			agents: { Reviewer: { description: 'Reviews', config_file: '/tmp/reviewer.toml' } },
		}, 'Use the selected reviewer instructions.'), {
			threadId: 'thread-c',
			model: 'native-model',
			modelProvider: 'openai',
			config: { agents: { Reviewer: { description: 'Reviews', config_file: '/tmp/reviewer.toml' } }, 'features.default_mode_request_user_input': true, 'features.image_generation': false },
			developerInstructions: 'Use the selected reviewer instructions.',
		});
		assert.deepStrictEqual(buildCodexResumeParams({ modelProvider: 'custom-provider', modelId: 'custom-model' }, 'thread-c', {}, ['/repo-a', '/repo-b']), {
			threadId: 'thread-c',
			model: 'custom-model',
			modelProvider: 'custom-provider',
			cwd: '/repo-a',
			runtimeWorkspaceRoots: ['/repo-a', '/repo-b'],
			config: { 'features.default_mode_request_user_input': true, 'features.image_generation': false },
		});
		assert.deepStrictEqual(buildCodexResumeParams({ modelProvider: 'openai', modelId: 'native-model' }, 'thread-d', {}, ['/repo'], {}, undefined, false, {
			approvalPolicy: 'on-request',
			approvalsReviewer: 'auto_review',
			permissions: 'vscode-workspace',
		}), {
			threadId: 'thread-d',
			model: 'native-model',
			modelProvider: 'openai',
			cwd: '/repo',
			runtimeWorkspaceRoots: ['/repo'],
			approvalPolicy: 'on-request',
			approvalsReviewer: 'auto_review',
			permissions: 'vscode-workspace',
			config: { 'features.default_mode_request_user_input': true, 'features.image_generation': false },
		});
	});
});
