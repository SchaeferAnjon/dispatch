import { useEffect, useState } from "react";
import type { Api } from "./api";

// Models an agent can start with, per Mac (`dispatch models`): Claude's from Anthropic's model
// list, Codex's from the list Codex itself keeps for the ChatGPT account. A new release shows up
// here without an app update. `id` goes after `--model`; "" is the agent's own default.
export interface ModelOption { id: string; label: string; family?: string; latest?: boolean; note?: string; default?: string }
export type ModelCatalog = Record<string, ModelOption[]>;

// Until the CLI answers (or on an older one without `models`): the Claude aliases, which always
// mean the newest of their family, and every agent's own default.
export const FALLBACK_MODELS: ModelCatalog = {
  claude: [{ id: "", label: "默认" }, ...["fable", "opus", "sonnet", "haiku"].map((f) => ({ id: f, label: f[0].toUpperCase() + f.slice(1), family: f, latest: true }))],
  codex: [{ id: "", label: "默认" }],
  pi: [{ id: "", label: "默认" }],
};

/** Session and `agent start` names differ for Claude ("claude-code" vs "claude"); the catalog uses the latter. */
export const modelKind = (agent: string) => (agent === "claude-code" ? "claude" : agent);

const loaded = new Map<string, Promise<ModelCatalog>>();

export function loadModels(api: Api, host: string): Promise<ModelCatalog> {
  let p = loaded.get(host);
  if (!p) {
    p = api.on(host, ["models", "--json"]).then((s) => ({ ...FALLBACK_MODELS, ...(JSON.parse(s.slice(Math.max(0, s.indexOf("{")))) as ModelCatalog) }));
    // A failed read (offline Mac, older CLI) is not remembered: the next dialog asks again.
    p.catch(() => loaded.delete(host));
    loaded.set(host, p);
  }
  return p;
}

export function useModels(api: Api | undefined, host: string): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>(FALLBACK_MODELS);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    loadModels(api, host).then((c) => { if (alive) setCatalog(c); }).catch(() => { if (alive) setCatalog(FALLBACK_MODELS); });
    return () => { alive = false; };
  }, [api, host]);
  return catalog;
}

const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const undated = (id: string) => id.replace(/-\d{8}(?=$|\[)/, "");
/** A readable name from a model id alone: "claude-haiku-4-5-20251001" → "Haiku 4.5",
 *  "claude-opus-5-5[1m]" → "Opus 5.5 · 1M", "claude-3-5-sonnet-20241022" → "Sonnet 3.5", "opus" → "Opus". Other ids stay as they are. */
export function modelNameOf(id: string): string {
  const one = /\[1m\]$/i.test(id) ? " · 1M" : "";
  // Bedrock ("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), Vertex ("claude-sonnet-4-5@20250929") and "-latest" spellings too
  const bare = undated(id.replace(/\[1m\]$/i, "").replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/@\d{8}$/, "").replace(/-latest$/, ""));
  const cap = (f: string) => f[0].toUpperCase() + f.slice(1);
  if (CLAUDE_FAMILIES.includes(bare)) return cap(bare) + one;
  let m = /^claude-(fable|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?$/.exec(bare);
  if (m) return m[2] ? `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}${one}` : cap(m[1]) + one;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-(fable|opus|sonnet|haiku)$/.exec(bare);
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ""}${one}`;
  return id;
}
/** The catalog entry a model id stands for: the same id, the same id without its date, or (an alias
 *  such as "haiku") the newest of that family. The agent reports the full dated id after it starts. */
export function matchModel(options: ModelOption[] | undefined, id: string): ModelOption | undefined {
  if (!id || !options?.length) return undefined;
  const hit = options.find((o) => o.id === id) ?? options.find((o) => o.id && undated(o.id) === undated(id));
  if (hit) return hit;
  return CLAUDE_FAMILIES.includes(id) ? options.find((o) => o.family === id && o.latest !== false) : undefined;
}
/** What to call a model in the picker and on a turn: the catalog's label, else a name from the id. */
/** One letter for a model chip too narrow for its name: the model's own first letter, the default's model for 默认. */
export function initialOf(name: string, options: ModelOption[] | undefined): string {
  const n = name || options?.find((o) => o.id === "")?.default || "";
  return (n.match(/[A-Za-z0-9]/)?.[0] ?? n.slice(0, 1)).toUpperCase();
}
export function modelName(options: ModelOption[] | undefined, id: string): string {
  const hit = matchModel(options, id);
  if (hit?.label) return hit.label;
  // "claude-opus-5-5[1m]" when the catalog only lists "claude-opus-5-5": its label with the 1M context
  const base = /\[1m\]$/i.test(id) ? matchModel(options, id.replace(/\[1m\]$/i, ""))?.label : "";
  return base ? `${base} · 1M` : modelNameOf(id);
}

/** "" and the newest ones first, older releases after; a saved choice the list no longer has stays selectable. */
export function modelGroups(options: ModelOption[] | undefined, current = ""): { latest: ModelOption[]; older: ModelOption[] } {
  const all = options?.length ? options : [{ id: "", label: "默认" }];
  const withCurrent = current && !matchModel(all, current) ? [...all, { id: current, label: modelNameOf(current), latest: true }] : all;
  return { latest: withCurrent.filter((o) => o.latest !== false), older: withCurrent.filter((o) => o.latest === false) };
}
