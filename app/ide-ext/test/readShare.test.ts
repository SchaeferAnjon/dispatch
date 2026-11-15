import { describe, expect, it } from "vitest";
import { ReadShare, readKey } from "../src/core/readShare";

/** A call to the CLI we resolve by hand. */
function fake() {
  const calls: { resolve: (v: string) => void; reject: (e: Error) => void }[] = [];
  const start = () => new Promise<string>((resolve, reject) => { calls.push({ resolve, reject }); });
  return { calls, start };
}

describe("which calls are reads", () => {
  it("knows the polled questions", () => {
    for (const a of [
      ["waiting", "--json"], ["inbox", "list", "--limit", "40"], ["build", "queue", "--json"], ["accounts", "watch", "--json"],
      ["turbo", "list", "--json"], ["capture", "list", "--json"], ["session", "life", "claude-code:abc", "--json"],
      ["projects", "--sidebar", "--json"], ["awake", "--json"], ["busy", "--json"], ["sessions", "--json"], ["attribution", "steps", "--host-session", "x"],
    ]) expect(readKey(a), a.join(" ")).toBeDefined();
  });
  it("never takes a call that changes something", () => {
    for (const a of [
      ["waiting", "pick", "ide:x", "A", "--json"], ["waiting", "done", "task-1", "--json"], ["waiting", "read", "--all", "--json"],
      ["inbox", "read", "x"], ["turbo", "start", "r"], ["accounts", "use", "claude", "a"], ["awake", "--set", "display"],
      ["usage", "--record", "--json"], ["build", "retry", "x"], ["log", "x"],
    ]) expect(readKey(a), a.join(" ")).toBeUndefined();
  });
  it("tells folders and arguments apart", () => {
    expect(readKey(["session", "life", "a"])).not.toBe(readKey(["session", "life", "b"]));
    expect(readKey(["waiting", "--json"], "/x")).not.toBe(readKey(["waiting", "--json"], "/y"));
  });
});

describe("sharing a read", () => {
  it("runs the CLI once for ten askers at the same time", async () => {
    const f = fake();
    const s = new ReadShare<string>(() => 0, () => 0);
    const k = readKey(["waiting", "--json"]);
    const all = Array.from({ length: 10 }, () => s.run(k, f.start));
    expect(f.calls.length).toBe(1);
    f.calls[0].resolve("rows");
    expect(await Promise.all(all)).toEqual(Array(10).fill("rows"));
  });
  it("keeps the answer for the next asker for a moment, then asks again", async () => {
    let now = 0;
    const f = fake();
    const s = new ReadShare<string>(() => now, () => 0, 1500);
    const k = readKey(["build", "queue", "--json"]);
    const a = s.run(k, f.start);
    f.calls[0].resolve("q1");
    await a;
    now = 1000;
    expect(await s.run(k, f.start)).toBe("q1");
    expect(f.calls.length).toBe(1);
    now = 1600;
    void s.run(k, f.start);
    expect(f.calls.length).toBe(2);
  });
  it("different questions run side by side", () => {
    const f = fake();
    const s = new ReadShare<string>(() => 0, () => 0);
    void s.run(readKey(["waiting", "--json"]), f.start);
    void s.run(readKey(["build", "queue", "--json"]), f.start);
    expect(f.calls.length).toBe(2);
  });
  it("a board change ends the sharing: that read must see the change", async () => {
    let rev = 0;
    const f = fake();
    const s = new ReadShare<string>(() => 0, () => rev);
    const k = readKey(["waiting", "--json"]);
    void s.run(k, f.start);
    rev = 1;
    void s.run(k, f.start);
    expect(f.calls.length).toBe(2);
    f.calls[1].resolve("new");
    await Promise.resolve();
    expect(await s.run(k, f.start)).toBe("new");
    expect(f.calls.length).toBe(2);
  });
  it("a write ends the sharing, while it runs and after it", async () => {
    const f = fake();
    const w = fake();
    const s = new ReadShare<string>(() => 0, () => 0);
    const k = readKey(["waiting", "--json"]);
    const first = s.run(k, f.start);
    const write = s.run(undefined, w.start);
    void s.run(k, f.start);
    expect(f.calls.length).toBe(2); // not the read that began before the write
    w.calls[0].resolve("ok");
    await write;
    void s.run(k, f.start);
    expect(f.calls.length).toBe(3); // nor the one that began during it
    f.calls[0].resolve("old");
    expect(await first).toBe("old");
  });
  it("a failed read is not kept: the next asker starts again", async () => {
    const f = fake();
    const s = new ReadShare<string>(() => 0, () => 0);
    const k = readKey(["accounts", "watch", "--json"]);
    const a = s.run(k, f.start);
    f.calls[0].reject(new Error("timed out"));
    await expect(a).rejects.toThrow("timed out");
    void s.run(k, f.start);
    expect(f.calls.length).toBe(2);
  });
});
