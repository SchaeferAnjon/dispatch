// Dispatch integration for OpenCode (https://opencode.ai). Linked from ~/.config/opencode/plugins/dispatch.js
// by Dispatch's setup (`dispatch engines install-plugin opencode`). Undo with `uninstall-plugin`.
// Everything it asks Dispatch goes to Dispatch's one hook entry (app/cli/hook.py, `hook.py opencode`), the command
// Claude Code's and Codex's hooks run too, with the same hook JSON (hook_event_name, session_id, cwd ...):
//   * SessionStart: the session-start digest, loaded before the first model request and reused for this session,
//     including after compaction (source "compact" carries the latest handoff). The awaited system hook avoids a
//     session.created race.
//   * UserPromptSubmit: who wrote which line (a mark when a turn starts, awaited so it is taken before the agent
//     edits anything; the person's changes since the last turn ride on that turn's system prompt), and a prompt
//     typed in Dispatch's own terminal goes on the board.
//   * PostToolUse (todowrite): the todo list becomes the plan of the session's current task.
//   * Stop (session.idle): the end mark, then the context lifetime; its reminder or handoff request rides on the
//     system prompt of that session's requests until the next turn ends.
//   * session: every shell command OpenCode runs gets DISPATCH_SESSION_ID (its session id), and every
//     call to a tool of Dispatch's MCP server (dispatch_*: task_begin, task_log, prefs_add …) carries it
//     as dispatch_session, so the task, the log line or the preference belongs to this conversation, as
//     it does for Claude Code and Codex. One OpenCode process serves many sessions; the server alone
//     could not tell them apart.
// Nothing here may fail a tool call: every error is swallowed.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
// Dispatch's hook entry next to this file (the app ships agent/ next to cli/; the repository keeps app/cli), run
// with the python3 `dispatch` itself runs on; else the `dispatch` command (`dispatch hook opencode`, slower).
const HOOK = (() => {
  try {
    const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
    return [join(here, "..", "..", "cli", "hook.py"), join(here, "..", "..", "app", "cli", "hook.py")].find((p) => existsSync(p)) ?? "";
  } catch {
    return "";
  }
})();
const DISPATCH_CLI = process.env.DISPATCH_CLI || ([
  join(HOME, ".local", "bin", "dispatch"),
  join(HOME, ".dispatch-cli", "dispatch", "cli", "dispatch.py"),
].find((p) => p && existsSync(p)) ?? "dispatch");
const ENTRY = HOOK ? [process.env.DISPATCH_PYTHON || "python3", [HOOK, "opencode"]] : [DISPATCH_CLI, ["hook", "opencode"]];

// One call of the entry: the hook JSON in, its answer's text out. Fails open: a failed or empty answer, one over a
// megabyte or one that does not come in time is "" and the turn goes on. `waitMs`: how long the caller waits; then
// the child is stopped, unless `keep` (an attribution mark must still land; an answer that comes late goes to `late`).
function hook(event, sessionID, directory, extra = {}, { waitMs = 15000, keep = false, late = () => {} } = {}) {
  return new Promise((resolve) => {
    let waiting = true;
    let out = "";
    let child;
    const stop = () => {
      try { child?.kill("SIGTERM"); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.(); } catch { /* already gone */ }
    };
    const finish = (text) => {
      if (waiting) { waiting = false; clearTimeout(timer); resolve(text); }
      else if (text) late(text);
    };
    const timer = setTimeout(() => {
      waiting = false;
      resolve(""); // do not wait for close: a stuck command may ignore SIGTERM
      if (!keep) stop();
    }, waitMs);
    try {
      child = spawn(ENTRY[0], ENTRY[1], {
        cwd: directory,
        env: { ...process.env, BEADS_ACTOR: "opencode", DISPATCH_ACTOR: "opencode", DISPATCH_SESSION_ID: sessionID },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => finish(""));
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.length > 1024 * 1024) { finish(""); stop(); }
      });
      child.on("close", (code) => {
        if (code) return finish("");
        try {
          const r = JSON.parse(out.trim() || "{}");
          finish(String(r.reason || r.systemMessage || r.hookSpecificOutput?.additionalContext || "").trim());
        } catch {
          finish("");
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionID, cwd: directory, ...extra }));
    } catch {
      finish("");
    }
  });
}

const WAIT_MS = Number(process.env.DISPATCH_ATTRIBUTION_WAIT_MS) || 8000;

export const DispatchPlugin = async ({ directory } = {}) => {
  const primes = new Map();
  const compacted = new Set(); // sessions whose next brief is the one after a compaction
  const notes = new Map(); // sessionID -> lifetime text for this turn's requests
  const yourEdits = new Map(); // sessionID -> the lines the person changed since the last turn (this turn only)
  const cwd = () => directory || process.cwd();
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return; // auxiliary requests without a session have no session context
      if (!primes.has(sessionID)) {
        const source = compacted.has(sessionID) ? "compact" : "";
        compacted.delete(sessionID);
        primes.set(sessionID, hook("SessionStart", sessionID, cwd(), source ? { source } : {}));
      }
      const prime = await primes.get(sessionID);
      if (prime && !output.system.includes(prime)) output.system.push(prime);
      const note = notes.get(sessionID);
      if (note && !output.system.includes(note)) output.system.push(note);
      const edits = yourEdits.get(sessionID);
      if (edits && !output.system.includes(edits)) output.system.push(edits);
    },
    "chat.message": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return;
      const typed = (output?.parts ?? []).filter((p) => p?.type === "text" && !p?.synthetic).map((p) => p.text || "").join(" ");
      const edits = await hook("UserPromptSubmit", sessionID, cwd(), { prompt: typed },
        { waitMs: WAIT_MS, keep: true, late: (note) => yourEdits.set(sessionID, note) });
      if (edits) yourEdits.set(sessionID, edits);
      else yourEdits.delete(sessionID);
    },
    event: async ({ event }) => {
      const props = event?.properties ?? {};
      if (event.type === "session.deleted") {
        const id = props.info?.id;
        primes.delete(id);
        notes.delete(id);
        yourEdits.delete(id);
        compacted.delete(id);
      } else if (event.type === "session.compacted" && props.sessionID) {
        primes.delete(props.sessionID);
        compacted.add(props.sessionID);
      } else if (event.type === "session.idle" && props.sessionID) {
        const id = props.sessionID;
        // Not awaited: the event bus never waits for the measurement.
        hook("Stop", id, cwd()).then((text) => {
          if (text) notes.set(id, text);
          else notes.delete(id);
        });
      }
    },
    dispose: async () => { primes.clear(); notes.clear(); yourEdits.clear(); compacted.clear(); },
    "shell.env": async (input, output) => {
      if (input?.sessionID) {
        output.env.DISPATCH_SESSION_ID = input.sessionID;
        output.env.BEADS_ACTOR = "opencode";
        output.env.DISPATCH_ACTOR = "opencode";
      }
    },
    "tool.execute.before": async (input, output) => {
      // dispatch_mcp.py reads it and takes it out before anything runs (it is in no tool's schema)
      if (input?.sessionID && typeof input.tool === "string" && input.tool.startsWith("dispatch_") &&
          output?.args && typeof output.args === "object") {
        output.args.dispatch_session = input.sessionID;
      }
    },
    "tool.execute.after": async (input) => {
      if (input?.tool === "todowrite" && input.sessionID) {
        hook("PostToolUse", input.sessionID, cwd(), { tool_name: "todowrite", tool_input: input.args ?? {} });
      }
    },
  };
};
