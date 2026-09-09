import type { Block, SessionDetail, SessionTail, TimelineMsg, ToolStatus } from "./types";

// The conversation as the session page shows it: which turns and which steps are visible, and
// how a live tail (`dispatch session --since`) folds into what is already on screen.

// Older CLIs (and the fixtures) only give text + tool chips; make blocks out of them.
export function blocksOf(m: TimelineMsg): Block[] {
  if (m.blocks) return m.blocks;
  const out: Block[] = [];
  if (m.text) out.push({ type: "text", text: m.text });
  for (const t of m.tools) out.push({ type: "tool_call", id: t.id ?? "", name: t.name, summary: t.summary, input: {}, status: "done" });
  return out;
}

export interface ViewOptions { brief: boolean; showTools: boolean; showUser: boolean; showAssistant: boolean; running: boolean }

// Which turns to draw, with the steps each keeps. 只看结论 keeps your messages and the last reply
// of every turn, without thinking or tool cards; otherwise tool cards follow the 工具调用 switch,
// thinking stays folded under the text it led to, and a running session always shows its
// latest turn so "思考中 / 正在调用" has somewhere to appear.
export function visibleTurns(messages: TimelineMsg[], o: ViewOptions): TimelineMsg[] {
  const shown: TimelineMsg[] = [];
  const last = messages[messages.length - 1];
  for (const x of messages) {
    if (x.role === "gap") { shown.push(x); continue; }
    if (x.role === "user") { if (x.synthetic ? o.showTools && !o.brief : o.showUser) shown.push(x); continue; }
    if (x.role === "tool") { if (o.showTools && !o.brief) shown.push(x); continue; }
    const blocks = blocksOf(x);
    const hasText = blocks.some((b) => b.type === "text" && b.text.trim());
    const live = o.running && x === last && !o.brief;
    const visible = hasText ? o.showAssistant : (o.showTools && !o.brief) || live;
    if (!visible) continue;
    // With tool cards off, the live turn still shows the call that is running right now.
    const keep = blocks.filter((b) => b.type === "text" || (!o.brief && b.type === "thinking") || (!o.brief && b.type === "tool_call" && (o.showTools || (live && b.status === "running"))));
    shown.push({ ...x, blocks: keep });
  }
  if (!o.brief) return shown;
  const keep: TimelineMsg[] = [];
  let lastReply: TimelineMsg | null = null;
  for (const x of shown) {
    if (x.role === "user") { if (lastReply) keep.push(lastReply); lastReply = null; keep.push(x); }
    else if (x.role === "assistant" && x.text.trim()) lastReply = x;
    else if (x.role === "gap") keep.push(x);
  }
  if (lastReply) keep.push(lastReply);
  return keep;
}

const withResult = (b: Block, r: { status: ToolStatus; result?: string; result_ts?: string }): Block => b.type === "tool_call" ? { ...b, status: r.status, result: r.result ?? b.result, result_ts: r.result_ts ?? b.result_ts } : b;
const textOf = (blocks: Block[]) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const toolsOf = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call").map((b) => ({ name: b.name, summary: b.summary, id: b.id }));

// Fold a tail into the detail: results land on the cards already drawn, a step that continues
// the last turn (same transcript message) joins it, a card the agent re-emitted (OpenCode
// rewrites a tool part as it runs) updates in place instead of appearing twice.
export function mergeTail(d: SessionDetail, t: SessionTail): SessionDetail {
  if (t.since !== (d.offset ?? 0)) return d; // a stale tail (the detail was replaced meanwhile)
  let msgs = d.messages.slice();
  const patch = (id: string, r: { status: ToolStatus; result?: string; result_ts?: string }) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const bs = msgs[i].blocks;
      const j = bs?.findIndex((b) => b.type === "tool_call" && b.id === id) ?? -1;
      if (bs && j >= 0) { msgs[i] = { ...msgs[i], blocks: bs.map((b, k) => (k === j ? withResult(b, r) : b)) }; return true; }
    }
    return false;
  };
  for (const r of t.resolved) patch(r.id, r);
  for (const m of t.messages) {
    let blocks = blocksOf(m);
    blocks = blocks.filter((b) => {
      if (b.type === "tool_call" && b.id && patch(b.id, b)) return false;
      if (b.type !== "tool_call" && b.id) {
        // A re-emitted text/thinking part: replace the earlier copy.
        for (let i = msgs.length - 1; i >= 0; i--) {
          const bs = msgs[i].blocks; const j = bs?.findIndex((x) => x.type === b.type && x.id === b.id) ?? -1;
          if (bs && j >= 0) { const nb = bs.map((x, k) => (k === j ? b : x)); msgs[i] = { ...msgs[i], blocks: nb, text: textOf(nb) }; return false; }
        }
      }
      return true;
    });
    if (!blocks.length && !m.images?.length) continue;
    const last = msgs[msgs.length - 1];
    if (m.role === "assistant" && m.mid && last?.role === "assistant" && last.mid === m.mid) {
      const nb = [...blocksOf(last), ...blocks];
      msgs[msgs.length - 1] = { ...last, blocks: nb, text: textOf(nb), tools: toolsOf(nb) };
    } else msgs.push({ ...m, blocks, text: textOf(blocks) || m.text, tools: toolsOf(blocks) });
  }
  const files = d.files.slice();
  for (const f of t.files) { const i = files.findIndex((x) => x.path === f.path); if (i >= 0) files[i] = { path: f.path, changes: [...files[i].changes, ...f.changes] }; else files.push(f); }
  const tool_counts = { ...d.tool_counts };
  for (const [k, v] of Object.entries(t.tool_counts)) tool_counts[k] = (tool_counts[k] ?? 0) + v;
  return { ...d, messages: msgs, files, tool_counts, offset: t.offset };
}

// The step the agent is on right now, for the status line: the last block of the last turn.
export function currentStep(messages: TimelineMsg[]): { kind: "thinking" | "tool" | "text" | "idle"; name?: string } {
  const last = messages[messages.length - 1];
  if (!last) return { kind: "idle" };
  if (last.role !== "assistant") return { kind: "thinking" };
  const blocks = blocksOf(last);
  const b = blocks[blocks.length - 1];
  if (!b) return { kind: "thinking" };
  if (b.type === "tool_call") return b.status === "running" ? { kind: "tool", name: b.name } : { kind: "thinking" };
  return { kind: b.type === "thinking" ? "thinking" : "text" };
}
