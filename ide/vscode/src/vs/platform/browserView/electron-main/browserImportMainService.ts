/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import type { Database } from '@vscode/sqlite3';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { IBrowserImportCookiesResult, IBrowserImportRequest, IBrowserImportResult, IBrowserImportService, IBrowserImportSource, MAX_IMPORTED_HISTORY } from '../common/browserImport.js';
import { BROWSER_IMPORT_BROWSERS, cookieRowToElectron, decryptCookieValue, deriveCookieKey, flattenBookmarks, historyRowsToEntries, IBrowserImportBrowserInfo, IChromiumCookieRow, IChromiumHistoryRow, parseLocalStateProfiles } from '../node/browserImportHelpers.js';
import { BrowserSession } from './browserSession.js';

/**
 * Only for tests on a fake profile: `BROWSER_IMPORT_TEST_ROOT` stands in for
 * ~/Library/Application Support, and `BROWSER_IMPORT_TEST_KEY` (honoured only together with it) is
 * the "Safe Storage" password, so the keychain is never asked. Unset, the real folders and the
 * keychain are used.
 */
const TEST_ROOT_ENV = 'BROWSER_IMPORT_TEST_ROOT';
const TEST_KEY_ENV = 'BROWSER_IMPORT_TEST_KEY';

/** How long the keychain prompt may stay up before the import gives up on cookies. */
const KEYCHAIN_TIMEOUT_MS = 120_000;

