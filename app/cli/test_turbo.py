# -*- coding: utf-8 -*-
"""dispatch turbo: splitting, the forecast, the allowance rules, and a whole run with a stand-in agent in real git copies."""
import json
import re
import contextlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import turbo  # noqa: E402

# A stand-in for `opencode run --format json`: answers the split prompt with a plan, does a part (a file, a commit,
# a step, a report), asks once when the part says ASKME, and fits itself to the combined branch when asked to.
FAKE = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys, time
args = sys.argv[1:]
prompt = args[args.index("--") + 1] if "--" in args else args[-1]
session = args[args.index("--session") + 1] if "--session" in args else "ses_fake%d" % os.getpid()
print(json.dumps({"type": "step_start", "sessionID": session, "part": {"type": "step-start"}}), flush=True)
def say(t):
    print(json.dumps({"type": "text", "sessionID": session, "part": {"type": "text", "text": t}}), flush=True)
def sh(*a):
    return subprocess.run(list(a), capture_output=True, text=True)
if "Split this job" in prompt:
    say(json.dumps({"title": "Two notes", "parts": [
        {"name": "Write note A", "full": "a.txt says A", "files": ["a.txt", "shared.txt"], "after": [], "minutes": 20},
        {"name": "Write note B", "full": "b.txt says B", "files": ["b.txt", "shared.txt"], "after": [1], "minutes": 10}]}))
    sys.exit(0)
prov = os.environ.get("FAKE_PROVIDER", "")
if prov and "Your part:" in prompt:
    # what OpenCode's error log says (--print-logs) while its provider refuses: it retries and prints nothing else
    msg = "余额不足或无可用资源包,请充值。" if prov == "out" else "Rate limit reached for requests"
    for i in range(400 if prov == "out" else 2):
        sys.stderr.write('timestamp=2026-10-06T14:48:58.383Z level=ERROR run=x message="stream error" providerID=zhipu modelID=glm session.id=%s small=false agent="build" mode=primary error.error="AI_APICallError: %s"\n' % (session, msg))
        sys.stderr.flush()
        time.sleep(0.05)
time.sleep(float(os.environ.get("FAKE_SLEEP", "0.2")))
step = re.search(r"(\S+ \S+) turbo step (tb-\S+) (\S+) ", prompt)
report = re.search(r"report (?:again )?to (/\S+?\.md)", prompt)
cli = step.group(1).split(" ") if step else None
if cli:
    subprocess.run(cli + ["turbo", "step", step.group(2), step.group(3), "Writing the note"])
print(json.dumps({"type": "tool_use", "sessionID": session, "part": {"type": "tool", "tool": "edit", "state": {"input": {"filePath": os.getcwd() + "/x.txt"}}}}), flush=True)
if "ASKME" in prompt and "The person answered" not in prompt:
    ask = re.search(r"(\S+ \S+) turbo ask (tb-\S+) (\d+) ", prompt)
    subprocess.run(ask.group(1).split(" ") + ["turbo", "ask", ask.group(2), ask.group(3), "Blue or green?", "--option", "Blue", "--option", "Green"])
    say("I asked.")
    sys.exit(0)
if "could not be combined" in prompt:
    m = re.search(r"merge branch (\S+) into your branch", prompt)
    sh("git", "merge", "-X", "ours", "--no-edit", m.group(1))
elif prompt.startswith("Continue where you left off"):
    with open("resumed.txt", "w") as f:
        f.write("carried on\n")
    sh("git", "add", "-A"); sh("git", "commit", "-q", "-m", "carried on")
elif "Your part:" in prompt or "The person answered" in prompt:
    m = re.search(r"Your part: (.*)", prompt)
    what = m.group(1) if m else "answered"
    name = "a.txt" if "a.txt" in what else "b.txt" if "b.txt" in what else "c.txt"
    with open(name, "w") as f:
        f.write(what + "\n")
    if os.environ.get("FAKE_CONFLICT"):
        with open("same.txt", "w") as f:
            f.write(name + "\n")
    sh("git", "add", "-A"); sh("git", "commit", "-q", "-m", "note " + name)
else:
    with open("final-%s.txt" % (re.search(r"Your step: (\w+)", prompt).group(1).lower()), "w") as f:
        f.write("ok\n")
    sh("git", "add", "-A"); sh("git", "commit", "-q", "-m", "final")
if report:
    os.makedirs(os.path.dirname(report.group(1)), exist_ok=True)
    open(report.group(1), "w").write("Done. Checked it.\n")
say("Done.")
'''


# A stand-in for `codex exec --json`: a HOLD part works until .turbo-stop appears, leaves half its work and stops;
# any other part writes its file, commits and reports.
FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys, time
prompt = sys.argv[-1]
print(json.dumps({"type": "thread.started", "thread_id": "0199aaaa-bbbb-cccc-dddd-%012d" % os.getpid()}), flush=True)
m = re.search(r"Your part: (.*)", prompt)
what = m.group(1) if m else "final"
name = "a.txt" if "a.txt" in what else "b.txt" if "b.txt" in what else "final-codex.txt"
report = re.search(r"report (?:again )?to (/\S+?\.md)", prompt)
if "HOLD" in what:
    for _ in range(200):
        if os.path.exists(".turbo-stop"):
            break
        time.sleep(0.1)
    open(name, "w").write("half of " + what + "\n")
    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Wrote half of the note."}}), flush=True)
    sys.exit(0)
open(name, "w").write(what + "\n")
subprocess.run(["git", "add", "-A"]); subprocess.run(["git", "commit", "-q", "-m", "note " + name])
if report:
    os.makedirs(os.path.dirname(report.group(1)), exist_ok=True)
    open(report.group(1), "w").write("Done.\n")
'''


def git(cwd, *a):
    return subprocess.run(["git", "-C", cwd] + list(a), capture_output=True, text=True, check=True).stdout.strip()


