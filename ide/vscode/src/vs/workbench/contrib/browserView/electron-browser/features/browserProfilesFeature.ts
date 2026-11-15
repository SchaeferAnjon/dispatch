/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewUri } from '../../../../../platform/browserView/common/browserViewUri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserActionCategory, BrowserActionGroup, BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../browserEditor.js';
import { DEFAULT_BROWSER_PROFILE, IBrowserProfilesService } from '../browserProfilesService.js';
import { BrowserNavigationFeatures } from './browserNavigationFeatures.js';
import './browserProfilesFeature.css';

/**
 * Dispatch: the login identity button at the start of the address bar and its menu (kanban task-jj19).
 * The button names the identity the page is signed in with ("Work"); with only the default identity it
 * is just the person icon. The menu switches the page to another identity (the page reloads with that
 * identity's sign-ins and new pages use it too), adds one, brings Chrome's logins into it, renames or
 * removes it. Agents open pages with an identity by name (`open_browser_page` with `profile`, or
 * `dispatch browser --ide open <url> --profile <name>`).
 */

export const SWITCH_BROWSER_IDENTITY_ID = 'workbench.action.browser.switchIdentity';
const IMPORT_FROM_CHROME_ID = 'workbench.action.browser.importFromChrome';

class BrowserIdentityContribution extends BrowserEditorContribution {
	private readonly _container: HTMLElement;
	private readonly _button: Button;

	constructor(
		editor: BrowserEditor,
		@IBrowserProfilesService private readonly profiles: IBrowserProfilesService,
		@ICommandService commandService: ICommandService,
	) {
		super(editor);
		// the share toggle's look (a small borderless button in the address bar), no style of its own
		this._container = $('.browser-share-toggle-container.dispatch-browser-identity');
		this._button = this._register(new Button(this._container, {
			supportIcons: true,
			small: true,
			hoverDelegate: getDefaultHoverDelegate('element'),
		}));
		this._button.element.classList.add('browser-share-toggle');
		// a press does not move the focus into the editor: on a blank page that focus opens the URL picker, which
		// took the place of this button's picker ("0 Results" for seconds)
		this._register(addDisposableListener(this._button.element, EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(this._button.onDidClick(() => commandService.executeCommand(SWITCH_BROWSER_IDENTITY_ID, this.editor)));
		this._register(this.profiles.onDidChange(() => this._refresh()));
		this._refresh();
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.PreUrl, element: this._container, order: -1 }];
	}

	protected override onModelAttached(_model: IBrowserViewModel, _store: DisposableStore): void {
		this._refresh();
	}

	override prerenderInput(_input: BrowserEditorInput): void {
		this._refresh();
	}

	override onModelDetached(): void {
		this._refresh();
	}

	private _refresh(): void {
		const id = this.editor.input?.profile ?? this.profiles.current;
		const name = this.profiles.nameOf(id);
		const showName = id !== DEFAULT_BROWSER_PROFILE || this.profiles.getProfiles().length > 1;
		// a name only once there is a choice; the chevron says it opens a menu
		this._button.label = showName ? `$(account) ${name} $(chevron-down)` : '$(account) $(chevron-down)';
		const label = localize('browser.identity.aria', "Browser profile: {0}", name);
		this._button.setTitle(label);
		this._button.element.setAttribute('aria-label', label);
		this._container.classList.toggle('named', showName);
	}
}

BrowserEditor.registerContribution(BrowserIdentityContribution);

interface IIdentityPick extends IQuickPickItem {
	readonly run: () => Promise<void> | void;
}

/** Open the same page again with another identity, in the same place, and close the old one. */
async function reopenAs(editorService: IEditorService, browserViews: IBrowserViewWorkbenchService, editor: BrowserEditor | undefined, profile: string): Promise<void> {
	const input = editor?.input;
	const url = editor?.model?.url || input?.url;
	const resource = BrowserViewUri.forId(generateUuid());
	if (!editor || !input || editor.input?.profile === profile) {
		await editorService.openEditor({ resource, options: { viewState: { url, profile }, pinned: true } }, await browserViews.getPreferredGroup());
		return;
	}
	const group = editor.group;
	const index = group.getIndexOfEditor(input);
	await editorService.openEditor({ resource, options: { viewState: { url, profile }, index: index >= 0 ? index : undefined, pinned: true } }, group);
	await group.closeEditor(input, { preserveFocus: true });
}

