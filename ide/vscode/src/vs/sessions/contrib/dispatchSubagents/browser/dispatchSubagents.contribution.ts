/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the sub-agent strip above the message box (direction A, task-1rzdr; dispatchSubagentStrip.ts).
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { DispatchSubagentStrip } from './dispatchSubagentStrip.js';

registerWorkbenchContribution2(DispatchSubagentStrip.ID, DispatchSubagentStrip, WorkbenchPhase.AfterRestored);
