/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the selection box on a reply (315-quote.patch): where it sits (at the first selected character,
 *  never over the reply's tool row) and the quote card a Quote makes. responseSelectionSideChatController.ts uses these.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { IChatRequestDispatchQuoteVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IChat } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { agentName, formatQuoteTime, toQuoteEntry } from '../../dispatchQuote/browser/dispatchQuote.js';
import { IResolvedResponseSelection } from './responseSelectionResolver.js';

/**
 * Where the selected text starts (its first line box), so the overlay lines up with
 * the first selected character rather than the left edge of the paragraph.
 */
export function dispatchSelectionStartRect(range: Range): { left: number } | undefined {
	for (const rect of range.getClientRects()) {
		if (rect.width !== 0 && rect.height !== 0) {
			return rect;
		}
	}
	return undefined;
}

/**
 * The visible buttons of the tool row under the reply the selection is in.
 */
export function dispatchToolRowRect(range: Range): { top: number; bottom: number; left: number; right: number } | undefined {
	const start = range.startContainer;
	const el = dom.isHTMLElement(start) ? start : start.parentElement;
	const toolbar = el?.closest('.interactive-item-container')?.querySelector('.chat-footer-toolbar');
	if (!toolbar) {
		return undefined;
	}
	let top = Number.POSITIVE_INFINITY, bottom = Number.NEGATIVE_INFINITY, left = Number.POSITIVE_INFINITY, right = Number.NEGATIVE_INFINITY;
	// eslint-disable-next-line no-restricted-syntax
	for (const item of toolbar.querySelectorAll('.action-item')) {
		const r = item.getBoundingClientRect();
		if (!r.width || !r.height) {
			continue;
		}
		top = Math.min(top, r.top);
		bottom = Math.max(bottom, r.bottom);
		left = Math.min(left, r.left);
		right = Math.max(right, r.right);
	}
	return bottom === Number.NEGATIVE_INFINITY ? undefined : { top, bottom, left, right };
}

/** The quote card for a selection in a reply: its text, and "Claude · 4:20 AM" as where it is from. */
export function dispatchReplyQuoteEntry(resolved: IResolvedResponseSelection, chat: IChat, sessionsManagementService: ISessionsManagementService): IChatRequestDispatchQuoteVariableEntry {
	const session = sessionsManagementService.getSessionForChatResource(chat.resource)?.session;
	const response = resolved.response;
	const at = response.model.completedAt ?? response.model.timestamp;
	const name = agentName(session?.sessionType, session?.providerId, session?.icon.id) ?? response.agent?.fullName ?? response.username;
	const time = formatQuoteTime(at);
	return toQuoteEntry(resolved.text, {
		from: 'reply',
		label: time ? `${name} · ${time}` : name,
		icon: session?.icon.id,
		chat: chat.resource.toString(),
		responseId: response.id,
		requestId: response.requestId,
		at,
	});
}
