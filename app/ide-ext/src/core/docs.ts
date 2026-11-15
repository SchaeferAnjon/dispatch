// The rows the Docs tab shows, from `dispatch docs list --json` (kanban app/cli/docs_view.py).
// No vscode import (vitest runs it).

export interface DocsAnswer {
  project?: string;
  docs?: unknown[];
  /** Rows the list leaves out (handoffs, reports): only for the reader's "for <task>" line. */
  reader?: unknown[];
  counts?: Record<string, number>;
}

/** The tab's groups, in this order (Delivered, Designs, Reviews, Handoffs, Notes); the picker's Notes holds handoffs too. */
export type DocGroup = "delivered" | "design" | "research" | "handoff" | "notes";
export const DOC_GROUPS: DocGroup[] = ["delivered", "design", "research", "handoff", "notes"];

export interface DocTask {
  id: string;
  title: string;
  status: string;
  /** Seconds since the epoch. */
  delivered_at: number;
}

export interface DocWhereItem {
  n: number;
  /** x, y, w, h in pixels of the picture. */
  box: [number, number, number, number];
  what: string;
  where: string;
  how: string;
  /** Another screenshot of the folder this box is on (a delivery page's 00-where.json). */
  image?: string;
}

/** The "Where to look" picture and its numbered boxes (00-where.json next to the document). */
export interface DocWhere {
  image: string;
  size?: [number, number];
  items: DocWhereItem[];
  /** The boxes are in the picture already: the reader only dims around them (else it rings them). */
  drawn: boolean;
}

export interface DocRow {
  id: string;
  /** The title as the list shows it: no trailing (task-xxxx, 2026-09-27). */
  title: string;
  group: DocGroup;
  path: string;
  /** Seconds since the epoch: the file's time. */
  mtime: number;
  ext: string;
  /** The tasks it was delivered for, newest first. */
  tasks: DocTask[];
  /** When it was last delivered (seconds), 0 when never. */
  delivered_at: number;
  /** A delivery nobody opened yet: the list shows the title in 500. */
  unseen: boolean;
  /** Delivered or changed since local midnight (the CLI's clock): the picker's Today. */
  today: boolean;
  /** Registered by, or delivered for a task of, the session the list was asked for. */
  in_session: boolean;
  /** The sessions it belongs to (their ids): "This session" of a cached list (docsQuick.ts). */
  sessions?: string[];
  /** The HTML page in the same folder (a README.md and its index.html are one row). */
  prototype?: string;
  where?: DocWhere;
  /** Not a list row: a handoff or report the reader may open from elsewhere, kept for its task line. */
  reader_only?: boolean;
}

const GROUP_BY_KIND: Record<string, DocGroup> = { handoff: "handoff", Handoff: "handoff", 交接: "handoff", 交付: "delivered", 截图: "delivered", 设计: "design", 调研: "research", 复审: "research" };

export function docGroup(group: unknown, kind?: unknown): DocGroup {
  if (kind === "handoff" || kind === "Handoff" || kind === "交接") return "handoff";
  if (typeof group === "string" && (DOC_GROUPS as string[]).includes(group)) return group as DocGroup;
  return (typeof kind === "string" && GROUP_BY_KIND[kind]) || "notes";
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function tasksOf(v: unknown): DocTask[] {
  if (!Array.isArray(v)) return [];
  const out: DocTask[] = [];
  for (const t of v) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (!str(r.id)) continue;
    out.push({ id: str(r.id), title: str(r.title) || str(r.id), status: str(r.status), delivered_at: num(r.delivered_at) });
  }
  return out;
}

function whereOf(v: unknown): DocWhere | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const image = str(r.image);
  if (!image.startsWith("/") || !Array.isArray(r.items)) return undefined;
  const items: DocWhereItem[] = [];
  for (const it of r.items) {
    if (!it || typeof it !== "object") continue;
    const x = it as Record<string, unknown>;
    const box = Array.isArray(x.box) && x.box.length === 4 && x.box.every((n) => typeof n === "number") ? (x.box as [number, number, number, number]) : undefined;
    if (!box) continue;
    const item: DocWhereItem = { n: num(x.n) || items.length + 1, box, what: str(x.what), where: str(x.where), how: str(x.how) };
    if (str(x.image).startsWith("/")) item.image = str(x.image);
    items.push(item);
  }
  const size = Array.isArray(r.size) && r.size.length === 2 && r.size.every((n) => typeof n === "number") ? (r.size as [number, number]) : undefined;
  return items.length ? { image, size, items, drawn: r.drawn !== false } : undefined;
}

/** A delivery page's kind from the start of its HTML (`dispatch deliver` writes the meta), or undefined. */
export function deliveryKind(head: string): "impl" | "proposal" | undefined {
  if (!/<meta\s+name="generator"\s+content="dispatch deliver"/i.test(head)) return undefined;
  const m = head.match(/<meta\s+name="dispatch-delivery"\s+content="(impl|proposal)"/i);
  return m ? (m[1].toLowerCase() as "impl" | "proposal") : undefined;
}

/** Local files only (URLs and rows from another Mac cannot open in the side pane), newest first. */
export function docRows(ans: DocsAnswer): DocRow[] {
  const rows: DocRow[] = [];
  const listed = (ans.docs || []).length;
  for (const [i, d] of [...(ans.docs || []), ...(ans.reader || [])].entries()) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const path = str(r.path);
    if (!path.startsWith("/") || r.url || r.host) continue;
    const ext = str(r.ext) || (path.match(/\.([^./]+)$/)?.[1] || "").toLowerCase();
    const title = (str(r.display_title) || str(r.title)).trim();
    const proto = Array.isArray(r.attachments)
      ? (r.attachments as unknown[]).map((a) => (a && typeof a === "object" ? str((a as Record<string, unknown>).path) : "")).find((p) => p.startsWith("/"))
      : undefined;
    rows.push({
      id: String(r.id ?? path),
      title: title || path.split("/").pop() || path,
      group: docGroup(r.group, r.kind),
      path,
      mtime: num(r.mtime),
      ext,
      tasks: tasksOf(r.tasks),
      delivered_at: num(r.delivered_at),
      unseen: r.unseen === true,
      today: r.today === true,
      in_session: r.in_session === true,
      ...(Array.isArray(r.sessions) ? { sessions: (r.sessions as unknown[]).filter((x): x is string => typeof x === "string" && !!x) } : {}),
      prototype: proto,
      where: whereOf(r.where),
      ...(i >= listed ? { reader_only: true } : {}),
    });
  }
  rows.sort((a, b) => Math.max(b.delivered_at, b.mtime) - Math.max(a.delivered_at, a.mtime));
  return rows;
}
