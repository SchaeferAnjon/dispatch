/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: What's new, the data and when it shows (kanban design/annotations/redesign 第 3 节,
 *  DECISIONS.md 「标注图四个触点」; patches/480-whats-new.patch).
 *
 *  The app carries `whats-new/whats-new.json` next to its code (build.sh copies it into
 *  Resources/app/whats-new with the pictures), nothing is fetched:
 *
 *      { "v": 1, "version": "1.139.1", "date": "2026-09-28",
 *        "releaseNotes": "https://github.com/…/releases",
 *        "features": [ { "id": "draw-and-ask", "title": "Draw and ask", "description": "…",
 *            "where": "Chat input, on a pasted picture", "icon": "edit", "version": "2026-09-28",
 *            "badge": true,
 *            "anchor": { "selector": "…", "text": "Overview" },
 *            "command": "…", "args": [], "target": { "selector": "…" },
 *            "image": "draw-and-ask.png", "marks": "draw-and-ask.json", "mark": 1 } ] }
 *
 *  `version` is the build date a feature arrived in; `anchor` finds its entry point in the Agents
 *  window (a CSS selector, narrowed by visible text or aria-label); `command` + `args` bring that
 *  entry point into view for Show me, `target` is what flashes then (default: the anchor); `image`
 *  and `marks` are its Where to look picture (marks JSON, dispatchWhere.ts). At most five features,
 *  at most three with a NEW badge.
 *
 *  After an update (the build's commit changed) the features newer than the build you came from are
 *  "this update's": the title bar says What's new for 7 days, each badged entry point has NEW until
 *  you use it or say Got it. A new install shows nothing; the first build that has this shows its
 *  features to someone who had the Agents window before.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISessionsWindowUsageService } from '../../../services/sessions/browser/sessionsWindowUsageService.js';
import { IDispatchMarks, parseDispatchMarks, readDispatchMarks, resolveDispatchPicture } from '../../dispatchCommon/browser/dispatchWhere.js';

export interface IDispatchWhatsNewAnchor {
	/** CSS selector of the entry point. */
	readonly selector: string;
	/** Only the matches whose visible text starts with these words ({@link dispatchLabelStartsWith}). */
	readonly text?: string;
	/** Only the matches whose aria-label starts with these words. */
	readonly aria?: string;
}

export interface IDispatchWhatsNewFeature {
	readonly id: string;
	readonly title: string;
	/** One sentence. */
	readonly description: string;
	/** Where its entry point is, in words. */
	readonly where: string;
	/** A codicon for the where line. */
	readonly icon?: string;
	/** The build date it arrived in (YYYY-MM-DD). */
	readonly version?: string;
	readonly badge: boolean;
	readonly anchor?: IDispatchWhatsNewAnchor;
	readonly command?: string;
	readonly args?: readonly unknown[];
	readonly target?: IDispatchWhatsNewAnchor;
	/** Its Where to look picture and marks. */
	readonly picture?: IDispatchMarks;
	readonly mark?: number;
}

export interface IDispatchWhatsNewData {
	readonly version: string;
	readonly date: string;
	readonly releaseNotes?: string;
	readonly features: readonly IDispatchWhatsNewFeature[];
}

const MAX_FEATURES = 5;
const MAX_BADGES = 3;
export const WHATS_NEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY_LAST_BUILD = 'dispatch.whatsNew.lastBuild';
const KEY_CURRENT = 'dispatch.whatsNew.current';
const KEY_SEEN = 'dispatch.whatsNew.seen';

interface ILastBuild { readonly commit: string; readonly date: string }
interface ICurrent { readonly commit: string; readonly since: number; readonly ids: readonly string[] }

