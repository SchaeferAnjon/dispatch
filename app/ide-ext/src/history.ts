// dispatch.history: what the Agents window's History tab asks (Dispatch IDE patches/450-history.patch).
//   list {scope, folder, query, agents, sort, limit, showEmpty, machine}   `dispatch sessions history --json`
//   openWindow {cwd, command, name}   a new editor window on the session's folder that continues it in a terminal
//   continueInChat {agent, id}        the Agent Host takes the agent's own conversation in as a session of the window
//                                     (<userData>/dispatch-continue/<n>.json, answered with <n>.done.json), so it goes
//                                     on in the chat: {ok, session} or {ok: false, error}
// Nothing here imports a session or registers a project unless the person continues it.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { idePath, log, rootFor, runJson } from "./cli";
import { continueAnswer, continueRequest, historyArgs, historyKey, HistoryRequest, openWindowRequest, takesRequest, userDataOf } from "./core/history";

const REQUEST = "history-open.json";
const CONTINUE_DIR = "dispatch-continue";
const CONTINUE_WAIT_MS = 60_000;

/** Ask the Agent Host of this window to take a conversation in, and wait for its answer. */
async function continueInChat(userData: string, arg: unknown): Promise<{ ok: boolean; session?: string; error?: string }> {
  const req = continueRequest(arg);
  if (!req) return { ok: false, error: "Dispatch could not read that session." };
  if (!userData.startsWith("/")) return { ok: false, error: "Dispatch does not know where this window keeps its sessions." };
  const dir = path.join(userData, CONTINUE_DIR);
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const done = path.join(dir, `${name}.done.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json.tmp`), JSON.stringify(req));
  fs.renameSync(path.join(dir, `${name}.json.tmp`), path.join(dir, `${name}.json`));
  const t0 = Date.now();
  while (Date.now() - t0 < CONTINUE_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 250));
    let text = "";
    try {
      text = fs.readFileSync(done, "utf8");
    } catch {
      continue;
    }
    try {
      fs.unlinkSync(done);
    } catch {
      // the Agent Host clears old answers too
    }
    const a = continueAnswer(text);
    log(`history: continue ${req.provider}:${req.id} in chat: ${a?.ok ? a.session : a?.error}`);
    return a ?? { ok: false, error: "The Agents window gave an answer Dispatch could not read." };
  }
  try {
    fs.unlinkSync(path.join(dir, `${name}.json`));
  } catch {
    // taken after all
  }
  return { ok: false, error: "The Agents window did not answer in time. Try again in a moment." };
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The window opened to continue a session runs its resume line in a terminal (claim by rename). */
function takeOpenRequest() {
  const root = rootFor();
  const file = idePath(REQUEST);
  if (!root || !fs.existsSync(file)) return;
  let rec: unknown;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const r = takesRequest(rec, root, Date.now() / 1000, (a, b) => real(a) === real(b));
  if (!r) return;
  const mine = `${file}.${process.pid}`;
  try {
    fs.renameSync(file, mine);
    fs.unlinkSync(mine);
  } catch {
    return; // another window took it
  }
  log(`history: continuing in this window: ${r.name}`);
  const term = vscode.window.createTerminal({ name: r.name, cwd: r.root, location: vscode.TerminalLocation.Editor });
  term.show();
  term.sendText(r.command, true);
}

/** An editor window: take the request "Open in New Window" left for it, at start and while it settles (a busy Mac can
 *  take a while to start the window's extensions; the request stays good for two minutes). */
export function registerHistoryWindow(ctx: vscode.ExtensionContext) {
  const file = idePath(REQUEST);
  takeOpenRequest();
  const check = () => takeOpenRequest();
  fs.watchFile(file, { interval: 1000 }, check);
  const stop = setTimeout(() => fs.unwatchFile(file, check), 150_000);
  ctx.subscriptions.push({ dispose: () => { clearTimeout(stop); fs.unwatchFile(file, check); } });
}

export function registerHistory(ctx: vscode.ExtensionContext) {
  const inFlight = new Map<string, Promise<unknown>>();
  const userData = userDataOf(ctx.globalStorageUri.fsPath);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.history", async (op?: unknown, arg?: unknown) => {
      if (op === "continueInChat") {
        try {
          return await continueInChat(userData, arg);
        } catch (e) {
          log(`history continueInChat: ${(e as Error).message}`);
          return { ok: false, error: (e as Error).message };
        }
      }
      if (op === "openWindow") {
        const req = openWindowRequest(arg, Date.now() / 1000);
        if (!req) return { ok: false, message: "Dispatch could not read that session." };
        try {
          fs.mkdirSync(path.dirname(idePath(REQUEST)), { recursive: true });
          fs.writeFileSync(idePath(REQUEST), JSON.stringify(req));
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(req.root), { forceNewWindow: true });
          return { ok: true };
        } catch (e) {
          log(`history openWindow: ${(e as Error).message}`);
          return { ok: false, message: (e as Error).message };
        }
      }
      const args = historyArgs((op === "list" ? arg : op) as HistoryRequest, userData);
      if (!args) return { ok: false, error: "bad request" };
      const key = historyKey(args);
      let p = inFlight.get(key);
      if (!p) {
        p = runJson(args, { timeoutMs: 45000 }).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      try {
        return await p;
      } catch (e) {
        log(`history: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}
