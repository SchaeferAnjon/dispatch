/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Settings page, the plain functions (patches/510-settings.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { abilitySection, agentForHarness, isEmbeddedPage, matchParts, navOwner, pageForSection, pageParent, pagesOf, pageTitle, percent, searchSettings } from '../../browser/dispatchSettingsModel.js';

suite('Dispatch settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('plain words find the setting', () => {
		assert.strictEqual(searchSettings('sleep')[0].entry.page, 'awake');
		assert.strictEqual(searchSettings('dark')[0].entry.page, 'appearance');
		assert.strictEqual(searchSettings('iphone')[0].entry.page, 'phone');
		assert.strictEqual(searchSettings('mcp')[0].entry.page, 'tools');
		assert.strictEqual(searchSettings('claude.md')[0].entry.page, 'instructions');
		assert.strictEqual(searchSettings('tailscale')[0].entry.page, 'macs');
		assert.strictEqual(searchSettings('tone')[0].entry.page, 'soul');
		assert.strictEqual(searchSettings('soul')[0].entry.label, 'Soul');
		assert.strictEqual(searchSettings('rules')[0].entry.page, 'instructions');
		assert.strictEqual(searchSettings('api key')[0].entry.page, 'keys');
		assert.strictEqual(searchSettings('keys')[0].entry.page, 'keys');
		assert.strictEqual(searchSettings('secret')[0].entry.page, 'keys');
		assert.deepStrictEqual(searchSettings('   '), []);
		assert.deepStrictEqual(searchSettings('zzzz-nothing'), []);
	});

	test('MCP is found by every word people use for it, the page first (the user could not find it as External tools)', () => {
		for (const q of ['mcp', 'MCP servers', 'mcp server', 'add mcp', 'external tools', 'servers']) {
			const hits = searchSettings(q);
			assert.strictEqual(hits[0].entry.page, 'tools', q);
			assert.strictEqual(hits[0].entry.label, 'MCP servers', q);
		}
		assert.ok(pagesOf(searchSettings('mcp')).has('tools') && pagesOf(searchSettings('mcp')).has('abilities'));
	});

	test('a name beats a word people use for it', () => {
		const hits = searchSettings('skills');
		assert.strictEqual(hits[0].entry.label, 'Skills');
	});

	test('the side bar rows a search lights up', () => {
		const pages = pagesOf(searchSettings('opencode'));
		assert.ok(pages.has('agents'), 'an agent page lights up Agents');
		const ab = pagesOf(searchSettings('hook'));
		assert.ok(ab.has('hooks') && ab.has('abilities'));
	});

	test('pages, their names and the way back', () => {
		assert.strictEqual(pageTitle('awake'), 'Keep awake');
		assert.strictEqual(pageTitle('tools'), 'MCP servers');
		assert.strictEqual(pageTitle('agent:opencode'), 'OpenCode');
		assert.strictEqual(pageParent('agent:claude'), 'agents');
		assert.strictEqual(pageParent('skills'), 'abilities');
		assert.strictEqual(pageParent('phone'), 'overview');
		assert.strictEqual(pageTitle('soul'), 'Soul');
		assert.strictEqual(pageParent('soul'), 'overview');
		assert.ok(!isEmbeddedPage('soul'));
		assert.strictEqual(pageTitle('keys'), 'Keys');
		assert.strictEqual(pageParent('keys'), 'overview');
		assert.ok(!isEmbeddedPage('keys'));
		assert.strictEqual(pageParent('overview'), undefined);
		assert.strictEqual(navOwner('agent:codex'), 'agents');
		assert.ok(isEmbeddedPage('knowledge') && isEmbeddedPage('agent:claude') && isEmbeddedPage('changes'));
		assert.ok(!isEmbeddedPage('abilities') && !isEmbeddedPage('phone'));
	});

	test('the customizations editor and the Settings pages map both ways', () => {
		assert.strictEqual(abilitySection('tools'), 'mcpServers');
		assert.strictEqual(abilitySection('subagents'), 'agents');
		assert.strictEqual(pageForSection('mcpServers', undefined), 'tools');
		assert.strictEqual(pageForSection('agents', undefined), 'subagents');
		assert.strictEqual(pageForSection('harnessSettings', 'agent-host-opencode'), 'agent:opencode');
		assert.strictEqual(pageForSection('harnessSettings', 'copilotcli'), 'agents');
		assert.strictEqual(pageForSection(undefined, undefined), 'abilities');
		assert.strictEqual(agentForHarness('agent-host-codex'), 'codex');
		assert.strictEqual(agentForHarness('remote-x-claude'), undefined);
	});

	test('marks and numbers', () => {
		assert.deepStrictEqual(matchParts('Keep this Mac awake', 'mac'), ['Keep this ', 'Mac', ' awake']);
		assert.strictEqual(matchParts('Keep awake', 'sleep'), undefined);
		assert.strictEqual(percent(43.6), 44);
		assert.strictEqual(percent(140), 100);
		assert.strictEqual(percent('x'), 0);
	});
});
