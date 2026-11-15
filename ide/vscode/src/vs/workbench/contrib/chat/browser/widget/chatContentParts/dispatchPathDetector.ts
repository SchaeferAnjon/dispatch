/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: finds file paths in the text of a chat reply (patches/325-path-links.patch).
 *
 *  What counts as a path, before the file system is asked:
 *  - absolute (`/Users/x/a.md`, `~/notes/b.md`): at least two segments, or one with an extension;
 *  - relative with a slash (`design/a/README.md`, `./x.ts`, `../y.png`): the last segment has an
 *    extension, or the path ends in `/` (a folder);
 *  - a bare file name with an extension (`README.md`).
 *  Optionally followed by `:line`, `:line:column` or `#Lline`. URLs are masked first; `a/b`,
 *  `and/or`, `1/2`, `v1.2.3` and `x.5` are not paths (no extension that starts with a letter).
 *  No imports, so it can be tested on its own.
 *--------------------------------------------------------------------------------------------*/

export interface IDispatchPathCandidate {
	/** Offsets into the text, the line suffix included. */
	readonly start: number;
	readonly end: number;
	/** The path as written, without the line suffix. */
	readonly path: string;
	readonly line?: number;
	readonly column?: number;
	/** Written with a trailing slash: a folder. */
	readonly isFolder: boolean;
}

const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'`]+|\bmailto:[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/g;
// a segment: ASCII only, so CJK prose right next to a path ends it
const PATH_RE = /(?:~?\/)?(?:[A-Za-z0-9_@+.-]+\/)*[A-Za-z0-9_@+.-]+\/?/g;
const EXT_RE = /[^./]\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const LINE_RE = /^(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)/;
// characters that glue a match to something bigger than a path (an e-mail, a key=value, a URL rest)
const GLUE_BEFORE = /[A-Za-z0-9_@+.\-/\\=]/;

export function findPathCandidates(text: string): IDispatchPathCandidate[] {
	const masked: [number, number][] = [];
	for (const m of text.matchAll(URL_RE)) {
		masked.push([m.index!, m.index! + m[0].length]);
	}
	const out: IDispatchPathCandidate[] = [];
	for (const m of text.matchAll(PATH_RE)) {
		const start = m.index!;
		// a full stop after the path ends the sentence, not the file name
		const raw = m[0].endsWith('/') ? m[0] : m[0].replace(/\.+$/, '');
		if (!raw || !/[A-Za-z]/.test(raw)) {
			continue;
		}
		if (start > 0 && GLUE_BEFORE.test(text[start - 1])) {
			continue;
		}
		if (masked.some(([a, b]) => start < b && start + raw.length > a)) {
			continue;
		}
		if (!isPathLike(raw)) {
			continue;
		}
		let end = start + raw.length;
		let line: number | undefined;
		let column: number | undefined;
		const suffix = LINE_RE.exec(text.slice(end));
		if (suffix && !raw.endsWith('/')) {
			line = Number(suffix[1] ?? suffix[3]);
			const col = suffix[2] ?? suffix[4];
			column = col ? Number(col) : undefined;
			end += suffix[0].length;
		}
		// `a.md:12abc` or `a.md.bak` style tails: the match continues into a word, not a path
		if (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
			continue;
		}
		out.push({ start, end, path: raw, line, column, isFolder: raw.endsWith('/') });
	}
	return out;
}

function isPathLike(raw: string): boolean {
	const absolute = raw.startsWith('/') || raw.startsWith('~/');
	const isFolder = raw.endsWith('/');
	const body = raw.replace(/^~?\//, '').replace(/\/$/, '');
	if (!body) {
		return false;
	}
	const segments = body.split('/');
	if (segments.some(s => !s || /^\.{3,}$/.test(s))) {
		return false; // `a//b`, `.../x`
	}
	const last = segments[segments.length - 1];
	const hasExt = EXT_RE.test(last) && !/^\d+(\.\d+)+$/.test(last);
	if (absolute) {
		return segments.length >= 2 || hasExt;
	}
	if (segments.length > 1 || isFolder) {
		// `./x/` `design/a/` folders, `design/a/README.md` files; never `a/b` or `and/or`
		return isFolder ? segments.some(s => /[A-Za-z]{2,}/.test(s)) : hasExt;
	}
	return hasExt && !last.includes('@'); // an e-mail address, not a file
}
