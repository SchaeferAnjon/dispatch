/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: In this update in the update tooltip (480-whats-new.patch). updateTooltip.ts calls renderInThisUpdate.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchInThisUpdate.css';
import * as dom from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IUpdate } from '../../../../platform/update/common/update.js';

/**
 * "In this update", the new build's What's new that the
 * update feed carries (release.sh puts the features' names, where they are and a small picture
 * into each feed entry), so the restart shows what to look at.
 */
export function renderInThisUpdate(node: HTMLElement, update: IUpdate | undefined): void {
	const items = (update as { whatsNew?: unknown } | undefined)?.whatsNew;
	if (!Array.isArray(items) || !items.length) {
		return;
	}
	dom.append(node, dom.$('.ulh', undefined, localize('updateTooltip.inThisUpdate', "In this update")));
	for (const raw of items.slice(0, 5)) {
		const r = raw as { title?: unknown; where?: unknown; thumb?: unknown } | undefined;
		if (!r || typeof r.title !== 'string') {
			continue;
		}
		const row = dom.append(node, dom.$('.uli'));
		const thumb = dom.append(row, dom.$('span.thumb'));
		if (typeof r.thumb === 'string' && r.thumb.startsWith('data:image/')) {
			thumb.style.backgroundImage = `url("${r.thumb}")`;
		}
		dom.append(row, dom.$('span.t', undefined, r.title));
		if (typeof r.where === 'string' && r.where) {
			dom.append(row, dom.$('span.w', undefined, r.where));
		}
	}
	node.style.display = '';
}
