/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Codex's slash commands in the Agents window. Codex's app-server does not read a
 *  `/name` at the start of a message the way its terminal does; each command is one request, sent by
 *  CodexAgent._sendMessage: `/compact` thread/compact/start (codexCompactCommand.ts), `/review`
 *  review/start, `/status` account/rateLimits/read, `/init` a turn with the prompt Codex's own `/init`
 *  sends. The slash menu lists them through IAgent.getSlashCommands.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { IAgentSlashCommand } from '../../common/agent.js';
import type { GetAccountRateLimitsResponse } from './protocol/generated/v2/GetAccountRateLimitsResponse.js';
import type { RateLimitWindow } from './protocol/generated/v2/RateLimitWindow.js';
import type { ReviewTarget } from './protocol/generated/v2/ReviewTarget.js';

export const CODEX_REVIEW_SLASH_COMMAND = 'review';
export const CODEX_INIT_SLASH_COMMAND = 'init';
export const CODEX_STATUS_SLASH_COMMAND = 'status';

/** The commands the menu offers for a Codex session (`/compact` comes from its own provider). */
export function codexSlashCommandsForMenu(): IAgentSlashCommand[] {
	return [
		{
			name: CODEX_REVIEW_SLASH_COMMAND,
			description: localize('codexSlash.review', "Review the uncommitted changes, or a branch, a commit or what you ask for"),
			argumentHint: localize('codexSlash.reviewHint', "[branch <base> | commit <sha> | what to check]"),
			runsImmediately: false,
		},
		{ name: CODEX_INIT_SLASH_COMMAND, description: localize('codexSlash.init', "Write an AGENTS.md for this project"), runsImmediately: true },
		{ name: CODEX_STATUS_SLASH_COMMAND, description: localize('codexSlash.status', "Show plan limits and when they reset"), runsImmediately: true },
	];
}

/**
 * What `/review <rest>` reviews: nothing after it (or `uncommitted`) is the uncommitted changes,
 * `branch <base>` the changes against a base branch, `commit <sha>` one commit, anything else is
 * what to check in the uncommitted changes.
 */
export function parseCodexReviewTarget(rest: string): ReviewTarget {
	const text = rest.trim();
	if (!text || /^uncommitted$/i.test(text)) {
		return { type: 'uncommittedChanges' };
	}
	const branch = /^(?:branch|base)\s+(\S+)\s*$/i.exec(text);
	if (branch) {
		return { type: 'baseBranch', branch: branch[1] };
	}
	const commit = /^commit\s+([0-9a-f]{4,40})(?:\s+([\s\S]+))?$/i.exec(text);
	if (commit) {
		return { type: 'commit', sha: commit[1], title: commit[2]?.trim() || null };
	}
	return { type: 'custom', instructions: text };
}

/** `/status`: the plan's windows, how much of each is used and when it resets, as a short Markdown list. */
export function formatCodexStatus(response: GetAccountRateLimitsResponse, now = Date.now()): string {
	const snapshot = response.rateLimits;
	const lines: string[] = [];
	const windowLine = (window: RateLimitWindow | null) => {
		if (!window) {
			return;
		}
		const used = Math.round(window.usedPercent);
		const name = windowName(window.windowDurationMins);
		const resets = window.resetsAt ? formatReset(window.resetsAt, now) : undefined;
		lines.push(resets
			? localize('codexStatus.window', "- {0}: {1}% used, resets {2}", name, used, resets)
			: localize('codexStatus.windowNoReset', "- {0}: {1}% used", name, used));
	};
	windowLine(snapshot?.primary ?? null);
	windowLine(snapshot?.secondary ?? null);
	if (snapshot?.planType) {
		lines.push(localize('codexStatus.plan', "- Plan: {0}", String(snapshot.planType)));
	}
	if (snapshot?.credits && typeof (snapshot.credits as { balance?: unknown }).balance === 'string') {
		lines.push(localize('codexStatus.credits', "- Credits: {0}", (snapshot.credits as { balance: string }).balance));
	}
	if (!lines.length) {
		return localize('codexStatus.none', "Codex did not report any limits for this account.");
	}
	return [localize('codexStatus.title', "**Codex usage**"), '', ...lines].join('\n');
}

function windowName(minutes: number | null): string {
	if (minutes === 300) {
		return localize('codexStatus.fiveHour', "5-hour window");
	}
	if (minutes === 10080) {
		return localize('codexStatus.weekly', "Weekly window");
	}
	if (minutes && minutes % 1440 === 0) {
		return localize('codexStatus.days', "{0}-day window", minutes / 1440);
	}
	if (minutes && minutes % 60 === 0) {
		return localize('codexStatus.hours', "{0}-hour window", minutes / 60);
	}
	return minutes ? localize('codexStatus.minutes', "{0}-minute window", minutes) : localize('codexStatus.window.unknown', "Window");
}

/** `resetsAt` is in seconds (app-server) or milliseconds; either way the local date and time. */
function formatReset(resetsAt: number, now: number): string {
	const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
	const date = new Date(ms);
	const sameDay = new Date(now).toDateString() === date.toDateString();
	const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	return sameDay
		? localize('codexStatus.resetToday', "today at {0}", time)
		: localize('codexStatus.resetDate', "{0} at {1}", date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), time);
}

/**
 * The prompt Codex's own `/init` sends (openai/codex, codex-rs/tui/prompt_for_init_command.md,
 * Apache-2.0), so `/init` in the Agents window does what it does in Codex's terminal.
 */
export const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed: add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;
