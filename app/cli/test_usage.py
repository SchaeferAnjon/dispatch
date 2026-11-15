# -*- coding: utf-8 -*-
"""usage.py and usage_scan.py: the Usage page's data (allowance per account, spend, tools, the year per engine)."""
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage as U  # noqa: E402
import usage_scan as S  # noqa: E402
from engines import codex as X  # noqa: E402

TODAY = date(2026, 9, 27)


def ts(day, hour=12):
    """A local time as Claude Code writes it (UTC ISO)."""
    t = time.mktime(datetime.strptime("%s %02d" % (day, hour), "%Y-%m-%d %H").timetuple())
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Heatmap(unittest.TestCase):
    def test_english_labels_without_kind_are_read_alongside_legacy_labels(self):
        for label, key in (("5h", "session"), ("5 hours", "session"), ("Weekly", "weekly"), ("每周", "weekly")):
            with self.subTest(label=label):
                self.assertEqual(U._window_key({"label": label}), key)

    def test_sessions_per_day_per_engine_main_sessions_only(self):
        idx = {
            "a": {"agent": "claude-code", "session_id": "a", "days": {"2026-09-27": [3, 0, 0, 0, 0, 0], "2026-09-26": [0, 10, 0, 0, 0, 0]}},
            "b": {"agent": "codex", "session_id": "b", "days": {"2026-09-27": [1, 0, 0, 0, 0, 0]}},
            "c": {"agent": "codex", "session_id": "c", "days": {"2026-09-27": [2, 0, 0, 0, 0, 0]}},
            "sub": {"agent": "claude-code", "session_id": "d", "subagent": True, "days": {"2026-09-27": [5, 0, 0, 0, 0, 0]}},
            "old": {"agent": "codex", "session_id": "e", "days": {"2024-01-01": [5, 0, 0, 0, 0, 0]}},
            "noid": {"agent": "pi", "session_id": "", "days": {"2026-09-27": [5, 0, 0, 0, 0, 0]}},
        }
        h = U.heatmap(idx, 365, TODAY)
        self.assertEqual(h["counts"], {"2026-09-27": {"claude-code": 1, "codex": 2}})
        self.assertEqual(h["by_engine"], {"codex": 2, "claude-code": 1})
        self.assertEqual((h["max"], h["total"], h["active_days"]), (3, 3, 1))
        self.assertEqual((h["from"], h["to"]), ("2025-09-28", "2026-09-27"))

    def test_empty(self):
        h = U.heatmap({}, 30, TODAY)
        self.assertEqual((h["counts"], h["max"], h["total"]), ({}, 0, 0))


class Readings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "quota.jsonl")

    def row(self, at, s=10.0, w=20.0, agent="claude-code"):
        return {"agent": agent, "plan": "", "updated_at": at, "windows": [
            {"label": "5 小时", "kind": "session", "used_percent": s, "resets_at": at + 3600},
            {"label": "每周", "kind": "weekly", "used_percent": w, "resets_at": at + 86400},
            {"label": "每周 · Opus", "kind": "weekly_model", "used_percent": 99}]}

    def test_reading_keeps_the_two_windows_and_the_account(self):
        r = U.reading_of(self.row(1000), account="a@x")
        self.assertEqual((r["session"]["used"], r["weekly"]["used"], r["account"]), (10.0, 20.0, "a@x"))
        self.assertIsNone(U.reading_of({"agent": "codex", "windows": []}))

    def test_record_skips_repeats_and_older_per_account(self):
        self.assertEqual(len(U.record([U.reading_of(self.row(1000), account="a")], self.path)), 1)
        # the same values five minutes later: not written; another account at the same time: written
        self.assertEqual(U.record([U.reading_of(self.row(1300), account="a")], self.path), [])
        self.assertEqual(len(U.record([U.reading_of(self.row(1300), account="b")], self.path)), 1)
        self.assertEqual(len(U.record([U.reading_of(self.row(1400, s=12), account="a")], self.path)), 1)
        self.assertEqual(U.record([U.reading_of(self.row(900, s=50), account="a")], self.path), [])
        self.assertEqual(len(U.load_history(self.path)), 3)

    def test_codex_points_from_rollout(self):
        lines = [
            json.dumps({"timestamp": "2026-09-27T10:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
                "primary": {"used_percent": 30, "window_minutes": 300}, "secondary": {"used_percent": 5, "window_minutes": 10080}}}}),
            json.dumps({"timestamp": "2026-09-27T11:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
                "secondary": {"used_percent": 6, "window_minutes": 10080}}}}),
            '{"type":"response_item","payload":{}}',
        ]
        pts = X.quota_points("\n".join(lines))
        self.assertEqual([(p[1], p[2]) for p in pts], [(30.0, 5.0), (None, 6.0)])


