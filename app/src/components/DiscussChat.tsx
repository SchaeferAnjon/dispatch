import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, createMessageQueue, useAuiState, useExternalStoreRuntime, useSmooth, type AppendMessage, type AttachmentAdapter, type MessageStatus, type TextMessagePartProps, type ThreadMessageLike } from "@assistant-ui/react";
import type { Api } from "../api";
import { actorOf, relTime } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KIND_ACTOR } from "./Delegate";
import type { Discussion } from "./Discuss";

// The group chat drawn with assistant-ui. useDiscussion still owns the data (the 【讨论】
// comments, the typing bubbles from discussions/<task>.live.json, the person's line); this file
// maps it onto an external-store runtime — every statement, bubble and system line becomes one
// Thread message, with who said it in metadata.custom — and renders the Thread and Composer
// primitives with the same look (classes) the hand-written thread had.
type Custom =
  | { kind: "opener"; text: string }
  | { kind: "round"; n: number }
  | { kind: "empty" }
  | { kind: "say"; actor: string; name: string; leader: boolean; when: string; persona?: string; model?: string }
  | { kind: "live"; actor: string; name: string; leader: boolean; status: string; persona?: string; model?: string }
  | { kind: "note" | "system" | "hint"; text: string };
type Msg = ThreadMessageLike & { readonly metadata: { readonly custom: Custom } };

const RUNNING: MessageStatus = { type: "running" };
const DONE: MessageStatus = { type: "complete", reason: "stop" };
const text = (t: string) => [{ type: "text" as const, text: t }];
const sys = (id: string, custom: Custom, t = ""): Msg => ({ id, role: "system", content: text(t), metadata: { custom } });
// The model a member spoke as, from the signature the CLI writes (`codex（gpt-5.5）：…`).
const modelOf = (who: string) => /（([^）]+)）/.exec(who)?.[1];

// The thread as assistant-ui messages, in the order the thread shows them.
function toMessages(d: Discussion, me: string, personas: Record<string, string>): Msg[] {
  const { thread, roundsSeen, bubbles, skippedNow, erroredNow, system, running, waiting, live, queued, quiet } = d;
  const out: Msg[] = [];
  const opener = thread.find((t) => t.opener);
  if (opener) out.push(sys(`opener:${opener.c.id}`, { kind: "opener", text: opener.body }));
  if (thread.length === 0) out.push(sys("empty", { kind: "empty" }));
  for (let r = 1; r <= roundsSeen; r++) {
    const lines = thread.filter((t) => t.round === r && !t.opener);
    if (roundsSeen > 1 && lines.length) out.push(sys(`round:${r}`, { kind: "round", n: r }));
    for (const { c, body, mine } of lines) {
      const a = mine ? actorOf(me, me) : actorOf(c.author, me);
      const who = (/^([^：:\n]{1,24})[：:]/.exec(body)?.[1] ?? "").trim();
      const said = body.replace(/^[^：:\n]{1,24}[：:]\s*/, "");
      const kind = Object.entries(KIND_ACTOR).find(([, id]) => id === a?.id)?.[0];
      out.push({ id: c.id, role: mine ? "user" : "assistant", createdAt: new Date(c.created_at), status: mine ? undefined : DONE, content: text(said), metadata: { custom: { kind: "say", actor: a?.id ?? c.author, name: mine ? "你" : a?.name ?? c.author, leader: !mine && d.isLeaderLine(c, body), when: c.created_at, persona: kind ? personas[kind] : undefined, model: modelOf(who) } } });
    }
  }
  if (skippedNow.length) out.push(sys("skipped", { kind: "note", text: `${skippedNow.join("、")} 这轮没话说` }));
  for (const [who, m] of erroredNow) out.push(sys(`err:${who}`, { kind: "system", text: `${who}：${m.text || "没说上话"}` }));
  for (const c of system) out.push(sys(c.id, { kind: "system", text: c.text.trimStart().slice(4) }));
  if (!running && quiet >= 2) out.push(sys("quiet", { kind: "hint", text: `连续 ${quiet} 轮没有新提议了——可以「整理成文档」收尾，或者你再说一句把话题推进一步。` }));
  if (running && waiting > 0 && bubbles.length === 0) out.push(sys("waiting", { kind: "hint", text: live ? `${queued} 个成员排队中…` : "正在起会话……" }));
  // The bubbles last, so the thread's tail is an assistant message while a round runs and
  // assistant-ui does not add a placeholder of its own.
  for (const [who, m] of bubbles) {
    const a = actorOf(KIND_ACTOR[m.kind] ?? m.kind, me);
    out.push({ id: `live:${who}`, role: "assistant", status: m.status === "typing" || m.status === "thinking" ? RUNNING : DONE, content: text(m.text), metadata: { custom: { kind: "live", actor: a?.id ?? who, name: a?.name ?? who, leader: d.isLeaderLive(who), status: m.status, persona: personas[m.kind], model: modelOf(who) } } });
  }
  return out;
}

