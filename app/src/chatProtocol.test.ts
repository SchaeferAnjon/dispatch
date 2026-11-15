import { describe, expect, it } from "vitest";
import { canSend, commandBrief, initialChatView, isBusy, reduceChatEvent, splitKey, stepPhrase, toolKind, toolLabel, type ChatEvent } from "./chatProtocol";
import stepCases from "./stepPhrase.cases.json";

describe("stepPhrase (mirror of chat_protocol.step_phrase)", () => {
  it("says the same sentence as the Python side for every shared case", () => {
    expect(stepCases.length).toBeGreaterThan(15);
    for (const c of stepCases) expect(stepPhrase(c.name, c.input as Record<string, unknown>), JSON.stringify(c)).toBe(c.want);
  });
  it("copes with no input and a quoted cd", () => {
    expect(stepPhrase("Edit", null)).toBe("Editing a file");
    expect(commandBrief("cd 'my dir' ; make")).toBe("make");
  });
});

const S = "claude-code:abc";
let seq = 0;
type Bare<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;
const ev = (e: Bare<ChatEvent>): ChatEvent => ({ ...e, seq: ++seq, ts: 1000 + seq } as ChatEvent);
const run = (events: Bare<ChatEvent>[]) => events.reduce((v, e) => reduceChatEvent(v, ev(e)), initialChatView(S));

describe("chat protocol helpers", () => {
  it("keys and tool kinds", () => {
    expect(splitKey("codex:019a-x")).toEqual({ agent: "codex", id: "019a-x" });
    expect(splitKey("opencode:ses_2c4f9a1b3effe")).toEqual({ agent: "opencode", id: "ses_2c4f9a1b3effe" });
    expect(splitKey("pi:abc")).toBeNull();
    expect(["Bash", "Write", "Grep", "Task", "AskUserQuestion", "mcp__x"].map(toolKind)).toEqual(["shell", "edit", "search", "agent", "question", "other"]);
  });
  it("Codex's tool names read the way Claude Code's do", () => {
    expect(["commandExecution", "exec_command", "fileChange", "apply_patch", "read_file", "imageView", "webSearch", "subAgent", "requestUserInput"].map(toolLabel))
      .toEqual(["Bash", "Bash", "Edit", "Edit", "Read", "Read", "WebSearch", "Agent", "AskUserQuestion"]);
    // Claude Code's own names and anything unknown stay as they are
    expect(["Bash", "Read", "Edit", "Grep", "mcp__x", "github.search"].map(toolLabel)).toEqual(["Bash", "Read", "Edit", "Grep", "mcp__x", "github.search"]);
  });
});

