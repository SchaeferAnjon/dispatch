/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: Turbo's mark, the app icon's ten blocks as a run's progress (patches/420-turbo.patch).
 *  The Timeline's title and the run's row in the sessions list draw it; nothing else is imported, so the sessions
 *  list can draw it without loading the Timeline.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';
import { DISPATCH_ICON_BLOCKS } from '../../../../base/common/dispatchPalette.js';
import { DISPATCH_ICON_DROP, dispatchIconLayout } from '../../../../base/common/dispatchIcon.js';
import { dispatchIconDrop } from '../../../../base/browser/dispatchIcon.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The outline of a hollow block, in the mark's 16 units: drawn inside the block's box. */
const STROKE = 0.45;

/**
 * The app icon's ten blocks as Turbo's progress, at the Dock icon's proportions (base/common/dispatchIcon.ts): the
 * parts combined so far solid, in the order the icon's blocks drop in (a new one drops in once, the big icon's
 * drop at this size), the rest hollow. Done: they take the icon's colours one after another and the green corner
 * lights up.
 */
export function turboMark(size: number, cells: readonly boolean[], opts: { done?: boolean; arrive?: number; think?: boolean } = {}): HTMLElement {
	ensureDispatchPalette();
	const host = dom.$(`span.dispatch-turbo-mark${opts.done ? '.done' : ''}${opts.think ? '.think' : ''}`);
	host.setAttribute('aria-hidden', 'true');
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', '0 0 16 16');
	const order = DISPATCH_ICON_DROP.order;
	const L = dispatchIconLayout(16, { plate: false });
	for (const b of L.blocks) {
		const i = b.i;
		const r = mainWindow.document.createElementNS(SVG_NS, 'rect');
		r.setAttribute('x', String(b.x + STROKE / 2));
		r.setAttribute('y', String(b.y + STROKE / 2));
		r.setAttribute('width', String(b.w - STROKE));
		r.setAttribute('height', String(b.h - STROKE));
		r.setAttribute('rx', String(b.rx));
		const lit = !!cells[i];
		r.setAttribute('class', `cell blk${lit ? ' lit' : ''}`);
		r.dataset.i = String(i);
		r.style.setProperty('--i', String(order.indexOf(i)));
		if (opts.done) {
			// the app icon's own colours (base/common/dispatchPalette.ts)
			r.style.setProperty('--c', `var(--dispatch-icon-${DISPATCH_ICON_BLOCKS[i].color})`);
			r.style.setProperty('--o', String(DISPATCH_ICON_BLOCKS[i].opacity));
		}
		svg.appendChild(r);
	}
	const d = L.dot!;
	const dot = mainWindow.document.createElementNS(SVG_NS, 'circle');
	dot.setAttribute('cx', String(d.cx));
	dot.setAttribute('cy', String(d.cy));
	dot.setAttribute('r', String(d.r - STROKE / 2));
	dot.setAttribute('class', 'dot');
	svg.appendChild(dot);
	host.appendChild(svg);
	const arrive = opts.arrive !== undefined ? order[opts.arrive] : undefined;
	if (arrive !== undefined && cells[arrive]) {
		// the newest part drops in once, the big icon's drop (design/icon-motion's 落块) at this size
		dispatchIconDrop(svg as SVGSVGElement, () => !!mainWindow.document.querySelector('.monaco-workbench.monaco-reduce-motion') || mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches).drop([arrive]);
	}
	return host;
}
