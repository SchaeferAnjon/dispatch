// The task board's changes, pushed (app/cli/board_service.py in chatd): the Agents window's board views
// (Waiting for you, Tasks, Projects, the session's life card; Dispatch IDE patches/dispatch-board-push.patch)
// refresh when the board changed instead of asking every few seconds.
//
// One connection to chatd's door as a board client ({"board": 1}): it gets only `board_changed` events.
// A burst of changes becomes one refresh (core/board.ts Coalescer). While there is no connection the
// views keep their old timers (`live: false`). No chatd yet: `dispatch chatd ensure` starts the resident
// one once (it also serves the board for every `dispatch` an Agent runs), then this tries again.
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { dispatchDir, log, run } from "./cli";
import { asChange, BoardChange, boardDoor, Coalescer, helloLines, noteBoardChange, splitLines } from "./core/board";

const WORKBENCH_COMMAND = "_dispatch.board.changed";
const RETRY_MS = 3000;
const ENSURE_AFTER_MS = 4000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readDoor() {
  try {
    return boardDoor(JSON.parse(fs.readFileSync(path.join(dispatchDir(), "chatd.json"), "utf8")), alive);
  } catch {
    return null;
  }
}

export class BoardWatch implements vscode.Disposable {
  private sock: net.Socket | null = null;
  private buf = "";
  private retry: NodeJS.Timeout | undefined;
  private closed = false;
  private live = false;
  private ensured = false;
  private noDoorSince = 0;
  private missingCommand = false;
  private coalescer = new Coalescer((c) => this.tell(c), {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as NodeJS.Timeout),
    now: () => Date.now(),
  });

  constructor() {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const door = readDoor();
    if (!door) {
      this.setLive(false);
      if (!this.noDoorSince) this.noDoorSince = Date.now();
      if (!this.ensured && Date.now() - this.noDoorSince >= ENSURE_AFTER_MS) {
        // nobody started chatd (no Codex session yet, no phone paired): start the resident one once
        this.ensured = true;
        log("board: no board service yet, starting chatd");
        void run(["chatd", "ensure"], { timeoutMs: 20000 }).then(
          (r) => log(`board: chatd ensure → ${r.code}${r.code ? " " + r.stderr.trim().slice(-200) : ""}`),
          (e) => log(`board: chatd ensure failed: ${(e as Error).message}`),
        );
      }
      this.later();
      return;
    }
    this.noDoorSince = 0;
    const s = net.connect(door.port, "127.0.0.1");
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => s.write(helloLines(door)));
    s.on("data", (chunk: string) => {
      const { lines, rest } = splitLines(this.buf + chunk);
      this.buf = rest;
      for (const line of lines) {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const m = msg as { rid?: string; ok?: boolean; rev?: number };
        if (m.rid === "watch" && m.ok) {
          log(`board: watching changes (rev ${m.rev ?? 0})`);
          this.setLive(true);
          continue;
        }
        const c = asChange(msg);
        if (c) {
          noteBoardChange(); // a read already running is from before this change: do not share it
          this.coalescer.push(c);
        }
      }
    });
    const gone = () => {
      if (this.sock !== s) return;
      this.sock = null;
      this.buf = "";
      this.setLive(false);
      this.later();
    };
    s.on("error", (e) => log(`board: ${e.message}`));
    s.on("close", gone);
  }

  private later() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, RETRY_MS);
  }

  private setLive(live: boolean) {
    if (this.live === live) return;
    this.live = live;
    noteBoardChange();
    // going live: one refresh, the views may have missed changes while nothing was pushed
    void this.send({ live, rev: 0, ids: [], kv: true, issues: true, all: true });
  }

  private tell(c: BoardChange) {
    void this.send({ live: this.live, ...c });
  }

  private async send(arg: { live: boolean } & BoardChange) {
    try {
      await vscode.commands.executeCommand(WORKBENCH_COMMAND, arg);
    } catch (e) {
      // a Dispatch IDE without the push patch: its views keep their timers
      if (!this.missingCommand) log(`board: ${WORKBENCH_COMMAND}: ${(e as Error).message}`);
      this.missingCommand = true;
    }
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.retry);
    this.coalescer.dispose();
    this.sock?.destroy();
  }
}

export function registerBoard(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(new BoardWatch());
}
