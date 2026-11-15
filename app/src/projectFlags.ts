import type { Memory } from "./types";
import { homeOf, toSlash } from "./platform";

// Two switches per project — 收藏 (starred, pinned to the top) and 归档 (archived,
// hidden until asked for) — kept in one shared bd memory so both Macs agree.
// Same key and shape as `dispatch project` in the CLI.
export const PROJECT_FLAGS_KEY = "dispatch-projects";
export const INTERNAL_MEMORY_PREFIX = "dispatch-";
// `dir`: the home folder chosen when the project was created in the app; the project exists before
// any session or task does, and conversations inside that folder belong to it.
// Legacy command metadata is preserved when unrelated project flags are saved.
export type ProjectFlag = { starred?: true; archived?: true; alias?: string; dir?: string; test_cmd?: string; installed_probe?: string; test_cmd_suggested?: string; test_cmd_dismissed?: string };
export type ProjectFlagChange = { starred?: boolean; archived?: boolean; alias?: string; dir?: string; test_cmd?: string; installed_probe?: string; test_cmd_dismissed?: string };
const CMD_FIELDS = ["test_cmd", "installed_probe", "test_cmd_suggested", "test_cmd_dismissed"] as const;
export type ProjectFlags = Record<string, ProjectFlag>;

export function parseProjectFlags(memories: Memory[]): ProjectFlags {
  const raw = memories.find((m) => m.key === PROJECT_FLAGS_KEY)?.value;
  if (!raw) return {};
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const out: ProjectFlags = {};
  for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const f: ProjectFlag = {};
    if ((v as ProjectFlag).starred === true) f.starred = true;
    if ((v as ProjectFlag).archived === true) f.archived = true;
    const alias = (v as ProjectFlag).alias;
    if (typeof alias === "string" && alias.trim() && alias.trim() !== name) f.alias = alias.trim().slice(0, 80);
    const dir = (v as ProjectFlag).dir;
    if (typeof dir === "string" && dir.trim().startsWith("/")) f.dir = dir.trim().replace(/\/+$/, "").slice(0, 400);
    for (const k of CMD_FIELDS) { const c = (v as ProjectFlag)[k]; if (typeof c === "string" && c.trim()) f[k] = c.trim().slice(0, 400); }
    if (f.starred || f.archived || f.alias || f.dir || CMD_FIELDS.some((k) => f[k])) out[name] = f;
  }
  return out;
}

export function withProjectFlag(flags: ProjectFlags, name: string, change: ProjectFlagChange): ProjectFlags {
  const cur = { ...(flags[name] ?? {}), ...change };
  const next: ProjectFlag = {};
  if (cur.starred) next.starred = true;
  if (cur.archived) next.archived = true;
  // 显示名: what the person calls the project; the raw name stays on labels and directories.
  const alias = (cur.alias ?? "").trim();
  if (alias && alias !== name) next.alias = alias.slice(0, 80);
  const dir = (cur.dir ?? "").trim().replace(/\/+$/, "");
  if (dir.startsWith("/")) next.dir = dir.slice(0, 400);
  for (const k of CMD_FIELDS) { const c = (cur[k] ?? "").trim(); if (c) next[k] = c.slice(0, 400); }
  // The person set the test command (or cleared it): the pending suggestion is decided, same as the CLI.
  if (change.test_cmd !== undefined && next.test_cmd_suggested) { next.test_cmd_dismissed = next.test_cmd_suggested; delete next.test_cmd_suggested; }
  const out: ProjectFlags = { ...flags };
  if (next.starred || next.archived || next.alias || next.dir || CMD_FIELDS.some((k) => next[k])) out[name] = next; else delete out[name];
  return out;
}

/** lowercase name -> home folder, for projects created with a folder. */
export const projectDirs = (flags: ProjectFlags): Record<string, string> => Object.fromEntries(Object.entries(flags).filter(([, f]) => f.dir).map(([n, f]) => [n.toLowerCase(), f.dir!]));

