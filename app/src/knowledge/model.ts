// The Knowledge page's data (Dispatch IDE, Agents window, Customizations → Knowledge): the wiki from
// `dispatch wiki list --dated --json`, FACTS.md from `dispatch facts list --json` and PROFILE.md from
// `dispatch profile show --json`, all through dispatch-bridge (ide-ext/src/knowledge.ts). Every entry
// of the three becomes the same Row (title, one-line summary, source and date) so the page shows one
// kind of list. Pure helpers, so vitest runs them without a webview.

export type WikiKind = "pit" | "win" | "retro" | "howto";

export interface WikiItem {
  key: string;
  kind: WikiKind | null;
  text: string;
  /** labelled fields as the CLI parses them: {"【解法】": "…"} */
  fields: Record<string, string>;
  project: string;
  task: string;
  raw: string;
  /** when it was first written (Dolt history), ISO */
  created?: string;
}

/** A Markdown entry of FACTS.md / PROFILE.md with where it starts (1-based line). */
export interface MdItem {
  line: number;
  end: number;
  text: string;
}

export interface FactTopic {
  section: string;
  topic: string;
  note: string;
  body: string;
  path: string;
  line: number;
  items: MdItem[];
}

export interface ProfileSection {
  heading: string;
  body: string;
  line: number;
  items: MdItem[];
}

export interface Profile {
  path: string;
  sections: ProfileSection[];
}

export interface KindInfo {
  kind: WikiKind;
  label: string;
  one: string;
  fields: { name: string; label: string; cli: string }[];
}

/** The wiki's groups in page order, their English names and the CLI's field labels. */
export const KINDS: KindInfo[] = [
  { kind: "win", label: "Wins", one: "Win", fields: [{ name: "why", label: "Why it worked", cli: "【为什么】" }] },
  { kind: "pit", label: "Pitfalls", one: "Pitfall", fields: [{ name: "fix", label: "Fix", cli: "【解法】" }] },
  {
    kind: "retro",
    label: "Retros",
    one: "Retro",
    fields: [
      { name: "tech", label: "Tech", cli: "【技术】" },
      { name: "good", label: "Went well", cli: "【做对】" },
      { name: "bad", label: "Went wrong", cli: "【做错】" },
    ],
  },
  { kind: "howto", label: "How-tos", one: "How-to", fields: [] },
];

export const kindInfo = (k: WikiKind): KindInfo => KINDS.find((x) => x.kind === k)!;

/** The entry's fields by name ({fix: "…"}), for the edit form. */
export function fieldValues(it: WikiItem): Record<string, string> {
  const out: Record<string, string> = {};
  if (!it.kind) return out;
  for (const f of kindInfo(it.kind).fields) out[f.name] = it.fields[f.cli] ?? "";
  return out;
}

/** Only the fields that changed, for `wikiEdit` (undefined: nothing changed). */
export function changedFields(it: WikiItem, fields: Record<string, string>): Record<string, string> | undefined {
  const before = fieldValues(it);
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(fields)) if ((before[name] ?? "").trim() !== v.trim()) out[name] = v;
  return Object.keys(out).length ? out : undefined;
}

// ---- one kind of row ------------------------------------------------------------------------------

export type Area = "wiki" | "facts" | "me";

export interface Row {
  id: string;
  area: Area;
  /** the group in the left column and above the rows */
  group: string;
  /** which line icon */
  icon: string;
  title: string;
  summary: string;
  /** right side: project, topic or agent */
  source: string;
  /** YYYY-MM-DD or YYYY-MM, "" when unknown */
  date: string;
  /** the whole entry as Markdown, for the detail */
  body: string;
  wiki?: WikiItem;
  /** Facts / About me: the file and the entry's first line */
  path?: string;
  line?: number;
  /** the entry as the CLI gave it, for Delete's check */
  raw?: string;
}

const SUMMARY_CHARS = 80;
const TITLE_CHARS = 48;

