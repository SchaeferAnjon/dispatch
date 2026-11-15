/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: "Symbols and Motion", a page in the middle of the Agents window that shows every
 *  Dispatch symbol and plays the seven motions (patches/050-blocks.patch). For whoever
 *  builds a page with them, and for checking a build: Command Palette › "Show Dispatch Symbols and Motion".
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchBlocksShowcase.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { constObservable, IObservable } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionsCategories } from '../../../common/categories.js';
import { AbstractCustomView } from '../../../services/customView/browser/customView.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { arrive, assistantMark, DISPATCH_STATE_LABEL, DispatchBlockGlyph, DispatchBlockIcons, engineBlock, handoffLine, handoffTravel, knock, linkMark, onlineDot, resetAssistantMark, rollCount, setAssistantMarkState, setLinkState, stateBlock } from './dispatchBlocks.js';

export const DISPATCH_BLOCKS_VIEW_ID = 'dispatch.blocks.showcase';

const GROUPS: { title: string; note: string; glyphs: DispatchBlockGlyph[] }[] = [
	{ title: localize('blocks.states', "States"), note: localize('blocks.statesNote', "The colour is the state; the mark inside says it again for anyone who can't tell the colours apart."), glyphs: ['working', 'waiting', 'done', 'handoff', 'stopped', 'todo', 'sub-agent', 'step-now'] },
	{ title: localize('blocks.things', "Things"), note: localize('blocks.thingsNote', "What Dispatch keeps track of."), glyphs: ['assistant', 'task', 'plan', 'delivery', 'delivery-new', 'pass-on'] },
	{ title: localize('blocks.devices', "Devices"), note: localize('blocks.devicesNote', "A Mac or the phone."), glyphs: ['macbook', 'mac-mini', 'iphone'] },
	{ title: localize('blocks.places', "Places and actions"), note: localize('blocks.placesNote', "Line icons on the same rounded block. A folder stays a folder."), glyphs: ['folder', 'automations', 'chats', 'knowledge', 'settings', 'editor', 'new', 'plus', 'search', 'filter', 'sidebar', 'right-panel', 'theme', 'permission', 'branch', 'send', 'stop', 'open', 'claude'] },
];

class DispatchBlocksShowcase extends AbstractCustomView {

	readonly title: IObservable<string> = constObservable(localize('blocks.title', "Symbols and Motion"));
	override readonly description: IObservable<string | undefined> = constObservable(localize('blocks.description', "Dispatch's own symbols and the seven ways they move. With Reduce motion on, all of them stay still."));

