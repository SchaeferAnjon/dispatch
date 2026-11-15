import { describe, expect, it } from "vitest";
import { asChange, boardDoor, Coalescer, helloLines, merge, splitLines, type BoardChange } from "../src/core/board";

const reg = { pid: 42, door: { port: 5555, token: "t0k" }, board: { ready: true, beads_dir: "/b", protocol: 1 } };

describe("board door", () => {
  it("only a live chatd that serves the board", () => {
    expect(boardDoor(reg, () => true)).toEqual({ port: 5555, token: "t0k" });
    expect(boardDoor(reg, () => false)).toBeNull();
    expect(boardDoor({ ...reg, board: undefined }, () => true)).toBeNull(); // an older chatd
    expect(boardDoor({ ...reg, door: { port: "x" } }, () => true)).toBeNull();
    expect(boardDoor(null, () => true)).toBeNull();
  });
  it("says hello as a board client and subscribes", () => {
    const [a, b] = helloLines({ port: 1, token: "t" }).trim().split("\n").map((l) => JSON.parse(l));
    expect(a).toEqual({ token: "t", board: 1 });
    expect(b).toEqual({ cmd: "board.watch", rid: "watch" });
  });
  it("splits whole lines and keeps the rest", () => {
    expect(splitLines('{"a":1}\n\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
  });
  it("reads change events and nothing else", () => {
    expect(asChange({ ev: "board_changed", rev: 3, ids: ["task-a", 5], kv: true, issues: false, all: false })).toEqual({
      rev: 3, ids: ["task-a"], kv: true, issues: false, all: false,
    });
    expect(asChange({ ev: "turn_done" })).toBeNull();
  });
  it("merges two changes", () => {
    const a: BoardChange = { rev: 1, ids: ["x"], kv: false, issues: true, all: false };
    const b: BoardChange = { rev: 2, ids: ["x", "y"], kv: true, issues: false, all: false };
    expect(merge(a, b)).toEqual({ rev: 2, ids: ["x", "y"], kv: true, issues: true, all: false });
  });
});

class FakeTimers {
  t = 0;
  next = 1;
  jobs = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const h = this.next++;
    this.jobs.set(h, { at: this.t + ms, fn });
    return h;
  };
  clear = (h: unknown) => void this.jobs.delete(h as number);
  now = () => this.t;
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = due[1].at;
      this.jobs.delete(due[0]);
      due[1].fn();
    }
    this.t = end;
  }
}

describe("coalescer", () => {
  const ch = (rev: number, id: string): BoardChange => ({ rev, ids: [id], kv: false, issues: true, all: false });

  it("a burst becomes one refresh after a quiet moment", () => {
    const timers = new FakeTimers();
    const fired: BoardChange[] = [];
    const c = new Coalescer((x) => fired.push(x), timers, 400, 3000);
    for (let i = 1; i <= 5; i++) {
      c.push(ch(i, "task-" + i));
      timers.advance(100);
    }
    expect(fired).toHaveLength(0);
    timers.advance(400);
    expect(fired).toHaveLength(1);
    expect(fired[0].rev).toBe(5);
    expect(fired[0].ids).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
  });

  it("a change every 200 ms still refreshes at least every 3 s", () => {
    const timers = new FakeTimers();
    const fired: number[] = [];
    const c = new Coalescer(() => fired.push(timers.now()), timers, 400, 3000);
    for (let i = 0; i < 50; i++) {
      c.push(ch(i, "task-a"));
      timers.advance(200);
    }
    expect(fired.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < fired.length; i++) expect(fired[i] - fired[i - 1]).toBeLessThanOrEqual(3200);
  });
});

describe("shared reads", () => {
  it("share a running read, but not across a board change", async () => {
    const { sharedRuns, noteBoardChange } = await import("../src/core/board");
    const run = sharedRuns<number>();
    let started = 0;
    const resolvers: ((v: number) => void)[] = [];
    const start = () => { started++; return new Promise<number>((r) => resolvers.push(r)); };
    const a = run("k", start);
    const b = run("k", start);
    expect(started).toBe(1);
    noteBoardChange();
    const c = run("k", start);
    expect(started).toBe(2);
    resolvers[0](1);
    resolvers[1](2);
    expect([await a, await b, await c]).toEqual([1, 1, 2]);
    const d = run("k", start); // nothing running any more: a new read
    expect(started).toBe(3);
    resolvers[2](3);
    expect(await d).toBe(3);
  });
});
