/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what an open document is, from its path, and how its tab names and marks it (task-fif4i,
 *  design/right-tabs/redesign A1 and A2): a delivery, a design proposal, a prototype, a handoff or notes each get
 *  their own symbol instead of one globe or page for every HTML or Markdown file, and the tab carries the part of
 *  the title before its colon ("备忘录里的问题", not "备忘录里的问题：16 件改好了…").
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DispatchBlockIcons } from '../../dispatchBlocks/browser/dispatchBlocks.js';

export type DispatchDocKind = 'delivery' | 'proposal' | 'prototype' | 'handoff' | 'notes' | 'page';

/** What a document is, by where it lives: delivery pages and proposals are a folder's index.html under design/. */
export function dispatchDocKind(path: string): DispatchDocKind {
	const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
	if (/\/handoffs\//.test(path)) {
		return 'handoff';
	}
	if (/^(proto|prototype)([-_.][^/]*)?\.html?$/.test(file)) {
		return 'prototype';
	}
	if (/^index\.html?$/.test(file)) {
		// a proposal's folder is redesign… or proposal…; an implementation's delivery is impl/ or the folder itself
		return /\/(redesign|proposal)[^/]*\//i.test(path) ? 'proposal' : /\/design\//.test(path) ? 'delivery' : 'page';
	}
	return /\.(md|markdown)$/.test(file) ? 'notes' : 'page';
}

const KIND_ICON: Record<DispatchDocKind, ThemeIcon> = {
	delivery: DispatchBlockIcons.delivery,
	proposal: DispatchBlockIcons.proposal,
	prototype: DispatchBlockIcons.prototype,
	handoff: DispatchBlockIcons['pass-on'],
	notes: Codicon.file,
	page: Codicon.globe,
};

export function dispatchDocKindIcon(kind: DispatchDocKind): ThemeIcon {
	return KIND_ICON[kind];
}

/**
 * A tab's name: the title up to its colon, and a prototype's letter after it ("BB 的整套设置 A"). A handoff's title is
 * "Context handoff: <the task>": every one would read the same, so its tab carries what comes after the colon.
 */
export function dispatchDocShortName(title: string, path?: string): string {
	const t = title.trim();
	const cut = t.search(/[：:]\s*/);
	const after = cut > 0 ? t.slice(cut + 1).trim() : '';
	const short = cut > 0 ? (path && dispatchDocKind(path) === 'handoff' && after ? after : t.slice(0, cut).trim()) : t;
	const letter = path ? /\/proto[-_]([a-z0-9])\.html?$/i.exec(path)?.[1] : undefined;
	return letter && !new RegExp(`\\b${letter}$`, 'i').test(short) ? `${short} ${letter.toUpperCase()}` : short;
}
