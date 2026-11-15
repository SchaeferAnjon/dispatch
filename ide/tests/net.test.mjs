// The network model (dispatchNetModel.ts). The connection errors are the
// same cases as kanban app/cli/test_net.py's NetworkErrors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('sessions/contrib/dispatchNet/common/dispatchNetModel.ts'));

const maker = (name, ready = false) => ({ id: name.toLowerCase(), name, models: '', providers: [], account: '', key_url: 'https://example.cn', plan_url: '', ready, ready_provider: '' });

test('connection errors of each engine are retried', () => {
	for (const text of ['API Error: Connection error.', 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
		'Unable to connect. Is the computer able to access the url?', 'read ECONNRESET', 'connect ETIMEDOUT 104.18.1.1:443', 'getaddrinfo ENOTFOUND api.anthropic.com',
		'socket hang up', 'fetch failed', 'Request timed out.', 'The socket connection was closed unexpectedly',
		'tunneling socket could not be established, cause=connect ECONNREFUSED 127.0.0.1:9']) {
		assert.ok(m.isNetworkError(text), text);
	}
});

test('other errors are not', () => {
	for (const text of ['', undefined, null, 'API Error: 401 invalid x-api-key', 'Invalid API key · Please run /login', 'API Error: 529 Overloaded', 'rate limit exceeded', 'Prompt is too long', '403 Forbidden: Request not allowed']) {
		assert.ok(!m.isNetworkError(text), String(text));
	}
});

test('the words while it waits and when it gives up', () => {
	assert.equal(m.reconnectNotice('claude:/abc', 3, 1), 'Lost the connection to Claude\'s servers. Trying again in 3 seconds (2 of 5). Your message is kept and goes out again on its own.');
	assert.ok(m.reconnectNotice('codex:/t', 60, 4).includes('OpenAI\'s servers. Trying again in 60 seconds (5 of 5)'));
	assert.ok(m.reconnectNotice('opencode:/s', 1, 1).includes('the model\'s server. Trying again in 1 second '));
	assert.ok(m.gaveUpNotice('claude:/abc', 5).startsWith('Still no connection to Claude\'s servers after 5 tries.'));
	assert.deepEqual(m.RETRY_DELAYS, [3, 10, 30, 60]);
});

test('which engines cannot reach their servers', () => {
	assert.deepEqual(m.blockedEngines({ anthropic: true, openai: false }), ['claude']);
	assert.deepEqual(m.blockedEngines({ anthropic: true, openai: true }), ['claude', 'codex']);
	assert.deepEqual(m.blockedEngines({ anthropic: null, openai: null }), []);
	assert.deepEqual(m.blockedEngines(undefined), []);
});

test('the notice names what is set up already', () => {
	const all = [maker('DeepSeek'), maker('Kimi'), maker('Qwen')];
	assert.equal(m.makerList(all), 'DeepSeek, Kimi or Qwen');
	assert.ok(m.noticeBody(all).includes('such as DeepSeek, Kimi or Qwen'));
	assert.ok(m.noticeBody([maker('DeepSeek', true), maker('Kimi')]).startsWith('OpenCode works here with DeepSeek, already set up'));
});

test('the wizard starts sessions with OpenCode only when nothing else was picked', () => {
	const net = { recommend: 'opencode', blocked: { anthropic: true, openai: true }, china_models: [], checked_at: 0 };
	assert.equal(m.wizardDefault('', net, ['claude', 'opencode']), 'opencode');
	assert.equal(m.wizardDefault('claude', net, ['claude', 'opencode']), 'claude');
	assert.equal(m.wizardDefault('', net, ['claude']), '');
	assert.equal(m.wizardDefault('', { ...net, recommend: '' }, ['opencode']), '');
	assert.equal(m.wizardDefault('', null, ['opencode']), '');
});

test('proxy variables start from what the app had', () => {
	const started = { HTTPS_PROXY: 'http://shell:1', NO_PROXY: 'corp' };
	assert.equal(m.proxyVariables(started, { set: {} }).HTTPS_PROXY, 'http://shell:1');
	const off = m.proxyVariables(started, { unset: ['HTTPS_PROXY', 'PATH'] });
	assert.equal(off.HTTPS_PROXY, undefined);
	assert.equal(off.NO_PROXY, 'corp');
	assert.ok(!('PATH' in off));
	const sys = m.proxyVariables({}, { set: { HTTPS_PROXY: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890', EVIL: 'x' } });
	assert.equal(sys.https_proxy, 'http://127.0.0.1:7890');
	assert.ok(!('EVIL' in sys));
});
test('npm\'s registry for the mirrors in China comes with the proxy, and goes when the answer stops naming it', () => {
	const mirror = 'https://registry.npmmirror.com';
	assert.equal(m.proxyVariables({}, { set: { npm_config_registry: mirror } }).npm_config_registry, mirror);
	assert.equal(m.proxyVariables({}, { set: {} }).npm_config_registry, undefined);
	// one the person had when the app started comes back
	assert.equal(m.proxyVariables({ npm_config_registry: 'https://npm.example.com' }, { set: {} }).npm_config_registry, 'https://npm.example.com');
});
