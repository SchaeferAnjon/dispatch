/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the sub-agent strip above the message box shows, worked out without the window (direction A,
 *  the person picked it 2026-11-12, task-1rzdr; kanban design/subagent-strip). dispatchSubagentStrip.ts draws it,
 *  the Now tab (contrib/dispatchNow) takes the step a conversation is on from here too; ide/tests/subagent-strip.test.mjs
 *  tests it. No imports but types: Node runs this file as it is.
 *--------------------------------------------------------------------------------------------*/

import type { SubAgentRowState } from '../../../browser/dispatchSubAgentRows.js';

/** One sub-agent as the strip needs it, read from its chat by the window. */
export interface IStripAgentInput {
	/** Its chat (the resource as a string). */
	readonly id: string;
	/** What it was sent to do: its chat's title. */
	readonly name: string;
	readonly state: SubAgentRowState;
	/** When it started (first seen working). */
	readonly startedAt: number;
	/** How long it has run, or ran. */
	readonly elapsedMs: number;
	/** What it is running this moment; empty when the window does not know. */
	readonly step?: string;
	/** When it started on that step. */
	readonly stepSince?: number;
}

export interface IStripRow extends IStripAgentInput {
	/**
	 * How long it has run ("15m 9s"). No tokens and no Stop: none of the three engines gives a sub-agent's own token
	 * count or a way to stop it alone today (task-1rzdr, the Agent Host adapters read 2026-11-12), and the strip shows
	 * neither a made-up number nor a button that does nothing.
	 */
	readonly meta: string;
	/** The second line: the step it is on, or "Stopped after 2m 4s"; empty for one back. */
	readonly second: string;
	/** How long it has been on that step ("19s"), only while it works. */
	readonly stepTime: string;
}

export interface IStrip {
	/** Shown only while one of the session's sub-agents works. */
	readonly visible: boolean;
	/** "2 agents working". */
	readonly head: string;
	/** Folded, after the head: "Count to 1500 A: Read notes.md". */
	readonly line: string;
	/** The ones working, then the ones stopped, oldest first. */
	readonly rows: readonly IStripRow[];
	/** The ones back in this round, newest first: folded into "N finished". */
	readonly finished: readonly IStripRow[];
}

/** "9s", "15m 9s", "1h 5m": seconds while under an hour, so the clock is seen to move. */
export function clockLabel(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	if (m < 60) {
		return `${m}m ${s % 60}s`;
	}
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The sub-agents of the round the session is on (started at or after `roundStart`, all of them when it is not
 * known), as the strip shows them at `now`.
 */
export function stripOf(agents: readonly IStripAgentInput[], roundStart: number | undefined, now: number): IStrip {
	const round = agents.filter(a => roundStart === undefined || a.startedAt >= roundStart - 1000);
	const row = (a: IStripAgentInput): IStripRow => {
		const meta = clockLabel(a.elapsedMs);
		const second = a.state === 'sub-agent' ? (a.step || '') : a.state === 'stopped' ? `Stopped after ${meta}` : '';
		const stepTime = a.state === 'sub-agent' && a.step && a.stepSince !== undefined ? clockLabel(now - a.stepSince) : '';
		return { ...a, meta, second, stepTime };
	};
	const byStart = (x: IStripAgentInput, y: IStripAgentInput) => x.startedAt - y.startedAt;
	const working = round.filter(a => a.state === 'sub-agent').sort(byStart);
	const stopped = round.filter(a => a.state === 'stopped').sort(byStart);
	const back = round.filter(a => a.state === 'done').sort((x, y) => y.startedAt - x.startedAt);
	const first = working[0];
	return {
		visible: working.length > 0,
		head: working.length === 1 ? '1 agent working' : `${working.length} agents working`,
		line: first ? (first.step ? `${first.name}: ${first.step}` : first.name) : '',
		rows: [...working, ...stopped].map(row),
		finished: back.map(row),
	};
}

/** "1 finished", "3 finished". */
export function finishedLabel(n: number): string {
	return `${n} finished`;
}

/**
 * When it started on the step it is on: kept while the step stays the same, `now` for a new one.
 */
export function stepSince(seen: { readonly step: string; readonly since: number } | undefined, step: string, now: number): number {
	return seen && seen.step === step ? seen.since : now;
}

/** A part of a conversation's reply, as much of it as tells the step it is on. */
export interface IReplyPart {
	/** A tool call (not words). */
	readonly tool: boolean;
	/** The call has not finished. */
	readonly running: boolean;
	/** The conversation does not show it. */
	readonly hidden: boolean;
	/** The call's id. */
	readonly id?: string;
	/** For a call a sub-agent made: the id of the call that started that sub-agent. */
	readonly parent?: string;
	/** For a call that starts a sub-agent: what it was sent to do (empty when the engine does not say) and its chat. */
	readonly subagent?: { readonly description?: string; readonly chat?: string };
	/** The call's own words ("Reading notes.md"), as plain text. */
	readonly message: string;
}

/**
 * The step a conversation is on: its newest tool call not finished ("Count to 1500 A" for one that started a
 * sub-agent, the command it runs), in one line; empty when none runs. The Now tab's "Right now" and each row of the
 * strip.
 */
export function runningStep(parts: readonly IReplyPart[]): string {
	for (let i = parts.length - 1; i >= 0; i--) {
		const p = parts[i];
		if (p.tool && p.running && !p.hidden) {
			return (p.subagent?.description || p.message).replace(/\s+/g, ' ').trim();
		}
	}
	return '';
}

/**
 * The step one sub-agent is on, from the reply of the conversation that sent it out: the Agent Host puts the
 * sub-agent's own calls there too, each marked with the call that started it. The sub-agent's chat is named
 * `<session>/subagent/<call id>` or carries that call in its fragment.
 */
export function subagentStep(parts: readonly IReplyPart[], chat: { readonly resource: string; readonly fragment: string }): string {
	const start = parts.find(p => p.subagent && p.id && (p.subagent.chat === chat.resource || chat.fragment === `subagent/${p.id}` || chat.fragment === p.id || chat.resource.endsWith(`/subagent/${p.id}`)));
	return start ? runningStep(parts.filter(p => p.parent === start.id)) : '';
}
