// 在 VS Code / Cursor 里打开 (the right-click menus of a session and a project, wide screens only):
// which of the two editors the Mac has (`dispatch editor apps`) and opening a folder in one
// (`dispatch editor open-in`). The editor opens on the Mac that serves this page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./api";

const trimSlash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
const isHomeDir = (p: string) => /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)\/?$/.test(p.replace(/\\/g, "/")) || p === "~" || p === "/";

/** The folder a session's editor opens: null for another Mac's session, no folder, or the home folder. */
export function sessionFolder(a: { cwd?: string; remote?: boolean }): string | null {
  if (a.remote || !a.cwd || isHomeDir(a.cwd)) return null;
  return trimSlash(a.cwd);
}
/** The folder a project's editor opens: null without one, or the home folder. */
export function projectFolder(dir: string | null | undefined): string | null {
  if (!dir || isHomeDir(dir)) return null;
  return trimSlash(dir);
}

const parse = <T,>(raw: string): T => JSON.parse(raw.slice(Math.max(0, raw.indexOf("{"))));

// ---- VS Code / Cursor: installed? One `editor apps` call per root, cached for the page's life.
export type ExternalApp = "code" | "cursor";
type AppsState = Partial<Record<ExternalApp, boolean>>;
const appsCache = new Map<string, AppsState | Promise<AppsState>>();
export function resetAppsCache() { appsCache.clear(); }
const editorCall = (api: Pick<Api, "on">, args: string[]) => api.on("local", ["editor", ...args, "--json"]).then((t) => {
  const r = parse<{ ok: boolean; error?: string; message?: string }>(t);
  if (!r.ok) throw new Error(r.message || r.error || "editor");
  return r;
});
/** Resolves which external editors are installed; cached per root (a failed probe counts as unknown). */
export function externalApps(api: Pick<Api, "on">, root: string): Promise<AppsState> {
  const hit = appsCache.get(root);
  if (hit) return Promise.resolve(hit);
  const p = editorCall(api, ["apps", "--root", root])
    .then((r) => Object.fromEntries((r as unknown as { apps: { id: ExternalApp; installed: boolean }[] }).apps.map((x) => [x.id, x.installed])) as AppsState)
    .catch(() => ({}) as AppsState);
  appsCache.set(root, p);
  void p.then((v) => appsCache.set(root, v));
  return p;
}
/**
 * For menus built synchronously: `installed(root, app)` answers from the cache (undefined while unknown,
 * which the menus treat as enabled) and starts the probe; the component re-renders when it lands.
 */
export function useExternalApps(api: Pick<Api, "on"> | null) {
  const [, bump] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return useCallback((root: string, app: ExternalApp): boolean | undefined => {
    if (!api || !root) return undefined;
    const hit = appsCache.get(root);
    if (hit && !(hit instanceof Promise)) return hit[app];
    if (!hit) void externalApps(api, root).then(() => { if (alive.current) bump((n) => n + 1); });
    return undefined;
  }, [api]);
}
/** 在 VS Code / Cursor 里打开. */
export function openInApp(api: Pick<Api, "on">, root: string, app: ExternalApp) {
  return editorCall(api, ["open-in", "--root", root, "--app", app]);
}
