// Tab completion and ⌘K settings, shown in the editor window's own Settings (Dispatch IDE
// patches/530-editor-settings.patch). The page asks by name; the command line is built here, and a save
// only carries the four editor settings, checked, through `dispatch settings --save`.

export interface EditorCall {
  args: string[];
  input?: string;
}

const MODEL = /^[\w.:\-[\]]{1,80}$/;

/** The settings patch a save may write, from what the page sent; Error on anything else. */
export function editorPatch(p: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "ide_tab_completion" && typeof v === "boolean") out[k] = v ? 1 : 0;
    else if ((k === "ide_tab_model" || k === "ide_edit_model") && typeof v === "string" && MODEL.test(v.trim())) out[k] = v.trim();
    else if (k === "ide_tab_daily_cap_usd" && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000) out[k] = Math.round(v * 100) / 100;
    else throw new Error(`bad setting ${k}`);
  }
  if (!Object.keys(out).length) throw new Error("nothing to save");
  return out;
}

export function editorCall(op: string, p: Record<string, unknown> = {}): EditorCall {
  if (op === "get") return { args: ["ide", "editor-settings", "--json"] };
  if (op === "save") return { args: ["settings", "--save", "--json"], input: JSON.stringify(editorPatch(p)) };
  throw new Error(`unknown operation ${op}`);
}

/** Tab completion through Claude or Codex (the subscription, `dispatch ide complete`) rather than DeepSeek's FIM API. */
export const viaSubscription = (model: string) => /^(claude|codex):/.test(model);

/** What the editor window's Settings is searched for: the four settings share this prefix. */
export const EDITOR_SETTINGS_QUERY = "dispatch.editor.";
/** A request older than this (seconds) is stale: nobody waits for it any more. */
export const SETTINGS_REQUEST_FRESH_S = 30;

export interface SettingsRequest {
  query: string;
  at: number;
}

export function settingsRequest(now: number): SettingsRequest {
  return { query: EDITOR_SETTINGS_QUERY, at: now };
}

interface Fs {
  renameSync(a: string, b: string): void;
  readFileSync(p: string, enc: "utf8"): string;
  rmSync(p: string, o: { force: boolean }): void;
}

/** Take the request if it is there and fresh: renamed away first, so only one window acts on it. */
export function takeSettingsRequest(file: string, pid: number, now: number, fs: Fs): SettingsRequest | undefined {
  const mine = `${file}.${pid}`;
  try {
    fs.renameSync(file, mine);
  } catch {
    return undefined; // none, or another window took it
  }
  let rec: { query?: unknown; at?: unknown };
  try {
    rec = JSON.parse(fs.readFileSync(mine, "utf8"));
  } catch {
    return undefined;
  } finally {
    try {
      fs.rmSync(mine, { force: true });
    } catch {
      /* gone */
    }
  }
  if (typeof rec.at !== "number" || now - rec.at > SETTINGS_REQUEST_FRESH_S) return undefined;
  return { query: typeof rec.query === "string" && rec.query.startsWith("dispatch.") ? rec.query : EDITOR_SETTINGS_QUERY, at: rec.at };
}