class Pure(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        turbo.D = types.SimpleNamespace(DISPATCH_DIR=self.tmp, BEADS_DIR=os.path.join(self.tmp, ".beads"), child_env=lambda: dict(os.environ))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_with(self, parts, slots=4, state="running"):
        r = {"id": "tb-1001-1200-abcd", "ask": "x", "engine": "claude", "slots": slots, "state": state, "parts": [], "quota": {},
             "finals": [{"id": i, "name": n, "est": m, "status": "waiting"} for i, n, m in turbo.FINALS]}
        _, ps = turbo.parse_parts({"parts": parts})
        for p in ps:
            p["status"] = "waiting"
        r["parts"] = ps
        return r

    def test_the_split_uses_the_agent_picked_in_the_input_box_and_says_why_it_failed(self):
        """task-o8wx: OpenCode + DeepSeek Flash were picked, the split ran on Claude and failed with "The plan has no parts"."""
        turbo.config_save(engine="claude")
        self.assertEqual(turbo.engine_choice("opencode", "deepseek/deepseek-flash")[:2], ("opencode", "deepseek/deepseek-flash"))
        r = {"engine": "opencode", "model": "deepseek/deepseek-flash"}
        self.assertEqual(turbo.split_error(r, "", "Sure, here are some thoughts."),
                         "I could not split the job: OpenCode (deepseek-flash) answered, but not with a plan of parts. Try again, or pick another agent in the input box.")
        self.assertIn("OpenCode (deepseek-flash) gave no answer", turbo.split_error(r, "", ""))
        self.assertIn("is not signed in", turbo.split_error({"engine": "codex"}, "Error: not logged in", ""))
        self.assertEqual(turbo.split_error({"engine": "claude"}, "Claude is not installed on this Mac.", ""), "I could not split the job: Claude is not installed on this Mac.")
        # the whole background split: the run fails with those words, and the agent asked is the one picked
        repo = os.path.join(self.tmp, "site")
        os.makedirs(repo)
        subprocess.run(["git", "-C", repo, "init", "-q"], check=True)
        subprocess.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"], check=True)
        run = turbo.new_run("Fix the header and the footer", repo, "opencode", "deepseek/deepseek-flash")
        turbo.save(run)
        asked = []
        with mock.patch.object(turbo, "ask_model", lambda r, p, f, n: asked.append((r["engine"], r["model"])) or ("no plan here", "")):
            turbo.split_in_background(run["id"])
        got = turbo.load(run["id"])
        self.assertEqual(asked, [("opencode", "deepseek/deepseek-flash")] * 2)
        self.assertEqual(got["state"], "failed")
        self.assertIn("OpenCode (deepseek-flash) answered, but not with a plan of parts", got["error"])

    def test_parse_parts_from_model_text(self):
        text = 'Sure! Here it is:\n```json\n{"title": "Next version", "parts": [{"name": "Fix setup", "files": ["./a.py", "b.py"], "minutes": "45"},' \
               ' {"name": "Docs", "after": [1, 3, 2], "minutes": 999}, {"name": ""}]}\n```'
        title, parts = turbo.parse_parts(text)
        self.assertEqual(title, "Next version")
        self.assertEqual([p["n"] for p in parts], [1, 2])
        self.assertEqual(parts[0]["files"], ["a.py", "b.py"])
        self.assertEqual(parts[0]["est"], 45)
        self.assertEqual(parts[1]["after"], [1])  # only backwards: no cycles, no unknown parts
        self.assertEqual(parts[1]["est"], 240)
        with self.assertRaises(turbo.UserError):
            turbo.parse_parts("no json here")

    def test_files_several_parts_change_are_kept_for_the_end(self):
        _, parts = turbo.parse_parts({"parts": [{"name": "a", "files": ["x", "dispatch.py"]}, {"name": "b", "files": ["dispatch.py", "y"]}, {"name": "c", "files": ["y"]}]})
        self.assertEqual(turbo.shared_files(parts), [{"file": "dispatch.py", "parts": [1, 2]}, {"file": "y", "parts": [2, 3]}])

    def test_forecast_runs_parts_side_by_side_and_waits_for_after(self):
        r = self.run_with([{"name": "a", "minutes": 60}, {"name": "b", "minutes": 30}, {"name": "c", "minutes": 30, "after": [1]}], slots=2, state="planned")
        now = 1_000_000.0
        fc = turbo.forecast(r, now)
        a, b, c = fc["parts"]["1"], fc["parts"]["2"], fc["parts"]["3"]
        self.assertEqual(a[0], now)
        self.assertEqual(b[0], now)  # two at a time
        self.assertGreaterEqual(c[0], a[1] + turbo.MERGE_MIN * 60)  # after part 1 is combined
        one = turbo.forecast(r, now, slots=1)
        self.assertGreater(one["done_at"], fc["done_at"])
        pv = turbo.plan_view(r, now)
        self.assertEqual(set(pv["options"]), {"2", "4", "6"})
        self.assertIn("Done around", pv["done_words"])
        self.assertTrue(pv["allowance"].startswith("About "))
        self.assertEqual(pv["planned_pct"] % 5, 0)

    def test_two_one_line_parts_are_forecast_in_minutes_not_three_quarters_of_an_hour(self):
        # task-npkp3: two one-line changes were forecast 46 minutes ("one part after another: about 1 h 2 min"); they took 8
        r = self.run_with([{"name": "Footer", "minutes": 3, "files": ["index.html"]}, {"name": "Blue button", "minutes": 3, "files": ["style.css"]}],
                          slots=4, state="planned")
        now = 1_000_000.0
        pv = turbo.plan_view(r, now)
        self.assertLess(pv["minutes"], 12)
        self.assertLess(pv["sequential_minutes"], 15)
        fc = turbo.forecast(r, now)
        self.assertEqual(fc["finals"]["shared"][0], fc["finals"]["shared"][1])  # no shared files: no time for them
        # the split is asked for honest minutes, and a part can be shorter than 5
        self.assertIn("1 to 3 minutes", turbo.SPLIT_PROMPT)
        _, ps = turbo.parse_parts({"parts": [{"name": "x", "minutes": 2}]})
        self.assertEqual(ps[0]["est"], 2)
        # a big job keeps sizeable finals
        big = self.run_with([{"name": str(i), "minutes": 60} for i in range(4)], slots=4, state="planned")
        self.assertEqual(turbo.final_est(big, next(f for f in big["finals"] if f["id"] == "tests")), 10)

    def test_one_small_part_is_forecast_near_the_minutes_it_takes(self):
        # task-lj06.29: "Add footer and item count" as one part was forecast about 22 minutes and took 3
        r = self.run_with([{"name": "Footer and item count", "minutes": 5, "files": ["index.html", "app.js"]}], slots=2, state="planned")
        now = 1_000_000.0
        pv = turbo.plan_view(r, now)
        self.assertLess(pv["minutes"], 8)
        self.assertEqual(pv["options"], {})  # one part runs alone: no "At a time" to pick
        self.assertIn("a footer, a counter", turbo.SPLIT_PROMPT)
        self.assertEqual(turbo.parts_words(1), "1 part")
        self.assertEqual(turbo.parts_words(3), "3 parts")

    def test_parts_run_marked_as_turbo_with_an_unseen_browser(self):
        # task-aqu6u: what keeps a part's pages out of the person's right panel (ide_show.turbo_part)
        env = turbo._child_env({"id": "tb-1007-0300-abcd", "engine": "opencode"})
        self.assertEqual(env["DISPATCH_TURBO_RUN"], "tb-1007-0300-abcd")
        self.assertEqual(env["DISPATCH_BROWSER_HEADLESS"], "1")

    def test_the_forecast_learns_how_long_this_agent_really_takes(self):
        r = self.run_with([{"name": "a", "minutes": 20}, {"name": "b", "minutes": 20}], slots=2, state="planned")
        before = turbo.plan_view(r, 1_000_000.0)["minutes"]
        # a finished run whose parts said 20 minutes and worked 4
        for p in r["parts"]:
            p.update(status="combined", segs=[[0, 240, "work"]])
        turbo.remember_pace(r)
        self.assertAlmostEqual(turbo.learned_pace(r["engine"]), 0.2)
        r2 = self.run_with([{"name": "a", "minutes": 20}, {"name": "b", "minutes": 20}], slots=2, state="planned")
        r2["pace"] = turbo.learned_pace("claude")  # what new_run puts in a new run
        after = turbo.plan_view(r2, 1_000_000.0)["minutes"]
        self.assertLess(after, before / 2)

    def test_allowance_no_reserve_slow_at_80_then_stop_before_the_limit(self):
        r = self.run_with([{"name": str(i), "minutes": 30} for i in range(6)], slots=6)
        for p in r["parts"][:6]:
            p["status"] = "working"
        now = 2_000_000.0
        resets = now + 4 * 3600
        # 60% with a slow pace: nothing changes (no reserve of its own)
        r["rate"] = 0.001
        self.assertEqual(turbo.govern(r, {"used_percent": 60, "resets_at": resets}, now), "")
        self.assertEqual(turbo.slots_now(r), 6)
        # 80%: half as many at once, once per period
        self.assertEqual(turbo.govern(r, {"used_percent": 80, "resets_at": resets}, now + 60), "slowed")
        self.assertEqual(turbo.slots_now(r), 3)
        self.assertEqual(turbo.govern(r, {"used_percent": 85, "resets_at": resets}, now + 120), "")
        # 97%: a clean stop until the refill
        self.assertEqual(turbo.govern(r, {"used_percent": 97, "resets_at": resets}, now + 180), "paused")
        self.assertEqual(r["quota"]["resume_at"], resets)
        # the refill: back to normal
        self.assertEqual(turbo.govern(r, {"used_percent": 2, "resets_at": resets + 5 * 3600}, resets + 60), "resumed")
        self.assertFalse(r["quota"]["slowed"])
        self.assertEqual(turbo.slots_now(r), 6)

    def test_allowance_slows_when_the_pace_reaches_the_limit_before_the_refill(self):
        r = self.run_with([{"name": str(i), "minutes": 240} for i in range(4)])
        for p in r["parts"]:
            p["status"] = "working"
        now = 3_000_000.0
        # 50% used, 4 parts at 4%/h each = 16%/h, 4 h to the refill (the run lasts longer): 114% → slow down now
        self.assertEqual(turbo.govern(r, {"used_percent": 50, "resets_at": now + 4 * 3600}, now), "slowed")
        self.assertEqual(r["quota"]["slowed_why"], "pace")
        self.assertEqual(turbo.slots_now(r), 2)
        # keep 4 at a time: the person said so
        r2 = self.run_with([{"name": str(i), "minutes": 240} for i in range(4)])
        for p in r2["parts"]:
            p["status"] = "working"
        r2["hold_slots"] = True
        self.assertEqual(turbo.govern(r2, {"used_percent": 50, "resets_at": now + 4 * 3600}, now), "")
        self.assertEqual(turbo.govern(r2, {"used_percent": 98, "resets_at": now + 4 * 3600}, now), "paused")

    def test_a_run_that_ends_before_the_limit_does_not_slow_down(self):
        # the same pace, but the parts are short: the run is done long before the allowance would fill
        r = self.run_with([{"name": str(i), "minutes": 30} for i in range(4)])
        for p in r["parts"]:
            p["status"] = "working"
        now = 3_000_000.0
        self.assertEqual(turbo.govern(r, {"used_percent": 50, "resets_at": now + 4 * 3600}, now), "")
        self.assertEqual(turbo.slots_now(r), 4)

    def test_every_window_counts_the_weekly_one_too(self):
        r = self.run_with([{"name": str(i), "minutes": 60} for i in range(4)])
        for p in r["parts"]:
            p["status"] = "working"
        now = 4_000_000.0
        week = now + 3 * 86400
        wins = lambda five, wk: {"windows": [{"kind": "session", "used_percent": five, "resets_at": now + 3600},
                                             {"kind": "weekly", "used_percent": wk, "resets_at": week}]}
        # the 5-hour window is low, the weekly one is at 81%: half as many at once, and the words say which
        self.assertEqual(turbo.govern(r, wins(10, 81), now), "slowed")
        self.assertEqual(r["quota"]["slowed_kind"], "weekly")
        self.assertEqual(r["quota"]["used"], 81)
        self.assertEqual(turbo.slots_now(r), 2)
        # the 5-hour window refilling does not undo a slow-down that the weekly window asked for
        self.assertEqual(turbo.govern(r, {"windows": [{"kind": "session", "used_percent": 1, "resets_at": now + 5 * 3600},
                                                      {"kind": "weekly", "used_percent": 82, "resets_at": week}]}, now + 3700), "")
        self.assertTrue(r["quota"]["slowed"])
        # the weekly window at 97%: stop until the weekly refill, not the 5-hour one
        self.assertEqual(turbo.govern(r, wins(20, 97), now + 3800), "paused")
        self.assertEqual(r["quota"]["resume_at"], week)
        self.assertEqual(r["quota"]["paused_kind"], "weekly")
        # a weekly window with a slow measured pace and no limit near: nothing (no reserve, no rate guess for it)
        r2 = self.run_with([{"name": str(i), "minutes": 600} for i in range(4)])
        for p in r2["parts"]:
            p["status"] = "working"
        self.assertEqual(turbo.govern(r2, {"windows": [{"kind": "weekly", "used_percent": 60, "resets_at": week}]}, now), "")
        self.assertEqual(turbo.govern(r2, {"windows": [{"kind": "weekly", "used_percent": 60.5, "resets_at": week}]}, now + 600), "")
        # but a fast measured weekly pace that reaches 100% before the run ends slows it down
        self.assertEqual(turbo.govern(r2, {"windows": [{"kind": "weekly", "used_percent": 66, "resets_at": week}]}, now + 1200), "slowed")
        self.assertEqual(r2["quota"]["slowed_why"], "pace")

    def test_reading_comes_from_the_account_in_use(self):
        calls = []

        class Done:
            stdout = json.dumps([{"engine": "claude", "account": {"name": "me@example.com"}, "top": {"kind": "weekly", "used_percent": 78, "resets_at": time.time() + 9e4},
                                  "windows": [{"kind": "session", "used_percent": 13.0, "resets_at": time.time() + 3600},
                                              {"kind": "weekly", "used_percent": 78.0, "resets_at": time.time() + 9e4},
                                              {"kind": "session", "used_percent": 99.0, "resets_at": time.time() - 3600}]}])

        def fake_run(argv, **kw):
            calls.append(argv)
            return Done()
        real = turbo.subprocess.run
        turbo.subprocess.run = fake_run
        try:
            rd = turbo.reading("claude")
        finally:
            turbo.subprocess.run = real
        self.assertEqual(calls[0][2:], ["accounts", "status", "claude", "--json"])  # the engine is positional
        self.assertEqual(rd["used_percent"], 78.0)
        self.assertEqual(rd["kind"], "weekly")
        self.assertEqual(rd["account"], "me@example.com")
        self.assertEqual([w["kind"] for w in rd["windows"]], ["session", "weekly"])  # a window already refilled is dropped
        self.assertIsNone(turbo.reading("opencode"))

    def test_config_and_engine_choice(self):
        self.assertEqual(turbo.engine_choice(), ("claude", "", ""))
        turbo.config_save(engine="opencode", model="deepseek/deepseek-flash")
        self.assertEqual(turbo.engine_choice(), ("opencode", "deepseek/deepseek-flash", ""))
        self.assertEqual(turbo.engine_choice("claude"), ("claude", "", ""))  # the OpenCode model is not carried over
        with self.assertRaises(turbo.UserError):
            turbo.engine_choice("gemini")

    def test_the_timeline_shows_a_failed_split_until_dismissed_and_not_a_dismissed_plan(self):
        r = self.run_with([{"name": "a"}], state="failed")
        r.update(created_at=time.time(), id="tb-1001-1200-abcd", forecast={})
        turbo.save(r)
        self.assertEqual(turbo.shown_run()["state"], "failed")
        turbo.change(r["id"], lambda r: r.update(state="cancelled", done_at=time.time()))
        self.assertIsNone(turbo.shown_run())  # dismissed: never started, so not shown again
        turbo.change(r["id"], lambda r: r.update(started_at=time.time() - 60))
        self.assertEqual(turbo.shown_run()["state"], "cancelled")  # a run that ran stays for a while

    def test_a_plan_made_in_the_same_minute_as_a_dismissed_one_is_the_one_shown(self):
        # ids made in the same minute differ only in their random end; the dismissed one sorts after the new one by id
        now = time.time()
        old = self.run_with([{"name": "a"}], state="cancelled")
        old.update(id="tb-1001-1200-ffff", created_at=now - 20, done_at=now - 5, forecast={})
        turbo.save(old)
        new = self.run_with([{"name": "b"}, {"name": "c"}], state="planned")
        new.update(id="tb-1001-1200-0001", created_at=now - 2, forecast={})
        turbo.save(new)
        self.assertEqual(turbo.run_ids(), ["tb-1001-1200-0001", "tb-1001-1200-ffff"])
        self.assertEqual(turbo.latest_run()["id"], "tb-1001-1200-0001")

    def test_a_report_gives_its_first_plain_sentence(self):
        self.assertEqual(turbo.report_line("# Part 1 report\n\n## What I changed\n- Added CHANGELOG.md with one dated entry. More.\n"),
                         "Added CHANGELOG.md with one dated entry.")
        self.assertEqual(turbo.report_line("Part 3 report — footer with current year"), "footer with current year")
        self.assertEqual(turbo.report_line(""), "")

    def test_what_opencodes_provider_says_is_read_from_its_error_log(self):
        log = os.path.join(self.tmp, "agent-1.log")
        lines = [
            '{"type":"step_start","sessionID":"ses_1"}',
            'timestamp=2026-10-06T14:47:57.158Z level=ERROR run=5874dffb message="stream error" providerID=fakeai modelID=m1 session.id=ses_1 small=false agent="build" mode=primary error.error="AI_APICallError: Rate limit reached for requests"',
            'timestamp=2026-10-06T14:49:04.480Z level=ERROR run=775edb51 message="stream error" providerID=zhipu modelID=glm session.id=ses_1 small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: 余额不足或无可用资源包,请充值。"',
            'timestamp=2026-10-06T14:49:05.000Z level=ERROR run=1 message="stream error" error.error="AI_APICallError: Unexpected token"',
            '{"type":"error","sessionID":"ses_1","error":{"name":"APIError","data":{"message":"429 Too Many Requests","statusCode":429}}}',
        ]
        with open(log, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        p = {"log": log, "engine": "opencode"}
        self.assertEqual(turbo.provider_said(p), [("rate", "Rate limit reached for requests"), ("out", "余额不足或无可用资源包,请充值。"),
                                                  ("rate", "429 Too Many Requests")])
        self.assertEqual(turbo.provider_said(p), [])  # each line is read once
        with open(log, "a", encoding="utf-8") as f:
            f.write(lines[1][:60])  # half a line: read once it is whole
        self.assertEqual(turbo.provider_said(p), [])
        with open(log, "a", encoding="utf-8") as f:
            f.write(lines[1][60:] + "\n")
        self.assertEqual(turbo.provider_said(p), [("rate", "Rate limit reached for requests")])
        self.assertTrue(turbo.hit_limit(log))

    def test_opencode_slows_on_too_many_requests_and_comes_back_after_quiet(self):
        r = self.run_with([{"name": "A", "full": "a"}, {"name": "B", "full": "b"}], slots=4)
        r["engine"] = "opencode"
        log = os.path.join(self.tmp, "a.log")
        open(log, "w").close()
        r["parts"][0].update(status="working", log=log, engine="opencode")
        rate = 'level=ERROR message="stream error" error.error="AI_APICallError: Rate limit reached for requests"\n'
        t = 1000000.0
        self.assertEqual(turbo.watch_provider(r, t), "")
        self.assertIn("does not report an allowance", turbo.allowance_now_words(r, t))
        with open(log, "a") as f:
            f.write(rate)
        self.assertEqual(turbo.watch_provider(r, t + 5), "slowed")
        self.assertEqual(turbo.slots_now(r), 2)
        self.assertEqual(r["parts"][0]["activity"], "Waiting: the provider says too many requests")
        self.assertIn("provider said too many requests at", turbo.allowance_now_words(r, t + 5))
        self.assertIn("2 at a time", turbo.allowance_now_words(r, t + 5))
        with open(log, "a") as f:
            f.write(rate)
        self.assertEqual(turbo.watch_provider(r, t + 60), "")  # too soon to halve again
        with open(log, "a") as f:
            f.write(rate)
        self.assertEqual(turbo.watch_provider(r, t + 5 + turbo.RATE_AGAIN), "slower")
        self.assertEqual(turbo.slots_now(r), 1)
        t2 = t + 5 + turbo.RATE_AGAIN
        self.assertEqual(turbo.watch_provider(r, t2 + turbo.RATE_QUIET - 1), "")
        self.assertEqual(turbo.watch_provider(r, t2 + turbo.RATE_QUIET + 1), "restored")
        self.assertEqual(turbo.slots_now(r), 4)
        v = turbo.view(dict(r, state="running", slots=4), t2 + turbo.RATE_QUIET + 2)
        self.assertTrue(v["allowance"]["watch"])
        self.assertIn("listens to its provider", v["plan"]["rule"])

    def test_opencode_stops_when_the_balance_ran_out_and_tries_again_later(self):
        r = self.run_with([{"name": "A", "full": "a"}], slots=2)
        r["engine"] = "opencode"
        log = os.path.join(self.tmp, "a.log")
        with open(log, "w") as f:
            f.write('level=ERROR message="stream error" error.error="AI_APICallError: 余额不足或无可用资源包,请充值。"\n')
        r["parts"][0].update(status="working", log=log, engine="opencode")
        t = 1000000.0
        self.assertEqual(turbo.watch_provider(r, t), "out")
        q = r["quota"]
        self.assertEqual((q["paused"], q["paused_kind"], q["resume_at"]), (True, "provider", t + turbo.OUT_RETRY))
        words = turbo.allowance_now_words(r, t)
        self.assertIn("balance or plan ran out", words)
        self.assertIn("余额不足", words)
        v = turbo.view(dict(r, state="paused"), t)
        self.assertIn("tries again at", v["allowance"]["stopped_words"])
        r["parts"][0]["status"] = "paused"
        self.assertEqual(turbo.watch_provider(r, t + turbo.OUT_RETRY + 1), "retry")
        self.assertFalse(r["quota"]["paused"])
        self.assertEqual(len(r["quota"]["stops"]), 1)

    def test_unreadable_allowance_changes_nothing(self):
        r = self.run_with([{"name": "a"}])
        self.assertEqual(turbo.govern(r, None), "")
        self.assertFalse(r["quota"]["known"])
        r["engine"] = "opencode"
        self.assertIn("listens to its provider", turbo.allowance_now_words(r, time.time()))

    def test_last_activity_in_plain_words(self):
        log = os.path.join(self.tmp, "a.log")
        with open(log, "w") as f:
            f.write(json.dumps({"type": "tool_use", "part": {"tool": "edit", "state": {"input": {"filePath": "/x/app/cli/turbo.py"}}}}) + "\n")
        self.assertEqual(turbo.last_activity("opencode", log), "Editing turbo.py")
        with open(log, "w") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "npm test  -- --run"}}]}}) + "\n")
        self.assertEqual(turbo.last_activity("claude", log), "Running npm test -- --run")
        with open(log, "w") as f:
            f.write(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "**Done**. The tests pass now. More text."}}) + "\n")
        self.assertEqual(turbo.last_activity("codex", log), "Done. The tests pass now.")
        with open(log, "w") as f:
            f.write(json.dumps({"type": "step_start", "sessionID": "ses_abc123"}) + "\n")
        self.assertEqual(turbo.session_of("opencode", log), "ses_abc123")


