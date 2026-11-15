// The pure part of the Agents window's Settings page (Dispatch IDE patches/510-settings.patch):
// what `dispatch.settings` may read and write through `dispatch settings`, and how Keep awake holds the Mac
// awake with caffeinate.

/** The shared settings the page shows. A save carries only these, each 0 or 1: the four the phone is told
 *  about, banners on this Mac in the background (notify_desktop, the same switch as the first-run wizard's),
 *  and which kinds show a banner on this Mac (kanban app/cli/notify_prefs.py) — plus the sound, a name. */
export const PAGE_SETTINGS = ["notify_reply", "notify_attention", "notify_done", "notify_needs_you", "notify_desktop",
  "notify_mac_finished", "notify_mac_needs_you", "notify_mac_stopped"] as const;
/** What a setting is when `dispatch settings` does not say (the CLI's SETTING_DEFAULTS): background banners on
 *  this Mac are off until the person turns them on, the phone ones are on; a stop does not ring by default. */
const PAGE_DEFAULTS: Record<PageSetting, boolean> = {
  notify_reply: true, notify_attention: true, notify_done: true, notify_needs_you: true, notify_desktop: false,
  notify_mac_finished: true, notify_mac_needs_you: true, notify_mac_stopped: false,
};
export type PageSetting = (typeof PAGE_SETTINGS)[number];
/** The banner's sound: "default" (the Mac's alert sound), "none", or one of the Mac's sounds by name. */
export const SOUND_SETTING = "notify_sound";
const SOUND_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export type PageValues = Record<PageSetting, boolean> & { notify_sound: string };

export interface SettingsCall {
  readonly args: string[];
  readonly input?: string;
}

/** The settings a save may write, from what the page sent; Error on anything else. */
export function settingsPatch(p: Record<string, unknown>): Partial<Record<PageSetting, number>> & { notify_sound?: string } {
  const out: Partial<Record<PageSetting, number>> & { notify_sound?: string } = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === SOUND_SETTING) {
      if (typeof v !== "string" || !SOUND_NAME.test(v)) throw new Error(`bad value for ${k}`);
      out.notify_sound = v;
      continue;
    }
    if (!(PAGE_SETTINGS as readonly string[]).includes(k)) throw new Error(`bad setting ${k}`);
    if (typeof v === "boolean") out[k as PageSetting] = v ? 1 : 0;
    else if (v === 0 || v === 1) out[k as PageSetting] = v;
    else throw new Error(`bad value for ${k}`);
  }
  if (!Object.keys(out).length) throw new Error("nothing to save");
  return out;
}

export function settingsCall(op: string, p: Record<string, unknown> = {}): SettingsCall {
  if (op === "get") return { args: ["settings", "--json"] };
  if (op === "save") return { args: ["settings", "--save", "--json"], input: JSON.stringify(settingsPatch(p)) };
  throw new Error(`unknown operation ${op}`);
}

/** Only the page's settings out of everything `dispatch settings --json` answers, as on / off. */
export function pageSettings(all: unknown): PageValues {
  const r = (all && typeof all === "object" ? all : {}) as Record<string, unknown>;
  const out = {} as PageValues;
  for (const k of PAGE_SETTINGS) out[k] = r[k] === undefined ? PAGE_DEFAULTS[k] : Number(r[k]) === 1;
  out.notify_sound = typeof r[SOUND_SETTING] === "string" && SOUND_NAME.test(r[SOUND_SETTING] as string) ? (r[SOUND_SETTING] as string) : "default";
  return out;
}

// ---- Keep awake ----------------------------------------------------------------------------------------

/** While an agent works or a phone is connected (kanban app/cli/awake.py, setting keep_awake): system, the Mac
 *  does not go to sleep, the screen still dims and locks; display, the screen stays on too; off, the Mac's own
 *  energy settings. */
export type AwakeMode = "system" | "display" | "off";
export const AWAKE_MODES: readonly AwakeMode[] = ["system", "display", "off"];
export const AWAKE_DEFAULT: AwakeMode = "system";

export function awakeMode(v: unknown): AwakeMode {
  return (AWAKE_MODES as readonly unknown[]).includes(v) ? (v as AwakeMode) : AWAKE_DEFAULT;
}