/** Text for a row: no Markdown links or bare URLs, no backticks or bold, no task-xxxx bookkeeping. */
export function plain(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[\w\-.~:/?#@!$&'*+,;=%]+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\s*[·,，;；]?\s*\btask-[a-z0-9]{3,6}\b/gi, "")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/** Where the title ends: the first colon, full stop or semicolon outside brackets (not a time's
 *  16:30), when it comes within the first TITLE_CHARS; -1 otherwise. */
function titleEnd(t: string): number {
  let depth = 0;
  for (let i = 0; i < Math.min(t.length, TITLE_CHARS + 1); i++) {
    const c = t[i];
    if ("（(「【[".includes(c)) depth++;
    else if ("）)」】]".includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && i >= 2 && ("：。；;".includes(c) || (c === ":" && !/\d/.test(t[i - 1] || "") && !/[\d/]/.test(t[i + 1] || "")))) return i;
  }
  return -1;
}

/** Title and one-line summary of a text: the title ends at the first colon or full stop when that
 *  comes early enough, else at a comma or space near TITLE_CHARS; the rest (or `more`) is the summary. */
export function titleAndSummary(text: string, more = ""): { title: string; summary: string } {
  let t = plain(text.split("\n").filter((l) => l.trim()).join(" "));
  let extra = plain(more);
  if (!t) [t, extra] = [extra, ""];
  const end = titleEnd(t);
  let title = t;
  let rest = "";
  if (end >= 0) {
    title = t.slice(0, end);
    rest = t.slice(end + 1).trim();
  } else if (t.length > TITLE_CHARS) {
    const cut = Math.max(t.lastIndexOf("，", TITLE_CHARS), t.lastIndexOf(", ", TITLE_CHARS), t.lastIndexOf(" ", TITLE_CHARS));
    title = t.slice(0, cut > 12 ? cut : TITLE_CHARS);
    rest = t.slice(title.length).replace(/^[，,\s]+/, "");
  }
  return { title: clip(title.trim(), TITLE_CHARS + 12), summary: clip(rest || extra, SUMMARY_CHARS) };
}

/** An About me entry's own bookkeeping: a leading date ("2026-09 · …", "2026-09-15|…|…") and a
 *  trailing "（2026-09-12 · claude-code）". */
export function attribution(text: string): { text: string; date: string; agent: string } {
  let t = text.trim();
  let date = "";
  let agent = "";
  const tail = /[（(]\s*(\d{4}-\d{2}(?:-\d{2})?)?\s*(?:·\s*)?([\w .-]*?)\s*(?:·\s*task-[a-z0-9]+\s*)?[)）]\s*$/i.exec(t);
  if (tail && (tail[1] || /^[a-z][\w.-]*$/i.test(tail[2] || ""))) {
    date = tail[1] || "";
    agent = (tail[2] || "").trim();
    t = t.slice(0, tail.index).trim();
  }
  // "2026-09 · …", "2026-09-15|Harbor 迁移|等会话完成 · …", "待办 · …", several in a row
  for (let n = 0; n < 3; n++) {
    const head = /^(?:(\d{4}-\d{2}(?:-\d{2})?)(?:\|[^|·]*)*|待办|[^|·\s]{1,6}\|[^|·]{1,10})\s*(?:·|\|)\s*/.exec(t);
    if (!head) break;
    date = date || head[1] || "";
    t = t.slice(head[0].length).trim();
  }
  return { text: t, date, agent };
}

const dayOf = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "");

export function wikiRows(items: WikiItem[]): Row[] {
  return items
    .filter((it) => it.kind)
    .map((it) => {
      const info = kindInfo(it.kind!);
      const firstField = info.fields.map((f) => it.fields[f.cli]).find((v) => v) || "";
      const { title, summary } = titleAndSummary(it.text, firstField);
      return {
        id: `wiki:${it.key}`, area: "wiki" as const, group: info.label, icon: it.kind!, title, summary,
        source: it.project, date: dayOf(it.created), body: it.text, wiki: it,
      };
    });
}

export function factRows(topics: FactTopic[]): Row[] {
  const out: Row[] = [];
  for (const t of topics) {
    const topicDate = /(\d{4}-\d{2}(?:-\d{2})?)/.exec(t.topic + " " + t.note)?.[1] || "";
    const topicName = plain(t.topic.replace(/[（(][^）)]*[)）]\s*$/, ""));
    for (const it of t.items) {
      const a = attribution(it.text);
      const { title, summary } = titleAndSummary(a.text);
      out.push({
        id: `facts:${it.line}`, area: "facts", group: topicName, icon: "fact", title, summary, source: topicName,
        date: a.date || topicDate, body: it.text, path: t.path, line: it.line, raw: it.text,
      });
    }
  }
  return out;
}

/** The About me groups: short names for PROFILE.md's sections. */
export function sectionName(heading: string): string {
  if (/^(Who I am|我是谁)/i.test(heading)) return "Who I am";
  if (/^(Devices and services|设备)/i.test(heading)) return "Devices and services";
  if (/^(Upcoming|将来)/i.test(heading)) return "Upcoming";
  if (/^(Past events|已发生)/i.test(heading)) return "Past events";
  return heading.replace(/[（(].*$/, "").trim();
}

const SECTION_ICONS: Record<string, string> = { "Who I am": "person", "Devices and services": "device", Upcoming: "calendar", "Past events": "history" };

export function profileRows(p: Profile): Row[] {
  const out: Row[] = [];
  for (const s of p.sections) {
    const group = sectionName(s.heading);
    for (const it of s.items) {
      const a = attribution(it.text);
      const { title, summary } = titleAndSummary(a.text);
      out.push({
        id: `me:${it.line}`, area: "me", group, icon: SECTION_ICONS[group] || "person", title, summary, source: a.agent,
        date: a.date, body: it.text, path: p.path, line: it.line, raw: it.text,
      });
    }
  }
  return out;
}

/** The groups of a list in page order (as they first appear, the wiki's in KINDS order) with counts. */
export function groupsOf(rows: Row[], area: Area): { name: string; count: number }[] {
  const names = area === "wiki" ? KINDS.map((k) => k.label) : [...new Set(rows.map((r) => r.group))];
  return names.map((name) => ({ name, count: rows.filter((r) => r.group === name).length })).filter((g) => area === "wiki" || g.count);
}

/** Newest first; undated keep their file order at the end. */
export function newestFirst(rows: Row[]): Row[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.date && b.r.date ? b.r.date.localeCompare(a.r.date) : a.r.date ? -1 : b.r.date ? 1 : a.i - b.i))
    .map((x) => x.r);
}

/** Rows whose text has every word of the query (Facts and About me search here; the wiki asks the CLI). */
export function filterRows(rows: Row[], query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.title} ${r.summary} ${r.body} ${r.source} ${r.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "09-26" in rows of this year, the whole date otherwise. */
export function shortDate(date: string, now = new Date()): string {
  if (!date) return "";
  return date.startsWith(String(now.getFullYear())) && date.length >= 10 ? date.slice(5) : date;
}
