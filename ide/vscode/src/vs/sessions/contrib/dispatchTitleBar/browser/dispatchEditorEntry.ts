/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the two buttons beside the session title in the middle of the title bar (the user's call 10-10,
 *  preference "Editor 和 Terminal 挨着标题"): "Terminal" on its left, "Editor" on its right. Until then Editor was
 *  first of the icons at the top right and Terminal the first block of the bottom bar. Both are icon buttons with
 *  no frame, as the title bar's others (preference「图标按钮不带字不带框」). Each shows only its icon until the pointer is on
 *  it, then its word slides out and the icon takes colour, as the editor window's Dispatch Agent button does. Editor opens this session's folder in the
 *  editor window (OpenSessionInVSCodeAction, sessions/electron-browser/actions/vscodeActions.ts, which puts it in
 *  the menu); Terminal shows and hides the panel at the bottom and stays pressed while it is open.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchTitleBar.css';
import { ensureDispatchPalette } from '../../../../base/browser/dispatchPalette.js';
import * as DOM from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext } from '../../../common/contextkeys.js';
import { agentsNewSessionButtonForeground } from '../../../common/theme.js';

/** OpenSessionInVSCodeAction (sessions/electron-browser/actions/vscodeActions.ts): this session's folder in the editor window. */
export const DISPATCH_OPEN_IN_EDITOR = 'agents.openSessionInVSCode';
/** The panel at the bottom (the terminal), shown or hidden: what the bottom bar's Terminal block ran. */
const TOGGLE_TERMINAL = 'workbench.action.togglePanel';

interface ICapsule {
	/** data-part, and the class after `dispatch-` on the button */
	readonly part: string;
	readonly label: string;
	readonly icon: () => HTMLElement;
	readonly tip: () => string;
	/** For a switch: whether it is on now, and when that changes. */
	readonly pressed?: { readonly read: () => boolean; readonly onChange: Event<unknown> };
}

/** An icon button (New ⌘N's Button and class, without its frame), its word sliding out on hover. */
class TitleCapsuleItem extends BaseActionViewItem {

	private button: Button | undefined;

	constructor(
		action: IAction,
		private readonly capsule: ICapsule,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		ensureDispatchPalette(); // the Editor icon's hover colour (--dispatch-icon-blue)
		const c = this.capsule;
		container.classList.add('dispatch-title-side-item');
		const button = this._register(new Button(container, {
			...defaultButtonStyles,
			// an icon button, no frame (preference「图标按钮不带字不带框」): the toolbar's hover fill only
			buttonSecondaryBackground: 'transparent',
			buttonSecondaryForeground: asCssVariable(agentsNewSessionButtonForeground),
			buttonSecondaryHoverBackground: 'var(--vscode-toolbar-hoverBackground)',
			buttonSecondaryBorder: 'transparent',
			secondary: true,
		}));
		this.button = button;
		const b = button.element;
		b.classList.add('agent-sessions-compact-new-button', 'dispatch-title-side', `dispatch-${c.part}`);
		b.dataset.part = c.part;
		DOM.reset(b, c.icon(), DOM.$('span.dispatch-title-side-t', undefined, c.label));
		b.setAttribute('aria-label', c.label);
		this._register(this.hoverService.setupDelayedHover(b, () => ({
			content: c.tip(),
			appearance: { compact: true },
			position: { hoverPosition: HoverPosition.BELOW },
		})));
		if (c.pressed) {
			const draw = () => {
				const on = c.pressed!.read();
				b.classList.toggle('on', on);
				b.setAttribute('aria-pressed', String(on));
			};
			draw();
			this._register(c.pressed.onChange(draw));
		}
		this._register(button.onDidClick(e => {
			// the <li> runs the action on a click too
			DOM.EventHelper.stop(e, true);
			if (this.action.enabled) {
				void this.actionRunner.run(this.action, this._context);
			}
		}));
		this.updateEnabled();
	}

	protected override updateEnabled(): void {
		if (this.button) {
			this.button.enabled = this.action.enabled;
		}
	}
}

class DispatchTitleSides extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dispatchEditorEntry';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		const editorLabel = localize('dispatchEditorTop.label', "Editor");
		const editor: ICapsule = {
			part: 'editor-top',
			label: editorLabel,
			icon: () => DOM.$('span.dispatch-editor-top-ic', { 'aria-hidden': 'true' }),
			tip: () => localize('dispatchEditorTop.tip', "Open this folder in the editor window"),
		};
		this._register(actionViewItemService.register(Menus.TitleBarCenterRight, DISPATCH_OPEN_IN_EDITOR, action => instantiationService.createInstance(TitleCapsuleItem, action, editor), undefined));

		const terminalOpen = () => layoutService.isVisible(Parts.PANEL_PART, mainWindow);
		const terminal: ICapsule = {
			part: 'terminal-top',
			label: localize('dispatchTerminalTop.label', "Terminal"),
			icon: () => DOM.$(`span.dispatch-terminal-top-ic${ThemeIcon.asCSSSelector(Codicon.terminal)}`, { 'aria-hidden': 'true' }),
			tip: () => terminalOpen()
				? localize('dispatchTerminalTop.tipHide', "Hide the terminal (⌃`)")
				: localize('dispatchTerminalTop.tipShow', "Show the terminal (⌃`)"),
			pressed: { read: terminalOpen, onChange: layoutService.onDidChangePartVisibility },
		};
		// the item's look first, then the entry: a toolbar draws an item once, with what is registered then
		this._register(actionViewItemService.register(Menus.TitleBarCenterLeft, TOGGLE_TERMINAL, action => instantiationService.createInstance(TitleCapsuleItem, action, terminal), undefined));
		this._register(MenuRegistry.appendMenuItem(Menus.TitleBarCenterLeft, {
			command: { id: TOGGLE_TERMINAL, title: terminal.label, icon: Codicon.terminal },
			group: 'navigation',
			order: 0,
			when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext.negate()),
		}));
	}
}

registerWorkbenchContribution2(DispatchTitleSides.ID, DispatchTitleSides, WorkbenchPhase.BlockRestore);
