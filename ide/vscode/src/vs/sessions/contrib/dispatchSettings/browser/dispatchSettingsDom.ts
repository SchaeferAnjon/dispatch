/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the parts every Settings page is made of, after kanban DESIGN.md and the Customizations
 *  pages next door: a group head (12/600, the description colour), rows on the side bar's colour in one rounded
 *  block, a row's name 13 and one line under it 12, a note and a "go there" line (8 radius, the input fill),
 *  tags as capsules, segmented choices with the tab radius. No colour except the amber of "near the limit".
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { settingsData, SettingsDataKey } from './dispatchSettingsData.js';
import { agoText } from './dispatchSettingsModel.js';

const $ = DOM.$;

export function icon(id: ThemeIcon | string, extra = ''): HTMLElement {
	const t = typeof id === 'string' ? ThemeIcon.fromId(id) : id;
	const el = $(`span.dset-ic${extra ? '.' + extra : ''}${ThemeIcon.asCSSSelector(t)}`);
	el.setAttribute('aria-hidden', 'true');
	return el;
}

/** A group head: an icon, the name, and something at the right. */
export function groupHead(parent: HTMLElement, label: string, ic?: ThemeIcon | string, right?: string): HTMLElement {
	const h = DOM.append(parent, $('.dset-gh'));
	if (ic) {
		h.appendChild(icon(ic));
	}
	DOM.append(h, $('span.dset-gh-t', undefined, label));
	if (right !== undefined) {
		DOM.append(h, $('span.dset-gh-r', undefined, right));
	}
	return h;
}

/** One rounded block of rows; `key` is what search flashes. */
export function rowsBlock(parent: HTMLElement, key?: string): HTMLElement {
	const r = DOM.append(parent, $('.dset-rows'));
	if (key) {
		r.dataset.setting = key;
	}
	return r;
}

export interface IRowParts {
	readonly row: HTMLElement;
	readonly lead: HTMLElement;
	readonly text: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly ctl: HTMLElement;
}

export interface IRowOptions {
	readonly label: string;
	readonly detail?: string;
	readonly icon?: ThemeIcon | string;
	readonly brand?: boolean;
	readonly key?: string;
	/** The whole row goes somewhere: a chevron at its end. */
	readonly onClick?: () => void;
}

export function row(parent: HTMLElement, o: IRowOptions, store: DisposableStore): IRowParts {
	const r = DOM.append(parent, $('.dset-row'));
	if (o.key) {
		r.dataset.setting = o.key;
	}
	const lead = DOM.append(r, $('.dset-row-lead'));
	if (o.icon) {
		const ic = icon(o.icon);
		if (o.brand) {
			DOM.append(lead, $('.dset-brand')).appendChild(ic);
		} else {
			lead.appendChild(ic);
		}
	} else {
		lead.remove();
	}
	const text = DOM.append(r, $('.dset-row-text'));
	const label = DOM.append(text, $('.dset-row-label', undefined, o.label));
	const detail = DOM.append(text, $('.dset-row-detail', undefined, o.detail ?? ''));
	detail.hidden = !o.detail;
	const ctl = DOM.append(r, $('.dset-row-ctl'));
	if (o.onClick) {
		r.classList.add('click');
		r.tabIndex = 0;
		r.setAttribute('role', 'button');
		ctl.appendChild(icon(Codicon.chevronRight, 'dset-go'));
		const run = o.onClick;
		store.add(DOM.addDisposableListener(r, DOM.EventType.CLICK, e => {
			if ((e.target as HTMLElement).closest('button, .monaco-button, .monaco-custom-toggle, .dset-toggle, input, a')) {
				return;
			}
			run();
		}));
		store.add(DOM.addDisposableListener(r, DOM.EventType.KEY_DOWN, e => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === r) {
				DOM.EventHelper.stop(e, true);
				run();
			}
		}));
	}
	return { row: r, lead, text, label, detail, ctl };
}

export function tag(parent: HTMLElement, text: string, kind?: 'amber' | 'solid'): HTMLElement {
	return DOM.append(parent, $(`span.dset-tag${kind ? '.' + kind : ''}`, undefined, text));
}

