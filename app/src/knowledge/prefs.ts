// The Knowledge page's preferences (Dispatch IDE, Agents window, Customizations → Knowledge, direction B
// of design/knowledge/redesign): what `dispatch prefs list|show --json` gives, and the pure helpers the page
// draws with: the home box's top five and its New line, the list's groups (New first, then the four areas),
// the grey line under each row saying where it came from, dates, and About me's soonest entries.
// No DOM here, so vitest runs it.

import { type Profile, sectionName } from "./model";

export type Polarity = "like" | "avoid";
export type PrefArea = "design" | "workflow" | "writing" | "tools";

export interface PrefSource { kind: string; path: string; line?: number; label: string; at?: string }
export interface PrefQuote { text: string; at?: string; session?: string; engine?: string; source?: string }
export interface PrefEvent { at: string; event: string; detail?: string; by?: string; id?: string; was?: string; project?: string; session?: string }
export interface PrefSaid { at?: string; engine?: string; session?: string; project?: string; cwd?: string }

export interface Pref {
  id: string;
  name: string;
  text: string;
  polarity: Polarity;
  area: PrefArea;
  scope: string;
  scope_label?: string;
  quote?: string;
  /** when the first words were said, if not with the entry (an imported note that got them later) */
  quote_said?: { at?: string; engine?: string; session?: string };
  quotes?: PrefQuote[];
  part?: string;
  part_path?: string;
  part_title?: string;
  evidence?: string[];
  replaces?: string[];
  replaced_by?: string;
  status?: "active" | "replaced" | "forgotten";
  created?: string;
  updated?: string;
  said?: PrefSaid;
  seen?: boolean;
  used?: number;
  last_used?: string | null;
  kept_at?: string;
  stale?: boolean;
  sources?: PrefSource[];
  also_in?: string[];
  history?: PrefEvent[];
  imported?: boolean;
  /** data: URI of the chip (list) or card (detail) thumbnail */
  thumb?: string;
  /** the evidence images copied into the entry's folder (detail) */
  images?: { path: string; uri: string }[];
  /** the ones it replaced and the one that replaced it (detail) */
  related?: { id: string; name: string; text: string; status: string; said_at?: string }[];
}

export interface PrefArea_ { id: PrefArea; label: string; description: string }

export interface PrefList {
  items: Pref[];
  counts?: { active: number; new: number; stale: number; areas: Record<string, number> };
  areas?: PrefArea_[];
  store?: string;
}

export const PREF_AREAS: PrefArea_[] = [
  { id: "design", label: "Design", description: "How interfaces look, and how design work is shown to you." },
  { id: "workflow", label: "Workflow", description: "How agents plan, hand off, check and report." },
  { id: "writing", label: "Writing", description: "How text for you and for other people reads." },
  { id: "tools", label: "Tools", description: "Which models, services and tools to use." },
];
export const areaLabel = (a: string) => PREF_AREAS.find((x) => x.id === a)?.label ?? a;
export const NEW_DESCRIPTION = "Remembered since you last opened Knowledge. They move to their group once you have seen them.";

export const isActive = (p: Pref) => (p.status ?? "active") === "active";

const ENGINES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", zcode: "ZCode", person: "you", import: "import", opencode: "OpenCode" };
export const engineName = (e?: string) => (e ? ENGINES[e] ?? e : "");

/** When it was said: the words' time, else when it was written down (an imported note without a date: unknown). */
export const saidAt = (p: Pref) => p.said?.at || (p.imported ? "" : p.created || "");

// ---- dates ----------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parse(iso: string): Date | null {
  if (!iso) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00") : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayDiff = (a: Date, b: Date) => Math.round((new Date(ymd(a) + "T12:00:00").getTime() - new Date(ymd(b) + "T12:00:00").getTime()) / 86400000);

/** Short, for the right end of a row: today, yesterday, 09-26 this year, 2025-09-26 before. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const diff = dayDiff(now, d);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  return d.getFullYear() === now.getFullYear() ? ymd(d).slice(5) : ymd(d);
}

/** With the time when it has one: "today 20:09", "09-26 23:58". A bare date stays a date. */
export function momentLabel(iso: string, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  const day = dayLabel(iso, now);
  return /T\d/.test(iso) ? `${day} ${hm(d)}` : day;
}

