import { describe, expect, it } from "vitest";
import { parseCheckpoints, parsePlan, parseRestore } from "../src/core/checkpointModel";

describe("checkpoints", () => {
  it("says unavailable while the CLI is a placeholder", () => {
    expect(parseCheckpoints({ ok: false, error: "unsupported" })).toEqual({ available: false, reason: "unsupported" });
    expect(parseCheckpoints({ ok: true })).toEqual({ available: false, reason: "unsupported" });
  });

  it("reads turns in any of the shapes, newest first", () => {
    const rows = [
      { turn_id: "t1", message_id: "m1", ts: 1000, files_changed: ["a.py", { path: "b.py" }], text: "first" },
      { turn_id: "t2", ts: 2000000000000, files: [] },
      { nope: 1 },
    ];
    for (const ans of [{ ok: true, turns: rows }, { checkpoints: rows }, rows]) {
      const r = parseCheckpoints(ans);
      expect(r.available).toBe(true);
      if (!r.available) continue;
      expect(r.turns.map((t) => t.id)).toEqual(["t2", "t1"]);
      expect(r.turns[0].ts).toBe(2000000000);
      expect(r.turns[1]).toMatchObject({ messageId: "m1", files: ["a.py", "b.py"], text: "first" });
    }
  });

  it("tells a conflict from other failures", () => {
    expect(parseRestore({ ok: true, restored: ["a.py"] })).toEqual({ ok: true, files: ["a.py"] });
    expect(parseRestore({ ok: false, error: "conflict", files: ["a.py"] })).toEqual({ ok: false, conflict: true, files: ["a.py"], message: "conflict" });
    expect(parseRestore({ ok: false, error: "no_turn", message: "gone" })).toMatchObject({ ok: false, conflict: false, message: "gone" });
  });

  it("reads the dry run: every file the restore touches, conflicts first, and who is running", () => {
    // restoring to before turn 1 also undoes turn 2 (b_module.py, c.py): the modal must list them
    const p = parsePlan({
      ok: true,
      dry_run: true,
      files: [
        { path: "a.txt", action: "restore" },
        { path: "b_module.py", action: "delete" },
        { path: "c.py", action: "delete" },
        { path: "notes.md", action: "delete" },
      ],
      conflicts: ["notes.md"],
      unsure: ["notes.md"],
      running: [],
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows.map((r) => [r.path, r.action, r.conflict, r.unsure])).toEqual([
      ["notes.md", "delete", true, true],
      ["a.txt", "restore", false, false],
      ["b_module.py", "delete", false, false],
      ["c.py", "delete", false, false],
    ]);
    expect(p.conflicts).toBe(1);
    expect(parsePlan({ ok: true, files: [], conflicts: [], running: ["claude-code:x"] })).toMatchObject({ ok: true, running: ["claude-code:x"] });
    expect(parsePlan({ ok: false, error: "no_such_turn", message: "gone" })).toEqual({ ok: false, message: "gone" });
  });
});
