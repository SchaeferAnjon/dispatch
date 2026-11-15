import { describe, expect, it } from "vitest";
import { chatRef, dirtyJson, dirtyReport } from "../src/core/signalModel";
import { sessionItems, sessionSummary } from "../src/core/sessionsModel";

describe("sessions and chat signals", () => {
  it("lists live sessions, this project's working ones first", () => {
    const rows = [
      { agent: "codex", session_id: "1", cwd: "/other", state: "working", alive: true },
      { agent: "claude-code", session_id: "2", cwd: "/p/sub", state: "idle", alive: true, herdr: { title: "◐ Fix the login" } },
      { agent: "claude-code", session_id: "3", cwd: "/p", state: "working", alive: true, title: "Tab cap" },
      { agent: "claude-code", session_id: "4", cwd: "/p", alive: false },
      { agent: "claude-code", cwd: "/p" },
    ];
    const items = sessionItems(rows, "/p");
    expect(items.map((s) => s.key)).toEqual(["claude-code:3", "claude-code:2", "codex:1"]);
    expect(items[1].label).toBe("Fix the login");
    expect(items[2].label).toBe("codex · /other");
    expect(sessionSummary(items)).toEqual({ total: 3, here: 2, working: 2 });
    expect(sessionItems({}, "/p")).toEqual([]);
  });

  it("turns a selection into a chat mention", () => {
    const r = chatRef({ root: "/p", file: "/p/src/a.py", startLine: 9, endLine: 11, text: "x", sep: "/" });
    expect(r).toMatchObject({ path: "src/a.py", start: 10, end: 12, mention: "@src/a.py:10-12", truncated: false });
    expect(chatRef({ root: "/p", file: "/p/a.py", startLine: 0, endLine: 0, text: "y".repeat(9000), sep: "/" })).toMatchObject({ mention: "@a.py:1", truncated: true });
    expect(chatRef({ root: "/p", file: "/elsewhere/b.py", startLine: 0, endLine: 0, text: "", sep: "/" }).path).toBe("/elsewhere/b.py");
  });
});

describe("unsaved count for ⌘Q", () => {
  it("is written at once when it grows and a moment later when it shrinks", () => {
    expect(dirtyReport(-1, 0)).toBe("now"); // the first report on start
    expect(dirtyReport(0, 1)).toBe("now"); // the first keystroke in a clean file: ⌘Q right after must ask
    expect(dirtyReport(1, 1)).toBe("none");
    expect(dirtyReport(3, 0)).toBe("later");
    expect(JSON.parse(dirtyJson(2, 1_700_000_000_500))).toEqual({ count: 2, at: 1_700_000_000 });
  });
});
