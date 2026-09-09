import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)


class RetiredAgentCache(unittest.TestCase):
    def test_old_local_and_remote_entries_do_not_reappear(self):
        rows = {"old": {"agent": "qoder"}, "ide": {"agent": "qoder-ide"}, "keep": {"agent": "codex"}}
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(rows, f); f.flush()
            with patch.object(dispatch, "INDEX_FILE", f.name):
                self.assertEqual(dispatch.load_index(), {"keep": rows["keep"]})
            # Migration changes Dispatch's view, not another application's source data.
            with open(f.name) as saved:
                self.assertEqual(json.load(saved), rows)
        self.assertEqual(dispatch._only_theirs(list(rows.values())), [rows["keep"]])


class ResumeCommand(unittest.TestCase):
    def test_claude(self):
        self.assertEqual(dispatch.resume_command("claude-code", "abc", "/Users/x/p"), "cd '/Users/x/p' && claude --resume abc")

    def test_codex(self):
        self.assertEqual(dispatch.resume_command("codex", "abc", ""), "codex resume abc")

    def test_quotes_in_cwd_are_escaped(self):
        cmd = dispatch.resume_command("claude-code", "abc", "/Users/x/it's")
        self.assertIn("'/Users/x/it'\\''s'", cmd)

    def test_zcode_has_no_cli(self):
        self.assertTrue(dispatch.resume_command("zcode", "sess_1", "/x").startswith("open -a ZCode"))


class HostApp(unittest.TestCase):
    def test_walks_to_app_bundle(self):
        table = {10: (5, "/opt/homebrew/bin/fish"), 5: (1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), 1: (0, "launchd")}
        self.assertEqual(dispatch.host_app_of(10, table), "Ghostty")

    def test_none_without_bundle(self):
        table = {10: (1, "fish"), 1: (0, "launchd")}
        self.assertIsNone(dispatch.host_app_of(10, table))


class SessionDetailClaude(unittest.TestCase):
    def test_timeline_and_file_changes(self):
        lines = [
            {"type": "user", "timestamp": "2026-09-02T10:00:00Z", "message": {"role": "user", "content": "修一下 task-1"}},
            {"type": "assistant", "timestamp": "2026-09-02T10:00:05Z", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "好的"},
                {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/x/a.ts", "old_string": "a", "new_string": "b"}},
                {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "npm test"}},
            ]}},
            {"type": "user", "timestamp": "2026-09-02T10:00:06Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
            {"type": "user", "isSidechain": True, "timestamp": "2026-09-02T10:00:07Z", "message": {"role": "user", "content": "subagent noise"}},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for l in lines:
                f.write(json.dumps(l) + "\n")
        ref = {"agent": "claude-code", "path": f.name, "session_id": "s", "cwd": "/x", "title": "", "tasks": {}, "subagents": []}
        d = dispatch.read_session_detail(ref)
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant"])
        self.assertEqual([t["name"] for t in d["messages"][1]["tools"]], ["Edit", "Bash"])
        self.assertEqual(d["files"][0]["path"], "/x/a.ts")
        self.assertEqual(d["files"][0]["changes"][0]["new"], "b")
        self.assertEqual(d["tool_counts"], {"Edit": 1, "Bash": 1})
        os.unlink(f.name)


class RulesSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.rules = os.path.join(self.tmp, "GLOBAL.md")
        with open(self.rules, "w") as f:
            f.write("# rules\n- fish, not bash\n")
        self._orig = (dispatch.RULES_FILE, dict(dispatch.RULE_TARGETS))
        dispatch.RULES_FILE = self.rules
        dispatch.RULE_TARGETS = {
            "claude": {"path": os.path.join(self.tmp, "CLAUDE.md"), "mode": "import"},
            "codex": {"path": os.path.join(self.tmp, "AGENTS.md"), "mode": "inline"},
        }
        with open(dispatch.RULE_TARGETS["claude"]["path"], "w") as f:
            f.write("# claude only\n")

    def tearDown(self):
        dispatch.RULES_FILE, dispatch.RULE_TARGETS = self._orig

    def _sync(self, force=False):
        import io, contextlib
        a = type("A", (), {"op": "sync", "force": force, "json": True})()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dispatch.cmd_rules(a)
        return json.loads(buf.getvalue())

    def test_sync_creates_appends_and_is_idempotent(self):
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "appended", "codex": "created"})
        claude = open(dispatch.RULE_TARGETS["claude"]["path"]).read()
        self.assertTrue(claude.startswith("# claude only\n"))
        self.assertIn("@" + self.rules, claude)  # import, not a copy
        codex = open(dispatch.RULE_TARGETS["codex"]["path"]).read()
        self.assertIn("- fish, not bash", codex)  # inlined
        r2 = self._sync()
        self.assertTrue(all(x["action"] == "unchanged" for x in r2["results"]))

    def test_edit_marks_stale_and_updates_in_place(self):
        self._sync()
        with open(self.rules, "a") as f:
            f.write("- new rule\n")
        h = dispatch.rules_hash(dispatch.rules_text())
        self.assertEqual(dispatch.target_state("codex", h)[0], "stale")
        r = self._sync()
        self.assertEqual({x["agent"]: x["action"] for x in r["results"]}, {"claude": "updated", "codex": "updated"})
        codex = open(dispatch.RULE_TARGETS["codex"]["path"]).read()
        self.assertEqual(codex.count(dispatch.RULES_BEGIN), 1)
        self.assertIn("- new rule", codex)


