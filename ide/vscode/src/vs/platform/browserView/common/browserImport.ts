/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Dispatch: "Import from Chrome..." in the integrated browser's "..." menu. The main process reads a
 * Chromium browser profile on this Mac (Chrome, Edge, Brave, Arc, Chromium) and writes its cookies
 * into the integrated browser's shared persistent session (`persist:vscode-browser`, which the pages
 * agents open use too); bookmarks and history go back to the workbench,
 * which keeps them for the address bar and the Bookmarks list. Passwords are never read.
 */
export const ipcBrowserImportChannelName = 'browserImport';

export const IBrowserImportService = createDecorator<IBrowserImportService>('browserImportService');

export type BrowserImportBrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'chromium';

export interface IBrowserImportProfile {
	/** The profile's folder name under the browser's user data folder ("Default", "Profile 1"). */
	readonly id: string;
	/** The name the browser shows for it ("Person 1", "Work"). */
	readonly name: string;
	/** The signed-in account, when the browser knows one. */
	readonly account?: string;
}

export interface IBrowserImportSource {
	readonly browser: BrowserImportBrowserId;
	/** "Google Chrome", "Microsoft Edge", ... */
	readonly displayName: string;
	/** The keychain item the cookie key lives in ("Chrome Safe Storage"). */
	readonly keychainService: string;
	readonly profiles: readonly IBrowserImportProfile[];
}

export interface IBrowserImportRequest {
	readonly browser: BrowserImportBrowserId;
	readonly profile: string;
	readonly cookies: boolean;
	readonly bookmarks: boolean;
	readonly history: boolean;
	/** Dispatch: the login identity the cookies go into (`browserProfiles.ts`); undefined = the default one. */
	readonly into?: string;
}

export interface IImportedBookmark {
	readonly title: string;
	readonly url: string;
	/** The folder path in the source browser ("Bookmarks bar / Work"). */
	readonly folder: string;
}

export interface IImportedHistoryEntry {
	readonly url: string;
	readonly title: string;
	readonly visits: number;
	/** Epoch ms of the last visit. */
	readonly lastVisit: number;
}

export interface IBrowserImportCookiesResult {
	/** Written into the session. */
	readonly imported: number;
	/** Already expired in the source browser. */
	readonly expired: number;
	/** Could not be decrypted or were refused by the session (partitioned, invalid). */
	readonly skipped: number;
	/** Why no cookie was imported at all (keychain access denied, database unreadable). */
	readonly error?: string;
}

export interface IBrowserImportResult {
	readonly cookies?: IBrowserImportCookiesResult;
	readonly bookmarks?: readonly IImportedBookmark[];
	readonly bookmarksError?: string;
	readonly history?: readonly IImportedHistoryEntry[];
	readonly historyError?: string;
}

export interface IBrowserImportService {
	readonly _serviceBrand: undefined;
	/** The Chromium browsers installed on this Mac and their profiles; empty when none is. */
	listSources(): Promise<IBrowserImportSource[]>;
	import(request: IBrowserImportRequest): Promise<IBrowserImportResult>;
}

/** Most history entries kept per imported profile (most visited first). */
export const MAX_IMPORTED_HISTORY = 5000;
