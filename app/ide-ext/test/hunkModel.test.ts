import { describe, expect, it } from "vitest";
import { AgentHunk, hunkAt, nextHunk, oldPreview, paint, pickSession, preferredSid, sidFromDir } from "../src/core/hunkModel";

const h = (index: number, new_start: number, new_lines: number, old_lines = 1, old_text = "old\n"): AgentHunk => ({
  id: "h" + index, index, kind: new_lines ? (old_lines ? "mod" : "add") : "del", old_start: new_start, old_lines, new_start, new_lines, old_text, new_text: "",
});

describe("agent hunks", () => {
  it("maps folder names back to session keys", () => {
    expect(sidFromDir("claude-code__0a1b")).toBe("claude-code:0a1b");
    expect(sidFromDir("plain")).toBe("plain");
  });

  it("picks the session that has a baseline for the file, newest first, the IDE's own session over all", () => {
    const ix = [
      { sid: "claude-code:old", root: "/p", files: { "a.py": { captured_at: 100 } }, mtime: 100_000 },
      { sid: "codex:new", root: "/p", files: { "a.py": { captured_at: 200 }, "b.py": {} }, mtime: 200_000 },
      { sid: "claude-code:sub", root: "/p/sub", files: { "c.py": {} }, mtime: 1 },
    ];
    expect(pickSession(ix, "/p/a.py")).toEqual({ sid: "codex:new", root: "/p", key: "a.py" });
    expect(pickSession(ix, "/p/a.py", "claude-code:old")?.sid).toBe("claude-code:old");
    expect(pickSession(ix, "/p/sub/c.py")).toEqual({ sid: "claude-code:sub", root: "/p/sub", key: "c.py" });
    expect(pickSession(ix, "/p/c.py")).toBeUndefined();
    expect(pickSession(ix, "/px/a.py")).toBeUndefined();
  });

  it("paints added lines, removal markers and a lens per hunk", () => {
    const hs = [h(1, 2, 3), h(2, 8, 0, 2), h(3, 50, 1)];
    expect(paint(hs, 20)).toEqual({ added: [[1, 3], [19, 19]], removedAt: [7], lens: [1, 7, 19] });
  });

  it("finds the hunk under the cursor and the next / previous one", () => {
    const hs = [h(1, 2, 3), h(2, 8, 0, 2), h(3, 20, 1)];
    expect(hunkAt(hs, 3)?.index).toBe(1);
    expect(hunkAt(hs, 7)?.index).toBe(2); // a removal sits on one line
    expect(hunkAt(hs, 10)?.index).toBe(3);
    expect(hunkAt(hs, 40)?.index).toBe(1);
    expect(nextHunk(hs, 0, 1)?.index).toBe(1);
    expect(nextHunk(hs, 1, 1)?.index).toBe(2);
    expect(nextHunk(hs, 25, 1)?.index).toBe(1);
    expect(nextHunk(hs, 9, -1)?.index).toBe(2);
    expect(nextHunk(hs, 0, -1)?.index).toBe(3);
    expect(nextHunk([], 0, 1)).toBeUndefined();
  });

  it("cuts long old text for the hover", () => {
    const long = h(1, 1, 1, 40, Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n");
    const p = oldPreview(long, 3).split("\n");
    expect(p).toEqual(["l0", "l1", "l2", "… (+37)"]);
  });

  it("prefers the session the IDE was opened for in this folder, not the server's first one", () => {
    const opened = { "/p": { sid: "codex:second", at: 2 }, "/p/sub": { sid: "claude-code:inner", at: 3 }, "/q": { sid: "", at: 1 } };
    expect(preferredSid(opened, "/p/a.py", "claude-code:first")).toBe("codex:second");
    expect(preferredSid(opened, "/p/sub/b.py", "claude-code:first")).toBe("claude-code:inner");
    // opened with no session: no preference (the newest baseline wins), not the stale env value
    expect(preferredSid(opened, "/q/c.py", "claude-code:first")).toBe("");
    expect(preferredSid(opened, "/elsewhere/d.py", "claude-code:first")).toBe("claude-code:first");
    expect(preferredSid(undefined, "/p/a.py", "x")).toBe("x");
    const ix = [
      { sid: "claude-code:first", root: "/p", files: { "a.py": { captured_at: 10 } }, mtime: 0 },
      { sid: "codex:second", root: "/p", files: { "a.py": { captured_at: 20 } }, mtime: 0 },
    ];
    expect(pickSession(ix, "/p/a.py", preferredSid(opened, "/p/a.py", "claude-code:first"))?.sid).toBe("codex:second");
  });
});
