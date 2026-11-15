/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecipheriv, createHash, pbkdf2Sync } from 'crypto';
import { BrowserImportBrowserId, IBrowserImportProfile, IImportedBookmark, IImportedHistoryEntry } from '../common/browserImport.js';

/**
 * Dispatch: the pure half of "Import from Chrome..." (platform/browserView/electron-main/browserImportMainService.ts
 * does the files, the keychain and the session). Chromium browsers on macOS share one format:
 * `<user data>/Local State` lists the profiles, each profile folder has `Cookies` and `History`
 * (SQLite) and `Bookmarks` (JSON); cookie values are AES-128-CBC encrypted with a key derived from
 * the browser's "... Safe Storage" keychain password.
 */

export interface IBrowserImportBrowserInfo {
	readonly browser: BrowserImportBrowserId;
	readonly displayName: string;
	/** Under ~/Library/Application Support. */
	readonly userDataPath: string;
	readonly keychainService: string;
	readonly keychainAccount: string;
}

export const BROWSER_IMPORT_BROWSERS: readonly IBrowserImportBrowserInfo[] = [
	{ browser: 'chrome', displayName: 'Google Chrome', userDataPath: 'Google/Chrome', keychainService: 'Chrome Safe Storage', keychainAccount: 'Chrome' },
	{ browser: 'edge', displayName: 'Microsoft Edge', userDataPath: 'Microsoft Edge', keychainService: 'Microsoft Edge Safe Storage', keychainAccount: 'Microsoft Edge' },
	{ browser: 'brave', displayName: 'Brave', userDataPath: 'BraveSoftware/Brave-Browser', keychainService: 'Brave Safe Storage', keychainAccount: 'Brave' },
	{ browser: 'arc', displayName: 'Arc', userDataPath: 'Arc/User Data', keychainService: 'Arc Safe Storage', keychainAccount: 'Arc' },
	{ browser: 'chromium', displayName: 'Chromium', userDataPath: 'Chromium', keychainService: 'Chromium Safe Storage', keychainAccount: 'Chromium' },
];

/** Seconds between 1601-01-01 (Chromium's time origin) and 1970-01-01. */
const CHROMIUM_EPOCH_OFFSET_S = 11644473600;

/** Chromium time (microseconds since 1601) to seconds since 1970. */
export function chromiumTimeToEpochSeconds(micros: number): number {
	return micros / 1e6 - CHROMIUM_EPOCH_OFFSET_S;
}

/** The 16 byte AES key Chromium derives from the keychain password on macOS. */
export function deriveCookieKey(password: string): Buffer {
	return pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1');
}

/**
 * One cookie's value. `encrypted` empty: the plain `value` column is the value. Otherwise "v10" +
 * AES-128-CBC (IV of 16 spaces, PKCS#7); databases from version 24 on put SHA-256(host_key) in front
 * of the plain text. Returns undefined when it cannot be decrypted (another key, another format).
 */
export function decryptCookieValue(encrypted: Uint8Array | null | undefined, plain: string | null | undefined, key: Buffer, dbVersion: number, hostKey: string): string | undefined {
	if (!encrypted || encrypted.length === 0) {
		return plain ?? '';
	}
	const buf = Buffer.from(encrypted);
	const prefix = buf.subarray(0, 3).toString('latin1');
	if (prefix !== 'v10' && prefix !== 'v11') {
		return undefined;
	}
	let out: Buffer;
	try {
		const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
		out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
	} catch {
		return undefined;
	}
	if (out.length >= 32) {
		const hostHash = createHash('sha256').update(hostKey, 'utf8').digest();
		if (dbVersion >= 24 || out.subarray(0, 32).equals(hostHash)) {
			out = out.subarray(32);
		}
	}
	const text = out.toString('utf8');
	// A wrong key that still unpads leaves bytes that are not text.
	if (text.includes('�') || /[\x00-\x08\x0e-\x1f\x7f]/.test(text)) {
		return undefined;
	}
	return text;
}

/** A row of Chromium's `cookies` table (the columns we read). */
export interface IChromiumCookieRow {
	readonly host_key: string;
	readonly name: string;
	readonly value: string | null;
	readonly encrypted_value: Uint8Array | null;
	readonly path: string;
	readonly expires_utc: number;
	readonly is_secure: number;
	readonly is_httponly: number;
	readonly has_expires: number;
	readonly samesite: number;
	readonly top_frame_site_key?: string | null;
}

