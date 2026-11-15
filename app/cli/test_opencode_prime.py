# -*- coding: utf-8 -*-
"""Run the shipped OpenCode plugin against real child processes, without any model calls."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import opencode_engine


class Digest(unittest.TestCase):
    def test_the_brief_is_the_same_for_opencode_and_inside_its_limit(self):
        import prime_brief
        text, cut = prime_brief.build("# Dispatch · 当前项目 kanban · 你是 opencode",
                                      [("板上", ["## 板上（kanban：进行中和等你）", "◐ 「修复启动」（task-a）"]),
                                       ("同目录", ["## 同目录在跑（1）", "◐ codex 01a0ea21 · 在跑"]),
                                       ("偏好", ["## 偏好", "- 方角开关：开关用方角。"])])
        for expected in ("你是 opencode", "修复启动", "codex 01a0ea21", "方角开关"):
            self.assertIn(expected, text)
        self.assertLessEqual(len((text + "\n").encode("utf-8")), 10000)
        self.assertNotIn("\ufffd", text)


# A fake `dispatch` that answers `hook opencode` as Dispatch's hook entry would: the hook JSON on stdin.
FAKE_HEAD = """#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const data = JSON.parse(input || "{}");
  const say = (text) => process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: data.hook_event_name, additionalContext: text}}));
"""


@unittest.skipUnless(shutil.which("node") and os.name != "nt", "requires Node and executable scripts")
class Runtime(unittest.TestCase):
    def test_real_plugin_waits_caches_isolates_sessions_and_fails_open(self):
        with tempfile.TemporaryDirectory(prefix="dispatch prime ") as folder:
            root = Path(folder).resolve()
            plugin = root / "dispatch.mjs"
            plugin.write_text(Path(opencode_engine.PLUGIN_SOURCE).read_text())
            fake = root / "fake dispatch"
            fake.write_text(FAKE_HEAD + """
  fs.appendFileSync(process.env.PRIME_CALLS, JSON.stringify({args, data, cwd: process.cwd(), actor: process.env.BEADS_ACTOR,
    dispatchActor: process.env.DISPATCH_ACTOR, session: process.env.DISPATCH_SESSION_ID}) + "\\n");
  switch (process.env.PRIME_CASE) {
    case "failed": say("partial context"); process.exit(1);
    case "empty": process.stdout.write("   "); break;
    case "overflow": process.stdout.write("x".repeat(2 * 1024 * 1024)); break;
    case "timeout": setTimeout(() => {}, 30000); break;
    default: setTimeout(() => say("# prime for " + process.env.DISPATCH_SESSION_ID), 30);
  }
});
""")
            fake.chmod(0o755)
            script = r"""
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Accelerate only the timeout cases; the shipped wait is 15 s.
const realSpawn = cp.spawn;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 15000 && ["slow-close", "timeout"].includes(process.env.PRIME_CASE) ? 120 : ms, ...args);
const cleaned = [];
cp.spawn = (file, args, options) => {
  if (process.env.PRIME_CASE === "sync-error") throw new Error("spawn unavailable");
  // A child that never answers or closes, even after it is told to stop.
  if (process.env.PRIME_CASE === "slow-close") return {
    on: () => {}, kill: (signal) => cleaned.push(signal), unref: () => cleaned.push("unref"),
    stdin: {on: () => {}, end: () => {}},
    stdout: {on: () => {}, destroy: () => cleaned.push("stdout")}, stderr: {destroy: () => cleaned.push("stderr")},
  };
  return realSpawn(file, args, options);
};
syncBuiltinESMExports();
const url = pathToFileURL(process.env.PRIME_PLUGIN).href;
const { DispatchPlugin } = await import(url);
const hooks = await DispatchPlugin({directory: process.env.PRIME_CWD});
const transform = hooks["experimental.chat.system.transform"];
const call = async (sessionID, output = {system: ["base prompt"]}) => {
  await transform({sessionID}, output);
  return output.system;
};
const calls = () => readFileSync(process.env.PRIME_CALLS, "utf8").trim().split("\n").map(JSON.parse);
assert.deepEqual(await call(undefined), ["base prompt"]);
const [first, concurrent] = await Promise.all([call("s1"), call("s1")]);
assert.deepEqual(first, ["base prompt", "# prime for s1"]);
assert.deepEqual(concurrent, first);
assert.equal(calls().length, 1);
assert.deepEqual(calls()[0], {args: ["hook", "opencode"], data: {hook_event_name: "SessionStart", session_id: "s1", cwd: process.env.PRIME_CWD},
  cwd: process.env.PRIME_CWD, actor: "opencode", dispatchActor: "opencode", session: "s1"});
