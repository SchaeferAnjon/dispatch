// Dispatch integration for pi (https://github.com/earendil-works/pi-mono).
// Symlinked from ~/.pi/agent/extensions/dispatch.ts. What it does:
//   * identity: BEADS_ACTOR=pi for every shell pi runs, so board writes are attributed
//   * presence: registers the session with ~/tasks/.dispatch/presence.py (Dispatch shows it live)
//   * prime: on the first turn, appends `dispatch prime` (tasks, wiki, neighbours, quota) to the system prompt
//   * edit-guard: before edit/write, asks ~/tasks/.dispatch/edit-guard.py whether another session is on that file
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const HOME = homedir();
const DISPATCH_DIR = join(HOME, "tasks", ".dispatch");
const DISPATCH_CLI = join(HOME, "Projects", "kanban", "app", "cli", "dispatch.py");
const PATH = `/opt/homebrew/bin:/usr/local/bin:${join(HOME, ".local/bin")}:${process.env.PATH ?? ""}`;
process.env.BEADS_ACTOR = "pi";
process.env.BEADS_DIR ??= join(HOME, "tasks", ".beads");

function run(cmd: string, args: string[], stdin = ""): string {
  const r = spawnSync(cmd, args, { input: stdin, encoding: "utf8", env: { ...process.env, PATH }, timeout: 15000 });
  return r.status === 0 ? (r.stdout ?? "") : "";
}
function sessionId(ctx: any): string {
  const f = ctx.sessionManager?.getSessionFile?.() ?? "";
  const b = basename(String(f)).replace(/\.jsonl$/, "");
  return (b.includes("_") ? b.slice(b.indexOf("_") + 1) : b) || "ephemeral";
}
function presence(ctx: any, event: string) {
  run("python3", [join(DISPATCH_DIR, "presence.py"), "pi", event], JSON.stringify({ session_id: sessionId(ctx), cwd: ctx.cwd ?? process.cwd() }));
}

export default function (pi: any) {
  let primed = false;
  pi.on("session_start", async (_e: any, ctx: any) => { primed = false; presence(ctx, "SessionStart"); });
  pi.on("turn_start", async (_e: any, ctx: any) => presence(ctx, "UserPromptSubmit"));
  pi.on("agent_end", async (_e: any, ctx: any) => presence(ctx, "Stop"));
  pi.on("session_shutdown", async (_e: any, ctx: any) => presence(ctx, "SessionEnd"));

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (primed) return;
    primed = true;
    const out = run("python3", [DISPATCH_CLI, "prime", "--cwd", ctx.cwd ?? process.cwd()]).trim();
    if (!out) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${out}` };
  });

  const guard = (phase: "pre" | "post") => async (event: any, ctx: any) => {
    if (!["edit", "write"].includes(event.toolName)) return;
    const file = event.input?.path ?? event.input?.file_path ?? event.input?.filePath;
    if (!file) return;
    const out = run("python3", [join(DISPATCH_DIR, "edit-guard.py"), "pi", phase],
      JSON.stringify({ session_id: sessionId(ctx), tool_name: event.toolName, tool_input: { file_path: file } })).trim();
    if (phase === "pre" && out) {
      try { const j = JSON.parse(out); const h = j.hookSpecificOutput; if (h?.permissionDecision === "deny") return { block: true, reason: h.permissionDecisionReason }; } catch { /* allow */ }
    }
  };
  pi.on("tool_call", guard("pre"));
  pi.on("tool_result", guard("post"));
}
