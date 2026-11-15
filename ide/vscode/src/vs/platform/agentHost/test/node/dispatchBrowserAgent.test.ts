/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DISPATCH_BROWSER_INSTRUCTIONS_CLAUDE, DISPATCH_BROWSER_INSTRUCTIONS_CODEX } from '../../common/dispatchBrowserInstructions.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { ClaudeAgentSession } from '../../node/claude/claudeAgentSession.js';
import { handleCanUseTool } from '../../node/claude/claudeCanUseTool.js';

suite('Dispatch: the built-in browser in Claude and Codex sessions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const session = (onAsk: () => void) => upcastPartial<ClaudeAgentSession>({
		requestPermission: async () => { onAsk(); return false; },
		respondToPermissionRequest: () => true,
		respondToUserInputRequest: () => true,
	});
	const ask = (toolName: string, onAsk: () => void) => handleCanUseTool(
		{ getSession: () => session(onAsk), configurationService: upcastPartial<IAgentConfigurationService>({}), configurationResource: URI.parse('claude:/s'), serverToolHost: undefined },
		's', toolName, { pageId: 'p1' }, { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'r1' },
	);

	test('a client tool is not asked about again (the workbench confirms it itself)', async () => {
		let asked = false;
		const result = await ask('mcp__client__clickElement', () => asked = true);
		assert.deepStrictEqual({ result, asked }, { result: { behavior: 'allow', updatedInput: { pageId: 'p1' } }, asked: false });
	});

	test('other tools still go through the permission request', async () => {
		let asked = false;
		const result = await ask('Bash', () => asked = true);
		assert.deepStrictEqual({ behavior: result.behavior, asked }, { behavior: 'deny', asked: true });
	});

	test('the instructions name the tools the way each harness sees them', () => {
		assert.ok(DISPATCH_BROWSER_INSTRUCTIONS_CLAUDE.includes('mcp__client__openBrowserPage'));
		assert.ok(DISPATCH_BROWSER_INSTRUCTIONS_CLAUDE.includes('内置浏览器'));
		assert.ok(DISPATCH_BROWSER_INSTRUCTIONS_CODEX.includes(' openBrowserPage ('));
		assert.ok(!DISPATCH_BROWSER_INSTRUCTIONS_CODEX.includes('mcp__client__'));
		assert.ok(/Claude in Chrome/.test(DISPATCH_BROWSER_INSTRUCTIONS_CODEX));
	});
});
