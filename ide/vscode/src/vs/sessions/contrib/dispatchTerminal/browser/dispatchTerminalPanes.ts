/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a terminal session split into panes, side by side or one above the other.
 *
 *  Learned from Orca's split terminal tabs (https://github.com/stablyai/orca, terminal-pane; MIT, notice in
 *  dispatchTerminalModel.ts): ⌘D opens a shell to the right of the pane the keyboard is in, ⌘⇧D one below it, ⌘W
 *  closes that pane, ⌘] and ⌘[ move between panes, ⌘⇧Enter gives one pane the whole space and back. The panes
 *  are drawn with VS Code's own SplitView (the dividers drag the way the window's own do) and each pane is a
 *  terminal of its own in Dispatch's terminal daemon, so the panes and their sizes come back after a restart.
 *
 *  A pane moves by its grip (a small handle at its top while the session is split): dragged onto another pane it
 *  goes to the edge it is dropped nearest to, as Orca's tabs do when dropped on a pane's edge.
 *
 *  The session's first pane is the session itself (its agent, its row in the list); the others are shells it
 *  opened. The layout lives in dispatchTerminalModel.ts (PaneLayout) and with the terminal in the daemon.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { IView, Sizing, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Color } from '../../../../base/common/color.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { agentsPanelBorder } from '../../../common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PaneLayout, paneIds, PaneSide, paneSideAt } from './dispatchTerminalModel.js';

const PANE_MIME = 'application/x-dispatch-terminal-pane';

/** A pane dragged onto another pane's edge. */
export type PaneMove = (id: string, target: string, side: PaneSide) => void;
import { DispatchTerminalSession } from './dispatchTerminalSessionsProvider.js';

const MIN_PANE = 80;

/** The shape of a layout without its sizes: a drag of a divider changes sizes, not the shape. */
function shape(layout: PaneLayout): string {
	return 'pane' in layout ? layout.pane : `${layout.dir}(${layout.children.map(shape).join(',')})`;
}

type Dir = 'row' | 'column';

/** (width, height) from a view's size along its parent's direction and the size across it. */
function box(dir: Dir, size: number, across: number): { width: number; height: number } {
	return dir === 'row' ? { width: size, height: across } : { width: across, height: size };
}

interface INode extends IView<number> {
	/** The same layout with the sizes as the person left them. */
	read(): PaneLayout;
}

class Leaf implements INode {
	readonly element: HTMLElement;
	readonly minimumSize = MIN_PANE;
	readonly maximumSize = Number.POSITIVE_INFINITY;
	readonly onDidChange = Event.None;

	/** The screen is in the pane (attached to its terminal the first time). */
	readonly ready: Promise<void>;

	constructor(readonly id: string, private readonly _dir: Dir, private readonly _session: DispatchTerminalSession, store: DisposableStore, onMove: PaneMove) {
		this.element = $('.dispatch-terminal-pane');
		this.element.dataset.pane = id;
		this.ready = _session.paneController(id)?.show(this.element) ?? Promise.resolve();
		this._movable(store, onMove);
	}

	/** The grip that moves this pane, and this pane as a place to drop another one. */
	private _movable(store: DisposableStore, onMove: PaneMove): void {
		const grip = append(this.element, $('.dispatch-terminal-pane-grip', { draggable: 'true', title: 'Drag onto another pane to move this one there', 'aria-label': 'Move pane' }));
		append(grip, $(`span${ThemeIcon.asCSSSelector(Codicon.gripper)}`));
		store.add(addDisposableListener(grip, EventType.DRAG_START, e => {
			e.dataTransfer?.setData(PANE_MIME, this.id);
			e.dataTransfer?.setData('text/plain', '');
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
			}
		}));
		let drop: HTMLElement | undefined;
		const clear = () => { drop?.remove(); drop = undefined; };
		const side = (e: DragEvent): PaneSide => {
			const r = this.element.getBoundingClientRect();
			return paneSideAt((e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height));
		};
		const ours = (e: DragEvent) => !!e.dataTransfer?.types.includes(PANE_MIME);
		store.add(addDisposableListener(this.element, EventType.DRAG_OVER, e => {
			if (!ours(e)) {
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			drop ??= append(this.element, $('.dispatch-terminal-pane-drop'));
			drop.className = `dispatch-terminal-pane-drop ${side(e)}`;
		}));
		store.add(addDisposableListener(this.element, EventType.DRAG_LEAVE, e => {
			if (!this.element.contains(e.relatedTarget as Node | null)) {
				clear();
			}
		}));
		store.add(addDisposableListener(this.element, EventType.DROP, e => {
			const id = e.dataTransfer?.getData(PANE_MIME);
			const at = side(e);
			clear();
			if (!id) {
				return;
			}
			e.preventDefault();
			if (id !== this.id) {
				onMove(id, this.id, at);
			}
		}));
		store.add(addDisposableListener(grip, EventType.DRAG_END, clear));
		store.add({ dispose: clear });
	}

	layout(size: number, _offset: number, across: number | undefined): void {
		const { width, height } = box(this._dir, size, across ?? 0);
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this._session.paneController(this.id)?.layout(width, height);
	}

	read(): PaneLayout {
		return { pane: this.id };
	}
}

class Branch extends Disposable implements INode {
	readonly element: HTMLElement;
	readonly minimumSize = MIN_PANE;
	readonly maximumSize = Number.POSITIVE_INFINITY;
	readonly onDidChange = Event.None;
	private readonly _split: SplitView<number, INode>;
	private readonly _children: INode[] = [];

	get nodes(): readonly INode[] {
		return this._children;
	}
	private _sized = false;

