/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: scheduled jobs other apps set up (patches/455-automations.patch), the data
 *  side. `dispatch automations discover --json` (kanban app/cli/automations_discover.py) reads Hermes,
 *  OpenClaw, Codex, Claude, launchd and cron, read-only, on this Mac and over ssh on the other Macs in
 *  hosts.json; dispatch-bridge's `dispatch.automations` runs it ('here', 'others', 'fresh').
 *  The words for times live here too, so they can be tested without a window.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export type FoundRunStatus = 'ok' | 'failed' | 'running' | 'skipped' | 'unknown';

export interface IFoundRun {
	/** Epoch seconds. */
	readonly at: number | null;
	readonly status: FoundRunStatus;
	readonly title?: string | null;
	readonly preview: string;
	readonly output?: string | null;
	readonly error?: string | null;
	readonly path?: string | null;
}

export interface IFoundJob {
	/** `<host>/<source>:<the tool's own id>`, unique across Macs. */
	readonly id: string;
	readonly source: string;
	readonly source_label: string;
	/** The agent it starts: claude, codex, hermes, openclaw, opencode, gemini… */
	readonly agent: string;
	readonly agent_label: string;
	readonly name: string;
	/** What it does, in one sentence. */
	readonly does: string;
	readonly prompt?: string | null;
	/** When it runs, in words ("Every day at 8:00 AM"). */
	readonly schedule: string;
	readonly enabled: boolean;
	readonly state: string;
	readonly next_run: number | null;
	readonly last_run: number | null;
	readonly last_status: FoundRunStatus | null;
	readonly last_error?: string | null;
	readonly workdir?: string | null;
	/** The file the job is defined in (on its Mac). */
	readonly where?: string | null;
	/** Who runs it and where to change it, in words. */
	readonly manage: string;
	readonly note?: string | null;
	readonly run_count: number;
	readonly runs: readonly IFoundRun[];
	readonly host: string;
	readonly host_name: string;
}

export interface IFoundMachine {
	readonly id: string;
	readonly name: string;
	readonly local: boolean;
	readonly reachable: boolean;
	readonly error: string | null;
	/** When its answer was read (epoch seconds). */
	readonly at: number | null;
}

export interface IFoundAutomations {
	readonly machines: readonly IFoundMachine[];
	readonly jobs: readonly IFoundJob[];
}

export const hermesIcon = registerIcon('dispatch-hermes', Codicon.symbolEvent, localize('dispatchHermesIcon', "Icon for Hermes."));
export const openClawIcon = registerIcon('dispatch-openclaw', Codicon.bug, localize('dispatchOpenClawIcon', "Icon for OpenClaw."));

/** Each agent with its own mark: codicon has Claude, OpenAI and Gemini; Hermes and OpenClaw are glyphs of our font. */
export function agentIcon(agent: string): ThemeIcon {
	switch (agent) {
		case 'claude': return Codicon.claude;
		case 'codex': return Codicon.openai;
		case 'gemini': return Codicon.googleGemini;
		case 'hermes': return hermesIcon;
		case 'openclaw': return openClawIcon;
		case 'opencode': return { id: 'dispatch-opencode' };
		case 'copilot': return Codicon.copilot;
		default: return Codicon.terminal;
	}
}