/** The page's note: a line on the input fill, its first words in the text colour. */
export function note(parent: HTMLElement, bold: string, text: string, ic: ThemeIcon = Codicon.info): HTMLElement {
	const n = DOM.append(parent, $('.dset-note'));
	n.appendChild(icon(ic));
	const body = DOM.append(n, $('span'));
	DOM.append(body, $('strong', undefined, bold));
	body.append(text ? ` ${text}` : '');
	return n;
}

/** A line that takes you to the one place something lives. */
export function guide(parent: HTMLElement, ic: ThemeIcon, text: string, go: string, run: () => void, store: DisposableStore): HTMLElement {
	const g = DOM.append(parent, $('button.dset-guide'));
	g.appendChild(icon(ic));
	DOM.append(g, $('span.dset-guide-t', undefined, text));
	const goEl = DOM.append(g, $('span.dset-guide-go', undefined, go));
	goEl.appendChild(icon(Codicon.chevronRight));
	store.add(DOM.addDisposableListener(g, DOM.EventType.CLICK, () => run()));
	return g;
}

export function button(parent: HTMLElement, label: string, run: () => unknown, store: DisposableStore, primary = false): Button {
	const b = store.add(new Button(parent, { ...defaultButtonStyles, secondary: !primary, supportIcons: true }));
	b.label = label;
	b.element.classList.add('dset-btn', primary ? 'dset-btn-solid' : 'dset-btn-ghost');
	store.add(b.onDidClick(() => { void run(); }));
	return b;
}

/** An icon-only button (Remove). */
export function iconButton(parent: HTMLElement, ic: ThemeIcon, title: string, run: () => unknown, store: DisposableStore): HTMLElement {
	const b = DOM.append(parent, $('button.dset-ibtn', { title, 'aria-label': title }));
	b.appendChild(icon(ic));
	store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, e => {
		DOM.EventHelper.stop(e, true);
		void run();
	}));
	return b;
}

/** The single-colour switch of the Customizations pages, with On / Off next to it. */
export function toggle(parent: HTMLElement, title: string, checked: boolean, change: (on: boolean) => Promise<boolean | void>, store: DisposableStore): Checkbox {
	const wrap = DOM.append(parent, $('.dset-toggle'));
	const c = store.add(new Checkbox(title, checked, defaultCheckboxStyles));
	wrap.appendChild(c.domNode);

	store.add(c.onChange(async () => {
		const want = c.checked;
		c.disable();
		let ok: boolean | void = false;
		try {
			ok = await change(want);
		} catch {
			ok = false;
		}
		if (!c.domNode.isConnected) {
			return;
		}
		c.enable();
		if (ok === false) {
			c.checked = !want;
		}
	}));
	return c;
}

/** Several choices, one on: the tab radius, the chosen one on the page colour. */
export function segmented<T extends string>(parent: HTMLElement, label: string, options: readonly { readonly id: T; readonly label: string }[], current: T, pick: (id: T) => void, store: DisposableStore): HTMLElement {
	const seg = DOM.append(parent, $('.dset-seg', { role: 'radiogroup', 'aria-label': label }));
	for (const o of options) {
		const b = DOM.append(seg, $('button', { role: 'radio', 'aria-checked': String(o.id === current) }, o.label));
		b.classList.toggle('on', o.id === current);
		store.add(DOM.addDisposableListener(b, DOM.EventType.CLICK, () => {
			for (const other of seg.children) {
				other.classList.toggle('on', other === b);
				other.setAttribute('aria-checked', String(other === b));
			}
			pick(o.id);
		}));
	}
	return seg;
}