describe("reduceChatEvent", () => {
  it("drops hook reports (内部记账) and keeps notices as a line of the turn", () => {
    const v = run([
      { ev: "opened", session: S, agent: "codex", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] },
      { ev: "turn_started", session: S, turn_id: "t1", message_id: "m1", text: "hi", images_n: 0 },
      { ev: "system", session: S, kind: "hook", text: "sessionStart: 已载入 3 条记忆" },
      { ev: "system", session: S, kind: "notice", text: "检查点：给这个目录打快照用了 3.1 秒" },
    ]);
    expect(v.turns[0].steps).toEqual([{ kind: "system", text: "检查点：给这个目录打快照用了 3.1 秒" }]);
  });
  it("streams a turn: text, thinking, a tool chip, a permission card, then done", () => {
    const v = run([
      { ev: "opened", session: S, agent: "claude-code", cwd: "/p", resumed: false, model: "haiku", permission_mode: "default", transcript_path: "/t.jsonl", capabilities: ["allow_session", "queue"] },
      { ev: "state", session: S, lifecycle: "idle", model: "haiku", permission_mode: "default", queue: [], pending: [], since: 1 },
      { ev: "turn_started", session: S, turn_id: "t1", message_id: "m1", text: "hi", images_n: 0 },
      { ev: "thinking_delta", session: S, turn_id: "t1", text: "hm" },
      { ev: "thinking_done", session: S, turn_id: "t1", text: "", tokens: 12, duration_ms: 900 },
      { ev: "text_delta", session: S, turn_id: "t1", text: "Hel" },
      { ev: "text_delta", session: S, turn_id: "t1", text: "lo" },
      { ev: "text_done", session: S, turn_id: "t1", text: "Hello there" },
      { ev: "tool_start", session: S, turn_id: "t1", tool_id: "u1", name: "Bash", kind: "shell", input: { command: "ls" }, summary: "ls" },
      { ev: "permission_request", session: S, turn_id: "t1", permission_id: "p1", kind: "command", tool_id: "u1", tool_name: "Bash", input: { command: "ls" }, summary: "ls", reason: "", options: ["allow", "allow_session", "deny"] },
    ]);
    expect(v.lifecycle).toBe("waiting_permission");
    expect(v.pending.map((p) => p.permission_id)).toEqual(["p1"]);
    expect(isBusy(v) && canSend(v)).toBe(true);
    const t = v.turns[0];
    expect(t.user_text).toBe("hi");
    expect(t.steps.map((s) => s.kind)).toEqual(["thinking", "text", "tool", "permission"]);
    expect(t.steps[0]).toMatchObject({ kind: "thinking", text: "hm", done: true, tokens: 12 });
    expect(t.steps[1]).toMatchObject({ kind: "text", text: "Hello there", done: true });
    expect(t.tools.u1.status).toBe("running");

    const v2 = [
      ev({ ev: "permission_resolved", session: S, permission_id: "p1", decision: "allow", by: "dispatch" }),
      ev({ ev: "tool_end", session: S, turn_id: "t1", tool_id: "u1", ok: true, output: "a\nb", truncated: false, exit_code: 0, duration_ms: 40 }),
      ev({ ev: "text_delta", session: S, turn_id: "t1", text: "Done." }),
      ev({ ev: "turn_done", session: S, turn_id: "t1", status: "success", duration_ms: 1200, cost_usd: 0.001, num_tools: 1 }),
    ].reduce(reduceChatEvent, v);
    expect(v2.lifecycle).toBe("idle");
    expect(v2.pending).toEqual([]);
    expect(v2.permissions.p1.resolved).toEqual({ decision: "allow", by: "dispatch" });
    expect(v2.turns[0].tools.u1).toMatchObject({ status: "done", output: "a\nb", exit_code: 0 });
    // a text block still open at turn_done is closed by it
    expect(v2.turns[0].steps.map((s) => s.kind)).toEqual(["thinking", "text", "tool", "permission", "text"]);
    expect(v2.turns[0].steps[4]).toMatchObject({ kind: "text", text: "Done.", done: true });
    expect(v2.turns[0]).toMatchObject({ status: "success", cost_usd: 0.001 });
    // a second turn gets its own entry
    const v3 = reduceChatEvent(v2, ev({ ev: "turn_started", session: S, turn_id: "t2", message_id: "m2", text: "again", images_n: 1 }));
    expect(v3.turns.map((t) => t.turn_id)).toEqual(["t1", "t2"]);
    expect(v3.lifecycle).toBe("running");
  });

  it("queue, errors, close, and other sessions", () => {
    const v = run([
      { ev: "opened", session: S, agent: "claude-code", cwd: "/p", resumed: true, model: "", permission_mode: "", transcript_path: "", capabilities: [] },
      { ev: "turn_started", session: S, turn_id: "t1", message_id: "m1", text: "go", images_n: 0 },
      { ev: "queue", session: S, queue: [{ message_id: "m2", text: "next", images_n: 0, at: 5 }] },
      { ev: "error", session: S, code: "session_busy", message: "later", fatal: false },
    ]);
    expect(v.queue).toHaveLength(1);
    expect(v.error?.code).toBe("session_busy");
    expect(v.lifecycle).toBe("running");
    // the queued message starting its turn leaves the queue
    const v2 = reduceChatEvent(reduceChatEvent(v, ev({ ev: "turn_done", session: S, turn_id: "t1", status: "interrupted", duration_ms: 3, num_tools: 0 })), ev({ ev: "turn_started", session: S, turn_id: "t2", message_id: "m2", text: "next", images_n: 0 }));
    expect(v2.queue).toEqual([]);
    expect(v2.error).toBeUndefined();
    expect(v2.turns[0].status).toBe("interrupted");
    // another session's event is ignored, a replayed (older seq) event too
    expect(reduceChatEvent(v2, ev({ ev: "text_delta", session: "codex:zzz", turn_id: "x", text: "no" }))).toBe(v2);
    expect(reduceChatEvent(v2, { ev: "text_delta", session: S, turn_id: "t2", text: "old", seq: 1, ts: 0 })).toBe(v2);
    const dead = reduceChatEvent(v2, ev({ ev: "error", session: S, code: "process_exited", message: "gone", fatal: true }));
    expect(dead.lifecycle).toBe("error");
    expect(canSend(dead)).toBe(false);
    const closed = reduceChatEvent(v2, ev({ ev: "closed", session: S, reason: "requested" }));
    expect(closed.lifecycle).toBe("stopped");
    expect(closed.closed?.reason).toBe("requested");
  });
});

