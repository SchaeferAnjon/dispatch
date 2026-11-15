// dispatch.tasks (design/task-model/DECISIONS.md): the Agents window's Tasks tab, task graph and task
// page (Dispatch IDE patches/430-tasks.patch, 430-tasks.patch) and the task links in
// chat replies (330-task-links.patch) read `dispatch task list | graph | show --json` through here.
import * as vscode from "vscode";
import { log, runJson } from "./cli";
import { tasksArgs, tasksRequestKey, TasksRequest } from "./core/tasks";
import { sharedRuns } from "./core/board";

export function registerTasks(ctx: vscode.ExtensionContext) {
  // the same question asked twice at once (tab and page refresh together) shares one CLI run
  const run = sharedRuns();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.tasks", async (req?: TasksRequest) => {
      const args = tasksArgs(req);
      if (!args) return { error: "bad request" };
      const key = tasksRequestKey(args);
      const p = run(key, () => runJson(args, { timeoutMs: 30000 }));
      try {
        return await p;
      } catch (e) {
        log(`tasks ${args.slice(1, 4).join(" ")}: ${(e as Error).message}`);
        return { error: (e as Error).message };
      }
    }),
  );
}
