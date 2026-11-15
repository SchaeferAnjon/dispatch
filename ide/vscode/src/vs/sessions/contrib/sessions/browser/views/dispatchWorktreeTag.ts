/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a session in a git worktree of its project says so at the end of its row in the sessions list,
 *  grouped by project (130-session-rows.patch). sessionsList.ts calls renderDispatchWorktreeTag.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ISession } from '../../../../services/sessions/common/session.js';
import { dispatchProjectsRegistry, projectOfSession } from '../dispatchProjectsModel.js';

const $ = DOM.$;

export function renderDispatchWorktreeTag(titleRow: HTMLElement, session: ISession, store: DisposableStore): void {
	let tag = titleRow.querySelector<HTMLElement>(':scope > .dispatch-worktree-tag');
	if (!tag) {
		tag = $('span.dispatch-worktree-tag', undefined, localize('dispatchWorktreeTag', "own copy"));
		titleRow.insertBefore(tag, titleRow.querySelector(':scope > .session-title-toolbar'));
	}
	const worktreeTag = tag;
	store.add(autorun(reader => {
		const projects = dispatchProjectsRegistry.read(reader);
		session.workspace.read(reader);
		worktreeTag.style.display = projectOfSession(session, projects)?.worktree ? '' : 'none';
	}));
	store.add(toDisposable(() => worktreeTag.style.display = 'none'));
}