describe("reduceChatEvent after a Codex reconnect", () => {
  // The event order t13 recorded: a connection drop during a command approval, then the daemon
  // resumes the same turn and asks again under a new id (old chatd sent an empty turn_started).
  const C = "codex:01a0";
  const cev = (e: Bare<ChatEvent>) => ev({ ...e, session: C } as Bare<ChatEvent>);
  const base: Bare<ChatEvent>[] = [
    { ev: "opened", session: C, agent: "codex", cwd: "/p", resumed: false, model: "luna", permission_mode: "plan", transcript_path: "", capabilities: ["queue"] },
    { ev: "turn_started", session: C, turn_id: "T", message_id: "x1", text: "sleep 8 then echo", images_n: 0 },
    { ev: "tool_start", session: C, turn_id: "T", tool_id: "e1", name: "commandExecution", kind: "shell", input: {}, summary: "sleep 8" },
    { ev: "permission_request", session: C, turn_id: "T", permission_id: "c1-4", kind: "command", tool_id: "e1", tool_name: "commandExecution", input: {}, summary: "sleep 8", reason: "", options: ["allow", "deny"] },
    { ev: "turn_done", session: C, turn_id: "T", status: "error", error: "lost the connection to the codex daemon", duration_ms: 1, num_tools: 1 },
    { ev: "state", session: C, lifecycle: "running", model: "luna", permission_mode: "plan", queue: [], pending: [], since: 1 },
  ];
  it("the resumed turn runs again, keeps its bubble, and only the new card has buttons", () => {
    for (const text of ["", "sleep 8 then echo"]) {  // an older chatd sent it empty; this one sends it again
      const v = [...base, { ev: "turn_started", session: C, turn_id: "T", message_id: text ? "x1" : "", text, images_n: 0 } as Bare<ChatEvent>,
        { ev: "permission_request", session: C, turn_id: "T", permission_id: "c2-4", kind: "command", tool_id: "e1", tool_name: "commandExecution", input: {}, summary: "sleep 8", reason: "", options: ["allow", "deny"] } as Bare<ChatEvent>]
        .reduce((acc, e) => reduceChatEvent(acc, cev(e)), initialChatView(C));
      const t = v.turns[0];
      expect(v.turns).toHaveLength(1);
      expect(t.status).toBeUndefined();
      expect(t.user_text).toBe("sleep 8 then echo");
      expect(t.message_id).toBe("x1");
      expect(v.lifecycle).toBe("waiting_permission");
      expect(v.pending.map((p) => p.permission_id)).toEqual(["c2-4"]);
      expect(v.permissions["c1-4"].resolved).toEqual({ decision: "deny", by: "elsewhere" });
      expect(v.permissions["c2-4"].resolved).toBeUndefined();
    }
  });
});

describe("reduceChatEvent cost", () => {
  it("a turn with thousands of tool calls stays linear", () => {
    const K = "claude-code:big";
    let v = initialChatView(K);
    let n = 0;
    const put = (e: Record<string, unknown>) => { v = reduceChatEvent(v, { ...e, session: K, seq: ++n, ts: n } as ChatEvent); };
    put({ ev: "turn_started", turn_id: "t", message_id: "m", text: "go", images_n: 0 });
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) {
      put({ ev: "tool_start", turn_id: "t", tool_id: `u${i}`, name: "Read", kind: "read", input: {}, summary: "f" });
      put({ ev: "tool_end", turn_id: "t", tool_id: `u${i}`, ok: true, output: "x", truncated: false, duration_ms: 1 });
    }
    const took = performance.now() - t0;
    expect(Object.keys(v.turns[0].tools)).toHaveLength(3000);
    expect(v.turns[0].tools.u2999.status).toBe("done");
    expect(took).toBeLessThan(1500);  // copying the map per event took 2.8 s for this
    // text streaming leaves the tool map alone instead of copying it
    const before = v.turns[0].tools;
    put({ ev: "text_delta", turn_id: "t", text: "a" });
    expect(v.turns[0].tools).toBe(before);
  });
});