class Frontmatter(unittest.TestCase):
    def test_reads_name_and_description(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "SKILL.md"), "w") as f:
            f.write('---\nname: x\ndescription: "does things"\n---\n# x\n')
        fm = dispatch.read_frontmatter(d)
        self.assertEqual(fm["description"], "does things")


if __name__ == "__main__":
    unittest.main()


class EnvStore(unittest.TestCase):
    def test_roundtrip_mask_and_fish(self):
        with tempfile.TemporaryDirectory() as d:
            dispatch.ENV_DIR = d; dispatch.ENV_FILE = os.path.join(d, "env"); dispatch.ENV_FISH = os.path.join(d, "env.fish")
            dispatch.env_write([{"name": "ZHIPU_API_KEY", "value": "abc123def456", "note": "智谱 GLM"}, {"name": "X", "value": "has space #1", "note": ""}])
            items = dispatch.env_read()
            self.assertEqual([i["name"] for i in items], ["ZHIPU_API_KEY", "X"])
            self.assertEqual(items[0]["note"], "智谱 GLM"); self.assertEqual(items[1]["value"], "has space #1")
            self.assertEqual(oct(os.stat(dispatch.ENV_FILE).st_mode & 0o777), "0o600")
            self.assertEqual(dispatch.env_mask("abc123def456"), "abc…456")
            self.assertIn("set -gx X 'has space #1'", open(dispatch.ENV_FISH).read())
            self.assertIn("ZHIPU_API_KEY=智谱 GLM", dispatch.env_summary_line())


class Guards(unittest.TestCase):
    def test_quota_modes(self):
        self.assertEqual(dispatch.quota_mode(None)[0], None)
        self.assertEqual(dispatch.quota_mode(30)[0], "normal")
        self.assertEqual(dispatch.quota_mode(80)[0], "saving")
        self.assertIn("省 token", dispatch.quota_mode(85)[1])
        self.assertEqual(dispatch.quota_mode(97)[0], "critical")
    def test_similar_titles(self):
        self.assertGreaterEqual(dispatch.similar("Dispatch 技能视图：使用频次", "Dispatch 技能视图 使用频次 + 按钮"), 0.5)
        self.assertLess(dispatch.similar("Mac mini 安装 Dolt", "雅思刷题网站"), 0.5)
    def test_neighbours_matches_same_or_nested_dir(self):
        dispatch.live_sessions = lambda: [
            {"session_id": "me", "cwd": "/a/b", "alive": True}, {"session_id": "x", "cwd": "/a/b", "alive": True},
            {"session_id": "y", "cwd": "/a/b/sub", "alive": True}, {"session_id": "z", "cwd": "/other", "alive": True}, {"session_id": "d", "cwd": "/a/b", "alive": False}]
        self.assertEqual([s["session_id"] for s in dispatch.neighbours("/a/b", "me")], ["x", "y"])


class EditGuard(unittest.TestCase):
    def test_paths_from_tool_inputs(self):
        spec = importlib.util.spec_from_file_location("edit_guard", os.path.join(HERE, "edit-guard.py"))
        g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
        self.assertEqual(g.files_of("Edit", {"file_path": "/a/b.ts"}), ["/a/b.ts"])
        self.assertEqual(g.files_of("apply_patch", {"input": "*** Begin Patch\n*** Update File: x/y.py\n@@\n*** Add File: z.md\n*** End Patch"}), ["x/y.py", "z.md"])
        self.assertEqual(g.files_of("Bash", {"command": "ls"}), [])


