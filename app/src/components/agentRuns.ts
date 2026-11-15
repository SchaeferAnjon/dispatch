// The agent's shell commands as read-only terminal tabs (screen 17, the 「Agent · xcodebuild」 row):
// derived from the chat view's tool chips, never from a PTY. Pure, so the linger rule is testable.
import type { ChatView, ToolChip } from "../chatProtocol";

/** Lines of output kept per command tab. */
export const AGENT_SCROLLBACK = 2000;
/** An agent's finished command tab stays this long after `tool_end`. */
export const AGENT_TAB_LINGER_MS = 10 * 60 * 1000;
/** Shell commands the agent ran in this session, from the chat's tool chips: each is one read-only terminal tab. */
export interface AgentRun { tool_id: string; command: string; summary: string; started: number; done: boolean; ok?: boolean; exit_code?: number | null; output: string; duration_ms?: number }

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** The command line of a shell chip: Claude's `input.command`, Codex's `cmd` or an argv array. */
export function commandOf(chip: Pick<ToolChip, "input" | "summary">): string {
  const i = chip.input || {};
  const argv = strs(i.command) ?? strs(i.args) ?? strs(i.argv);
  let cmd = str(i.command) || str(i.cmd) || (argv ? argv.join(" ") : "") || chip.summary || "";
  // Codex wraps commands as `bash -lc '<cmd>'`: show what runs inside.
  const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd);
  if (wrapped) cmd = wrapped[2];
  return cmd.trim();
}

/** 「xcodebuild」「npm test」「git status」: the program and its sub-command, for the row. */
export function runSummary(command: string): string {
  // Skip leading `cd somewhere &&` and environment assignments.
  const parts = command.split(/\s*(?:&&|;|\|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  const main = parts.find((p) => !/^cd(\s|$)/.test(p)) ?? parts[0] ?? "";
  const words = main.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (!words.length) return command.slice(0, 32);
  const prog = words[0].replace(/^.*\//, "");
  const sub = words[1] && !/^[-'"$<>|&(]/.test(words[1]) && words[1].length <= 16 ? ` ${words[1]}` : "";
  const s = prog + sub;
  return s.length > 32 ? `${s.slice(0, 31)}…` : s;
}

/** When a finished run ended, in ms: started + duration when chatd said, else when the page first saw it done. */
function endedAt(c: ToolChip, seenDone?: Map<string, number>, now = Date.now()): number {
  if (c.duration_ms !== undefined) return c.started * 1000 + c.duration_ms;
  return seenDone?.get(c.tool_id) ?? now;
}

/**
 * Every shell command of the view, oldest first. Running ones always stay; finished ones stay for
 * AGENT_TAB_LINGER_MS after their end. `now` is ms since the epoch; `seenDone` (tool_id → ms) lets the
 * caller remember when a run without `duration_ms` was first seen finished.
 */
export function agentRunsOf(view: ChatView | null | undefined, now: number, seenDone?: Map<string, number>): AgentRun[] {
  if (!view) return [];
  const out: AgentRun[] = [];
  for (const turn of view.turns) {
    for (const step of turn.steps) {
      if (step.kind !== "tool") continue;
      const c = turn.tools[step.tool_id];
      if (!c || c.kind !== "shell") continue;
      const done = c.status !== "running";
      // A turn that ended (interrupted, error) leaves no command running.
      const orphan = !done && !!turn.status;
      if (done || orphan) {
        if (seenDone && !seenDone.has(c.tool_id)) seenDone.set(c.tool_id, now);
        const end = done ? endedAt(c, seenDone, now) : (seenDone?.get(c.tool_id) ?? now);
        if (now - end > AGENT_TAB_LINGER_MS) continue;
      }
      const command = commandOf(c);
      out.push({
        tool_id: c.tool_id, command, summary: runSummary(command), started: c.started,
        done: done || orphan, ok: done ? c.status === "done" && (c.exit_code === undefined || c.exit_code === null || c.exit_code === 0) : orphan ? false : undefined,
        exit_code: c.exit_code, output: c.output ?? "", duration_ms: c.duration_ms,
      });
    }
  }
  return out;
}

function diffStat(a: string, b: string): string {
  const x = a ? a.split("\n") : [], y = b ? b.split("\n") : [];
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0; while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return ` +${y.length - i - j} −${x.length - i - j}`;
}

/** 「[Agent] 12:30:58 Update scripts/install-device.sh +5 −1」: the 输出 tab, one line per tool call. */
export function agentLogOf(view: ChatView | null | undefined, fmt: (sec: number) => string): string[] {
  if (!view) return [];
  const out: string[] = [];
  for (const turn of view.turns) for (const step of turn.steps) {
    if (step.kind !== "tool") continue;
    const c = turn.tools[step.tool_id];
    if (!c) continue;
    const what = c.kind === "shell" ? commandOf(c) : str(c.input?.file_path) || str(c.input?.path) || c.summary;
    const stat = c.diff ? diffStat(c.diff.old, c.diff.new) : "";
    const st = c.status === "running" ? " …" : c.status === "error" ? " ✗" : "";
    out.push(`[Agent] ${fmt(c.started)} ${c.name} ${what}${stat}${st}`.replace(/\s+$/, ""));
  }
  return out;
}
