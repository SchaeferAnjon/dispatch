import { describe, expect, it } from "vitest";
import { EDIT_MAX_LINES, contextFromHits, linesText, locate, parseInstruction, replaceLines, selectedLines, selectionTooLarge } from "../src/core/proposal";

describe("⌘K proposal", () => {
  it("covers whole lines and leaves out a line the selection only touches at column 0", () => {
    expect(selectedLines({ startLine: 2, startCol: 4, endLine: 2, endCol: 4 })).toEqual({ start: 2, end: 2 });
    expect(selectedLines({ startLine: 1, startCol: 0, endLine: 3, endCol: 0 })).toEqual({ start: 1, end: 2 });
    expect(selectedLines({ startLine: 1, startCol: 3, endLine: 3, endCol: 2 })).toEqual({ start: 1, end: 3 });
  });

  it("replaces the lines and keeps the rest", () => {
    const t = "a\nb\nc\nd";
    expect(linesText(t, { start: 1, end: 2 })).toBe("b\nc");
    expect(replaceLines(t, { start: 1, end: 2 }, "X\nY\nZ")).toBe("a\nX\nY\nZ\nd");
    expect(replaceLines(t, { start: 3, end: 3 }, "D")).toBe("a\nb\nc\nD");
  });

  it("finds the original lines again after edits elsewhere, nearest first", () => {
    const now = "new\nx\nb\nc\nq\nb\nc";
    expect(locate(now, "b\nc", 1)).toEqual({ start: 2, end: 3 });
    expect(locate(now, "b\nc", 6)).toEqual({ start: 5, end: 6 });
    expect(locate(now, "zz", 0)).toBeUndefined();
  });

  it("reads @codebase and picks context that is not the selection itself", () => {
    expect(parseInstruction("  @codebase use the helper")).toEqual({ instruction: "use the helper", codebase: true });
    expect(parseInstruction("rename x")).toEqual({ instruction: "rename x", codebase: false });
    const hits = [
      { path: "a.py", start: 1, end: 10, text: "self" },
      { path: "b.py", start: 5, end: 9, text: "other" },
      { path: "a.py", start: 40, end: 50, text: "far" },
    ];
    expect(contextFromHits(hits, "a.py", { start: 2, end: 4 }).map((h) => h.text)).toEqual(["other", "far"]);
    expect(contextFromHits(hits, "a.py", { start: 2, end: 4 }, 1).length).toBe(1);
  });

  it("refuses a selection too large for one rewrite (the answer would be cut off)", () => {
    expect(selectionTooLarge("x = 1\n".repeat(EDIT_MAX_LINES - 1))).toBe(false);
    expect(selectionTooLarge("x = 1\n".repeat(EDIT_MAX_LINES + 1))).toBe(true);
    expect(selectionTooLarge("x".repeat(20001))).toBe(true);
  });
});