/** A thin bar: how much is used, amber from 80. */
export function meter(parent: HTMLElement, label: string, pct: number, right: string): HTMLElement {
	const m = DOM.append(parent, $('.dset-meter'));
	m.classList.toggle('warn', pct >= 80);
	DOM.append(m, $('span.dset-meter-l', undefined, label));
	const bar = DOM.append(m, $('span.dset-meter-bar'));
	DOM.append(bar, $('i')).style.width = `${pct}%`;
	DOM.append(m, $('span.dset-meter-v', undefined, `${pct}%`));
	DOM.append(m, $('span.dset-meter-r', undefined, right));
	return m;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A ring that fills to the share used, the number in it. */
export function ring(parent: HTMLElement, pct: number): HTMLElement {
	const w = DOM.append(parent, $('.dset-ring'));
	w.classList.toggle('warn', pct >= 80);
	const doc = mainWindow.document;
	const svg = doc.createElementNS(SVG, 'svg');
	svg.setAttribute('width', '40');
	svg.setAttribute('height', '40');
	svg.setAttribute('viewBox', '0 0 40 40');
	svg.setAttribute('aria-hidden', 'true');
	const c = 2 * Math.PI * 17;
	for (const cls of ['tr', 'vl']) {
		const circle = doc.createElementNS(SVG, 'circle');
		circle.setAttribute('cx', '20');
		circle.setAttribute('cy', '20');
		circle.setAttribute('r', '17');
		circle.setAttribute('class', cls);
		if (cls === 'vl') {
			circle.setAttribute('stroke-dasharray', String(c));
			circle.setAttribute('stroke-dashoffset', String(c * (1 - pct / 100)));
			circle.style.setProperty('--c', String(c));
		}
		svg.appendChild(circle);
	}
	w.appendChild(svg);
	DOM.append(w, $('span.dset-ring-v', undefined, `${pct}%`));
	return w;
}

/** The empty state: a 24 icon, a title, one sentence, at most one button. */
export function empty(parent: HTMLElement, ic: ThemeIcon, title: string, text: string): HTMLElement {
	const e = DOM.append(parent, $('.dset-empty'));
	e.appendChild(icon(ic));
	DOM.append(e, $('.dset-empty-t', undefined, title));
	DOM.append(e, $('.dset-empty-s', undefined, text));
	return e;
}

/** Next to a part read from a server or another program: when it was read ("Updated 3 min ago"), and a small spinner
 *  while it is read again; the page shows the last answer meanwhile (design/settings-fast). `when` gives the time the
 *  numbers themselves are from, when the answer says (an allowance read earlier and kept). */
export function freshness(parent: HTMLElement, key: SettingsDataKey, store: DisposableStore, when?: () => number | undefined, word: 'updated' | 'checked' = 'updated'): HTMLElement {
	const el = DOM.append(parent, $('span.dset-fresh'));
	el.dataset.fresh = key;
	const spin = el.appendChild(icon(ThemeIcon.modify(Codicon.loading, 'spin')));
	const text = DOM.append(el, $('span'));
	const draw = (busy: boolean) => {
		const at = when?.() ?? settingsData.at(key);
		spin.hidden = !busy;
		const ago = at ? agoText(at, Date.now()) : '';
		text.textContent = !at
			? (busy ? localize('dispatchSettings.freshFirst', "Checking") : '')
			: word === 'checked' ? localize('dispatchSettings.freshChecked', "Checked {0}", ago) : localize('dispatchSettings.freshUpdated', "Updated {0}", ago);
		el.hidden = !busy && !at;
		el.title = busy ? localize('dispatchSettings.freshBusy', "Reading it again now") : '';
	};
	store.add(autorun(reader => draw(settingsData.busy.read(reader).has(key))));
	const tick = setInterval(() => draw(settingsData.busy.get().has(key)), 30_000);
	store.add({ dispose: () => clearInterval(tick) });
	return el;
}

/** A part never read on this Mac yet (its first Settings, before the first answer): one quiet line, no placeholder
 *  rows; every later visit draws the last answer instead. */
export function pending(parent: HTMLElement, text?: string): HTMLElement {
	const p = DOM.append(parent, $('.dset-pending'));
	p.appendChild(icon(ThemeIcon.modify(Codicon.loading, 'spin')));
	DOM.append(p, $('span', undefined, text ?? localize('dispatchSettings.pending', "Reading it for the first time")));
	return p;
}

export function problem(parent: HTMLElement, text: string): HTMLElement {
	return DOM.append(parent, $('.dset-problem', { role: 'alert' }, text));
}
