/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the Agents window's own Settings (kanban task-tjor, design/settings direction B).
 *
 *  - ⌘, in the Agents window opens it (the editor window keeps VS Code's settings), as do "Settings" at the
 *    bottom of the side bar and "Settings…" in the account menu.
 *  - The whole window becomes Settings: the side bar shows its contents (dispatchSettingsNav.ts), the middle
 *    the page (dispatchSettingsView.ts, a custom view). "‹ Sessions" or Esc goes back to where you were.
 *  - Customizations live here now, as Abilities: the pane at the bottom of the side bar is gone
 *    (sessionsView.ts), and anything that asks for the Customizations editor (a slash command's Open, a link
 *    in a session, "Manage Providers…") lands on the matching Settings page instead of the modal editor.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchSettings.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { AICustomizationManagementEditor } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditor.js';
import { AICustomizationManagementCommands } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { AGENT_PAGES, ABILITIES, pageForSection, SETTINGS_NAV, SettingsPageId } from './dispatchSettingsModel.js';
import { DispatchSettingsNav } from './dispatchSettingsNav.js';
import { DISPATCH_SETTINGS_CLOSE, DISPATCH_SETTINGS_OPEN, DISPATCH_SETTINGS_VIEW_ID, escapeWasForAPopup, goToSettingsPage, noteEscape, setSettingsOpen } from './dispatchSettingsState.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { DispatchSettingsView } from './dispatchSettingsView.js';
import { settingsData } from './dispatchSettingsData.js';
// "Key saved" from wherever a key was saved: `_dispatch.envChanged` is registered there
import './dispatchSettingsKeysToast.js';

export const DispatchSettingsVisibleContext = new RawContextKey<boolean>('dispatchSettingsVisible', false, localize('dispatchSettings.visibleKey', "Whether the Agents window shows its Settings"));

const PAGES: ReadonlySet<string> = new Set<string>(['overview', 'abilities', 'changes', 'editor', 'findskills', 'usage', ...SETTINGS_NAV.map(n => n.id), ...ABILITIES.map(n => n.id), ...AGENT_PAGES.map(n => n.id)]);

let controller: DispatchSettingsContribution | undefined;

class DispatchSettingsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'dispatch.contrib.settings';

	private readonly nav: DispatchSettingsNav;
	private readonly visibleKey: IContextKey<boolean>;
	/** The page in the middle before Settings (another custom view), to go back to. */
	private previousView: string | undefined;
	private wasVisible = false;
	private focusSearchOnShow = false;
	private readonly openOverride = this._register(new MutableDisposable());

	constructor(
		@ICustomViewService private readonly customViewService: ICustomViewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		controller = this;
		// what the pages show, kept from the last window; on this Mac's first window, read once the window settled (the
		// external parts too: the allowances, the agents, the network check), so
		// Settings then opens with everything drawn (design/settings-fast)
		settingsData.init(commandService, storageService);
		const settle = setTimeout(() => {
			this._register(DOM.runWhenWindowIdle(mainWindow, () => void settingsData.fillMissing(['watch', 'agents', 'accounts', 'net']), 5_000));
		}, 5_000);
		this._register({ dispose: () => clearTimeout(settle) });
		this._register({ dispose: () => { if (controller === this) { controller = undefined; } } });
		this.visibleKey = DispatchSettingsVisibleContext.bindTo(contextKeyService);
		this.nav = this._register(instantiationService.createInstance(DispatchSettingsNav));
		this._register(customViewService.registerCustomView({ id: DISPATCH_SETTINGS_VIEW_ID, ctor: new SyncDescriptor(DispatchSettingsView) }, { restore: false }));
		this._register(autorun(reader => {
			const visible = customViewService.activeCustomView.read(reader)?.id === DISPATCH_SETTINGS_VIEW_ID;
			if (visible === this.wasVisible) {
				return;
			}
			this.wasVisible = visible;
			this.visibleKey.set(visible);
			setSettingsOpen(visible);
			if (visible) {
				// what is kept on this Mac, read again in one go; the page on screen follows when it changed
				void settingsData.refreshLocal();
				this.nav.show(this.focusSearchOnShow);
				this.focusSearchOnShow = false;
			} else {
				this.nav.hide();
			}
		}));

		// an Escape that closes a popup over Settings (the phone's pairing, a hover card, a menu) leaves Settings open
		this._register(DOM.addDisposableListener(mainWindow, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				// shown ones only: a hover's element can stay in the page after it closed
				const popups = mainWindow.document.querySelectorAll<HTMLElement>('.monaco-hover, .context-view .monaco-menu-container, .quick-input-widget:not([style*="display: none"])');
				noteEscape([...popups].some(p => p.getClientRects().length > 0 && mainWindow.getComputedStyle(p).visibility !== 'hidden'));
			}
		}, true));

		// Customizations asked for by command (account menu, links, the agent host): the Settings page instead
		this.overrideOpenEditor();
		this._register(CommandsRegistry.onDidRegisterCommand(id => {
			if (id === AICustomizationManagementCommands.OpenEditor && !this.overriding) {
				this.overrideOpenEditor();
			}
		}));
		// ... and opened straight as an editor: its page in Settings, the modal closed before it shows
		this._register(editorService.onDidActiveEditorChange(() => this.redirectEditor()));
	}

	private overriding = false;

	private overrideOpenEditor(): void {
		this.overriding = true;
		try {
			this.openOverride.value = CommandsRegistry.registerCommand(AICustomizationManagementCommands.OpenEditor, (_accessor, target?: unknown) => {
				let section: string | undefined;
				let harness: string | undefined;
				let migration = false;
				if (typeof target === 'string') {
					section = target;
				} else if (target && typeof target === 'object') {
					const t = target as { section?: string; sessionType?: string; migration?: boolean };
					section = t.section;
					harness = t.sessionType;
					migration = !!t.migration;
				}
				this.open(migration ? 'changes' : pageForSection(section, harness ?? this.harnessService.activeHarness.get()));
			});
		} finally {
			this.overriding = false;
		}
	}

	private redirectEditor(): void {
		const pane = this.editorService.activeEditorPane;
		if (!(pane instanceof AICustomizationManagementEditor)) {
			return;
		}
		// the caller picks the section right after the editor opened: read it a moment later
		setTimeout(() => {
			const section = pane.dispatchSelectedSection;
			const page = section ? pageForSection(section, this.harnessService.activeHarness.get()) : 'abilities';
			const input = pane.input;
			if (input) {
				void pane.group.closeEditor(input);
			}
			this.open(page);
		}, 0);
	}

	open(page?: string, flash?: string, focusSearch = false): void {
		const active = this.customViewService.activeCustomView.get();
		const fresh = active?.id !== DISPATCH_SETTINGS_VIEW_ID;
		if (fresh) {
			this.previousView = active?.id;
			this.focusSearchOnShow = focusSearch;
		}
		if (page && PAGES.has(page)) {
			goToSettingsPage(page as SettingsPageId, flash);
		} else if (fresh) {
			goToSettingsPage('overview');
		}
		this.customViewService.showCustomView(DISPATCH_SETTINGS_VIEW_ID);
	}

	close(): void {
		if (this.customViewService.activeCustomView.get()?.id !== DISPATCH_SETTINGS_VIEW_ID) {
			return;
		}
		const previous = this.previousView;
		this.previousView = undefined;
		if (previous) {
			this.customViewService.showCustomView(previous);
		} else {
			this.customViewService.hideCustomView();
		}
	}

	toggle(): void {
		if (this.customViewService.activeCustomView.get()?.id === DISPATCH_SETTINGS_VIEW_ID) {
			this.close();
		} else {
			this.open();
		}
	}
}
registerWorkbenchContribution2(DispatchSettingsContribution.ID, DispatchSettingsContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_SETTINGS_OPEN,
			title: localize2('dispatchSettings.open', "Settings"),
			icon: Codicon.settingsGear,
			f1: true,
			precondition: IsSessionsWindowContext,
			keybinding: {
				// above VS Code's own ⌘, (workbench.action.openSettings), only in the Agents window
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: IsSessionsWindowContext,
				primary: KeyMod.CtrlCmd | KeyCode.Comma,
			},
		});
	}
	run(_accessor: ServicesAccessor, page?: unknown, flash?: unknown): void {
		const c = controller;
		if (!c) {
			return;
		}
		if (page === undefined) {
			// ⌘, a second time goes back, like the button that opened it
			c.toggle();
			return;
		}
		c.open(typeof page === 'string' ? page : undefined, typeof flash === 'string' ? flash : undefined);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: DISPATCH_SETTINGS_CLOSE,
			title: localize2('dispatchSettings.close', "Close Settings"),
			precondition: DispatchSettingsVisibleContext,
			keybinding: {
				// Esc anywhere but in a text field (the page and the side bar's search handle their own first)
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(DispatchSettingsVisibleContext, InputFocusedContext.negate()),
				primary: KeyCode.Escape,
			},
		});
	}
	run(): void {
		if (!escapeWasForAPopup()) {
			controller?.close();
		}
		noteEscape(false);
	}
});

// the account menu's last row
MenuRegistry.appendMenuItem(Menus.AccountMenu, {
	command: { id: DISPATCH_SETTINGS_OPEN, title: localize('dispatchSettings.menu', "Settings…") },
	group: 'z_dispatchSettings',
	order: 1,
});