export class BrowserImportMainService implements IBrowserImportService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@ILogService private readonly logService: ILogService,
	) { }

	private _root(): string {
		return process.env[TEST_ROOT_ENV] || join(homedir(), 'Library', 'Application Support');
	}

	private _browser(id: string): IBrowserImportBrowserInfo {
		const info = BROWSER_IMPORT_BROWSERS.find(b => b.browser === id);
		if (!info) {
			throw new Error(`Unknown browser: ${id}`);
		}
		return info;
	}

	async listSources(): Promise<IBrowserImportSource[]> {
		if (process.platform !== 'darwin') {
			return [];
		}
		const out: IBrowserImportSource[] = [];
		for (const info of BROWSER_IMPORT_BROWSERS) {
			const userData = join(this._root(), info.userDataPath);
			let localState: unknown;
			try {
				localState = JSON.parse(await fs.readFile(join(userData, 'Local State'), 'utf8'));
			} catch {
				continue; // not installed (or never started)
			}
			const profiles = [];
			for (const profile of parseLocalStateProfiles(localState)) {
				if (await exists(join(userData, profile.id))) {
					profiles.push(profile);
				}
			}
			if (profiles.length) {
				out.push({ browser: info.browser, displayName: info.displayName, keychainService: info.keychainService, profiles });
			}
		}
		return out;
	}

	async import(request: IBrowserImportRequest): Promise<IBrowserImportResult> {
		const info = this._browser(request.browser);
		if (!/^[\w .-]+$/.test(request.profile) || request.profile.includes('..')) {
			throw new Error('Invalid profile');
		}
		const profileDir = join(this._root(), info.userDataPath, request.profile);
		if (!await exists(profileDir)) {
			throw new Error(`${info.displayName} has no profile ${request.profile}`);
		}
		const work = await fs.mkdtemp(join(tmpdir(), 'dispatch-browser-import-'));
		try {
			let result: IBrowserImportResult = {};
			if (request.bookmarks) {
				try {
					const file = JSON.parse(await fs.readFile(join(profileDir, 'Bookmarks'), 'utf8'));
					result = { ...result, bookmarks: flattenBookmarks(file) };
				} catch (e) {
					result = { ...result, bookmarks: [], bookmarksError: isNotFound(e) ? undefined : 'The Bookmarks file could not be read.' };
				}
			}
			if (request.history) {
				try {
					const rows = await this._query<IChromiumHistoryRow>(join(profileDir, 'History'), work, 'History',
						`SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%') ORDER BY visit_count DESC, last_visit_time DESC LIMIT ${MAX_IMPORTED_HISTORY * 2}`);
					result = { ...result, history: historyRowsToEntries(rows, MAX_IMPORTED_HISTORY) };
				} catch (e) {
					result = { ...result, history: [], historyError: isNotFound(e) ? undefined : 'The History database could not be read.' };
				}
			}
			if (request.cookies) {
				result = { ...result, cookies: await this._importCookies(info, profileDir, work, request.into) };
			}
			this.logService.info(`[BrowserImport] ${info.browser}/${request.profile}: cookies ${result.cookies ? `${result.cookies.imported} imported, ${result.cookies.expired} expired, ${result.cookies.skipped} skipped` : 'not asked'}; bookmarks ${result.bookmarks?.length ?? '-'}; history ${result.history?.length ?? '-'}`);
			return result;
		} finally {
			await fs.rm(work, { recursive: true, force: true }).catch(() => { });
		}
	}

	private async _importCookies(info: IBrowserImportBrowserInfo, profileDir: string, work: string, into?: string): Promise<IBrowserImportCookiesResult> {
		const session = this._targetSession(into);
		const base = { imported: 0, expired: 0, skipped: 0 };
		// Newer Chromium keeps cookies in <profile>/Network/Cookies, older in <profile>/Cookies.
		const dbPath = await exists(join(profileDir, 'Network', 'Cookies')) ? join(profileDir, 'Network', 'Cookies') : join(profileDir, 'Cookies');
		let rows: IChromiumCookieRow[];
		let dbVersion = 0;
		try {
			const meta = await this._query<{ value: string }>(dbPath, work, 'Cookies', `SELECT value FROM meta WHERE key = 'version'`);
			dbVersion = Number(meta[0]?.value) || 0;
			rows = await this._query<IChromiumCookieRow>(dbPath, work, 'Cookies', `SELECT * FROM cookies`);
		} catch (e) {
			return { ...base, error: isNotFound(e) ? 'This profile has no cookies.' : 'The Cookies database could not be read.' };
		}
		if (rows.length === 0) {
			return base;
		}

		let password: string;
		try {
			password = await this._password(info);
		} catch (e) {
			return { ...base, skipped: rows.length, error: (e as Error).message };
		}
		const key = deriveCookieKey(password);
		password = '';

		const now = Date.now() / 1000;
		let imported = 0, expired = 0, skipped = 0, undecryptable = 0;
		for (const row of rows) {
			const value = decryptCookieValue(row.encrypted_value, row.value, key, dbVersion, row.host_key);
			if (value === undefined) {
				undecryptable++;
				continue;
			}
			const mapped = cookieRowToElectron(row, value, now);
			if (mapped.kind === 'expired') {
				expired++;
				continue;
			}
			if (mapped.kind === 'skipped') {
				skipped++;
				continue;
			}
			try {
				await session.electronSession.cookies.set(mapped.details);
				imported++;
			} catch {
				skipped++; // refused by Chromium (a prefix rule, an invalid domain); the value is not logged
			}
		}
		key.fill(0);
		await session.electronSession.cookies.flushStore().catch(() => { });
		const encryptedRows = rows.filter(r => r.encrypted_value && r.encrypted_value.length > 0).length;
		const error = imported === 0 && encryptedRows > 0 && undecryptable === encryptedRows
			? `The cookies could not be decrypted with the "${info.keychainService}" key.`
			: undefined;
		return { imported, expired, skipped: skipped + undecryptable, ...(error ? { error } : {}) };
	}

	/**
	 * The integrated browser's shared persistent session (`persist:vscode-browser`): the pages people
	 * open with the default storage and the pages agents open both use it.
	 */
	private _targetSession(into?: string): BrowserSession {
		// Dispatch: or the login identity the page belongs to (`common/browserProfiles.ts`)
		const session = BrowserSession.getOrCreateGlobal(this.instantiationService, into);
		session.connectStorage(this.applicationStorageMainService);
		return session;
	}

	/** The "... Safe Storage" password from the login keychain (macOS asks the user the first time). Only in memory. */
	private _password(info: IBrowserImportBrowserInfo): Promise<string> {
		if (process.env[TEST_ROOT_ENV] && process.env[TEST_KEY_ENV]) {
			return Promise.resolve(process.env[TEST_KEY_ENV]!);
		}
		// A HOME without a login keychain (a test instance's temporary HOME, a fresh account) would make
		// `security` bring up macOS's "keychain not found" dialog: skip the cookies instead, quietly.
		if (!hasLoginKeychain()) {
			return Promise.reject(new Error(`There is no login keychain in ${homedir()}, so no cookies were imported.`));
		}
		return new Promise((resolve, reject) => {
			execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', info.keychainService], { timeout: KEYCHAIN_TIMEOUT_MS }, (err, stdout) => {
				if (err) {
					// 128: the user clicked Deny; 44: no such item. Never pass stdout or stderr on.
					const code = (err as { code?: unknown }).code;
					reject(new Error(code === 44
						? `The keychain has no "${info.keychainService}" item, so the cookies cannot be read.`
						: `Keychain access to "${info.keychainService}" was not allowed, so no cookies were imported.`));
					return;
				}
				const password = stdout.replace(/\n$/, '');
				if (!password) {
					reject(new Error(`The keychain returned an empty "${info.keychainService}" password.`));
					return;
				}
				resolve(password);
			});
		});
	}

	/**
	 * Runs one query on a copy of a Chromium SQLite file (the browser keeps it locked while it runs),
	 * with its -wal / -journal next to it so recent writes are there too.
	 */
	private async _query<T>(file: string, work: string, name: string, sql: string): Promise<T[]> {
		const copy = join(work, `${name}-${Math.random().toString(36).slice(2)}`);
		await fs.copyFile(file, copy);
		for (const suffix of ['-wal', '-journal']) {
			await fs.copyFile(file + suffix, copy + suffix).catch(() => { });
		}
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		const db: Database = await new Promise((resolve, reject) => {
			const d: Database = new sqlite3.Database(copy, sqlite3.OPEN_READWRITE, err => err ? reject(err) : resolve(d));
		});
		try {
			return await new Promise<T[]>((resolve, reject) => db.all(sql, (err: Error | null, rows: T[]) => err ? reject(err) : resolve(rows)));
		} finally {
			await new Promise<void>(resolve => db.close(() => resolve()));
		}
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

function isNotFound(e: unknown): boolean {
	return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** The login keychain of the current HOME (macOS keeps it as login.keychain-db, older systems login.keychain). */
export function hasLoginKeychain(home = homedir()): boolean {
	const dir = join(home, 'Library', 'Keychains');
	return existsSync(join(dir, 'login.keychain-db')) || existsSync(join(dir, 'login.keychain'));
}
