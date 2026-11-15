/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: scheduled jobs from other apps on the Automations page (patches/455-automations.patch).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { byMachine, IFoundJob, lastRunWords, nextRunWords, relativeWords, whenWords } from '../../browser/dispatchFoundAutomationsModel.js';

// Thursday Oct 1 2026, 20:30 local time
const NOW = new Date(2026, 9, 1, 20, 30).getTime() / 1000;
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime() / 1000;

function job(over: Partial<IFoundJob>): IFoundJob {
	return {
		id: 'local/hermes:a', source: 'hermes', source_label: 'Hermes', agent: 'hermes', agent_label: 'Hermes', name: 'Brief',
		does: '', schedule: 'Every day at 8:00 AM', enabled: true, state: 'scheduled', next_run: null, last_run: null,
		last_status: null, manage: '', run_count: 0, runs: [], host: 'local', host_name: 'This Mac', ...over,
	};
}

suite('Dispatch found automations', () => {

	test('times in words a person would say', () => {
		assert.strictEqual(whenWords(at(10, 1, 21, 5), NOW), 'today at 9:05 PM');
		assert.strictEqual(whenWords(at(10, 2, 8), NOW), 'tomorrow at 8:00 AM');
		assert.strictEqual(whenWords(at(9, 30, 8), NOW), 'yesterday at 8:00 AM');
		assert.strictEqual(whenWords(at(10, 5, 9), NOW), 'Monday at 9:00 AM');
		assert.strictEqual(whenWords(at(10, 20, 0), NOW), 'Oct 20 at 12:00 AM');
		assert.strictEqual(relativeWords(NOW + 300, NOW), 'in 5 min');
		assert.strictEqual(relativeWords(NOW - 3 * 3600, NOW), '3 h ago');
		assert.strictEqual(relativeWords(NOW - 86400, NOW), '1 day ago');
	});

	test('next run: paused, running, due, overdue', () => {
		assert.strictEqual(nextRunWords(job({ next_run: at(10, 2, 8) }), NOW), 'Next tomorrow at 8:00 AM');
		assert.strictEqual(nextRunWords(job({ enabled: false, state: 'paused', next_run: at(10, 2, 8) }), NOW), 'Paused');
		assert.strictEqual(nextRunWords(job({ state: 'running' }), NOW), 'Running now');
		assert.strictEqual(nextRunWords(job({ next_run: NOW - 7200 }), NOW), 'Was due 2 h ago');
		assert.strictEqual(nextRunWords(job({}), NOW), '');
	});

	test('last run says when and how it went', () => {
		assert.strictEqual(lastRunWords(job({ last_run: NOW - 7200, last_status: 'failed' }), NOW), 'Last ran 2 h ago · Failed');
		assert.strictEqual(lastRunWords(job({ last_run: NOW - 7200, last_status: 'ok' }), NOW), 'Last ran 2 h ago');
		assert.strictEqual(lastRunWords(job({ last_run: NOW - 60, last_status: 'running' }), NOW), 'Running now');
		assert.strictEqual(lastRunWords(job({}), NOW), 'No runs yet');
	});

	test('this Mac first, then the others with their own jobs', () => {
		const groups = byMachine({
			machines: [{ id: 'mini', name: 'Mac mini', local: false, reachable: false, error: 'unreachable', at: null }, { id: 'local', name: 'MacBook', local: true, reachable: true, error: null, at: NOW }],
			jobs: [job({ id: 'mini/hermes:x', host: 'mini' }), job({})],
		});
		assert.deepStrictEqual(groups.map(g => [g.machine.id, g.jobs.map(j => j.id)]), [['local', ['local/hermes:a']], ['mini', ['mini/hermes:x']]]);
	});
});