/** A mode someone asked for, or undefined when it is not one. */
export function awakeSetting(v: unknown): AwakeMode | undefined {
  return (AWAKE_MODES as readonly unknown[]).includes(v) ? (v as AwakeMode) : undefined;
}

export interface AwakeState {
  readonly mode: AwakeMode;
  /** caffeinate holds the Mac awake right now */
  readonly holding: boolean;
  /** why: "working" (an agent is working), "phone" (a phone is connected), or "" */
  readonly reason: "working" | "phone" | "";
  /** agent sessions working on this Mac */
  readonly working: number;
  /** Dispatch's background service made a pass lately (without it nothing keeps the Mac awake) */
  readonly running: boolean;
}

/** `dispatch awake --json` as the page and the bottom bar read it. */
export function awakeState(r: unknown): AwakeState {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const reason = o.reason === "working" || o.reason === "phone" ? o.reason : "";
  const working = typeof o.working === "number" && o.working > 0 ? Math.floor(o.working) : 0;
  return { mode: awakeMode(o.mode), holding: o.holding === true, reason, working, running: o.running !== false };
}

// ---- Settings read in one go (design/settings-fast) -------------------------------------------------------------

/** What `dispatch settings-page --json` reads, each part in the shape the page draws it: the same as the command the
 *  page used to run on its own answers through this bridge. A part that failed is left out (the page keeps what it
 *  had). The keys come as names with their notes, never their values; the tool servers twice, as names (`mcp`) and
 *  whole (`mcpFull`, which the window does not write down). */
export function shapeSnapshot(raw: unknown, mobile: (r: unknown) => unknown): Record<string, unknown> {
  const parts = (raw && typeof raw === "object" ? (raw as { parts?: unknown }).parts : undefined) as Record<string, { ok?: boolean; value?: unknown }> | undefined;
  const out: Record<string, unknown> = {};
  if (!parts || typeof parts !== "object") return out;
  const ok = (k: string) => (parts[k] && parts[k].ok === true ? parts[k].value : undefined);
  const obj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  const notify = ok("notify");
  if (obj(notify)) out.notify = pageSettings(notify);
  const awake = ok("awake");
  if (obj(awake)) out.awake = awakeState(awake);
  const phone = ok("mobile");
  if (obj(phone)) out.mobile = mobile(phone);
  for (const k of ["soul", "autonomy", "attribution", "nextup", "neat", "gitIdentity", "computer"]) {
    const v = ok(k);
    if (obj(v) && (v as { ok?: boolean }).ok !== false) out[k] = v;
  }
  const keys = ok("keys");
  if (Array.isArray(keys)) {
    out.keys = keys.filter((r) => r && typeof r.name === "string").map((r) => ({ name: r.name, note: typeof r.note === "string" ? r.note : "", project: typeof r.project === "string" ? r.project : "", length: Number(r.length) || 0 }));
  }
  // Settings › Soul: what Dispatch puts into every agent, its switches with it (agent_builtins.py)
  const builtins = ok("builtins");
  if (obj(builtins)) out.builtins = builtins;
  const mcp = ok("mcp") as { servers?: { name?: unknown; scope?: unknown; builtin?: unknown }[] } | undefined;
  if (obj(mcp) && Array.isArray(mcp!.servers)) {
    out.mcp = { servers: mcp!.servers.filter((s) => s && typeof s.name === "string").map((s) => ({ name: s.name, scope: String(s.scope ?? ""), builtin: s.builtin === true })) };
    // the whole answer, for the MCP servers page: the window keeps it in memory only (a server's env can hold a key)
    out.mcpFull = mcp;
  }
  for (const k of ["inventory", "plugins"]) {
    const v = ok(k);
    if (obj(v)) out[k] = v;
  }
  return out;
}

/** Settings › Agents: every other app without asking (`dispatch computer allowed [--all on|off]`); no argument reads it. */
export function computerAllowAllArgs(on: unknown): string[] {
  if (on === undefined) return ["computer", "allowed", "--json"];
  if (typeof on !== "boolean") throw new Error("dispatch.computerAllowAll: on or off");
  return ["computer", "allowed", "--all", on ? "on" : "off", "--json"];
}