class FrontmatterMultiline(unittest.TestCase):
    def test_folded_and_indented_descriptions(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "SKILL.md"), "w").write("---\nname: x\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\nbody")
            self.assertEqual(dispatch.read_frontmatter(d)["description"], "first line second line")
            open(os.path.join(d, "SKILL.md"), "w").write("---\nname: y\ndescription:\n  只有缩进的一行\n---\n")
            self.assertEqual(dispatch.read_frontmatter(d)["description"], "只有缩进的一行")


class PeerReview(unittest.TestCase):
    def run_review(self, verdict="pass", actor="codex", assignee="claude-code", status="closed", labels=None):
        from types import SimpleNamespace
        from unittest.mock import patch
        issue = {"status": status, "assignee": assignee, "labels": labels or []}
        with patch.dict(os.environ, {"BEADS_ACTOR": actor}), patch.object(dispatch, "bd_json", return_value=issue) as bd, patch.object(dispatch, "sh", return_value=(0, "", "")) as shell:
            dispatch.cmd_review(SimpleNamespace(task="task-test", verdict=verdict, reason="tests passed"))
            return bd.call_args_list, shell.call_args_list
    def test_independent_review_records_author_and_evidence(self):
        bd, shell = self.run_review()
        self.assertIn("reviewed", bd[-1].args[0])
        self.assertIn("codex", shell[0].args[0][-1])
        self.assertIn("tests passed", shell[0].args[0][-1])
    def test_self_review_is_rejected(self):
        with self.assertRaises(SystemExit): self.run_review(actor="claude-code")
    def test_incomplete_task_cannot_pass(self):
        with self.assertRaises(SystemExit): self.run_review(status="open")
    def test_designated_reviewer_is_respected(self):
        with self.assertRaises(SystemExit): self.run_review(labels=["reviewer:pi"])
    def test_changes_reopen_task(self):
        bd, _ = self.run_review(verdict="changes")
        self.assertIn("open", bd[-1].args[0])
        self.assertIn("review-changes", bd[-1].args[0])
    def test_comment_failure_does_not_mark_reviewed(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.dict(os.environ, {"BEADS_ACTOR": "codex"}), patch.object(dispatch, "bd_json", return_value={"status": "closed", "assignee": "claude-code"}) as bd, patch.object(dispatch, "sh", return_value=(1, "", "write failed")):
            with self.assertRaises(SystemExit): dispatch.cmd_review(SimpleNamespace(task="task-test", verdict="pass", reason="checks"))
            self.assertEqual(bd.call_count, 1)


class CompletionReviewRequest(unittest.TestCase):
    def test_completion_does_not_require_review(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(dispatch, "bd_json", return_value={"labels": []}) as bd, patch.object(dispatch, "out"):
            dispatch.cmd_done(SimpleNamespace(task="task-test", reason="done", verified=True, review_by=None, next=[], retro=None, json=False))
            self.assertFalse(any("review-requested" in c.args[0] for c in bd.call_args_list))
    def test_explicit_request_keeps_completion_and_names_reviewer(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(dispatch, "bd_json", return_value={"labels": []}) as bd, patch.object(dispatch, "out"):
            dispatch.cmd_done(SimpleNamespace(task="task-test", reason="done", verified=True, review_by="pi", next=[], retro=None, json=False))
            self.assertEqual(bd.call_args_list[0].args[0][0], "close")
            self.assertIn("reviewer:pi", bd.call_args_list[1].args[0])

class BeginSessionLink(unittest.TestCase):
    def test_records_explicit_session_for_delivery(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='session-123456', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd:
            dispatch.cmd_begin(a)
        self.assertIn('session:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])
        self.assertIn('session-origin:session-123456', bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1])

    def test_invalid_session_cannot_inject_labels(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='test', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session='bad,reviewed', force=True)
        with patch.object(dispatch, 'begin_warnings', return_value=[]), patch.object(dispatch, 'local_host_name', return_value='test'), patch.object(dispatch, 'out'), patch.object(dispatch, 'bd_json', side_effect=[{'id':'task-test'},{}]) as bd:
            dispatch.cmd_begin(a)
        self.assertEqual(bd.call_args_list[0].args[0][bd.call_args_list[0].args[0].index('-l')+1], 'project:kanban,host:test')

class BeginTitleRule(unittest.TestCase):
    def test_vague_title_or_thin_description_is_refused(self):
        self.assertTrue(dispatch.title_problems("修复", ""))
        self.assertTrue(dispatch.title_problems("会话页 diff 改成可横向滚动：手机上右半截被截掉", "短"))
        self.assertEqual(dispatch.title_problems("会话页 diff 改成可横向滚动：手机上右半截被截掉", "用户在手机上看任务页的 diff 时只能看到左半截，期望长行能横向滚动或换行"), [])

    def test_begin_exits_without_creating_when_refused(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        a = SimpleNamespace(title='修复', project='kanban', type='task', priority=2, desc=None, acceptance=None, deps=None, json=True, session=None, force=False)
        with patch.object(dispatch, 'bd_json') as bd, self.assertRaises(SystemExit):
            dispatch.cmd_begin(a)
        bd.assert_not_called()

class ServeSymlink(unittest.TestCase):
    def test_resolves_sibling_server_from_real_cli_path(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root,'cli')); os.makedirs(os.path.join(root,'bin'))
            real=os.path.join(root,'cli','dispatch.py'); link=os.path.join(root,'bin','dispatch')
            with open(real,'w') as f: f.write('')
            os.symlink(real,link)
            with patch.object(dispatch,'__file__',link), patch.object(sys,'argv',['dispatch']), patch('runpy.run_path') as run:
                dispatch.cmd_serve(SimpleNamespace(what='url'))
            run.assert_called_once_with(os.path.realpath(os.path.join(root,'cli','serve.py')),run_name='__main__')


class FactsSections(unittest.TestCase):
    DOC = "# 常用信息\n\n> 说明\n\n## 通用\n\n- 机器 A\n\n## relecture（ReLecture · 重讲）\n\n- 域名 relecture.app\n\n## ReadOut\n\n- 手机阅读\n\n## 空节\n"

    def test_key_is_first_word_lowercased(self):
        self.assertEqual(dispatch.facts_key("relecture（ReLecture · 重讲）"), "relecture")
        self.assertEqual(dispatch.facts_key("ReadOut"), "readout")
        self.assertEqual(dispatch.facts_key("通用"), "通用")

    def test_project_gets_general_plus_its_own_section_only(self):
        picked = dispatch.facts_for("Relecture", self.DOC)
        self.assertEqual([h for h, _ in picked], ["通用", "relecture（ReLecture · 重讲）"])
        self.assertIn("relecture.app", picked[1][1])

    def test_no_project_gets_general_only_and_empty_sections_are_dropped(self):
        self.assertEqual([h for h, _ in dispatch.facts_for("", self.DOC)], ["通用"])
        self.assertEqual([h for h, _ in dispatch.facts_for("空节", self.DOC)], ["通用"])


class ProjectFlags(unittest.TestCase):
    def test_parse_keeps_only_true_known_fields(self):
        raw = json.dumps({"a": {"starred": True, "archived": False, "x": 1}, "b": {"archived": True}, "c": {"starred": False}, "d": "bad"})
        self.assertEqual(dispatch.project_flags_parse(raw), {"a": {"starred": True}, "b": {"archived": True}})
        self.assertEqual(dispatch.project_flags_parse(""), {})
        self.assertEqual(dispatch.project_flags_parse("not json"), {})

    def test_apply_merges_and_drops_empty(self):
        flags = dispatch.project_flags_apply({}, "ReadOut", {"starred": True})
        flags = dispatch.project_flags_apply(flags, "ReadOut", {"archived": True})
        self.assertEqual(flags, {"ReadOut": {"starred": True, "archived": True}})
        flags = dispatch.project_flags_apply(flags, "ReadOut", {"starred": False, "archived": False})
        self.assertEqual(flags, {})

    def test_apply_rejects_bad_input(self):
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "", {"starred": True})
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "x", {"pinned": True})
        with self.assertRaises(ValueError): dispatch.project_flags_apply({}, "x", {"starred": "yes"})

    def test_internal_memory_hidden_from_wiki(self):
        with patch.object(dispatch, "sh", return_value=(0, json.dumps({"schema_version": 1, "pit-a": "【坑】x", "dispatch-projects": "{}"}), "")):
            self.assertEqual([it["key"] for it in dispatch.wiki_all()], ["pit-a"])


class HumanNote(unittest.TestCase):
    def test_only_the_users_latest_unanswered_note_is_injected(self):
        user = {"author": "schaefer", "text": "请补一下  手机截图", "created_at": "2"}
        agent = {"author": "claude-code", "text": "好的", "created_at": "3"}
        self.assertEqual(dispatch.human_note([agent, user], "claude-code"), "请补一下 手机截图")
        self.assertEqual(dispatch.human_note([user, agent], "claude-code"), "")
        self.assertEqual(dispatch.human_note([{"author": "codex", "text": "x", "created_at": "1"}], "claude-code"), "")
        self.assertEqual(dispatch.human_note([], "claude-code"), "")


class SessionLifecycle(unittest.TestCase):
    def test_settings_parse_keeps_known_numeric_keys(self):
        self.assertEqual(dispatch.settings_parse(json.dumps({"session_archive_days": 45, "x": 1, "bad": "no"})), {"session_archive_days": 45})
        self.assertEqual(dispatch.settings_parse("nope"), {})

    def test_starred_sessions_of_project(self):
        idx = {"/a": {"agent": "claude-code", "session_id": "aaaa1111", "cwd": "/Users/x/Projects/kanban/app", "title": "长线", "mtime": 5},
               "/b": {"agent": "codex", "session_id": "bbbb2222", "cwd": "/Users/x/Projects/other", "title": "别的", "mtime": 9},
               "/c": {"agent": "codex", "session_id": "cccc3333", "cwd": "/Users/x/Projects/kanban", "title": "归档了", "mtime": 9}}
        prefs = {"claude-code:aaaa1111": {"starred": True}, "codex:bbbb2222": {"starred": True}, "codex:cccc3333": {"starred": True, "archived": True}}
        rows = dispatch.starred_sessions(prefs, idx, "kanban", {"kanban": "kanban"})
        self.assertEqual([r["session_id"] for r in rows], ["aaaa1111"])
        self.assertEqual([r["session_id"] for r in dispatch.starred_sessions(prefs, idx, "", {})], ["bbbb2222", "aaaa1111"])


class Facts(unittest.TestCase):
    TEXT = "# x\n\n## 通用\n\n**机器**\n- 本机 MacBook，Tailscale 100.85.245.72\n- mini 100.118.80.86\n\n**我常说的话**\n- 密钥只进 dispatch env\n\n## kanban\n- 板在 ~/tasks/.beads\n"

    def test_topics_and_get(self):
        secs = dict(dispatch.facts_sections(self.TEXT))
        self.assertEqual([t for t, _ in dispatch.facts_topics(secs["通用"])], ["机器", "我常说的话"])
        hits = dispatch.facts_get("机器", "", self.TEXT)
        self.assertEqual([(h, t) for h, t, _ in hits], [("通用", "机器")])
        self.assertIn("100.85.245.72", hits[0][2])
        self.assertEqual(dispatch.facts_get("常说", "kanban", self.TEXT)[0][1], "我常说的话")
        self.assertEqual(dispatch.facts_get("nothing", "", self.TEXT), [])

    def test_search_carries_topic(self):
        rows = dispatch.facts_search("mini 100", [("通用", self.TEXT)])
        self.assertEqual(rows, [("通用", "机器", "- mini 100.118.80.86")])

    def test_import_candidates_skip_known_and_irrelevant(self):
        src = [("/m/a.md", "---\nname: x\n---\n\n本机 MacBook，Tailscale 100.85.245.72 就是这台\n\n今天天气不错，写了很多代码，非常开心的一天。\n\nHetzner 别名 hetzner，root@178.104.140.55，裸 IP 会 Permission denied\n"), ("/m/b.md", "Hetzner 别名 hetzner，root@178.104.140.55，裸 IP 会 Permission denied")]
        cands = dispatch.facts_candidates(src, self.TEXT)
        self.assertEqual([p for p, _ in cands], ["/m/a.md", "/m/a.md"])
        self.assertTrue(any("Hetzner" in c for _, c in cands))
        self.assertFalse(any("天气" in c for _, c in cands))


class DynamicWorkflow(unittest.TestCase):
    def test_split_spec(self):
        self.assertEqual(dispatch.split_spec('codex:写测试|覆盖 diff'), ("codex", "写测试", "覆盖 diff"))
        self.assertEqual(dispatch.split_spec('claude:只有标题'), ("claude", "只有标题", ""))
        with self.assertRaises(ValueError): dispatch.split_spec("没有冒号")
        with self.assertRaises(ValueError): dispatch.split_spec("codex:")

    def test_discussion_filter_and_prompts(self):
        cs = [{"text": "普通进展"}, {"text": " 【讨论】codex：拆成两块"}]
        self.assertEqual(dispatch.discussion_of(cs), [cs[1]])
        p1 = dispatch.discuss_prompt("task-1", "标题", 1, "先做哪个")
        self.assertIn("bd show task-1", p1); self.assertIn("先做哪个", p1); self.assertIn("不要改代码", p1)
        self.assertIn("第 2 轮", dispatch.discuss_prompt("task-1", "标题", 2))
