/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createCipheriv, createHash } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { chromiumTimeToEpochSeconds, cookieRowToElectron, decryptCookieValue, deriveCookieKey, flattenBookmarks, historyRowsToEntries, IChromiumCookieRow, parseLocalStateProfiles } from '../../node/browserImportHelpers.js';

// A made-up password for a made-up profile: no real keychain item or cookie is involved.
const FAKE_PASSWORD = 'dispatch-test-only-not-a-real-key';

/** Encrypts like Chromium on macOS: "v10" + AES-128-CBC (IV of 16 spaces) of [SHA-256(host) +] value. */
function encrypt(value: string, password: string, host?: string): Buffer {
	const key = deriveCookieKey(password);
	const plain = host ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value, 'utf8')]) : Buffer.from(value, 'utf8');
	const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
	return Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plain), cipher.final()]);
}

/** Chromium time for seconds since 1970. */
function chromiumTime(epochSeconds: number): number {
	return (epochSeconds + 11644473600) * 1e6;
}

function row(overrides: Partial<IChromiumCookieRow>): IChromiumCookieRow {
	return {
		host_key: 'example.test', name: 'sid', value: '', encrypted_value: null, path: '/',
		expires_utc: 0, is_secure: 0, is_httponly: 0, has_expires: 0, samesite: -1, top_frame_site_key: '',
		...overrides,
	};
}

