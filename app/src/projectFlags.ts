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
export interface DispatchSettings { session_archive_days: number }
export function parseSettings(memories: Memory[]): DispatchSettings {
  const out: DispatchSettings = { session_archive_days: 30 };
  const raw = memories.find((m) => m.key === SETTINGS_KEY)?.value;
  if (!raw) return out;
  try { const d = JSON.parse(raw); if (d && typeof d.session_archive_days === "number" && d.session_archive_days >= 0) out.session_archive_days = d.session_archive_days; } catch { /* keep defaults */ }
  return out;
}

export const serializeProjectFlags = (flags: ProjectFlags) => JSON.stringify(Object.fromEntries(Object.keys(flags).sort().map((k) => [k, flags[k]])));
export const isStarred = (flags: ProjectFlags, name: string) => !!flags[name]?.starred;
export const isArchived = (flags: ProjectFlags, name: string) => !!flags[name]?.archived;

// Starred first (keeping the caller's order inside each group), archived set aside.
export function rankProjects<T extends { name: string }>(list: T[], flags: ProjectFlags): { active: T[]; archived: T[] } {
  const live = list.filter((p) => !isArchived(flags, p.name));
  return { active: [...live.filter((p) => isStarred(flags, p.name)), ...live.filter((p) => !isStarred(flags, p.name))], archived: list.filter((p) => isArchived(flags, p.name)) };
}
