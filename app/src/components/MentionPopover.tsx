import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Api } from "../api";
import type { Issue } from "../types";
import { t, useT } from "../i18n";
import { basename } from "../platform";
import { control } from "./SessionActions";

// `@` in a chat box: the project's tasks (unclaimed and P1 first), recent conversations, the
// folders under the working directory and `@codebase`. Picking one puts a token into the text
// (`@task-ef2g`); when the message goes out each token still in it is expanded: a task into
// `dispatch show <id>`, a conversation into its summary and resume command, a folder into its
// path. `@codebase` searches the project (`dispatch code-search`) with the message and appends the
// hits for the agent, while the bubble shows what was typed (chatd `send.display`).

export type MentionKind = "task" | "session" | "file" | "codebase";
export interface MentionItem { kind: MentionKind; id: string; label: string; sub?: string; token: string; tag?: string }
export interface MentionSession { key: string; title: string; summary?: string; resume?: string }
export interface MentionSources { tasks: Issue[]; sessions: MentionSession[]; files: { name: string; path: string }[]; codebase?: boolean }
export const CODEBASE_TOKEN = "@codebase";
export interface CodeHit { path: string; start: number; end: number; text: string }
/** Characters the appended search results may take (chatd refuses a message over TEXT_LIMIT = 16000). */
export const CODEBASE_BUDGET = 15000;

/** The `@word` right before the caret (at the start or after a space), or null. */
export function mentionQuery(text: string, caret: number = text.length): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { query: m[2], start: caret - m[2].length - 1 } : null;
}

const short = (id: string) => id.replace(/^task-/, "");
/** Tasks first (unclaimed, then P1, then the newest), then conversations, then folders; each list capped. */
export function mentionItems(query: string, src: MentionSources): MentionItem[] {
  const q = query.toLowerCase();
  const hit = (...xs: (string | undefined)[]) => !q || xs.some((x) => (x ?? "").toLowerCase().includes(q));
  const tasks = src.tasks.filter((i) => i.status !== "closed" && hit(i.id, short(i.id), i.title))
    .sort((a, b) => Number(!!a.assignee) - Number(!!b.assignee) || a.priority - b.priority || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 6).map((i): MentionItem => ({ kind: "task", id: i.id, label: i.title, sub: [i.status === "in_progress" ? t("进行中") : "", i.assignee ? "" : t("未认领")].filter(Boolean).join(" · "), token: `@${i.id}`, tag: i.priority <= 1 ? `P${i.priority}` : undefined }));
  const sessions = src.sessions.filter((s) => hit(s.title, s.key)).slice(0, 3).map((s): MentionItem => ({ kind: "session", id: s.key, label: s.title || s.key, sub: s.summary?.slice(0, 60), token: `@${t("会话")}:${(s.key.split(":").pop() || s.key).slice(0, 8)}` }));
  const files = src.files.filter((f) => hit(f.name)).slice(0, 5).map((f): MentionItem => ({ kind: "file", id: f.path, label: `${f.name}/`, token: `@${f.name}/` }));
  const cb: MentionItem = { kind: "codebase", id: "codebase", label: "codebase", sub: t("按意思搜整个项目，把相关代码附在消息后面"), token: CODEBASE_TOKEN };
  if (!src.codebase) return [...tasks, ...sessions, ...files];
  // Typed toward it: first. An empty `@`: last, so ↵ still picks the first task as before.
  if (q && ("codebase".startsWith(q) || t("代码库").toLowerCase().startsWith(q))) return [cb, ...tasks, ...sessions, ...files];
  return q ? [...tasks, ...sessions, ...files] : [...tasks, ...sessions, ...files, cb];
}

const CODEBASE_RE = /(^|\s)@codebase(?=\s|$|[,.;:!?，。；：！？])/;
/** The message with `@codebase` in it as the agent gets it: the token gone, the project searched
 *  with the rest of the message, the hits appended as `[codebase] path:L1-L2` blocks; `display` is
 *  what the bubble shows (what was typed). Without the token: the text unchanged, no display. */
