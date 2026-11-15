// ~/.dispatch pieces of the Agents window's Customizations (Dispatch IDE patches):
//   dispatch.skillsFind     Overview › Find skills: `dispatch skills find <q> --json` (pool first, then skills.sh)
//   dispatch.skillsConfirmInstall / dispatch.skillsInstall  a result's Install / Enable: ask, then
//                           `dispatch skills install|enable` (the page asks first so its button changes only after a yes)
//   dispatch.agentsEffort   Claude › Sub-agent effort: `dispatch agents effort [level] --json`
//   dispatch.agentRun       Agents › a definition's Run as a Session...: `dispatch agent run <name> "<task>"`
import * as vscode from "vscode";
import { log, run, runJson } from "./cli";
import { engineOf, FoundSkill, installArgs } from "./core/skillInstall";

const EFFORTS = ["low", "medium", "high", "max"];

async function confirmInstall(s: FoundSkill, engine: { id: string; label: string }): Promise<boolean> {
  const fromPool = s.source === "pool" || s.source === "local";
  const go = fromPool ? "Enable" : "Install";
  const detail = fromPool
    ? `Mounts ${s.name} from ~/.dispatch/skills for ${engine.label}. New sessions can use it.`
    : `Downloads ${s.repo} from GitHub, copies the skill "${s.skill_id || s.name}" into ~/.dispatch/skills with its license, and mounts it for ${engine.label}. Read what it does before you use it.`;
  return (await vscode.window.showInformationMessage(`${go} ${s.name}?`, { modal: true, detail }, go)) === go;
}

export function registerDispatchDir(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("dispatch.skillsFind", async (query: unknown, online: unknown) => {
      const q = String(query ?? "").trim();
      if (!q) return { ok: true, result: { query: "", local: [], online: [] } };
      try {
        const result = await runJson(["skills", "find", q, "--json", ...(online === false ? ["--local"] : [])], { timeoutMs: 30000 });
        return { ok: true, result };
      } catch (e) {
        log(`skillsFind: ${(e as Error).message}`);
        if (online === false) return { ok: false, error: (e as Error).message };
        // the public search (skills.sh, GitHub) did not answer in time: the pool still does, with a line saying so
        try {
          const local = (await runJson(["skills", "find", q, "--json", "--local"], { timeoutMs: 30000 })) as Record<string, unknown>;
          return { ok: true, result: { ...local, online: [], error: "the public skill search did not answer in time" } };
        } catch (e2) {
          log(`skillsFind --local: ${(e2 as Error).message}`);
          return { ok: false, error: (e as Error).message };
        }
      }
    }),
    vscode.commands.registerCommand("dispatch.skillsConfirmInstall", async (skill: unknown, harness: unknown) => {
      const s = (skill && typeof skill === "object" ? skill : {}) as FoundSkill;
      return confirmInstall(s, engineOf(harness));
    }),
    vscode.commands.registerCommand("dispatch.skillsInstall", async (skill: unknown, harness: unknown, confirmed: unknown) => {
      const s = (skill && typeof skill === "object" ? skill : {}) as FoundSkill;
      const engine = engineOf(harness);
      const args = installArgs(s, [engine.id]);
      if (!args) return { ok: false, error: "This result has no repository to install from." };
      // the page asks first (dispatch.skillsConfirmInstall) so its button only turns to Installing... after a yes
      if (confirmed !== true && !(await confirmInstall(s, engine))) return { ok: false, cancelled: true };
      try {
        if (args[1] === "enable") {
          const r = await run(args, { timeoutMs: 60000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || `exit ${r.code}`);
          return { ok: true, result: { name: s.name, agents: [engine.id] } };
        }
        return { ok: true, result: await runJson(args, { timeoutMs: 300000 }) };
      } catch (e) {
        log(`skillsInstall ${s.name}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
    vscode.commands.registerCommand("dispatch.agentRun", async (name: unknown, engine: unknown, project: unknown) => {
      const n = String(name ?? "");
      if (!n) return { ok: false, error: "no agent" };
      const task = await vscode.window.showInputBox({
        title: `Run ${n}`,
        prompt: `What should ${n} do? It runs as its own ${engine === "codex" ? "Codex" : "Claude"} session with ${n}'s instructions.`,
        placeHolder: "Review the Agents page against DESIGN.md",
        ignoreFocusOut: true,
      });
      if (!task?.trim()) return { ok: false, cancelled: true };
      const args = ["agent", "run", n, task.trim(), "--engine", engine === "claude" ? "claude" : "codex", "--timeout", "1800000", "--json"];
      if (typeof project === "string" && project) args.push("--project", project);
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${n} is working...`, cancellable: false },
        async () => {
          try {
            return { ok: true, result: await runJson<{ result_file: string; status: string; session: string }>(args, { timeoutMs: 2100000 }) };
          } catch (e) {
            log(`agentRun ${n}: ${(e as Error).message}`);
            return { ok: false, error: (e as Error).message };
          }
        },
      );
      if (res.ok && res.result) {
        const open = "Open Result";
        const done = res.result.status === "idle" || !res.result.status;
        void vscode.window.showInformationMessage(done ? `${n} finished.` : `${n} is still ${res.result.status}.`, open).then((pick) => {
          if (pick === open) void vscode.window.showTextDocument(vscode.Uri.file(res.result!.result_file));
        });
      } else {
        void vscode.window.showErrorMessage(`${n} could not run: ${res.error ?? ""}`);
      }
      return res;
    }),
    vscode.commands.registerCommand("dispatch.agentsEffort", async (level: unknown) => {
      const l = String(level ?? "");
      try {
        const result = await runJson(["agents", "effort", ...(EFFORTS.includes(l) ? [l] : []), "--json"], { timeoutMs: 30000 });
        return { ok: true, result };
      } catch (e) {
        log(`agentsEffort ${l}: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    }),
  );
}
