// The Agents window's Changes card (Dispatch IDE patches/dispatch-fixit.patch) through the dispatch CLI
// (kanban app/cli/fixit.py): what went wrong in plain words with the prompt for the agent, and the commit
// message the default agent writes.
//
//   dispatch.fixExplain(kind, folder, error?, message?, base?) → problem   (`fix <kind>`, git's output on stdin)
//   dispatch.fixStatus(folder, fresh?)                          → {problems} (`fix status`: conflicts, checks, comments)
//   dispatch.fixSettled(folder, about, since?, need?)           → {settled, how, subject?} (`fix settled`: is it behind us)
//   dispatch.write(kind, folder, about?, agent?, model?)        → {text|title|name, by, by_label, ai}
//     (agent, model: the session's, for a commit message: only that agent writes it)
//     walk: `about` is the turn's stops as JSON, sent on stdin → {texts, by, by_label, ai} (Walk me through, task-fktjx)
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { fixArgs, folderPath, isFixKind, isWriteKind, settledArgs, timeoutFor, writeArgs } from "./core/fixit";

async function call(args: string[], input?: string): Promise<Record<string, unknown>> {
  try {
    return await runJson<Record<string, unknown>>(args, { timeoutMs: timeoutFor(args), input });
  } catch (e) {
    log(`dispatch ${args.slice(0, 2).join(" ")}: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}

export function registerFixit(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.fixExplain", (kind: unknown, folder: unknown, error: unknown, message: unknown, base: unknown) => {
      const f = folderPath(folder);
      if (!isFixKind(kind) || kind === "status" || !f) return { error: "bad arguments" };
      const args = fixArgs(kind, f, { message: typeof message === "string" ? message : "", base: typeof base === "string" ? base : "" });
      if (kind === "conflicts" && typeof error === "string" && error) args.push("--error", error);
      return call(args, kind === "conflicts" ? "" : typeof error === "string" ? error : "");
    }),
    vscode.commands.registerCommand("dispatch.fixStatus", (folder: unknown, fresh: unknown) => {
      const f = folderPath(folder);
      if (!f) return { problems: [] };
      return call(fixArgs("status", f, { fresh: fresh === true }));
    }),
    vscode.commands.registerCommand("dispatch.fixSettled", (folder: unknown, about: unknown, since: unknown, need: unknown) => {
      const f = folderPath(folder);
      const args = f ? settledArgs(f, about, since, need) : undefined;
      return args ? call(args) : { settled: false, error: "bad arguments" };
    }),
    vscode.commands.registerCommand("dispatch.write", (kind: unknown, folder: unknown, about: unknown, agent: unknown, model: unknown) => {
      const f = folderPath(folder);
      const str = (x: unknown) => (typeof x === "string" ? x : "");
      if (kind === "walk") {
        // the turn's stops as JSON ({request, stops}) go on stdin: their code is too long for a command line
        return str(about) ? call(writeArgs(kind, "", "", str(agent), str(model)), str(about)) : { error: "bad arguments" };
      }
      if (!isWriteKind(kind) || (!f && kind !== "branch")) return { error: "bad arguments" };
      return call(writeArgs(kind, f, str(about), str(agent), str(model)));
    }),
  );
}
