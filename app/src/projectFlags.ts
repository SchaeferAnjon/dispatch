import type { Memory } from "./types";

// Two switches per project — 收藏 (starred, pinned to the top) and 归档 (archived,
// hidden until asked for) — kept in one shared bd memory so both Macs agree.
// Same key and shape as `dispatch project` in the CLI.
export const PROJECT_FLAGS_KEY = "dispatch-projects";
export const INTERNAL_MEMORY_PREFIX = "dispatch-";
export type ProjectFlag = { starred?: true; archived?: true };
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
    if (f.starred || f.archived) out[name] = f;
  }
  return out;
}

export function withProjectFlag(flags: ProjectFlags, name: string, change: { starred?: boolean; archived?: boolean }): ProjectFlags {
  const cur = { ...(flags[name] ?? {}), ...change };
  const next: ProjectFlag = {};
  if (cur.starred) next.starred = true;
  if (cur.archived) next.archived = true;
  const out: ProjectFlags = { ...flags };
  if (next.starred || next.archived) out[name] = next; else delete out[name];
  return out;
}

// Shared settings live next to the flags, in their own memory (`dispatch settings`).
export const SETTINGS_KEY = "dispatch-settings";
export interface DispatchSettings { session_archive_days: number; home_expanded: number; sdk_sessions_scheduled: boolean; workspace_roots: string[]; summary_auto: boolean; summary_model: string; discuss_rules: string; discuss_persona_claude: string; discuss_persona_codex: string; discuss_persona_pi: string }
// Discussion members: one line of persona each plus the group's length rules — the same defaults
// as the CLI (dispatch settings), which puts them into each member's system prompt.
export const DISCUSS_RULES_DEFAULT = "闲聊就闲聊，两句以内；正事默认一两段、150 字左右，要论证再展开；只回应最新消息和别人已经说过的观点，不重复，不为了凑段落写风险和拆分；没有新东西就只回 SKIP。";
export const DISCUSS_PERSONA_DEFAULT = { claude: "偏架构和验收：先问值不值得做、做完怎么验证，习惯把方案拆成可交付的步骤。", codex: "抠实现细节：关心具体改哪里、边界情况、能不能复用已有代码，不信没验证过的说法。", pi: "短句直给：一次只说最重要的一点，倾向先做最小可验证的版本，看到过度设计会直说。" };
// Folders whose direct children are projects (~/Projects/<name>/… belongs to <name>).
export const DEFAULT_SETTINGS: DispatchSettings = { session_archive_days: 30, home_expanded: 2, sdk_sessions_scheduled: true, workspace_roots: ["~/Projects"], summary_auto: true, summary_model: "", discuss_rules: DISCUSS_RULES_DEFAULT, discuss_persona_claude: DISCUSS_PERSONA_DEFAULT.claude, discuss_persona_codex: DISCUSS_PERSONA_DEFAULT.codex, discuss_persona_pi: DISCUSS_PERSONA_DEFAULT.pi };
const DISCUSS_KEYS = ["discuss_rules", "discuss_persona_claude", "discuss_persona_codex", "discuss_persona_pi"] as const;
export function parseSettings(memories: Memory[]): DispatchSettings {
  const out = { ...DEFAULT_SETTINGS };
  const raw = memories.find((m) => m.key === SETTINGS_KEY)?.value;
  if (!raw) return out;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d.session_archive_days === "number" && d.session_archive_days >= 0) out.session_archive_days = d.session_archive_days;
    if (d && typeof d.home_expanded === "number" && d.home_expanded >= 0) out.home_expanded = d.home_expanded;
    if (d && Array.isArray(d.workspace_roots)) out.workspace_roots = d.workspace_roots.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim());
    if (d && typeof d.sdk_sessions_scheduled === "number") out.sdk_sessions_scheduled = d.sdk_sessions_scheduled !== 0;
    if (d && typeof d.summary_auto === "number") out.summary_auto = d.summary_auto !== 0;
    if (d && typeof d.summary_model === "string") out.summary_model = d.summary_model.trim();
    for (const k of DISCUSS_KEYS) if (d && typeof d[k] === "string") out[k] = d[k].trim();
  } catch { /* keep defaults */ }
  return out;
}
// The CLI stores integers only; booleans travel as 0/1.
export const serializeSettings = (s: DispatchSettings) => JSON.stringify({ home_expanded: s.home_expanded, sdk_sessions_scheduled: s.sdk_sessions_scheduled ? 1 : 0, session_archive_days: s.session_archive_days, workspace_roots: s.workspace_roots, summary_auto: s.summary_auto ? 1 : 0, summary_model: s.summary_model, ...Object.fromEntries(DISCUSS_KEYS.map((k) => [k, s[k]])) });

export const serializeProjectFlags = (flags: ProjectFlags) => JSON.stringify(Object.fromEntries(Object.keys(flags).sort().map((k) => [k, flags[k]])));
export const isStarred = (flags: ProjectFlags, name: string) => !!flags[name]?.starred;
export const isArchived = (flags: ProjectFlags, name: string) => !!flags[name]?.archived;

// Starred first (keeping the caller's order inside each group), archived set aside.
export function rankProjects<T extends { name: string }>(list: T[], flags: ProjectFlags): { active: T[]; archived: T[] } {
  const live = list.filter((p) => !isArchived(flags, p.name));
  return { active: [...live.filter((p) => isStarred(flags, p.name)), ...live.filter((p) => !isStarred(flags, p.name))], archived: list.filter((p) => isArchived(flags, p.name)) };
}
