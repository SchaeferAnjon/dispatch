import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerCache, assistantArgs, retryTimeout } from "../src/core/assistant";

describe("assistant", () => {
  it("only reads", () => {
    expect(assistantArgs(undefined)).toEqual(["assistant", "--json", "--quick"]);
    expect(assistantArgs("status")).toEqual(["assistant", "--json", "--quick"]);
    expect(assistantArgs("overview")).toBeUndefined(); // the Running tab is gone; the Assistant reads `dispatch assistant overview` itself
    expect(assistantArgs("reset")).toBeUndefined();
    expect(assistantArgs("send")).toBeUndefined();
    expect(assistantArgs("home")).toBeUndefined(); // the Mac's Assistant home went 2026-11-11 (task-0v1o9)
    expect(assistantArgs("now", "opencode:/abc-123")).toBeUndefined();
  });
});

describe("the status on a busy Mac (the Assistant could not start: dispatch assistant --json timed out)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const timeout = () => Object.assign(new Error("dispatch assistant --json timed out"), { code: "timeout" });

  it("the first question waits for the CLI, and its failure reaches the caller", async () => {
    let calls = 0;
    const get = answerCache(async () => { calls++; throw timeout(); }, { freshMs: 15000, waitMs: 3000 });
    await expect(get()).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });

  it("an answer inside its window is given without asking again", async () => {
    let calls = 0;
    const get = answerCache(async () => ++calls, { freshMs: 15000, waitMs: 3000 });
    expect(await get()).toBe(1);
    vi.advanceTimersByTime(14000);
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
  });

  it("an older answer is given after three seconds while the CLI is still slow, and the CLI's late answer is kept for the next call", async () => {
    let release!: (n: number) => void;
    let calls = 0;
    const get = answerCache(() => { calls++; return calls === 1 ? Promise.resolve(1) : new Promise<number>(r => { release = r; }); }, { freshMs: 15000, waitMs: 3000 });
    expect(await get()).toBe(1);
    vi.advanceTimersByTime(20000);
    const second = get();
    vi.advanceTimersByTime(3000);
    expect(await second).toBe(1);
    // asked again while that run is still going: it is the same run
    const third = get();
    vi.advanceTimersByTime(3000);
    expect(await third).toBe(1);
    expect(calls).toBe(2);
    release(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(await get()).toBe(2);
  });

  it("an older answer is replaced at once when the new one comes inside the wait", async () => {
    let calls = 0;
    const get = answerCache(async () => ++calls, { freshMs: 15000, waitMs: 3000 });
    expect(await get()).toBe(1);
    vi.advanceTimersByTime(20000);
    expect(await get()).toBe(2);
  });

  it("a failed refresh gives the older answer and the next call asks again", async () => {
    let calls = 0;
    const get = answerCache(async () => { calls++; if (calls === 2) throw timeout(); return calls; }, { freshMs: 15000, waitMs: 3000 });
    expect(await get()).toBe(1);
    vi.advanceTimersByTime(20000);
    expect(await get()).toBe(1);
    expect(await get()).toBe(3);
  });

  it("a run that timed out is run once more; other failures are not", async () => {
    let calls = 0;
    expect(await retryTimeout(async () => { calls++; if (calls === 1) throw timeout(); return "ok"; })).toBe("ok");
    expect(calls).toBe(2);
    let n = 0;
    await expect(retryTimeout(async () => { n++; throw Object.assign(new Error("no dispatch"), { code: "spawn" }); })).rejects.toThrow("no dispatch");
    expect(n).toBe(1);
    let m = 0;
    await expect(retryTimeout(async () => { m++; throw timeout(); })).rejects.toThrow(/timed out/);
    expect(m).toBe(2);
  });
});
