/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the input box's permission picker says what the agent will do (patches/305-composer.patch;
 *  kanban design/identity/bold A3). The levels Settings › Agents names have those names here too, the chip and the
 *  menu alike (task-o2r5g: Full auto had five names, and Codex's menu spoke of sandboxes and auto-reviewers):
 *  Always ask, Ask for risky actions, Full auto (platform/agentHost/common/dispatchPermissionNames.ts). A mode that
 *  is none of them (Claude Code's Plan and Auto, Codex's reviewer) keeps a plain sentence of its own.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { dispatchAlwaysAsk, dispatchAlwaysAskDetail, dispatchAskRisky, dispatchAskRiskyDetail, dispatchFullAuto, dispatchFullAutoDetail } from '../../../../platform/agentHost/common/dispatchPermissionNames.js';
import { DispatchBlockIcons } from '../../dispatchBlocks/browser/dispatchBlocks.js';

interface IWords { readonly label: () => string; readonly detail: () => string }

const WORDS: Record<string, Record<string, IWords>> = {
	// Claude Code (claude.permissionMode)
	'permissionMode': {
		'default': { label: dispatchAlwaysAsk, detail: dispatchAlwaysAskDetail },
		'acceptEdits': { label: dispatchAskRisky, detail: dispatchAskRiskyDetail },
		'plan': {
			label: () => localize('dispatchPermission.claude.plan', "Plans first, changes nothing"),
			detail: () => localize('dispatchPermission.claude.planDetail', "Reads and plans; you say when it may change things"),
		},
		'auto': {
			label: () => localize('dispatchPermission.claude.auto', "Decides itself when to ask"),
			detail: () => localize('dispatchPermission.claude.autoDetail', "Asks only before steps it judges risky"),
		},
		'bypassPermissions': { label: dispatchFullAuto, detail: dispatchFullAutoDetail },
	},
	// Codex (codex.permissionsPreset)
	'permissionsPreset': {
		'default': {
			label: dispatchAskRisky,
			detail: () => localize('dispatchPermission.codex.defaultDetail', "Works inside the project on its own and asks before going online or outside it"),
		},
		'auto-review': {
			label: () => localize('dispatchPermission.codex.autoReview', "Another AI answers for you"),
			detail: () => localize('dispatchPermission.codex.autoReviewDetail', "Works inside the project; when it wants to go further, another AI decides instead of asking you"),
		},
		'full-access': {
			label: dispatchFullAuto,
			detail: () => localize('dispatchPermission.codex.fullAccessDetail', "Changes files anywhere, runs commands and goes online without asking"),
		},
	},
};

function wordsOf(property: string, value: string | undefined): IWords | undefined {
	const key = Object.keys(WORDS).find(k => property === k || property.endsWith('.' + k));
	return key && value ? WORDS[key][value] : undefined;
}

/** The name and icon for a permission picker's value, or undefined for anything else (keep the engine's label). */
export function dispatchPermissionWords(property: string, value: string | undefined): { label: string; icon: ThemeIcon } | undefined {
	const words = wordsOf(property, value);
	if (!words) {
		return undefined;
	}
	const risky = value === 'bypassPermissions' || value === 'full-access';
	return { label: words.label(), icon: risky ? Codicon.warning : DispatchBlockIcons.permission };
}

/** A permission menu's row for a value: the same name as the chip, and what it means in plain words. */
export function dispatchPermissionItem(property: string, value: string): { label: string; description: string } | undefined {
	const words = wordsOf(property, value);
	return words ? { label: words.label(), description: words.detail() } : undefined;
}