const useCustom = () => useAuiState((s) => (s.message.metadata.custom ?? {}) as Partial<Custom>);

// Text parts: Markdown, smoothed while streaming so a chunk that arrives per poll still shows
// up character by character, with a caret at the end while the member is typing.
function Text(p: TextMessagePartProps) {
  const { text: t, status } = useSmooth(p, true);
  return <Markdown src={t + (status.type === "running" ? " ▍" : "")} className="compact" />;
}
const PARTS = { Text };

function Bubble({ live }: { live?: boolean }) {
  const c = useCustom();
  const status = useAuiState((s) => s.message.status?.type);
  if (c.kind !== "say" && c.kind !== "live") return null;
  const a = actorOf(c.actor ?? "", "");
  const mine = c.kind === "say" && c.name === "你";
  const state = c.kind === "live" ? (c.status === "thinking" ? "正在想" : c.status === "typing" ? "正在输入" : "写好了") : relTime(c.kind === "say" ? c.when ?? "" : "");
  const persona = [c.model, c.persona].filter(Boolean).join(" · ");
  const empty = useAuiState((s) => !s.message.content.some((x) => x.type === "text" && x.text));
  return (
    <MessagePrimitive.Root className={`disc-say${mine ? " mine" : ""}${live ? " disc-live" : ""}`}>
      <Avatar actor={mine ? actorOf(c.actor ?? "", c.actor ?? "") : a} size={28} />
      <div className="disc-bubble" title={persona || undefined}>
        <div className="l1"><b>{c.name}</b>{c.leader && <span className="chip disc-leader-tag">领队</span>}{!mine && persona && <span className="muted small disc-persona">{persona}</span>}<span className="muted small">{state}</span></div>
        {live && empty && status === "running" ? <span className="disc-dots"><i /><i /><i /></span> : <MessagePrimitive.Parts components={PARTS} />}
      </div>
    </MessagePrimitive.Root>
  );
}
const UserMessage = () => <Bubble />;
function AssistantMessage() {
  const c = useCustom();
  const optimistic = useAuiState((s) => !!s.message.metadata.isOptimistic);
  if (optimistic) return null;
  return <Bubble live={c.kind === "live"} />;
}
function SystemMessage() {
  const c = useCustom();
  const running = useAuiState((s) => s.thread.isRunning);
  switch (c.kind) {
    case "opener": return <div className="disc-opener muted small">{c.text}</div>;
    case "round": return <div className="disc-round-h muted small">第 {c.n} 轮</div>;
    case "empty": return <div className="empty small">{running ? "Agent 正在读上下文……第一条发言通常十几秒后出现" : "还没有发言"}</div>;
    case "note": return <div className="disc-opener muted small">{c.text}</div>;
    case "system": return <div className="disc-system small">{c.text}</div>;
    case "hint": return <div className="disc-waiting muted small">{c.text}</div>;
    default: return null;
  }
}
const MESSAGES = { UserMessage, AssistantMessage, SystemMessage };

function Attachments() {
  const any = useAuiState((s) => s.composer.attachments.length > 0);
  return any ? <div className="disc-images"><ComposerPrimitive.Attachments components={{ Attachment }} /></div> : null;
}
function Attachment() {
  const src = useAuiState((s) => { const a = s.attachment; const part = a.content?.find((p) => p.type === "image"); return part?.type === "image" ? part.image : ""; });
  return <AttachmentPrimitive.Root className="disc-img">{src ? <img src={src} alt="" /> : null}<AttachmentPrimitive.Remove className="x" aria-label="移除">✕</AttachmentPrimitive.Remove></AttachmentPrimitive.Root>;
}

