import * as vscode from "vscode";
import { runJson } from "./cli";
import { lifeSession, lifeSnapshot } from "./core/life";
import { sharedRuns } from "./core/board";

export function registerLife(ctx: vscode.ExtensionContext) {
  const run = sharedRuns();
  const read = <T>(args: string[]): Promise<T> => run(JSON.stringify(args), () => runJson(args, { timeoutMs: 20000 })) as Promise<T>;
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.sessionLife", async (value: unknown) => {
      const session = lifeSession(value);
      if (!session) return undefined;
      // Older CLIs have neither command. Their unavailable fields must not become zero usage.
      try { return lifeSnapshot(await read(["session", "life", session, "--json"])); }
      catch { return undefined; }
    }),
  );
}