export async function withCodebase(text: string, typed: string, search: (q: string) => Promise<CodeHit[]>): Promise<{ text: string; display?: string }> {
  if (!CODEBASE_RE.test(text)) return { text };
  const body = text.split(/\n/).map((l) => l.replace(new RegExp(CODEBASE_RE.source, "g"), "$1").replace(/[ \t]{2,}/g, " ")).join("\n").trim();
  const hits = await search(body || typed);
  const blocks: string[] = [];
  let room = CODEBASE_BUDGET - body.length;
  for (const h of hits) {
    const b = `[codebase] ${h.path}:${h.start}-${h.end}\n${h.text.replace(/\s+$/, "")}`;
    if (b.length + 2 > room) break;
    blocks.push(b); room -= b.length + 2;
  }
  const head = blocks.length ? t("[codebase] 按这句话在项目里搜到的代码（dispatch code-search），可能相关：") : t("[codebase] 在项目里没搜到相关代码");
  return { text: `${body}\n\n${[head, ...blocks].join("\n\n")}`, display: typed };
}

/** Put the picked token where the `@query` was; returns the new text and caret. */
export function insertMention(text: string, caret: number, item: MentionItem): { text: string; caret: number } {
  const q = mentionQuery(text, caret);
  const start = q ? q.start : caret;
  const before = text.slice(0, start); const after = text.slice(caret);
  const ins = `${item.token} `;
  return { text: before + ins + after.replace(/^ /, ""), caret: before.length + ins.length };
}

/** The message as the agent reads it: tokens still in the text replaced, task and conversation details appended. */
export async function expandMentions(text: string, picked: MentionItem[], deps: { show: (id: string) => Promise<string>; sessions: MentionSession[] }): Promise<string> {
  let out = text;
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const m of picked) {
    if (!out.includes(m.token) || seen.has(m.token)) continue;
    seen.add(m.token);
    if (m.kind === "file") { out = out.split(m.token).join(m.id); continue; }
    if (m.kind === "task") {
      out = out.split(m.token).join(m.id);
      let body = "";
      try { body = (await deps.show(m.id)).trim(); } catch { body = ""; }
      extra.push(`${t("【任务 {id}】", { id: m.id })}\n${body || m.label}`);
      continue;
    }
    const s = deps.sessions.find((x) => x.key === m.id);
    out = out.split(m.token).join(t("会话「{title}」", { title: m.label }));
    extra.push([t("【会话「{title}」】", { title: m.label }), s?.summary ?? "", s?.resume ? t("恢复命令：{cmd}", { cmd: s.resume }) : ""].filter(Boolean).join("\n"));
  }
  return extra.length ? `${out.trim()}\n\n${extra.join("\n\n")}` : out;
}

/** What `dispatch show <id>` tells an agent about a task: title, description, acceptance items. */
export function taskText(i: Issue): string {
  return [`${i.id} ${i.title}`, i.description?.trim() ?? "", i.acceptance_criteria?.trim() ? `${t("验收")}：\n${i.acceptance_criteria.trim()}` : ""].filter(Boolean).join("\n\n");
}

const SECTION: Record<MentionKind, string> = { task: "任务", session: "最近的会话", file: "文件夹", codebase: "代码库" };
export function MentionPopover({ items, cursor, onPick, onHover, project, dir, below }: { items: MentionItem[]; cursor: number; onPick: (i: MentionItem) => void; onHover?: (n: number) => void; project?: string; dir?: string; below?: boolean }) {
  const t = useT();
  if (!items.length) return <div className={`pop${below ? " below" : ""}`} role="listbox" aria-label={t("提到任务、会话或文件夹")}><div className="pf">{t("没有匹配的任务、会话或文件夹")}</div></div>;
  return (
    <div className={`pop${below ? " below" : ""}`} role="listbox" aria-label={t("提到任务、会话或文件夹")}>
      {items.map((it, i) => {
        const head = i === 0 || items[i - 1].kind !== it.kind;
        const title = it.kind === "task" && project ? `${t(SECTION.task)} · ${project}` : it.kind === "file" && dir ? `${t(SECTION.file)} · ${basename(dir) || dir}` : t(SECTION[it.kind]);
        return <div key={`${it.kind}:${it.id}`}>
          {head && <div className="sec">{title}{i === 0 && <span className="r">{t("↑↓ 选 · ↵ 插入")}</span>}</div>}
          <div role="option" aria-selected={i === cursor} className={`row${i === cursor ? " sel" : ""}`} onMouseDown={(e) => { e.preventDefault(); onPick(it); }} onMouseEnter={() => onHover?.(i)}>
            <span className="ic">{it.kind === "task" ? "#" : it.kind === "session" ? "›" : it.kind === "codebase" ? "⌕" : "▱"}</span>
            <span className="t">{it.kind === "task" && <span className="mono id">{short(it.id)} </span>}{it.kind === "codebase" ? <span className="mono">@codebase</span> : it.label}{it.sub ? <span className="s"> {it.sub}</span> : null}</span>
            <span className="acc">{it.tag && <span className="tag orange">{it.tag}</span>}</span>
          </div>
        </div>;
      })}
      <div className="pf"><span>{t("@ 任务、会话、文件夹")}</span><span>{t("/ 命令")}</span><span>{t("{mod}V 贴图")}</span></div>
    </div>
  );
}

