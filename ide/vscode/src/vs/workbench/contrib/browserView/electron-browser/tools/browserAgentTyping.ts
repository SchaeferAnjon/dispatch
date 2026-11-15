/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: an agent typing into a page, a few letters at a time so the person sees it typed
 *  (710-browser-agent-tools.patch). typeBrowserTool.ts calls typeLetterByLetter for short text.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import type { IToolResult } from '../../../chat/common/tools/languageModelToolsService.js';
import { errorResult, playwrightInvoke } from './browserToolHelpers.js';

/**
 * Short text goes in a few letters at a time so the user sees it typed, and stops
 * between pieces as soon as the user takes over (Playwright cannot be interrupted mid-call).
 */
export async function typeLetterByLetter(playwrightService: IPlaywrightService, sessionId: string, pageId: string, text: string, submit: boolean, selector: string, token: CancellationToken): Promise<IToolResult> {
	const cleared = await playwrightInvoke(playwrightService, sessionId, pageId, (page, sel) => page.locator(sel).fill(''), selector);
	if (cleared.toolResultError) {
		return cleared;
	}
	for (let i = 0; i < text.length; i += 4) {
		if (token.isCancellationRequested) {
			return errorResult('Stopped while typing.');
		}
		const piece = await playwrightInvoke(playwrightService, sessionId, pageId, (page, sel, chunk) => page.locator(sel).pressSequentially(chunk, { delay: 24 }), selector, text.slice(i, i + 4));
		if (piece.toolResultError) {
			return piece;
		}
	}
	if (submit && !token.isCancellationRequested) {
		return playwrightInvoke(playwrightService, sessionId, pageId, (page, sel) => page.locator(sel).press('Enter'), selector);
	}
	return { content: [{ kind: 'text', value: 'Typed the text.' }] };
}
