// `dispatch ide show <path | URL>` and `dispatch task deliver --show` (kanban app/cli/ide_show.py),
// and `dispatch browser --ide …` (kanban app/cli/browser_ide.py, runs `_dispatch.browser`):
// the Agents window opens a deliverable in its right panel. The channel is files under
// <DISPATCH_DIR>/ide: this window keeps agents-window.json fresh ({pid, at}) so the CLI knows it is
// here, and takes requests/<id>.json (renaming it away first, so two windows never both open it),
// then answers requests/<id>.done. A Markdown or HTML file (or a folder with a README.md) opens in
// the Docs tab's reader through the workbench's `dispatch.openDoc(path, {task, reason})` (Dispatch
// IDE patches/435-docs.patch); a URL or an image through `_dispatch.openPath` with
// `fromDocs`, which puts "‹ Docs" above the tab (435-docs.patch).
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { idePath, log } from "./cli";
import { HEARTBEAT_MS, IDE_FEATURES, parseBrowserRequest, parseShowRequest, requestFiles } from "./core/ideShow";
import { disposeDeliveryServer } from "./deliveryPage";

export function registerIdeShow(ctx: vscode.ExtensionContext) {
  const dir = idePath("requests");
  const alive = idePath("agents-window.json");
  const beat = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${alive}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() / 1000, features: IDE_FEATURES }));
      fs.renameSync(tmp, alive);
    } catch (e) {
      log(`ide show heartbeat: ${(e as Error).message}`);
    }
  };
  beat();
  let busy = false;
  const take = async () => {
    if (busy) return;
    busy = true;
    try {
      let names: string[] = [];
      try {
        names = requestFiles(fs.readdirSync(dir));
      } catch {
        return;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        // with several Agents windows open, the one in front takes it; the others only after a moment
        if (!vscode.window.state.focused && Date.now() - mtimeMs(file) < UNFOCUSED_WAIT_MS) continue;
        await handle(file);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    beat();
    void take();
  }, HEARTBEAT_MS);
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => void take());
  } catch (e) {
    log(`ide show watch: ${(e as Error).message}`);
  }
  // a quicker poll as well: fs.watch can miss a rename on some file systems
  const poll = setInterval(() => void take(), 700);
  void take();
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      clearInterval(poll);
      disposeDeliveryServer();
      watcher?.close();
      try {
        // only our own heartbeat: another window may have written a newer one
        const rec = JSON.parse(fs.readFileSync(alive, "utf8"));
        if (rec?.pid === process.pid) fs.rmSync(alive, { force: true });
      } catch {
        /* gone already */
      }
    },
  });
}

/** An Agents window that is not in front leaves a fresh request this long to the one that is. */
const UNFOCUSED_WAIT_MS = 1500;

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function isFolder(p: string): boolean {
  try {
    return p.startsWith("/") && fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "README.md"));
  } catch {
    return false;
  }
}

async function handle(file: string) {
  const mine = `${file}.taking-${process.pid}`;
  try {
    fs.renameSync(file, mine);
  } catch {
    return; // another window took it, or the CLI gave up
  }
  let text = "";
  try {
    text = fs.readFileSync(mine, "utf8");
  } finally {
    fs.rmSync(mine, { force: true });
  }
  const answerTo = (id: string) => (rec: unknown) => {
    try {
      const done = path.join(path.dirname(file), `${id}.done`);
      fs.writeFileSync(`${done}.tmp`, JSON.stringify(rec));
      fs.renameSync(`${done}.tmp`, done);
    } catch (e) {
      log(`ide request answer: ${(e as Error).message}`);
    }
  };
  // `dispatch browser --ide …`: drive the integrated browser (never logs page text or images).
  const browser = parseBrowserRequest(text, Date.now() / 1000);
  if (browser) {
    log(`ide browser ${browser.args.action}${browser.args.url ? ` ${browser.args.url}` : ""}`);
    try {
      const result = await vscode.commands.executeCommand("_dispatch.browser", browser.args);
      answerTo(browser.id)({ ok: true, result });
    } catch (e) {
      answerTo(browser.id)({ ok: false, error: (e as Error).message });
    }
    return;
  }
  const req = parseShowRequest(text, Date.now() / 1000);
  if (!req) {
    log(`ide show: ignored ${path.basename(file)}`);
    return;
  }
  const answer: (rec: { ok: boolean; error?: string }) => void = answerTo(req.id);
  log(`ide show ${req.target}${req.session ? ` (session ${req.session})` : ""}`);
  try {
    if (req.session) {
      await vscode.commands.executeCommand("_dispatch.openSession", req.session).then(undefined, (e: Error) => log(`ide show session: ${e.message}`));
    }
    if (/\.(md|markdown|html?)$/i.test(req.target) || isFolder(req.target)) {
      // the Docs tab's reader: the side pane switches to Docs, the tab flashes, the chat keeps the keyboard
      await vscode.commands.executeCommand("dispatch.openDoc", req.target, { task: req.task || undefined, reason: "delivered" });
    } else {
      await vscode.commands.executeCommand("_dispatch.openPath", req.target, { folderReadme: true, fromDocs: true });
    }
    answer({ ok: true });
  } catch (e) {
    answer({ ok: false, error: (e as Error).message });
  }
}
