// The Agents window's Settings page (Dispatch IDE patches/510-settings.patch).
//   dispatch.settings get           the phone notification switches from `dispatch settings --json`
//   dispatch.settings save {k: v}   write some of them (`dispatch settings --save`), answers with all of them
//   dispatch.settings snapshot      everything Settings shows that is kept on this Mac (`dispatch settings-page`)
//   dispatch.awake [state]          Keep awake: the mode and whether this Mac is held awake now, from `dispatch awake --json`
// Keeping the Mac awake is chatd's (kanban app/cli/awake.py): while an agent works or a phone is connected, in
// the mode of the CLI setting keep_awake. `dispatch.keepAwake` (what the page shows and sets) mirrors it: a change
// here is written to the CLI, and at start the CLI's value (the first-run step writes it) is taken over.
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { shapeState } from "./core/mobile";
import { AwakeMode, awakeMode, awakeSetting, awakeState, computerAllowAllArgs, pageSettings, settingsCall, shapeSnapshot } from "./core/settingsPage";

class KeepAwake {
  private writing: AwakeMode | undefined;

  private config(): AwakeMode {
    return awakeMode(vscode.workspace.getConfiguration("dispatch").get("keepAwake"));
  }

  /** The page changed the mode: the CLI's setting follows. */
  async toCli(): Promise<void> {
    const mode = this.config();
    if (this.writing === mode) return;
    try {
      await runJson(["awake", "set", mode, "--json"], { timeoutMs: 20000 });
      log(`keep awake: ${mode}`);
    } catch (e) {
      log(`keep awake: ${(e as Error).message}`);
    }
  }

  /** The CLI's setting is the one that counts (the first-run step writes it there): the page shows it. */
  async fromCli(): Promise<void> {
    try {
      const mode = awakeMode((await this.state()).mode);
      if (mode === this.config()) return;
      this.writing = mode;
      await vscode.workspace.getConfiguration("dispatch").update("keepAwake", mode, vscode.ConfigurationTarget.Global);
    } catch (e) {
      log(`keep awake: ${(e as Error).message}`);
    } finally {
      this.writing = undefined;
    }
  }

  async state(): Promise<ReturnType<typeof awakeState>> {
    return awakeState(await runJson(["awake", "--json"], { timeoutMs: 20000 }));
  }
}

let keepAwake: KeepAwake | undefined;

/** After the first-run step wrote keep_awake: the page's setting follows. */
export function awakeChanged(): void {
  void keepAwake?.fromCli();
}

export function registerSettingsPage(ctx: vscode.ExtensionContext) {
  const awake = (keepAwake = new KeepAwake());
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dispatch.keepAwake")) void awake.toCli();
    }),
    vscode.commands.registerCommand("dispatch.awake", async (op?: unknown, mode?: unknown) => {
      if (op === "set") {
        const m = awakeSetting(mode);
        if (!m) throw new Error(`dispatch.awake: bad mode ${String(mode)}`);
        await vscode.workspace.getConfiguration("dispatch").update("keepAwake", m, vscode.ConfigurationTarget.Global);
        await awake.toCli();
      }
      return awake.state();
    }),
    vscode.commands.registerCommand("dispatch.computerAllowAll", (on: unknown) => runJson(computerAllowAllArgs(on), { timeoutMs: 20000 })),
    vscode.commands.registerCommand("dispatch.settings", async (op: unknown, payload: unknown) => {
      if (op === "snapshot") {
        // everything Settings shows that is kept on this Mac, in one CLI run (design/settings-fast)
        try {
          return { ok: true, result: shapeSnapshot(await runJson(["settings-page", "--json"], { timeoutMs: 60000 }), (r) => shapeState(r)) };
        } catch (e) {
          log(`settings snapshot: ${(e as Error).message}`);
          return { ok: false, error: (e as Error).message };
        }
      }
      try {
        const call = settingsCall(String(op ?? ""), payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});
        return { ok: true, result: pageSettings(await runJson(call.args, { input: call.input, timeoutMs: 30000 })) };
      } catch (e) {
        log(`settings ${String(op)}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
  void awake.fromCli();
}
