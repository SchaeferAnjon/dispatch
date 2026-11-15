/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserImportResult, IBrowserImportService, IBrowserImportSource, IImportedBookmark, IImportedHistoryEntry, ipcBrowserImportChannelName } from '../../../../../platform/browserView/common/browserImport.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory, BrowserActionGroup, BrowserEditor, BrowserEditorContribution, IBrowserUrlSuggestion, IBrowserUrlSuggestionProvider } from '../browserEditor.js';

/**
 * Dispatch: "Import from Chrome..." in the integrated browser's "..." menu (kanban task-p597).
 * Picks a Chromium browser profile on this Mac (Chrome, Edge, Brave, Arc, Chromium) and what to
 * bring over: cookies go straight into the browser session in the main process
 * (platform/browserView/electron-main/browserImportMainService.ts); bookmarks and history are kept
 * here, per source profile, so importing again replaces that profile's copy instead of adding to it.
 * They show up in the address bar's suggestions and, for bookmarks, in "Bookmarks..." in the same
 * menu. Passwords are not imported.
 */

const CONTEXT_BROWSER_HAS_IMPORTED_BOOKMARKS = new RawContextKey<boolean>('browserHasImportedBookmarks', false, localize('browser.hasImportedBookmarks', "Whether bookmarks were imported into the integrated browser"));

const BOOKMARKS_KEY = 'dispatch.browser.import.bookmarks';
const HISTORY_KEY = 'dispatch.browser.import.history';
const MAX_SUGGESTIONS = 6;

// -- Imported data ------------------------------------------------------------------------------

export const IBrowserImportedDataService = createDecorator<IBrowserImportedDataService>('browserImportedDataService');

export interface IBrowserImportedDataService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Every imported bookmark, each URL once (the most recently imported profile's copy wins). */
	getBookmarks(): readonly (IImportedBookmark & { source: string })[];
	/** Every imported history entry, each URL once, most visited first. */
	getHistory(): readonly IImportedHistoryEntry[];
	/** Replace one source profile's bookmarks and/or history; returns how many of their URLs were not there before. */
	setSource(source: string, label: string, bookmarks: readonly IImportedBookmark[] | undefined, history: readonly IImportedHistoryEntry[] | undefined): { newBookmarks: number; newHistory: number };
}

type PerSource<T> = Record<string, { label: string; at: number; items: T[] }>;

