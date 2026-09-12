import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dispatch  # noqa: E402
import memories  # noqa: E402  (the same `dispatch` instance the module calls into, so patches land)


class MemoriesPage(unittest.TestCase):
    """`dispatch memories`: grouping by project, expired project dirs, archive, cached model summary."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._home = dispatch.HOME
        self._stores = memories.MEMORY_STORES
        self._dispatch_dir = dispatch.DISPATCH_DIR
        dispatch.HOME = self.tmp
        self.projects = os.path.join(self.tmp, ".claude", "projects")
        self.mem = os.path.join(self.projects, "-Users-me-Projects-demo", "memory")
        os.makedirs(self.mem)
        self.real_demo = os.path.join(self.tmp, "Projects", "demo")
        os.makedirs(self.real_demo)
        memories.MEMORY_STORES = [("claude-code", os.path.join(self.projects, "*", "memory", "*.md"))]
        self._patches = [
            patch.object(dispatch, "project_names", return_value={}),
            patch.object(dispatch, "settings_load", return_value={}),
            patch.object(memories, "claude_project_dirs", return_value={"-Users-me-Projects-demo": self.real_demo}),
            patch.object(memories, "claude_decode_dir", return_value=None),
            patch.object(dispatch, "zcode_query", return_value=[]),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        dispatch.HOME = self._home
        memories.MEMORY_STORES = self._stores
        dispatch.DISPATCH_DIR = self._dispatch_dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, text):
        with open(os.path.join(self.mem, name), "w", encoding="utf-8") as f:
            f.write(text)

    def test_parse_frontmatter_nested_flat_folded_and_missing(self):
        nested = "---\nname: a\ndescription: 一句\nmetadata: \n  node_type: memory\n  type: feedback\n  originSessionId: s1\n---\n正文\n"
        fields, body = memories.parse_frontmatter(nested)
        self.assertEqual(fields["type"], "feedback")
        self.assertEqual(fields["node_type"], "memory")
        self.assertEqual(body, "正文\n")
        folded = "---\nname: c\ndescription: >\n  第一行\n  第二行\n---\nb"
        self.assertEqual(memories.parse_frontmatter(folded)[0]["description"], "第一行 第二行")
        flat = "---\nname: b\ndescription: 平\n在 continuation\n---\nx"
        self.assertEqual(memories.parse_frontmatter(flat)[0]["description"], "平 在 continuation")
        self.assertEqual(memories.parse_frontmatter("# 没有 frontmatter\n正文"), ({}, "# 没有 frontmatter\n正文"))

    def test_entries_group_project_and_flag_missing_frontmatter_and_index(self):
        self.write("MEMORY.md", "- [文学](user_literary.md) — 描述\n")
        self.write("user_literary.md", "---\nname: user_literary\ndescription: 用户的文学趣味\ntype: user\noriginSessionId: s1\n---\n正文 A\n")
        self.write("nested.md", "---\nname: nested\ndescription: 嵌套的\nmetadata: \n  node_type: memory\n  type: feedback\n---\n正文 B\n")
        self.write("folded.md", "---\nname: folded\ndescription: >\n  合并的\n  描述\n---\n正文 C\n")
        self.write("raw.md", "# 没有 frontmatter\n正文 D\n")
        rows = memories.memory_entries()
        by = {r["name"]: r for r in rows}
        self.assertEqual(len(rows), 5)
        self.assertEqual(by["user_literary"]["type"], "user")
        self.assertEqual(by["nested"]["type"], "feedback")
        self.assertEqual(by["folded"]["description"], "合并的 描述")
        self.assertEqual(by["raw"]["description"], "")
        self.assertEqual(by["raw"]["body"], "# 没有 frontmatter\n正文 D\n")
        self.assertTrue(all(r["project"] == "demo" and not r["expired"] for r in rows))
        self.assertTrue(by["MEMORY"]["index"])
        self.assertTrue(by["MEMORY"]["body"].startswith("- [文学]"))
        self.assertFalse(rows[0]["index"])
        self.assertTrue(rows[-1]["index"])

    def test_expired_project_directory_is_flagged(self):
        old = os.path.join(self.projects, "-old-gone", "memory")
        os.makedirs(old)
        open(os.path.join(old, "orphan.md"), "w").write("---\nname: orphan\n---\n正文\n")
        row = next(r for r in memories.memory_entries() if r["name"] == "orphan")
        self.assertTrue(row["expired"])
        self.assertEqual(row["project_dir"], "")
        self.assertEqual(row["project"], "gone")

    def test_zcode_resolves_real_directory_by_hash(self):
        zbase = os.path.join(self.tmp, ".zcode", "cli", "memories", "projects")
        h = hashlib.sha256(self.real_demo.encode()).hexdigest()[:16]
        zdir = os.path.join(zbase, "demo-" + h, "memory")
        os.makedirs(zdir)
        open(os.path.join(zdir, "z.md"), "w").write("---\nname: z\nmetadata:\n  type: project\n---\n正文\n")
        memories.MEMORY_STORES = memories.MEMORY_STORES + [("zcode", os.path.join(zbase, "*", "memory", "*.md"))]
        with patch.object(dispatch, "zcode_query", return_value=[{"directory": self.real_demo}]):
            row = next(r for r in memories.memory_entries() if r["name"] == "z")
        self.assertEqual(row["project"], "demo")
        self.assertEqual(row["project_dir"], self.real_demo)
        self.assertFalse(row["expired"])
        self.assertEqual(row["type"], "project")

    def test_codex_threads_split_into_entries(self):
        raw = os.path.join(self.tmp, "raw_memories.md")
        open(raw, "w", encoding="utf-8").write(
            "# Raw Memories\n\n"
            "## Thread `aaaaaaaa-1111-2222-3333-444444444444`\n"
            "updated_at: 2026-08-07T17:30:12+00:00\n---\n"
            "description: 第一个\n task: 任务一\ncwd: /tmp/alpha\nkeywords: a,b\n---\n\n"
            "### Task 1: 子任务\ntask: inner-task\nbody one\n\n"
            "## Thread `bbbbbbbb-1111-2222-3333-444444444444`\n"
            "description: 第二个\ncwd: /tmp/beta\n\n### Task 1: x\ntext\n")
        memories.MEMORY_STORES = [("codex", raw)]
        rows = memories.codex_entries()
        self.assertEqual(len(rows), 2)
        self.assertEqual([r["id"] for r in rows], ["codex:aaaaaaaa-1111-2222-3333-444444444444", "codex:bbbbbbbb-1111-2222-3333-444444444444"])
        self.assertEqual(rows[0]["name"], "任务一")
        self.assertEqual(rows[0]["description"], "第一个")
        self.assertEqual(rows[0]["project"], "alpha")
        self.assertEqual(rows[1]["name"], "第二个")
        self.assertNotIn("inner-task", rows[0]["description"])

    def test_archive_moves_file_and_rejects_codex_or_outside(self):
        p = os.path.join(self.mem, "user_literary.md")
        open(p, "w").write("---\nname: x\n---\nbody")
        res = memories.memory_archive(p)
        dest = os.path.join(os.path.realpath(self.mem), "archived", "user_literary.md")
        self.assertEqual(res["to"], dest)
        self.assertTrue(os.path.isfile(dest))
        self.assertFalse(os.path.exists(p))
        outside = os.path.join(self.tmp, "elsewhere.md")
        open(outside, "w").write("x")
        with self.assertRaises(ValueError):
            memories.memory_archive(outside)
        raw = os.path.join(self.tmp, "raw_memories.md")
        open(raw, "w").write("x")
        memories.MEMORY_STORES = [("codex", raw)]
        with self.assertRaises(ValueError):
            memories.memory_archive(raw)

    def test_summary_calls_model_once_then_caches_and_recomputes(self):
        self.write("user_literary.md", "---\nname: user_literary\ndescription: 文学\ntype: user\n---\n正文\n")
        dispatch.DISPATCH_DIR = os.path.join(self.tmp, "dispatch")
        sys.path.insert(0, HERE)
        import summarize
        fake = {"id": "zhipu", "model": "glm-5.3-flash"}
        reply = json.dumps({"overall": "总览", "projects": {"claude-code|demo": "一句"}}, ensure_ascii=False)
        with patch.object(summarize, "provider", return_value=fake), patch.object(summarize, "chat", return_value=reply) as chat:
            first = memories.memory_summary()
            second = memories.memory_summary()
            self.assertFalse(first["cached"])
            self.assertTrue(second["cached"])
            self.assertEqual(chat.call_count, 1)
            self.assertEqual(first["overall"], "总览")
            self.assertEqual(first["projects"], {"claude-code|demo": "一句"})
            self.write("user_second.md", "---\nname: second\ndescription: 变了\n---\n新内容\n")
            third = memories.memory_summary()
            self.assertEqual(chat.call_count, 2)
            self.assertFalse(third["cached"])
            self.assertNotEqual(first["fingerprint"], third["fingerprint"])

    def test_summary_json_tolerates_braces_inside_strings(self):
        text = '{"overall": "用了 {curly} 和 } 括号", "projects": {"claude-code|demo": "一句"}}'
        self.assertEqual(memories._memory_summary_json(text),
                         {"overall": "用了 {curly} 和 } 括号", "projects": {"claude-code|demo": "一句"}})

    def test_summary_recomputes_when_cache_holds_an_empty_result(self):
        self.write("user_literary.md", "---\nname: u\ndescription: 文学\ntype: user\n---\n正文\n")
        dispatch.DISPATCH_DIR = os.path.join(self.tmp, "dispatch")
        os.makedirs(dispatch.DISPATCH_DIR, exist_ok=True)
        rows = memories.memory_entries()
        with open(os.path.join(dispatch.DISPATCH_DIR, "memory-summaries.json"), "w", encoding="utf-8") as f:
            json.dump({"at": 1, "model": "zhipu:glm-5.3-flash",
                       "fingerprint": memories.memory_entry_fingerprint(rows), "overall": "", "projects": {}}, f)
        sys.path.insert(0, HERE)
        import summarize
        reply = json.dumps({"overall": "重算", "projects": {"claude-code|demo": "一句"}}, ensure_ascii=False)
        with patch.object(summarize, "provider", return_value={"id": "zhipu", "model": "glm-5.3-flash"}), \
             patch.object(summarize, "chat", return_value=reply) as chat:
            r = memories.memory_summary()
        self.assertEqual(chat.call_count, 1)
        self.assertFalse(r["cached"])
        self.assertEqual(r["overall"], "重算")

    def test_summary_text_flattens_object_and_list_shapes(self):
        self.assertEqual(memories._summary_text({"偏好": "爱简洁", "反馈": "少废话"}), "**偏好**：爱简洁\n**反馈**：少废话")
        self.assertEqual(memories._summary_text(["一", "二"]), "一\n二")
        self.assertEqual(memories._summary_text("纯文本"), "纯文本")
        self.assertEqual(memories._summary_text(None), "")


if __name__ == "__main__":
    unittest.main()
