import { describe, expect, it } from "vitest";
import { buildFimRequest, cleanCompletion, clipPrefix, clipSuffix, costUsd, estimateUsage, headerComment, parseFimResponse, shouldTrigger } from "../src/core/fim";

describe("FIM request", () => {
  it("keeps whole lines when it clips the prefix and suffix", () => {
    const text = "aaaa\nbbbb\ncccc\ndddd\n";
    expect(clipPrefix(text, 12, 7)).toBe("cc"); // "bbbb\ncc" starts mid-line: drop to the next line
    expect(clipPrefix(text, 4, 7)).toBe("aaaa");
    expect(clipSuffix(text, 0, 12)).toBe("aaaa\nbbbb\n");
    expect(clipSuffix(text, 15, 100)).toBe("dddd\n");
  });

  it("asks for one line mid-line and a block on an empty line", () => {
    const text = "def add(a, b):\n    return a\n\nx = ad";
    const mid = buildFimRequest({ relPath: "m.py", languageId: "python", text, offset: text.length }, "deepseek-flash");
    expect(mid.multiline).toBe(false);
    expect(mid.body).toMatchObject({ model: "deepseek-flash", max_tokens: 64, stop: ["\n"], temperature: 0, suffix: "" });
    expect(mid.body.prompt.startsWith("# Path: m.py\n")).toBe(true);
    expect(mid.linePrefix).toBe("x = ad");
    const blank = buildFimRequest({ relPath: "m.py", languageId: "python", text: "def f():\n    \n", offset: 13 }, "m");
    expect(blank.multiline).toBe(true);
    expect(blank.body.max_tokens).toBe(160);
    expect(blank.body.stop).toEqual(["\n\n"]);
    expect(blank.body.suffix).toBe("\n");
  });

  it("uses the language's comment for the path header", () => {
    expect(headerComment("a.ts", "typescript")).toBe("// Path: a.ts\n");
    expect(headerComment("a.sql", "sql")).toBe("-- Path: a.sql\n");
    expect(headerComment("a.md", "markdown")).toBe("<!-- Path: a.md -->\n");
    expect(headerComment("a.json", "json")).toBe("");
  });

  it("triggers after words, dots, brackets and fresh lines, not mid-word", () => {
    expect(shouldTrigger("foo.", "", false)).toBe(true);
    expect(shouldTrigger("print(", ")", false)).toBe(true);
    expect(shouldTrigger("    ", "", false)).toBe(true);
    expect(shouldTrigger("return ", "", false)).toBe(true);
    expect(shouldTrigger("x = 1;", "", false)).toBe(false);
    expect(shouldTrigger("a  ", "", false)).toBe(false);
    expect(shouldTrigger("fo", "o()", false)).toBe(false);
    expect(shouldTrigger("x = 1;", "", true)).toBe(true);
  });
});

describe("FIM answer", () => {
  it("cleans the completion", () => {
    expect(cleanCompletion("b)\nnext line", ")", false)).toBe("b");
    expect(cleanCompletion("  return a + b  \n\n", "", true)).toBe("  return a + b");
    expect(cleanCompletion("   \n", "", true)).toBe("");
    expect(cleanCompletion("x\r\ny", "", true)).toBe("x\ny");
  });

  it("reads usage including the cache hits", () => {
    const r = parseFimResponse({ choices: [{ text: "abc" }], usage: { prompt_tokens: 1500, completion_tokens: 50, prompt_cache_hit_tokens: 1000 } });
    expect(r).toEqual({ text: "abc", usage: { prompt_tokens: 1500, cached_tokens: 1000, completion_tokens: 50 } });
    expect(parseFimResponse({})).toEqual({ text: "", usage: { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 } });
  });

  it("prices like ide.tab_usd (peak prices)", () => {
    // (1500 * 0.30 + 50 * 1.20) / 1e6
    expect(costUsd({ prompt_tokens: 1500, cached_tokens: 0, completion_tokens: 50 })).toBeCloseTo(0.00051, 10);
    // 500 misses at 0.30, 1000 hits at 0.006, 50 out at 1.20
    expect(costUsd({ prompt_tokens: 1500, cached_tokens: 1000, completion_tokens: 50 })).toBeCloseTo((500 * 0.3 + 1000 * 0.006 + 50 * 1.2) / 1e6, 12);
  });

  it("estimates a request before its answer at no less than it can cost", () => {
    const text = "def f(x):\n    return x\n".repeat(200);
    const req = buildFimRequest({ relPath: "a.py", languageId: "python", text, offset: 3000 }, "deepseek-flash");
    const est = estimateUsage(req.body);
    expect(est.completion_tokens).toBe(req.body.max_tokens);
    expect(est.cached_tokens).toBe(0);
    // code runs about 3.5 characters per token: the estimate is above the real prompt tokens
    expect(est.prompt_tokens).toBeGreaterThanOrEqual(Math.ceil((req.body.prompt.length + req.body.suffix.length) / 3.5));
    expect(costUsd(est)).toBeGreaterThan(costUsd({ prompt_tokens: Math.ceil((req.body.prompt.length + req.body.suffix.length) / 3.5), cached_tokens: 0, completion_tokens: 20 }));
  });
});
