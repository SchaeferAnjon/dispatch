import { describe, expect, it } from "vitest";
import { blocksOf, currentStep, foldLabel, mergeTail, visibleTurns } from "./timeline";
import type { Block, SessionDetail, SessionTail, TimelineMsg, ToolStatus } from "./types";

const tool = (id: string, name: string, status: ToolStatus, extra: Partial<Extract<Block, { type: "tool_call" }>> = {}): Block => ({ type: "tool_call", id, name, summary: name.toLowerCase(), input: {}, status, ...extra });
const msg = (role: TimelineMsg["role"], blocks: Block[], extra: Partial<TimelineMsg> = {}): TimelineMsg => ({ ts: "2026-09-09T10:00:00Z", role, text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), tools: blocks.filter((b) => b.type === "tool_call").map((b) => ({ name: b.name, summary: b.summary, id: b.id })), blocks, ...extra });
const detail = (messages: TimelineMsg[], offset = 100): SessionDetail => ({ meta: {} as SessionDetail["meta"], messages, files: [], tool_counts: {}, offset });
const tail = (t: Partial<SessionTail>): SessionTail => ({ partial: true, since: 100, offset: 200, messages: [], resolved: [], files: [], tool_counts: {}, ...t });

describe("blocksOf", () => {
  it("makes blocks out of a message from an older CLI", () => {
    expect(blocksOf({ ts: "", role: "assistant", text: "hi", tools: [{ name: "Bash", summary: "ls" }] })).toEqual([{ type: "text", text: "hi" }, { type: "tool_call", id: "", name: "Bash", summary: "ls", input: {}, status: "done" }]);
  });
});

describe("visibleTurns", () => {
  const thread = [
    msg("user", [{ type: "text", text: "看看" }]),
    msg("assistant", [{ type: "thinking", text: "先读" }, tool("t1", "Read", "done")]),
    msg("assistant", [{ type: "thinking", text: "再答" }, { type: "text", text: "读完了。" }, tool("t2", "Bash", "running")]),
  ];
  const opts = { brief: false, showTools: false, showUser: true, showAssistant: true, running: false };
  it("folds finished calls into one line when 工具调用 is off; real thinking stays, a signature-only line goes", () => {
    const v = visibleTurns(thread, opts);
    expect(v.map((x) => x.role)).toEqual(["user", "assistant", "assistant"]);
    expect(v[1].blocks!.map((b) => b.type)).toEqual(["thinking", "tool_fold"]);
    expect(v[2].blocks!.map((b) => b.type)).toEqual(["thinking", "text", "tool_fold"]);
    const bare = visibleTurns([msg("user", [{ type: "text", text: "嗯" }]), msg("assistant", [{ type: "thinking", text: "" }, { type: "text", text: "好" }])], opts);
    expect(bare[1].blocks!.map((b) => b.type)).toEqual(["text"]);
  });
  it("consecutive tool-only turns read as one fold; the running call stays a card", () => {
    const run = [
      msg("user", [{ type: "text", text: "跑" }]),
      msg("assistant", [{ type: "thinking", text: "" }, tool("a", "Bash", "done"), tool("b", "Read", "done")]),
      msg("assistant", [tool("c", "Bash", "error")]),
      msg("assistant", [{ type: "text", text: "看到了" }, tool("d", "Grep", "done"), tool("e", "Bash", "running")]),
    ];
    const v = visibleTurns(run, { ...opts, running: true });
    expect(v.length).toBe(3);
    const f = v[1].blocks![0];
    expect(f.type).toBe("tool_fold");
    if (f.type === "tool_fold") { expect(f.tools.map((t) => t.id)).toEqual(["a", "b", "c"]); expect(foldLabel(f.tools)).toBe("跑了 2 条命令、读了 1 个文件 · 1 个出错"); }
    expect(v[2].blocks!.map((b) => (b.type === "tool_call" ? b.id : b.type))).toEqual(["text", "tool_fold", "e"]);
  });
  it("shows every step with 工具调用 on", () => {
    const v = visibleTurns(thread, { ...opts, showTools: true });
    expect(v.length).toBe(3);
    expect(v[1].blocks!.map((b) => b.type)).toEqual(["thinking", "tool_call"]);
  });
  it("只看结论 keeps your line and the last reply, without thinking or tools", () => {
    const v = visibleTurns([...thread, msg("user", [{ type: "text", text: "好" }]), msg("assistant", [{ type: "text", text: "一" }]), msg("assistant", [{ type: "text", text: "二" }])], { ...opts, brief: true, showTools: true });
    expect(v.map((x) => x.text)).toEqual(["看看", "读完了。", "好", "二"]);
    expect(v[1].blocks!.map((b) => b.type)).toEqual(["text"]);
  });
  it("a running session always shows its latest turn, with the call that is running", () => {
    const live = [...thread, msg("assistant", [{ type: "thinking", text: "" }, tool("t3", "Grep", "done"), tool("t4", "Bash", "running")])];
    const v = visibleTurns(live, { ...opts, running: true });
    expect(v.length).toBe(4);
    expect(v[3].blocks!.map((b) => (b.type === "tool_call" ? b.id : b.type))).toEqual(["tool_fold", "t4"]);
    expect(visibleTurns(live, { ...opts, running: true, brief: true }).length).toBe(2);
  });
  it("system events sit at tool level", () => {
    const sys = msg("user", [{ type: "text", text: "hook" }], { synthetic: true });
    expect(visibleTurns([sys], opts)).toEqual([]);
    expect(visibleTurns([sys], { ...opts, showTools: true }).length).toBe(1);
  });
});

