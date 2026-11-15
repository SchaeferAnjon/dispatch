/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sessions picker asks the codebase too (350-codebase-search.patch): the active session's
 *  folder through dispatch-bridge's dispatch.codeSearch (`dispatch code-search`), shown as an "In codebase" group.
 *  sessionsActions.ts calls searchDispatchCodebase with its picker.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInput, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Event } from '../../../../base/common/event.js';

/** A place in the code, opened at its line. */
export interface IDispatchCodebaseHit extends IQuickPickItem {
	readonly hit: { readonly path: string; readonly line: number };
}

/** Once the query has 3 characters and the typing paused (400 ms), the hits in `root`; none without a root. */
export function searchDispatchCodebase(picker: IQuickInput & { readonly onDidChangeValue: Event<string> }, commandService: ICommandService, root: string | undefined, show: (hits: IDispatchCodebaseHit[]) => void): IDisposable {
	const store = new DisposableStore();
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	store.add(toDisposable(() => clearTimeout(timer)));
	store.add(picker.onDidChangeValue(value => {
		clearTimeout(timer);
		const query = value.trim();
		if (!root || query.length < 3) {
			show([]);
			return;
		}
		const mine = ++seq;
		timer = setTimeout(async () => {
			try {
				const found = await commandService.executeCommand<{ path: string; relative: string; line: number; text: string }[]>('dispatch.codeSearch', query, root);
				if (mine === seq) {
					show((found ?? []).slice(0, 8).map(h => ({
						id: `dispatch.hit.${h.path}:${h.line}`,
						label: `$(file) ${h.relative}:${h.line}`,
						description: localize('dispatch.inCodebaseDescription', "In codebase"), // the separator's label is not shown while the list is filtered
						detail: h.text,
						alwaysShow: true, // the quick pick's own filter matches names, not code
						hit: { path: h.path, line: h.line },
					})));
				}
			} catch {
				// no bridge, no index: sessions only
			}
		}, 400);
	}));
	return store;
}