/** What `Electron.Session.cookies.set` takes. */
export interface IElectronCookieDetails {
	url: string;
	name: string;
	value: string;
	domain?: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	expirationDate?: number;
	sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export type CookieMapResult =
	| { readonly kind: 'ok'; readonly details: IElectronCookieDetails }
	| { readonly kind: 'expired' }
	| { readonly kind: 'skipped'; readonly reason: 'partitioned' | 'invalid' };

const SAME_SITE: Record<number, IElectronCookieDetails['sameSite']> = { [-1]: 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * A decrypted cookie row as Electron cookie details. Host-only cookies (host_key without a leading
 * dot) get no `domain`, so Electron keeps them host-only; session cookies (has_expires 0) get no
 * expiration and stay session cookies. Expired ones, partitioned ones (CHIPS, which
 * `cookies.set` cannot express) and SameSite=None without Secure (Chromium refuses those) are left out.
 */
export function cookieRowToElectron(row: IChromiumCookieRow, value: string, nowSeconds: number): CookieMapResult {
	const host = row.host_key.startsWith('.') ? row.host_key.slice(1) : row.host_key;
	if (!host || (!row.name && !value)) {
		return { kind: 'skipped', reason: 'invalid' };
	}
	if (row.top_frame_site_key) {
		return { kind: 'skipped', reason: 'partitioned' };
	}
	let expirationDate: number | undefined;
	if (row.has_expires && row.expires_utc > 0) {
		expirationDate = chromiumTimeToEpochSeconds(row.expires_utc);
		if (expirationDate <= nowSeconds) {
			return { kind: 'expired' };
		}
	}
	const secure = !!row.is_secure;
	const sameSite = SAME_SITE[row.samesite] ?? 'unspecified';
	if (sameSite === 'no_restriction' && !secure) {
		return { kind: 'skipped', reason: 'invalid' };
	}
	const path = row.path || '/';
	const details: IElectronCookieDetails = {
		url: `${secure ? 'https' : 'http'}://${host}${path.startsWith('/') ? path : '/' + path}`,
		name: row.name,
		value,
		path,
		secure,
		httpOnly: !!row.is_httponly,
		sameSite,
	};
	if (row.host_key.startsWith('.')) {
		details.domain = row.host_key;
	}
	if (expirationDate !== undefined) {
		details.expirationDate = expirationDate;
	}
	return { kind: 'ok', details };
}

/** The profiles in a `Local State` file, in the browser's order; folders that do not exist are the caller's to drop. */
export function parseLocalStateProfiles(localState: unknown): IBrowserImportProfile[] {
	const profile = (localState as { profile?: { info_cache?: Record<string, { name?: unknown; user_name?: unknown; gaia_name?: unknown }>; profiles_order?: unknown } } | undefined)?.profile;
	const cache = profile?.info_cache;
	if (!cache || typeof cache !== 'object') {
		return [];
	}
	const order = Array.isArray(profile.profiles_order) ? profile.profiles_order.filter((id): id is string => typeof id === 'string' && id in cache) : [];
	const ids = [...order, ...Object.keys(cache).filter(id => !order.includes(id))];
	return ids.map(id => {
		const info = cache[id] ?? {};
		const name = typeof info.name === 'string' && info.name ? info.name : id;
		const account = typeof info.user_name === 'string' && info.user_name ? info.user_name : undefined;
		return account ? { id, name, account } : { id, name };
	});
}

interface IChromiumBookmarkNode {
	type?: string;
	name?: string;
	url?: string;
	children?: IChromiumBookmarkNode[];
}

const ROOT_NAMES: Record<string, string> = { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' };

/** Every http(s) bookmark in a `Bookmarks` file with its folder path, each URL once, in the browser's order. */
export function flattenBookmarks(file: unknown): IImportedBookmark[] {
	const roots = (file as { roots?: Record<string, IChromiumBookmarkNode> } | undefined)?.roots;
	if (!roots || typeof roots !== 'object') {
		return [];
	}
	const out: IImportedBookmark[] = [];
	const seen = new Set<string>();
	const walk = (node: IChromiumBookmarkNode, folder: string, depth: number) => {
		if (depth > 64 || !node || typeof node !== 'object') {
			return;
		}
		if (node.type === 'url' && typeof node.url === 'string') {
			if (/^https?:\/\//i.test(node.url) && !seen.has(node.url)) {
				seen.add(node.url);
				out.push({ title: typeof node.name === 'string' && node.name ? node.name : node.url, url: node.url, folder });
			}
			return;
		}
		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				const childFolder = child?.type === 'folder' ? (folder ? `${folder} / ${child.name ?? ''}` : String(child.name ?? '')) : folder;
				walk(child, childFolder, depth + 1);
			}
		}
	};
	for (const key of ['bookmark_bar', 'other', 'synced']) {
		const root = roots[key];
		if (root) {
			walk(root, root.name || ROOT_NAMES[key], 0);
		}
	}
	return out;
}

/** A row of Chromium's `urls` table (the columns we read). */
export interface IChromiumHistoryRow {
	readonly url: string;
	readonly title: string | null;
	readonly visit_count: number;
	readonly last_visit_time: number;
}

export function historyRowsToEntries(rows: readonly IChromiumHistoryRow[], max: number): IImportedHistoryEntry[] {
	const out: IImportedHistoryEntry[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (out.length >= max) {
			break;
		}
		if (typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url) || seen.has(row.url)) {
			continue;
		}
		seen.add(row.url);
		out.push({
			url: row.url,
			title: row.title ?? '',
			visits: row.visit_count || 0,
			lastVisit: row.last_visit_time > 0 ? Math.round(chromiumTimeToEpochSeconds(row.last_visit_time) * 1000) : 0,
		});
	}
	return out;
}
