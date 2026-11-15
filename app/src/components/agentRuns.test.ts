import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../chatProtocol";
import { chatViewOf, ingest, resetChatStore } from "../chatStore";
import { AGENT_TAB_LINGER_MS, agentLogOf, agentRunsOf, commandOf, runSummary } from "./agentRuns";

const KEY = "claude-code:0f5c2b1e-aaaa-4bbb-8ccc-123456789abc";
let seq = 0;
const ev = (e: Record<string, unknown>) => ingest({ seq: ++seq, ts: 1000 + seq, ...e } as ChatEvent);
const view = () => chatViewOf(KEY)!;

// A turn with two shell commands (one finished, one still running) and one edit.
function fixture() {
  ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
  ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "build it", images_n: 0 });
  ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "b1", name: "Bash", kind: "shell", input: { command: "cd app && npm test -- --run" }, summary: "npm test" });
  ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: "b1", ok: true, output: "285 passed\n", truncated: false, exit_code: 0, duration_ms: 4000 });
  ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "e1", name: "Edit", kind: "edit", input: { file_path: "/p/a.ts" }, summary: "a.ts" });
  ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: "e1", ok: true, output: "", truncated: false, duration_ms: 10, diff: { kind: "edit", path: "/p/a.ts", old: "a\nb", new: "a\nc\nd" } });
  ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "b2", name: "Bash", kind: "shell", input: { command: "xcodebuild -scheme Harbor build" }, summary: "xcodebuild" });
}

beforeEach(() => { resetChatStore(); seq = 0; });
afterEach(() => resetChatStore());

describe("commandOf / runSummary", () => {
  it("reads Claude's command, Codex's argv and unwraps bash -lc", () => {
    expect(commandOf({ input: { command: "git status" }, summary: "" })).toBe("git status");
    expect(commandOf({ input: { command: ["npm", "run", "build"] }, summary: "" })).toBe("npm run build");
    expect(commandOf({ input: { cmd: "bash -lc 'ls -la src'" }, summary: "" })).toBe("ls -la src");
    expect(commandOf({ input: {}, summary: "fallback" })).toBe("fallback");
  });
  it("names the program and its sub-command, skipping cd and env assignments", () => {
    expect(runSummary("cd app && npm test -- --run")).toBe("npm test");
    expect(runSummary("CI=1 /usr/bin/xcodebuild -scheme X")).toBe("xcodebuild");
    expect(runSummary("git status")).toBe("git status");
  });
});

describe("agentRunsOf", () => {
  it("lists only shell chips, running and finished, with their output", () => {
    fixture();
    const now = (1000 + seq) * 1000;
    const runs = agentRunsOf(view(), now);
    expect(runs.map((r) => r.tool_id)).toEqual(["b1", "b2"]);
    expect(runs[0]).toMatchObject({ command: "cd app && npm test -- --run", summary: "npm test", done: true, ok: true, exit_code: 0, output: "285 passed\n", duration_ms: 4000 });
    expect(runs[1]).toMatchObject({ command: "xcodebuild -scheme Harbor build", summary: "xcodebuild", done: false, output: "" });
  });

  it("drops a finished run AGENT_TAB_LINGER_MS after it ended; a running one stays", () => {
    fixture();
    const b1 = view().turns[0].tools.b1;
    const end = b1.started * 1000 + 4000;
    expect(agentRunsOf(view(), end + AGENT_TAB_LINGER_MS - 1).map((r) => r.tool_id)).toEqual(["b1", "b2"]);
    expect(agentRunsOf(view(), end + AGENT_TAB_LINGER_MS + 1).map((r) => r.tool_id)).toEqual(["b2"]);
  });

  it("marks a failed command and ends orphans of a turn that stopped", () => {
    fixture();
    ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: "b2", ok: false, output: "error: no scheme\n", truncated: false, exit_code: 65, duration_ms: 2000 });
    ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "b3", name: "Bash", kind: "shell", input: { command: "sleep 100" }, summary: "sleep" });
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "interrupted", duration_ms: 9000, num_tools: 4 });
    const seen = new Map<string, number>();
    const now = (1000 + seq) * 1000;
    const runs = agentRunsOf(view(), now, seen);
    expect(runs.find((r) => r.tool_id === "b2")).toMatchObject({ done: true, ok: false, exit_code: 65 });
    expect(runs.find((r) => r.tool_id === "b3")).toMatchObject({ done: true, ok: false });
    // The orphan has no duration: its linger clock starts when the page first saw it end.
    expect(seen.get("b3")).toBe(now);
    expect(agentRunsOf(view(), now + AGENT_TAB_LINGER_MS + 1, seen).map((r) => r.tool_id)).not.toContain("b3");
  });

  it("is empty without a view", () => {
    expect(agentRunsOf(null, Date.now())).toEqual([]);
  });
});

describe("agentLogOf", () => {
  it("writes one line per tool call for the 输出 tab", () => {
    fixture();
    const lines = agentLogOf(view(), (s) => `T${s}`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[Agent\] T\d+ Bash cd app && npm test -- --run$/);
    expect(lines[1]).toMatch(/Edit \/p\/a\.ts \+2 −1$/);
    expect(lines[2]).toMatch(/xcodebuild -scheme Harbor build …$/);
  });
});
