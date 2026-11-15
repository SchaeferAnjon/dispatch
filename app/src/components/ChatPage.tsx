import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { chatViewOf, newId, outboxAdd, outboxDrop, outboxFail, picturesOf, request, useChatSession, useOutbox, waitingOutgoing, type Outgoing } from "../chatStore";
import { PERMISSION_MODES, canSend, isBusy, splitKey, toolLabel, type Capability, type ChatAgent, type ChatApi, type ChatCommand, type ChatImage, type ChatView, type CloseReason, type Decision, type LiveTurn, type PermissionMode, type SendMode, type ToolChip as Chip, type TurnStep } from "../chatProtocol";
import type { Activity, Host, Issue, SessionDetail, TimelineMsg } from "../types";
import { t, useT } from "../i18n";
import { fmtTime } from "../derive";
import { tildePath } from "../activity";
import { relPath } from "../diff";
import { visibleTurns } from "../timeline";
import { linkedSessions } from "../projectModel";
import { SessionThread, ThinkLine, ToLatest, UserActionContext } from "./SessionThread";
import { CheckpointRestore } from "./CheckpointRestore";
import { checkpointApi, checkpointForMessage, type Checkpoint } from "../checkpoints";
import { Markdown, Linkified } from "./Markdown";
import { ToolChip, ToolGroup, chipSummary, fmtDuration, groupTools } from "./ChatToolChip";
import { PermissionCard } from "./PermissionCard";
import { ChatComposer, composerKey, planSend, type ComposerKey } from "./ChatComposer";
import type { MentionSession } from "./MentionPopover";
import { Icon } from "./icons";


// A session that runs inside Dispatch (design 图 13): the transcript up to the first turn chatd
// streamed, then the live turns drawn from chatd's events (text streaming with a caret, thinking
// as one line, tool chips, permission cards in the flow), and the chat box. The top line says
// where it runs and hands it to a terminal. When chatd does not know the session (after a restart
// it was not running) the page shows the transcript as a terminal session and offers to take it over.

/** The app's Api as the chat side sees it; null outside Dispatch IDE's webview (browser preview, phone). */
export function chatApiOf(api: Api | null | undefined): ChatApi | null {
  return api && api.chatAvailable ? api : null;
}

/** Every command a chat page sends, by session; each waits for chatd's reply (or its error). */
export function chatActions(chat: ChatApi, session: string) {
  const ask = async (cmd: ChatCommand) => { await request(chat, cmd); };
  return {
    send: async (text: string, images?: ChatImage[], mode?: SendMode, display?: string, message_id = newId()) => { await ask({ cmd: "send", session, message_id, text, images: images?.length ? images : undefined, mode, display: display && display !== text ? display : undefined }); return message_id; },
    interrupt: () => ask({ cmd: "interrupt", session }),
    withdraw: (message_id: string) => ask({ cmd: "withdraw", session, message_id }),
    permission: (permission_id: string, decision: Decision, message?: string) => ask({ cmd: "permission", session, permission_id, decision, message }),
    answer: (permission_id: string, answers: Record<string, string[]>) => ask({ cmd: "answer", session, permission_id, answers }),
    setModel: (model: string) => ask({ cmd: "set_model", session, model }),
    setPermissionMode: (mode: PermissionMode) => ask({ cmd: "set_permission_mode", session, mode }),
    commands: () => ask({ cmd: "commands", session }),
    replay: () => ask({ cmd: "replay", session }),
    close: (reason?: CloseReason) => ask({ cmd: "close", session, reason }),
    /** A line for the agent at the start of its next turn; the chat shows it as a system line now. */
    note: (text: string) => ask({ cmd: "note", session, text }),
  };
}
export type ChatActions = ReturnType<typeof chatActions>;

/** A key of the page (not typed into the box): esc stops or denies, ↵ / ⇧↵ answer a waiting card. */
export async function runKey(act: ChatActions, k: ComposerKey, view: ChatView, draft = ""): Promise<void> {
  if (!k) return;
  if (k === "interrupt") { await act.interrupt(); return; }
  if (k === "send") { const p = planSend(draft, view); if (p.kind === "send") await act.send(p.text, [], p.mode); return; }
  const card = view.pending[0];
  if (!card || (card.kind === "question" && k !== "deny")) return;  // a question is answered on its card
  await act.permission(card.permission_id, k);
}

