import { describe, expect, it } from "vitest";
import { inlineDiff, pairRows, patchRows, diffStat, collapse, codexPatchRows, diffOfTool, diffRows, relPath, type DiffRow } from "./diff";
type Line = Extract<DiffRow, { kind: "same" | "add" | "del" }>;
type Skip = Extract<DiffRow, { kind: "skip" }>;

describe("inlineDiff", () => {
  it("marks only the changed words", () => {
    const d = inlineDiff("const a = 1;", "const b = 1;");
    expect(d.a.filter((s) => s.changed).map((s) => s.text)).toEqual(["a"]);
    expect(d.b.filter((s) => s.changed).map((s) => s.text)).toEqual(["b"]);
  });
  it("gives up on lines that changed almost entirely", () => {
    const d = inlineDiff("hello world", "完全不同的一行内容");
    expect(d.a.every((s) => !s.changed)).toBe(true);
  });
});

describe("pairRows", () => {
  it("numbers both sides and attaches word segments to replaced lines", () => {
    const rows = pairRows("x = 1\ny = 2\nz = 3", "x = 1\ny = 20\nz = 3");
    const del = rows.find((r) => r.kind === "del") as Line;
    const add = rows.find((r) => r.kind === "add") as Line;
    expect(del.oldNo).toBe(2); expect(del.newNo).toBeNull();
    expect(add.newNo).toBe(2);
    expect(add.segs?.some((s) => s.changed && s.text.includes("20"))).toBe(true);
  });
  it("collapses far-away unchanged lines into a skip", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const full = pairRows(old, old.replace("l15", "L15"));
    const rows = collapse(full, 2);
    const skips = rows.filter((r) => r.kind === "skip") as Skip[];
    expect(skips.length).toBe(2);
    expect(skips[0]).toEqual({ kind: "skip", count: 13, start: 0 });
    expect(diffStat(rows)).toEqual({ add: 1, del: 1 });
    expect(collapse(full, 2, new Set([0])).filter((r) => r.kind === "skip").length).toBe(1);
  });
});

describe("patchRows", () => {
  it("reads real line numbers from hunk headers", () => {
    const rows = patchRows("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -10,3 +10,3 @@ fn\n ctx\n-old line\n+new line\n ctx2\n");
    const same = rows.filter((r) => r.kind === "same") as Line[];
    expect(same[0].oldNo).toBe(10); expect(same[1].newNo).toBe(12);
    const del = rows.find((r) => r.kind === "del") as Line;
    expect(del.oldNo).toBe(11);
    expect(del.segs?.filter((s) => s.changed).map((s) => s.text)).toEqual(["old"]);
  });
});

describe("codexPatchRows", () => {
  it("reads a Codex apply_patch DSL block (no numbered @@ headers)", () => {
    const rows = codexPatchRows("*** Begin Patch\n*** Update File: x/y.py\n@@ def foo():\n context\n-old line\n+new line\n*** End Patch");
    expect(rows[0]).toEqual({ kind: "hunk", text: "*** Update File: x/y.py" });
    expect(rows[1]).toEqual({ kind: "hunk", text: "@@ def foo():" });
    const same = rows.find((r) => r.kind === "same") as Line;
    expect(same.text).toBe("context");
    const del = rows.find((r) => r.kind === "del") as Line;
    const add = rows.find((r) => r.kind === "add") as Line;
    expect(del.text).toBe("old line"); expect(add.text).toBe("new line");
  });
});

describe("diffOfTool", () => {
  it("reads Claude Code's Edit", () => {
    const d = diffOfTool("Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" });
    expect(d).toEqual({ kind: "pair", path: "/x/a.ts", old: "a", new: "b", truncated: false });
  });
  it("reads MultiEdit's edits[]", () => {
    const d = diffOfTool("MultiEdit", { file_path: "/x/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] });
    expect(d).toEqual({ kind: "edits", path: "/x/a.ts", edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }], truncated: false });
  });
  it("reads Write as an all-added file, and carries the truncated flag through", () => {
    const d = diffOfTool("Write", { file_path: "/x/a.ts", content: "hi", truncated: true });
    expect(d).toEqual({ kind: "write", path: "/x/a.ts", new: "hi", truncated: true });
  });
  it("reads pi's lowercase edit (oldText/newText)", () => {
    const d = diffOfTool("edit", { path: "/x/a.ts", oldText: "a", newText: "b" });
    expect(d).toEqual({ kind: "pair", path: "/x/a.ts", old: "a", new: "b", truncated: false });
  });
  it("reads Codex apply_patch and pulls the touched paths out of the patch text", () => {
    const patch = "*** Begin Patch\n*** Update File: x/y.py\n-a\n+b\n*** End Patch";
    const d = diffOfTool("apply_patch", { input: patch });
    expect(d).toEqual({ kind: "patch", path: "x/y.py", text: patch, truncated: false });
  });
  it("strips a namespaced tool name before matching", () => {
    const d = diffOfTool("functions.apply_patch", { input: "*** Begin Patch\n*** End Patch" });
    expect(d?.kind).toBe("patch");
  });
  it("returns null for a tool with nothing to diff", () => {
    expect(diffOfTool("Bash", { command: "ls" })).toBeNull();
    expect(diffOfTool("Edit", { file_path: "/x/a.ts" })).toBeNull();
  });
});

describe("diffRows", () => {
  it("gives one block per MultiEdit hunk, labeled", () => {
    const blocks = diffRows({ kind: "edits", path: "/x", edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }], truncated: false });
    expect(blocks.map((b) => b.label)).toEqual(["第 1 处", "第 2 处"]);
    expect(diffStat(blocks[0].rows)).toEqual({ add: 1, del: 1 });
  });
  it("treats a write as all lines added", () => {
    const blocks = diffRows({ kind: "write", path: "/x", new: "a\nb", truncated: false });
    expect(diffStat(blocks[0].rows)).toEqual({ add: 2, del: 0 });
  });
});

describe("relPath", () => {
  it("strips the session cwd prefix", () => {
    expect(relPath("/Users/x/proj/app/cli/move.py", "/Users/x/proj")).toBe("app/cli/move.py");
  });
  it("leaves a path outside cwd (or with no cwd) alone", () => {
    expect(relPath("/etc/hosts", "/Users/x/proj")).toBe("/etc/hosts");
    expect(relPath("/etc/hosts")).toBe("/etc/hosts");
  });
});