const existing = {system: first};
await call("s1", existing);
assert.equal(existing.system.length, 2);
assert.deepEqual(await call("s1"), first); // next turn / after compaction: a fresh system array
assert.equal(calls().length, 1);
assert.deepEqual(await call("s2"), ["base prompt", "# prime for s2"]);
assert.equal(calls().length, 2);
await hooks.event({event: {type: "session.deleted", properties: {info: {id: "s1"}}}});
await call("s1");
assert.equal(calls().length, 3);
await hooks.dispose();
await call("s2");
assert.equal(calls().length, 4);
const env = {env: {OTHER: "keep"}};
await hooks["shell.env"]({sessionID: "s3"}, env);
assert.deepEqual(env.env, {OTHER: "keep", DISPATCH_SESSION_ID: "s3", BEADS_ACTOR: "opencode", DISPATCH_ACTOR: "opencode"});
// a tool of Dispatch's MCP server learns the session; any other tool's arguments stay as they were
const mcpCall = {args: {task: "task-a1", text: "x"}};
await hooks["tool.execute.before"]({tool: "dispatch_task_log", sessionID: "s3", callID: "c1"}, mcpCall);
assert.deepEqual(mcpCall.args, {task: "task-a1", text: "x", dispatch_session: "s3"});
const other = {args: {command: "ls"}};
await hooks["tool.execute.before"]({tool: "bash", sessionID: "s3", callID: "c2"}, other);
assert.deepEqual(other.args, {command: "ls"});
for (const mode of ["failed", "empty", "overflow", "timeout", "slow-close", "sync-error"]) {
  process.env.PRIME_CASE = mode;
  const started = Date.now();
  assert.deepEqual(await call(mode), ["base prompt"], mode);
  if (mode === "slow-close") {
    assert.ok(Date.now() - started < 1000, "must not wait for the child to close");
    assert.deepEqual(cleaned, ["SIGTERM", "stdout", "stderr", "unref"]);
  }
  const count = mode === "sync-error" || mode === "slow-close" ? 0 : calls().length;
  assert.deepEqual(await call(mode), ["base prompt"]);
  if (count) assert.equal(calls().length, count); // a failed brief does not keep delaying later requests
}
process.env.DISPATCH_CLI = process.env.PRIME_CWD + "/missing-dispatch";
delete process.env.PRIME_CASE;
const missing = await (await import(url + "?missing")).DispatchPlugin({directory: process.env.PRIME_CWD});
const output = {system: ["still starts"]};
await missing["experimental.chat.system.transform"]({sessionID: "missing"}, output);
assert.deepEqual(output.system, ["still starts"]);
console.log(JSON.stringify({ok: true, subprocesses: calls().length}));
"""
            env = {**os.environ, "DISPATCH_CLI": str(fake), "PRIME_CALLS": str(root / "calls.jsonl"),
                   "PRIME_PLUGIN": str(plugin), "PRIME_CWD": str(root), "BEADS_ACTOR": "claude-code"}
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                    env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertTrue(json.loads(result.stdout)["ok"])


@unittest.skipUnless(shutil.which("node") and os.name != "nt", "requires Node and executable scripts")
class Lifetime(unittest.TestCase):
    def test_turn_end_hook_reminds_and_compaction_reloads_the_brief_with_the_handoff(self):
        with tempfile.TemporaryDirectory(prefix="dispatch life ") as folder:
            root = Path(folder).resolve()
            plugin = root / "dispatch.mjs"
            plugin.write_text(Path(opencode_engine.PLUGIN_SOURCE).read_text())
            fake = root / "fake dispatch"
            fake.write_text(FAKE_HEAD + """
  fs.appendFileSync(process.env.LIFE_CALLS, JSON.stringify({args, data, session: process.env.DISPATCH_SESSION_ID}) + "\\n");
  if (data.hook_event_name === "SessionStart") say(data.source === "compact" ? "# brief\\n## 最新交接\\nHANDOFF-CANARY" : "# brief");
  else if (process.env.LIFE_CASE === "limit") process.stdout.write(JSON.stringify({decision: "block", reason: "LIMIT write a handoff"}));
  else if (process.env.LIFE_CASE === "quiet") process.stdout.write("{}");
  else process.stdout.write(JSON.stringify({systemMessage: "REMINDER write a handoff soon"}));
});
""")
            fake.chmod(0o755)
            script = r"""
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { DispatchPlugin } = await import(pathToFileURL(process.env.LIFE_PLUGIN).href);
const hooks = await DispatchPlugin({directory: process.env.LIFE_CWD});
const system = async (sessionID) => { const o = {system: ["base"]}; await hooks["experimental.chat.system.transform"]({sessionID}, o); return o.system; };
const calls = () => readFileSync(process.env.LIFE_CALLS, "utf8").trim().split("\n").map(JSON.parse);
const stops = () => calls().filter((c) => c.data.hook_event_name === "Stop");
const settle = async () => { for (let i = 0; i < 100 && stops().length < want; i++) await new Promise((r) => setTimeout(r, 30)); await new Promise((r) => setTimeout(r, 50)); };
// the hook's answer reaches the system prompt a moment after its call is logged: poll, do not race (busy Macs)
const eventually = async (sessionID, expected) => { let got; for (let i = 0; i < 100; i++) { got = await system(sessionID); try { assert.deepEqual(got, expected); return; } catch {} await new Promise((r) => setTimeout(r, 30)); } assert.deepEqual(got, expected); };
let want = 0;
assert.deepEqual(await system("s1"), ["base", "# brief"]);
// A turn ends: the Stop hook of Claude Code and Codex, for OpenCode.
want = 1; await hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}}); await settle();
const hook = stops()[0];
assert.deepEqual(hook.args, ["hook", "opencode"]);
assert.deepEqual(hook.data, {hook_event_name: "Stop", session_id: "s1", cwd: process.env.LIFE_CWD});
assert.equal(hook.session, "s1");
await eventually("s1", ["base", "# brief", "REMINDER write a handoff soon"]);
assert.deepEqual(await system("s1"), ["base", "# brief", "REMINDER write a handoff soon"]); // every request of the turn
assert.deepEqual(await system("s2"), ["base", "# brief"]); // other sessions untouched
process.env.LIFE_CASE = "limit";
want = 2; await hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}}); await settle();
await eventually("s1", ["base", "# brief", "LIMIT write a handoff"]);
process.env.LIFE_CASE = "quiet";
want = 3; await hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}}); await settle();
await eventually("s1", ["base", "# brief"]); // cleared once the hook has nothing to say
// Compaction: the cached brief is dropped and the next one carries the latest handoff.
await hooks.event({event: {type: "session.compacted", properties: {sessionID: "s1"}}});
const after = await system("s1");
assert.ok(after.join("\n").includes("HANDOFF-CANARY"), after.join("|"));
const primes = calls().filter((c) => c.data.hook_event_name === "SessionStart" && c.session === "s1");
assert.equal(primes.at(-1).data.source, "compact");
assert.equal(primes.length, 2);
await system("s1");
assert.equal(calls().filter((c) => c.data.hook_event_name === "SessionStart" && c.session === "s1").length, 2); // cached again
console.log(JSON.stringify({ok: true}));
"""
            env = {**os.environ, "DISPATCH_CLI": str(fake), "LIFE_CALLS": str(root / "calls.jsonl"),
                   "LIFE_PLUGIN": str(plugin), "LIFE_CWD": str(root)}
            env.pop("LIFE_CASE", None)
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["ok"])


@unittest.skipUnless(shutil.which("node") and os.name != "nt", "requires Node and executable scripts")
class TheEntryBesideIt(unittest.TestCase):
    def test_in_the_app_s_layout_it_runs_hook_py_itself(self):
        """Linked from the app (agent/opencode/dispatch.js next to cli/hook.py), it runs Dispatch's entry with python
        directly, not through the slower `dispatch` command."""
        with tempfile.TemporaryDirectory(prefix="dispatch app ") as folder:
            root = Path(folder).resolve()
            (root / "agent" / "opencode").mkdir(parents=True)
            (root / "cli").mkdir()
            plugin = root / "agent" / "opencode" / "dispatch.mjs"
            plugin.write_text(Path(opencode_engine.PLUGIN_SOURCE).read_text())
            (root / "cli" / "hook.py").write_text("# the entry")
            link = root / "plugins" / "dispatch.mjs"
            link.parent.mkdir()
            link.symlink_to(plugin)
            py = root / "fake python"
            py.write_text(FAKE_HEAD + """
  fs.appendFileSync(process.env.CALLS, JSON.stringify({args}) + "\\n");
  say("# brief from the entry");
});
""")
            py.chmod(0o755)
            script = r"""
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { DispatchPlugin } = await import(pathToFileURL(process.env.PLUGIN).href);
const hooks = await DispatchPlugin({directory: process.env.CWD});
const o = {system: []};
await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, o);
assert.deepEqual(o.system, ["# brief from the entry"]);
const calls = readFileSync(process.env.CALLS, "utf8").trim().split("\n").map(JSON.parse);
assert.deepEqual(calls[0].args, [process.env.HOOK, "opencode"]);
console.log(JSON.stringify({ok: true}));
"""
            env = {**os.environ, "DISPATCH_PYTHON": str(py), "DISPATCH_CLI": "/nowhere/dispatch", "CALLS": str(root / "calls.jsonl"),
                   "PLUGIN": str(link), "CWD": str(root), "HOOK": str(root / "cli" / "hook.py")}
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                    env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
