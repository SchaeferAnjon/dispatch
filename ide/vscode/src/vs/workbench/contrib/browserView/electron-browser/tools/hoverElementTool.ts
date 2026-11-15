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

export const HoverElementToolData: IToolData = {
	id: 'hover_element',
	toolReferenceName: BrowserChatToolReferenceName.HoverElement,
	displayName: localize('hoverElementTool.displayName', 'Hover Element'),
	userDescription: localize('hoverElementTool.userDescription', 'Hover over an element in a browser page'),
	modelDescription: 'Hover over an element in a browser page. Provide either a Playwright selector or an element reference.',
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
				description: 'Element reference to hover over.'
			},
			selector: {
				type: 'string',
				description: 'Playwright selector of the element to hover over when "ref" is not available.'
			},
			element: {
				type: 'string',
				description: 'Human-readable description of the element to hover over (e.g., "navigation menu", "tooltip trigger").'
			},
		},
		required: ['pageId', 'element'],
		$comment: 'One of "ref" or "selector" is required.',
	},
};

interface IHoverElementToolParams {
	pageId: string;
	ref?: string;
	selector?: string;
	element?: string;
}

export class HoverElementTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IBrowserAgentPresenceService private readonly presence: IBrowserAgentPresenceService,
	) { }

	async prepareToolInvocation(_context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = _context.parameters as IHoverElementToolParams;
		const link = createBrowserPageLink(params.pageId);
		const element = escapeMarkdownSyntaxTokens(params.element ?? DEFAULT_ELEMENT_LABEL);
		return {
			invocationMessage: new MarkdownString(localize('browser.hover.invocation', "Hovering over {0} in {1}", element, link)),
			pastTenseMessage: new MarkdownString(localize('browser.hover.past.dispatch', "Hovered over {0}", element)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IHoverElementToolParams;
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

		const target = selector;
		const element = quoteElement(params.element, localize('browserAgent.anElement', "an element"));
		const result = await this.presence.run(params.pageId, browserAgentIdentity(invocation), {
			label: localize('browserAgent.hovering', "Hovering over {0}", element),
			input: 'pointer',
		}, token, async control => {
			const rect = await agentTargetRect(this.playwrightService, sessionId, params.pageId, target, control.motion);
			if (rect) {
				await control.cue({ kind: 'hover', rect });
			}
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, sel) => page.locator(sel).hover(), target);
		});
		return result instanceof BrowserAgentInterrupted ? result.toToolResult() : result;
	}
}