	render(container: HTMLElement): void {
		const root = dom.append(container, dom.$('.dispatch-blocks-showcase'));
		for (const g of GROUPS) {
			const sec = dom.append(root, dom.$('section.dbs-group'));
			dom.append(sec, dom.$('h3', undefined, g.title));
			dom.append(sec, dom.$('p.dbs-note', undefined, g.note));
			const grid = dom.append(sec, dom.$('.dbs-glyphs'));
			for (const name of g.glyphs) {
				const cell = dom.append(grid, dom.$('.dbs-glyph'));
				cell.dataset.glyph = name;
				dom.append(cell, dom.$(`span.dbs-big${ThemeIcon.asCSSSelector(DispatchBlockIcons[name])}`));
				dom.append(cell, dom.$(`span.dbs-small${ThemeIcon.asCSSSelector(DispatchBlockIcons[name])}`));
				dom.append(cell, dom.$('span.dbs-name', undefined, name));
			}
		}
		const engines = dom.append(root, dom.$('section.dbs-group'));
		dom.append(engines, dom.$('h3', undefined, localize('blocks.engines', "Engines")));
		dom.append(engines, dom.$('p.dbs-note', undefined, localize('blocks.enginesNote', "Each engine's own mark in the same small block, as in the input box and the Now tab.")));
		const eg = dom.append(engines, dom.$('.dbs-row'));
		for (const [icon, name] of [[Codicon.claude, 'Claude Code'], [Codicon.openai, 'Codex'], [ThemeIcon.fromId('dispatch-opencode'), 'OpenCode']] as const) {
			const c = dom.append(eg, dom.$('.dbs-chip'));
			c.appendChild(engineBlock(icon));
			dom.append(c, dom.$('span', undefined, name));
		}

		const motion = dom.append(root, dom.$('section.dbs-group'));
		dom.append(motion, dom.$('h3', undefined, localize('blocks.motion', "Motion")));
		dom.append(motion, dom.$('p.dbs-note', undefined, localize('blocks.motionNote', "One-off motions take 200 ms or less (the check 350 ms). Loops run only while something is going on.")));
		const cards = dom.append(motion, dom.$('.dbs-cards'));
		const card = (id: string, title: string, what: string, spec: string, build: (stage: HTMLElement) => (() => void) | void) => {
			const c = dom.append(cards, dom.$('.dbs-card'));
			c.dataset.motion = id;
			const stage = dom.append(c, dom.$('.dbs-stage'));
			const replay = build(stage);
			const head = dom.append(c, dom.$('.dbs-card-head'));
			dom.append(head, dom.$('b', undefined, title));
			if (replay) {
				const btn = dom.append(head, dom.$<HTMLButtonElement>('button.dbs-replay', { type: 'button' }, localize('blocks.replay', "Replay")));
				this._register(dom.addDisposableListener(btn, 'click', replay));
			}
			dom.append(c, dom.$('p', undefined, what));
			dom.append(c, dom.$('p.dbs-spec', undefined, spec));
		};
		const row = (stage: HTMLElement, slot: HTMLElement, text: string) => {
			const r = dom.append(stage, dom.$('.dbs-mrow'));
			dom.append(r, dom.$('span.dbs-slot')).appendChild(slot);
			dom.append(r, dom.$('span.dbs-t', undefined, text));
			return r;
		};

		card('done', localize('blocks.m1', "Task done"), localize('blocks.m1What', "The block fills in and the check draws itself, once."), '350ms ease-spring · check 200ms ease-out after 150ms', stage => {
			const r = row(stage, stateBlock('done', { play: true }), localize('blocks.m1Row', "Persist which agents are used"));
			return () => { r.querySelector('.dbs-slot')!.replaceChildren(stateBlock('done', { play: true })); };
		});
		card('working', localize('blocks.m2', "Agent working"), localize('blocks.m2What', "Green blocks breathe while an agent works, all on one clock."), '2.4s each way ease-std · opacity .5 to 1 · scale .84 to 1', stage => {
			row(stage, stateBlock('working', { breathe: true }), localize('blocks.m2Row', "Finding every agent on this Mac"));
			row(stage, stateBlock('step-now'), localize('blocks.m2Row2', "Detect every agent on the Mac"));
		});
		card('waiting', localize('blocks.m3', "Waiting for you"), localize('blocks.m3What', "Amber blocks knock twice, three times in a row when they turn up, then hold still."), '2px lifts · 3 times, 4s apart · ease-out', stage => {
			const b = stateBlock('waiting', { knock: true });
			row(stage, b, localize('blocks.m3Row', "Pick A or B"));
			return () => knock(b);
		});
		card('delivery', localize('blocks.m4', "Delivery arriving"), localize('blocks.m4What', "The new one drops into place, the others slide down, the count ticks up."), 'drop 8px 200ms ease-out · dot 350ms ease-spring · count 150ms', stage => {
			const head = dom.append(stage, dom.$('.dbs-dhead'));
			dom.append(head, dom.$(`span${ThemeIcon.asCSSSelector(DispatchBlockIcons.delivery)}`));
			dom.append(head, dom.$('span', undefined, localize('blocks.delivered', "Delivered")));
			const count = dom.append(head, dom.$('span.dbs-count'));
			rollCount(count, '1');
			const list = dom.append(stage, dom.$('.dbs-tiles'));
			const tile = (label: string, fresh: boolean) => {
				const t = dom.$('.dbs-tile');
				dom.append(t, dom.$(`span${ThemeIcon.asCSSSelector(fresh ? DispatchBlockIcons['delivery-new'] : DispatchBlockIcons.delivery)}`));
				dom.append(t, dom.$('span', undefined, label));
				return t;
			};
			list.appendChild(tile(localize('blocks.m4Old', "Delivery page"), false));
			let n = 1;
			return () => {
				n++;
				list.querySelectorAll(`.codicon-dispatch-delivery-new`).forEach(e => e.className = ThemeIcon.asClassName(DispatchBlockIcons.delivery));
				const t = tile(localize('blocks.m4New', "Build ok on mini"), true);
				list.prepend(t);
				while (list.children.length > 3) {
					list.lastElementChild!.remove();
				}
				arrive(list, t);
				rollCount(count, String(n));
			};
		});
		card('handoff', localize('blocks.m5', "Handoff"), localize('blocks.m5What', "When a session is nearly full the work moves to a fresh one; a blue block carries it across."), 'travel 200ms ease-std · old row dims 150ms · one ring 600ms ease-out', stage => {
			const a = row(stage, stateBlock('working', { breathe: true }), localize('blocks.m5Old', "Session lifetime and handoff notes"));
			const target = stateBlock('handoff');
			row(stage, target, localize('blocks.m5New', "Handoff: carry on with the task"));
			stage.appendChild(handoffLine(localize('blocks.m5Line', "Handed over to a fresh session. The notes went along.")));
			return () => { a.classList.remove('dispatch-handoff-from'); void a.offsetWidth; handoffTravel(a.querySelector('.dispatch-block')!, target); };
		});
		card('phone', localize('blocks.m6', "Phone connecting"), localize('blocks.m6What', "Three blocks light in turn while the phone pairs, then join into a line and the phone gets its green dot."), '1.2s loop linear · join 200ms ease-out · dot 350ms ease-spring', stage => {
			const r = dom.append(stage, dom.$('.dbs-pair'));
			dom.append(r, dom.$(`span.dbs-dev${ThemeIcon.asCSSSelector(DispatchBlockIcons.macbook)}`));
			const link = linkMark('connecting');
			r.appendChild(link);
			const phone = dom.append(r, dom.$('span.dbs-phone'));
			dom.append(phone, dom.$(`span.dbs-dev${ThemeIcon.asCSSSelector(DispatchBlockIcons.iphone)}`));
			const cap = dom.append(stage, dom.$('.dbs-cap', undefined, localize('blocks.m6Connecting', "Connecting · keep the app open")));
			let timer: ReturnType<typeof setTimeout> | undefined;
			const play = () => {
				clearTimeout(timer);
				setLinkState(link, 'connecting');
				phone.querySelector('.dispatch-online-dot')?.remove();
				cap.textContent = localize('blocks.m6Connecting', "Connecting · keep the app open");
				timer = setTimeout(() => {
					setLinkState(link, 'connected');
					phone.appendChild(onlineDot(true));
					cap.textContent = localize('blocks.m6Connected', "Connected");
				}, 3600);
			};
			this._register({ dispose: () => clearTimeout(timer) });
			play();
			return play;
		});
		card('assistant', localize('blocks.m7', "The app's mark"), localize('blocks.m7What', "The app's mark is the app icon: its blocks drop in when it first shows, lift in a diagonal wave while it looks, then a new delivery drops its block in again and the green dot breathes while sessions work."), 'drop 380ms, 80ms a block · wave 1.6s loop, 110ms a diagonal', stage => {
			const r = dom.append(stage, dom.$('.dbs-as'));
			const words = dom.append(r, dom.$('div'));
			const h = dom.append(words, dom.$('b'));
			let mark: HTMLElement | undefined;
			const timers: ReturnType<typeof setTimeout>[] = [];
			const play = () => {
				timers.splice(0).forEach(clearTimeout);
				mark?.remove();
				resetAssistantMark('showcase');
				mark = assistantMark(48, 'showcase', { think: true });
				r.insertBefore(mark, words);
				h.textContent = localize('blocks.m7Looking', "Looking through 8 folders");
				timers.push(setTimeout(() => {
					setAssistantMarkState(mark!, { waiting: 3, working: 2, delivered: 1 });
					h.textContent = localize('blocks.m7Found', "3 things wait for you. 2 sessions are working.");
				}, 3200));
				timers.push(setTimeout(() => {
					setAssistantMarkState(mark!, { waiting: 3, working: 2, delivered: 2 });
					h.textContent = localize('blocks.m7Delivered', "Something new was delivered.");
				}, 5200));
			};
			this._register({ dispose: () => timers.forEach(clearTimeout) });
			play();
			return play;
		});

		const legend = dom.append(root, dom.$('section.dbs-group'));
		dom.append(legend, dom.$('h3', undefined, localize('blocks.rows', "On a session row")));
		const lr = dom.append(legend, dom.$('.dbs-row'));
		for (const s of ['waiting', 'stopped', 'done', 'handoff', 'sub-agent', 'todo'] as const) {
			const c = dom.append(lr, dom.$('.dbs-chip'));
			c.appendChild(stateBlock(s));
			dom.append(c, dom.$('span', undefined, DISPATCH_STATE_LABEL[s]));
		}
	}

	layout(_width: number, _height: number): void { }
}

class DispatchBlocksShowcaseContribution extends Disposable {
	static readonly ID = 'dispatch.contrib.blocksShowcase';
	constructor(@ICustomViewService customViewService: ICustomViewService) {
		super();
		this._register(customViewService.registerCustomView({ id: DISPATCH_BLOCKS_VIEW_ID, ctor: new SyncDescriptor(DispatchBlocksShowcase) }));
	}
}

registerWorkbenchContribution2(DispatchBlocksShowcaseContribution.ID, DispatchBlocksShowcaseContribution, WorkbenchPhase.BlockRestore);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dispatch.blocks.showcase',
			title: localize2('blocks.show', "Show Dispatch Symbols and Motion"),
			category: SessionsCategories.Sessions,
			f1: true,
			precondition: IsSessionsWindowContext,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ICustomViewService).showCustomView(DISPATCH_BLOCKS_VIEW_ID);
	}
});
