// The Docs tab's first frame (user 2026-10-09: "Files opens at once, why does Docs take so long?"): the
// project's documents straight from its folders, sorted into the tab's groups, merged with the last full
// answer of `dispatch docs list` kept on disk. The CLI's answer (titles of registered documents, tasks,
// sessions, "Where to look") replaces it a moment later; until then this is what the tab shows.
//
// The rules are kanban app/cli/docs_view.py's (shelf, group_of, fold) and dispatch.py's docs_scan, for the
// files alone: what only the board knows (a registration's kind, "Remove from Docs") comes from the cache.
// No vscode import (vitest runs it).
import * as fs from "fs";
import * as path from "path";
import { DocGroup, DocRow, deliveryKind } from "./docs";

export const DOC_DIR_NAMES = ["design", "docs", "研究"];
const DOC_EXTS = new Set([".md", ".html", ".htm"]);
/** Published-site folders, not working documents (dispatch.py DOC_SKIP_DIRS). */
const SKIP_DIRS = new Set(["node_modules", "manual", "demo", "dist", "build", "assets", "_site", "site", "public", "static", "vendor"]);
const MAX_DEPTH = 2;
const HEAD_BYTES = 8192;
const CACHE_VERSION = 1;

const RESEARCH_TITLE = ["调研", "复审", "审读", "复核"];
const DELIVERED_TITLE = ["真机截图", "实现截图", "真机验收", "实机验收"];
const NOTES_TITLE = ["定稿", "设计偏好", "实施计划"];
const DELIVERED_PATH = /\/(impl|phase1|codepilot-impl)(\/|$)/;
const NOTES_FILE = /^(DECISIONS|PLAN|NOTES)(\.[a-z]+)?$/i;
const SCRATCH_PATH = /\/design\/e2e\/|\/scratchpad\//;
const WORK_PATH = /\/design\/handoff\/|\/handoffs\//;
const REPORT_NAME = /(^|[-_])report\.md$/i;
const PROPOSAL_PAGES = ["index.html", "index.htm", "proposal.html"];
const SOURCE_NAMES = ["readme.md", "notes.md"];

/** The repository a folder belongs to: a linked worktree (its .git is a file) counts as the main checkout. */
export function projectRoot(folder: string): string {
  let d = path.resolve(folder);
  for (;;) {
    const dotgit = path.join(d, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotgit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return d;
    if (st?.isFile()) {
      const gitdir = fs.readFileSync(dotgit, "utf8").match(/gitdir:\s*(.+)/)?.[1].trim() ?? "";
      const abs = gitdir ? path.resolve(d, gitdir) : "";
      const main = abs.includes("/.git/worktrees/") ? abs.split("/.git/worktrees/")[0] : "";
      return main && fs.existsSync(main) ? main : d;
    }
    const up = path.dirname(d);
    if (up === d) return path.resolve(folder);
    d = up;
  }
}

export interface ScannedDoc {
  path: string;
  /** Seconds since the epoch. */
  mtime: number;
  ext: string;
}

/** Every .md / .html under design/, docs/ and 研究/ of the project, at most two folders deep (dispatch.py docs_scan). */
export function scanDocFiles(root: string): ScannedDoc[] {
  const out: ScannedDoc[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // a two-letter folder is a translation of a published manual
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(e.name) || e.name.startsWith(".") || /^[a-z]{2}$/.test(e.name)) continue;
        walk(p, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!DOC_EXTS.has(ext)) continue;
      let real = p;
      try {
        if (e.isSymbolicLink()) real = fs.realpathSync(p);
        const st = fs.statSync(real);
        if (!st.isFile() || seen.has(real)) continue;
        seen.add(real);
        out.push({ path: real, mtime: st.mtimeMs / 1000, ext: ext.slice(1) });
      } catch {
        continue;
      }
    }
  };
  for (const sub of DOC_DIR_NAMES) walk(path.join(root, sub), 0);
  return out;
}

function readHead(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** First `# heading`, or <title> / <h1> of a page, else the file name without its suffix (dispatch.py docs_title). */
export function docTitle(file: string, head: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, "").slice(0, 80);
  if (/\.html?$/i.test(file)) {
    const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || head.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const t = m ? m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    return t ? t.slice(0, 80) : base;
  }
  for (const line of head.split("\n")) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim().slice(0, 80);
  }
  return base;
}