// ---- the home box -------------------------------------------------------------------------------

/** The five agents follow most: used, then recently used, then the newest said; the new ones come last
 *  (the line under the five lists them). */
export function topPrefs(prefs: Pref[], newIds: Set<string>, n = 5): Pref[] {
  const act = prefs.filter(isActive);
  const score = (p: Pref) => [p.used ?? 0, p.last_used ?? "", saidAt(p)] as const;
  const by = (a: Pref, b: Pref) => {
    const [ua, la, sa] = score(a);
    const [ub, lb, sb] = score(b);
    return ub - ua || lb.localeCompare(la) || sb.localeCompare(sa);
  };
  // the followed ones by how often; the never followed take the four areas in turns, so the box is not
  // five Design lines when nothing has been used yet
  const turns = (list: Pref[]) => {
    const used = list.filter((p) => (p.used ?? 0) > 0);
    const queues = [...PREF_AREAS.map((a) => list.filter((p) => !(p.used ?? 0) && p.area === a.id)),
      list.filter((p) => !(p.used ?? 0) && !PREF_AREAS.some((a) => a.id === p.area))];
    const out = [...used];
    while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
    return out;
  };
  const old = turns(act.filter((p) => !newIds.has(p.id)).sort(by));
  const fresh = turns(act.filter((p) => newIds.has(p.id)).sort(by));
  return [...old, ...fresh].slice(0, n);
}

/** Newest first. */
export function newest(prefs: Pref[]): Pref[] {
  return [...prefs].sort((a, b) => (b.updated || saidAt(b)).localeCompare(a.updated || saidAt(a)));
}

// ---- the list -----------------------------------------------------------------------------------

export interface PrefGroup { id: string; label: string; description: string; items: Pref[] }

