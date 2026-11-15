/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Let the agent fix it" and the agent-written commit message in the Changes tab
 *  (kanban app/cli/fixit.py). The service is made at startup so the changeset hook is in place
 *  before the first Commit.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { DispatchFixitService, IDispatchFixitService } from './dispatchFixitService.js';

registerSingleton(IDispatchFixitService, DispatchFixitService, InstantiationType.Delayed);

class DispatchFixitContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchFixit';
	constructor(@IDispatchFixitService _fixit: IDispatchFixitService) {
		super();
	}
}

registerWorkbenchContribution2(DispatchFixitContribution.ID, DispatchFixitContribution, WorkbenchPhase.AfterRestored);
