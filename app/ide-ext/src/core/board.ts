// The task board's change events (app/cli/board_service.py in chatd), without vscode: which door to
// knock on, how lines are split, and how a burst of changes becomes one refresh.

export interface BoardDoor {
  port: number;
  token: string;
}

/** chatd.json's door when that chatd runs the board service, else null (an older chatd, or none). */
export function boardDoor(reg: unknown, alive: (pid: number) => boolean): BoardDoor | null {
  if (!reg || typeof reg !== "object") return null;
  const r = reg as { pid?: unknown; door?: { port?: unknown; token?: unknown }; board?: { ready?: unknown } };
  if (typeof r.pid !== "number" || !alive(r.pid)) return null;
  if (!r.board || r.board.ready !== true) return null;
  const d = r.door;
  if (!d || typeof d.port !== "number" || typeof d.token !== "string" || !d.token) return null;
  return { port: d.port, token: d.token };
}

/** What the first line and the subscription say. */
export function helloLines(door: BoardDoor): string {
  return JSON.stringify({ token: door.token, board: 1 }) + "\n" + JSON.stringify({ cmd: "board.watch", rid: "watch" }) + "\n";
}

/** Whole lines out of `buf`; the unfinished end stays for the next chunk. */
export function splitLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) lines.push(line);
  }
  return { lines, rest: buf };
}

export interface BoardChange {
  rev: number;
  ids: string[];
  kv: boolean;
  issues: boolean;
  all: boolean;
}

/** A board_changed event as sent by the service, or null for anything else. */
export function asChange(msg: unknown): BoardChange | null {
  if (!msg || typeof msg !== "object" || (msg as { ev?: unknown }).ev !== "board_changed") return null;
  const m = msg as Record<string, unknown>;
  return {
    rev: typeof m.rev === "number" ? m.rev : 0,
    ids: Array.isArray(m.ids) ? m.ids.filter((x): x is string => typeof x === "string") : [],
    kv: m.kv === true,
    issues: m.issues === true,
    all: m.all === true,
  };
}

export function merge(a: BoardChange | null, b: BoardChange): BoardChange {
  if (!a) return { ...b, ids: [...b.ids] };
  const ids = a.ids.concat(b.ids.filter((x) => !a.ids.includes(x))).slice(0, 500);
  return { rev: Math.max(a.rev, b.rev), ids, kv: a.kv || b.kv, issues: a.issues || b.issues, all: a.all || b.all };
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
  now(): number;
}

/** Many changes in a row (ten Agents logging) become one refresh: it fires `quietMs` after the last
 *  change, and at least every `maxWaitMs` while changes keep coming, so the views never fall far behind. */
export class Coalescer {
  private pending: BoardChange | null = null;
  private timer: unknown;
  private first = 0;
  constructor(
    private fire: (c: BoardChange) => void,
    private timers: Timers,
    private quietMs = 400,
    private maxWaitMs = 3000,
  ) {}

  push(c: BoardChange) {
    if (!this.pending) this.first = this.timers.now();
    this.pending = merge(this.pending, c);
    if (this.timer !== undefined) this.timers.clear(this.timer);
    const left = Math.max(0, Math.min(this.quietMs, this.first + this.maxWaitMs - this.timers.now()));
    this.timer = this.timers.set(() => this.flush(), left);
  }

  flush() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    const c = this.pending;
    this.pending = null;
    if (c) this.fire(c);
  }

  dispose() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.pending = null;
  }
}

// ---- reads shared while they run -------------------------------------------------------------------
// The views share a running `dispatch …` read (two refreshes at once run the CLI once). A refresh that a
// board change triggered must not join a read that started before the change: it would show the board
// as it was. Every change bumps the revision; a running read is shared only within its revision.

let revision = 0;

export function boardRevision(): number {
  return revision;
}

export function noteBoardChange(): void {
  revision++;
}

/** `run(key, start)`: the read already running for `key` when the board has not changed since it started, else a new one. */
export function sharedRuns<T = unknown>() {
  const running = new Map<string, { rev: number; p: Promise<T> }>();
  return (key: string, start: () => Promise<T>): Promise<T> => {
    const cur = running.get(key);
    if (cur && cur.rev === revision) return cur.p;
    const entry = { rev: revision, p: undefined as unknown as Promise<T> };
    entry.p = start().finally(() => {
      if (running.get(key) === entry) running.delete(key);
    });
    running.set(key, entry);
    return entry.p;
  };
}
