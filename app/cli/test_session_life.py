import json
import os
import tempfile
import unittest
from unittest.mock import patch

import session_life as L


class Life(unittest.TestCase):
    def test_context_breakdown_is_read_for_a_claude_session_only(self):
        import tempfile
        sid = "0b7e7d4c-1f2a-4c3b-9d8e-1234567890ab"
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "context-usage"))
            with open(os.path.join(d, "context-usage", sid + ".json"), "w") as f:
                json.dump({"total": 1200, "max": 200000, "categories": [{"name": "Messages", "tokens": 800}]}, f)
            self.assertEqual(L.context_breakdown("claude-code:" + sid, base=d)["total"], 1200)
            self.assertEqual(L.context_breakdown("opencode:ses_abc", base=d), {})
            self.assertEqual(L.context_breakdown("claude-code:" + sid.replace("0", "1"), base=d), {})

    def test_claude_deduplicates_request_blocks_and_includes_both_caches(self):
        m = L.Meter()
        for rid, n in (("a", 100), ("a", 100), ("b", 200), ("a", 100)):
            m.feed({"type": "assistant", "requestId": rid, "timestamp": "2026-09-29T10:00:00Z",
                    "message": {"id": rid, "usage": {"input_tokens": n, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 20},
                                "content": [{"type": "tool_use", "id": rid}]}}, "claude-code")
        self.assertEqual(m.data["cumulative_read_tokens"], 440)
        self.assertEqual(m.data["context_tokens"], 270)
        self.assertEqual(m.data["tool_steps"], 2)
        self.assertEqual(m.data["messages"], 2)

    def test_codex_inclusive_input_and_cumulative_difference(self):
        m = L.Meter()
        for total, last in ((1000, 1000), (1000, 1000), (2300, 1300)):
            m.feed({"type": "event_msg", "payload": {"type": "token_count", "info": {
                "last_token_usage": {"input_tokens": last, "cached_input_tokens": 800},
                "total_token_usage": {"input_tokens": total, "cached_input_tokens": 1600}, "model_context_window": 16000}}}, "codex")
        self.assertEqual(m.data["context_tokens"], 1300)
        # Unrealistic cached count > total is clamped by the normalization.
        self.assertEqual(m.data["cumulative_read_tokens"], 2300)
        self.assertEqual(m.snapshot()["limit_tokens"], 12800)

    def test_model_windows_and_explicit_override(self):
        for model in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1",
                      "claude-sonnet-5-5-20260928", "opus-5-5", "unknown[1m]"):
            with self.subTest(model=model):
                m = L.Meter({"model": model, "context_tokens": 98000})
                self.assertEqual(m.snapshot()["limit_tokens"], 800000)
                self.assertEqual(m.snapshot()["status"], "ok")
        for model in ("claude-haiku-4-5-20251001", "unknown", "claude-sonnet-5-9"):
            self.assertEqual(L.Meter({"model": model}).snapshot()["limit_tokens"], 160000)
        m = L.Meter({"model_context_window": 272000})
        self.assertEqual(m.snapshot()["limit_tokens"], 217600)
        self.assertEqual(m.snapshot({"session_life_tokens": 900000})["limit_tokens"], 272000)
        self.assertEqual(m.snapshot({"session_life_tokens": 20000})["limit_tokens"], 20000)
        self.assertEqual(L.D.settings_parse('{"session_life_tokens":-1}'), {"session_life_tokens": -1})
        self.assertEqual(L.D.SETTING_DEFAULTS["session_life_tokens"], -1)

    def test_parent_excludes_child_but_child_transcript_counts_it(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "child.jsonl")
            rows = [{"type": "assistant", "isSidechain": True, "timestamp": "2026-09-29T10:00:00Z",
                     "message": {"id": "c1", "model": "claude-sonnet-5-5", "usage": {"input_tokens": 900000}}}]
            with open(path, "w") as f:
                f.write(json.dumps(rows[0]) + "\n")
            parent = L.transcript_meter(path, "claude-code", root)
            child = L.transcript_meter(path, "claude-code", root, subagent=True)
            self.assertIsNone(parent.data["context_tokens"])
            self.assertEqual(parent.data["started_at"], 0)
            self.assertEqual(child.data["context_tokens"], 900000)
            self.assertEqual(child.snapshot()["status"], "limit")

    def test_usage_fields_have_one_definition(self):
        self.assertEqual(L.read_tokens(L.codex_usage({"inputTokens": 1000, "cachedInputTokens": 800}, True)), 1000)
        self.assertEqual(L.read_tokens(L.claude_usage({"input_tokens": 200, "cache_read_input_tokens": 800})), 1000)

    def test_unknown_and_disabled_are_not_zero_measurements(self):
        m = L.Meter()
        self.assertIsNone(m.snapshot()["context_tokens"])
        m.usage({"input": 10}, "r")
        self.assertIsNone(m.snapshot({"session_life_tokens": 0})["percent"])
        self.assertFalse(m.snapshot({"session_life_tokens": 0})["auto_handoff"])

    def test_warning_and_limit(self):
        m = L.Meter()
        for n, state in ((79, "ok"), (80, "warning"), (100, "limit")):
            m.usage({"input": n}, str(n))
            self.assertEqual(m.snapshot({"session_life_tokens": 100})["status"], state)

    def test_incremental_scan_partial_line_and_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "session.jsonl")
            row = json.dumps({"type": "assistant", "requestId": "a", "message": {"usage": {"input_tokens": 50}}})
            with open(path, "w") as f: f.write(row + "\n" + row[:20])
            self.assertEqual(L.transcript_meter(path, "claude-code", root).data["cumulative_read_tokens"], 50)
            with open(path, "a") as f: f.write(row[20:] + "\n")
            self.assertEqual(L.transcript_meter(path, "claude-code", root).data["cumulative_read_tokens"], 50)
            with open(path, "w") as f: f.write("{}\n")
            self.assertIsNone(L.transcript_meter(path, "claude-code", root).data["context_tokens"])

    def test_tool_results_do_not_count_as_user_rounds(self):
        m = L.Meter()
        m.feed({"type": "user", "uuid": "a", "message": {"content": "do work"}}, "claude-code")
        m.feed({"type": "user", "uuid": "b", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}, "claude-code")
        m.feed({"type": "system", "subtype": "compact_boundary"}, "claude-code")
        self.assertEqual((m.data["rounds"], m.data["epoch"], m.data["context_tokens"]), (1, 1, 0))

    def test_window_query_refreshes_usage_during_a_turn(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "native.jsonl")
            row = {"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 1500}, "total_token_usage": {"input_tokens": 2500}}}}
            with open(path, "w") as f: f.write(json.dumps(row) + "\n")
            snapshot = {"session": "codex:window", "native_session": "codex:native", "cwd": root, "context_tokens": 1000, "messages": 4}
            L.save(L.path_for("runtime", "codex:window", root), {"snapshot": snapshot,
                "native_contexts": {"codex:old": {"cumulative_read_tokens": 5000}, "codex:native": {"cumulative_read_tokens": 1000}}})
            with patch('ide_sessions.transcript_key', return_value='codex:native'), patch.object(L.D, 'load_index', return_value={}), \
                 patch.object(L.D, 'resolve', return_value=[{"path": path}]):
                result = L.measure('codex:window', base=root, settings={})
            self.assertEqual(result['context_tokens'], 1500)
            self.assertEqual(result['cumulative_read_tokens'], 7500)
            self.assertEqual(result['messages'], 4)

    def test_opencode_pending_message_does_not_erase_latest_request_usage(self):
        messages = [{"id": "done", "time_created": 1000, "data": json.dumps({"role": "assistant", "tokens": {"input": 100, "cache": {"read": 50}}})},
                    {"id": "pending", "time_created": 2000, "data": json.dumps({"role": "assistant", "tokens": {"input": 0, "cache": {"read": 0}}})}]
        with patch.object(L.D, 'zcode_query', side_effect=[messages, [{"n": 0}]]):
            m = L.store_meter('sid')
        self.assertEqual(m.data['context_tokens'], 150)

    def test_opencode_compaction_starts_a_new_epoch(self):
        rows = [{"role": "assistant", "tokens": {"input": 900, "cache": {"read": 0}}},
                {"role": "assistant", "summary": True, "mode": "compaction", "tokens": {"input": 2000}},
                {"role": "user"},
                {"role": "assistant", "tokens": {"input": 120, "cache": {"read": 30}}}]
        messages = [{"id": f"m{i}", "time_created": 1000 + i, "data": json.dumps(r)} for i, r in enumerate(rows)]
        with patch.object(L.D, 'zcode_query', side_effect=[messages, [{"n": 0}]]):
            m = L.store_meter('sid')
        self.assertEqual((m.data['epoch'], m.data['context_tokens']), (1, 150))

    def test_opencode_session_is_measured_from_its_store_without_chatd(self):
        with patch("agent_switch.find_source") as find, patch.object(L, "store_meter", return_value=L.Meter({"context_tokens": 5})) as meter:
            r = L.measure("opencode:ses_abc", agent="opencode", settings={})
        find.assert_not_called()
        meter.assert_called_once_with("ses_abc", "opencode")
        self.assertEqual(r["context_tokens"], 5)


if __name__ == "__main__": unittest.main()


class OpenCodeWindow(unittest.TestCase):
    """OpenCode models take their window from OpenCode's own models cache (limit.context), not the 200K fallback."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dtest-ocwin-")
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "opencode"))
        with open(os.path.join(self.tmp, "opencode", "models.json"), "w") as f:
            json.dump({"deepseek": {"models": {"deepseek-flash": {"limit": {"context": 1000000, "output": 393216}}}},
                       "zai-coding-plan": {"models": {"glm-5.3-flash": {"limit": {"context": 1000000}}}},
                       "other": {"models": {"small": {"limit": {"context": 64000}}}}}, f)
        p = patch.dict(os.environ, {"XDG_CACHE_HOME": self.tmp})
        p.start()
        self.addCleanup(p.stop)

    def test_one_million_window_gives_800k_on_automatic(self):
        for model, provider in (("deepseek-flash", "deepseek"), ("glm-5.3-flash", "zai-coding-plan"), ("deepseek/deepseek-flash", "")):
            m = L.Meter({"model": model, "provider": provider, "context_tokens": 1000})
            snap = m.snapshot({"session_life_tokens": L.DEFAULT_LIMIT})
            self.assertEqual((snap["model_context_window"], snap["limit_tokens"]), (1000000, 800000), model)

    def test_unknown_models_and_claude_keep_their_rules(self):
        self.assertEqual(L.model_window("nobody-knows"), L.FALLBACK_WINDOW)
        self.assertEqual(L.model_window("small"), 64000)
        self.assertEqual(L.model_window("claude-opus-5-5"), 1000000)
        self.assertEqual(L.model_window("claude-haiku-4-5"), 200000)

    def test_a_window_the_engine_reported_wins(self):
        m = L.Meter({"model": "deepseek-flash", "provider": "deepseek", "model_context_window": 128000, "context_tokens": 1})
        self.assertEqual(m.snapshot({"session_life_tokens": L.DEFAULT_LIMIT})["limit_tokens"], 102400)