/** Everything a chat box needs for `@`: the query under the caret, the list, keys, the picked tokens and the expansion. */
export function useMentions({ api, host, cwd, draft, setDraft, textarea, tasks, sessions, codebase = false }: { api: Api | null; host: string; cwd?: string; draft: string; setDraft: (s: string) => void; textarea: RefObject<HTMLTextAreaElement | null>; tasks: Issue[]; sessions: MentionSession[]; codebase?: boolean }) {
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [closed, setClosed] = useState("");
  const [picked, setPicked] = useState<MentionItem[]>([]);
  const [files, setFiles] = useState<{ name: string; path: string }[] | null>(null);
  const q = mentionQuery(draft, Math.min(caret || draft.length, draft.length));
  const open = !!q && closed !== draft;
  const filesFor = useRef("");
  useEffect(() => {
    if (!open || !api || !cwd || filesFor.current === `${host}:${cwd}`) return;
    filesFor.current = `${host}:${cwd}`;
    control<{ children: { name: string; path: string }[] }>(api, host, "browse", { path: cwd }).then((r) => setFiles(r.children ?? [])).catch(() => setFiles([]));
  }, [open, api, host, cwd]);
  const withCb = codebase && !!api && !!cwd;
  const items = useMemo(() => (open ? mentionItems(q!.query, { tasks, sessions, files: files ?? [], codebase: withCb }) : []), [open, q?.query, tasks, sessions, files, withCb]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCursor(0); }, [q?.query]);
  const pick = (it: MentionItem) => {
    const r = insertMention(draft, Math.min(caret || draft.length, draft.length), it);
    setDraft(r.text); setPicked((p) => [...p.filter((x) => x.token !== it.token), it]);
    requestAnimationFrame(() => { const el = textarea.current; if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret); setCaret(r.caret); } });
  };
  /** true when the key was the popover's. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !items.length) { if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setClosed(draft); return true; } return false; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((i) => (i + 1) % items.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((i) => (i - 1 + items.length) % items.length); return true; }
    if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); pick(items[Math.min(cursor, items.length - 1)]); return true; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setClosed(draft); return true; }
    return false;
  };
  const track = () => { const el = textarea.current; if (el) setCaret(el.selectionStart ?? el.value.length); };
  const expand = (text: string) => expandMentions(text, picked, { show: async (id) => { const i = api ? await api.show(id) : null; return i ? taskText(i) : ""; }, sessions });
  const reset = () => { setPicked([]); setClosed(""); };
  /** `@codebase` in the (expanded) text: search the project and append the hits; `typed` is what the bubble shows. */
  const codebaseOf = (text: string, typed: string) => (withCb ? withCodebase(text, typed, (query) => searchCode(api!, host, cwd!, query)) : Promise.resolve({ text } as { text: string; display?: string }));
  return { open, items, cursor, setCursor, pick, onKeyDown, track, expand, reset, picked, codebase: codebaseOf };
}

/** `dispatch code-search` over the chat's folder: the top 10 hits (keyword search without OPENAI_API_KEY). */
export async function searchCode(api: Pick<Api, "on">, host: string, root: string, query: string): Promise<CodeHit[]> {
  let raw: string;
  // a refusal (home folder, not a folder) exits 1: the desktop bridge then only has stderr
  try { raw = await api.on(host, ["code-search", "--root", root, "-n", "10", "--json", "--", query]); }
  catch (e) { throw new Error(t("代码搜索没成：{err}", { err: (e instanceof Error ? e.message : String(e)) || t("没说原因") })); }
  const i = raw.indexOf("{");
  const r = JSON.parse(i >= 0 ? raw.slice(i) : "{}") as { ok?: boolean; message?: string; error?: string; results?: CodeHit[] };
  if (!r.ok) throw new Error(t("代码搜索没成：{err}", { err: r.message || r.error || raw.trim().slice(0, 200) }));
  return r.results ?? [];
}
