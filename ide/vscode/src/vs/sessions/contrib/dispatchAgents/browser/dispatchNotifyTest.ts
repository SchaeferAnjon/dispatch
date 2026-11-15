/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Send a test notification" (the setup wizard's notifications page, Customizations › Overview).
 *  The banner comes from the app itself (the window's own toasts, IHostService.showToast), so macOS shows it as
 *  Dispatch IDE, lists Dispatch IDE in System Settings › Notifications and asks about it there. It used to go
 *  through `dispatch first-run notify-test`, whose `osascript display notification` macOS files under Script
 *  Editor: on a new Mac nothing showed, nothing asked, and Dispatch was not in the list the page sent people to
 *  (the new-user run on the 0.9.1 release, kanban task-7mmi3).
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

export const DISPATCH_NOTIFY_TEST_COMMAND = '_dispatch.notifyTest';

export interface INotifyTestAnswer { readonly ok: boolean; readonly message: string }

const SENT = 'A banner was sent. If you did not see it, open System Settings › Notifications and allow Dispatch IDE.';

CommandsRegistry.registerCommand(DISPATCH_NOTIFY_TEST_COMMAND, (accessor): INotifyTestAnswer => {
	// the toast answers when it is closed or clicked, long after the button wants its line: not waited for
	accessor.get(IHostService).showToast({
		title: 'Dispatch',
		body: 'Notifications are on. You will see one like this when an agent finishes or needs you.',
	}, CancellationToken.None).catch(onUnexpectedError);
	return { ok: true, message: SENT };
});
