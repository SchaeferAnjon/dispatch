/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: file paths in a chat reply become links (patches/325-path-links.patch).
 *
 *  After a reply's markdown is rendered, the text (and whole inline `code` spans) is scanned with
 *  {@link findPathCandidates}; each candidate is resolved against the session's folders (the
 *  Agents window's `_dispatch.pathBases`: the worktree, then the repository it came from; else the
 *  window's workspace folders), then the projects this session's replies named by absolute path (a
 *  session outside any project, like the Assistant in ~/.dispatch/assistant, still links `app/x.py`
 *  after it mentioned /Users/me/Projects/kanban/...), and the home folder; only paths that exist become
 *  links. Absolute and ~/ paths are opened as they are, never joined to a folder. A click
 *  runs `_dispatch.openPath` (the Agents window: Markdown Editor, image preview, integrated
 *  browser, editor at the line, folder in Files); without it the opener service opens the file.
 *--------------------------------------------------------------------------------------------*/

import './media/dispatchPathLinks.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { dirname, isEqualOrParent, joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService, withSelection } from '../../../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../../services/path/common/pathService.js';
import { findPathCandidates, IDispatchPathCandidate } from './dispatchPathDetector.js';

export const DISPATCH_OPEN_PATH_COMMAND = '_dispatch.openPath';
export const DISPATCH_PATH_BASES_COMMAND = '_dispatch.pathBases';

interface IResolved {
	readonly uri: URI;
	readonly isDirectory: boolean;
}

const SKIP_SELECTOR = 'a, pre, button, textarea, .monaco-editor, .interactive-result-code-block, .chat-inline-anchor-widget, .dispatch-path-link, .chat-codeblock-pill-widget';
const CACHE_MS = 15_000;
const resolveCache = new Map<string, { at: number; value: Promise<IResolved | undefined> }>();
/** Per session: the project folders its replies named by absolute path, most recent first. */
const recentProjects = new Map<string, URI[]>();
const RECENT_MAX = 4;

/**
 * Links the paths inside `root`. Resolution is async (a stat per path); the result is applied only
 * while the rendered nodes are still in the document, so a re-render during streaming just starts
 * over on the new nodes.
 */
export function linkifyDispatchPaths(accessor: ServicesAccessor, root: HTMLElement, sessionResource: URI | undefined): IDisposable {
	const store = new DisposableStore();
	const commandService = accessor.get(ICommandService);
	const fileService = accessor.get(IFileService);
	const workspaceService = accessor.get(IWorkspaceContextService);
	const pathService = accessor.get(IPathService);
	const openerService = accessor.get(IOpenerService);

	const targets = collectTargets(root);
	if (!targets.length) {
		return store;
	}
	let disposed = false;
	store.add({ dispose: () => { disposed = true; } });

	void (async () => {
		const sessionBases = await pathBases(commandService, workspaceService, sessionResource);
		const home = pathService.userHome({ preferLocal: true });
		const unique = new Set<string>();
		for (const t of targets) {
			for (const c of t.candidates) {
				unique.add(c.path);
			}
		}
		const resolved = new Map<string, IResolved | undefined>();
		// absolute and ~/ paths first: the projects they sit in become folders for the relative ones
		const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('~/');
		const absolute = [...unique].filter(isAbsolute);
		await Promise.all(absolute.map(async p => resolved.set(p, await resolvePath(fileService, p, sessionBases, home))));
		const key = sessionResource?.toString() ?? '';
		const found = (await Promise.all(absolute.map(p => resolved.get(p)).filter((r): r is IResolved => !!r).map(r => projectRoot(fileService, r, home))))
			.filter((u): u is URI => !!u);
		const recent = [...found, ...(recentProjects.get(key) ?? [])].filter((u, i, all) => all.findIndex(x => x.toString() === u.toString()) === i).slice(0, RECENT_MAX);
		recentProjects.set(key, recent);
		const bases = [...sessionBases, ...recent.filter(u => !sessionBases.some(b => b.toString() === u.toString()))];
		await Promise.all([...unique].filter(p => !isAbsolute(p)).map(async p => resolved.set(p, await resolvePath(fileService, p, bases, home))));
		if (disposed || !root.isConnected) {
			return;
		}
		const open = (target: IResolved, c: IDispatchPathCandidate) => {
			if (CommandsRegistry.getCommand(DISPATCH_OPEN_PATH_COMMAND)) {
				void commandService.executeCommand(DISPATCH_OPEN_PATH_COMMAND, target.uri, { line: c.line, column: c.column, isDirectory: target.isDirectory });
			} else {
				void openerService.open(c.line ? withSelection(target.uri, { startLineNumber: c.line, startColumn: c.column ?? 1 }) : target.uri);
			}
		};
		for (const t of targets) {
			if (!t.node.isConnected || t.node.textContent !== t.text) {
				continue;
			}
			if (t.kind === 'code') {
				const c = t.candidates[0];
				const hit = resolved.get(c.path);
				if (hit) {
					decorate(store, t.node as HTMLElement, hit, c, open);
				}
				continue;
			}
			wrapTextNode(store, t.node as Text, t.candidates, resolved, open);
		}
	})();
	return store;
}

