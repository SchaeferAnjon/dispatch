import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, makeAssistantToolUI, useAuiState, useExternalStoreRuntime, type MessageStatus, type ReasoningMessagePartProps, type TextMessagePartProps, type ThreadMessageLike, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { fmtTime } from "../derive";
import { blocksOf, foldLabel } from "../timeline";
import { diffOfTool, diffRows, relPath, diffStat } from "../diff";
import { toolKind, toolLabel } from "../chatProtocol";
import type { Block, TimelineMsg } from "../types";
import { ImageGrid } from "./Media";
import { Markdown, Linkified } from "./Markdown";
import { DiffTable } from "./Diff";
import { t, useT, useLocale } from "../i18n";
import { ToolHead } from "./ChatToolChip";
import { Icon } from "./icons";

// The conversation drawn with assistant-ui, the way design/conversation-cursor lays it out: your
// message a small bubble on the right; an assistant turn's steps as its parts, with no name line:
// thinking as one folded gray line, each tool call as one quiet line that opens in place, the text
// as Markdown. While the session runs the last line says the agent is working and at which step.
// The list arrives already filtered (see timeline.ts); this file only draws it.

type ToolBlock = Extract<Block, { type: "tool_call" }>;
type Custom =
  | { kind: "turn"; role: "user" | "assistant" | "tool"; ts: string; queued?: boolean; images?: string[]; tools: Record<string, ToolBlock>; folds: Record<string, ToolBlock[]> }
  | { kind: "system"; text: string; images?: string[] }
  | { kind: "gap"; text: string }
  | { kind: "working"; step: number };
type Msg = ThreadMessageLike & { readonly metadata: { readonly custom: Custom } };

const FOLD = "__fold";
const RUNNING: MessageStatus = { type: "running" };
const DONE: MessageStatus = { type: "complete", reason: "stop" };
const HALTED: MessageStatus = { type: "incomplete", reason: "cancelled" };

/** The step the agent is on: the calls it made since your last message, plus the one it is on now. */
export function stepOf(list: TimelineMsg[]): number {
  let n = 1;
  for (let i = list.length - 1; i >= 0 && !(list[i].role === "user" && !list[i].synthetic); i--) {
    if (list[i].role !== "assistant") continue;
    for (const b of blocksOf(list[i])) n += b.type === "tool_call" ? 1 : b.type === "tool_fold" ? b.tools.length : 0;
  }
  return n;
}

// Every turn becomes one message; the assistant's own status decides whether its last step is
// "still going" (running: the shimmer, the spinner) or settled.
function toMessages(list: TimelineMsg[], running: boolean): Msg[] {
  const out: Msg[] = [];
  list.forEach((x, i) => {
    const id = `${i}:${x.ts}`;
    if (x.role === "gap") { out.push({ id, role: "system", content: [{ type: "text", text: x.text || "…" }], metadata: { custom: { kind: "gap", text: x.text } } }); return; }
    if (x.synthetic) { out.push({ id, role: "system", content: [{ type: "text", text: x.text || "…" }], metadata: { custom: { kind: "system", text: x.text, images: x.images } } }); return; }
    // Claude Code's own mark for an Esc: a quiet line, not something you said.
    if (x.role === "user" && /^\[Request interrupted by user[^\]]*\]$/.test((x.text || "").trim())) { out.push({ id, role: "system", content: [{ type: "text", text: "…" }], metadata: { custom: { kind: "gap", text: t("你打断了这一轮") } } }); return; }
    if (x.role === "user" || x.role === "tool") {
      out.push({ id, role: "user", content: [{ type: "text", text: x.text || (x.images?.length ? "[图片]" : "…") }], metadata: { custom: { kind: "turn", role: x.role, ts: x.ts, queued: x.queued, images: x.images, tools: {}, folds: {} } } });
      return;
    }
    const blocks = blocksOf(x);
    const isLast = i === list.length - 1;
    const tools: Record<string, ToolBlock> = {};
    const folds: Record<string, ToolBlock[]> = {};
    type Part = Exclude<Msg["content"], string>[number];
    const content: Part[] = [];
    blocks.forEach((b, j) => {
      if (b.type === "text") { if (b.text.trim()) content.push({ type: "text", text: b.text }); return; }
      if (b.type === "tool_fold") { const key = `${id}:fold:${j}`; folds[key] = b.tools; content.push({ type: "tool-call", toolCallId: key, toolName: FOLD, args: {} as Record<string, never>, result: "" }); return; }
      // A thinking block with nothing readable (signature only, redacted) says nothing: skip it.
      if (b.type === "thinking") { if (b.text.trim()) content.push({ type: "reasoning", text: b.text }); return; }
      const key = b.id || `${id}:${j}`;
      tools[key] = b;
      // assistant-ui treats a tool call without a result as still running (it inherits the message
      // status), so a settled call always carries one — the card reads the block for the truth.
      content.push({ type: "tool-call", toolCallId: key, toolName: b.name, args: (b.input ?? {}) as Record<string, never>, result: b.status === "running" && running && isLast ? undefined : (b.result ?? ""), isError: b.status === "error" });
    });
    if (!content.length) return;
    const unfinished = blocks.some((b) => b.type === "tool_call" && b.status === "running");
    const status = running && isLast ? RUNNING : unfinished ? HALTED : DONE;
    out.push({ id, role: "assistant", status, content, metadata: { custom: { kind: "turn", role: "assistant", ts: x.ts, images: x.images, tools, folds } } });
  });
  // While the session runs the last line says so, with the step it is on.
  if (running) out.push({ id: "working", role: "system", content: [{ type: "text", text: "…" }], metadata: { custom: { kind: "working", step: stepOf(list) } } });
  return out;
}

