/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an agent that opens a page it already has open gets that tab again, reloaded, instead of a
 *  second tab of the same page (725-browser-same-page.patch). Two "To-Do List" tabs of one index.html came
 *  from an agent that checked its work twice (task-lj06.34), with forceNew or through `dispatch browser open`.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import type { IToolInvocation } from '../../../chat/common/tools/languageModelToolsService.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { BrowserAgentInterrupted, browserAgentIdentity, IBrowserAgentPresenceService } from './browserAgentPresence.js';
import { playwrightInvokeRaw } from './browserToolHelpers.js';

/** The page a URL means, for comparing two: the same address without its `#…` part. */
export function samePageUrl(a: string | undefined, b: string | undefined): boolean {
	const key = (u: string | undefined) => {
		const parsed = u ? URL.parse(u) : null;
		return parsed ? parsed.href.replace(/#.*$/, '').replace(/\/$/, '') : '';
	};
	return !!key(a) && key(a) === key(b);
}

/** The agent's page (shared with it) already at `url`, the newest first; undefined when there is none. */
export function findSamePage(browserViews: IBrowserViewWorkbenchService, url: string, activeSessionId: string | undefined): BrowserEditorInput | undefined {
	const views = [...browserViews.getContextualBrowserViews({ activeSessionId }).values()].reverse();
	return views.find((e): e is BrowserEditorInput => e instanceof BrowserEditorInput
		&& e.model?.sharingState === BrowserViewSharingState.Shared && samePageUrl(e.url, url));
}

/** Reloads that page (the agent opens it to see its latest change) and answers with its summary, as an open does. */
export async function reuseSamePage(
	page: BrowserEditorInput, sessionId: string, invocation: IToolInvocation, token: CancellationToken,
	playwright: IPlaywrightService, presence: IBrowserAgentPresenceService,
): Promise<{ pageId: string; summary: string } | BrowserAgentInterrupted> {
	const summary = await presence.run(page.id, browserAgentIdentity(invocation), { label: localize('browserAgent.reloading', "Reloading the page") }, token, async () => {
		await playwrightInvokeRaw(playwright, sessionId, page.id, p => p.reload({ waitUntil: 'domcontentloaded' }).then(() => undefined));
		return playwright.getSummary(sessionId, page.id);
	});
	return summary instanceof BrowserAgentInterrupted ? summary : { pageId: page.id, summary };
}