interface ITarget {
	readonly kind: 'text' | 'code';
	readonly node: Node;
	readonly text: string;
	readonly candidates: IDispatchPathCandidate[];
}

function collectTargets(root: HTMLElement): ITarget[] {
	const out: ITarget[] = [];
	// inline code that is exactly a path: the whole span is the link
	// eslint-disable-next-line no-restricted-syntax
	for (const code of root.querySelectorAll('code')) {
		if (code.closest(SKIP_SELECTOR)) {
			continue;
		}
		const text = code.textContent ?? '';
		const trimmed = text.trim();
		const candidates = findPathCandidates(trimmed);
		if (candidates.length === 1 && candidates[0].start === 0 && candidates[0].end === trimmed.length) {
			out.push({ kind: 'code', node: code, text, candidates });
		}
	}
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const parent = n.parentElement;
		if (!parent || parent.closest(SKIP_SELECTOR) || parent.closest('code')) {
			continue;
		}
		const text = n.textContent ?? '';
		if (text.length < 3 || !/[./]/.test(text)) {
			continue;
		}
		const candidates = findPathCandidates(text);
		if (candidates.length) {
			out.push({ kind: 'text', node: n, text, candidates });
		}
	}
	return out;
}

async function pathBases(commandService: ICommandService, workspaceService: IWorkspaceContextService, sessionResource: URI | undefined): Promise<URI[]> {
	if (CommandsRegistry.getCommand(DISPATCH_PATH_BASES_COMMAND)) {
		try {
			const bases = await commandService.executeCommand<URI[]>(DISPATCH_PATH_BASES_COMMAND, sessionResource);
			if (bases?.length) {
				return bases.map(b => URI.revive(b));
			}
		} catch {
			// fall back to the window's folders
		}
	}
	return workspaceService.getWorkspace().folders.map(f => f.uri);
}

/** The project a file sits in: the nearest folder above it with a .git (a repository or a worktree), below the home folder. */
async function projectRoot(fileService: IFileService, target: IResolved, home: URI): Promise<URI | undefined> {
	let dir = target.isDirectory ? target.uri : dirname(target.uri);
	for (let i = 0; i < 8 && isEqualOrParent(dir, home) && dir.toString() !== home.toString(); i++) {
		if (await fileService.exists(joinPath(dir, '.git'))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function resolvePath(fileService: IFileService, path: string, bases: URI[], home: URI): Promise<IResolved | undefined> {
	const key = `${bases.map(b => b.toString()).join('|')}\n${path}`;
	const hit = resolveCache.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) {
		return hit.value;
	}
	const value = (async () => {
		const clean = path.replace(/\/$/, '');
		let candidates: URI[];
		if (clean.startsWith('~/')) {
			candidates = [joinPath(home, clean.slice(2))];
		} else if (clean.startsWith('/')) {
			candidates = [URI.file(clean)];
		} else {
			candidates = bases.map(b => joinPath(b, clean));
		}
		for (const uri of candidates) {
			try {
				const stat = await fileService.stat(uri);
				return { uri, isDirectory: stat.isDirectory };
			} catch {
				// not here, try the next folder
			}
		}
		return undefined;
	})();
	resolveCache.set(key, { at: Date.now(), value });
	return value;
}

function decorate(store: DisposableStore, el: HTMLElement, target: IResolved, c: IDispatchPathCandidate, open: (t: IResolved, c: IDispatchPathCandidate) => void): void {
	el.classList.add('dispatch-path-link');
	el.setAttribute('role', 'link');
	el.tabIndex = 0;
	el.title = c.line
		? localize('dispatchPathLink.titleLine', "Open {0} at line {1}", target.uri.fsPath, c.line)
		: localize('dispatchPathLink.title', "Open {0}", target.uri.fsPath);
	store.add(dom.addDisposableListener(el, dom.EventType.CLICK, e => {
		// a click that ends a text selection is a selection, not a click on the link
		const selection = dom.getWindow(el).getSelection();
		if (selection && !selection.isCollapsed && selection.toString().trim()) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		open(target, c);
	}));
	store.add(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			open(target, c);
		}
	}));
}

function wrapTextNode(store: DisposableStore, node: Text, candidates: IDispatchPathCandidate[], resolved: Map<string, IResolved | undefined>, open: (t: IResolved, c: IDispatchPathCandidate) => void): void {
	const text = node.textContent ?? '';
	const hits = candidates.filter(c => resolved.get(c.path));
	if (!hits.length) {
		return;
	}
	const doc = node.ownerDocument;
	const frag = doc.createDocumentFragment();
	let at = 0;
	for (const c of hits) {
		if (c.start > at) {
			frag.appendChild(doc.createTextNode(text.slice(at, c.start)));
		}
		const span = doc.createElement('span');
		span.textContent = text.slice(c.start, c.end);
		decorate(store, span, resolved.get(c.path)!, c, open);
		frag.appendChild(span);
		at = c.end;
	}
	if (at < text.length) {
		frag.appendChild(doc.createTextNode(text.slice(at)));
	}
	node.replaceWith(frag);
}