/** A view chatd actually holds: a replay answered with no_such_session leaves an empty one behind. */
export function isLiveView(v: ChatView | null | undefined): v is ChatView {
  return !!v && !(v.error?.code === "no_such_session" && !v.agent && !v.turns.length);
}
/** The live chat key for a bare session id, when chatd streamed one this run (a new chat is not in the transcript index yet). */
export function liveKeyOf(sessionId: string): string | null {
  for (const a of ["claude-code", "codex"]) { const k = `${a}:${sessionId}`; if (isLiveView(chatViewOf(k))) return k; }
  return null;
}
/** What the agent can do in Dispatch when the view was rebuilt from `state` (no `opened` this run). */
const DEFAULT_CAPS: Record<ChatAgent, Capability[]> = {
  "claude-code": ["allow_session", "set_model", "set_permission_mode", "thinking_text", "images_base64", "queue", "commands"],
  codex: ["allow_session", "set_model", "set_permission_mode", "effort", "diff_events", "images_path", "thinking_text", "queue", "commands"],
  opencode: ["allow_session", "set_model", "effort", "thinking_text", "images_base64", "images_path", "queue", "commands"],
};
export const capsOf = (v: ChatView, agent: ChatAgent): Capability[] => (v.capabilities.length ? v.capabilities : DEFAULT_CAPS[agent]);
/** The transcript part before chatd's first live turn: the live turns draw the rest. */
export function historyBefore(messages: TimelineMsg[], view: ChatView | null): TimelineMsg[] {
  const first = view?.turns[0]?.started;
  if (!first) return messages;
  return messages.filter((m) => { const at = Date.parse(m.ts) / 1000; return !Number.isFinite(at) || at < first - 1; });
}
/** Accepts a message now: open, or stopped for idleness (chatd resumes it on the next send). */
export const acceptsSend = (v: ChatView | null) => !!v && (canSend(v) || (v.lifecycle === "stopped" && v.closed?.reason === "idle"));
/** Its process is gone (chatd shut down, restarted or crashed, or the agent exited) but the transcript
 *  is there: the next message opens it again in Dispatch (open with resume) and then sends. */
export const resumable = (v: ChatView | null) => !!v && !!v.closed && v.closed.reason !== "idle" && (v.lifecycle === "stopped" || v.lifecycle === "error");
/** open{resume} for a session chatd no longer holds, with the model and mode it had. */
export async function reopen(chat: ChatApi, session: string, cwd: string, view: ChatView | null): Promise<string> {
  const key = splitKey(session);
  if (!key) throw new Error(session);
  const mode = view?.permission_mode as PermissionMode | undefined;
  const e = await request(chat, { cmd: "open", request_id: newId(), agent: key.agent, cwd, resume: key.id, model: view?.model || undefined, permission_mode: mode && PERMISSION_MODES.includes(mode) ? mode : undefined }, 60000);
  return "session" in e && typeof e.session === "string" ? e.session : session;
}
/** Send, opening the session again first when its process is gone; a chatd that restarted and no
 *  longer knows the session (no_such_session) gets the same open-then-send. */
export async function sendOrResume(chat: ChatApi, act: ChatActions, session: string, cwd: string, text: string, images?: ChatImage[], mode?: SendMode, resume: (v: ChatView | null) => Promise<unknown> = (v) => reopen(chat, session, cwd, v), display?: string, message_id?: string): Promise<string> {
  const v = chatViewOf(session) ?? null;
  if (resumable(v)) await resume(v);
  try { return await act.send(text, images, mode, display, message_id); }
  catch (e) {
    if (chatViewOf(session)?.error?.code !== "no_such_session") throw e;
    await resume(chatViewOf(session) ?? null);
    return act.send(text, images, mode, display, message_id);
  }
}

const AGENT_NAME: Record<ChatAgent, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

/** A streaming reply cut into blocks that can no longer change: each ends at a blank line outside a
 *  code fence. Only the tail after the last cut is parsed again on the next delta; re-parsing the
 *  whole reply per delta made a long answer quadratic. Incremental: when `src` only grew, the scan
 *  continues where `prev` stopped. */
export interface StreamSplit { src: string; blocks: string[]; start: number; line: number; fence: string; content: boolean }
export function splitStream(src: string, prev?: StreamSplit): StreamSplit {
  let blocks: string[] = [], start = 0, line = 0, fence = "", content = false;
  // Deltas only append, so the ends of the previous text are enough to tell "grew" from "replaced".
  const grew = !!prev && src.length >= prev.src.length && src.startsWith(prev.src.slice(0, 64)) && src.startsWith(prev.src.slice(-256), Math.max(0, prev.src.length - 256));
  if (prev && grew) ({ blocks, start, line, fence, content } = prev);
  let copied = false;
  for (let nl = src.indexOf("\n", line); nl >= 0; nl = src.indexOf("\n", line)) {
    const text = src.slice(line, nl);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (f) { const c = f[1][0]; fence = !fence ? c : fence === c ? "" : fence; content = true; }
    else if (!text.trim()) {
      if (!fence && content) { if (!copied) { blocks = blocks.slice(); copied = true; } blocks.push(src.slice(start, nl + 1)); start = nl + 1; content = false; }
    } else content = true;
    line = nl + 1;
  }
  return { src, blocks, start, line, fence, content };
}
const StableMarkdown = memo(Markdown);
function StreamingMarkdown({ src, className }: { src: string; className?: string }) {
  const last = useRef<StreamSplit | undefined>(undefined);
  const split = useMemo(() => (last.current = splitStream(src, last.current)), [src]);
  return <>{split.blocks.map((b, i) => <StableMarkdown key={i} src={b} className={className} />)}<Markdown src={src.slice(split.start)} className={className} /></>;
}