/** What to print for a project: its 显示名 when one was set, else the name itself. */
export const projectLabel = (flags: ProjectFlags, name: string) => flags[name]?.alias || name;

// Which Mac a project lives on after it was handed over (`dispatch move` / `dispatch project <名> --move-to`).
// Same key and shape as PROJECT_OWNERS_KEY in the CLI: the Mac's own name plus its Tailscale IP.
export const PROJECT_OWNERS_KEY = "dispatch-project-owners";
export type ProjectOwner = { host: string; ip: string; at: number };
export function parseProjectOwners(memories: Memory[]): Record<string, ProjectOwner> {
  const raw = memories.find((m) => m.key === PROJECT_OWNERS_KEY)?.value;
  if (!raw) return {};
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return {}; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const out: Record<string, ProjectOwner> = {};
  for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
    const o = v as Partial<ProjectOwner> | null;
    if (o && typeof o.host === "string" && o.host) out[name] = { host: o.host, ip: typeof o.ip === "string" ? o.ip : "", at: typeof o.at === "number" ? o.at : 0 };
  }
  return out;
}
// The hosts-list id ("local" for this Mac) an owner record points at: by name, an old name, or IP.
export function ownerHostId(owner: ProjectOwner | undefined, hosts: { id: string; name: string; local?: boolean; aliases?: string[]; ip?: string }[]): string | undefined {
  if (!owner) return undefined;
  const h = hosts.find((x) => x.name === owner.host || (x.aliases ?? []).includes(owner.host) || (!!owner.ip && x.ip === owner.ip));
  return h ? (h.local ? "local" : h.id) : undefined;
}
// Where 「新建会话」 opens for a project: on its owner Mac when it has one. A folder seen on the other
// Mac becomes the same place under this one's home (dispatch move keeps home-relative paths).
export function newSessionTarget(ownerId: string | undefined, ctx: { host?: string; cwd?: string } | undefined, fallback: string): { initialHost: string; initialCwd?: string } {
  const ctxHost = ctx?.host || fallback;
  if (!ownerId || ownerId === ctxHost) return { initialHost: ctxHost, initialCwd: ctx?.cwd };
  const cwd = toSlash(ctx?.cwd || "");
  const home = homeOf(cwd);
  return { initialHost: ownerId, initialCwd: home ? `~${cwd.slice(home.length)}` : undefined };
}

