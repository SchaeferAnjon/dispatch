// First start of Dispatch IDE: Dispatch Light / Dark following the system, the editor font and size,
// the minimal icon theme and the other defaults in themes/ide-defaults.json (5A.2), written into the
// user settings for keys the user has not set. Runs once per defaults version.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log } from "./cli";
import { defaultsToWrite, type IdeDefaults } from "./core/ideDefaults";

const STATE_KEY = "dispatch.ideDefaultsVersion";
// the Agents window has its own profile and settings: its own marker, so the editor's does not skip it
const AGENTS_STATE_KEY = "dispatch.agentsDefaultsVersion";

export async function applyIdeDefaults(ctx: vscode.ExtensionContext) {
  let d: IdeDefaults;
  try {
    d = JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, "themes", "ide-defaults.json"), "utf8"));
  } catch (e) {
    log(`defaults: ${(e as Error).message}`);
    return;
  }
  const cfg = () => vscode.workspace.getConfiguration();
  // proposal agentSessionsWorkspace, granted in Dispatch IDE's product.json
  const agents = (vscode.workspace as { isAgentSessionsWorkspace?: boolean }).isAgentSessionsWorkspace === true;
  const key = agents ? AGENTS_STATE_KEY : STATE_KEY;
  const todo = defaultsToWrite(d, (k) => cfg().inspect(k)?.globalValue, ctx.globalState.get<number>(key, 0), agents);
  for (const [k, v] of todo) {
    try {
      await cfg().update(k, v, vscode.ConfigurationTarget.Global);
    } catch (e) {
      log(`defaults ${k}: ${(e as Error).message}`);
    }
  }
  if (todo.length) log(`defaults: wrote ${todo.map(([k]) => k).join(", ")}`);
  await ctx.globalState.update(key, d.version);
}