suite('Dispatch browser import helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('derives the 16 byte key and decrypts a v10 value', () => {
		const key = deriveCookieKey(FAKE_PASSWORD);
		assert.strictEqual(key.length, 16);
		assert.strictEqual(decryptCookieValue(encrypt('hello-cookie', FAKE_PASSWORD), null, key, 23, 'example.test'), 'hello-cookie');
	});

	test('drops the host hash that databases from version 24 put in front', () => {
		const key = deriveCookieKey(FAKE_PASSWORD);
		const enc = encrypt('abc123', FAKE_PASSWORD, '.example.test');
		assert.strictEqual(decryptCookieValue(enc, null, key, 24, '.example.test'), 'abc123');
		// a matching hash is dropped even when the version is not known
		assert.strictEqual(decryptCookieValue(enc, null, key, 0, '.example.test'), 'abc123');
	});

	test('a wrong key or an unknown format gives undefined, an empty blob the plain value', () => {
		const other = deriveCookieKey('some-other-fake-password');
		assert.strictEqual(decryptCookieValue(encrypt('secret-ish', FAKE_PASSWORD), null, other, 23, 'example.test'), undefined);
		assert.strictEqual(decryptCookieValue(Buffer.from('x9zabc'), null, other, 23, 'example.test'), undefined);
		assert.strictEqual(decryptCookieValue(Buffer.alloc(0), 'plain', other, 23, 'example.test'), 'plain');
		assert.strictEqual(decryptCookieValue(null, null, other, 23, 'example.test'), '');
	});

	test('host-only and domain cookies map to Electron cookie details', () => {
		const now = 1_800_000_000;
		const hostOnly = cookieRowToElectron(row({ host_key: 'app.example.test', path: '/a', is_secure: 1, is_httponly: 1, samesite: 1 }), 'v', now);
		assert.deepStrictEqual(hostOnly, {
			kind: 'ok',
			details: { url: 'https://app.example.test/a', name: 'sid', value: 'v', path: '/a', secure: true, httpOnly: true, sameSite: 'lax' },
		});
		const domain = cookieRowToElectron(row({ host_key: '.example.test', has_expires: 1, expires_utc: chromiumTime(now + 3600), samesite: 2 }), 'w', now);
		assert.strictEqual(domain.kind, 'ok');
		if (domain.kind === 'ok') {
			assert.strictEqual(domain.details.domain, '.example.test');
			assert.strictEqual(domain.details.url, 'http://example.test/');
			assert.strictEqual(domain.details.sameSite, 'strict');
			assert.strictEqual(Math.round(domain.details.expirationDate!), now + 3600);
		}
	});

	test('expired, partitioned and SameSite=None without Secure are left out; session cookies stay', () => {
		const now = 1_800_000_000;
		assert.deepStrictEqual(cookieRowToElectron(row({ has_expires: 1, expires_utc: chromiumTime(now - 1) }), 'v', now), { kind: 'expired' });
		assert.deepStrictEqual(cookieRowToElectron(row({ top_frame_site_key: 'https://top.test' }), 'v', now), { kind: 'skipped', reason: 'partitioned' });
		assert.deepStrictEqual(cookieRowToElectron(row({ samesite: 0, is_secure: 0 }), 'v', now), { kind: 'skipped', reason: 'invalid' });
		const session = cookieRowToElectron(row({ has_expires: 0, expires_utc: 0, samesite: 0, is_secure: 1 }), 'v', now);
		assert.strictEqual(session.kind, 'ok');
		if (session.kind === 'ok') {
			assert.strictEqual(session.details.expirationDate, undefined);
			assert.strictEqual(session.details.sameSite, 'no_restriction');
		}
	});

	test('Chromium time converts to seconds since 1970', () => {
		assert.strictEqual(chromiumTimeToEpochSeconds(chromiumTime(1_700_000_000)), 1_700_000_000);
	});

	test('Local State profiles come in the browser order with names and accounts', () => {
		const profiles = parseLocalStateProfiles({
			profile: {
				profiles_order: ['Profile 1', 'Default'],
				info_cache: {
					'Default': { name: 'Person 1' },
					'Profile 1': { name: 'Work', user_name: 'someone@example.test' },
					'Profile 2': {},
				},
			},
		});
		assert.deepStrictEqual(profiles, [
			{ id: 'Profile 1', name: 'Work', account: 'someone@example.test' },
			{ id: 'Default', name: 'Person 1' },
			{ id: 'Profile 2', name: 'Profile 2' },
		]);
		assert.deepStrictEqual(parseLocalStateProfiles({}), []);
		assert.deepStrictEqual(parseLocalStateProfiles(undefined), []);
	});

	test('bookmarks flatten with their folder path, each URL once, http(s) only', () => {
		const flat = flattenBookmarks({
			roots: {
				bookmark_bar: {
					name: 'Bookmarks bar', type: 'folder', children: [
						{ type: 'url', name: 'Docs', url: 'https://docs.example.test/' },
						{
							type: 'folder', name: 'Work', children: [
								{ type: 'url', name: 'Board', url: 'https://board.example.test/' },
								{ type: 'url', name: 'Bookmarklet', url: 'javascript:alert(1)' },
							]
						},
					]
				},
				other: { type: 'folder', children: [{ type: 'url', name: 'Docs again', url: 'https://docs.example.test/' }, { type: 'url', url: 'http://plain.example.test/' }] },
				synced: { type: 'folder', children: [] },
			},
		});
		assert.deepStrictEqual(flat, [
			{ title: 'Docs', url: 'https://docs.example.test/', folder: 'Bookmarks bar' },
			{ title: 'Board', url: 'https://board.example.test/', folder: 'Bookmarks bar / Work' },
			{ title: 'http://plain.example.test/', url: 'http://plain.example.test/', folder: 'Other bookmarks' },
		]);
		assert.deepStrictEqual(flattenBookmarks({}), []);
	});

	test('history rows keep http(s), each URL once, up to the limit', () => {
		const entries = historyRowsToEntries([
			{ url: 'https://a.example.test/', title: 'A', visit_count: 9, last_visit_time: chromiumTime(1_700_000_000) },
			{ url: 'chrome://settings', title: 'Settings', visit_count: 8, last_visit_time: 0 },
			{ url: 'https://a.example.test/', title: 'A dup', visit_count: 1, last_visit_time: 0 },
			{ url: 'http://b.example.test/', title: null, visit_count: 3, last_visit_time: 0 },
			{ url: 'https://c.example.test/', title: 'C', visit_count: 1, last_visit_time: 0 },
		], 2);
		assert.deepStrictEqual(entries, [
			{ url: 'https://a.example.test/', title: 'A', visits: 9, lastVisit: 1_700_000_000_000 },
			{ url: 'http://b.example.test/', title: '', visits: 3, lastVisit: 0 },
		]);
	});
});
