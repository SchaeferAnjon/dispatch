/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the first-run choices that are not about which agents are used (kanban app/cli/autonomy.py,
 *  awake.py, firstrun.py are what they ask): how much agents may do on their own, how Dispatch looks,
 *  notifications on this Mac, and keeping the Mac awake while an agent works.
 *  No imports in here: the wizard, Customizations and the node tests use it.
 *--------------------------------------------------------------------------------------------*/

/** One of the three answers to "how much may agents do on their own" (autonomy.py LEVELS). */
export interface IAutonomyLevel {
	readonly id: string;
	readonly title: string;
	/** What it means in plain words, including what can go wrong. */
	readonly detail: string;
}

/** `dispatch autonomy --json`. */
export interface IAutonomy {
	readonly level: string;
	readonly saved: boolean;
	readonly levels: readonly IAutonomyLevel[];
	/** The value of the window's chat.defaultConfiguration approvals setting for this level. */
	readonly ide_approvals: string;
}

/**
 * Claude Code has its own approvals axis (`permissionMode`) in the Agents window; this is the value for the
 * `chat.defaultConfiguration` approvals the person's answer was saved as: 'assisted' lets it edit files on its own,
 * 'allowAll' lets it do everything. '' for the safe level (Claude asks as usual) and under an enterprise policy.
 */
export function claudePermissionModeFor(approvals: unknown, policyRestricted: boolean): string {
	if (policyRestricted) {
		return '';
	}
	return approvals === 'assisted' ? 'acceptEdits' : approvals === 'allowAll' ? 'bypassPermissions' : '';
}

/**
 * Codex has its own approvals axis in the Agents window too (`codex.permissionsPreset`), which
 * `chat.defaultConfiguration` does not reach either (task-ngwit: with Full auto chosen, Claude Code and OpenCode started
 * that way and Codex asked before risky steps). 'allowAll' is its Full Access. Codex has no level that asks before every
 * edit: for the other answers it keeps its own default, which edits and runs routine commands inside the project and
 * asks before anything wider. '' under an enterprise policy.
 */
export function codexPermissionsPresetFor(approvals: unknown, policyRestricted: boolean): string {
	if (policyRestricted) {
		return '';
	}
	return approvals === 'allowAll' ? 'full-access' : '';
}

/** Full auto, the user's call (2026-10-01): agents change files and run commands without asking until a stricter level is picked. */
export const DEFAULT_AUTONOMY = 'auto';

/** The level the person chose, else the one saved, else the default. */
export function chosenAutonomy(chosen: string, saved: IAutonomy | undefined): string {
	const known = (id: string) => !!id && (saved?.levels.some(l => l.id === id) ?? id === DEFAULT_AUTONOMY);
	return known(chosen) ? chosen : saved?.level ?? DEFAULT_AUTONOMY;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly { readonly mode: ThemeMode; readonly title: string; readonly detail: string }[] = [
	{ mode: 'system', title: 'System', detail: 'Follows your Mac: light by day, dark at night.' },
	{ mode: 'light', title: 'Light', detail: 'Bright background.' },
	{ mode: 'dark', title: 'Dark', detail: 'Dark background, easier on the eyes in a dim room.' },
];

/** Notifications on this Mac: what the card says (plain words, no commands). */
export const NOTIFY_TEXT = {
	title: 'Tell me when an agent finishes or needs me',
	detail: 'A banner appears on this Mac, even when Dispatch is in the background. The first time, macOS asks to allow it: click Allow.',
} as const;

/** Keeping the Mac awake: the setting and the one honest line about the lid. */
export const AWAKE_TEXT = {
	title: 'Keep this Mac awake while an agent is working',
	detail: 'The Mac does not go to sleep in the middle of a task, and stays reachable from your phone. Closing the lid still puts a MacBook to sleep, unless it is plugged in and connected to an external display.',
} as const;
