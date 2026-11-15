/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: whether the active session has loaded its changes and has none, for the side pane's Changes tab
 *  (browser/dispatchDockedDetailFit.ts): then the file list alone fills the tab, instead of the diff's "No Changed
 *  Files" beside the list's "Changes / No changed files" (task-wwi8s, "我点击changes之后 会出现两个changes").
 *  While a session or its changes load, the last answer stands, so the tab does not flicker between one and two.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { derivedObservableWithCache } from '../../../../base/common/observable.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { bindContextKey } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { DispatchNoChangesContext } from '../../../browser/dispatchDockedDetailFit.js';
import { IChangesViewService } from '../common/changesViewService.js';

class DispatchChangesEmptyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dispatchChangesEmpty';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChangesViewService changesViewService: IChangesViewService,
	) {
		super();
		const none = derivedObservableWithCache<boolean>(this, (reader, last) => {
			if (!changesViewService.activeSessionResourceObs.read(reader)) {
				return false;
			}
			if (changesViewService.activeSessionLoadingObs.read(reader) || changesViewService.activeSessionChangesetLoadingObs.read(reader)) {
				return last ?? false;
			}
			return changesViewService.activeSessionChangesObs.read(reader).length === 0;
		});
		this._register(bindContextKey(DispatchNoChangesContext, contextKeyService, reader => none.read(reader)));
	}
}

registerWorkbenchContribution2(DispatchChangesEmptyContribution.ID, DispatchChangesEmptyContribution, WorkbenchPhase.AfterRestored);