interface Props { api: Api; d: Discussion; me: string; showConclusion?: boolean; compact?: boolean; between?: ReactNode; onError: (m: string) => void }

// The thread and, under it, the box where the person says a line (pictures pasted or picked;
// Enter sends, Shift+Enter breaks the line). A line sent while the members talk is posted right
// away and answered once the round ends — the runtime's queue lane lets the composer send then.
export function DiscussChat({ api, d, me, showConclusion, compact, between, onError }: Props) {
  const dRef = useRef(d); dRef.current = d;
  const [personas, setPersonas] = useState<Record<string, string>>({});
  useEffect(() => { let alive = true; (async () => { try { const t = await api.on("local", ["settings", "--json"]); const s = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))); const p: Record<string, string> = {}; for (const [k, v] of Object.entries(s)) if (k.startsWith("discuss_persona_") && typeof v === "string" && v.trim()) p[k.slice(16)] = v.trim(); if (alive) setPersonas(p); } catch { /* no personas shown */ } })(); return () => { alive = false; }; }, [api]);
  const messages = useMemo(() => toMessages(d, me, personas), [d, me, personas]);

  // Pictures are stored on this machine as they are added (the members read them by path);
  // the attachment's id is that path, which is what the person's line carries.
  const attachments = useMemo<AttachmentAdapter>(() => ({
    accept: "image/*",
    add: async ({ file }) => { const im = await dRef.current.saveImage(file, "reply"); return { id: im.path, type: "image", name: file.name || "粘贴的图片", contentType: file.type, file, status: { type: "requires-action", reason: "composer-send" }, content: [{ type: "image", image: im.preview }] }; },
    remove: async () => {},
    send: async (a) => ({ ...a, status: { type: "complete" }, content: a.content ?? [] }),
  }), []);
  const say = async (m: AppendMessage) => {
    const line = m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const images = (m.attachments ?? []).map((a) => ({ path: a.id, preview: "" }));
    await dRef.current.say(line, images);
  };
  const queue = useMemo(() => createMessageQueue({ run: (m) => { void say(m).catch((e) => onError(String(e))).finally(() => queue.notifyIdle()); } }), []);  // eslint-disable-line react-hooks/exhaustive-deps
  const runtime = useExternalStoreRuntime<Msg>({ messages, isRunning: d.running, isDisabled: d.saying, convertMessage: (m) => m, onNew: say, queue: queue.adapter, adapters: { attachments } });
  const conclusion = showConclusion ? d.conclusion : null;
  // The first load lands after the viewport measured an empty thread (and the dialog is still
  // animating in), so the built-in initial scroll can stop short: jump to the end ourselves
  // once the comments are in, on the next frames.
  const viewportRef = useRef<HTMLDivElement>(null);
  const loaded = d.comments.length > 0;
  useEffect(() => { if (!loaded) return; let n = 0; let raf = 0; const tick = () => { const el = viewportRef.current; if (el) el.scrollTop = el.scrollHeight; if (++n < 12) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf); }, [loaded, d.issue?.id]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Viewport ref={viewportRef} className={`disc-thread${compact ? " compact" : ""}`} autoScroll>
        {conclusion && <div className="disc-conclusion"><div className="l1"><b>结论</b><span className="muted small">{conclusion.when.includes("T") ? relTime(conclusion.when) : conclusion.when}{conclusion.by ? ` · ${conclusion.by}` : ""}</span></div><Markdown src={conclusion.text} className="compact" /></div>}
        <ThreadPrimitive.Messages components={MESSAGES} />
        <ThreadPrimitive.ScrollToBottom className="btn sm disc-to-bottom" title="到最新">↓ 最新</ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      {between}
      <ComposerPrimitive.Root className="disc-compose-wrap">
        <Attachments />
        <div className="disc-compose">
          <ComposerPrimitive.Input minRows={2} maxRows={8} placeholder={d.running ? "你也说一句（回车发言）；他们正在说，你的话会在这轮结束后得到回应" : "你也说一句（回车发言，Shift+回车换行；截图直接粘贴），他们会接着回应"} />
          <ComposerPrimitive.AddAttachment multiple className="btn sm disc-img-add" title="附图">🖼</ComposerPrimitive.AddAttachment>
          <ComposerPrimitive.Send className="btn sm">{d.saying ? "发送中…" : "发言"}</ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
