// dispatch.machines: the title bar's Machines menu (Dispatch IDE patches/285-machines.patch) reads
// `dispatch machines` through here. "Open Window" on another Mac is a new Dispatch IDE window connected to it
// through the built-in Open Remote - SSH (vscode-remote://ssh-remote+...): that Mac's sessions, terminal and
// files live in that window, this one keeps to this Mac. A session of that Mac (the Projects page) opens the
// same way, on its folder.
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatdLink } from "./chatPanel";
import { landingOptions, validLanding, serverStartFailure } from "./core/machineConnection";
import * as vscode from "vscode";
import { log, run, runAnswer } from "./cli";
import { jsonLines, machinesArgs, remoteFolder, serverCommands, serverStartScript, sshAuthority, withAuthority } from "./core/machines";
import { shared } from "./shared";

type Machine = { id: string; name: string; ssh: string; local: boolean; home?: string; authority?: string; recent?: { dir?: string }[] };
type Session = { id: string; cwd: string };

const ask = shared();
let known: Machine[] = [];

async function machine(host: unknown): Promise<Machine | undefined> {
  let m = known.find((x) => x.id === host);
  if (!m) {
    known = withAuthority(((await ask(["machines", "--json"], 20000)) as Machine[]) || []);
    m = known.find((x) => x.id === host);
  }
  return m;
}

/**
 * A window on that Mac: this Mac, a new empty window; another Mac, a new window connected over SSH, on
 * `dir` when given (a folder there), else the project last worked on there, else its home folder. Always a
 * folder: an empty window has no workspace the IDE could tell apart, so "Switch to window" would not find it.
 */
const preparations = new Map<string, AbortController>();

async function prepare(m: Machine, land?: "waiting"): Promise<string | undefined> {
  const authority = sshAuthority(m.ssh)!;
  preparations.get(authority)?.abort();
  const cancel = new AbortController();
  preparations.set(authority, cancel);
  const progress = async (stage: string, error?: string) => {
    await vscode.commands.executeCommand("dispatch.machines.connectionProgress", authority, {
      stage, name: m.name, host: m.id, land, error, at: Date.now(),
    });
  };
  try {
    await progress("connecting");
    const failed = await ensureServer(m.ssh, () => progress("starting-server"), cancel.signal);
    if (cancel.signal.aborted) return "Cancelled";
    if (failed) { await progress("failed", failed); return failed; }
    if (land) await runAnswer(["machines", "open", m.id, "--land", land, "--json"], { timeoutMs: 20000 });
    await progress("ready");
    return undefined;
  } catch (e) {
    if (!cancel.signal.aborted) await progress("failed", (e as Error).message);
    return (e as Error).message;
  } finally {
    if (preparations.get(authority) === cancel) preparations.delete(authority);
  }
}

export async function openMachineWindow(host: unknown, options?: unknown): Promise<{ ok: boolean; message?: string }> {
  const m = await machine(host);
  if (!m) return { ok: false, message: `Unknown Mac: ${String(host)}.` };
  const { dir, land } = landingOptions(options);
  if (m.local) {
    if (land) await vscode.commands.executeCommand("dispatch.waiting.show");
    else await vscode.commands.executeCommand("workbench.action.newWindow");
    return { ok: true };
  }
  const authority = sshAuthority(m.ssh);
  if (!authority) return { ok: false, message: `No ssh address for ${m.name}.` };
  const folder = remoteFolder(dir) ?? remoteFolder(m.recent?.[0]?.dir) ?? remoteFolder(m.home);
  if (!folder) return { ok: false, message: `No home or project folder for ${m.name}.` };
  // Publish before opening. The new window's resolver waits for ready; its workbench can
  // already render the connection screen while this bridge installs the bundled server.
  await vscode.commands.executeCommand("dispatch.machines.connectionProgress", authority, {
    stage: "finding", name: m.name, host: m.id, land, at: Date.now(),
  });
  await vscode.commands.executeCommand("dispatch.machines.openRemoteWindow",
    vscode.Uri.from({ scheme: "vscode-remote", authority, path: folder }));
  const failed = await prepare(m, land);
  return failed ? { ok: false, message: failed } : { ok: true };
}