// Shared settings live next to the flags, in their own memory (`dispatch settings`).
export const SETTINGS_KEY = "dispatch-settings";
export type DispatchSettings = { session_archive_days: number; chat_idle_close_minutes: number; new_worktree: boolean; task_archive_days: number; home_expanded: number; sdk_sessions_scheduled: boolean; workspace_roots: string[]; summary_auto: boolean; summary_model: string; summary_uses?: Record<string, number>; retired_providers: string; human_aliases: string; notify_reply: boolean; notify_attention: boolean; notify_done: boolean; notify_needs_you: boolean; discuss_rules: string; discuss_persona_claude: string; discuss_persona_codex: string; discuss_persona_pi: string; list_density: ListDensity } & IdeSettings;
/** The full IDE (设置 › 编辑器, `dispatch ide`): ⌘E's target, Tab completion (off by default, daily cap in USD), ⌘K's model, language extensions, download mirror. */
export interface IdeSettings { ide_tab_completion: boolean; ide_tab_daily_cap_usd: number; ide_tab_model: string; ide_edit_model: string }
export const IDE_DEFAULTS: IdeSettings = { ide_tab_completion: true, ide_tab_daily_cap_usd: 0.5, ide_tab_model: "deepseek-flash", ide_edit_model: "claude:sonnet" };
/** Row height of every list: comfortable = 40px rows (default), compact = 34px. Drives `data-density` on <html>. */
export type ListDensity = "comfortable" | "compact";
// Discussion members: one line of persona each plus the group's length rules — the same defaults
// as the CLI (dispatch settings), which puts them into each member's system prompt.
export const DISCUSS_RULES_DEFAULT = "闲聊就闲聊，两句以内；正事默认一两段、150 字左右，要论证再展开；只回应最新消息和别人已经说过的观点，不重复，不为了凑段落写风险和拆分；没有新东西就只回 SKIP。";
export const DISCUSS_PERSONA_DEFAULT = { claude: "偏架构和验收：先问值不值得做、做完怎么验证，习惯把方案拆成可交付的步骤。", codex: "抠实现细节：关心具体改哪里、边界情况、能不能复用已有代码，不信没验证过的说法。", pi: "短句直给：一次只说最重要的一点，倾向先做最小可验证的版本，看到过度设计会直说。" };
// Folders whose direct children are projects (~/Projects/<name>/… belongs to <name>).
export const DEFAULT_SETTINGS: DispatchSettings = { session_archive_days: 30, new_worktree: false, chat_idle_close_minutes: 30, task_archive_days: 0, home_expanded: 2, sdk_sessions_scheduled: true, workspace_roots: ["~/Projects"], summary_auto: false, summary_model: "", summary_uses: {}, retired_providers: "", human_aliases: "", notify_reply: true, notify_attention: true, notify_done: true, notify_needs_you: true, discuss_rules: DISCUSS_RULES_DEFAULT, discuss_persona_claude: DISCUSS_PERSONA_DEFAULT.claude, discuss_persona_codex: DISCUSS_PERSONA_DEFAULT.codex, discuss_persona_pi: DISCUSS_PERSONA_DEFAULT.pi, list_density: "comfortable", ...IDE_DEFAULTS };
const DISCUSS_KEYS = ["discuss_rules", "discuss_persona_claude", "discuss_persona_codex", "discuss_persona_pi"] as const;
// Phone pushes (ntfy / Bark), one switch per event; the CLI and the phone server read the same keys.
export const NOTIFY_KEYS = ["notify_reply", "notify_attention", "notify_done", "notify_needs_you"] as const;
export function parseSettings(memories: Memory[]): DispatchSettings {
  const out = { ...DEFAULT_SETTINGS };
  const raw = memories.find((m) => m.key === SETTINGS_KEY)?.value;
  if (!raw) return out;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d.session_archive_days === "number" && d.session_archive_days >= 0) out.session_archive_days = d.session_archive_days;
    if (d && typeof d.task_archive_days === "number" && d.task_archive_days >= 0) out.task_archive_days = d.task_archive_days;
    if (d && typeof d.chat_idle_close_minutes === "number" && d.chat_idle_close_minutes >= 0) out.chat_idle_close_minutes = d.chat_idle_close_minutes;
    if (d && typeof d.home_expanded === "number" && d.home_expanded >= 0) out.home_expanded = d.home_expanded;
    if (d && Array.isArray(d.workspace_roots)) out.workspace_roots = d.workspace_roots.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim());
    if (d && typeof d.sdk_sessions_scheduled === "number") out.sdk_sessions_scheduled = d.sdk_sessions_scheduled !== 0;
    if (d && typeof d.summary_auto === "number") out.summary_auto = d.summary_auto !== 0;
    if (d && typeof d.new_worktree === "number") out.new_worktree = d.new_worktree !== 0;
    for (const k of NOTIFY_KEYS) if (d && typeof d[k] === "number") out[k] = d[k] !== 0;
    if (d && typeof d.summary_model === "string") out.summary_model = d.summary_model.trim();
    if (d && typeof d.retired_providers === "string") out.retired_providers = d.retired_providers.trim();
    if (d && typeof d.human_aliases === "string") out.human_aliases = d.human_aliases.trim();
    if (d && d.summary_uses && typeof d.summary_uses === "object" && !Array.isArray(d.summary_uses)) {
      const uses: Record<string, number> = {};
      for (const [k, v] of Object.entries(d.summary_uses as Record<string, unknown>)) if (k !== "check" && typeof v === "number") uses[k] = v;
      out.summary_uses = uses;
    }
    for (const k of DISCUSS_KEYS) if (d && typeof d[k] === "string") out[k] = d[k].trim();
    if (d && (d.list_density === "compact" || d.list_density === "comfortable")) out.list_density = d.list_density;
    if (d && typeof d.ide_tab_completion === "number") out.ide_tab_completion = d.ide_tab_completion !== 0;
    if (d && typeof d.ide_tab_daily_cap_usd === "number" && d.ide_tab_daily_cap_usd >= 0) out.ide_tab_daily_cap_usd = d.ide_tab_daily_cap_usd;
    for (const k of ["ide_tab_model", "ide_edit_model"] as const) if (d && typeof d[k] === "string" && d[k].trim()) out[k] = d[k].trim();
  } catch { /* keep defaults */ }
  return out;
}
/** Only the settings that changed (summary_uses per key), for `dispatch settings --save`: the CLI merges
 * them into what is stored, so keys another build added are kept and an untouched setting is never reset. */