	constructor(private readonly _layout: Extract<PaneLayout, { dir: Dir }>, private readonly _dir: Dir, session: DispatchTerminalSession, separator: Color, onSash: () => void, onMove: PaneMove) {
		super();
		this.element = $('.dispatch-terminal-panes-branch');
		this._split = this._register(new SplitView<number, INode>(this.element, {
			orientation: _layout.dir === 'row' ? Orientation.HORIZONTAL : Orientation.VERTICAL,
			proportionalLayout: true,
			styles: { separatorBorder: separator },
		}));
		for (const child of _layout.children) {
			const node = 'pane' in child ? new Leaf(child.pane, _layout.dir, session, this._store, onMove) : this._register(new Branch(child, _layout.dir, session, separator, onSash, onMove));
			this._children.push(node);
			this._split.addView(node, Sizing.Distribute, undefined, true);
		}
		this._register(this._split.onDidSashChange(() => onSash()));
	}

	style(separator: Color): void {
		this._split.style({ separatorBorder: separator });
		for (const c of this._children) {
			if (c instanceof Branch) {
				c.style(separator);
			}
		}
	}

	layout(size: number, _offset: number, across: number | undefined): void {
		const { width, height } = box(this._dir, size, across ?? 0);
		const along = this._layout.dir === 'row' ? width : height;
		this._split.layout(along, this._layout.dir === 'row' ? height : width);
		const sizes = this._layout.sizes;
		if (!this._sized && along > 0) {
			this._sized = true;
			if (sizes && sizes.length === this._children.length) {
				const total = sizes.reduce((a, b) => a + b, 0);
				sizes.slice(0, -1).forEach((s, i) => this._split.resizeView(i, Math.round(along * s / total)));
			} else {
				this._split.distributeViewSizes();
			}
		}
	}

	read(): PaneLayout {
		return { dir: this._layout.dir, children: this._children.map(c => c.read()), sizes: this._children.map((_, i) => this._split.getViewSize(i)) };
	}
}

/** The panes of one session in its view's terminal area. */
export class DispatchTerminalPanes extends Disposable {
	private readonly _drawing = this._register(new DisposableStore());
	private _root: INode | undefined;
	private _drawn = '';
	private _size: { width: number; height: number } | undefined;
	private _sashTimer: ReturnType<typeof setTimeout> | undefined;
	/** Every pane of the last drawing has its screen. */
	ready: Promise<void> = Promise.resolve();

	constructor(
		private readonly _session: DispatchTerminalSession,
		private readonly _host: HTMLElement,
		private readonly _onSizes: (layout: PaneLayout) => void,
		private readonly _onMove: PaneMove,
		@IThemeService private readonly _themes: IThemeService,
	) {
		super();
		this._host.classList.add('dispatch-terminal-panes');
		this._register(autorun(reader => {
			const layout = this._session.layout.read(reader);
			const expanded = this._session.expanded.read(reader);
			const drawn = expanded ? `expanded:${expanded}` : shape(layout);
			if (drawn !== this._drawn) {
				this._draw(expanded ? { pane: expanded } : layout, drawn);
			}
		}));
		this._register(autorun(reader => {
			const focused = this._session.focusedPane.read(reader);
			const many = paneIds(this._session.layout.read(reader)).length > 1 && !this._session.expanded.read(reader);
			this._host.classList.toggle('split', many);
			for (const el of this._host.querySelectorAll<HTMLElement>('.dispatch-terminal-pane')) {
				el.classList.toggle('focused', many && el.dataset.pane === focused);
			}
		}));
		this._register(this._themes.onDidColorThemeChange(() => {
			if (this._root instanceof Branch) {
				this._root.style(this._separator());
			}
		}));
		this._register({ dispose: () => clearTimeout(this._sashTimer) });
	}

	/** The divider between panes: the window's hairline (DESIGN.md --hair), the one line a panel may have. */
	private _separator(): Color {
		return this._themes.getColorTheme().getColor(agentsPanelBorder) ?? Color.transparent;
	}

	private _draw(layout: PaneLayout, drawn: string): void {
		this._drawing.clear();
		clearNode(this._host);
		this._drawn = drawn;
		const onSash = () => {
			clearTimeout(this._sashTimer);
			this._sashTimer = setTimeout(() => {
				const read = this._root?.read();
				if (read && !this._session.expanded.get()) {
					this._onSizes(read);
				}
			}, 300);
		};
		this._root = 'pane' in layout ? new Leaf(layout.pane, 'row', this._session, this._drawing, this._onMove) : this._drawing.add(new Branch(layout, 'row', this._session, this._separator(), onSash, this._onMove));
		append(this._host, this._root.element);
		const leaves: Leaf[] = [];
		const collect = (n: INode) => n instanceof Leaf ? leaves.push(n) : (n as Branch).nodes.forEach(collect);
		collect(this._root);
		this.ready = Promise.all(leaves.map(l => l.ready.catch(() => undefined))).then(() => undefined);
		const focused = this._session.focusedPane.get();
		for (const el of this._host.querySelectorAll<HTMLElement>('.dispatch-terminal-pane')) {
			el.classList.toggle('focused', paneIds(layout).length > 1 && el.dataset.pane === focused);
		}
		if (this._size) {
			this.layout(this._size.width, this._size.height);
		}
	}

	layout(width: number, height: number): void {
		this._size = { width, height };
		this._root?.layout(width, 0, height);
	}

	/** The pane the keyboard was in last, or the first. */
	focus(): void {
		(this._session.paneController(this._session.focusedPane.get()) ?? this._session.controller).focus();
	}
}