/** A heading's inline Markdown as the words it shows. */
function plainTitle(title: string): string {
  return title
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

const BOOK_PART = /^(task-[a-z0-9]{2,8}|\d{4}-\d{2}-\d{2}|[A-Za-z0-9]{1,3}\s*组|完成|草稿|wip)$/i;

/** 「任务模块真机截图（task-ha7k，2026-09-27）」→「任务模块真机截图」 (docs_view.display_title). */
export function displayTitle(title: string): string {
  const t = plainTitle(title);
  const m = t.match(/\s*[（(]([^（）()]*)[）)]\s*$/);
  if (m && m.index !== undefined && t.slice(0, m.index).trim()) {
    const parts: string[] = [];
    for (const p of m[1].split(/[，,、;；\s]\s*/).map((x) => x.trim()).filter(Boolean)) {
      if (p === "组" && parts.length) parts[parts.length - 1] += " 组";
      else parts.push(p);
    }
    if (parts.length && parts.every((p) => BOOK_PART.test(p))) return t.slice(0, m.index).trimEnd();
  }
  return t;
}

/** 调研 / 复审 / 设计 / 文档 from the file's name and folder (dispatch.py docs_kind_of, docs_kind_in_design). */
function kindOf(file: string): string {
  const name = path.basename(file);
  const low = name.toLowerCase();
  if (low.includes("research") || name.includes("调研")) return "调研";
  if (low.includes("review") || name.includes("复审")) return "复审";
  return path.dirname(file).split(path.sep).includes("design") ? "设计" : "文档";
}

interface Entry extends ScannedDoc {
  name: string;
  dir: string;
  title: string;
  kind: string;
  /** A `dispatch deliver` page: "impl" or "proposal" ("" for an old page without the kind, undefined for no page). */
  page?: "impl" | "proposal" | "";
}

/** docs_view.group_of for a file nobody registered. */
function groupOf(e: Entry): DocGroup {
  if (e.kind === "调研" || e.kind === "复审" || RESEARCH_TITLE.some((w) => e.title.includes(w))) return "research";
  if (DELIVERED_PATH.test(e.path) || DELIVERED_TITLE.some((w) => e.title.includes(w))) return "delivered";
  if (NOTES_FILE.test(e.name) || NOTES_TITLE.some((w) => e.title.includes(w))) return "notes";
  return e.kind === "设计" ? "design" : "notes";
}

/** docs_view.shelf: the group a file is listed in, or undefined when it is no row of the list. */
function shelfOf(e: Entry, folders: Map<string, Set<string>>): DocGroup | undefined {
  if (e.page !== undefined) {
    const g = groupOf(e);
    return e.page === "impl" && (g === "design" || g === "notes") ? "delivered" : g;
  }
  if (SCRATCH_PATH.test(e.path)) return undefined;
  if (WORK_PATH.test(e.path)) return "notes";
  const g = groupOf(e);
  if (g === "research") return g;
  if (REPORT_NAME.test(e.name) || e.title.trimEnd().endsWith("报告")) return "notes";
  const low = e.name.toLowerCase();
  const side = !SOURCE_NAMES.includes(low) && !PROPOSAL_PAGES.includes(low) && e.path.includes("/design/")
    && PROPOSAL_PAGES.some((n) => folders.get(e.dir)?.has(n));
  if (side) return e.ext === "md" ? undefined : "design";
  return g;
}

function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** docs_view._session_key: a session's id from its resource or id. */
export function sessionKey(s: string): string {
  const t = s.trim().replace(/^[a-z][\w+.-]*:\/*/i, "").split("?")[0].split("#")[0].replace(/\/+$/, "");
  return t.split("/").pop() || "";
}

export function inSession(sessions: readonly string[] | undefined, session: string): boolean {
  const sid = sessionKey(session || "");
  if (!sid || !sessions) return false;
  return sessions.some((k) => k === sid || (sid.length >= 8 && k.startsWith(sid)));
}

/**
 * The rows of the scanned files, as `docs list` would list them before it knows the board: one row per
 * document (a delivery page's README / notes / same-title .md hang under it, a hand-made index.html is the
 * README's prototype), sorted into the tab's groups.
 */
export function quickRows(files: ScannedDoc[], nowMs = Date.now(), titleOf?: (file: ScannedDoc) => string | undefined): DocRow[] {
  const folders = new Map<string, Set<string>>();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!folders.has(dir)) folders.set(dir, new Set());
    folders.get(dir)!.add(path.basename(f.path).toLowerCase());
  }
  const entries: Entry[] = files.map((f) => {
    const html = f.ext !== "md";
    const known = titleOf?.(f);
    // a page's head says whether it is a delivery; a Markdown file's first heading is its title
    const head = html || known === undefined ? readHead(f.path) : "";
    const kind = html && head ? deliveryKind(head) : undefined;
    const isPage = html && /<meta\s+name="generator"\s+content="dispatch deliver"/i.test(head);
    return {
      ...f,
      name: path.basename(f.path),
      dir: path.dirname(f.path),
      title: known ?? docTitle(f.path, head),
      kind: kindOf(f.path),
      page: isPage ? kind ?? "" : undefined,
    };
  });
  const pageIn = new Map<string, Entry>();
  for (const e of entries) if (e.page !== undefined && !pageIn.has(e.dir)) pageIn.set(e.dir, e);
  const readmeIn = new Map<string, Entry>();
  for (const e of entries) if (e.name.toLowerCase() === "readme.md") readmeIn.set(e.dir, e);
  const midnight = localMidnight(nowMs);
  const rows: DocRow[] = [];
  for (const e of entries) {
    const low = e.name.toLowerCase();
    const page = pageIn.get(e.dir);
    // a delivery page's source documents are the page's row
    if (page && page !== e && e.ext === "md" && (SOURCE_NAMES.includes(low) || displayTitle(e.title) === displayTitle(page.title))) continue;
    // a hand-made index.html is its README's prototype
    const readme = readmeIn.get(e.dir);
    if ((low === "index.html" || low === "index.htm") && e.page === undefined && readme && !(page && page !== e)) continue;
    const group = shelfOf(e, folders);
    if (!group) continue;
    const proto = low === "readme.md" && !page
      ? entries.find((x) => x.dir === e.dir && x.page === undefined && /^index\.html?$/i.test(x.name))?.path
      : undefined;
    rows.push({
      id: e.path,
      title: displayTitle(e.title) || e.name,
      group,
      path: e.path,
      mtime: e.mtime,
      ext: e.ext,
      tasks: [],
      delivered_at: 0,
      unseen: false,
      today: e.mtime >= midnight,
      in_session: false,
      ...(proto ? { prototype: proto } : {}),
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/** The last full answer of `docs list` for a project, kept on disk by the bridge. */
export interface DocsCache {
  version: number;
  root: string;
  project: string;
  /** When it was written, ms since the epoch. */
  at: number;
  rows: DocRow[];
}

export function readDocsCache(file: string, root: string): DocsCache | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as DocsCache;
    return c && c.version === CACHE_VERSION && c.root === root && Array.isArray(c.rows) ? c : undefined;
  } catch {
    return undefined;
  }
}

export function writeDocsCache(file: string, root: string, project: string, rows: DocRow[], at = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const cache: DocsCache = { version: CACHE_VERSION, root, project, at, rows };
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

export interface QuickAnswer {
  project: string;
  docs: DocRow[];
  /** The board's part (tasks, sessions, registrations) is not in yet. */
  partial: true;
  /** Rows from the cache, and from the folder scan. */
  cached: number;
  scanned: number;
  ms: number;
}

/**
 * The first frame of the Docs tab: the cached answer, minus files that are gone, plus documents written since
 * it was saved; without a cache, the scan alone. `This session` reads the sessions the cached rows carry.
 */
export function quickAnswer(folder: string, session: string, cacheFile: (root: string) => string, nowMs = Date.now()): QuickAnswer {
  const t0 = Date.now();
  const root = projectRoot(folder);
  const cache = readDocsCache(cacheFile(root), root);
  const files = scanDocFiles(root);
  const midnight = localMidnight(nowMs);
  const byPath = new Map(files.map((f) => [f.path, f]));
  let docs: DocRow[];
  if (!cache) {
    docs = quickRows(files, nowMs);
  } else {
    const known = new Map<string, DocRow>();
    for (const r of cache.rows) {
      known.set(r.path, r);
      if (r.prototype) known.set(r.prototype, r);
    }
    docs = [];
    for (const r of cache.rows) {
      const f = byPath.get(r.path);
      if (!f && !r.reader_only && !fs.existsSync(r.path)) continue;
      const mtime = f ? f.mtime : r.mtime;
      docs.push({ ...r, mtime, today: Math.max(r.delivered_at, mtime) >= midnight, in_session: inSession(r.sessions, session) });
    }
    // written or changed since the cache: a file the board has not seen yet (one it hid stays hidden)
    const fresh = files.filter((f) => !known.has(f.path) && f.mtime * 1000 > cache.at - 2000);
    if (fresh.length) {
      const titles = new Map(cache.rows.map((r) => [r.path, r.title]));
      docs.push(...quickRows(fresh, nowMs, (f) => titles.get(f.path)));
    }
    docs.sort((a, b) => Math.max(b.delivered_at, b.mtime) - Math.max(a.delivered_at, a.mtime));
  }
  return {
    project: cache?.project || path.basename(root),
    docs,
    partial: true,
    cached: cache ? cache.rows.length : 0,
    scanned: files.length,
    ms: Date.now() - t0,
  };
}
