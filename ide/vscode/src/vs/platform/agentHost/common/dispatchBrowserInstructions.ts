/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserChatToolReferenceName } from '../../browserView/common/browserChatToolReferenceNames.js';

/**
 * Dispatch: what "the built-in browser" means in a Claude or Codex session of the Agents window,
 * appended to Claude's system prompt and to Codex's developer instructions. The integrated
 * browser's tools reach both harnesses as client tools; without this the model reaches for
 * whatever browser it knows from elsewhere (Claude in Chrome, a Playwright MCP server, `open`,
 * the `dispatch browser` CLI).
 *
 * @param toolPrefix how the harness names client tools: `mcp__client__` for Claude, '' for Codex.
 */
export function dispatchBrowserInstructions(toolPrefix: string): string {
	const t = (name: string) => `${toolPrefix}${name}`;
	const R = BrowserChatToolReferenceName;
	return [
		'# Built-in browser (Dispatch)',
		`When the user says "内置浏览器", "built-in browser", "in-app browser" or "the browser in Dispatch", they mean the browser in the right pane of this Dispatch window. Drive it with the built-in browser tools: ${t(R.OpenBrowserPage)} (open a URL; call it without a url to use the page the user already has open there), ${t(R.ReadPage)}, ${t(R.ScreenshotPage)}, ${t(R.ClickElement)}, ${t(R.TypeInPage)} (text, or a key such as Enter), ${t(R.HoverElement)}, ${t(R.DragElement)}, ${t(R.HandleDialog)}, ${t(R.NavigatePage)} and ${t(R.RunPlaywrightCode)}. Load them with tool search first if they are deferred.`,
		`The built-in browser can keep several profiles, each with its own sign-ins (for example "Work" and "Personal", or a test user). When the user says which account or profile to use, pass its name as \`profile\` to ${t(R.OpenBrowserPage)}; otherwise leave it out and the page opens with the profile the user picked last.`,
		'Do not use Claude in Chrome, the system browser (`open`), a Playwright MCP server, or the `dispatch browser` command for this unless the user names one of them. The built-in browser keeps the user\'s logins (they can import them from Chrome), so prefer it for pages that need a signed-in user.',
		'The user watches the page while you work and can take over by clicking or typing in it. When a browser tool says the user took control or stopped the action, do not retry: tell the user what you were doing and wait for them.',
	].join('\n');
}

/** The Claude harness's name for a client tool (`clientTools/claudeClientToolMcpServer.ts`). */
export const DISPATCH_BROWSER_INSTRUCTIONS_CLAUDE = dispatchBrowserInstructions('mcp__client__');
export const DISPATCH_BROWSER_INSTRUCTIONS_CODEX = dispatchBrowserInstructions('');