WEEK = 7 * 86400
NOW = 1_791_550_000.0  # 2026-10-09, a Friday
THU6 = 1_792_036_800.0  # the next Thursday 06:00 (one account's weekly reset)
SUN23 = 1_791_752_400.0  # Sunday 23:00 (another's)


def reading(at, week, five=None, reset=THU6, account=None):
    r = {"agent": "claude-code", "at": at, "plan": "", "weekly": {"used": week, "resets_at": reset}}
    if five is not None:
        r["session"] = {"used": five, "resets_at": at + 3600}
    if account:
        r["account"] = account
    return r


class Allowance(unittest.TestCase):
    def accounts(self):
        return [
            {"id": "c1", "email": "one@x", "name": "one", "plan": "Max 20x", "active": True, "usage": {}},
            {"id": "c2", "email": "two@x", "name": "two", "plan": "Max 5x", "active": False,
             "usage": {"at": NOW - 600, "windows": [{"kind": "session", "used_percent": 0}, {"kind": "weekly", "used_percent": 100, "resets_at": SUN23}]}},
        ]

    def test_old_readings_go_to_the_account_whose_week_starts_at_the_same_hour(self):
        hist = [
            reading(NOW - 3 * 86400, 40, 10, reset=THU6 - WEEK + 0.4),  # no account: Thursday 06:00
            reading(NOW - 2 * 86400, 90, reset=SUN23 - WEEK),  # no account: Sunday 23:00 → two@x by its own usage
            reading(NOW - 86400, 50, reset=THU6, account="one@x"),
            reading(NOW - 5 * 86400, 30, reset=THU6 + 26 * 3600 - WEEK),  # Friday 08:00, passed since: no account has it
        ]
        a = U.allowance(NOW, 14, hist, self.accounts(), codex={}, oc_quota={}, codex_points=[])
        tracks = {t["id"]: t for t in a["tracks"]}
        self.assertEqual([p[1] for p in tracks["one@x"]["weekly"]], [40, 50])
        self.assertEqual([p[1] for p in tracks["two@x"]["weekly"]], [90])
        unnamed = [t for t in a["tracks"] if t["id"].startswith("anchor-")]
        self.assertEqual(len(unnamed), 1)
        cards = {c["id"]: c for c in a["cards"]}
        self.assertEqual(cards["claude:one@x"]["weekly"]["used"], 50)
        self.assertTrue(cards["claude:one@x"]["in_use"])
        # the account's own usage answer is newer than its recorded readings: the card shows it
        self.assertEqual(cards["claude:two@x"]["weekly"]["used"], 100)
        self.assertEqual(cards["claude:two@x"]["weekly_reset"], SUN23)
        third = [c for c in a["cards"] if c["unnamed"]][0]
        self.assertEqual(third["title"], "Claude · 2nd")
        # its week reset since it was read: 0%, with when and what it was
        self.assertEqual(third["weekly"]["used"], 0)
        self.assertEqual(third["weekly"]["was"], 30)

    def test_codex_says_why_there_is_no_reading_and_takes_the_plan_from_the_account(self):
        pts = [(NOW - 3 * 86400, None, 2.0)]
        a = U.allowance(NOW, 14, [], [], codex={"email": "c@x", "plan": "plus", "last_session_at": NOW - 86400}, oc_quota={}, codex_points=pts)
        card = [c for c in a["cards"] if c["kind"] == "codex"][0]
        self.assertEqual(card["plan"], "Plus")
        self.assertIsNone(card["weekly"])
        self.assertIn("reported no limits", card["note"])
        self.assertIn("week 2%", card["note"])
        self.assertEqual([t["id"] for t in a["tracks"]], ["codex"])

    def test_glm_and_deepseek_from_opencode_quota(self):
        oc = {"zhipuai-coding-plan": {"at": NOW, "rows": [{"kind": "window", "label": "5-hour", "used_percent": 5, "resets_at": NOW + 3600, "plan": "lite"},
                                                         {"kind": "window", "label": "weekly", "used_percent": 38, "resets_at": NOW + 86400, "plan": "lite"}]},
              "deepseek": {"at": NOW, "rows": [{"kind": "balance", "label": "Balance", "amount": 25.68, "currency": "CNY"}]}}
        a = U.allowance(NOW, 14, [], [], codex={}, oc_quota=oc, codex_points=[], deepseek_spent=4.06)
        cards = {c["id"]: c for c in a["cards"]}
        self.assertEqual((cards["glm"]["plan"], cards["glm"]["session"]["used"], cards["glm"]["weekly"]["used"]), ("Lite", 5.0, 38.0))
        self.assertEqual((cards["deepseek"]["balance"]["amount"], cards["deepseek"]["spent_30d"]), (25.68, 4.06))

    def test_next_reset_and_anchor(self):
        self.assertEqual(U.next_reset(THU6 - 3 * WEEK, NOW), THU6)
        self.assertTrue(U._same_anchor(U.anchor_of(THU6), U.anchor_of(THU6 + WEEK + 300)))
        self.assertFalse(U._same_anchor(U.anchor_of(THU6), U.anchor_of(SUN23)))