describe("mergeTail", () => {
  it("lands results on the cards already drawn and appends new turns", () => {
    const d = detail([msg("user", [{ type: "text", text: "跑" }]), msg("assistant", [tool("t1", "Bash", "running")], { mid: "m1" })]);
    const t = tail({ resolved: [{ id: "t1", status: "done", result: "42 passed", result_ts: "2026-09-09T10:00:05Z" }], messages: [msg("assistant", [{ type: "text", text: "都过了。" }], { mid: "m2" })], tool_counts: { Bash: 1 } });
    const out = mergeTail(d, t);
    expect(out.offset).toBe(200);
    expect(out.messages.length).toBe(3);
    expect(out.messages[1].blocks![0]).toMatchObject({ status: "done", result: "42 passed" });
    expect(out.messages[2].text).toBe("都过了。");
    expect(out.tool_counts).toEqual({ Bash: 1 });
    expect(d.messages[1].blocks![0]).toMatchObject({ status: "running" }); // the old detail is untouched
  });
  it("continues the last turn when the tail carries the rest of the same message", () => {
    const d = detail([msg("assistant", [{ type: "thinking", text: "想" }], { mid: "m1" })]);
    const out = mergeTail(d, tail({ messages: [msg("assistant", [{ type: "text", text: "答" }, tool("t9", "Read", "running")], { mid: "m1" })] }));
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].blocks!.map((b) => b.type)).toEqual(["thinking", "text", "tool_call"]);
    expect(out.messages[0].text).toBe("答");
    expect(out.messages[0].tools).toEqual([{ name: "Read", summary: "read", id: "t9" }]);
  });
  it("a re-emitted card or part replaces the earlier copy instead of doubling", () => {
    const d = detail([msg("assistant", [{ type: "text", text: "he", id: "p1" }, tool("z1", "bash", "running")], { mid: "a1" })]);
    const out = mergeTail(d, tail({ messages: [msg("assistant", [{ type: "text", text: "hello", id: "p1" }, tool("z1", "bash", "done", { result: "ok" })], { mid: "a1" })] }));
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].blocks).toEqual([{ type: "text", text: "hello", id: "p1" }, expect.objectContaining({ id: "z1", status: "done", result: "ok" })]);
    expect(out.messages[0].text).toBe("hello");
  });
  it("ignores a tail that does not continue this detail", () => {
    const d = detail([], 300);
    expect(mergeTail(d, tail({ since: 100, messages: [msg("user", [{ type: "text", text: "x" }])] }))).toBe(d);
  });
});

describe("currentStep", () => {
  it("names the running call, otherwise thinking or replying", () => {
    expect(currentStep([msg("user", [{ type: "text", text: "?" }])])).toEqual({ kind: "thinking" });
    expect(currentStep([msg("assistant", [tool("t", "Bash", "running")])])).toEqual({ kind: "tool", name: "Bash" });
    expect(currentStep([msg("assistant", [tool("t", "Bash", "done")])])).toEqual({ kind: "thinking" });
    expect(currentStep([msg("assistant", [{ type: "text", text: "…" }])])).toEqual({ kind: "text" });
    expect(currentStep([])).toEqual({ kind: "idle" });
  });
});
