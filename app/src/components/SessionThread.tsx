import { useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, makeAssistantToolUI, useAuiState, useExternalStoreRuntime, useSmooth, type MessageStatus, type ReasoningMessagePartProps, type TextMessagePartProps, type ThreadMessageLike, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { fmtTime } from "../derive";
import { blocksOf, foldLabel } from "../timeline";
import type { Block, TimelineMsg } from "../types";
import { ImageGrid } from "./Media";
import { Markdown, Linkified } from "./Markdown";

// The conversation drawn with assistant-ui: every turn is one Thread message, an assistant turn's
// steps are its parts — thinking as a Reasoning part (folded), a tool call as a tool-call part
// (a card with its status and result), the text as Markdown that streams while the session runs.
// The list arrives already filtered (see timeline.ts); this file only draws it.

type ToolBlock = Extract<Block, { type: "tool_call" }>;
type Custom =
  | { kind: "turn"; role: "user" | "assistant" | "tool"; name: string; ts: string; cont: boolean; images?: string[]; tools: Record<string, ToolBlock>; folds: Record<string, ToolBlock[]> }
  | { kind: "system"; text: string }
  | { kind: "gap"; text: string }
  | { kind: "typing"; name: string };
type Msg = ThreadMessageLike & { readonly metadata: { readonly custom: Custom } };

const FOLD = "__fold";
const RUNNING: MessageStatus = { type: "running" };
const DONE: MessageStatus = { type: "complete", reason: "stop" };
const HALTED: MessageStatus = { type: "incomplete", reason: "cancelled" };
const STATUS_TEXT: Record<ToolBlock["status"], string> = { running: "运行中", done: "完成", error: "出错", incomplete: "没等到结果" };
const STATUS_MARK: Record<ToolBlock["status"], string> = { running: "…", done: "✓", error: "✗", incomplete: "?" };

// Every turn becomes one message; the assistant's own status decides whether its last step is
// "still going" (running: the shimmer, the spinner) or settled.
function toMessages(list: TimelineMsg[], name: string, running: boolean): Msg[] {
  const out: Msg[] = [];
  list.forEach((x, i) => {
    const id = `${i}:${x.ts}`;
    if (x.role === "gap") { out.push({ id, role: "system", content: [{ type: "text", text: x.text || "…" }], metadata: { custom: { kind: "gap", text: x.text } } }); return; }
    if (x.synthetic) { out.push({ id, role: "system", content: [{ type: "text", text: x.text || "…" }], metadata: { custom: { kind: "system", text: x.text } } }); return; }
    if (x.role === "user" || x.role === "tool") {
      out.push({ id, role: "user", content: [{ type: "text", text: x.text || (x.images?.length ? "[图片]" : "…") }], metadata: { custom: { kind: "turn", role: x.role, name: x.role === "user" ? "你" : "工具", ts: x.ts, cont: x.role === "tool" && out[out.length - 1]?.role === "assistant", images: x.images, tools: {}, folds: {} } } });
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
      if (b.type === "thinking") { content.push({ type: "reasoning", text: b.text, unstable_summary: b.note || (b.text ? undefined : "内容未记录") }); return; }
      const key = b.id || `${id}:${j}`;
      tools[key] = b;
      // assistant-ui treats a tool call without a result as still running (it inherits the message
      // status), so a settled call always carries one — the card reads the block for the truth.
      content.push({ type: "tool-call", toolCallId: key, toolName: b.name, args: (b.input ?? {}) as Record<string, never>, result: b.status === "running" && running && isLast ? undefined : (b.result ?? ""), isError: b.status === "error" });
    });
    if (!content.length) return;
    const unfinished = blocks.some((b) => b.type === "tool_call" && b.status === "running");
    const status = running && isLast ? RUNNING : unfinished ? HALTED : DONE;
    // A reply that follows another reply (or a tool row) continues it: no second name line.
    const cont = out[out.length - 1]?.role === "assistant" || (out[out.length - 1]?.metadata.custom as Custom | undefined)?.kind === "turn" && (out[out.length - 1]?.metadata.custom as Custom & { role?: string }).role === "tool";
    out.push({ id, role: "assistant", status, content, metadata: { custom: { kind: "turn", role: "assistant", name, ts: x.ts, cont, images: x.images, tools, folds } } });
  });
  // Between two steps of a running session the agent is thinking: say so at the tail.
  const tail = list[list.length - 1];
  const tailBlocks = tail?.role === "assistant" ? blocksOf(tail) : [];
  const lastBlock = tailBlocks[tailBlocks.length - 1];
  // After a text block the caret says so; after a tool call the turn's own Empty slot does (see Empty below).
  const needsLine = !lastBlock || lastBlock.type === "thinking";
  if (running && needsLine) out.push({ id: "typing", role: "assistant", status: RUNNING, content: [], metadata: { custom: { kind: "typing", name } } });
  return out;
}