/** Thinking as it streams: 「思考中…」 with the thought growing under it; then one line 「思考了 1.4s」. A thought with no text (summaries off) is not shown once done. */
function Thinking({ step }: { step: Extract<TurnStep, { kind: "thinking" }> }) {
  const t = useT();
  const text = step.text.trim();
  if (step.done && !text) return null;
  return <ThinkLine text={text} live={!step.done} label={step.done ? `${t("思考了")}${step.duration_ms ? ` ${fmtDuration(step.duration_ms)}` : ""}` : t("思考中…")} />;
}
/** The step a live turn is on: its tool calls so far, plus the one it is on now. */
export const turnStep = (turn: LiveTurn | undefined) => (turn ? turn.steps.filter((s) => s.kind === "tool").length + 1 : 1);
/** "3s", "48s", "2 分 5 秒": a timer that ticks once a second. */
export const fmtSecs = (s: number) => (s < 60 ? `${s}s` : t("{m} 分 {s} 秒", { m: Math.floor(s / 60), s: s % 60 }));
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The line at the end of the conversation while the agent works: what it is doing right now, in plain words
 *  (「第 2 步 · 正在跑 npm test」, 「在想」, 「在写」), and the call it is waiting on, if any. */
export function liveStatus(turn: LiveTurn | undefined, waitingCard: boolean, cwd?: string): { label: string; tool?: Chip } {
  const tools = turn ? turn.steps.filter((s): s is Extract<TurnStep, { kind: "tool" }> => s.kind === "tool") : [];
  if (waitingCard) return { label: t("等你确认 · 第 {n} 步", { n: Math.max(1, tools.length) }) };
  const last = turn?.steps[turn.steps.length - 1];
  const chip = last?.kind === "tool" ? turn!.tools[last.tool_id] : undefined;
  if (chip?.status === "running") {
    const arg = short(chipSummary(chip, cwd));
    const doing = chip.kind === "shell" ? t("正在跑 {x}", { x: arg }) : chip.kind === "read" ? t("正在读 {x}", { x: arg }) : chip.kind === "edit" ? t("正在改 {x}", { x: arg })
      : chip.kind === "search" ? t("正在搜 {x}", { x: arg }) : chip.kind === "web" ? t("正在查网页") : chip.kind === "agent" ? t("子 Agent 在干活") : t("正在用 {x}", { x: toolLabel(chip.name) });
    return { label: t("第 {n} 步 · {doing}", { n: tools.length, doing }), tool: chip };
  }
  if (last?.kind === "text" && !last.done) return { label: t("在写") };
  return { label: t("在想") };
}
/** 「在想 · 12s」: one line, the words shimmer, the seconds tick (DESIGN.md 动效: every wait moves). */
export function LiveLine({ label, secs, slow, children, spin = true }: { label: string; secs?: number; slow?: boolean; children?: ReactNode; spin?: boolean }) {
  const t = useT();
  // one indicator per wait (DESIGN.md 动效): while a tool row spins, this line only shimmers and counts
  return <div className="working live" role="status">{spin && <span className="spin" />}<span className="shimmer">{label}</span>{!!secs && <span className="secs">· {fmtSecs(secs)}</span>}{slow && <span className="slow">{t("这一步跑得比较久")}</span>}{children}</div>;
}
/** A message you sent that chatd has not taken yet: the bubble at once, then 正在启动 Agent / 在想, or 没发出去 + 重发. */
function OutgoingTurn({ o, onRetry, onDrop }: { o: Outgoing; onRetry: () => void; onDrop: () => void }) {
  const t = useT();
  return <div className={`turn you${o.state === "failed" ? " failed" : ""}`}>
    {o.pictures.length > 0 && <MsgPictures urls={o.pictures} />}
    <div className="bubble-row"><div className="bubble sel-text"><Linkified text={o.text} /></div></div>
    {o.state === "failed" && <div className="send-failed" role="alert"><span>{t("没发出去：{error}", { error: o.error || t("没说原因") })}</span><button type="button" className="lk" onClick={onRetry}>{t("重发")}</button><button type="button" className="lk quiet" onClick={onDrop}>{t("不发了")}</button></div>}
  </div>;
}
/** Your pictures over your bubble: 96px squares in a row, right-aligned. */
export function MsgPictures({ urls, count = 0 }: { urls: string[]; count?: number }) {
  const t = useT();
  if (!urls.length && !count) return null;
  return <div className="msg-pics">{urls.length ? urls.map((u, i) => <img key={i} src={u} alt={t("图片")} />) : Array.from({ length: Math.min(count, 8) }, (_, i) => <span key={i} className="ph" title={t("{n} 张图", { n: count })}><Icon name="screen" size={16} /></span>)}</div>;
}