/** Rows whose text has every word of the query. */
export function filterPrefs(prefs: Pref[], query: string): Pref[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return prefs;
  return prefs.filter((p) => {
    const hay = [p.name, p.text, p.quote, ...(p.quotes ?? []).map((q) => q.text), p.scope_label ?? p.scope, p.part, areaLabel(p.area), p.polarity,
      ...(p.sources ?? []).map((s) => s.label)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** New first (the ones not seen before this visit), then each area with anything in it, newest first. */
export function prefGroups(prefs: Pref[], newIds: Set<string>): PrefGroup[] {
  const act = newest(prefs.filter(isActive));
  const groups: PrefGroup[] = [{ id: "new", label: "New", description: NEW_DESCRIPTION, items: act.filter((p) => newIds.has(p.id)) }];
  for (const a of PREF_AREAS) groups.push({ id: a.id, label: a.label, description: a.description, items: act.filter((p) => p.area === a.id && !newIds.has(p.id)) });
  return groups.filter((g) => g.items.length);
}

function deliveryName(p: Pref): string {
  if (p.part_title) return p.part_title;
  const file = (p.part || "").split("#")[0];
  if (!file) return "";
  if (/^https?:\/\//i.test(file)) {
    try {
      return new URL(file).hostname;
    } catch {
      return file;
    }
  }
  const parts = file.split("/").filter(Boolean);
  // design/<feature>/redesign/index.html reads as the feature
  const i = parts.indexOf("design");
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

export const regionOf = (p: Pref) => (p.part || "").split("#")[1] || "";

/** The grey line under a row: what it hangs on, or where it came from, and the person's words. */
export function whereFrom(p: Pref, now = new Date()): string {
  const bits: string[] = [];
  if (p.imported && p.sources?.length) {
    const s = p.sources[0];
    bits.push(`From ${s.label}${s.at ? ` · ${dayLabel(s.at, now)}` : ""}`);
    if (p.sources.length > 1) bits.push(`+${p.sources.length - 1} more`);
  } else if (p.part) {
    const what = deliveryName(p);
    const region = regionOf(p);
    bits.push(`Your feedback on ${what}${region ? ` · ${region}` : ""}`);
  } else if (p.quote) {
    bits.push("You said");
  }
  if (p.quote) bits.push(`「${p.quote}」`);
  if (p.also_in?.length) bits.push(`also in ${p.also_in.join(", ")}`);
  return bits.join(" · ");
}

/** The right end of a row: where it applies and when it was said. */
export function scopeAndDay(p: Pref, now = new Date()): string {
  return [p.scope_label || scopeLabel(p.scope), dayLabel(saidAt(p), now)].filter(Boolean).join(" · ");
}

export function scopeLabel(scope: string): string {
  if (!scope || scope === "everywhere") return "Everywhere";
  const [p, s] = scope.split(/:(.*)/s);
  return s ? `${p} · ${s}` : p;
}

/** "Everywhere", "kanban", "kanban · Tasks tab" as a sentence for the detail's Applies to. */
export function appliesTo(p: Pref): string {
  const [proj, surface] = (p.scope || "everywhere").split(/:(.*)/s);
  if (!p.scope || p.scope === "everywhere") return "Everywhere";
  return surface ? `${proj}: ${surface}` : `The ${proj} project`;
}

export function rememberedLine(p: Pref, now = new Date()): string {
  if (p.imported) {
    const s = p.sources?.[0];
    return s ? `Imported from ${s.label}${s.at ? `, written ${dayLabel(s.at, now)}` : ""}` : "Imported";
  }
  const who = engineName(p.said?.engine);
  const where = p.said?.project ? ` in ${p.said.project}` : "";
  return `${momentLabel(saidAt(p), now)}${who ? ` by ${who}` : ""}${where}`;
}

export function usedLine(p: Pref, now = new Date()): string {
  const n = p.used ?? 0;
  if (!n) return "Not yet";
  const times = n === 1 ? "Once" : `${n} times`;
  return p.last_used ? `${times}, last ${dayLabel(p.last_used, now)}` : times;
}

/** One line of History in words. */
export function eventLine(e: PrefEvent): string {
  const by = engineName(e.by);
  switch (e.event) {
    case "remembered":
      return `Remembered${by ? ` by ${by}` : ""}${e.project ? ` in ${e.project}` : ""}`;
    case "imported":
      return `Imported${e.detail ? ` from ${e.detail}` : ""}`;
    case "said-again":
      return `Said again${e.detail ? `: 「${e.detail}」` : ""}`;
    case "unsaid":
      return "Undo right after it was said again: kept as it was";
    case "also-found":
      return `Also found in ${e.detail || "another place"}`;
    case "edited":
      return `Edited${e.detail ? ` (${e.detail})` : ""}`;
    case "used":
      return by === "reply" || e.by === "reply" ? "Followed in a reply" : `Used${by ? ` by ${by}` : ""}${e.detail ? ` for ${e.detail}` : ""}`;
    case "replaced":
      return `Replaced ${e.detail || ""}`.trim();
    case "replaces":
      return `Replaced ${e.detail || "an older one"}. Kept here, not given to agents.`;
    case "restored":
      return "Back in use";
    case "still-true":
      return "You said it is still true";
    default:
      return e.event;
  }
}

// ---- evidence -----------------------------------------------------------------------------------

export interface EvidenceCard {
  key: string;
  kind: "page" | "image" | "link";
  title: string;
  part: string;
  file: string;
  dir: string;
  /** what the window opens: a file path, a file path with #region, or a URL */
  target: string;
  thumb?: string;
}

function splitPath(p: string): { file: string; dir: string } {
  const clean = p.replace(/^~?\/Users\/[^/]+\//, "~/");
  const i = clean.lastIndexOf("/");
  return i < 0 ? { file: clean, dir: "" } : { file: clean.slice(i + 1), dir: clean.slice(0, i) };
}

/** The cards under Evidence: the delivery part it hangs on, the images copied with it, the pages and
 *  links given as evidence. The first card carries the thumbnail. */
export function evidenceCards(p: Pref): EvidenceCard[] {
  const out: EvidenceCard[] = [];
  const region = regionOf(p);
  const partFile = (p.part || "").split("#")[0];
  if (p.part_path || /^https?:\/\//i.test(partFile)) {
    const target = p.part_path || partFile;
    const { file, dir } = splitPath(p.part_path || partFile);
    out.push({ key: "part", kind: /\.(png|jpe?g|gif|webp)$/i.test(target) ? "image" : /^https?:/i.test(target) ? "link" : "page",
      title: p.part_title || deliveryName(p), part: region || "Whole delivery", file, dir, target: target + (region && !/^https?:/i.test(target) ? `#${region}` : "") });
  }
  for (const img of p.images ?? []) {
    const { file, dir } = splitPath(img.path);
    out.push({ key: img.path, kind: "image", title: "Your screenshot", part: p.name, file, dir, target: img.path, thumb: img.uri });
  }
  const copied = new Set((p.images ?? []).map((img) => splitPath(img.path).file));
  for (const ev of p.evidence ?? []) {
    if (/\.(png|jpe?g|gif|webp|heic)$/i.test(ev) && copied.has(splitPath(ev).file)) continue; // shown by its copy
    if (ev === p.part_path || ev === partFile) continue;
    const link = /^https?:\/\//i.test(ev);
    const { file, dir } = splitPath(ev);
    out.push({ key: ev, kind: link ? "link" : /\.(png|jpe?g|gif|webp)$/i.test(ev) ? "image" : "page",
      title: link ? deliveryName({ ...p, part: ev, part_title: "" }) : file, part: link ? ev : "", file, dir, target: ev });
  }
  if (out.length && p.thumb && !out[0].thumb) out[0] = { ...out[0], thumb: p.thumb };
  return out;
}

// ---- Profile, the soonest ------------------------------------------------------------------------

export interface Soon { when: string; text: string; date: string; line?: number }

/** `2026-09-28|外管局预约|延签 · 周一 11:00，…` → date, label and the rest. */
export function upcomingParts(raw: string): { date: string; label: string; rest: string } | null {
  const m = /^(\d{4}-\d{2}(?:-\d{2})?)(?:\|([^|·]*))?(?:\|([^|·]*))?\s*·\s*([\s\S]*)$/.exec(raw.trim());
  if (!m) return null;
  const rest = m[4].replace(/[（(][^（）()]*\d{4}-\d{2}-\d{2}[^（）()]*[)）]\s*$/, "").trim();
  return { date: m[1], label: (m[2] || "").trim(), rest };
}

function soonWhen(date: string, text: string, now: Date): string {
  const d = parse(date);
  if (!d) return date;
  const time = /(\d{1,2}:\d{2})/.exec(text)?.[1] ?? "";
  const diff = dayDiff(d, now);
  if (diff === 0) return time ? `Today ${time}` : "Today";
  if (diff > 0 && diff < 7) return `${DAYS[d.getDay()]}${time ? ` ${time}` : ""}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** What is coming up (dated, not past), soonest first; then the latest dated notes about the person. */
export function aboutSoon(profile: Profile | null, now = new Date(), n = 4): Soon[] {
  if (!profile) return [];
  const out: Soon[] = [];
  const today = ymd(now);
  // PROFILE.md's headings are Chinese in older files, English after the profile migration
  const future = profile.sections.find((s) => sectionName(s.heading) === "Upcoming");
  for (const it of future?.items ?? []) {
    const p = upcomingParts(it.text);
    if (!p || p.date.length < 10 || p.date < today) continue;
    const text = p.label || p.rest.split(/[。；;，,]/)[0];
    out.push({ when: soonWhen(p.date, p.rest, now), text, date: p.date, line: it.line });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  if (out.length < n) {
    const notes: Soon[] = [];
    for (const s of profile.sections) {
      if (["Upcoming", "Past events"].includes(sectionName(s.heading))) continue;
      for (const it of s.items) {
        const m = /[（(](\d{4}-\d{2}-\d{2})[^（）()]*[)）]\s*$/.exec(it.text) || /^(\d{4}-\d{2}-\d{2})/.exec(it.text);
        if (!m) continue;
        const body = it.text.replace(/[（(][^（）()]*[)）]\s*$/, "").replace(/^\d{4}-\d{2}-\d{2}\s*[·|]\s*/, "").trim();
        const text = body.split(/[。；;：:]/)[0].slice(0, 40);
        const d = parse(m[1]);
        notes.push({ when: d ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : m[1], text, date: m[1], line: it.line });
      }
    }
    notes.sort((a, b) => b.date.localeCompare(a.date));
    out.push(...notes.slice(0, n - out.length));
  }
  return out.slice(0, n);
}

/** Every entry in Profile (the See all count). */
export const aboutCount = (profile: Profile | null) => (profile ? profile.sections.reduce((n, s) => n + s.items.length, 0) : 0);
