// The Api the chat page needs, over the webview's postMessage to dispatch-bridge (ide-ext/src/chatPanel.ts):
// chat commands go to chatd's local door, `dispatch …` runs as a CLI call, events come back as they arrive.
import type { Api } from "../api";
import type { ChatEvent } from "../chatProtocol";

interface VsCode { postMessage(m: unknown): void }
declare function acquireVsCodeApi(): VsCode;

/** What the extension tells the page: the folder, its conversation, the Mac's language (Dispatch follows it) and the colours. */
export interface PanelInit { root: string; session: string | null; language: string; dark: boolean }
export type FromExt =
  | { kind: "reply"; id: number; ok: boolean; result?: string; error?: string }
  | { kind: "event"; e: ChatEvent }
  | { kind: "init"; init: PanelInit }
  | { kind: "focus" }
  | { kind: "drawer" }
  | { kind: "fresh"; key: string; result: string }
  | { kind: "insert"; text: string };

const vscode = acquireVsCodeApi();
let seq = 0;
const pending = new Map<number, { res: (v: string) => void; rej: (e: Error) => void }>();
const chatListeners = new Set<(e: ChatEvent) => void>();
const pageListeners = new Set<(m: FromExt) => void>();

window.addEventListener("message", (ev: MessageEvent<FromExt>) => {
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  if (m.kind === "reply") {
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.ok) p.res(m.result ?? ""); else p.rej(new Error(m.error || "Dispatch IDE"));
  } else if (m.kind === "event") chatListeners.forEach((cb) => cb(m.e));
  else pageListeners.forEach((cb) => cb(m));
});

function rpc(kind: string, payload: Record<string, unknown>): Promise<string> {
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); vscode.postMessage({ kind, id, ...payload }); });
}
export const send = (m: Record<string, unknown>) => vscode.postMessage(m);

/** A composer <select> as menu rows (menu.ts): its options, optgroups as separators. */
export type PickItem = { kind: "separator"; label: string } | { kind: "item"; label: string; value: string; picked: boolean; disabled: boolean };
export function selectItems(sel: HTMLSelectElement): PickItem[] {
  const out: PickItem[] = [];
  const opt = (o: HTMLOptionElement): PickItem => ({ kind: "item", label: o.text, value: o.value, picked: o.value === sel.value, disabled: o.disabled });
  for (const el of Array.from(sel.children)) {
    if (el instanceof HTMLOptGroupElement) { out.push({ kind: "separator", label: el.label }); out.push(...Array.from(el.children).filter((c): c is HTMLOptionElement => c instanceof HTMLOptionElement).map(opt)); }
    else if (el instanceof HTMLOptionElement) out.push(opt(el));
  }
  return out;
}
export function onPage(cb: (m: FromExt) => void) { pageListeners.add(cb); return () => { pageListeners.delete(cb); }; }

const json = <T,>(s: string): T => JSON.parse(s.replace(/^[^{[]*/, "")) as T;
const run = (args: string[], stdin?: string) => rpc("dispatch", { args, stdin });
/** Reads the column makes on every open: the extension answers with the last result at once and sends
 *  { kind: "fresh", key } when the CLI's new answer differs ("workspace": kept per folder). */
export const cachedRun = (args: string[], scope: "global" | "workspace" = "global") => rpc("dispatch", { args, cache: scope });
export const parseJson = <T,>(s: string): T => JSON.parse(s.replace(/^[^{[]*/, "")) as T;

const base: Partial<Api> = {
  chatAvailable: true,
  chatCommand: async (cmd) => { await rpc("chat", { cmd }); },
  onChatEvent: async (cb) => { chatListeners.add(cb); return () => { chatListeners.delete(cb); }; },
  chatRestart: async () => { await rpc("chatRestart", {}); },
  // the model list (models.ts) comes through here too: cached like hosts
  on: (host, args, stdin) => (args[0] === "models" && (!host || host === "local") && !stdin ? cachedRun(args) : run(host && host !== "local" ? ["--host", host, ...args] : args, stdin)),
  sessionDetail: async (id, brief) => json(await cachedRun(["session", id, "--json", ...(brief ? ["--brief"] : [])], "workspace")),
  hosts: async () => json(await cachedRun(["hosts", "--json"])),
  copy: async (text) => { await navigator.clipboard.writeText(text); },
  openPath: async (path) => { await rpc("openFile", { path }); },
};
const NOT_HERE = new Set<PropertyKey>(["then", "toJSON", "$$typeof"]);
/** Everything else the Api has is a page of Dispatch that is not in this column: it says so instead of hanging. */
export const api = new Proxy(base, {
  get(target, p) {
    if (p in target) return target[p as keyof Api];
    if (typeof p === "symbol" || NOT_HERE.has(p)) return undefined;
    return () => Promise.reject(new Error("Dispatch IDE: " + String(p)));
  },
}) as Api;
