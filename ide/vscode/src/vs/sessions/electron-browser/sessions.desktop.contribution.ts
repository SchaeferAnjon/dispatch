/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../platform/actions/common/actions.js';
import { OpenSessionInVSCodeAction, OpenVSCodeWindowAction, ReturnToVSCodeEditorAction, ShouldShowReturnToVSCodeEditorAction } from './actions/vscodeActions.js';

// Actions
(function registerActions(): void {
	registerAction2(OpenSessionInVSCodeAction);
	registerAction2(OpenVSCodeWindowAction);
	registerAction2(ReturnToVSCodeEditorAction);
	registerAction2(ShouldShowReturnToVSCodeEditorAction);
})();

// Dispatch IDE: no OpenInVSCodeWidgetContribution here. Editor right of the session title is drawn by
// contrib/dispatchTitleBar/browser/dispatchEditorEntry.ts (one view item per menu entry).
