/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: what the tips remember, per profile: the tours already shown, the checklist items
 *  already done, whether the person hid the checklist.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { parseIdList, withId } from './dispatchToursModel.js';

const KEY_SEEN = 'dispatch.tours.seen';
const KEY_DONE = 'dispatch.checklist.done';
const KEY_HIDDEN = 'dispatch.checklist.hidden';
const KEY_CELEBRATED = 'dispatch.checklist.celebrated';

export class DispatchToursState extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _seen: string[];
	private _done: string[];

	constructor(private readonly storage: IStorageService) {
		super();
		this._seen = parseIdList(storage.get(KEY_SEEN, StorageScope.PROFILE));
		this._done = parseIdList(storage.get(KEY_DONE, StorageScope.PROFILE));
	}

	get seen(): readonly string[] {
		return this._seen;
	}

	get done(): readonly string[] {
		return this._done;
	}

	get checklistHidden(): boolean {
		return this.storage.getBoolean(KEY_HIDDEN, StorageScope.PROFILE, false);
	}

	/** The "you did everything" note was shown once. */
	get celebrated(): boolean {
		return this.storage.getBoolean(KEY_CELEBRATED, StorageScope.PROFILE, false);
	}

	markSeen(id: string): void {
		if (this._seen.includes(id)) {
			return;
		}
		this._seen = withId(this._seen, id);
		this.storage.store(KEY_SEEN, JSON.stringify(this._seen), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChange.fire();
	}

	resetSeen(): void {
		this._seen = [];
		this.storage.remove(KEY_SEEN, StorageScope.PROFILE);
		this._onDidChange.fire();
	}

	/** True when the item was not done before. */
	markDone(id: string): boolean {
		if (this._done.includes(id)) {
			return false;
		}
		this._done = withId(this._done, id);
		this.storage.store(KEY_DONE, JSON.stringify(this._done), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChange.fire();
		return true;
	}

	setChecklistHidden(hidden: boolean): void {
		if (hidden === this.checklistHidden) {
			return;
		}
		if (hidden) {
			this.storage.store(KEY_HIDDEN, true, StorageScope.PROFILE, StorageTarget.USER);
		} else {
			this.storage.remove(KEY_HIDDEN, StorageScope.PROFILE);
		}
		this._onDidChange.fire();
	}

	setCelebrated(): void {
		this.storage.store(KEY_CELEBRATED, true, StorageScope.PROFILE, StorageTarget.USER);
	}
}