function clock(d: Date): string {
	const h = d.getHours(), m = d.getMinutes();
	return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function dayStart(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "today at 8:00 AM", "tomorrow at…", "Friday at…", "yesterday at…", "Oct 12 at…" (epoch seconds, local time). */
export function whenWords(at: number, now = Date.now() / 1000): string {
	const d = new Date(at * 1000);
	const days = Math.round((dayStart(d) - dayStart(new Date(now * 1000))) / 86400000);
	const t = clock(d);
	if (days === 0) {
		return localize('dispatchFound.today', "today at {0}", t);
	}
	if (days === 1) {
		return localize('dispatchFound.tomorrow', "tomorrow at {0}", t);
	}
	if (days === -1) {
		return localize('dispatchFound.yesterday', "yesterday at {0}", t);
	}
	if (days > 1 && days < 7) {
		return localize('dispatchFound.weekday', "{0} at {1}", WEEKDAYS[d.getDay()], t);
	}
	return localize('dispatchFound.date', "{0} {1} at {2}", MONTHS[d.getMonth()], d.getDate(), t);
}

/** "in 5 min", "in 3 h", "in 2 days" / "5 min ago", "3 h ago", "2 days ago". */
export function relativeWords(at: number, now = Date.now() / 1000): string {
	const s = at - now;
	const a = Math.abs(s);
	const n = a < 3600 ? Math.max(1, Math.round(a / 60)) : a < 86400 ? Math.round(a / 3600) : Math.round(a / 86400);
	const unit = a < 3600 ? localize('dispatchFound.min', "min") : a < 86400 ? localize('dispatchFound.h', "h") : n === 1 ? localize('dispatchFound.day', "day") : localize('dispatchFound.days', "days");
	return s >= 0 ? localize('dispatchFound.in', "in {0} {1}", n, unit) : localize('dispatchFound.ago', "{0} {1} ago", n, unit);
}

export function statusWords(status: FoundRunStatus | null): string {
	switch (status) {
		case 'ok': return localize('dispatchFound.ok', "Finished");
		case 'failed': return localize('dispatchFound.failed', "Failed");
		case 'running': return localize('dispatchFound.running', "Running now");
		case 'skipped': return localize('dispatchFound.skipped', "Skipped");
		default: return localize('dispatchFound.unknown', "Result unknown");
	}
}

export function statusIcon(status: FoundRunStatus | null): ThemeIcon {
	switch (status) {
		case 'ok': return Codicon.check;
		case 'failed': return Codicon.error;
		case 'running': return Codicon.loading;
		case 'skipped': return Codicon.circleSlash;
		default: return Codicon.circleSmall;
	}
}

/** The card's last line: "Last ran 2 h ago", "Last ran 2 h ago · Failed", "Running now" or "No runs yet". */
export function lastRunWords(job: IFoundJob, now = Date.now() / 1000): string {
	if (job.last_status === 'running') {
		return localize('dispatchFound.runningNow', "Running now");
	}
	if (job.last_run) {
		// a run that went fine needs no word; a failure does
		return job.last_status === 'failed'
			? localize('dispatchFound.lastRanFailed', "Last ran {0} · Failed", relativeWords(job.last_run, now))
			: localize('dispatchFound.lastRan', "Last ran {0}", relativeWords(job.last_run, now));
	}
	return localize('dispatchFound.neverRan', "No runs yet");
}

/** The card's next-run words: "Next tomorrow at 8:00 AM", "Paused", or nothing when the app keeps it to itself. */
export function nextRunWords(job: IFoundJob, now = Date.now() / 1000): string {
	if (!job.enabled) {
		return job.state === 'completed' ? localize('dispatchFound.completed', "Done, will not run again") : localize('dispatchFound.paused', "Paused");
	}
	if (job.state === 'running') {
		return localize('dispatchFound.runningNow', "Running now");
	}
	if (job.next_run) {
		return job.next_run < now - 60
			? localize('dispatchFound.overdue', "Was due {0}", relativeWords(job.next_run, now))
			: localize('dispatchFound.next', "Next {0}", whenWords(job.next_run, now));
	}
	return '';
}

/** Jobs grouped by Mac, this Mac first, in the order the CLI gave (enabled and soonest first). */
export function byMachine(data: IFoundAutomations): { machine: IFoundMachine; jobs: IFoundJob[] }[] {
	const machines = [...data.machines].sort((a, b) => Number(b.local) - Number(a.local));
	return machines.map(machine => ({ machine, jobs: data.jobs.filter(j => j.host === machine.id) }));
}