/** The folder the app keeps What's new in (Resources/app/whats-new). */
export function dispatchWhatsNewFolder(): URI {
	return URI.joinPath(FileAccess.asFileUri(''), '..', 'whats-new');
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function anchorOf(v: unknown): IDispatchWhatsNewAnchor | undefined {
	if (typeof v === 'string' && v.trim()) {
		return { selector: v.trim() };
	}
	if (typeof v === 'object' && v && !Array.isArray(v)) {
		const r = v as Record<string, unknown>;
		const selector = str(r.selector);
		return selector ? { selector, text: str(r.text), aria: str(r.aria) } : undefined;
	}
	return undefined;
}

export class DispatchWhatsNewModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _data: IDispatchWhatsNewData | undefined;
	private _current: ICurrent | undefined;
	private _seen: Set<string>;
	private readonly _ready: Promise<void>;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@ISessionsWindowUsageService private readonly usageService: ISessionsWindowUsageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._seen = new Set(this.readJson<string[]>(KEY_SEEN) ?? []);
		this._ready = this.load();
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	get data(): IDispatchWhatsNewData | undefined {
		return this._data;
	}

	/** This update's features (empty unless an update brought some). */
	get features(): readonly IDispatchWhatsNewFeature[] {
		if (!this._data || !this._current) {
			return [];
		}
		const ids = new Set(this._current.ids);
		return this._data.features.filter(f => ids.has(f.id));
	}

	/** The title bar entry shows: an update brought features, less than 7 days ago. */
	get showEntry(): boolean {
		return !!this._current && Date.now() - this._current.since < WHATS_NEW_DAYS * DAY_MS && this.features.length > 0;
	}

	/** When the update was first seen (for "Sep 28"). */
	get since(): number | undefined {
		return this._current?.since;
	}

	/** Features whose NEW badge shows now (at most three, not seen yet). */
	get badged(): readonly IDispatchWhatsNewFeature[] {
		return this.features.filter(f => f.badge && f.anchor && !this._seen.has(f.id)).slice(0, MAX_BADGES);
	}

	isSeen(id: string): boolean {
		return this._seen.has(id);
	}

	markSeen(id: string): void {
		if (this._seen.has(id)) {
			return;
		}
		this._seen.add(id);
		this.storageService.store(KEY_SEEN, JSON.stringify([...this._seen]), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire();
	}

	/** Developer: show this build's What's new as right after an update (all its features, nothing seen; whats-new.json read again). */
	async previewAsAfterUpdate(): Promise<void> {
		this._data = await this.readData();
		const commit = this.productService.commit ?? 'dev';
		this._current = { commit, since: Date.now(), ids: (this._data?.features ?? []).map(f => f.id) };
		this._seen.clear();
		this.storageService.store(KEY_CURRENT, JSON.stringify(this._current), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.remove(KEY_SEEN, StorageScope.APPLICATION);
		this._onDidChange.fire();
	}

	async welcomeOnce(): Promise<boolean> {
		await this.ready;
		if (this.storageService.getBoolean('dispatch.whatsNew.welcomeShown', StorageScope.APPLICATION, false)) { return false; }
		this.storageService.store('dispatch.whatsNew.welcomeShown', true, StorageScope.APPLICATION, StorageTarget.USER);
		this._current = { commit: this.productService.commit ?? 'dev', since: Date.now(), ids: (this._data?.features ?? []).map(f => f.id) };
		this.storageService.store(KEY_CURRENT, JSON.stringify(this._current), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire();
		return true;
	}

	private readJson<T>(key: string): T | undefined {
		const raw = this.storageService.get(key, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}

	private async load(): Promise<void> {
		this._data = await this.readData();
		const commit = this.productService.commit ?? 'dev';
		const date = this.productService.date ?? '';
		const last = this.readJson<ILastBuild>(KEY_LAST_BUILD);
		let current = this.readJson<ICurrent>(KEY_CURRENT);
		const all = (this._data?.features ?? []).map(f => f.id);
		if (!last) {
			// the first build that has What's new: its features are new to someone who used the Agents window before
			if (this.usageService.hadPriorWindowOpen && all.length) {
				current = { commit, since: Date.now(), ids: all };
			}
		} else if (last.commit !== commit) {
			const from = (last.date ?? '').slice(0, 10);
			const ids = (this._data?.features ?? []).filter(f => !f.version || !from || f.version >= from).map(f => f.id);
			current = ids.length ? { commit, since: Date.now(), ids } : undefined;
		}
		if (current && current.commit !== commit) {
			current = undefined;
		}
		this._current = current;
		this.storageService.store(KEY_LAST_BUILD, JSON.stringify({ commit, date } satisfies ILastBuild), StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (current) {
			this.storageService.store(KEY_CURRENT, JSON.stringify(current), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(KEY_CURRENT, StorageScope.APPLICATION);
		}
		this._onDidChange.fire();
	}

	private async readData(): Promise<IDispatchWhatsNewData | undefined> {
		const folder = dispatchWhatsNewFolder();
		const json = URI.joinPath(folder, 'whats-new.json');
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse((await this.fileService.readFile(json)).value.toString());
		} catch (e) {
			this.logService.trace('[dispatch] whats-new.json not read', e);
			return undefined;
		}
		const features: IDispatchWhatsNewFeature[] = [];
		for (const f of Array.isArray(raw.features) ? raw.features.slice(0, MAX_FEATURES) : []) {
			if (typeof f !== 'object' || !f) {
				continue;
			}
			const r = f as Record<string, unknown>;
			const id = str(r.id), title = str(r.title);
			if (!id || !title) {
				continue;
			}
			let picture: IDispatchMarks | undefined;
			const image = str(r.image);
			if (typeof r.marks === 'string') {
				picture = await readDispatchMarks(this.fileService, URI.joinPath(folder, r.marks));
			} else if (r.marks && typeof r.marks === 'object') {
				const parsed = parseDispatchMarks({ image, ...(r.marks as object) });
				picture = parsed && { ...parsed, image: resolveDispatchPicture(json, parsed.image).toString() };
			}
			if (!picture && image) {
				picture = { image: resolveDispatchPicture(json, image).toString(), marks: [] };
			}
			if (picture && image && !picture.image) {
				picture = { ...picture, image: resolveDispatchPicture(json, image).toString() };
			}
			features.push({
				id,
				title,
				description: str(r.description) ?? '',
				where: str(r.where) ?? '',
				icon: str(r.icon),
				version: str(r.version),
				badge: r.badge === true,
				anchor: anchorOf(r.anchor),
				command: str(r.command),
				args: Array.isArray(r.args) ? r.args : undefined,
				target: anchorOf(r.target),
				picture,
				mark: typeof r.mark === 'number' ? r.mark : undefined,
			});
		}
		return {
			version: str(raw.version) ?? this.productService.version,
			date: str(raw.date) ?? '',
			releaseNotes: str(raw.releaseNotes),
			features,
		};
	}
}

/**
 * `label` starts with the words `want` (case aside) and they end there: a count, a comma or our NEW
 * may follow, another word may not ("Tasks" is not "tasks-tab.png").
 */
export function dispatchLabelStartsWith(label: string, want: string): boolean {
	const l = label.replace(/\s+/g, ' ').trim().toLowerCase(), w = want.trim().toLowerCase();
	return l.startsWith(w) && (l.length === w.length || !/[\p{L}._\-]/u.test(l[w.length]));
}

/** An entry's text without the NEW badges put into it. */
function ownText(el: HTMLElement): string {
	let text = el.textContent ?? '';
	for (const b of el.querySelectorAll('.dispatch-new-badge')) {
		text = text.replace(b.textContent ?? '', ' ');
	}
	return text;
}

/** The elements an anchor points at, in the page order. */
export function findDispatchAnchor(doc: Document, anchor: IDispatchWhatsNewAnchor): HTMLElement[] {
	let list: HTMLElement[];
	try {
		list = [...doc.querySelectorAll<HTMLElement>(anchor.selector)];
	} catch {
		return [];
	}
	if (anchor.text) {
		const want = anchor.text;
		// the entry's own words come first (a count may follow); our NEW is not part of them: "OverviewNew"
		// would not match, the next scan would take the badge off and the one after put it back, forever
		list = list.filter(el => dispatchLabelStartsWith(ownText(el), want));
	}
	if (anchor.aria) {
		const want = anchor.aria;
		list = list.filter(el => dispatchLabelStartsWith(el.getAttribute('aria-label') ?? '', want));
	}
	return list;
}
