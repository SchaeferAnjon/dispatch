/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { createBrowserPageLink, DEFAULT_ELEMENT_LABEL, errorResult, getSessionId, playwrightInvoke } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../../../../platform/browserView/common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';
import { agentTargetRect, BrowserAgentInterrupted, browserAgentIdentity, IBrowserAgentPresenceService, quoteElement } from './browserAgentPresence.js';

export const ClickBrowserToolData: IToolData = {
	id: 'click_element',
	toolReferenceName: BrowserChatToolReferenceName.ClickElement,
	displayName: localize('clickBrowserTool.displayName', 'Click Element'),
	userDescription: localize('clickBrowserTool.userDescription', 'Click an element in a browser page'),
	modelDescription: 'Click on an element in a browser page.',
	icon: Codicon.cursor,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: `The browser page ID, acquired from context or the open tool.`
			},
			ref: {
				type: 'string',
				description: 'Element reference to click.'
			},
			selector: {
				type: 'string',
				description: 'Playwright selector of the element to click when "ref" is not available.'
			},
			element: {
				type: 'string',
				description: 'Human-readable description of the element to click (e.g., "submit button", "search icon").'
			},
			dblClick: {
				type: 'boolean',
				description: 'Set to true for double clicks. Default is false.'
			},
			button: {
				type: 'string',
				enum: ['left', 'right', 'middle'],
				description: 'Mouse button to click with. Default is "left".'
			},
		},
		required: ['pageId', 'element'],
		$comment: 'One of "ref" or "selector" is required.',
	},
};

interface IClickBrowserToolParams {
	pageId: string;
	ref?: string;
	selector?: string;
	element?: string;
	dblClick?: boolean;
	button?: 'left' | 'right' | 'middle';
}

export class ClickBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IBrowserAgentPresenceService private readonly presence: IBrowserAgentPresenceService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = _context.parameters as IClickBrowserToolParams;
		const link = createBrowserPageLink(params.pageId);
		const element = escapeMarkdownSyntaxTokens(params.element ?? DEFAULT_ELEMENT_LABEL);
		return {
			invocationMessage: params.button === 'right'
				? new MarkdownString(localize('browser.click.invocation.right', "Right-clicking {0} in {1}", element, link))
				: params.button === 'middle'
					? new MarkdownString(localize('browser.click.invocation.middle', "Middle-clicking {0} in {1}", element, link))
					: params.dblClick
						? new MarkdownString(localize('browser.dblClick.invocation', "Double-clicking {0} in {1}", element, link))
						: new MarkdownString(localize('browser.click.invocation', "Clicking {0} in {1}", element, link)),
			pastTenseMessage: params.button === 'right'
				? new MarkdownString(localize('browser.click.past.right', "Right-clicked {0} in {1}", element, link))
				: params.button === 'middle'
					? new MarkdownString(localize('browser.click.past.middle', "Middle-clicked {0} in {1}", element, link))
					: params.dblClick
						? new MarkdownString(localize('browser.dblClick.past', "Double-clicked {0} in {1}", element, link))
						: new MarkdownString(localize('browser.click.past.dispatch', "Clicked {0}", element)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IClickBrowserToolParams;
		const sessionId = getSessionId(invocation);

		if (!params.pageId) {
			return errorResult(`No page ID provided. Use '${OpenPageToolId}' first.`);
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!selector) {
			return errorResult('Either a "ref" or "selector" parameter is required.');
		}

		const button = params.button ?? 'left';
		const target = selector;

		// Dispatch: the virtual cursor glides to the element, then the click lands with a ripple.
		const element = quoteElement(params.element, localize('browserAgent.anElement', "an element"));
		const result = await this.presence.run(params.pageId, browserAgentIdentity(invocation), {
			label: params.dblClick
				? localize('browserAgent.doubleClicking', "Double-clicking {0}", element)
				: localize('browserAgent.clicking', "Clicking {0}", element),
			input: 'pointer',
		}, token, async control => {
			const rect = await agentTargetRect(this.playwrightService, sessionId, params.pageId, target, control.motion);
			if (rect) {
				await control.cue({ kind: 'move', rect });
				await control.cue({ kind: 'click', rect });
			}
			if (params.dblClick) {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, sel, btn) => page.locator(sel).dblclick({ button: btn }), target, button);
			}
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, sel, btn) => page.locator(sel).click({ button: btn }), target, button);
		});
		return result instanceof BrowserAgentInterrupted ? result.toToolResult() : result;
	}
}
