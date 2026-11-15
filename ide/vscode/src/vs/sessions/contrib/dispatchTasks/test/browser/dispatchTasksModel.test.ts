/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a task's session found in the Agents window (dispatchTasksModel.ts sessionForTask, task-wwi8s).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { sessionForTask } from '../../browser/dispatchTasksModel.js';

suite('Dispatch task session', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const session = (resource: string) => ({ resource: URI.parse(resource) }) as unknown as ISession;
	const assistant = session('agent-host-claude:/c3bebb99-fd7d-42e2-a559-9cb2f3fd3d59');
	const codex = session('agent-host-codex:/5a1f0c2e-1111-4222-8333-944445555666');
	const management = { getSessions: () => [assistant, codex] } as unknown as ISessionsManagementService;

	test('a task that names its session by the agent\'s own id is found by the window\'s id the CLI adds', () => {
		// MCP task_begin in the Assistant's Claude Code session files Claude's own id, not the window's
		assert.strictEqual(sessionForTask(management, '6769f937-2933-44f6-88a7-8688d66eefec'), undefined);
		assert.strictEqual(sessionForTask(management, '6769f937-2933-44f6-88a7-8688d66eefec', 'c3bebb99-fd7d-42e2-a559-9cb2f3fd3d59'), assistant);
	});

	test('a task filed under the window\'s own id is found as before, with or without the window\'s id', () => {
		assert.strictEqual(sessionForTask(management, '5a1f0c2e-1111-4222-8333-944445555666'), codex);
		assert.strictEqual(sessionForTask(management, '5a1f0c2e', ''), codex);
		assert.strictEqual(sessionForTask(management, '5a1f0c2e-1111-4222-8333-944445555666', 'not-in-this-window'), codex);
	});

	test('no session id, no session', () => {
		assert.strictEqual(sessionForTask(management, '', ''), undefined);
	});
});