const useCustom = () => useAuiState((s) => s.message.metadata.custom as Custom);

// Text: Markdown, smoothed while the session streams so a paragraph that lands per poll shows up
// character by character, with a caret while it is still the newest thing.
function Text(p: TextMessagePartProps) {
  const { text, status } = useSmooth(p, true);
  return <div className="tl-t"><Markdown src={text + (status.type === "running" ? " ▍" : "")} className="compact" /></div>;
}

// Thinking, folded: the first line as the summary, the whole thing on click; while it is the
// running step the summary shimmers as 思考中.
function Reasoning(p: ReasoningMessagePartProps) {
  // Transcripts write a thinking block once it is finished, so text means "thought"; the
  // shimmer is for a block that is still empty while the session runs (headless streams).
  const running = p.status.type === "running";
  const text = (p.text || "").trim();
  // No readable thinking (signature only, redacted, summaries off): one quiet line, not a fold.
  if (!text) return <div className={`tl-think bare${running ? " running" : ""}`}><span className="think-mark">💭</span>{running ? <span className="shimmer">思考中…</span> : <span className="muted">思考了{p.unstable_summary ? ` · ${p.unstable_summary}` : ""}</span>}</div>;
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <details className="tl-think">
      <summary><span className="think-mark">💭</span><span className="think-peek">{first.length > 120 ? first.slice(0, 120) + "…" : first}</span></summary>
      <div className="think-body sel-text">{text}</div>
    </details>
  );
}

const ARG_ORDER = ["command", "cmd", "file_path", "filePath", "path", "pattern", "url", "prompt", "description", "query", "old_string", "new_string"];
const argEntries = (input: Record<string, unknown>) => Object.entries(input).sort(([a], [b]) => (ARG_ORDER.indexOf(a) + 1 || 99) - (ARG_ORDER.indexOf(b) + 1 || 99));

// The tool card: name, the argument that identifies the call, its status; open it for every
// argument and the result.
function CardView({ name, status, summary, input, result, ts, shell }: { name: string; status: ToolBlock["status"]; summary: string; input: Record<string, unknown>; result: string; ts?: string; shell?: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { if (status !== "running" || !ts) return; const t = window.setInterval(() => setTick((n) => n + 1), 1000); return () => window.clearInterval(t); }, [status, ts]);
  const secs = status === "running" && ts ? Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000)) : 0;
  void tick;
  return (
    <details className={`tool-card ${status}`}>
      <summary title={summary || undefined}>
        <span className={`tool-status ${status}`} aria-label={STATUS_TEXT[status]}>{status === "running" ? <span className="spin" /> : STATUS_MARK[status]}</span>
        <b>{name}</b>
        {summary && <span className={`tool-sum${shell ? " mono" : ""}`}>{summary}</span>}
        <span className="muted small tool-state">{status === "running" ? `正在调用${secs > 2 ? ` · ${secs}s` : ""}` : STATUS_TEXT[status]}</span>
      </summary>
      <div className="tool-body">
        {Object.keys(input).length > 0 && <dl className="tool-args">{argEntries(input).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="sel-text">{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}</dl>}
        {result ? <pre className={`tool-result${status === "error" ? " err" : ""}`}>{result}</pre> : status === "done" ? <div className="muted small">（没有输出）</div> : null}
      </div>
    </details>
  );
}
// The block from the CLI is the source of truth for the status (assistant-ui only knows "has a result or not").
function ToolCard(p: ToolCallMessagePartProps & { shell?: boolean }) {
  const c = useCustom();
  const b = c.kind === "turn" ? c.tools[p.toolCallId] : undefined;
  // A call the transcript never answered only spins while the session itself is running.
  const status: ToolBlock["status"] = b ? (b.status === "running" && p.status.type !== "running" ? "incomplete" : b.status) : p.status.type === "running" ? "running" : p.isError ? "error" : "done";
  const summary = b?.summary || (p.shell ? String(p.args?.command ?? p.args?.cmd ?? "") : "");
  const input = (b?.input ?? p.args ?? {}) as Record<string, unknown>;
  const result = b?.result ?? (typeof p.result === "string" ? p.result : "");
  return <CardView name={p.toolName} status={status} summary={summary} input={input} result={result} ts={b?.ts} shell={p.shell} />;
}
// A run of finished calls as one line — "跑了 6 条命令 ›" — with the cards inside when opened.
function FoldRow(p: ToolCallMessagePartProps) {
  const c = useCustom();
  const tools = c.kind === "turn" ? c.folds[p.toolCallId] ?? [] : [];
  if (!tools.length) return null;
  return (
    <details className="tool-fold">
      <summary><span className="fold-label">{foldLabel(tools)}</span><span className="fold-arrow">›</span></summary>
      <div className="fold-body">{tools.map((t, i) => <CardView key={t.id || i} name={t.name} status={t.status} summary={t.summary} input={t.input ?? {}} result={t.result ?? ""} ts={t.ts} shell={SHELL_TOOLS.includes(t.name)} />)}</div>
    </details>
  );
}
const FoldToolUI = makeAssistantToolUI({ toolName: FOLD, render: FoldRow });
const ShellCard = (p: ToolCallMessagePartProps) => <ToolCard {...p} shell />;
// Shell calls get their own registered UI (the command is the whole story); everything else falls back to the generic card.
const SHELL_TOOLS = ["Bash", "bash", "exec_command", "shell", "run_command"];
const ShellToolUIs = SHELL_TOOLS.map((toolName) => makeAssistantToolUI({ toolName, render: ShellCard }));