function ssh(target: string, command: string, input?: { file?: string; text?: string }, timeoutMs = 20000, signal?: AbortSignal): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target, command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code: -1, out, err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code, out, err }); });
    if (input?.file) fs.createReadStream(input.file).on("error", () => child.stdin.end()).pipe(child.stdin);
    else child.stdin.end(input?.text ?? "");
  });
}

/**
 * Dispatch IDE's own server on that Mac, at this app's commit (build-server.sh packs it into the app), where
 * Open Remote - SSH looks for it; copied over once per app version. Returns what went wrong, or undefined.
 * An app without a packed server (a development build) or a Mac that is not macOS arm64: nothing to do here,
 * the extension tries its own way.
 */
async function ensureServer(target: string, starting: () => Promise<unknown>, signal: AbortSignal, start = true): Promise<string | undefined> {
  let product: { commit?: string; serverApplicationName?: string; serverDataFolderName?: string };
  try {
    product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
  } catch {
    return undefined;
  }
  const tar = path.join(vscode.env.appRoot, "server", `${product.serverApplicationName}-darwin-arm64.tar.gz`);
  const cmds = serverCommands(product.serverDataFolderName, product.serverApplicationName, product.commit);
  if (!cmds || !fs.existsSync(tar)) return undefined;
  const check = await ssh(target, cmds.check, undefined, 20000, signal);
  if (check.code !== 0) return vscode.l10n.t("Could not reach {0} over ssh: {1}", target, (check.err || `exit ${check.code}`).trim().split("\n").pop() ?? "");
  if (!/^Darwin arm64/m.test(check.out)) return undefined;
  await starting();
  if (signal.aborted) return "Cancelled";
  if (!/^present$/m.test(check.out)) {
    log(`server: installing ${product.commit} on ${target}`);
    const inst = await ssh(target, cmds.install, { file: tar }, 180000, signal);
    if (!/^installed$/m.test(inst.out)) return vscode.l10n.t("Could not install Dispatch IDE's server on {0}: {1}", target, (inst.err || `exit ${inst.code}`).trim().split("\n").pop() ?? "");
    log(`server: installed on ${target}`);
  }
  if (!start) return undefined; // Run on: the SSH agent host starts its own (Dispatch IDE dispatchAgentHostCommand.ts)
  // start it in that Mac's logged-in session, so it (and the Claude it runs) can read that Mac's keychain
  const script = serverStartScript(product.serverDataFolderName!, product.serverApplicationName!, product.commit!);
  if (script) {
    const start = await ssh(target, "bash -s", { text: script }, 60000, signal);
    log(`server: start on ${target}: ${start.out.trim().split("\n").pop() ?? ""} ${start.err.trim()}`);
    const failure = serverStartFailure(start.code, start.out, start.err);
    if (failure) return `Could not start Dispatch on ${target}: ${failure}`;
  }
  return undefined;
}

/**
 * Run on (the new session page's machine chip, Dispatch IDE patches/280-run-on.patch): before this window
 * connects to that Mac's agents over SSH, Dispatch IDE's own server at this app's version is copied there once.
 * Answers the SSH target (user@address) the window connects to, or what went wrong.
 */
