// dispatch.env: Settings › Keys (Dispatch IDE contrib/dispatchSettings/browser/dispatchSettingsKeys.ts) lists, shows,
// saves and deletes the keys in `dispatch env` (core/keys.ts builds the command lines). Values are never logged:
// only the operation and the exit code go into the log.
//
// ~/.dispatch/state/env-events.jsonl (DISPATCH_HOME wins) is watched: whoever saved or deleted a key (this page, an
// agent in a chat, a terminal), the window hears `_dispatch.envChanged` with what changed, shows "Key saved: NAME"
// with Show and Undo, and an open Keys page reads the list again.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, run, runAnswer } from "./cli";
import { keysCall, newKeyEvents } from "./core/keys";
import { dispatchHome } from "./knowledge";

const EVENTS = "env-events.jsonl";

function watchKeyEvents(ctx: vscode.ExtensionContext) {
  const dir = path.join(dispatchHome(), "state");
  const file = path.join(dir, EVENTS);
  const seen = new Set<string>();
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  // what was there before this window: history, no toast
  newKeyEvents(read(), seen);
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const fresh = newKeyEvents(read(), seen);
      if (!fresh.length) return;
      log(`keys: ${fresh.map(e => `${e.op} ${e.name}`).join(", ")}`);
      // only the Agents window registers it
      void vscode.commands.executeCommand("_dispatch.envChanged", fresh).then(undefined, () => undefined);
    }, 150);
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const w = fs.watch(dir, (_event, name) => {
      if (String(name || "") === EVENTS) changed();
    });
    w.on("error", () => undefined);
    ctx.subscriptions.push({ dispose: () => { w.close(); if (timer) clearTimeout(timer); } });
  } catch (e) {
    log(`keys: cannot watch ${dir}: ${(e as Error).message}`);
  }
}

export function registerKeys(ctx: vscode.ExtensionContext) {
  watchKeyEvents(ctx);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.env", async (op: unknown, payload: unknown) => {
      const name = String(op ?? "");
      try {
        const call = keysCall(name, payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
        if (call.text) {
          const r = await run(call.args, { timeoutMs: 20000 });
          log(`keys ${name} → ${r.code}`);
          if (r.code !== 0) return { ok: false, error: "Dispatch could not read that key." };
          return { ok: true, result: { value: r.stdout.replace(/\r?\n$/, "") } };
        }
        if (name !== "list") log(`keys ${name}`);
        const result = await runAnswer<{ ok?: boolean; error?: string }>(call.args, { input: call.input, timeoutMs: 30000 });
        if (result && typeof result === "object" && !Array.isArray(result) && result.ok === false) {
          return { ok: false, error: result.error || "Dispatch could not do that." };
        }
        return { ok: true, result };
      } catch (e) {
        // the message is the CLI's stderr or our own check: neither carries a value
        log(`keys ${name}: failed`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}