def line(**d):
    return json.dumps(d, separators=(",", ":"))  # the engines write compact JSON


class ScanClaude(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def write(self, name, lines):
        p = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        return p

    def transcript(self):
        u = {"input_tokens": 10, "output_tokens": 100, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 50,
             "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 30}}
        t = ts("2026-09-27")
        return [
            line(type="attachment", timestamp=t, cwd="/p/kanban", attachment={"type": "deferred_tools_delta", "addedNames": ["Bash", "mcp__harbor__add_tasks", "mcp__claude-in-chrome__computer"]}),
            line(type="user", timestamp=t, message={"role": "user", "content": "<command-name>/login</command-name>"}),
            # one answer, logged once per content block: the usage counts once
            line(type="assistant", timestamp=t, cwd="/p/kanban", sessionId="s1", requestId="r1", message={"model": "claude-opus-5-5", "usage": u, "content": [
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}),
            line(type="assistant", timestamp=t, cwd="/p/kanban", sessionId="s1", requestId="r1", message={"model": "claude-opus-5-5", "usage": u, "content": [
                {"type": "tool_use", "id": "t2", "name": "mcp__claude-in-chrome__computer", "input": {}},
                {"type": "tool_use", "id": "t3", "name": "Skill", "input": {"skill": "designer"}},
                {"type": "tool_use", "id": "t4", "name": "Agent", "input": {"subagent_type": "opus-high"}}]}),
            line(type="user", timestamp=t, message={"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                {"type": "tool_result", "tool_use_id": "t2", "content": "boom", "is_error": True},
                {"type": "tool_result", "tool_use_id": "t3", "content": "ok"},
                {"type": "tool_result", "tool_use_id": "t4", "content": "failed", "is_error": True}]}),
            line(type="attachment", timestamp=t, attachment={"type": "hook_success", "hookEvent": "PostToolUse", "hookName": "PostToolUse:Bash", "exitCode": 0,
                                                             "command": "python3 /x/dispatch.py handoff hook --agent claude-code # dispatch-life"}),
            line(type="attachment", timestamp=t, attachment={"type": "hook_non_blocking_error", "hookEvent": "Stop", "hookName": "Stop",
                                                             "stderr": "\"node /Users/x/cc-status-hook.js\" exited 2"}),
            line(type="system", subtype="stop_hook_summary", timestamp=t, hookInfos=[{"command": "x # dispatch-presence"}], hookErrors=[]),
        ]

    def test_fold(self):
        p = self.write("proj/s1.jsonl", self.transcript())
        s = S.read_file(p, "claude-code")
        self.assertEqual((s["sid"], s["cwd"], s["last"]), ("s1", "/p/kanban", "2026-09-27"))
        self.assertEqual(s["tok"]["2026-09-27"]["claude-opus-5-5"], [10, 100, 1000, 20, 30])
        self.assertEqual(s["tl"]["Bash"]["2026-09-27"], [1, 0])
        self.assertEqual(s["tl"]["mcp__claude-in-chrome__computer"]["2026-09-27"], [1, 1])
        self.assertEqual(s["sk"]["designer"]["2026-09-27"], [1, 0])
        self.assertEqual(s["ag"]["opus-high"]["2026-09-27"], [1, 1])
        self.assertEqual(s["cm"]["/login"]["2026-09-27"], [1, 0])
        self.assertEqual(s["hk"]["dispatch-life"]["2026-09-27"], [1, 0])
        self.assertEqual(s["hk"]["cc-status-hook"]["2026-09-27"], [1, 1])
        self.assertEqual(s["hk"]["dispatch-presence"]["2026-09-27"], [1, 0])
        self.assertEqual(sorted(s["mo"]), ["claude-in-chrome", "harbor"])
        self.assertEqual(s["pend"], {})

    def test_reads_only_what_was_appended(self):
        lines = self.transcript()
        p = self.write("proj/s1.jsonl", lines[:3])
        s = S.read_file(p, "claude-code")
        self.assertEqual(s["pend"], {"t1": ["t", "Bash", "2026-09-27"]})
        with open(p, "a") as f:
            f.write("\n".join(lines[3:]) + "\n")
        s = S.read_file(p, "claude-code", json.loads(json.dumps(s)))
        self.assertEqual(s["tok"]["2026-09-27"]["claude-opus-5-5"], [10, 100, 1000, 20, 30])
        self.assertEqual(s["tl"]["mcp__claude-in-chrome__computer"]["2026-09-27"], [1, 1])

    def test_a_half_written_last_line_waits(self):
        lines = self.transcript()
        p = self.write("proj/s1.jsonl", lines[:2])
        with open(p, "a") as f:
            f.write(lines[2][:40])
        s = S.read_file(p, "claude-code")
        self.assertEqual(s["tok"], {})
        with open(p, "a") as f:
            f.write(lines[2][40:] + "\n")
        s = S.read_file(p, "claude-code", s)
        self.assertEqual(s["tok"]["2026-09-27"]["claude-opus-5-5"][1], 100)

    def test_subagent_files_belong_to_their_session(self):
        p = self.write("proj/s1/subagents/workflows/w1/agent-a.jsonl", self.transcript()[2:3])
        s = S.read_file(p, "claude-code")
        self.assertTrue(s["sub"])
        self.assertEqual(s["sid"], "s1")

    def test_scan_cache_and_skip_unchanged(self):
        p = self.write("proj/s1.jsonl", self.transcript())
        cache = os.path.join(self.tmp, "u", "scan.json")
        out = S.scan(cache, [(p, "claude-code")])
        self.assertIn(p, out)
        with mock.patch.object(S, "read_file", side_effect=AssertionError("read again")):
            S.scan(cache, [(p, "claude-code")])


class ScanOthers(unittest.TestCase):
    def test_codex_counts_turns_by_delta_and_skills_only_in_tool_calls(self):
        t = "2026-09-27T10:00:00Z"
        tc = lambda i, c, o: line(timestamp=t, type="event_msg", payload={"type": "token_count", "info": {"total_token_usage": {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o}}})
        lines = [
            line(timestamp=t, type="session_meta", payload={"id": "019-abc", "cwd": "/p/kanban"}),
            line(timestamp=t, type="turn_context", payload={"model": "gpt-6"}),
            tc(100, 40, 10), tc(100, 40, 10), tc(300, 140, 30),
            line(timestamp=t, type="response_item", payload={"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "cat ~/.agents/skills/designer/SKILL.md"})}),
            # a compacted history repeats the system prompt's skill list: not a use
            line(timestamp=t, type="compacted", payload={"replacement_history": [{"type": "function_call", "arguments": "skills/pdf/SKILL.md"}]}),
        ]
        d = tempfile.mkdtemp()
        p = os.path.join(d, "rollout-2026-09-27T10-00-00-01a0e004-fa97-7150-a46a-0e4622765937.jsonl")
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        s = S.read_file(p, "codex")
        day = S.day_of_iso(t)
        self.assertEqual(s["tok"][day]["gpt-6"], [160, 30, 140, 0, 0])
        self.assertEqual(s["tl"]["exec_command"][day], [1, 0])
        self.assertEqual(list(s["sk"]), ["designer"])
        self.assertEqual(s["cwd"], "/p/kanban")

    def test_codex_index_counts_skills_only_from_tool_calls(self):
        e = {"skills": {}, "codex_prev": 0, "tokens": {}, "models": {}, "days": {}, "hours": {}}
        buf = "\n".join([
            line(type="compacted", payload={"replacement_history": [{"type": "function_call", "arguments": "skills/pdf/SKILL.md"}]}),
            line(type="response_item", payload={"type": "function_call", "name": "exec_command", "arguments": "cat skills/designer/SKILL.md"}),
        ])
        import re
        X.parse_stats(e, buf, re.compile(r'"timestamp":"([^"]+)"'))
        self.assertEqual(e["skills"], {"designer": 1})
        d = tempfile.mkdtemp()
        p = os.path.join(d, "r.jsonl")
        with open(p, "w") as f:
            f.write(buf + "\n")
        row = {"skills": {"pdf": 21, "designer": 1}, "off": os.path.getsize(p), "first_prompt": "", "origin_v": None}
        import dispatch as D
        with mock.patch.object(D, "ORIGIN_V", None):
            X.Codex().index_cached(row, p, True)
        self.assertEqual((row["skills"], row["skills_v"]), ({"designer": 1}, X.SKILLS_V))

    def test_pi_cost_and_failures(self):
        t = "2026-09-27T10:00:00Z"
        lines = [
            line(type="session", id="pi1", cwd="/p/bookmark", timestamp=t),
            line(type="message", timestamp=t, message={"role": "assistant", "provider": "deepseek", "model": "deepseek-flash",
                                                       "usage": {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 0, "cost": {"total": 0.002}},
                                                       "content": [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {}}]}),
            line(type="message", timestamp=t, message={"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": True, "content": []}),
        ]
        d = tempfile.mkdtemp()
        p = os.path.join(d, "2026-09-27T10-00-00_pi1.jsonl")
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        s = S.read_file(p, "pi")
        day = S.day_of_iso(t)
        self.assertEqual(s["usd"][day]["deepseek-flash"], 0.002)
        self.assertEqual(s["prov"]["deepseek-flash"], "deepseek")
        self.assertEqual(s["tl"]["bash"][day], [1, 1])
        self.assertEqual((s["sid"], s["cwd"]), ("pi1", "/p/bookmark"))

    def test_sqlite_store(self):
        rows = {
            "session": [{"id": "ses1", "parent_id": None, "directory": "/p/kanban", "title": "Fix it"}, {"id": "ses2", "parent_id": "ses1", "directory": "/p/kanban", "title": "sub"}],
            "message": [{"session_id": "ses1", "time_created": 1790000000000, "data": json.dumps({"role": "assistant", "modelID": "deepseek-flash", "providerID": "deepseek", "cost": 0.01,
                                                                                                  "tokens": {"input": 5, "output": 6, "reasoning": 1, "cache": {"read": 7, "write": 0}}})},
                        {"session_id": "ses2", "time_created": 1790000000000, "data": json.dumps({"role": "assistant", "modelID": "glm-5.3", "providerID": "zai-coding-plan", "cost": 0,
                                                                                                  "tokens": {"input": 1, "output": 1}})}],
            "part": [{"session_id": "ses1", "time_created": 1790000000000, "tool": "bash", "status": "error", "skill": None},
                     {"session_id": "ses1", "time_created": 1790000000000, "tool": "skill", "status": "completed", "skill": "designer"}],
        }

        def query(sql, args):
            return rows["session" if "from session" in sql else "message" if "from message" in sql else "part"]
        out = S.sqlite_summaries("opencode", query, 0)
        main, sub = out["opencode:ses1"], out["opencode:ses2"]
        day = S.day_of_ms(1790000000000)
        self.assertEqual(main["tok"][day]["deepseek-flash"], [5, 7, 7, 0, 0])
        self.assertEqual(main["usd"][day]["deepseek-flash"], 0.01)
        self.assertEqual(main["tl"]["bash"][day], [1, 1])
        self.assertEqual(main["sk"]["designer"][day], [1, 0])
        self.assertEqual((sub["sid"], sub["sub"]), ("ses1", True))


class Prices(unittest.TestCase):
    def test_list_prices(self):
        # 1M of each at Opus 5.5: 4 + 20 + 0.20 + 5 (5-minute write) + 8 (1-hour write)
        self.assertAlmostEqual(S.api_value("claude-opus-5-5", [1e6] * 5), 37.2)
        self.assertAlmostEqual(S.api_value("claude-fable-5-1", [0, 0, 1e6, 0, 0]), 0.25)
        self.assertAlmostEqual(S.api_value("claude-fable-5", [0, 0, 1e6, 0, 0]), 1.0)
        self.assertAlmostEqual(S.api_value("claude-sonnet-4-5-20250929", [1e6, 0, 0, 0, 0]), 3.0)
        self.assertIsNone(S.api_value("gpt-6", [1, 1, 1, 1, 1]))

    def test_model_labels(self):
        self.assertEqual(S.model_label("claude-opus-5-5"), "Opus 5.5")
        self.assertEqual(S.model_label("claude-fable-5-1"), "Fable 5.1")
        self.assertEqual(S.model_label("claude-sonnet-4-5-20250929"), "Sonnet 4.5")
        self.assertEqual(S.model_label("claude-3-5-haiku-20241022"), "Haiku 3.5")
        self.assertEqual(S.model_label("deepseek-v4.1-flash-expires-on-0910"), "DeepSeek V4.1 Flash")
        self.assertEqual(S.model_label("glm-5.3-flash"), "GLM 5.3 Flash")
        self.assertEqual(S.model_label("kimi-k3"), "kimi-k3")

    def test_hook_labels(self):
        self.assertEqual(S.hook_label('PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 "$HOME/x/presence.py" claude-code Stop # dispatch-presence'), "dispatch-presence")
        self.assertEqual(S.hook_label('"$HOME/.local/bin/dispatch" prime --hook-json'), "dispatch prime")
        self.assertEqual(S.hook_label("/opt/python3.14 /Users/x/kanban/app/cli/dispatch.py handoff hook --agent c"), "dispatch handoff hook")
        self.assertEqual(S.hook_label('if [ -z "${HOME-}" ]; then printf x; else "${HOME-}/.orca/agent-hooks/claude-hook.cmd"; fi'), "orca claude-hook")


class Aggregate(unittest.TestCase):
    def summary(self, **kw):
        s = S.new_summary("", kw.pop("eng", "claude-code"))
        s.update(kw)
        return s

    def test_windows_spend_and_tools(self):
        today = date(2026, 9, 27)
        sums = {
            "a": self.summary(sid="s1", cwd="/p/kanban", first="2026-09-20", last="2026-09-27",
                              tok={"2026-09-27": {"claude-opus-5-5": [0, 1_000_000, 0, 0, 0]}, "2026-09-01": {"claude-opus-5-5": [0, 1_000_000, 0, 0, 0]}},
                              tl={"Bash": {"2026-09-27": [10, 1]}, "mcp__harbor__add": {"2026-09-26": [2, 0]}, "Skill": {"2026-09-27": [1, 0]}},
                              sk={"designer": {"2026-09-27": [1, 0]}}, ag={"opus-high": {"2026-09-27": [2, 1]}},
                              hk={"dispatch-life": {"2026-09-27": [5, 0]}}, hke={"dispatch-life": "Stop"}, cm={"/login": {"2026-09-27": [1, 0]}},
                              mo=["harbor", "claude_ai_Gmail"]),
            "b": self.summary(sid="s1", sub=True, cwd="/p/kanban", first="2026-09-27", last="2026-09-27",
                              tok={"2026-09-27": {"claude-opus-5-5": [0, 1_000_000, 0, 0, 0]}}),
            "c": self.summary(eng="opencode", sid="o1", cwd="/p/harbor", first="2026-09-27", last="2026-09-27",
                              tok={"2026-09-27": {"deepseek-flash": [100, 0, 0, 0, 0]}}, usd={"2026-09-27": {"deepseek-flash": 0.5}}, prov={"deepseek-flash": "deepseek"}),
            "d": self.summary(eng="codex", sid="x1", cwd="/p/kanban", first="2026-09-27", last="2026-09-27",
                              tok={"2026-09-27": {"gpt-6": [100, 0, 0, 0, 0]}}, tl={"exec": {"2026-09-27": [3, 0]}}),
        }
        out = U.aggregate(sums, today, (7, 30), U._Projects(lambda cwd: os.path.basename(cwd)), {("claude-code", "s1"): "Big one"},
                          installed_skills=["designer", "getnote"], agent_defs=["opus-high", "sonnet-max"],
                          extra_billed={"2026-09-26": {"Tab completion (DeepSeek)": 0.25}}, offered_tools={"claude_ai_Gmail": {"authenticate", "complete_authentication"}})
        w7, w30 = out["7"], out["30"]
        self.assertAlmostEqual(w7["spend"]["api_value"], 40.0)  # two answers of 1M output at $20
        self.assertAlmostEqual(w30["spend"]["api_value"], 60.0)
        self.assertAlmostEqual(w7["spend"]["billed"], 0.75)
        self.assertEqual([b["label"] for b in w7["spend"]["billed_by"]], ["DeepSeek via OpenCode", "Tab completion (DeepSeek)"])
        self.assertEqual(w7["spend"]["engines"]["claude-code"]["daily_tokens"][-1], 2_000_000)
        s = w7["spend"]["sessions"][0]
        self.assertEqual((s["title"], s["subagents"], s["project"], s["tokens"]), ("Big one", 1, "kanban", 2_000_000))
        self.assertEqual(w7["spend"]["projects"][0]["name"], "kanban")
        t = w7["tools"]
        self.assertEqual(t["totals"]["calls"], 16)
        bash = [r for r in t["builtin"] if r["name"] == "Bash"][0]
        self.assertEqual((bash["count"], bash["errors"], bash["projects"], bash["last"]), (10, 1, ["kanban"], "2026-09-27"))
        self.assertIsNone([r for r in t["builtin"] if r["name"] == "exec"][0]["errors"])  # Codex writes no failures
        self.assertNotIn("Skill", [r["name"] for r in t["builtin"]])
        mcp = {m["id"]: m for m in t["mcp"]}
        self.assertEqual((mcp["harbor"]["calls"], mcp["harbor"]["offered"]), (2, 1))
        self.assertTrue(mcp["claude_ai_Gmail"]["connector"])
        self.assertEqual(mcp["claude_ai_Gmail"]["name"], "Gmail")
        self.assertEqual(t["unused_skills"], ["getnote"])
        self.assertEqual(t["unused_agents"], ["sonnet-max"])
        self.assertTrue(t["agents"][0]["defined"])
        self.assertEqual(t["hooks"][0]["event"], "Stop")
        self.assertEqual(t["commands"][0]["name"], "/login")

    def test_project_names(self):
        p = U._Projects(lambda cwd: "")
        self.assertEqual(p(os.path.expanduser("~")), "loose sessions")
        self.assertEqual(p("/private/tmp/claude-501/x"), "temp folders")
        self.assertEqual(p("/Users/x/Projects/harbor"), "harbor")
        self.assertEqual(p(""), "unknown folder")

    def test_mcp_names(self):
        self.assertEqual(U._mcp_name("plugin_playwright_playwright"), "Playwright (plugin)")
        self.assertEqual(U._mcp_name("plugin_design_figma"), "Figma (design plugin)")
        self.assertEqual(U._mcp_name("claude_ai_Google_Drive"), "Google Drive")
        self.assertEqual(U._mcp_name("claude-in-chrome"), "Claude in Chrome")


class Page(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_no_reading_yet_starts_one_and_says_counting(self):
        with mock.patch.object(U, "start_refresh", return_value=True) as start:
            r = U.page()
        self.assertEqual(r["state"], "counting")
        start.assert_called_once()

    def test_a_recent_reading_answers_at_once_without_refreshing(self):
        U._write_json(U._p("page.json"), {"v": U.PAGE_V, "generated_at": time.time() - 30})
        with mock.patch.object(U, "start_refresh") as start:
            r = U.page()
        self.assertEqual((r["state"], r["refreshing"]), ("ready", False))
        start.assert_not_called()

    def test_an_old_reading_answers_and_refreshes(self):
        U._write_json(U._p("page.json"), {"v": U.PAGE_V, "generated_at": time.time() - U.REFRESH_AFTER - 5})
        with mock.patch.object(U, "start_refresh", return_value=True) as start:
            r = U.page()
        self.assertEqual((r["state"], r["refreshing"]), ("ready", True))
        start.assert_called_once()

    def test_an_older_shape_is_not_shown(self):
        U._write_json(U._p("page.json"), {"generated_at": time.time(), "heatmap": {}})
        with mock.patch.object(U, "start_refresh", return_value=True):
            self.assertEqual(U.page()["state"], "counting")


if __name__ == "__main__":
    unittest.main()
