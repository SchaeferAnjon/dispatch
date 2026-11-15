/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: a project's folder the way a person reads it, one function for every place the Agents window
 *  shows one (Settings › Projects, the Projects page, a project's page head). A folder in the home folder is
 *  `~/…`; one in iCloud Drive is `iCloud Drive/…`, as Finder names it, not `~/Library/Mobile Documents/
 *  com~apple~CloudDocs/…`; a long one is cut in the middle (kanban DESIGN.md middlePath). Pure: no imports, so
 *  ide/tests runs it as it is.
 *--------------------------------------------------------------------------------------------*/

export const ICLOUD_DRIVE = 'iCloud Drive';

/** iCloud Drive's own folder, under whichever home folder it is in. */
const ICLOUD = /^(?:.*\/)?Library\/Mobile Documents\/com~apple~CloudDocs(?=\/|$)/;

function trimSlash(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function isInICloudDrive(path: string): boolean {
	return ICLOUD.test(path);
}

/** `/Users/<name>` of a path in someone's home folder, else undefined. */
export function homeOf(path: string): string | undefined {
	return /^\/Users\/[^/]+(?=\/|$)/.exec(path)?.[0];
}

/**
 * `~/Projects/x`, `iCloud Drive/河湾大学/ALG`, or the path as it is. `home` is the home folder that becomes `~`
 * (this Mac's, or the other Mac's for a project there).
 */
export function displayPath(path: string, home: string | undefined): string {
	const p = trimSlash(path);
	const icloud = ICLOUD.exec(p);
	if (icloud) {
		return ICLOUD_DRIVE + p.slice(icloud[0].length);
	}
	const h = home ? trimSlash(home) : '';
	if (h && h !== '/' && (p === h || p.startsWith(h + '/'))) {
		return '~' + p.slice(h.length);
	}
	return p;
}

/** The shown path in two: everything up to the last folder (with its slash), and the last folder. A line that is
 *  too narrow cuts the first part and keeps the folder's own name. */
export function splitPathTail(shown: string): { readonly head: string; readonly tail: string } {
	const i = shown.lastIndexOf('/');
	return i < 0 ? { head: '', tail: shown } : { head: shown.slice(0, i + 1), tail: shown.slice(i + 1) };
}

/** A long path cut in the middle by characters, for a line without room to measure: its first folder and its
 *  last two stay. */
export function middlePath(path: string, max = 44): string {
	if (path.length <= max) {
		return path;
	}
	const parts = path.split('/');
	if (parts.length <= 3) {
		return path;
	}
	return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

export interface IProjectPlaceInput {
	readonly dir: string;
	readonly host: string;
	readonly machine: string;
	/** The folder it was registered with, when that is not on this Mac any more (`dispatch projects --json`). */
	readonly missing_dir?: string;
}

export type ProjectPlaceKind = 'mac' | 'icloud' | 'remote' | 'missing';

export interface IProjectPlace {
	readonly kind: ProjectPlaceKind;
	/** The group it goes under when the list is grouped: This Mac, iCloud Drive, the other Mac's name, Not found. */
	readonly group: string;
	/** Said before the path: why there is no folder, or the other Mac's name. */
	readonly note: string;
	/** The path as shown ('' when there is none). */
	readonly path: string;
	/** The whole path, for the hover. */
	readonly full: string;
}

/** Where a project lives, in words. `home` is this Mac's home folder. */
export function projectPlace(p: IProjectPlaceInput, home: string | undefined): IProjectPlace {
	if (p.host !== 'local') {
		return { kind: 'remote', group: p.machine, note: p.machine, path: p.dir ? displayPath(p.dir, homeOf(p.dir)) : '', full: p.dir };
	}
	if (p.dir) {
		const icloud = isInICloudDrive(p.dir);
		return { kind: icloud ? 'icloud' : 'mac', group: icloud ? ICLOUD_DRIVE : 'This Mac', note: '', path: displayPath(p.dir, home), full: p.dir };
	}
	const gone = p.missing_dir ?? '';
	if (!gone) {
		return { kind: 'missing', group: 'Not found', note: 'No folder', path: '', full: '' };
	}
	// another person's home folder: the folder of another Mac this one has no host for
	const otherHome = homeOf(gone);
	const elsewhere = !!otherHome && !!home && otherHome !== trimSlash(home);
	return {
		kind: 'missing',
		group: 'Not found',
		note: elsewhere ? 'Not on this Mac' : 'Folder missing',
		path: displayPath(gone, elsewhere ? undefined : home),
		full: gone,
	};
}

const ORDER: Record<ProjectPlaceKind, number> = { mac: 0, icloud: 1, remote: 2, missing: 3 };

/**
 * The projects in groups by place, in the list's order within each: This Mac, iCloud Drive, each other Mac by name,
 * Not found. One group when they are all in one place (then the list shows no group names).
 */
export function groupByPlace<T>(items: readonly T[], placeOf: (item: T) => IProjectPlace): { readonly name: string; readonly items: readonly T[] }[] {
	const groups = new Map<string, { kind: ProjectPlaceKind; items: T[] }>();
	for (const item of items) {
		const place = placeOf(item);
		let g = groups.get(place.group);
		if (!g) {
			g = { kind: place.kind, items: [] };
			groups.set(place.group, g);
		}
		g.items.push(item);
	}
	return [...groups.entries()]
		.sort(([a, ga], [b, gb]) => ORDER[ga.kind] - ORDER[gb.kind] || a.localeCompare(b))
		.map(([name, g]) => ({ name, items: g.items }));
}
