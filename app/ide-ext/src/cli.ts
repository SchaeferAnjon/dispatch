import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { boardRevision } from "./core/board";
import { answerError, cliEnv, cliTarget, lastJson } from "./core/cliOutput";
import { ReadShare, readKey } from "./core/readShare";
import { macToolsReady } from "./core/onboarding";
import { COMMAND_LOCATION, settingValue } from "./core/settingNames";

export class CliError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface RunOpts {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  token?: vscode.CancellationToken;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** ~/tasks/.dispatch (DISPATCH_DIR wins, same as ide.py / editor.py). */
export function dispatchDir(): string {
  return process.env.DISPATCH_DIR || path.join(os.homedir(), "tasks", ".dispatch");
}

export function idePath(...parts: string[]): string {
  return path.join(dispatchDir(), "ide", ...parts);
}

let logChannel: vscode.OutputChannel | undefined;
/** A tree view when `id` is contributed, undefined when it is not (the views the bridge no longer shows). */
export function optionalTreeView<T>(id: string, treeDataProvider: vscode.TreeDataProvider<T>): vscode.TreeView<T> | undefined {
  const views = (vscode.extensions.getExtension("dispatch.dispatch-bridge")?.packageJSON?.contributes?.views ?? {}) as Record<string, { id: string }[]>;
  if (!Object.values(views).some((list) => list.some((v) => v.id === id))) return undefined;
  try {
    return vscode.window.createTreeView(id, { treeDataProvider });
  } catch {
    return undefined;
  }
}

export function setLog(ch: vscode.OutputChannel) {
  logChannel = ch;
}
export function log(msg: string) {
  logChannel?.appendLine(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}

let ideBinDir: string | undefined;
/** Dispatch IDE's own bd and dolt (Resources/app/tools), when this build has them. */
function ideBin(): string {
  if (ideBinDir === undefined) {
    const dir = path.join(vscode.env.appRoot, "tools");
    ideBinDir = fs.existsSync(path.join(dir, "bd")) ? dir : "";
  }
  return ideBinDir;
}

let missingCliNoticed = false;

/** The first time the CLI cannot be started at all: one notification that says what to install, then quiet
 *  (every page asks every few seconds; the log keeps the rest). */
function noticeMissingCli(cmd: string, e: Error) {
  log(`cannot start ${cmd}: ${e.message}`);
  if (missingCliNoticed || (e as NodeJS.ErrnoException).code !== "ENOENT") return;
  missingCliNoticed = true;
  void vscode.window.showWarningMessage(
    vscode.l10n.t("Dispatch IDE could not find the dispatch command at {0}. Install Dispatch's command line tools there (or set Dispatch: Command Location to your dispatch.py) and reload the window.", cmd),
  );
}

/** The "Command Location" setting (formerly dispatch.cliPath): another dispatch to run, or "" for the usual one. */
export function commandLocation(): string {
  const cfg = vscode.workspace.getConfiguration("dispatch");
  return settingValue<string>((k) => cfg.get<string>(k), COMMAND_LOCATION) || "";
}

let toolsHere = false;
let toolsAskedAt = 0;
let toolsAnswer = false;
/** Apple's command line tools on a Mac (the CLI's python3, git): once there they stay, so only a "no" is asked again
 *  (at most every 3 s). A new Mac has none: its python3 is a stub that opens macOS's install question whenever it
 *  runs, so the CLI is not started until they are in; the setup's first page installs them (task-7mmi3). */
export function macToolsHere(): boolean {
  if (process.platform !== "darwin" || toolsHere) return true;
  if (Date.now() - toolsAskedAt < 3000) return toolsAnswer;
  toolsAskedAt = Date.now();
  const r = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5000 });
  toolsAnswer = toolsHere = macToolsReady(process.platform, r.status === 0 ? r.stdout : "", (p) => fs.existsSync(p));
  return toolsAnswer;
}

const reads = new ReadShare<RunResult>(Date.now, boardRevision);

/** Run `dispatch <args…>`; never rejects on a non-zero exit (the caller reads the JSON). A read that only looks
 *  (`waiting --json`, `build queue --json`…) already running, or answered a moment ago, is not started again
 *  (core/readShare.ts: every start is a Python process of about 0.3 s of CPU). */
export function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  if (opts.token || opts.input) return start(args, opts);
  return reads.run(readKey(args, opts.cwd), () => start(args, opts));
}

function start(args: string[], opts: RunOpts): Promise<RunResult> {
  const override = commandLocation();
  const bundled = path.join(vscode.env.appRoot, "dispatch-cli", "dispatch", "cli", "dispatch.py");
  const t = cliTarget(process.env, os.homedir(), (p) => fs.existsSync(p), override, bundled);
  if ((t.cmd === "python3" || t.cmd === "/usr/bin/python3") && !macToolsHere()) {
    return Promise.reject(new CliError("no_tools", "Apple's command line tools are not on this Mac yet: Dispatch's setup installs them."));
  }
  return new Promise((resolve, reject) => {
    // a session's folder can be gone (a deleted worktree): spawn would fail with ENOENT, which reads as a
    // missing dispatch command; the CLI takes the folder from its arguments anyway
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    const t0 = Date.now();
    const child = spawn(t.cmd, [...t.pre, ...args], {
      cwd,
      env: cliEnv(process.env, ideBin(), os.homedir()) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub?.dispose();
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new CliError("timeout", `dispatch ${args[0]} ${args[1] || ""} timed out`)));
    }, opts.timeoutMs ?? 30000);
    const sub = opts.token?.onCancellationRequested(() => {
      child.kill("SIGTERM");
      finish(() => reject(new CliError("cancelled", "cancelled")));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      noticeMissingCli(t.cmd, e);
      finish(() => reject(new CliError("spawn", `${t.cmd}: ${e.message}`)));
    });
    // every call with its time: what a page waits for shows in the log (design/settings-fast)
    child.on("close", (code) => finish(() => {
      log(`dispatch ${args.slice(0, 3).join(" ")} → ${code} (${Date.now() - t0} ms)`);
      resolve({ code, stdout, stderr });
    }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

/** Run and parse the JSON answer; `{ok: false}` and unparsable output become a CliError. */
export async function runJson<T = unknown>(args: string[], opts: RunOpts = {}): Promise<T> {
  const r = await run(args, opts);
  const ans = lastJson(r.stdout);
  if (ans === undefined) {
    const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`;
    throw new CliError("no_json", msg);
  }
  const err = answerError(ans);
  if (err) throw new CliError(err.code, err.message);
  return ans as T;
}

/** Run and parse the JSON answer, `{ok: false}` included (callers that read error details). */
export async function runAnswer<T = unknown>(args: string[], opts: RunOpts = {}): Promise<T> {
  const r = await run(args, opts);
  const ans = lastJson(r.stdout);
  if (ans === undefined) throw new CliError("no_json", (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`);
  return ans as T;
}

/** Plain text output (e.g. `env get`), trimmed; empty string on failure. */
export async function runText(args: string[], opts: RunOpts = {}): Promise<string> {
  try {
    const r = await run(args, opts);
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/**
 * A path on this machine for a document or folder URI. code-server's extension host sees the
 * workspace as `vscode-remote://…` (the server is the "remote"), a local VS Code as `file:`.
 */
export function localPath(uri: vscode.Uri | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.scheme === "file" || uri.scheme === "vscode-remote") return uri.fsPath;
  return undefined;
}

/** The workspace folder a file belongs to, or the first one. */
export function rootFor(uri?: vscode.Uri): string | undefined {
  const f = (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
  return localPath(f?.uri);
}