// assistant-ui adds an empty slot after a running message whose last part is a tool call:
// between a finished call and the next step the agent is thinking; while the call runs the card's spinner is enough.
function Empty({ status }: { status: { type: string } }) {
  const c = useCustom();
  if (status.type !== "running" || (c.kind === "turn" && Object.values(c.tools).some((b) => b.status === "running"))) return null;
  return <div className="tl-think bare running"><span className="think-mark">💭</span><span className="shimmer">思考中…</span></div>;
}
const PARTS = { Text, Reasoning, Empty, tools: { Fallback: ToolCard } };

function Turn() {
  const c = useCustom();
  if (c.kind === "typing") return <MessagePrimitive.Root className="tl assistant typing"><div className="tl-h"><b>{c.name}</b></div><div className="tl-think bare running"><span className="think-mark">💭</span><span className="shimmer">思考中…</span></div></MessagePrimitive.Root>;
  if (c.kind !== "turn") return null;
  return (
    <MessagePrimitive.Root className={`tl ${c.role}${c.cont ? " cont" : ""}`}>
      {!c.cont && <div className="tl-h"><b>{c.name}</b><span className="mono muted small">{c.ts ? fmtTime(c.ts) : ""}</span></div>}
      {c.images && c.images.length > 0 && <ImageGrid ids={c.images} />}
      {c.role === "assistant" ? <MessagePrimitive.Parts components={PARTS} /> : <UserText />}
    </MessagePrimitive.Root>
  );
}
function UserText() {
  const text = useAuiState((s) => s.message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"));
  const c = useCustom();
  if (!text || (c.kind === "turn" && c.images?.length && text === "[图片]")) return null;
  return <div className="tl-t sel-text"><Linkified text={text} /></div>;
}
function SystemLine() {
  const c = useCustom();
  if (c.kind === "gap") return <div className="tl gap"><div className="muted">{c.text}</div></div>;
  if (c.kind === "system") return <div className="tl system"><div className="muted small tl-system" title="不是你发的：Claude Code 的后台任务 / hook 通知，Agent 看到后可能会接一句">系统事件 · {c.text}</div></div>;
  return null;
}
const MESSAGES = { UserMessage: Turn, AssistantMessage: Turn, SystemMessage: SystemLine };

interface Props { list: TimelineMsg[]; name: string; running?: boolean }

export function SessionThread({ list, name, running = false }: Props) {
  const messages = useMemo(() => toMessages(list, name, running), [list, name, running]);
  // Read-only: the reply box under the page sends messages, not this thread.
  const runtime = useExternalStoreRuntime<Msg>({ messages, isRunning: running, convertMessage: (m) => m, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {ShellToolUIs.map((T, i) => <T key={i} />)}<FoldToolUI />
      <div className="chat"><ThreadPrimitive.Messages components={MESSAGES} /></div>
    </AssistantRuntimeProvider>
  );
}