export function settingsPatch(prev: DispatchSettings, next: DispatchSettings): Record<string, unknown> {
  const a = JSON.parse(serializeSettings(prev)) as Record<string, unknown>;
  const b = JSON.parse(serializeSettings(next)) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "summary_uses") {
      const pa = (a[k] ?? {}) as Record<string, number>, pb = (v ?? {}) as Record<string, number>;
      const uses = Object.fromEntries(Object.entries(pb).filter(([u, x]) => pa[u] !== x));
      if (Object.keys(uses).length) out[k] = uses;
    } else if (JSON.stringify(a[k]) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}
// The CLI stores integers only; booleans travel as 0/1.
export const serializeSettings = (s: DispatchSettings) => JSON.stringify({ home_expanded: s.home_expanded, new_worktree: s.new_worktree ? 1 : 0, sdk_sessions_scheduled: s.sdk_sessions_scheduled ? 1 : 0, session_archive_days: s.session_archive_days, chat_idle_close_minutes: s.chat_idle_close_minutes, task_archive_days: s.task_archive_days, workspace_roots: s.workspace_roots, summary_auto: s.summary_auto ? 1 : 0, summary_model: s.summary_model, retired_providers: s.retired_providers, human_aliases: s.human_aliases, summary_uses: s.summary_uses ?? {}, list_density: s.list_density,
  ide_tab_completion: s.ide_tab_completion ? 1 : 0, ide_tab_daily_cap_usd: s.ide_tab_daily_cap_usd, ide_tab_model: s.ide_tab_model, ide_edit_model: s.ide_edit_model, ...Object.fromEntries(NOTIFY_KEYS.map((k) => [k, s[k] ? 1 : 0])), ...Object.fromEntries(DISCUSS_KEYS.map((k) => [k, s[k]])) });

export const serializeProjectFlags = (flags: ProjectFlags) => JSON.stringify(Object.fromEntries(Object.keys(flags).sort().map((k) => [k, flags[k]])));
export const isStarred = (flags: ProjectFlags, name: string) => !!flags[name]?.starred;
export const isArchived = (flags: ProjectFlags, name: string) => !!flags[name]?.archived;

// Starred first (keeping the caller's order inside each group), archived set aside.
export function rankProjects<T extends { name: string }>(list: T[], flags: ProjectFlags): { active: T[]; archived: T[] } {
  const live = list.filter((p) => !isArchived(flags, p.name));
  return { active: [...live.filter((p) => isStarred(flags, p.name)), ...live.filter((p) => !isStarred(flags, p.name))], archived: list.filter((p) => isArchived(flags, p.name)) };
}
