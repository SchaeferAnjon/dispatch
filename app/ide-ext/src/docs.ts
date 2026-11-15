// The Agents window's Docs tab (Dispatch IDE patches/435-docs.patch) through the dispatch CLI
// (kanban app/cli/docs_view.py). The window only knows the session's folder (often a worktree), so the
// CLI finds the project from it. Local rows only: a row another Mac found cannot be opened here.
//
//   dispatch.docsQuick(folder, session?) → {project, docs, partial}    (the first frame: the project's files and the
//                                                                       last list, core/docsQuick.ts; no CLI)
//   dispatch.docsList(folder, session?)  → {project, docs: DocRow[]}   (`docs list --folder --session`, kept for docsQuick)
//   dispatch.docsSeen(folder, id)        → {seen}                      (`docs seen`: the reader opened it)
//   dispatch.docsRemove(folder, id)      → {removed}                   (`docs rm`: "Remove from Docs")
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { DocRow, DocsAnswer, deliveryKind, docRows } from "./core/docs";
import { QuickAnswer, projectRoot, quickAnswer, writeDocsCache } from "./core/docsQuick";
import { servedUrl } from "./deliveryPage";

let cacheDir = "";

/** The last list of the project in `root`, on disk (the bridge's global storage). */
function cacheFile(root: string): string {
  return path.join(cacheDir, crypto.createHash("sha1").update(root).digest("hex").slice(0, 16) + ".json");
}

export function registerDocs(ctx: vscode.ExtensionContext) {
  cacheDir = path.join(ctx.globalStorageUri.fsPath, "docs-cache");
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.docsQuick", (folder: unknown, session: unknown) =>
      docsQuick(typeof folder === "string" ? folder : "", typeof session === "string" ? session : ""),
    ),
    vscode.commands.registerCommand("dispatch.docsList", (folder: unknown, session: unknown) =>
      docsList(typeof folder === "string" ? folder : "", typeof session === "string" ? session : ""),
    ),
    vscode.commands.registerCommand("dispatch.docsSeen", (folder: unknown, id: unknown) => docOp("seen", folder, id)),
    vscode.commands.registerCommand("dispatch.docsRemove", (folder: unknown, id: unknown) => docOp("rm", folder, id)),
    vscode.commands.registerCommand("dispatch.docsPageUrl", (file: unknown, task: unknown) => pageUrl(file, task)),
  );
}

/**
 * The Docs reader's prototype page asks this for every HTML file: a delivery page (`dispatch deliver`,
 * `<meta name="dispatch-delivery">`) comes back as its URL on the bridge's local page server
 * (deliveryPage.ts), so its Choose A / B records the pick for its task, the same as when `deliver --show`
 * opened it; any other page gets "" and the reader loads the file itself.
 */
async function pageUrl(file: unknown, task: unknown): Promise<{ url: string; kind?: string }> {
  const p = typeof file === "string" && file.startsWith("/") ? file : "";
  if (!p || !/\.html?$/i.test(p)) return { url: "" };
  let head = "";
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(4096);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { url: "" };
  }
  const kind = deliveryKind(head);
  if (!kind) return { url: "" };
  try {
    return { url: await servedUrl(p, typeof task === "string" ? task : "", kind), kind };
  } catch (e) {
    log(`docsPageUrl ${p}: ${(e as Error).message}`);
    return { url: "" };
  }
}

function fsPath(folder: string): string {
  return folder.startsWith("file:") ? vscode.Uri.parse(folder).fsPath : folder;
}

function docsQuick(folder: string, session: string): QuickAnswer | { error: string } {
  const dir = fsPath(folder);
  if (!dir || !fs.existsSync(dir)) return { error: "no folder" };
  try {
    const ans = quickAnswer(dir, session, cacheFile);
    log(`docsQuick ${dir}: ${ans.docs.length} rows (${ans.cached} cached, ${ans.scanned} files) in ${ans.ms} ms`);
    return ans;
  } catch (e) {
    log(`docsQuick ${dir}: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}

async function docsList(folder: string, session: string): Promise<{ project: string; docs: DocRow[] } | { error: string }> {
  const dir = fsPath(folder);
  if (!dir) return { error: "no folder" };
  const args = ["docs", "list", "--folder", dir, "--local", "--json"];
  if (session) args.push("--session", session);
  try {
    // the tab already shows docsQuick's rows: a board busy with other agents may take a while (2 min seen, 2026-10-09)
    const ans = await runJson<DocsAnswer>(args, { timeoutMs: 180000 });
    const docs = docRows(ans);
    try {
      writeDocsCache(cacheFile(projectRoot(dir)), projectRoot(dir), ans.project || "", docs);
    } catch (e) {
      log(`docs cache ${dir}: ${(e as Error).message}`);
    }
    return { project: ans.project || "", docs };
  } catch (e) {
    log(`docsList ${dir}: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}

async function docOp(op: "seen" | "rm", folder: unknown, id: unknown): Promise<Record<string, unknown>> {
  const path = typeof folder === "string" ? fsPath(folder) : "";
  if (!path || typeof id !== "string" || !/^[0-9a-f]{6,64}$/.test(id)) return { error: "bad arguments" };
  try {
    return await runJson<Record<string, unknown>>(["docs", op, id, "--folder", path, "--json"], { timeoutMs: 20000 });
  } catch (e) {
    log(`docs ${op} ${id}: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}