export class BrowserImportedDataService extends Disposable implements IBrowserImportedDataService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _bookmarks: PerSource<IImportedBookmark> | undefined;
	private _history: PerSource<IImportedHistoryEntry> | undefined;
	private _mergedBookmarks: (IImportedBookmark & { source: string })[] | undefined;
	private _mergedHistory: IImportedHistoryEntry[] | undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const hasBookmarks = CONTEXT_BROWSER_HAS_IMPORTED_BOOKMARKS.bindTo(contextKeyService);
		const update = () => hasBookmarks.set(this.getBookmarks().length > 0);
		const listener = this._register(new DisposableStore());
		for (const key of [BOOKMARKS_KEY, HISTORY_KEY]) {
			this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, key, listener)(() => {
				this._reset();
				update();
				this._onDidChange.fire();
			}));
		}
		update();
	}

	private _reset(): void {
		this._bookmarks = this._history = undefined;
		this._mergedBookmarks = this._mergedHistory = undefined;
	}

	private _read<T>(key: string): PerSource<T> {
		try {
			const parsed = JSON.parse(this._storageService.get(key, StorageScope.APPLICATION) || '{}');
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	getBookmarks(): readonly (IImportedBookmark & { source: string })[] {
		if (!this._mergedBookmarks) {
			this._bookmarks ??= this._read<IImportedBookmark>(BOOKMARKS_KEY);
			const seen = new Set<string>();
			const out: (IImportedBookmark & { source: string })[] = [];
			for (const entry of Object.values(this._bookmarks).sort((a, b) => b.at - a.at)) {
				for (const b of entry.items ?? []) {
					if (!seen.has(b.url)) {
						seen.add(b.url);
						out.push({ ...b, source: entry.label });
					}
				}
			}
			this._mergedBookmarks = out;
		}
		return this._mergedBookmarks;
	}

	getHistory(): readonly IImportedHistoryEntry[] {
		if (!this._mergedHistory) {
			this._history ??= this._read<IImportedHistoryEntry>(HISTORY_KEY);
			const byUrl = new Map<string, IImportedHistoryEntry>();
			for (const entry of Object.values(this._history)) {
				for (const h of entry.items ?? []) {
					const had = byUrl.get(h.url);
					byUrl.set(h.url, had ? { ...had, visits: had.visits + h.visits, lastVisit: Math.max(had.lastVisit, h.lastVisit) } : h);
				}
			}
			this._mergedHistory = [...byUrl.values()].sort((a, b) => b.visits - a.visits || b.lastVisit - a.lastVisit);
		}
		return this._mergedHistory;
	}

	setSource(source: string, label: string, bookmarks: readonly IImportedBookmark[] | undefined, history: readonly IImportedHistoryEntry[] | undefined): { newBookmarks: number; newHistory: number } {
		const knownBookmarks = new Set(this.getBookmarks().map(b => b.url));
		const knownHistory = new Set(this.getHistory().map(h => h.url));
		const at = Date.now();
		let newBookmarks = 0, newHistory = 0;
		if (bookmarks) {
			const all = this._read<IImportedBookmark>(BOOKMARKS_KEY);
			all[source] = { label, at, items: [...bookmarks] };
			newBookmarks = bookmarks.filter(b => !knownBookmarks.has(b.url)).length;
			this._storageService.store(BOOKMARKS_KEY, JSON.stringify(all), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		if (history) {
			const all = this._read<IImportedHistoryEntry>(HISTORY_KEY);
			all[source] = { label, at, items: [...history] };
			newHistory = history.filter(h => !knownHistory.has(h.url)).length;
			this._storageService.store(HISTORY_KEY, JSON.stringify(all), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this._reset();
		this._onDidChange.fire();
		return { newBookmarks, newHistory };
	}
}

registerSingleton(IBrowserImportedDataService, BrowserImportedDataService, InstantiationType.Delayed);

// -- Address bar suggestions --------------------------------------------------------------------

function matches(needle: string, ...fields: string[]): boolean {
	return fields.some(f => f.toLowerCase().includes(needle));
}

export class BrowserImportFeature extends BrowserEditorContribution {

	private readonly _bookmarksProvider: IBrowserUrlSuggestionProvider;
	private readonly _historyProvider: IBrowserUrlSuggestionProvider;

	constructor(
		editor: BrowserEditor,
		@IBrowserImportedDataService data: IBrowserImportedDataService,
	) {
		super(editor);
		this._bookmarksProvider = {
			label: localize('browser.import.bookmarks', "Bookmarks"),
			order: 40,
			onDidChange: data.onDidChange,
			getSuggestions: async ({ input, text }) => {
				const needle = text.trim().toLowerCase();
				if (!needle) {
					return [];
				}
				const out: IBrowserUrlSuggestion[] = [];
				for (const b of data.getBookmarks()) {
					if (out.length >= MAX_SUGGESTIONS) {
						break;
					}
					if (b.url !== input.url && matches(needle, b.title, b.url)) {
						out.push({ id: 'imported-bookmark:' + b.url, label: b.title, description: b.url, icon: Codicon.bookmark, apply: target => target.navigate(b.url) });
					}
				}
				return out;
			},
		};
		this._historyProvider = {
			label: localize('browser.import.history', "Imported History"),
			order: 60,
			onDidChange: data.onDidChange,
			getSuggestions: async ({ input, text }) => {
				const needle = text.trim().toLowerCase();
				if (!needle) {
					return [];
				}
				const bookmarked = new Set(data.getBookmarks().map(b => b.url));
				const out: IBrowserUrlSuggestion[] = [];
				for (const h of data.getHistory()) {
					if (out.length >= MAX_SUGGESTIONS) {
						break;
					}
					if (h.url !== input.url && !bookmarked.has(h.url) && matches(needle, h.title, h.url)) {
						out.push({ id: 'imported-history:' + h.url, label: h.title || h.url, description: h.title ? h.url : undefined, icon: Codicon.history, apply: target => target.navigate(h.url) });
					}
				}
				return out;
			},
		};
	}

	override get urlSuggestionProviders(): readonly IBrowserUrlSuggestionProvider[] {
		return [this._bookmarksProvider, this._historyProvider];
	}
}

BrowserEditor.registerContribution(BrowserImportFeature);

// -- Import from Chrome... ----------------------------------------------------------------------

interface IProfilePick extends IQuickPickItem {
	readonly source: IBrowserImportSource;
	readonly profile: string;
	readonly profileName: string;
}

interface IWhatPick extends IQuickPickItem {
	readonly what: 'cookies' | 'bookmarks' | 'history' | 'passwords';
}

function formatCount(n: number): string {
	return n.toLocaleString('en-US');
}

/** The one line shown when the import is done. */
export function describeImportResult(from: string, result: IBrowserImportResult, added: { newBookmarks: number; newHistory: number }): { message: string; severity: Severity } {
	const parts: string[] = [];
	const problems: string[] = [];
	if (result.cookies) {
		const c = result.cookies;
		const skipped = c.expired + c.skipped;
		parts.push(skipped
			? localize('browser.import.cookiesSkipped', "{0} cookies ({1} skipped: {2} expired, {3} not importable)", formatCount(c.imported), formatCount(skipped), formatCount(c.expired), formatCount(c.skipped))
			: localize('browser.import.cookies', "{0} cookies", formatCount(c.imported)));
		if (c.error) {
			problems.push(c.error);
		}
	}
	if (result.bookmarks) {
		parts.push(added.newBookmarks < result.bookmarks.length
			? localize('browser.import.bookmarksNew', "{0} bookmarks ({1} new)", formatCount(result.bookmarks.length), formatCount(added.newBookmarks))
			: localize('browser.import.bookmarksCount', "{0} bookmarks", formatCount(result.bookmarks.length)));
		if (result.bookmarksError) {
			problems.push(result.bookmarksError);
		}
	}
	if (result.history) {
		parts.push(added.newHistory < result.history.length
			? localize('browser.import.historyNew', "{0} history entries ({1} new)", formatCount(result.history.length), formatCount(added.newHistory))
			: localize('browser.import.historyCount', "{0} history entries", formatCount(result.history.length)));
		if (result.historyError) {
			problems.push(result.historyError);
		}
	}
	const message = localize('browser.import.done', "Imported from {0}: {1}.", from, parts.join(', ')) + (problems.length ? ' ' + problems.join(' ') : '');
	return { message, severity: problems.length ? Severity.Warning : Severity.Info };
}

class ImportFromChromeAction extends Action2 {
	static readonly ID = 'workbench.action.browser.importFromChrome';

	constructor() {
		super({
			id: ImportFromChromeAction.ID,
			title: localize2('browser.importFromChrome', 'Import from Chrome...'),
			category: BrowserActionCategory,
			icon: Codicon.cloudDownload,
			f1: true,
			precondition: BROWSER_EDITOR_ACTIVE,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 4,
				isHiddenByDefault: true,
			},
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const data = accessor.get(IBrowserImportedDataService);
		const importService = ProxyChannel.toService<IBrowserImportService>(accessor.get(IMainProcessService).getChannel(ipcBrowserImportChannelName));
		const editor = browserEditor instanceof BrowserEditor ? browserEditor : undefined;

		const sources = await importService.listSources();
		if (sources.length === 0) {
			notificationService.info(localize('browser.import.none', "No Chrome, Edge, Brave or Arc profile was found on this Mac."));
			return;
		}

		// 1. Which profile
		const profileItems: (IProfilePick | IQuickPickSeparator)[] = [];
		for (const source of sources) {
			profileItems.push({ type: 'separator', label: source.displayName });
			for (const p of source.profiles) {
				profileItems.push({ label: p.name, description: p.account, detail: undefined, source, profile: p.id, profileName: p.name });
			}
		}
		const picked = await quickInputService.pick<IProfilePick>(profileItems, {
			title: localize('browser.import.title', "Import from Chrome"),
			placeHolder: localize('browser.import.pickProfile', "Choose the browser profile to import from"),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		const from = `${picked.source.displayName} (${picked.profileName})`;

		// 2. What
		const store = new DisposableStore();
		const whatItems: IWhatPick[] = [
			{
				what: 'cookies', picked: true,
				label: localize('browser.import.what.cookies', "Cookies (sign-ins)"),
				detail: localize('browser.import.what.cookiesDetail', "Keeps you signed in. macOS will ask about \"{0}\": click Allow.", picked.source.keychainService),
			},
			{
				what: 'bookmarks', picked: true,
				label: localize('browser.import.what.bookmarks', "Bookmarks"),
				detail: localize('browser.import.what.bookmarksDetail', "Suggested as you type in the address bar, and listed under Bookmarks... in this menu."),
			},
			{
				what: 'history', picked: true,
				label: localize('browser.import.what.history', "History"),
				detail: localize('browser.import.what.historyDetail', "Pages you visited, suggested as you type in the address bar."),
			},
			{
				what: 'passwords', disabled: true,
				label: localize('browser.import.what.passwords', "Passwords"),
				detail: localize('browser.import.what.passwordsDetail', "Not imported: there is no password manager here to keep them encrypted."),
			},
		];
		const chosen = await new Promise<readonly IWhatPick[] | undefined>(resolve => {
			const qp = store.add(quickInputService.createQuickPick<IWhatPick>());
			qp.title = localize('browser.import.whatTitle', "Import from {0}", from);
			qp.placeholder = localize('browser.import.pickWhat', "Choose what to import, then press Enter");
			qp.canSelectMany = true;
			qp.items = whatItems;
			qp.selectedItems = whatItems.filter(i => i.picked);
			qp.ok = true;
			let done = false;
			store.add(qp.onDidAccept(() => {
				done = true;
				resolve(qp.selectedItems.filter(i => i.what !== 'passwords'));
				qp.hide();
			}));
			store.add(qp.onDidHide(() => {
				if (!done) {
					resolve(undefined);
				}
			}));
			qp.show();
		}).finally(() => store.dispose());
		if (!chosen || chosen.length === 0) {
			return;
		}
		const want = new Set(chosen.map(c => c.what));

		// 3. Import
		const scope = editor?.model?.storageScope ?? BrowserViewStorageScope.Global;
		let result: IBrowserImportResult;
		try {
			result = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: want.has('cookies')
					? localize('browser.import.progressCookies', "Importing from {0}. If macOS asks for keychain access, click Allow.", from)
					: localize('browser.import.progress', "Importing from {0}...", from),
			}, () => importService.import({
				browser: picked.source.browser,
				profile: picked.profile,
				cookies: want.has('cookies'),
				bookmarks: want.has('bookmarks'),
				history: want.has('history'),
				// Dispatch: into the page's login identity (browserProfilesFeature.ts)
				into: editor?.model?.profile,
			}));
		} catch (e) {
			notificationService.error(localize('browser.import.failed', "Import from {0} failed: {1}", from, (e as Error).message));
			return;
		}
		const added = data.setSource(`${picked.source.browser}/${picked.profile}`, from, result.bookmarks, result.history);
		const { message, severity } = describeImportResult(from, result, added);
		// cookies go into the shared profile; a tab on workspace or private storage does not see them
		const elsewhere = result.cookies && scope !== BrowserViewStorageScope.Global
			? ' ' + localize('browser.import.sharedProfile', "Cookies were imported into the shared browser profile.")
			: '';
		notificationService.notify({ severity, message: message + elsewhere });
		if (result.cookies?.imported && editor?.model) {
			void editor.model.reload();
		}
	}
}

registerAction2(ImportFromChromeAction);

// -- Bookmarks... -------------------------------------------------------------------------------

interface IBookmarkPick extends IQuickPickItem {
	readonly url: string;
}

class ShowImportedBookmarksAction extends Action2 {
	static readonly ID = 'workbench.action.browser.showImportedBookmarks';

	constructor() {
		const when = ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_IMPORTED_BOOKMARKS);
		super({
			id: ShowImportedBookmarksAction.ID,
			title: localize2('browser.showImportedBookmarks', 'Bookmarks...'),
			category: BrowserActionCategory,
			icon: Codicon.bookmark,
			f1: true,
			precondition: when,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 3,
				when,
				isHiddenByDefault: true,
			},
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const data = accessor.get(IBrowserImportedDataService);
		if (!(browserEditor instanceof BrowserEditor)) {
			return;
		}
		const items: (IBookmarkPick | IQuickPickSeparator)[] = [];
		const bookmarks = data.getBookmarks();
		// name the source profile only when bookmarks came from more than one
		const manySources = new Set(bookmarks.map(b => b.source)).size > 1;
		let folder: string | undefined;
		for (const b of bookmarks) {
			const group = manySources ? `${b.folder} · ${b.source}` : b.folder;
			if (group !== folder) {
				items.push({ type: 'separator', label: group });
				folder = group;
			}
			items.push({ label: b.title, description: b.url, url: b.url });
		}
		const pick = await quickInputService.pick<IBookmarkPick>(items, {
			title: localize('browser.bookmarks.title', "Bookmarks"),
			placeHolder: localize('browser.bookmarks.placeholder', "Search imported bookmarks"),
			matchOnDescription: true,
		});
		if (pick && browserEditor.model) {
			void browserEditor.model.loadURL(pick.url);
		}
	}
}

registerAction2(ShowImportedBookmarksAction);
