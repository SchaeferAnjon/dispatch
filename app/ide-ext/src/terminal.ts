// dispatch.terminal: what the Agents window's terminal asks (Dispatch IDE patches/610-terminal.patch).
//   agents    { ok, agents: TerminalAgent[] }   the agents on this Mac that can run in a terminal
//   ghostty   GhosttyPreview                    what the terminal would take from the person's Ghostty settings
//   daemon    { ok, url, port, token, pid }     where the terminal daemon listens (started when it is not running)
//   snippets  { ok, snippets }                  the snippets; arg { op: list|add|update|remove, id, name, text }
import * as vscode from "vscode";
import { runJson } from "./cli";
import { shapeGhostty, terminalArgs } from "./core/terminal";

export function registerTerminal(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.terminal", async (op?: unknown, arg?: unknown) => {
      const args = terminalArgs(op, arg, vscode.env.appRoot);
      if (!args) throw new Error(`dispatch.terminal: bad request ${String(op)}`);
      const answer = await runJson(args, { timeoutMs: 20000 });
      return op === "ghostty" ? shapeGhostty(answer) : answer;
    }),
  );
}
