// dispatch.openCommit(repo, hash): a task's commit deliverable opens as a multi-file diff (the git
// extension's own git: documents) under "<short hash> <subject>", without the task id the subject
// ends with. git.viewCommit would put "(task-xxx)" in the tab title. false when git cannot show it.
import * as vscode from "vscode";
import { log } from "./cli";
import { commitTitle } from "./core/commitTitle";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
}
interface GitRepo {
  getCommit(ref: string): Promise<{ hash: string; message: string; parents: string[] }>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}
interface GitApi {
  openRepository?(root: vscode.Uri): Promise<GitRepo | null>;
  getRepository(uri: vscode.Uri): GitRepo | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export function registerOpenCommit(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.openCommit", async (repo?: unknown, hash?: unknown) => {
      if (typeof repo !== "string" || !repo.startsWith("/") || typeof hash !== "string" || !/^[0-9a-f]{4,40}$/i.test(hash)) return false;
      try {
        const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
        if (!ext) return false;
        const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
        const root = vscode.Uri.file(repo);
        const r = api.getRepository(root) ?? (await api.openRepository?.(root)) ?? null;
        if (!r) return false;
        const commit = await r.getCommit(hash);
        const parent = commit.parents[0] ?? EMPTY_TREE;
        const changes = await r.diffBetween(parent, commit.hash);
        const resources = changes.map((c) => [c.uri, api.toGitUri(c.originalUri ?? c.uri, parent), api.toGitUri(c.uri, commit.hash)]);
        await vscode.commands.executeCommand("vscode.changes", commitTitle(hash.slice(0, 7), commit.message), resources);
        return true;
      } catch (e) {
        log(`openCommit ${hash}: ${(e as Error).message}`);
        return false;
      }
    }),
  );
}
