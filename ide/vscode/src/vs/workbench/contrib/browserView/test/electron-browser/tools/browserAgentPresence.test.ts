/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { IChannel } from '../../../../../../base/parts/ipc/common/ipc.js';
import { upcastPartial } from '../../../../../../base/test/common/mock.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IMainProcessService } from '../../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { BrowserAgentInterrupted, BrowserAgentPresenceService } from '../../../electron-browser/tools/browserAgentPresence.js';

/** Dispatch: what covers a page decides whether an agent's action runs, fails at once, or stops. */
suite('BrowserAgentPresenceService', () => {

	const who = { engine: 'claude' as const, name: 'Claude' };
	let presence: BrowserAgentPresenceService;

	setup(() => {
		const channel = upcastPartial<IChannel>({ call: <T>() => Promise.resolve(undefined as T), listen: () => Event.None });
		presence = new BrowserAgentPresenceService(
			upcastPartial<IMainProcessService>({ getChannel: () => channel }),
			upcastPartial<IAccessibilityService>({ isMotionReduced: () => true }),
			new NullLogService(),
		);
	});

	teardown(() => presence.dispose());

	test('an action on a page a menu covers fails at once and says why', async () => {
		presence.setCover('p1', 'menu');
		let ran = false;
		const result = await presence.run('p1', who, { label: 'Clicking' }, CancellationToken.None, async () => { ran = true; return 1; });
		assert.ok(result instanceof BrowserAgentInterrupted);
		assert.strictEqual(result.reason, 'covered');
		assert.strictEqual(ran, false);
		const tool = result.toToolResult();
		assert.match(String(tool.toolResultError), /a menu in Dispatch IDE covers it/);
	});

	test('a cover that goes away lets the next action run', async () => {
		presence.setCover('p1', 'dialog');
		presence.setCover('p1', undefined);
		const result = await presence.run('p1', who, { label: 'Reading' }, CancellationToken.None, async () => 42);
		assert.strictEqual(result, 42);
	});

	test('a page that gets covered while the agent acts stops the action instead of hanging', async () => {
		const result = presence.run('p1', who, { label: 'Clicking' }, CancellationToken.None, () => {
			presence.setCover('p1', 'quickInput');
			return new Promise<number>(() => { /* a page that no longer renders never answers */ });
		});
		const r = await result;
		assert.ok(r instanceof BrowserAgentInterrupted);
		assert.strictEqual(r.reason, 'covered');
		assert.strictEqual(r.cover, 'quickInput');
	});

	test('the first action marks the page as the agent\'s before the cover check (a notification then no longer pauses it)', async () => {
		presence.setCover('p1', 'notification');
		assert.strictEqual(presence.isAgentPage('p1'), false);
		// the renderer: on the change it recomputes the cover, and an agent page ignores notifications
		const sub = presence.onDidChange(id => {
			if (id === 'p1' && presence.isAgentPage('p1')) {
				presence.setCover('p1', undefined);
			}
		});
		const result = await presence.run('p1', who, { label: 'Opening' }, CancellationToken.None, async () => 'ok');
		sub.dispose();
		assert.strictEqual(result, 'ok');
		assert.strictEqual(presence.isAgentPage('p1'), true);
	});
});
