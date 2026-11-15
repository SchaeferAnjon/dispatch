// Language extensions this project wants (`dispatch ide recommend`, PLAN.md §3.3): Python
// (+ basedpyright), Swift, Rust, bash. On activation the missing ones are offered once per project
// and list; "Install" installs them from Open VSX inside this workbench, so they start without a reload.
import * as vscode from "vscode";
import { log, rootFor, runJson } from "./cli";

interface Lang {
  lang: string;
  name: string;
  files: number;
  extensions: string[];
  missing: string[];
}

interface Rec {
  languages: Lang[];
  missing: string[];
  hints: Array<{ tool: string; hint: string }>;
}

export class Recommend {
  constructor(private ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(vscode.commands.registerCommand("dispatch.recommendExtensions", () => this.check(true)));
  }

  /** Extensions the workbench itself has (the server's registry can lag behind an install made here). */
  private missingHere(ids: string[]): string[] {
    return ids.filter((id) => !vscode.extensions.getExtension(id));
  }

  async check(manual = false) {
    const root = rootFor();
    if (!root) return;
    let rec: Rec;
    try {
      rec = await runJson<Rec>(["ide", "recommend", "--root", root, "--json"], { timeoutMs: 30000 });
    } catch (e) {
      log(`recommend: ${(e as Error).message}`);
      if (manual) void vscode.window.showErrorMessage((e as Error).message);
      return;
    }
    const missing = this.missingHere(rec.missing || []);
    const langs = rec.languages.filter((l) => l.missing.some((id) => missing.includes(id))).map((l) => l.name);
    if (!missing.length) {
      if (manual) void vscode.window.showInformationMessage(vscode.l10n.t("All recommended language extensions are installed."));
      return;
    }
    const mark = `dispatch.recommend:${root}:${missing.join(",")}`;
    if (!manual && this.ctx.globalState.get(mark)) return;
    await this.ctx.globalState.update(mark, Date.now());
    const install = vscode.l10n.t("Install");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t("This is a {0} project. Install the matching extensions from Open VSX ({1})?", langs.join(", "), missing.join(", ")),
      install,
      vscode.l10n.t("Not now"),
    );
    if (pick !== install) return;
    await this.install(missing);
    for (const h of rec.hints || []) void vscode.window.showInformationMessage(vscode.l10n.t("{0} is not installed: {1}", h.tool, h.hint));
  }

  async install(ids: string[]) {
    const failed: string[] = [];
    const cancelled: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Installing language extensions") }, async (p) => {
      for (const id of ids) {
        p.report({ message: id });
        try {
          await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
        } catch (e) {
          const msg = `${(e as Error).name} ${(e as Error).message}`;
          // only a workbench without the install command falls back to the CLI; a "no" in the trust
          // publisher dialog (or any other refusal) is respected
          if (!/command .* not found/i.test(msg)) {
            log(`install ${id}: ${msg}`);
            (/cancel/i.test(msg) ? cancelled : failed).push(id);
            continue;
          }
          log(`install ${id}: no install command in this workbench; trying the CLI`);
          try {
            await runJson(["ide", "extensions", "install", id, "--json"], { timeoutMs: 900000 });
          } catch (e2) {
            log(`install ${id}: ${(e2 as Error).message}`);
            failed.push(id);
          }
        }
      }
    });
    const done = ids.filter((id) => !failed.includes(id) && !cancelled.includes(id));
    if (failed.length) void vscode.window.showErrorMessage(vscode.l10n.t("Could not install: {0}", failed.join(", ")));
    if (done.length) void vscode.window.showInformationMessage(vscode.l10n.t("Installed: {0}", done.join(", ")));
  }
}
