/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import {
	escapeMarkdownSyntaxTokens,
	MarkdownString
} from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { ToolDataSource, type CountTokensCallback, type IPreparedToolInvocation, type IToolData, type IToolImpl, type IToolInvocation, type IToolInvocationPreparationContext, type IToolResult, type ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { createBrowserPageLink, errorResult, getSessionId, playwrightInvoke } from './browserToolHelpers.js';
import { BrowserChatToolReferenceName } from '../../../../../platform/browserView/common/browserChatToolReferenceNames.js';
import { OpenPageToolId } from './openBrowserTool.js';
import { agentTargetRect, BrowserAgentInterrupted, browserAgentIdentity, IBrowserAgentPresenceService, quoteElement } from './browserAgentPresence.js';
import { typeLetterByLetter } from './browserAgentTyping.js';

export const TypeBrowserToolData: IToolData = {
	id: 'type_in_page',
	toolReferenceName: BrowserChatToolReferenceName.TypeInPage,
	displayName: localize('typeBrowserTool.displayName', 'Type in Page'),
	userDescription: localize('typeBrowserTool.userDescription', 'Type text or press keys in a browser page'),
	modelDescription: 'Type text or press keys in a browser page.',
	icon: Codicon.symbolText,
	source: ToolDataSource.Internal,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: `The browser page ID, acquired from context or the open tool.`
			},
			text: {
				type: 'string',
				description: 'The text to type. One of "text" or "key" must be provided.'
			},
			submit: {
				type: 'boolean',
				description: 'Whether to press Enter after typing text. Ignored when "key" is provided. Default is false.'
			},
			key: {
				type: 'string',
				description: 'A key or key combination to press (e.g., "Enter", "Tab", "Control+c"). One of "text" or "key" must be provided.'
			},
			ref: {
				type: 'string',
				description: 'Element reference to focus and type into. If omitted, types into the focused element.'
			},
			selector: {
				type: 'string',
				description: 'Playwright selector of element to focus and type into. Use if "ref" is not available. If omitted, types into the focused element.'
			},
			element: {
				type: 'string',
				description: 'Human-readable description of the element to type into (e.g., "search box", "comment field"). Required when "ref" or "selector" is specified.'
			},
		},
		required: ['pageId']
	},
};

interface ITypeBrowserToolParams {
	pageId: string;
	text?: string;
	submit?: boolean;
	key?: string;
	ref?: string;
	selector?: string;
	element?: string;
}

export class TypeBrowserTool implements IToolImpl {
	constructor(
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IBrowserAgentPresenceService private readonly presence: IBrowserAgentPresenceService,
	) { }

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ITypeBrowserToolParams;
		const link = createBrowserPageLink(params.pageId);
		const hasTarget = params.ref || params.selector;

		if (params.key) {
			const key = escapeMarkdownSyntaxTokens(params.key);
			if (hasTarget && params.element) {
				const element = escapeMarkdownSyntaxTokens(params.element);
				return {
					invocationMessage: new MarkdownString(localize('browser.pressKey.invocation.element', "Pressing key `{0}` in {1} in {2}", key, element, link)),
					pastTenseMessage: new MarkdownString(localize('browser.pressKey.past.element', "Pressed key `{0}` in {1} in {2}", key, element, link)),
				};
			}
			return {
				invocationMessage: new MarkdownString(localize('browser.pressKey.invocation', "Pressing key `{0}` in {1}", key, link)),
				pastTenseMessage: new MarkdownString(localize('browser.pressKey.past', "Pressed key `{0}` in {1}", key, link)),
			};
		}

		if (hasTarget && params.element) {
			const element = escapeMarkdownSyntaxTokens(params.element);
			return {
				invocationMessage: params.submit
					? new MarkdownString(localize('browser.typeAndSubmit.invocation.element', "Typing text in {0} in {1} and pressing Enter", element, link))
					: new MarkdownString(localize('browser.type.invocation.element', "Typing text in {0} in {1}", element, link)),
				pastTenseMessage: params.submit
					? new MarkdownString(localize('browser.typeAndSubmit.past.element.dispatch', "Typed into {0} and pressed Enter", element))
					: new MarkdownString(localize('browser.type.past.element.dispatch', "Typed into {0}", element)),
			};
		}
		return {
			invocationMessage: params.submit
				? new MarkdownString(localize('browser.typeAndSubmit.invocation', "Typing text in {0} and pressing Enter", link))
				: new MarkdownString(localize('browser.type.invocation', "Typing text in {0}", link)),
			pastTenseMessage: params.submit
				? new MarkdownString(localize('browser.typeAndSubmit.past', "Typed text in {0} and pressed Enter", link))
				: new MarkdownString(localize('browser.type.past', "Typed text in {0}", link)),
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ITypeBrowserToolParams;
		const sessionId = getSessionId(invocation);

		if (!params.pageId) {
			return errorResult(`No page ID provided. Use '${OpenPageToolId}' first.`);
		}

		let selector = params.selector;
		if (params.ref) {
			selector = `aria-ref=${params.ref}`;
		}

		if (!params.text && !params.key) {
			return errorResult('Either a "text" or "key" parameter is required.');
		}

		// Dispatch: the overlay outlines the field and the text appears letter by letter.
		const target = selector;
		const element = quoteElement(params.element, localize('browserAgent.theField', "the field"));
		const label = params.key
			? localize('browserAgent.pressing', "Pressing {0}", params.key)
			: target
				? localize('browserAgent.typingInto', "Typing into {0}", element)
				: localize('browserAgent.typing', "Typing");
		const result = await this.presence.run(params.pageId, browserAgentIdentity(invocation), { label, input: 'keys' }, token, async control => {
			const rect = target ? await agentTargetRect(this.playwrightService, sessionId, params.pageId, target, control.motion) : undefined;
			if (rect) {
				await control.cue({ kind: 'type', rect });
			}
			if (target && !params.key && control.motion && params.text!.length <= 80) {
				return typeLetterByLetter(this.playwrightService, sessionId, params.pageId, params.text!, !!params.submit, target, control.token);
			}
			return this._invoke(sessionId, params, target);
		});
		if (result instanceof BrowserAgentInterrupted) {
			return result.toToolResult();
		}
		return result;
	}

	private _invoke(sessionId: string, params: ITypeBrowserToolParams, selector: string | undefined): Promise<IToolResult> {
		// Press key
		if (params.key) {
			if (selector) {
				return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, sel, key) => page.locator(sel).press(key), selector, params.key);
			}
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, (page, key) => page.keyboard.press(key), params.key);
		}

		// Type text
		if (selector) {
			return playwrightInvoke(this.playwrightService, sessionId, params.pageId, async (page, sel, text, submit) => {
				const locator = page.locator(sel);
				await locator.fill(text);
				if (submit) {
					await locator.press('Enter');
				}
			}, selector, params.text!, params.submit ?? false);
		}
		return playwrightInvoke(this.playwrightService, sessionId, params.pageId, async (page, text, submit) => {
			await page.keyboard.type(text);
			if (submit) {
				await page.keyboard.press('Enter');
			}
		}, params.text!, params.submit ?? false);
	}
}