class SwitchBrowserIdentityAction extends Action2 {
	constructor() {
		super({
			id: SWITCH_BROWSER_IDENTITY_ID,
			title: localize2('browser.switchIdentity', 'Browser Profiles...'),
			category: BrowserActionCategory,
			icon: Codicon.account,
			f1: true,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 1,
				isHiddenByDefault: true,
			},
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const profiles = accessor.get(IBrowserProfilesService);
		const dialogService = accessor.get(IDialogService);
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const browserViews = accessor.get(IBrowserViewWorkbenchService);
		const editor = browserEditor instanceof BrowserEditor ? browserEditor : undefined;
		const pageId = editor?.input?.profile ?? profiles.current;
		const pageName = profiles.nameOf(pageId);
		const open = (id: string) => {
			profiles.setCurrent(id);
			return reopenAs(editorService, browserViews, editor, id);
		};

		const items: (IIdentityPick | IQuickPickSeparator)[] = [];
		for (const p of profiles.getProfiles()) {
			const isPage = p.id === pageId;
			items.push({
				label: p.name,
				iconClass: ThemeIcon.asClassName(isPage ? Codicon.check : Codicon.blank),
				description: isPage && editor ? localize('browser.identity.thisPage', "this page") : undefined,
				detail: p.id === DEFAULT_BROWSER_PROFILE
					? localize('browser.identity.defaultDetail', "The sign-ins you already have in this browser")
					: undefined,
				run: () => isPage ? undefined : open(p.id),
			});
		}
		items.push({ type: 'separator' });
		items.push({
			label: localize('browser.identity.new', "New profile..."),
			iconClass: ThemeIcon.asClassName(Codicon.add),
			detail: localize('browser.identity.newDetail', "A separate set of sign-ins, for a second account or a test user."),
			run: async () => {
				const name = await quickInputService.input({
					title: localize('browser.identity.newTitle', "New browser profile"),
					prompt: localize('browser.identity.newPrompt', "Name it after the account you will sign in with. This page opens again with it, signed out."),
					placeHolder: localize('browser.identity.newPlaceholder', "Work, Personal, Test user"),
					validateInput: async value => {
						try {
							const clean = value.trim();
							if (!clean) {
								return undefined;
							}
							if (profiles.getProfiles().some(p => p.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === 'default') {
								return localize('browser.identity.taken', "There is already a profile called {0}.", clean);
							}
							return undefined;
						} catch (e) {
							return (e as Error).message;
						}
					},
				});
				if (!name?.trim()) {
					return;
				}
				const created = profiles.add(name);
				await open(created.id);
			},
		});
		items.push({
			label: localize('browser.identity.import', "Bring sign-ins from Chrome into {0}...", pageName),
			iconClass: ThemeIcon.asClassName(Codicon.cloudDownload),
			run: () => commandService.executeCommand(IMPORT_FROM_CHROME_ID, editor),
		});
		if (pageId !== DEFAULT_BROWSER_PROFILE) {
			items.push({
				label: localize('browser.identity.rename', "Rename {0}...", pageName),
				iconClass: ThemeIcon.asClassName(Codicon.edit),
				run: async () => {
					const name = await quickInputService.input({
						title: localize('browser.identity.renameTitle', "Rename {0}", pageName),
						value: pageName,
					});
					if (name?.trim() && name.trim() !== pageName) {
						profiles.rename(pageId, name);
					}
				},
			});
			items.push({
				label: localize('browser.identity.remove', "Remove {0}...", pageName),
				iconClass: ThemeIcon.asClassName(Codicon.trash),
				run: async () => {
					const { confirmed } = await dialogService.confirm({
						message: localize('browser.identity.removeTitle', "Remove the profile {0}?", pageName),
						detail: localize('browser.identity.removeDetail', "Its sign-ins, cookies and history in the built-in browser are deleted, and its open pages close. Your accounts on the websites are not touched."),
						primaryButton: localize({ key: 'browser.identity.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
					});
					if (!confirmed) {
						return;
					}
					for (const input of [...browserViews.getKnownBrowserViews().values()]) {
						if (input.profile === pageId && input !== editor?.input) {
							await editorService.closeEditors(editorService.findEditors(input).map(e => ({ editor: e.editor, groupId: e.groupId })));
						}
					}
					profiles.setCurrent(DEFAULT_BROWSER_PROFILE);
					if (editor) {
						await reopenAs(editorService, browserViews, editor, DEFAULT_BROWSER_PROFILE);
					}
					await profiles.remove(pageId);
				},
			});
		}

		editor?.getContribution(BrowserNavigationFeatures)?.holdFocus();
		const picked = await quickInputService.pick<IIdentityPick>(items, {
			title: localize('browser.identity.title', "Browser profile"),
			placeHolder: localize('browser.identity.placeholder', "Each profile keeps its own sign-ins. Pick the one this page should use."),
			matchOnDetail: false,
		});
		await picked?.run();
	}
}

registerAction2(SwitchBrowserIdentityAction);
