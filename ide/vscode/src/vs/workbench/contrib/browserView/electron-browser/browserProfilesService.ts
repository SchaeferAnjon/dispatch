/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { isBrowserProfileId } from '../../../../platform/browserView/common/browserProfiles.js';
import { IBrowserViewService, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Dispatch: the integrated browser's login identities (kanban task-jj19). Each one keeps its own
 * sign-ins (a persistent browser session of its own, `platform/browserView/common/browserProfiles.ts`),
 * so a person can stay signed in to two accounts of the same site, or keep a test user apart from
 * their own account. The default identity ('') is the browser everyone had before. The list and the
 * identity new pages open with live in application storage, shared by every window; the identity of
 * an open page is fixed when the page is created and kept when the window is restored.
 */

export const DEFAULT_BROWSER_PROFILE = '';

export interface IBrowserProfile {
	/** '' for the default identity. */
	readonly id: string;
	readonly name: string;
}

export const IBrowserProfilesService = createDecorator<IBrowserProfilesService>('dispatchBrowserProfilesService');

export interface IBrowserProfilesService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** The default identity first, then the others in the order they were added. */
	getProfiles(): readonly IBrowserProfile[];
	/** The identity new pages open with, the person's last pick ('' = the default one). */
	readonly current: string;
	setCurrent(id: string): void;
	/** A new identity; throws with a sentence for the person when the name is empty or taken. */
	add(name: string): IBrowserProfile;
	rename(id: string, name: string): void;
	/** Forget an identity and everything it kept (cookies, storage, history). Not the default one. */
	remove(id: string): Promise<void>;
	/** By name (any case) or id; "default" is the default identity. */
	find(nameOrId: string): IBrowserProfile | undefined;
	nameOf(id: string | undefined): string;
}

const LIST_KEY = 'dispatch.browser.identities';
const CURRENT_KEY = 'dispatch.browser.identity';
const MAX_NAME = 40;

export function defaultBrowserProfileName(): string {
	return localize('browser.identity.default', "Default");
}

/** Pure helpers, tested on their own. */
export function parseBrowserProfiles(raw: string | undefined): IBrowserProfile[] {
	try {
		const parsed = JSON.parse(raw || '[]');
		if (!Array.isArray(parsed)) {
			return [];
		}
		const seen = new Set<string>();
		const out: IBrowserProfile[] = [];
		for (const p of parsed) {
			if (p && isBrowserProfileId(p.id) && typeof p.name === 'string' && p.name.trim() && !seen.has(p.id)) {
				seen.add(p.id);
				out.push({ id: p.id, name: p.name.trim().slice(0, MAX_NAME) });
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** A readable id from the name ("Work account" → work-account), unique among `taken`. */
export function browserProfileIdFor(name: string, taken: ReadonlySet<string>): string {
	const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'identity';
	let id = /^[a-z0-9]/.test(base) ? base : `id-${base}`;
	for (let n = 2; taken.has(id) || id === 'default'; n++) {
		id = `${base}-${n}`;
	}
	return id;
}

export class BrowserProfilesService extends Disposable implements IBrowserProfilesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _browserViewService: IBrowserViewService;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this._browserViewService = ProxyChannel.toService<IBrowserViewService>(mainProcessService.getChannel(ipcBrowserViewChannelName));
		const listener = this._register(new DisposableStore());
		for (const key of [LIST_KEY, CURRENT_KEY]) {
			this._register(this._storage.onDidChangeValue(StorageScope.APPLICATION, key, listener)(() => this._onDidChange.fire()));
		}
	}

	private _others(): IBrowserProfile[] {
		return parseBrowserProfiles(this._storage.get(LIST_KEY, StorageScope.APPLICATION));
	}

	private _write(list: readonly IBrowserProfile[]): void {
		this._storage.store(LIST_KEY, JSON.stringify(list), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	getProfiles(): readonly IBrowserProfile[] {
		return [{ id: DEFAULT_BROWSER_PROFILE, name: defaultBrowserProfileName() }, ...this._others()];
	}

	get current(): string {
		const id = this._storage.get(CURRENT_KEY, StorageScope.APPLICATION, DEFAULT_BROWSER_PROFILE);
		return this._others().some(p => p.id === id) ? id : DEFAULT_BROWSER_PROFILE;
	}

	setCurrent(id: string): void {
		const known = id === DEFAULT_BROWSER_PROFILE || this._others().some(p => p.id === id);
		this._storage.store(CURRENT_KEY, known ? id : DEFAULT_BROWSER_PROFILE, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	private _checkName(name: string, except?: string): string {
		const clean = name.trim().replace(/\s+/g, ' ');
		if (!clean) {
			throw new Error(localize('browser.identity.emptyName', "Give the profile a name, for example Work or Test user."));
		}
		if (clean.length > MAX_NAME) {
			throw new Error(localize('browser.identity.longName', "Keep the name under {0} characters.", MAX_NAME));
		}
		const clash = this.getProfiles().find(p => p.id !== except && p.name.toLowerCase() === clean.toLowerCase());
		if (clash || clean.toLowerCase() === 'default') {
			throw new Error(localize('browser.identity.takenName', "There is already a profile called {0}.", clash?.name ?? clean));
		}
		return clean;
	}

	add(name: string): IBrowserProfile {
		const clean = this._checkName(name);
		const others = this._others();
		const profile = { id: browserProfileIdFor(clean, new Set(others.map(p => p.id))), name: clean };
		this._write([...others, profile]);
		return profile;
	}

	rename(id: string, name: string): void {
		const clean = this._checkName(name, id);
		this._write(this._others().map(p => p.id === id ? { id, name: clean } : p));
	}

	async remove(id: string): Promise<void> {
		if (id === DEFAULT_BROWSER_PROFILE) {
			return;
		}
		if (this.current === id) {
			this.setCurrent(DEFAULT_BROWSER_PROFILE);
		}
		this._write(this._others().filter(p => p.id !== id));
		await this._browserViewService.clearProfileStorage(id);
	}

	find(nameOrId: string): IBrowserProfile | undefined {
		const want = nameOrId.trim().toLowerCase();
		if (!want || want === 'default' || want === defaultBrowserProfileName().toLowerCase()) {
			return this.getProfiles()[0];
		}
		return this.getProfiles().find(p => p.id === want || p.name.toLowerCase() === want);
	}

	nameOf(id: string | undefined): string {
		return this.getProfiles().find(p => p.id === (id ?? DEFAULT_BROWSER_PROFILE))?.name ?? defaultBrowserProfileName();
	}
}

registerSingleton(IBrowserProfilesService, BrowserProfilesService, InstantiationType.Delayed);