interface TurnProps { turn: LiveTurn; view: ChatView; cwd?: string; act: ChatActions | null; onError: (m: string) => void; onCopy: (s: string) => void; onOpenFile: (p: string) => void; onUndo: (c: Chip, path: string) => void; onDecided: () => void; onRestore?: (turn: LiveTurn) => void; restoreBusy?: boolean }
/** 「回到这一轮之前」 on a user bubble: shown while hovering, off while that turn still runs. */
/** `busy`: an agent turn runs in this session (this one or a later one): files would change under it. */
export function RestoreButton({ busy, onClick }: { busy?: boolean; onClick: () => void }) {
  const t = useT();
  return <button type="button" className="lk cp-restore" disabled={busy} onClick={onClick} title={busy ? t("Agent 还在跑，做完这一轮才能回去") : t("把项目文件回到这一轮开始之前，先列出要动的文件")}><Icon name="undo" size={12} />{t("回到这一轮之前")}</button>;
}
function Turn({ turn, view, cwd, act, onError, onCopy, onOpenFile, onUndo, onDecided, onRestore, restoreBusy }: TurnProps) {
  const t = useT();
  const [deciding, setDeciding] = useState(false);
  const decide = async (id: string, d: Decision) => { if (!act) return; setDeciding(true); try { await act.permission(id, d); onDecided(); } catch (e) { onError(String(e)); } finally { setDeciding(false); } };
  const answer = async (id: string, a: Record<string, string[]>) => { if (!act) return; setDeciding(true); try { await act.answer(id, a); onDecided(); } catch (e) { onError(String(e)); } finally { setDeciding(false); } };
  const lastText = turn.steps.map((s, i) => (s.kind === "text" && s.text.trim() ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const running = !turn.status;
  // Consecutive tool steps make one `.calls` block; within it, finished calls of one kind in a row fold into one line.
  const out: ReactNode[] = [];
  let calls: Chip[] = [];
  const flush = (k: number) => {
    if (!calls.length) return;
    out.push(<div key={`c${k}`} className="calls">{groupTools(calls).map((g) => Array.isArray(g)
      ? <ToolGroup key={g[0].tool_id} chips={g} cwd={cwd} onCopy={onCopy} onOpenFile={onOpenFile} onUndo={onUndo} />
      : <ToolChip key={g.tool_id} chip={g} cwd={cwd} onCopy={onCopy} onOpenFile={onOpenFile} onUndo={onUndo} />)}</div>);
    calls = [];
  };
  turn.steps.forEach((s, i) => {
    if (s.kind === "tool") {
      const chip = turn.tools[s.tool_id];
      if (chip) calls.push(chip);
      return;
    }
    flush(i);
    if (s.kind === "text") {
      if (!s.text.trim()) return;
      const fin = i === lastText && (!running || !s.done || i === turn.steps.length - 1);
      out.push(<div key={i} className={fin ? "fin" : "mid"}>{!s.done && running ? <StreamingMarkdown src={s.text} className="compact" /> : <Markdown src={s.text} className="compact" />}</div>);
    } else if (s.kind === "thinking") out.push(<Thinking key={i} step={s} />);
    else if (s.kind === "permission") { const c = view.permissions[s.permission_id]; if (c) out.push(<PermissionCard key={s.permission_id} card={c} busy={deciding} onDecide={(d) => void decide(c.permission_id, d)} onAnswer={(a) => void answer(c.permission_id, a)} />); }
    else if (s.kind === "system") out.push(<div key={i} className="sys muted small">{t("系统事件")} · {s.text}</div>);
  });
  flush(turn.steps.length);
  const at = new Date(turn.started * 1000).toISOString();
  return <>
    {turn.user_text || turn.images_n ? <div className="turn you" title={fmtTime(at)}>
      {turn.images_n > 0 && <MsgPictures urls={picturesOf(turn.message_id)} count={turn.images_n} />}
      {turn.user_text && <div className="bubble-row">
        {turn.checkpoint && onRestore && <RestoreButton busy={running || restoreBusy} onClick={() => onRestore(turn)} />}
        <div className="bubble sel-text"><Linkified text={turn.user_text} /></div>
      </div>}
    </div> : null}
    <div className="turn bot">
      {out}
      {turn.status === "interrupted" && <div className="denied"><span className="sq" />{t("你打断了这一轮")}</div>}
      {turn.status === "error" && <div className="chat-error">{t("这一轮出错了：{err}", { err: turn.error || t("没说原因") })}</div>}
      {turn.status === "success" && turn.duration_ms !== undefined && <div className="turn-meta muted small">{[t("用时 {d}", { d: fmtDuration(turn.duration_ms) }), turn.cost_usd ? `$${turn.cost_usd.toFixed(3)}` : "", turn.files.length ? t("改了 {n} 个文件", { n: turn.files.length }) : ""].filter(Boolean).join(" · ")}</div>}
    </div>
  </>;
}

interface Props {
  api: Api;
  /** `<agent>:<id>` */
  session: string;
  detail?: SessionDetail | null;
  activity?: Activity;
  hosts: Host[];
  issues?: Issue[];
  sessions?: MentionSession[];
  /** 「接管到 Dispatch」 on a session chatd does not hold. */
  onHandover: () => void;
  onError?: (m: string) => void;
  /** Editor mode's 340 px column: a 32 px title row (short name, state, the drawer with 任务 / 改动 / 产物, ✕) instead of the run-in line, smaller padding. */
  compact?: boolean;
  /** compact: the session's short name for the title row. */
  title?: string;
  /** compact: ✕ in the title row (⌘L does the same in editor mode). */
  onClose?: () => void;
  /** compact: an Update chip or a file in the drawer opens that file in the editor (root-relative path). */
  onOpenFile?: (path: string, line?: number) => void;
  /** compact: text appended to the composer when `token` changes (⌘L with a selection: `@install-device.sh:4-7`). */
  insertText?: { text: string; token: number } | null;
}

/** 「在跑」「等你确认」…: the session's state in a few words. */
export function lifeLabelOf(view: ChatView | null): string {
  if (!view) return t("连接中");
  switch (view.lifecycle) {
    case "running": return t("在跑");
    case "waiting_permission": return t("等你确认");
    case "waiting_input": return t("等你回答");
    case "starting": return t("启动中");
    case "stopped": return t("已停");
    case "error": return t("出错了");
    default: return t("空闲");
  }
}
/** The files this session's live turns changed, merged by path (the drawer's 改动). */
export function changedFiles(view: ChatView | null): { path: string; add: number; del: number }[] {
  const m = new Map<string, { path: string; add: number; del: number }>();
  for (const turn of view?.turns ?? []) for (const f of turn.files) { const x = m.get(f.path) ?? { path: f.path, add: 0, del: 0 }; x.add += f.add; x.del += f.del; m.set(f.path, x); }
  return [...m.values()];
}
/** Append `text` to a React-controlled textarea the way typing would (its onChange runs). */
export function appendToTextarea(el: HTMLTextAreaElement | null, text: string) {
  if (!el || !text) return;
  const cur = el.value;
  const next = cur && !/\s$/.test(cur) ? `${cur} ${text}` : cur + text;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) setter.call(el, next); else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange?.(next.length, next.length);
}

export function ChatPage({ api, session, detail, activity, hosts, issues = [], sessions = [], onHandover, onError, compact = false, title, onClose, onOpenFile, insertText }: Props) {
  const t = useT();
  const chat = chatApiOf(api);
  const handle = useChatSession(chat, session);
  // The store's server snapshot is empty (tests, SSR): fall back to reading it directly.
  const raw = handle.view ?? chatViewOf(session) ?? null;
  const view = isLiveView(raw) ? raw : null;
  const key = splitKey(session);
  const agent: ChatAgent = key?.agent ?? "claude-code";
  const act = useMemo(() => (chat ? chatActions(chat, session) : null), [chat, session]);
  const [note, setNote] = useState("");
  // errors go to the app's toast (DESIGN.md: no red boxes in the page); without one they show as a line here
  const report = (m: string) => { if (onError) onError(m); else setNote(m); };
  const outbox = useOutbox(session);
  const outgoing = waitingOutgoing(outbox, view);
  const sendingOut = outgoing.some((o) => o.state === "sending");
  // After an app restart chatd may still hold the session: ask it to replay the current turn.
  const [detached, setDetached] = useState(false);
  useEffect(() => {
    if (!act || view) return;
    let alive = true;
    act.replay().catch(() => { if (alive) setDetached(true); });
    return () => { alive = false; };
  }, [act, session]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view) setDetached(false); }, [!!view]);  // eslint-disable-line react-hooks/exhaustive-deps
  const busy = !!view && isBusy(view);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const ticking = busy || sendingOut;
  useEffect(() => { if (!ticking) return; setNow(Date.now() / 1000); const tm = window.setInterval(() => setNow(Date.now() / 1000), 1000); return () => window.clearInterval(tm); }, [ticking]);
  const local = hosts.find((h) => h.local);
  const hostName = local?.name || t("本机");
  const cwd = view?.cwd || detail?.meta.cwd || activity?.cwd || "";
  const history = useMemo(() => visibleTurns(historyBefore(detail?.messages ?? [], view), { brief: false, showTools: false, showUser: true, showAssistant: true, running: false }), [detail?.messages, view?.turns[0]?.started]);  // eslint-disable-line react-hooks/exhaustive-deps
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const toLatest = () => { const el = scroller.current; follow.current = true; setAway(false); if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => { const el = scroller.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [view?.seq, history.length, detached, outgoing.length, now]);
  const focusBox = () => (document.querySelector(".chat-composer textarea") as HTMLTextAreaElement | null)?.focus();
  const viewForBox = view ? { ...view, capabilities: capsOf(view, agent) } : null;
  const pendingCard = view?.pending[0];
  const onPageKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (!view || !act || el.closest?.("textarea,input,select,button,a,summary")) return;
    const k = composerKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }, { busy, hasText: false, pending: !!pendingCard, question: pendingCard?.kind === "question" });
    if (!k) return;
    e.preventDefault();
    void runKey(act, k, view).then(() => { if (k === "deny") focusBox(); }).catch((x) => report(String(x)));
  };
  const lastTurn = view?.turns[view.turns.length - 1];
  const turnSecs = lastTurn && !lastTurn.status ? Math.max(0, Math.round(now - lastTurn.started)) : 0;
  const status = liveStatus(lastTurn && !lastTurn.status ? lastTurn : undefined, !!pendingCard, cwd);
  const lastOut = outgoing[outgoing.length - 1];
  const ended = resumable(view);
  const fatal = !!view && !ended && (view.lifecycle === "error" || !!view.error?.fatal);
  // After chatd went away (app restart, crash, idle reap by an older chatd) the session continues here:
  // open it again with resume, then send. A chatd that restarted meanwhile no longer knows an idle-stopped one either.
  const [resuming, setResuming] = useState(false);
  const resumeWith = async (v: ChatView | null) => {
    if (!chat) throw new Error(t("应用内聊天只在电脑上的 Dispatch 里可用"));
    setResuming(true); setNote("");
    try { await reopen(chat, session, cwd, v); }
    catch (e) { report(t("没接上：{err}", { err: String(e) })); throw e; }
    finally { setResuming(false); }
  };
  const resumeHere = () => (resuming ? Promise.resolve() : resumeWith(view));
  const sendResuming = (text: string, images?: ChatImage[], mode?: SendMode, display?: string, message_id?: string) => (chat && act ? sendOrResume(chat, act, session, cwd, text, images, mode, resumeWith, display, message_id) : Promise.reject(new Error(t("应用内聊天只在电脑上的 Dispatch 里可用"))));
  // Sent the moment you press it: the bubble goes into the conversation now and waits there for chatd's turn.
  // A queued message (the agent is busy) shows in the queue above the box instead.
  const sendNow = async (text: string, images: ChatImage[] = [], mode?: SendMode, display?: string, previews: string[] = []) => {
    if (mode === "queue") return sendResuming(text, images, mode, display);
    const message_id = newId();
    const pics = previews.length ? previews : images.flatMap((i) => (i.data ? [`data:${i.media_type || "image/png"};base64,${i.data}`] : []));
    outboxAdd({ session, message_id, text: display || text, pictures: pics, at: Date.now() / 1000, state: "sending", payload: { text, images, mode, display } });
    follow.current = true;
    try { await sendResuming(text, images, mode, display, message_id); }
    catch (e) { outboxFail(session, message_id, e instanceof Error ? e.message : String(e)); }
  };
  const retry = (o: Outgoing) => { outboxDrop(session, o.message_id); void sendNow(o.payload.text, o.payload.images, o.payload.mode, o.payload.display, o.pictures); };
  // Checkpoints: live turns carry theirs (turn_started); transcript turns are matched against the list.
  const [restoring, setRestoring] = useState<{ turn: string; text: string; undo?: boolean } | null>(null);
  // the last restore of this page, so its note can offer to undo it (restoring its rollback_from record)
  const [undoable, setUndoable] = useState<{ id: string; note: string } | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const doneTurns = view?.turns.filter((x) => x.status).length ?? 0;
  useEffect(() => {
    if (!chat || !cwd || !history.some((m) => m.role === "user")) return;
    let alive = true;
    checkpointApi(api, cwd).list(session).then((l) => { if (alive) setCheckpoints(l); }).catch(() => {});
    return () => { alive = false; };
  }, [chat, cwd, session, history.length, doneTurns, restoring]);  // eslint-disable-line react-hooks/exhaustive-deps
  const historyRestore = useMemo(() => (chat && checkpoints.length ? (text: string, ts: string) => {
    const at = Date.parse(ts) / 1000;
    const c = Number.isFinite(at) ? checkpointForMessage(checkpoints, text, at) : null;
    return c ? <RestoreButton busy={busy} onClick={() => setRestoring({ turn: c.turn_id, text: c.text })} /> : null;
  } : null), [chat, checkpoints, busy]);
  const restoreDialog = restoring && cwd ? <CheckpointRestore api={api} root={cwd} session={session} turn={restoring.turn} turnText={restoring.text} undo={restoring.undo} running={busy}
    onNote={act && view && !ended && !fatal ? (text) => act.note(text) : undefined}
    onDone={(m, rollback) => { setNote(m); setUndoable(!restoring.undo && rollback ? { id: rollback, note: m } : null); }} onClose={() => { setRestoring(null); focusBox(); }} /> : null;
  // Editor mode's column: the title row, the drawer, text put into the box from the editor.
  const rootEl = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { if (insertText?.text) appendToTextarea(rootEl.current?.querySelector<HTMLTextAreaElement>(".chat-composer textarea") ?? null, insertText.text); }, [insertText?.token]);  // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = (p: string) => { if (compact && onOpenFile) onOpenFile(relPath(p, cwd)); else void api.openPath(p).catch((e) => report(String(e))); };
  const sid = key?.id ?? session;
  const files = compact && drawer ? changedFiles(view) : [];
  const linked = compact && drawer ? issues.filter((i) => linkedSessions(i).includes(sid)) : [];
  const titleRow = compact ? <div className="ch">
    <span className={`dotc${busy ? "" : " off"}`} /><b title={cwd}>{title || t("会话")}</b><span className="life">· {detached ? t("在终端里跑") : lifeLabelOf(view)}</span>
    <span className="sp" />
    {detached && chat && (agent === "claude-code" || agent === "codex") && <button type="button" onClick={onHandover} title={t("接管到 Dispatch")} aria-label={t("接管到 Dispatch")}><Icon name="reply" /></button>}
    <button type="button" className={drawer ? "on" : ""} aria-pressed={drawer} onClick={() => setDrawer((d) => !d)} title={t("任务 / 改动 / 产物")} aria-label={t("任务 / 改动 / 产物")}><Icon name="tasks" /></button>
    {onClose && <button type="button" onClick={onClose} title={t("收起聊天（{mod}L）")} aria-label={t("收起聊天（{mod}L）")}><Icon name="x" /></button>}
  </div> : null;
  const drawerEl = compact && drawer ? <div className="cdrawer" role="region" aria-label={t("任务 / 改动 / 产物")}>
    <h4>{t("改动")}</h4>
    {files.length ? files.map((f) => <button key={f.path} type="button" className="cd-row" onClick={() => { setDrawer(false); onOpenFile?.(relPath(f.path, cwd)); }} title={f.path}><span className="p mono">{relPath(f.path, cwd)}</span><span className="add">+{f.add}</span><span className="del">−{f.del}</span></button>) : <p className="muted">{t("这一段还没改文件")}</p>}
    <h4>{t("任务")}</h4>
    {linked.length ? linked.map((i) => <div key={i.id} className="cd-row"><span className="p">{i.title}</span><span className="muted mono">{i.id}</span></div>) : <p className="muted">{t("没有关联的任务")}</p>}
    <h4>{t("产物")}</h4>
    {detail?.attachments?.length ? detail.attachments.map((a) => <button key={a.id} type="button" className="cd-row" onClick={() => onOpenFile?.(relPath(a.path, cwd))} title={a.path}><span className="p">{a.name}</span></button>) : <p className="muted">{t("还没有图片或文件")}</p>}
  </div> : null;

  if (detached || (!chat && !view)) {
    return <div ref={rootEl} className={`chat-page conv chat${compact ? " compact" : ""}`}>
      {titleRow ?? <div className="runin term"><div className="in"><span className="sq" /><b>{t("在终端里跑")}</b><span>·</span><span>{t("这里是记录；接管后在 Dispatch 里接着聊")}</span><span className="sp" />
        {chat && (agent === "claude-code" || agent === "codex") && <button type="button" className="btn" onClick={onHandover}>{t("接管到 Dispatch")}</button>}</div></div>}
      {drawerEl}
      <div className="turns"><div className="in">{history.length ? <SessionThread list={history} cwd={cwd} /> : <p className="muted">{t("还没有记录")}</p>}</div></div>
    </div>;
  }
  return (
    <div ref={rootEl} className={`chat-page conv chat${compact ? " compact" : ""}`} onKeyDown={onPageKey}>
      {titleRow}
      {drawerEl}
      <div className="turns" ref={scroller} tabIndex={-1} onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setAway(!follow.current); }}>
        <div className="in">
          {history.length > 0 && <UserActionContext.Provider value={historyRestore}><SessionThread list={history} cwd={cwd} /></UserActionContext.Provider>}
          {!view && <div className="now-line"><span className="pulse" />{t("正在连接应用内聊天…")}</div>}
          {view?.turns.map((turn) => <Turn key={turn.turn_id} turn={turn} view={view} cwd={cwd} act={act} onError={report}
            onCopy={(s) => void api.copy(s).then(() => setNote(t("已复制"))).catch((e) => report(String(e)))}
            onOpenFile={openFile}
            onUndo={(_c, path) => void act?.send(t("把 {path} 刚才那处改动改回去，只改回这一处。", { path: relPath(path, cwd) }), [], busy ? "queue" : undefined).catch((e) => report(String(e)))}
            onDecided={focusBox} restoreBusy={busy} onRestore={chat && cwd ? (x) => x.checkpoint && setRestoring({ turn: x.checkpoint, text: x.user_text }) : undefined} />)}
          {outgoing.map((o) => <OutgoingTurn key={o.message_id} o={o} onRetry={() => retry(o)} onDrop={() => outboxDrop(session, o.message_id)} />)}
          {lastOut?.state === "sending" ? <LiveLine label={!view || resuming || view.lifecycle === "starting" || view.lifecycle === "stopped" || view.lifecycle === "error" ? t("正在启动 Agent") : t("在想")} secs={Math.max(0, Math.round(now - lastOut.at))} />
            : view && busy ? <LiveLine label={status.label} secs={turnSecs} spin={!status.tool} slow={!!status.tool && now - status.tool.started > 30}>{view.queue.length > 0 && <span className="secs">· {t("排队 {n} 条", { n: view.queue.length })}</span>}</LiveLine> : null}
          {view?.lifecycle === "starting" && !outgoing.length && <div className="now-line"><span className="pulse" />{t("正在启动 {agent} · {host} · {cwd}", { agent: AGENT_NAME[agent], host: hostName, cwd: tildePath(cwd) })}</div>}
          {view?.closed?.reason === "idle" && !outgoing.length && <div className="denied"><span className="sq" />{t("空闲太久，Dispatch 先停了进程；发一句会自动接上")}</div>}
          {handle.chatd === "down" && <div className="chat-error" role="alert">{t("应用内聊天的后台进程停了，正在重启")}{chat && <button type="button" className="lk" onClick={() => void chat.chatRestart().catch((e) => report(String(e)))}>{t("现在重启")}</button>}</div>}
          {view?.error && !fatal && !outgoing.some((o) => o.state === "failed") && <div className="chat-note" role="status">{view.error.message}</div>}
          {fatal && <div className="chat-error" role="alert">{view?.error?.message || t("应用内聊天出错了")}</div>}
          {ended && <div className="chat-note resume" role="status">{t("Agent 进程停了；发一句会在 Dispatch 里接着这段会话")}{view?.error?.message ? <span className="muted"> · {view.error.message}</span> : null}
            {chat && <button type="button" className="btn sm primary" disabled={resuming} onClick={() => void resumeHere().catch(() => {})}>{resuming ? t("正在接上…") : t("在 Dispatch 里接着聊")}</button>}</div>}
          {note && <div className="chat-note" role="status">{note}
            {undoable?.note === note && cwd && <button type="button" className="lk" disabled={busy} title={busy ? t("Agent 还在跑，做完这一轮才能回去") : undefined} onClick={() => { const id = undoable.id; setNote(""); setUndoable(null); setRestoring({ turn: id, text: "", undo: true }); }}>{t("撤销这次回退")}</button>}
            <button type="button" className="lk" onClick={() => { setNote(""); setUndoable(null); }}>{t("好")}</button></div>}
        </div>
        <ToLatest show={away} onClick={toLatest} />
      </div>
      <ChatComposer api={api} session={session} view={viewForBox} agent={agent} host="local" hostName={hostName} cwd={cwd} issues={issues} sessions={sessions} project={detail?.meta.project_override || detail?.meta.project || activity?.project}
        enabled={acceptsSend(view) || (ended && !!chat && !resuming)}
        onError={onError}
        actions={act && view ? {
          send: (text, images, mode, display, previews) => sendNow(text, images, mode, display, previews),
          interrupt: act.interrupt, withdraw: act.withdraw, setModel: act.setModel, setPermissionMode: act.setPermissionMode, commands: act.commands,
          decide: (d) => { if (pendingCard && (pendingCard.kind !== "question" || d === "deny")) void act.permission(pendingCard.permission_id, d).then(() => { if (d === "deny") focusBox(); }).catch((e) => report(String(e))); },
        } : null} />
      {restoreDialog}
    </div>
  );
}
