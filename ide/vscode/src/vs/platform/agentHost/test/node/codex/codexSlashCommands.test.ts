/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Codex's slash commands (codexSlashCommands.ts).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codexSlashCommandsForMenu, formatCodexStatus, parseCodexReviewTarget } from '../../../node/codex/codexSlashCommands.js';
import type { GetAccountRateLimitsResponse } from '../../../node/codex/protocol/generated/v2/GetAccountRateLimitsResponse.js';

suite('codexSlashCommands', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('/review reviews what follows it', () => {
		assert.deepStrictEqual(parseCodexReviewTarget(''), { type: 'uncommittedChanges' });
		assert.deepStrictEqual(parseCodexReviewTarget(' uncommitted '), { type: 'uncommittedChanges' });
		assert.deepStrictEqual(parseCodexReviewTarget('branch main'), { type: 'baseBranch', branch: 'main' });
		assert.deepStrictEqual(parseCodexReviewTarget('commit 3fa9c21'), { type: 'commit', sha: '3fa9c21', title: null });
		assert.deepStrictEqual(parseCodexReviewTarget('commit 3fa9c21 fix the parser'), { type: 'commit', sha: '3fa9c21', title: 'fix the parser' });
		assert.deepStrictEqual(parseCodexReviewTarget('check the error handling'), { type: 'custom', instructions: 'check the error handling' });
	});

	test('/status lists each window, what is used and when it resets', () => {
		const now = Date.UTC(2026, 8, 28, 12, 0, 0);
		const response = {
			rateLimits: {
				limitId: null, limitName: null, credits: null, individualLimit: null, spendControlReached: null, rateLimitReachedType: null, planType: 'plus',
				primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: null },
				secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.UTC(2026, 9, 2, 8, 0, 0) / 1000) },
			},
			rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
		} as unknown as GetAccountRateLimitsResponse;
		const text = formatCodexStatus(response, now);
		assert.ok(text.startsWith('**Codex usage**'), text);
		assert.ok(text.includes('- 5-hour window: 12% used'), text);
		assert.ok(/- Weekly window: 40% used, resets Oct 2 at/.test(text), text);
		assert.ok(text.includes('- Plan: plus'), text);
	});

	test('the menu offers review (for an argument), init and status', () => {
		const menu = codexSlashCommandsForMenu();
		assert.deepStrictEqual(menu.map(c => [c.name, c.runsImmediately]), [['review', false], ['init', true], ['status', true]]);
		assert.ok(menu[0].argumentHint);
	});
});
