// One `dispatch …` read at a time per question (task-yocgz). Every `dispatch` call is a Python start that costs
// about 0.3 s of CPU, and the window asks the same few questions from several places (the board's push, each
// view's timer, a page opening): ten Agents writing the board made `waiting --json` start several times a second.
// A read that is already running for the same question is shared, and its answer is kept for `KEEP_MS` for the next
// asker. A read is only shared with one that started after the last change it could not have seen: any
// call that is not a read (an answer, a pick, a done) and every board change ends the sharing.

/** How long an answer stays good for the next asker. */
export const READ_KEEP_MS = 1500;

/** The questions that only look: `dispatch <these>` changes nothing, so asking twice at once is asking once. */
export function readKey(args: readonly string[], cwd?: string): string | undefined {
  const [cmd, sub] = args;
  let read = false;
  switch (cmd) {
    case "waiting":
      read = args.length === 2 && sub === "--json";
      break;
    case "inbox":
      read = sub === "list" || sub === "prefs";
      break;
    case "turbo":
      read = sub === "list" || sub === "timeline";
      break;
    case "build":
      read = sub === "queue";
      break;
    case "accounts":
      read = sub === "watch" || sub === "status" || sub === "list";
      break;
    case "capture":
      read = sub === "list";
      break;
    case "session":
      read = sub === "life";
      break;
    case "attribution":
      read = sub === "steps";
      break;
    case "engines":
      read = sub === "enabled" || sub === "status";
      break;
    case "mobile":
      read = sub === "status";
      break;
    case "projects":
      read = args.includes("--sidebar");
      break;
    case "awake":
    case "busy":
    case "sessions":
    case "sleep":
    case "machines":
    case "quota":
      read = !args.some((a) => a === "--set" || a === "--on" || a === "--off" || a === "--record");
      break;
  }
  return read ? `${cwd ?? ""}\u0000${args.join("\u0000")}` : undefined;
}

interface Entry<T> {
  epoch: number;
  rev: number;
  at: number;
  done: boolean;
  p: Promise<T>;
}

export class ReadShare<T = unknown> {
  private epoch = 0;
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly clock: () => number,
    private readonly revision: () => number,
    private readonly keepMs = READ_KEEP_MS,
  ) {}

  /** `start()` runs the CLI. A call that is not a read passes `key` undefined: it runs, and ends all sharing. */
  run(key: string | undefined, start: () => Promise<T>): Promise<T> {
    if (key === undefined) {
      this.epoch++;
      const p = start();
      // its answer is in the board only after it ends: reads that began meanwhile saw the old one
      const end = () => { this.epoch++; };
      p.then(end, end);
      return p;
    }
    const cur = this.entries.get(key);
    if (cur && cur.epoch === this.epoch && cur.rev === this.revision() && (!cur.done || this.clock() - cur.at < this.keepMs)) {
      return cur.p;
    }
    const entry: Entry<T> = { epoch: this.epoch, rev: this.revision(), at: 0, done: false, p: undefined as unknown as Promise<T> };
    entry.p = start().then(
      (v) => { entry.done = true; entry.at = this.clock(); return v; },
      (e) => { if (this.entries.get(key) === entry) this.entries.delete(key); throw e; },
    );
    this.entries.set(key, entry);
    if (this.entries.size > 100) {
      const now = this.clock();
      for (const [k, e] of this.entries) if (e.done && now - e.at >= this.keepMs) this.entries.delete(k);
    }
    return entry.p;
  }
}