const useCustom = () => useAuiState((s) => s.message.metadata.custom as Custom);
// The session's working directory, so an Edit/Write card can show a path relative to it
// ("Update(app/cli/move.py)" instead of the full absolute path).
const CwdContext = createContext<string | undefined>(undefined);

// Text: Markdown. No caret while it streams: the text growing is the motion, the line at the end says it is still going.
// No typewriter smoothing any more: the library's smoothing hook writes to a per-part status
// store from an effect, and when React 19 discards and redoes a render that store can belong to a
// fiber that never mounted — it then throws "Resource updated before mount" and the page shows the
// red error strip (2026-09-12). Transcripts arrive per poll anyway, so the animation bought little.
function Text(p: TextMessagePartProps) {
  return <div className="tl-t"><Markdown src={p.text} className="compact" /></div>;
}

/** Thinking as one gray line: 「思考了」 and its first line; open it for the whole thought, indented under a rule.
 *  While it streams the thought is open under a plain 「思考中…」: the line at the end of the conversation carries the shimmer. */
export function ThinkLine({ text, label, live }: { text: string; label: ReactNode; live?: boolean }) {
  const first = text.split("\n").map((x) => x.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return (
    <details className={`think${live ? " live" : ""}`} open={live || undefined}>
      <summary><span className="ci"><Icon name="think" size={14} /></span><span className="lbl">{label}</span>{!live && first && <span className="peek">{first}</span>}<span className="chev">›</span></summary>
      <div className="think-raw sel-text"><Markdown src={text} className="compact" /></div>
    </details>
  );
}
function Reasoning(p: ReasoningMessagePartProps) {
  const t = useT();
  // Transcripts write a thinking block once it is finished: it is only live while it is the newest step.
  const live = p.status.type === "running";
  return <ThinkLine text={(p.text || "").trim()} label={live ? t("思考中…") : t("思考了")} live={live} />;
}

const ARG_ORDER = ["command", "cmd", "file_path", "filePath", "path", "pattern", "url", "prompt", "description", "query", "old_string", "new_string"];
const argEntries = (input: Record<string, unknown>) => Object.entries(input).sort(([a], [b]) => (ARG_ORDER.indexOf(a) + 1 || 99) - (ARG_ORDER.indexOf(b) + 1 || 99));

// A tool call as one line (ToolHead): the tool, the argument that identifies it, a gray measure;
// open it for every argument and the result. An Edit/Write/MultiEdit/apply_patch call reads
// "Update path +N −M" and opens to a real diff, the same rendering as the 文件 tab uses.
function CardView({ name, status, summary, input, result, ts }: { name: string; status: ToolBlock["status"]; summary: string; input: Record<string, unknown>; result: string; ts?: string }) {
  const t = useT();
  const [tick, setTick] = useState(0);
  useEffect(() => { if (status !== "running" || !ts) return; const t = window.setInterval(() => setTick((n) => n + 1), 1000); return () => window.clearInterval(t); }, [status, ts]);
  const secs = status === "running" && ts ? Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000)) : 0;
  void tick;
  const cwd = useContext(CwdContext);
  const diff = useMemo(() => diffOfTool(name, input), [name, input]);
  const blocks = useMemo(() => (diff ? diffRows(diff) : null), [diff]);
  const stat = useMemo(() => blocks?.reduce((s, b) => { const d = diffStat(b.rows); return { add: s.add + d.add, del: s.del + d.del }; }, { add: 0, del: 0 }), [blocks]);
  const path = diff ? relPath(diff.path, cwd) || "?" : "";
  // A read's size, the way Cursor says 「11 lines」.
  const lines = !diff && toolKind(name) === "read" && status === "done" && result.trim() ? result.replace(/\n+$/, "").split("\n").length : 0;
  // Like the terminal, a small change is shown opened; a big one stays one line until tapped.
  const [open, setOpen] = useState(() => !!blocks && blocks.reduce((n, b) => n + b.rows.length, 0) <= 40);
  return (
    <details className={`tool-card ${status}${diff ? " edit-card" : ""}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary title={diff ? diff.path : summary || undefined}>
        <ToolHead kind={diff ? "edit" : toolKind(name)} verb={diff ? (diff.kind === "write" ? "Write" : "Update") : toolLabel(name)} arg={diff ? path : summary} state={status === "incomplete" ? "none" : status} meta={<span className="meta">
          {status === "running" ? (secs > 2 ? `${secs}s` : null) : <>
            {stat && (stat.add > 0 || stat.del > 0) && <span className="ds"><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></span>}
            {diff?.truncated && <span title={t("改动超出展示上限，只截了前面一部分")}>{t("已截断")}</span>}
            {lines > 0 && <span>{t("{n} 行", { n: lines })}</span>}
            {status === "incomplete" && <span>{t("没等到结果")}</span>}
          </>}
        </span>} />
      </summary>
      <div className="tool-body">
        {blocks
          ? blocks.map((b, i) => <div key={i} className="hunk">{b.label && <div className="hunk-h muted small">{b.label}</div>}<DiffTable rows={b.rows} /></div>)
          : Object.keys(input).length > 0 && <dl className="tool-args">{argEntries(input).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="sel-text">{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}</dl>}
        {result && (!diff || status === "error") ? <pre className={`tool-result${status === "error" ? " err" : ""}`}>{result}</pre> : !diff && status === "done" ? <div className="muted small">{t("（没有输出）")}</div> : null}
      </div>
    </details>
  );
}
// The block from the CLI is the source of truth for the status (assistant-ui only knows "has a result or not").
function ToolCard(p: ToolCallMessagePartProps) {
  const c = useCustom();
  const b = c.kind === "turn" ? c.tools[p.toolCallId] : undefined;
  // A call the transcript never answered only spins while the session itself is running.
  const status: ToolBlock["status"] = b ? (b.status === "running" && p.status.type !== "running" ? "incomplete" : b.status) : p.status.type === "running" ? "running" : p.isError ? "error" : "done";
  const summary = b?.summary || (toolKind(p.toolName) === "shell" ? String(p.args?.command ?? p.args?.cmd ?? "") : "");
  const input = (b?.input ?? p.args ?? {}) as Record<string, unknown>;
  const result = b?.result ?? (typeof p.result === "string" ? p.result : "");
  return <CardView name={p.toolName} status={status} summary={summary} input={input} result={result} ts={b?.ts} />;
}
// A run of finished calls as one line — "跑了 6 条命令 ›" — with the cards inside when opened.
function FoldRow(p: ToolCallMessagePartProps) {
  const c = useCustom();
  const tools = c.kind === "turn" ? c.folds[p.toolCallId] ?? [] : [];
  if (!tools.length) return null;
  return (
    <details className="tool-fold">
      <summary><span className="ci"><Icon name="bolt" size={14} /></span><span className="fold-label">{foldLabel(tools)}</span><span className="sp" /><span className="st">{tools.some((x) => x.status === "error") ? <Icon name="x" size={14} className="bad" /> : <Icon name="check" size={14} className="ok" />}</span></summary>
      <div className="fold-body">{tools.map((t, i) => <CardView key={t.id || i} name={t.name} status={t.status} summary={t.summary} input={t.input ?? {}} result={t.result ?? ""} ts={t.ts} />)}</div>
    </details>
  );
}
const FoldToolUI = makeAssistantToolUI({ toolName: FOLD, render: FoldRow });

// assistant-ui adds an empty slot after a running message whose last part is a tool call: the working line says it all.
const Empty = () => null;
const PARTS = { Text, Reasoning, Empty, tools: { Fallback: ToolCard } };

/** 回到最新: a 36px round button at the bottom of the scrolled conversation, only while you are not at the end
 *  (DESIGN.md 5D). Put it last inside the scroller: it sticks 16 above the scroller's bottom edge. */
export function ToLatest({ show, unread, onClick }: { show: boolean; unread?: boolean; onClick: () => void }) {
  const t = useT();
  return <div className="to-latest-dock"><button type="button" className={`to-latest${show ? " on" : ""}`} tabIndex={show ? 0 : -1} aria-hidden={!show} onClick={onClick} title={unread ? t("有未读回复") : t("回到最新")} aria-label={t("回到最新")}><Icon name="down" size={16} />{unread && <span className="dot" />}</button></div>;
}

/** 「在干活 · 第 3 步」: the last line while the agent works (live chats add the time and esc). */
export function WorkingLine({ step, children, wait }: { step: number; children?: ReactNode; wait?: boolean }) {
  const t = useT();
  return <div className={`working${wait ? " wait" : ""}`}><span className="spin" /><span className="shimmer">{wait ? t("等你确认") : t("在干活")}</span><span className="muted">· {t("第 {n} 步", { n: step })}</span>{children}</div>;
}

function Turn() {
  const t = useT();
  const c = useCustom();
  if (c.kind !== "turn") return null;
  if (c.role === "assistant") return <MessagePrimitive.Root className="tl assistant"><MessagePrimitive.Parts components={PARTS} /></MessagePrimitive.Root>;
  // A tool's picture (the agent looked at an image): the picture and a gray caption, on the agent's side.
  if (c.role === "tool") return <MessagePrimitive.Root className="tl tool">{c.images && c.images.length > 0 && <ImageGrid ids={c.images} />}<UserText /></MessagePrimitive.Root>;
  return (
    <MessagePrimitive.Root className="tl user" title={c.ts ? fmtTime(c.ts) : undefined}>
      {c.images && c.images.length > 0 && <ImageGrid ids={c.images} />}
      <div className="bubble-row"><UserAction ts={c.ts} /><UserText /></div>
      {c.queued && <div className="queued-note">{t("排队时发的")}</div>}
    </MessagePrimitive.Root>
  );
}
/** Something to put in a user message's header (the chat page's 「回到这一轮之前」), from its text and time; null for none. */
export const UserActionContext = createContext<((text: string, ts: string) => ReactNode) | null>(null);
function UserAction({ ts }: { ts: string }) {
  const make = useContext(UserActionContext);
  const text = useAuiState((s) => s.message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"));
  const node = make ? make(text, ts) : null;
  return node ? <>{node}</> : null;
}
function UserText() {
  const text = useAuiState((s) => s.message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"));
  const c = useCustom();
  if (!text || (c.kind === "turn" && c.images?.length && text === "[图片]")) return null;
  return <div className="tl-t sel-text"><Linkified text={text} /></div>;
}
function SystemLine() {
  const t = useT();
  const c = useCustom();
  if (c.kind === "gap") return <div className="tl gap"><div className="muted">{c.text}</div></div>;
  if (c.kind === "working") return <WorkingLine step={c.step} />;
  if (c.kind === "system") return <div className="tl system"><div className="muted small tl-system" title={t("不是你发的：Claude Code 的后台任务 / 子 Agent / hook 的通知，Agent 看到后可能会接一句")}>{/^Agent "/.test(c.text || "") ? t("子 Agent") : t("系统事件")} · {c.text}</div>{c.images && c.images.length > 0 && <div className="tl-system-images"><ImageGrid ids={c.images} /></div>}</div>;
  return null;
}
const MESSAGES = { UserMessage: Turn, AssistantMessage: Turn, SystemMessage: SystemLine };

interface Props { list: TimelineMsg[]; running?: boolean; cwd?: string }

export function SessionThread({ list, running = false, cwd }: Props) {
  // The locale is a dependency: the notes toMessages bakes in must follow a switch.
  const locale = useLocale();
  const messages = useMemo(() => toMessages(list, running), [list, running, locale]);
  // Read-only: the reply box under the page sends messages, not this thread.
  const runtime = useExternalStoreRuntime<Msg>({ messages, isRunning: running, convertMessage: (m) => m, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CwdContext.Provider value={cwd}>
        <FoldToolUI />
        <div className="chat"><ThreadPrimitive.Messages components={MESSAGES} /></div>
      </CwdContext.Provider>
    </AssistantRuntimeProvider>
  );
}