class WholeRun(unittest.TestCase):
    """A real run: git copies, a stand-in agent, merges, finals and bringing the result in."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        fake = os.path.join(self.bin, "opencode")
        with open(fake, "w") as f:
            f.write(FAKE)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        self.repo = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(self.repo, "app", "node_modules", "pkg"))
        subprocess.run(["git", "init", "-q", "-b", "main", self.repo], check=True)
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "T")
        with open(os.path.join(self.repo, "README"), "w") as f:
            f.write("hi\n")
        with open(os.path.join(self.repo, "app", "main.js"), "w") as f:
            f.write("1\n")
        with open(os.path.join(self.repo, ".gitignore"), "w") as f:
            f.write("node_modules/\n")
        with open(os.path.join(self.repo, ".env"), "w") as f:
            f.write("X=1\n")
        git(self.repo, "add", "README", ".gitignore", "app/main.js")
        git(self.repo, "commit", "-q", "-m", "init")
        self.ddir = os.path.join(self.tmp, "dd")
        self.env = {"DISPATCH_IDE_BIN": self.bin, "DISPATCH_DIR": self.ddir, "FAKE_SLEEP": "0.1"}
        self.old = {k: os.environ.get(k) for k in list(self.env) + ["FAKE_CONFLICT"]}
        os.environ.update(self.env)
        turbo.D = types.SimpleNamespace(DISPATCH_DIR=self.ddir, BEADS_DIR=os.path.join(self.tmp, ".beads"), child_env=lambda: dict(os.environ))

    def tearDown(self):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def drive(self, rid, until, limit=60):
        t0 = time.time()
        while time.time() - t0 < limit:
            with turbo.locked(rid):
                r = turbo.load(rid)
                turbo.tick(r, time.time(), False)
                turbo.save(r)
            if until(r):
                return r
            time.sleep(0.3)
        self.fail("the run did not get there: %s" % json.dumps({k: r[k] for k in ("state",)}) + str([(p["n"], p.get("status")) for p in r["parts"]])
                  + str([(f["id"], f["status"]) for f in r["finals"]]) + "\n" + self.why(r))

    def why(self, r):
        """What the parts' agents were doing when the run got stuck: attempts, process state, exit files, log tails."""
        out = []
        for p in list(r["parts"]) + list(r.get("finals") or []):
            pid = p.get("pid")
            ps = subprocess.run(["ps", "-o", "pid=,stat=,etime=,command=", "-p", str(pid)], capture_output=True, text=True).stdout.strip() if pid else ""
            ex = p.get("exit_file") or ""
            out.append("part %s status=%s pid=%s alive=%s ps=[%s] exit=%s attempts=%s events=%s" % (
                p.get("n", p.get("id")), p.get("status"), pid, turbo.alive(p) if pid else None, ps,
                open(ex).read() if ex and os.path.exists(ex) else "none", json.dumps(p.get("attempts"))[:600],
                json.dumps([e for e in r.get("events", []) if p.get("n") and e.get("part") == p.get("n")][-6:])[:600]))
            for a in (p.get("attempts") or [])[-2:]:
                try:
                    out.append("  log %s: %s" % (a["log"], open(a["log"], errors="replace").read()[-800:]))
                except OSError as e:
                    out.append("  log %s: %s" % (a.get("log"), e))
        return "\n".join(out)

    def plan(self, parts, slots=4):
        r = turbo.new_run("Write two notes", self.repo, "opencode", slots=slots)
        _, ps = turbo.parse_parts({"parts": parts})
        turbo.set_parts(r, ps, "Two notes")
        r["state"] = "planned"
        turbo.save(r)
        return r["id"]

    def test_split_by_the_model(self):
        r = turbo.new_run("Write two notes", self.repo, "opencode")
        turbo.save(r)
        turbo.split_in_background(r["id"])
        r = turbo.load(r["id"])
        self.assertEqual(r["state"], "planned")
        self.assertEqual(r["title"], "Two notes")
        self.assertEqual([p["name"] for p in r["parts"]], ["Write note A", "Write note B"])
        self.assertEqual(r["shared"], [{"file": "shared.txt", "parts": [1, 2]}])
        self.assertEqual(r["parts"][1]["after"], [1])

    def test_a_whole_run_combines_every_part_and_brings_it_in(self):
        rid = self.plan([{"name": "Note A", "full": "a.txt says A", "files": ["a.txt"]},
                         {"name": "Note B", "full": "b.txt says B", "files": ["b.txt"]},
                         {"name": "Note C", "full": "c.txt after A", "files": ["c.txt"], "after": [1]}], slots=2)
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = turbo.load(rid)
        self.assertTrue(os.path.isdir(r["combine_copy"]))
        r = self.drive(rid, lambda r: r["state"] == "done")
        self.assertEqual([p["status"] for p in r["parts"]], ["combined"] * 3)
        self.assertEqual(sorted(p["combined_n"] for p in r["parts"]), [1, 2, 3])
        c = turbo.part_of(r, 3)
        self.assertGreaterEqual(c["started_at"], turbo.part_of(r, 1)["combined_at"])  # waited for part 1
        self.assertEqual(c.get("said"), "Writing the note")
        self.assertEqual({f["id"]: f["status"] for f in r["finals"]}, {"shared": "skipped", "tests": "done", "check": "done", "land": "done"})
        # the result is in the branch the person works on
        self.assertEqual(sorted(x for x in os.listdir(self.repo) if x.endswith(".txt")), ["a.txt", "b.txt", "c.txt", "final-second.txt", "final-tests.txt"])
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertTrue(os.path.isfile(r["page"]))
        page = open(r["page"], encoding="utf-8").read()
        self.assertIn("Brought into main as commit", page)
        self.assertNotIn("of the allowance", page)  # OpenCode's allowance is not readable: no made-up number
        self.assertEqual(r["summary"]["parts"], 3)
        self.assertEqual(r["summary"]["left"], [])
        # copies are gone, linked folders never got into a commit
        self.assertFalse(os.path.exists(os.path.join(self.ddir, "turbo", rid, "copies", "part-1")))
        self.assertNotIn("node_modules", git(self.repo, "log", "--name-only", "--format="))
        self.assertEqual(git(self.repo, "branch", "--list", "turbo/*"), "")  # nothing of the run is left behind

    def test_the_board_task_is_closed_with_the_page_and_the_commit_when_the_run_is_done(self):
        # task-1wkxk: the Timeline said Done, the board kept "Turbo: …" in progress
        calls = []
        rid = self.plan([{"name": "Note A", "full": "a.txt says A", "files": ["a.txt"]}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        turbo.change(rid, lambda r: r.update(task="task-tb1", own_task=True))
        with mock.patch.object(turbo, "_dispatch", side_effect=lambda *a, **k: calls.append((a, k)) or (True, "")):
            r = self.drive(rid, lambda r: r["state"] == "done")
        landed = r["summary"]["landed"][:12]
        self.assertTrue(landed)
        cmds = [c[0] for c in calls]
        self.assertIn(("task", "deliver", "task-tb1", "--file", r["page"], "--commit", landed), cmds)
        done = next(c for c in calls if c[0][0] == "done")
        self.assertEqual(done[0][1], "task-tb1")
        self.assertIn("1 of 1 part combined", done[0][3])  # never "1 parts" (task-lj06.29)
        self.assertIn("brought into main as " + landed, done[0][3])
        self.assertIn("--verified", done[0])  # its tests and the second check ran
        self.assertEqual(os.path.realpath(done[1]["cwd"]), os.path.realpath(self.repo))  # dispatch done links the commit from the project
        self.assertTrue(r["task_settled"])
        # once only: another look at a finished run settles nothing again
        with mock.patch.object(turbo, "_dispatch", side_effect=lambda *a, **k: calls.append((a, k)) or (True, "")):
            turbo.settle_task(r)
        self.assertEqual(sum(1 for c in calls if c[0][0] == "done"), 1)

    def test_a_task_the_run_was_given_gets_a_note_and_a_stopped_run_closes_its_own(self):
        calls = []
        fake = lambda *a, **k: calls.append(a) or (True, "")
        rid = self.plan([{"name": "Note A", "full": "a.txt says A", "files": ["a.txt"]}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        turbo.change(rid, lambda r: r.update(task="task-given"))  # plan --task: someone else's task
        with mock.patch.object(turbo, "_dispatch", side_effect=fake):
            self.drive(rid, lambda r: r["state"] == "done")
        self.assertFalse(any(c[0] == "done" for c in calls))
        self.assertTrue(any(c[:2] == ("log", "task-given") and re.search(r"\d of \d parts? combined", c[2]) for c in calls))
        calls.clear()
        rid = self.plan([{"name": "Note B", "full": "b.txt says B", "files": ["b.txt"]}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        turbo.change(rid, lambda r: r.update(task="task-own", own_task=True))
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        with mock.patch.object(turbo, "_dispatch", side_effect=fake):
            a = types.SimpleNamespace(turbo_cmd="cancel", args=[rid], json=True, text_opt=None, at_a_time=0)
            turbo._bind(a)
            with contextlib.redirect_stdout(io.StringIO()):  # its JSON otherwise lands after the suite's last line
                turbo.command(a)
        stop = next(c for c in calls if c[0] == "done")
        self.assertEqual(stop[1], "task-own")
        self.assertIn("Turbo stopped by you: 0 of 1 part combined", stop[3])
        self.assertNotIn("--verified", stop)

    def test_commits_turbo_brought_in_are_its_agents_not_yours(self):
        # task-v6glz: under the person's session every Turbo commit said "You committed" and "You changed 16 lines"
        import attribution as A
        A.mark(self.repo, "start", "opencode", "ses_person", text="make a todo page", base=self.ddir, now=time.time() - 30)
        with open(os.path.join(self.repo, "README"), "a") as f:
            f.write("by the agent\n")
        A.mark(self.repo, "end", "opencode", "ses_person", base=self.ddir, now=time.time() - 20)
        git(self.repo, "commit", "-qam", "agent commit")  # a commit of the person's own, after the turn
        rid = self.plan([{"name": "Note A", "full": "a.txt says A", "files": ["a.txt"]},
                         {"name": "Note B", "full": "b.txt says B", "files": ["b.txt"]}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = self.drive(rid, lambda r: r["state"] == "done")
        st = A.steps(self.repo, "opencode", "ses_person", base=self.ddir)
        own = st["turns"][0]["own_commits"]
        # the person's own commit, then one card for the whole run: its merge into main, made by Turbo's agent
        self.assertEqual([(c["subject"], c["by"]) for c in own], [("agent commit", "you"), ("Turbo: Two notes", "turbo")])
        card = own[1]
        self.assertEqual(card["hash"], r["summary"]["landed"])
        self.assertEqual((card["maker"], card["engine"], card["yours"], card["run"]), ("OpenCode", "opencode", 0, rid))
        self.assertEqual(card["agents"][0]["agent"], "OpenCode")
        self.assertGreaterEqual(card["agents"][0]["lines"], 2)  # a.txt and b.txt (and the final steps' files)
        # and the lines the result brought into the person's copy are not "you changed"
        self.assertEqual(st["yours"], [])

    def test_copies_link_dependencies_and_copy_settings(self):
        rid = self.plan([{"name": "Note A", "full": "a.txt says A"}])
        r = turbo.load(rid)
        path = turbo.make_copy(r, "part-1", "turbo/x/part-1", r["base_sha"])
        self.assertTrue(os.path.islink(os.path.join(path, "app", "node_modules")))
        self.assertTrue(os.path.isfile(os.path.join(path, ".env")))
        self.assertEqual(git(path, "status", "--porcelain"), "")

    def test_a_question_waits_for_the_person_and_the_part_goes_on_with_the_answer(self):
        rid = self.plan([{"name": "Pick a colour", "full": "ASKME a.txt has the colour"}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = self.drive(rid, lambda r: r["parts"][0]["status"] == "needs")
        v = turbo.view(r)
        self.assertEqual(v["needs"][0]["question"], "Blue or green?")
        self.assertEqual(v["needs"][0]["options"], ["Blue", "Green"])

        def answer(r):
            p = r["parts"][0]
            p["ask"]["answered"] = True
            p["answer"] = "Blue"
            p["status"] = "waiting"
        turbo.change(rid, answer)
        r = self.drive(rid, lambda r: r["state"] == "done")
        p = r["parts"][0]
        self.assertEqual(p["status"], "combined")
        self.assertTrue(p["attempts"][-1]["resume"])
        self.assertTrue(any(s[2] == "needs" for s in p["segs"]))

    def test_a_conflict_is_fitted_by_the_part_itself(self):
        os.environ["FAKE_CONFLICT"] = "1"
        rid = self.plan([{"name": "Note A", "full": "a.txt says A"}, {"name": "Note B", "full": "b.txt says B"}])
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = self.drive(rid, lambda r: r["state"] == "done")
        self.assertEqual([p["status"] for p in r["parts"]], ["combined", "combined"])
        self.assertTrue(any(p.get("fix_tries") for p in r["parts"]))
        self.assertTrue(any(e["kind"] == "fixing" for e in r["events"]))

    def test_parts_that_cannot_start_ask_and_leaving_them_out_ends_the_run(self):
        r = turbo.new_run("Two notes", self.repo, "no-such-agent")
        _, ps = turbo.parse_parts({"parts": [{"name": "Note A", "files": ["a.txt"]}, {"name": "Note B", "files": ["b.txt"], "after": [1]}]})
        turbo.set_parts(r, ps, "Two notes")
        r["state"] = "planned"
        turbo.save(r)
        rid = r["id"]
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = self.drive(rid, lambda r: any(p["status"] == "failed" for p in r["parts"]), limit=20)
        v = turbo.view(r)
        self.assertEqual(v["needs"][0]["options"], ["Try again", "Leave it out"])
        self.assertIn("not installed", v["needs"][0]["question"])
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        for n in ("1", "2"):
            r = self.drive(rid, lambda r, n=n: turbo.part_of(r, int(n))["status"] == "failed", limit=20)
            out = subprocess.run(cli + ["answer", rid, n, "--json", "--text=Leave it out"], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        r = self.drive(rid, lambda r: r["state"] == "done", limit=30)
        self.assertEqual(r["summary"]["left"], ["Note A", "Note B"])
        self.assertEqual(git(self.repo, "branch", "--list", "turbo/*part*"), "")  # left out before doing anything: no copies kept

    def test_stopped_for_the_allowance_it_goes_on_with_another_agent_and_comes_back_after_the_refill(self):
        # a stand-in Codex: HOLD parts work until Turbo asks them to stop, then leave half their work; others finish
        codex = os.path.join(self.bin, "codex")
        with open(codex, "w") as f:
            f.write(FAKE_CODEX)
        os.chmod(codex, os.stat(codex).st_mode | stat.S_IEXEC)
        usage = os.path.join(self.tmp, "usage.json")

        def use(pct):
            with open(usage, "w") as f:
                json.dump({"engine": "codex", "windows": [{"kind": "session", "used_percent": pct, "resets_at": time.time() + 3 * 3600}]}, f)
        use(40)
        r = turbo.new_run("Two notes", self.repo, "codex", slots=1)
        _, ps = turbo.parse_parts({"parts": [{"name": "Note A", "full": "HOLD a.txt says A", "files": ["a.txt"]},
                                             {"name": "Note B", "full": "b.txt says B", "files": ["b.txt"]}]})
        turbo.set_parts(r, ps, "Two notes")
        r.update(state="planned", usage_file=usage)
        turbo.save(r)
        rid = r["id"]
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        rd = lambda: turbo.reading("codex", usage)  # noqa: E731
        self.assertIsNone(turbo.reading("opencode", usage))  # a stand-in for Codex says nothing about OpenCode

        def tick_with(reading):
            with turbo.locked(rid):
                r = turbo.load(rid)
                turbo.tick(r, time.time(), reading)
                turbo.save(r)
            return r
        r = tick_with(rd())
        self.assertEqual(turbo.part_of(r, 1)["status"], "working")
        self.assertEqual(turbo.part_of(r, 1)["engine"], "codex")
        time.sleep(0.5)
        use(98)
        r = tick_with(rd())
        self.assertEqual(r["state"], "paused")
        r = self.drive(rid, lambda r: turbo.part_of(r, 1)["status"] == "paused", limit=30)
        with open(os.path.join(turbo.part_of(r, 1)["copy"], "a.txt"), encoding="utf-8") as f:
            self.assertIn("half of", f.read())
        self.assertIn("stopped for the allowance", git(turbo.part_of(r, 1)["copy"], "log", "-1", "--format=%s"))
        # the other agents: OpenCode is here (its allowance is not readable), Claude is not
        from unittest import mock
        with mock.patch("engines.which", lambda name, env=None: os.path.join(self.bin, name) if os.path.exists(os.path.join(self.bin, name)) else None):
            alts = turbo.alternatives(r)
        self.assertEqual([a["engine"] for a in alts], ["opencode"])
        # the person's click: go on with OpenCode
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        out = subprocess.run(cli + ["switch", rid, "--engine", "opencode", "--json"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        v = json.loads(out.stdout[out.stdout.find("{"):])
        self.assertEqual((v["state"], v["engine"]), ("running", "opencode"))
        self.assertEqual(v["was"]["engine"], "codex")
        self.assertEqual(len(v["allowance"]["stops"]), 1)  # the stop stays on the band, striped
        r = turbo.load(rid)
        p1 = turbo.part_of(r, 1)
        self.assertEqual((p1["status"], p1["session"]), ("waiting", ""))
        # part 1 goes on with OpenCode from a handoff in its own copy; part 2 waits (one at a time)
        os.environ["FAKE_SLEEP"] = "2"
        r = self.drive(rid, lambda r: turbo.part_of(r, 1)["status"] == "working", limit=40)
        p1 = turbo.part_of(r, 1)
        self.assertEqual(p1["engine"], "opencode")
        with open(os.path.join(os.path.dirname(p1["log"]), "launch-2.json"), encoding="utf-8") as f:
            prompt = json.load(f)["argv"][-1]
        self.assertIn("ChatGPT · Codex started this part and stopped for its allowance", prompt)
        self.assertIn("Your part: HOLD a.txt says A", prompt)
        # Codex refilled while part 1 works on OpenCode: the parts that start from now go back to it
        use(10)
        turbo.change(rid, lambda r: r["was"].update(back_at=time.time() - 1))
        r = self.drive(rid, lambda r: r["state"] == "done", limit=60)
        self.assertEqual(turbo.part_of(r, 2)["engine"], "codex")
        self.assertEqual([(x["from"], x["to"]) for x in r["switches"]], [("codex", "opencode"), ("opencode", "codex")])
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "b.txt")))
        self.assertEqual(turbo.part_of(r, 1)["engine"], "opencode")  # a part keeps the agent it finished on

    def test_on_opencode_a_provider_that_ran_out_stops_the_parts_cleanly(self):
        rid = self.plan([{"name": "Note A", "full": "a.txt says A", "files": ["a.txt"]}], slots=2)
        os.environ["FAKE_PROVIDER"] = "out"
        self.addCleanup(os.environ.pop, "FAKE_PROVIDER", None)
        turbo.change(rid, lambda r: turbo.start_run(r, spawn=False, task=False))
        r = self.drive(rid, lambda r: r["state"] == "paused", limit=30)
        with open(os.path.join(os.path.dirname(turbo.part_of(r, 1)["log"]), "launch-1.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["argv"][1:5], ["run", "--print-logs", "--log-level", "ERROR"])
        r = self.drive(rid, lambda r: turbo.part_of(r, 1)["status"] == "paused", limit=30)
        self.assertEqual(r["quota"]["paused_kind"], "provider")
        self.assertIn("balance or plan ran out", r["events"][-1]["text"] if r["events"][-1]["kind"] == "paused" else
                      next(e["text"] for e in r["events"] if e["kind"] == "paused"))
        # the provider takes requests again: after the wait the part carries on and the run ends
        os.environ.pop("FAKE_PROVIDER")
        turbo.change(rid, lambda r: r["quota"].update(resume_at=time.time() - 1))
        r = self.drive(rid, lambda r: r["state"] == "done", limit=60)
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "resumed.txt")))  # the same session carried on
        self.assertIn("Trying OpenCode's provider again", [e["text"] for e in r["events"]])

    def test_switch_only_from_a_stopped_run(self):
        rid = self.plan([{"name": "Note A", "full": "a.txt says A"}])
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        out = subprocess.run(cli + ["switch", rid, "--engine", "opencode", "--json"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1)
        self.assertIn("Only a stopped run", json.loads(out.stdout)["message"])

    def test_the_list_row_says_what_the_left_column_and_the_allowance_need(self):
        rid = self.plan([{"name": "Note A", "full": "a.txt says A"}, {"name": "Note B", "full": "b.txt says B"}])

        def going(r):
            r.update(state="running", started_at=time.time() - 600)
            r["parts"][0]["status"] = "combined"
            r["parts"][1].update(status="needs", started_at=time.time() - 300)
            r["quota"] = {"known": True, "used": 30.0, "resets_at": time.time() + 7200, "paused": False}
        turbo.change(rid, going)
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        out = subprocess.run(cli + ["list", "--json"], capture_output=True, text=True)
        row = json.loads(out.stdout)[0]
        self.assertEqual((row["combined"], row["total"], row["needs"], row["repo"]), (1, 2, 1, os.path.realpath(self.repo)))
        self.assertEqual([p["status"] for p in row["parts"]], ["combined", "needs"])
        self.assertEqual(row["used"], 30.0)
        self.assertIsInstance(row["plans_more"], int)

    def index_with(self, rows):
        turbo.D.load_index = lambda: rows
        turbo.D.project_dirs = lambda: {}
        import dispatch
        turbo.D.git_project_root = dispatch.git_project_root

    def test_the_folder_is_the_project_the_job_names_else_the_last_one(self):
        other = os.path.join(self.tmp, "readout")
        subprocess.run(["git", "init", "-q", "-b", "main", other], check=True)
        assistant = os.path.join(self.ddir, "assistant")
        os.makedirs(assistant)
        now = time.time()
        self.index_with({"a": {"cwd": other, "mtime": now}, "b": {"cwd": os.path.join(self.repo, "app"), "mtime": now - 60},
                         "c": {"cwd": assistant, "mtime": now + 5}, "d": {"cwd": "/nowhere/at/all", "mtime": now + 9}})
        self.assertEqual([f["name"] for f in turbo.folders()], ["readout", "proj"])  # Dispatch's own folder is left out
        self.assertEqual(turbo.pick_folder(assistant, "Fix the proj setup page"), os.path.realpath(self.repo))
        self.assertEqual(turbo.pick_folder("", "Make it faster"), os.path.realpath(other))
        self.assertEqual(turbo.pick_folder(os.path.join(self.repo, "app"), "readout too"), os.path.realpath(self.repo))

    def test_normal_mode_lanes_are_the_sessions_and_their_helpers(self):
        now = time.time()
        iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
        tx = os.path.join(self.tmp, "s1.jsonl")
        open(tx, "w").close()
        self.index_with({tx: {"session_id": "s1", "cwd": self.repo, "title": "Fix the setup", "first_ts": iso(now - 3600), "last_ts": iso(now - 600), "agent": "claude-code"},
                         "h1": {"session_id": "h1", "subagent": True, "parent": "s1", "cwd": self.repo, "first_ts": iso(now - 3000), "last_ts": iso(now - 1200)},
                         "old": {"session_id": "old", "cwd": self.repo, "title": "Last week", "first_ts": iso(now - 9e5), "last_ts": iso(now - 8e5)}})
        lanes = turbo.session_lanes(now)
        self.assertEqual([(l["kind"], l["name"]) for l in lanes], [("session", "Fix the setup"), ("helper", "Helper 1")])
        self.assertEqual(lanes[0]["status"], "working")  # its transcript was written just now
        self.assertEqual(lanes[0]["helpers"], 1)
        self.assertEqual(lanes[1]["status"], "done")
        self.assertEqual(lanes[0]["project"], "proj")

    def test_a_lane_is_named_in_a_few_words_and_drawn_as_its_stretches(self):
        self.assertEqual(turbo.short_words("Read DESIGN.md tokens"), "Read DESIGN.md tokens")
        self.assertEqual(turbo.short_words("按 design/frenzy/proto-a.html 重做 Assistant 的 Timeline 页签，代码在 ide/x.ts"), "按 proto-a 重做 Assistant 的 Timeline 页签")
        self.assertEqual(turbo.short_words("Rerun experiments/ablation.py with seeds 1 to 5 and update tables/ablation.tex"), "Rerun ablation with seeds 1 to 5 and…")
        self.assertEqual(turbo.short_words("Seed 3 to 5. You are a helper of the main session. Read ide/vscode/src"), "Seed 3 to 5")
        now = time.time()
        iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
        tx = os.path.join(self.tmp, "s2.jsonl")
        with open(tx, "w") as f:
            for ago in (300, 295, 290, 120, 118, 30):  # minutes ago: three stretches, the last one working
                f.write(json.dumps({"type": "assistant", "timestamp": iso(now - ago * 60)}, separators=(",", ":")) + "\n")
        self.index_with({tx: {"session_id": "s2", "cwd": self.repo, "agent": "claude-code", "first_prompt": "Fix the build on the mini, see app/cli/builds.py and the log in /tmp/x.log",
                              "first_ts": iso(now - 300 * 60), "last_ts": iso(now - 30 * 60)}})
        lane = turbo.session_lanes(now)[0]
        self.assertEqual(lane["name"], "Fix the build on the mini")
        self.assertEqual(len(lane["segs"]), 3)
        self.assertEqual(lane["status"], "working")  # the transcript was written just now
        self.assertEqual(lane["segs"][-1][1], now)
        self.assertLess(lane["segs"][0][1] - lane["segs"][0][0], 12 * 60)
        self.assertTrue(os.path.exists(turbo._lane_cache_path()))
        self.assertEqual(turbo.session_lanes(now)[0]["segs"], lane["segs"])  # the second read comes from the cache

    def test_another_folder_before_start_splits_the_job_again(self):
        other = os.path.join(self.tmp, "other")
        subprocess.run(["git", "init", "-q", "-b", "main", other], check=True)
        git(other, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init")
        parts = os.path.join(self.tmp, "parts.json")
        with open(parts, "w") as f:
            json.dump({"title": "Notes", "parts": [{"name": "Note A", "files": ["a.txt"], "minutes": 20}]}, f)
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        v = json.loads(subprocess.run(cli + ["plan", "Write", "a", "note", "--cwd", self.repo, "--parts", parts, "--engine", "opencode", "--json"], capture_output=True, text=True).stdout)
        out = subprocess.run(cli + ["replan", v["id"], "--cwd", other, "--json"], capture_output=True, text=True)
        w = json.loads(out.stdout)
        self.assertEqual(w["repo"], os.path.realpath(other))
        self.assertEqual(w["state"], "planning")
        self.assertEqual(w["parts"], [])
        r = self.wait_state(v["id"], "planned")
        self.assertEqual([p["name"] for p in r["parts"]], ["Write note A", "Write note B"])  # split again, by looking at the other project

    def wait_state(self, rid, state, limit=30):
        t0 = time.time()
        while time.time() - t0 < limit:
            r = turbo.load(rid)
            if r["state"] == state:
                return r
            time.sleep(0.3)
        self.fail("still %s" % turbo.load(rid)["state"])

    def test_cli_plan_status_and_answers_as_json(self):
        parts = os.path.join(self.tmp, "parts.json")
        with open(parts, "w") as f:
            json.dump({"title": "Notes", "parts": [{"name": "Note A", "files": ["a.txt"], "minutes": 20}]}, f)
        cli = [sys.executable, os.path.join(HERE, "dispatch.py"), "turbo"]
        out = subprocess.run(cli + ["plan", "Write", "a", "note", "--cwd", self.repo, "--parts", parts, "--engine", "opencode", "--json"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        v = json.loads(out.stdout)
        self.assertEqual(v["state"], "planned")
        self.assertEqual(v["total"], 1)
        self.assertIn("Done around", v["plan"]["done_words"])
        rid = v["id"]
        out = subprocess.run(cli + ["replan", rid, "--at-a-time", "2", "--json"], capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["slots"], 2)
        out = subprocess.run(cli + ["add", rid, "Also", "a", "note", "C", "--json"], capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["total"], 2)
        out = subprocess.run(cli + ["answer", rid, "1", "Blue", "--json"], capture_output=True, text=True)
        # words that start with a dash go in --text=… (what the bridge sends; no bare "--", which Python 3.9's argparse rejects)
        out2 = subprocess.run(cli + ["add", rid, "--json", "--text=-x also a note"], capture_output=True, text=True)
        self.assertEqual(json.loads(out2.stdout)["parts"][-1]["name"], "-x also a note")
        self.assertFalse(json.loads(out.stdout)["ok"])
        out = subprocess.run(cli + ["list", "--json"], capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)[0]["id"], rid)
        out = subprocess.run(cli + ["cancel", rid, "--json"], capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
