// The live side of a chat session: one subscription to chatd's event stream (shared by every
// mounted page), one ChatView per session kept in module state (so a page that remounts mid-turn
// picks up where it was), and the command helpers the page calls. History before the page opened
// still comes from the transcript (api.sessionDetail); this store only holds what streamed since.
//
// Depends on chatProtocol.ts only: idechat/bridge.ts implements `ChatApi` in Dispatch IDE's webview, the page passes
// its Api (which extends ChatApi) in.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { EVENT_ALL, initialChatView, reduceChatEvent, type ChatAgent, type ChatApi, type ChatCommand, type ChatEvent, type ChatEventOf, type ChatImage, type ChatView, type CloseReason, type Decision, type PermissionMode, type SendMode } from "./chatProtocol";

void EVENT_ALL; // the channel name lives in the protocol

export interface OpenInput { agent: ChatAgent; cwd: string; resume?: string; model?: string; permission_mode?: PermissionMode; effort?: string; task?: string; label?: string }
export interface ChatHandle {
  /** null until chatd said `opened` (or `state` after a replay) for this session. */
  view: ChatView | null;
  chatd: "unknown" | "up" | "down";
  hello: ChatEventOf<"hello"> | null;
  /** Start or resume; resolves with the session key from `opened`, rejects with the error message. */
  open(input: OpenInput): Promise<string>;
  send(text: string, images?: ChatImage[], mode?: SendMode): Promise<string>;
  withdraw(message_id: string): Promise<void>;
  interrupt(): Promise<void>;
  permission(permission_id: string, decision: Decision, message?: string): Promise<void>;
  answer(permission_id: string, answers: Record<string, string[]>): Promise<void>;
  setModel(model: string, effort?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  commands(): Promise<void>;
  replay(): Promise<void>;
  close(reason?: CloseReason): Promise<void>;
  hello_(): Promise<void>;
}

// ---- module state
const views = new Map<string, ChatView>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();
let chatdState: ChatHandle["chatd"] = "unknown";
let helloEvent: ChatEventOf<"hello"> | null = null;
let stream: { api: ChatApi; off: Promise<() => void>; refs: number } | null = null;
const pending = new Map<string, { resolve: (e: ChatEvent) => void; reject: (m: string) => void; timer: number }>();

const notify = (session?: string) => { (session ? listeners.get(session) : undefined)?.forEach((l) => l()); globalListeners.forEach((l) => l()); };
export const newId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Every chatd line lands here (the webview bridge calls it for each line; tests call it directly). */
export function ingest(e: ChatEvent) {
  if (e.ev === "chatd") {
    chatdState = e.state === "up" ? "up" : "down";
    if (e.state === "down") {
      for (const [id, p] of pending) { window.clearTimeout(p.timer); p.reject(e.reason || "chatd down"); pending.delete(id); }
      for (const s of views.keys()) { sidecarGone(s); notify(s); }
    }
    // A new chatd counts `seq` from 1 again: without this every view would drop its events as replays.
    for (const [s, v] of views) if (v.seq !== 0) views.set(s, { ...v, seq: 0 });
  } else if (chatdState !== "up") chatdState = "up"; // any real event means the sidecar is there (the page may have missed its "up")
  if (e.ev === "hello") helloEvent = e;
  if ("session" in e && e.session) {
    const prev = views.get(e.session) ?? initialChatView(e.session);
    const next = reduceChatEvent(prev, e);
    if (next !== prev) views.set(e.session, next);
    // the conversation took the message over: a turn for it started, or it waits in the queue
    const out = outboxes.get(e.session);
    if (out && (e.ev === "turn_started" || e.ev === "queue" || e.ev === "state")) { const rest = waitingOutgoing(out, next); if (rest.length !== out.length) setOutbox(e.session, rest); }
  }
  if (e.ev === "sessions") for (const s of e.sessions) { const prev = views.get(s.session) ?? initialChatView(s.session); views.set(s.session, reduceChatEvent(prev, { ...s, ev: "state", seq: prev.seq + 1, ts: e.ts })); notify(s.session); }
  if (e.request_id && pending.has(e.request_id)) {
    const p = pending.get(e.request_id)!; pending.delete(e.request_id); window.clearTimeout(p.timer);
    if (e.ev === "error") p.reject(e.message); else p.resolve(e);
  }
  notify("session" in e ? e.session : undefined);
}

/** chatd died with this session in it (its agent process went with it): finish the open turns as
 *  errors and mark the session stopped, the way the reducer would if chatd had said so itself. */
function sidecarGone(session: string) {
  let v = views.get(session);
  if (!v || v.lifecycle === "stopped") return;
  const ts = Date.now() / 1000;
  for (const t of v.turns) if (!t.status) v = reduceChatEvent(v, { ev: "turn_done", seq: v.seq + 1, ts, session, turn_id: t.turn_id, status: "error", error: "chatd exited", duration_ms: 0, num_tools: Object.keys(t.tools).length });
  views.set(session, reduceChatEvent(v, { ev: "closed", seq: v.seq + 1, ts, session, reason: "exited" }));
}

function ensureStream(api: ChatApi) {
  if (stream && stream.api === api) { stream.refs++; return; }
  if (stream) void stream.off.then((f) => f());
  // A host whose listener cannot attach leaves the store quiet rather than throwing unhandled.
  stream = { api, refs: 1, off: api.onChatEvent(ingest).catch(() => () => {}) };
}
function releaseStream() {
  if (!stream || --stream.refs > 0) return;
  const s = stream; stream = null; void s.off.then((f) => f());
}
/** Keep the event stream attached without a page (App-level badges); returns the release. */
export function subscribeChat(api: ChatApi): () => void {
  if (!api.chatAvailable) return () => {};
  ensureStream(api);
  let done = false;
  return () => { if (!done) { done = true; releaseStream(); } };
}
/** What the store last heard about the sidecar. */
export const chatdStatus = (): ChatHandle["chatd"] => chatdState;

/** Send a command and wait for its reply event (the one carrying the same request_id), 20 s at most. */
export function request(api: ChatApi, cmd: ChatCommand, timeoutMs = 20000): Promise<ChatEvent> {
  const request_id = cmd.request_id ?? newId();
  return new Promise<ChatEvent>((resolve, reject) => {
    const timer = window.setTimeout(() => { pending.delete(request_id); reject("chatd did not answer"); }, timeoutMs);
    pending.set(request_id, { resolve, reject, timer });
    // Send only once the page is listening, or a fast reply (hello right after mount) is lost.
    const listening = stream && stream.api === api ? stream.off : Promise.resolve();
    void listening.then(() => api.chatCommand({ ...cmd, request_id })).catch((e) => { pending.delete(request_id); window.clearTimeout(timer); reject(e instanceof Error ? e.message : String(e)); });
  });
}

// ---- the outbox: a message shows in the conversation the moment you send it (DESIGN.md 发出即上屏).
// It stays here until chatd starts a turn for it (turn_started) or queues it; a send that fails
// stays as `failed`, with what it would have sent, so the page can offer 重发.
export interface Outgoing {
  session: string; message_id: string; text: string;
  /** Thumbnails (data URLs) of the pictures it carries. */
  pictures: string[];
  at: number; state: "sending" | "failed"; error?: string;
  /** What goes to chatd again on 重发. */
  payload: { text: string; images: ChatImage[]; mode?: SendMode; display?: string };
}
const outboxes = new Map<string, Outgoing[]>();
const NO_OUT: Outgoing[] = [];
// A sent message's thumbnails, by message_id: the live turn draws them over its bubble (chatd only says how many).
const pictures = new Map<string, string[]>();
export const picturesOf = (message_id: string): string[] => pictures.get(message_id) ?? NO_PICS;
const NO_PICS: string[] = [];
export function rememberPictures(message_id: string, urls: string[]) { if (urls.length) { if (pictures.size > 200) pictures.delete(pictures.keys().next().value!); pictures.set(message_id, urls); } }
const setOutbox = (session: string, list: Outgoing[]) => { if (list.length) outboxes.set(session, list); else outboxes.delete(session); notify(session); };
export function outboxAdd(o: Outgoing) { rememberPictures(o.message_id, o.pictures); setOutbox(o.session, [...(outboxes.get(o.session) ?? []).filter((x) => x.message_id !== o.message_id), o]); }
export function outboxFail(session: string, message_id: string, error: string) { setOutbox(session, (outboxes.get(session) ?? []).map((x) => (x.message_id === message_id ? { ...x, state: "failed" as const, error } : x))); }
export function outboxDrop(session: string, message_id: string) { const l = outboxes.get(session); if (l?.some((x) => x.message_id === message_id)) setOutbox(session, l.filter((x) => x.message_id !== message_id)); }
export const outboxOf = (session: string): Outgoing[] => outboxes.get(session) ?? NO_OUT;
/** What still waits on screen: not yet a turn of the view and not in its queue. Pure. */
export function waitingOutgoing(list: Outgoing[], view: Pick<ChatView, "turns" | "queue"> | null): Outgoing[] {
  if (!view || !list.length) return list;
  const taken = new Set([...view.turns.map((t) => t.message_id), ...view.queue.map((q) => q.message_id)]);
  return list.filter((o) => !taken.has(o.message_id));
}
export function useOutbox(session: string | null): Outgoing[] {
  const subscribe = useCallback((l: () => void) => {
    if (!session) return () => {};
    let set = listeners.get(session); if (!set) listeners.set(session, (set = new Set())); set.add(l);
    return () => { listeners.get(session)?.delete(l); };
  }, [session]);
  const snap = () => (session ? outboxOf(session) : NO_OUT);
  return useSyncExternalStore(subscribe, snap, snap);
}

/** Read a session's live view without subscribing (workbench rows, badges). */
export const chatViewOf = (session: string): ChatView | undefined => views.get(session);
/** Tests and a fresh app state. */
export function resetChatStore() { if (stream) { const s = stream; stream = null; void s.off.then((f) => f()); } views.clear(); outboxes.clear(); pictures.clear(); listeners.clear(); chatdState = "unknown"; helloEvent = null; for (const p of pending.values()) window.clearTimeout(p.timer); pending.clear(); }

const NONE: ChatView | null = null;
export function useChatSession(api: ChatApi | null, session: string | null): ChatHandle {
  useEffect(() => { if (!api || !api.chatAvailable) return; ensureStream(api); return releaseStream; }, [api]);
  const subscribe = useCallback((l: () => void) => {
    globalListeners.add(l);
    if (session) { let set = listeners.get(session); if (!set) listeners.set(session, (set = new Set())); set.add(l); }
    return () => { globalListeners.delete(l); listeners.get(session ?? "")?.delete(l); };
  }, [session]);
  const view = useSyncExternalStore(subscribe, () => (session ? views.get(session) ?? NONE : NONE), () => NONE);
  const chatd = useSyncExternalStore(subscribe, () => chatdState, () => "unknown" as const);
  const hello = useSyncExternalStore(subscribe, () => helloEvent, () => null);
  const need = (): ChatApi => { if (!api || !api.chatAvailable) throw new Error("chat unavailable"); return api; };
  const key = (): string => { if (!session) throw new Error("no session"); return session; };
  const ask = async (cmd: ChatCommand) => { await request(need(), cmd); };
  return {
    view, chatd, hello,
    open: async (input) => { const e = await request(need(), { cmd: "open", request_id: newId(), ...input }, 60000); return (e as ChatEventOf<"opened">).session; },
    send: async (text, images, mode) => { const message_id = newId(); await ask({ cmd: "send", session: key(), message_id, text, images, mode }); return message_id; },
    withdraw: (message_id) => ask({ cmd: "withdraw", session: key(), message_id }),
    interrupt: () => ask({ cmd: "interrupt", session: key() }),
    permission: (permission_id, decision, message) => ask({ cmd: "permission", session: key(), permission_id, decision, message }),
    answer: (permission_id, answers) => ask({ cmd: "answer", session: key(), permission_id, answers }),
    setModel: (model, effort) => ask({ cmd: "set_model", session: key(), model, effort }),
    setPermissionMode: (mode) => ask({ cmd: "set_permission_mode", session: key(), mode }),
    commands: () => ask({ cmd: "commands", session: key() }),
    replay: () => ask({ cmd: "replay", session: key() }),
    close: (reason) => ask({ cmd: "close", session: key(), reason }),
    hello_: () => ask({ cmd: "hello" }),
  };
}