export async function prepareRunOn(host: unknown): Promise<{ ok: boolean; ssh?: string; name?: string; message?: string }> {
  const m = await machine(host);
  if (!m) return { ok: false, message: `Unknown Mac: ${String(host)}.` };
  if (m.local) return { ok: true, name: m.name };
  if (!m.ssh) return { ok: false, message: `No address for ${m.name}. Add it again in Settings › Macs.` };
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), 300000);
  try {
    const failed = await ensureServer(m.ssh, async () => undefined, cancel.signal, false);
    return failed ? { ok: false, name: m.name, message: failed } : { ok: true, ssh: m.ssh, name: m.name };
  } catch (e) {
    return { ok: false, name: m.name, message: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** A session of another Mac: its folder there, in a window connected to that Mac. */
export async function openRemoteSession(id: unknown, host: unknown): Promise<{ ok: boolean; message?: string }> {
  const args = machinesArgs("sessions", host);
  if (!args || typeof id !== "string") return { ok: false, message: "Not a session of another Mac." };
  const sessions = ((await ask(args, 30000)) as Session[]) || [];
  const s = sessions.find((x) => x.id === id);
  return openMachineWindow(host, s && s.cwd && s.cwd !== "/" ? s.cwd : undefined);
}

/** Claim by rename before reading: focus and startup may race across two Agents windows. */
function watchLanding(ctx: vscode.ExtensionContext) {
  const folder = process.env.DISPATCH_DIR || path.join(os.homedir(), ".dispatch", "state");
  const file = path.join(folder, "land.json");
  const consume = async () => {
    try {
      if (!(vscode.workspace as unknown as { isAgentSessionsWorkspace?: boolean }).isAgentSessionsWorkspace) return;
    } catch { return; }
    const mine = `${file}.${process.pid}`;
    try { fs.renameSync(file, mine); } catch { return; }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(mine, "utf8")); }
    catch { return; }
    finally { try { fs.unlinkSync(mine); } catch { /* consumed */ } }
    if (validLanding(value)) await vscode.commands.executeCommand("dispatch.waiting.show");
  };
  // A request can arrive after focus but before SSH returns to the opener.
  fs.watchFile(file, { interval: 500 }, () => { if (vscode.window.state.focused) void consume(); });
  ctx.subscriptions.push({ dispose: () => fs.unwatchFile(file) }, vscode.window.onDidChangeWindowState(s => { if (s.focused) void consume(); }));
  void consume();
}

export function registerMachines(ctx: vscode.ExtensionContext) {
  watchLanding(ctx);
  ctx.subscriptions.push(new ChatdLink((event) => {
    if (event && typeof event === "object" && (event as { ev?: string }).ev === "attention") {
      void vscode.commands.executeCommand("dispatch.machines.attentionChanged", event).then(undefined, () => undefined);
    }
  }));
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.machines", async (op?: unknown, ...a: unknown[]) => {
      if (op === "openWindow") return openMachineWindow(a[0], a[1]);
      if (op === "runOn") return prepareRunOn(a[0]);
      if (op === "cancel" && typeof a[0] === "string") { preparations.get(a[0])?.abort(); return; }
      if (op === "prepare") { const m = await machine(a[0]); return m ? prepare(m, landingOptions(a[1]).land) : undefined; }
      if (op === "land") return runAnswer(["machines", "open", String(a[0]), "--land", "waiting", "--json"], { timeoutMs: 20000 });
      const args = machinesArgs(op, ...a);
      if (!args) throw new Error(`dispatch.machines: bad request ${String(op)}`);
      if (op === "check") {
        // one JSON line per step; a password (to install the key once) only ever goes to the CLI's stdin
        const password = typeof a[2] === "string" && a[2] ? a[2] : undefined;
        const r = await run(args, { timeoutMs: 120000, input: password ? `${password}\n` : undefined });
        const steps = jsonLines(r.stdout);
        log(`dispatch hosts add --check → ${r.code}, ${steps.length} lines`);
        return steps.length ? steps : [{ step: "reach", state: "fail", detail: (r.stderr || r.stdout).trim().split("\n").pop() || `exit ${r.code}` }];
      }
      if (op === "add" || op === "set" || op === "remove") {
        known = [];
        try {
          return await runAnswer(args, { timeoutMs: 60000 });
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
      }
      const res = await ask(args, op === "discover" || op === "refresh" ? 30000 : 20000);
      if (args[0] === "machines" && args.length === 2 && Array.isArray(res)) return (known = withAuthority(res as Machine[]));
      return res;
    }),
  );
}
