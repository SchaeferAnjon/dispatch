"""Setup's state, selection and undo contract. Every writable path is temporary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import onboarding as O
import prefs
import vscode_import as V


class StateAndUndo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.d = types.SimpleNamespace(DISPATCH_DIR=str(self.root / 'state'), HOME=str(self.root),
                                      RULES_FILE=str(self.root / 'GLOBAL.md'))
        self.addCleanup(patch.stopall)
        patch.object(O, 'D', self.d).start()
        patch.object(O, '_mods', lambda: self.d).start()

    def test_reruns_retain_each_undo_record(self):
        first = O.log_add('projects', 'Projects', 'one', {'projects': []}, 'projects')
        second = O.log_add('projects', 'Projects', 'two', {'projects': []}, 'projects')
        O.save(step='rules')
        self.assertEqual([first['id'], second['id']], [e['id'] for e in O.load()['items']])
        self.assertNotIn('data', O.log_public()[0])

    def test_concurrent_state_edits_do_not_lose_log(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda i: O.log_add('prefs', 'Preferences', str(i)), range(12)))
        self.assertEqual(len(O.load()['items']), 12)

    def test_undo_restores_original_and_keeps_later_edit(self):
        a, b = self.root / 'a', self.root / 'b'
        a.write_text('original')
        before = {str(p): O.snapshot(str(p)) for p in (a, b)}
        a.write_text('setup'); b.write_text('setup')
        changes = O.changed_files(before)
        b.write_text('my later edit')
        entry = O.log_add('agent', 'Codex', 'rules', {'changes': changes})
        result = O.undo(entry['id'])
        self.assertTrue(result['ok'])
        self.assertEqual(a.read_text(), 'original')
        self.assertEqual(b.read_text(), 'my later edit')
        self.assertIn('Kept later edits', result['message'])

    def test_undo_restores_symlink_without_writing_its_target(self):
        target, link = self.root / 'target', self.root / 'link'
        target.write_text('keep')
        link.symlink_to(target)
        before = {str(link): O.snapshot(str(link))}
        link.unlink(); link.write_text('setup')
        O.restore_changes(O.changed_files(before))
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_text(), 'keep')

    def test_only_new_projects_enter_undo_log(self):
        old, new = str(self.root / 'old'), str(self.root / 'new')
        fake = types.SimpleNamespace(register=lambda d, n: {'name': Path(d).name, 'git': True})
        with patch.object(O, 'PV', fake), patch.object(O, 'registered_dirs', return_value=[old]):
            result = O.register([{'dir': old}, {'dir': new}, {'dir': new}])
        self.assertEqual(len(result['added']), 3)
        self.assertEqual([p['dir'] for p in O.load()['items'][0]['data']['projects']], [new])

    def test_setup_says_dispatch_md_only_when_it_is_there(self):
        # task-nb3v: a copy of Dispatch without dispatch.md still logged "dispatch.md (built in)" for Migrations
        home = self.root / 'dispatch-home'
        w = types.SimpleNamespace(ensure_board=lambda: {'created': False}, dispatch_dir_setup=lambda: None)
        with patch.object(O, 'W', w, create=True), patch.dict(os.environ, {'DISPATCH_HOME': str(home)}):
            self.assertFalse(O.apply_dir()['dispatch_md'])
            self.assertNotIn('dispatch.md', O.log_public()[-1]['detail'])
            (home / 'rules').mkdir(parents=True)
            (home / 'rules' / 'dispatch.md').write_text('# Dispatch\n')
            os.remove(self.d.RULES_FILE)
            self.assertTrue(O.apply_dir()['dispatch_md'])
            self.assertIn('dispatch.md (built in)', O.log_public()[-1]['detail'])

    def test_skipping_setup_still_makes_the_task_board(self):
        # audit round 1 (task-cq11p): after Skip setup there was no board, every task tool of an agent failed with bd's own error
        calls = []
        w = types.SimpleNamespace(ensure_board=lambda: calls.append('board') or {'created': True},
                                  save_state=lambda **kw: calls.append(('state', kw)), finish=lambda **kw: calls.append(('finish', kw)))
        with patch.object(O, 'W', w, create=True):
            self.assertEqual(O.finish(skipped=True), {'state': 'skipped', 'board': {'created': True}})
            self.assertEqual(calls, [('state', {'skipped': True}), 'board'])
            self.assertEqual(O.load()['state'], 'skipped')
            calls.clear()
            self.assertEqual(O.finish(skipped=False), {'state': 'done'})
            self.assertEqual(calls, [('finish', {'skipped': False})])
            self.assertEqual(O.load()['state'], 'done')

    def test_setup_says_when_codex_has_not_trusted_dispatch_s_hook_yet(self):
        open(self.d.RULES_FILE, 'w').write('# rules\n')
        installed = {'codex': {'path': '/x/hooks.json', 'trust': {'ok': False, 'why': 'Codex could not be asked'}},
                     'claude-code': {'path': '/x/settings.json'}}
        w = types.SimpleNamespace(agents_setup=lambda agents: {'installed': installed})
        import engines
        with patch.object(O, 'W', w, create=True), patch.object(O, 'E', engines, create=True), patch.object(O, '_sync_rules', return_value={}), \
                patch.object(O, '_mcp_files', return_value=[]), patch.object(O, 'supported', return_value=['claude', 'codex']), \
                patch.object(O, '_rules_path', side_effect=lambda a: str(self.root / f'{a}.md')), \
                patch.object(O, 'changed_files', return_value=[{'path': 'x'}]):
            res = O.apply_rules(['claude', 'codex'])
        self.assertTrue(res['ok'])
        details = {e['title']: e['detail'] for e in O.log_public()}
        self.assertIn("Codex has not trusted Dispatch's hook yet (Codex could not be asked); Dispatch asks it again", details['Codex'])
        self.assertNotIn('trusted', details['Claude Code'])

    def test_claude_codes_row_says_it_got_dispatch_s_tools_too(self):
        # setup calls it "claude", the MCP side "claude-code": its row in What Dispatch changed left the tools out (task-lj06.23)
        import engines
        import mcp_config
        with patch.object(O, 'E', engines, create=True), patch.object(mcp_config, 'home', return_value=str(self.root)), \
                patch.object(mcp_config, 'instance_home', return_value=None):
            files = O._mcp_files('claude')
            self.assertEqual(files, O._mcp_files('claude-code'))
            self.assertTrue(files)
            self.assertTrue(O._mcp_files('codex'))

    def test_sync_uses_prime3_rule_sync_and_only_chosen_agents(self):
        self.d.rule_sync_agents = lambda: ['claude', 'codex', 'zcode']
        self.d.cmd_rules = lambda a: print(json.dumps({'agents': self.d.rule_sync_agents()}))
        self.assertEqual(O._sync_rules(['codex']), {'agents': ['codex']})
        self.assertEqual(self.d.rule_sync_agents(), ['claude', 'codex', 'zcode'])

    def test_scan_uses_shared_builder_and_reports_interruption(self):
        started = []
        self.d.index_progress = lambda: {'state': 'interrupted', 'indexed': True, 'done': 2, 'total': 9}
        self.d.index_start_background = lambda: started.append(True)
        self.assertEqual(O.scan_status()['state'], 'interrupted')
        O.scan_start()
        self.assertEqual(started, [True])

    def test_partial_setup_resumes_after_the_first_projects_are_registered(self):
        fake = types.SimpleNamespace(board_status=lambda: {'exists': True})
        with patch.object(O, 'W', fake), patch.object(O, 'registered_dirs', return_value=['/project']), patch.dict(os.environ, {'DISPATCH_ONBOARDING': '1'}):
            self.assertFalse(O.needed())
            O.save(state='pending')
            self.assertTrue(O.needed())
            O.save(state='done')
            self.assertFalse(O.needed())


class RulesPreferences(unittest.TestCase):
    def test_literal_credentials_are_not_copied_into_the_import_plan(self):
        credential = 'sk-' + 'fixture' * 8
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'CLAUDE.md'
            p.write_text('- Always use ' + credential + ' for requests.\n')
            rows, skipped = prefs.from_rules_file(str(p), 'claude_md', 'CLAUDE.md')
        self.assertEqual(rows, [])
        self.assertEqual(len(skipped), 1)
        self.assertNotIn(credential, json.dumps(skipped))

    def test_facts_stay_out_of_preference_candidates(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'CLAUDE.md'
            p.write_text('- The repos live under ~/Projects\n- Keep explanations short and lead with the result.\n')
            rows, skipped = prefs.from_rules_file(str(p), 'claude_md', 'CLAUDE.md')
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['sure'])
        self.assertEqual(len(skipped), 1)

    def test_rules_sources_ignore_managed_blocks_and_code(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'AGENTS.md'
            p.write_text('''# Rules
- Always explain the result first.
<!-- BEGIN DISPATCH GLOBAL RULES hash:a -->
- Never import this managed instruction.
<!-- END DISPATCH GLOBAL RULES -->
```sh
- Never import this code sample either.
```
- Prefer focused tests before committing.
''')
            rows, _ = prefs.from_rules_file(str(p), 'agents_md', 'AGENTS.md')
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r['sure'] for r in rows))
        self.assertIn('claude_md', prefs.DEFAULT_SOURCES)
        self.assertIn('agents_md', prefs.DEFAULT_SOURCES)
        self.assertEqual(rows[-1]['sources'][0]['line'], 9)


class IsolatedInstance(unittest.TestCase):
    def test_fixture_home_does_not_use_the_host_accounts_or_config(self):
        import ide_e2e as E
        rec = {'name': 'onboarding-test', 'root': '/tmp/dide-e2e/onboarding-test', 'app': '/missing.app',
               'cli': '/tmp/dide-e2e/onboarding-test/cli/dispatch.py', 'fixture_home': '/tmp/dide-e2e/onboarding-test/home',
               'beads_dir': '/tmp/dide-e2e/onboarding-test/board/.beads', 'dispatch_dir': '/tmp/dide-e2e/onboarding-test/dispatch',
               'dispatch_home': '/tmp/dide-e2e/onboarding-test/dispatch-home'}
        env = E.instance_env(rec, {'HOME': '/Users/real', 'CODEX_HOME': '/Users/real/.codex', 'ZDOTDIR': '/Users/real', 'PATH': '/usr/bin'})
        self.assertEqual(env['HOME'], rec['fixture_home'])
        self.assertEqual(env['CODEX_HOME'], rec['fixture_home'] + '/.codex')
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], rec['fixture_home'] + '/.claude')
        self.assertNotIn('ZDOTDIR', env)
        self.assertEqual(env['DISPATCH_ONBOARDING'], '1')
        self.assertTrue(env['PATH'].startswith(rec['fixture_home'] + '/.local/bin'))


class VSCodeImport(unittest.TestCase):
    def test_jsonc_preserves_strings_comments_and_trailing_commas(self):
        text = '{"url":"https://host/", "literal":",}", /* comment */ "list":[1, // hi\n],}'
        self.assertEqual(json.loads(V.strip_jsonc(text)), {'url': 'https://host/', 'literal': ',}', 'list': [1]})

    def test_import_and_undo_keep_new_edits_and_existing_shortcuts(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); src = root / 'source'; dst = root / 'target'
            src.mkdir(); dst.mkdir()
            (src / 'keys.json').write_text('[{"key":"cmd+x"}]')
            (dst / 'settings.json').write_text('{"editor.fontSize":12,"files.autoSave":"off"}')
            (dst / 'keybindings.json').write_text('[]')
            found = {'settings': {'core': [{'key': 'editor.fontSize', 'value': 14}, {'key': 'files.autoSave', 'value': 'afterDelay'}], 'with_extension': []},
                     'keybindings': {'found': True, 'path': str(src / 'keys.json')}, 'snippets': {'files': []}}
            result = V.apply({'settings': ['editor.fontSize', 'files.autoSave'], 'keybindings': True}, found, str(dst))
            self.assertTrue(result['ok']); self.assertFalse(result['keybindings'])
            data = json.loads((dst / 'settings.json').read_text()); data['files.autoSave'] = 'onFocusChange'
            (dst / 'settings.json').write_text(json.dumps(data))
            V.undo(result)
            self.assertEqual(json.loads((dst / 'settings.json').read_text()), {'editor.fontSize': 12, 'files.autoSave': 'onFocusChange'})
            self.assertEqual((dst / 'keybindings.json').read_text(), '[]')

    def test_import_does_not_log_settings_already_equal(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'settings.json').write_text('{"editor.fontSize":14}')
            found = {'settings': {'core': [{'key': 'editor.fontSize', 'value': 14}], 'with_extension': []}, 'keybindings': {'found': False}, 'snippets': {'files': []}}
            self.assertEqual(V.apply({'settings': ['editor.fontSize']}, found, root)['settings'], {})



class CodexChatFolders(unittest.TestCase):
    def test_codex_names_its_chat_folders_after_the_chat(self):
        for d in ("/Users/x/Documents/Codex/2026-09-08/new-chat", "/Users/x/Documents/Codex/2026-09-10/new-chat-2",
                  "/Users/x/Documents/Codex/2026-09-02/hi", "/Users/x/Documents/Codex/2026-09-10/she-m",
                  "/Users/x/Documents/Codex/2026-09-01/3"):
            self.assertTrue(O.codex_chat_folder(d), d)
        for d in ("/Users/x/Projects/kanban", "/Users/x/Documents/Codex", "/Users/x/Documents/Codex/2026-09-08",
                  "/Users/x/Documents/Codex/2026-09-08/new-chat/src"):
            self.assertFalse(O.codex_chat_folder(d), d)


class AgentRows(unittest.TestCase):
    def test_status_lists_every_agent_with_the_choice_and_keeps_the_three_engines(self):
        import agents_catalog as AC
        three = [{"id": i, "name": i, "installed": True, "path": "/x/" + i, "version": "1.0.0", "account": "", "install": "", "sessions": 2} for i in AC.RUNNABLE]
        found = [dict(AC.detect_one(a), installed=a["id"] == "gemini", path="/x/gemini") for a in AC.CATALOG if not a.get("runnable")]
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DISPATCH_DIR": tmp}), \
                patch.object(O, '_mods', lambda: None), patch.object(O, 'engine_rows', lambda counts=None: three), \
                patch.object(AC, 'detect', lambda env=None, only=None: found):
            AC.save_choice(off="codex", on="gemini")
            rows = O.agent_rows({"claude": 2})
        self.assertEqual([r["id"] for r in rows[:3]], ["claude", "codex", "opencode"])
        by = {r["id"]: r for r in rows}
        self.assertTrue(all(r["runnable"] for r in rows[:3]))
        self.assertEqual((by["codex"]["enabled"], by["claude"]["enabled"], by["gemini"]["enabled"], by["aider"]["enabled"]), (False, True, True, False))
        self.assertEqual(by["gemini"]["sessions"], None)
        self.assertEqual(by["claude"]["sessions"], 2)
        self.assertTrue(by["aider"]["install"])

    def test_other_agents_already_found_as_a_command_are_not_listed_twice(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HOME": home}):
            for d in (".gemini", ".zcode"):
                os.makedirs(os.path.join(home, d))
            self.assertEqual(O.other_agents(), ["Gemini CLI", "ZCode"])  # in the order every list of agents follows
            self.assertEqual(O.other_agents({"Gemini CLI"}), ["ZCode"])


if __name__ == '__main__':
    unittest.main()


class UnconnectedAgents(unittest.TestCase):
    """task-vgll: an agent installed after setup has no Dispatch block yet; the title bar's Set up comes back for it."""

    def test_an_installed_agent_without_the_block_is_listed_until_it_has_one(self):
        with tempfile.TemporaryDirectory() as home:
            oc = Path(home) / '.opencode' / 'bin' / 'opencode'
            oc.parent.mkdir(parents=True)
            oc.write_text('#!/bin/sh\necho 1.18.0\n')
            oc.chmod(0o755)
            env = {'HOME': home, 'PATH': '/usr/bin:/bin', 'DISPATCH_DIR': os.path.join(home, 'state'), 'DISPATCH_HOME': os.path.join(home, '.dispatch'),
                   'BEADS_DIR': os.path.join(home, 'nope', '.beads'), 'LANG': 'en_US.UTF-8'}
            # the CLI also looks in Homebrew's and /usr/local's bin and in Dispatch IDE.app: only this test's agents count
            # here (the mini has Codex in /opt/homebrew/bin, this Mac in ~/npm-global/bin, so it failed there only)
            only_path = ("import os, sys, runpy, engines; real = engines.search_path; "
                         "engines.search_path = lambda env=None: os.pathsep.join(d for d in real(env).split(os.pathsep) "
                         "if d.startswith(os.environ['HOME'] + os.sep) or d in os.environ['PATH'].split(os.pathsep)); "
                         "sys.argv = ['dispatch.py', 'onboard', 'unconnected', '--json']; runpy.run_path(%r, run_name='__main__')"
                         % os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dispatch.py'))
            env['PYTHONPATH'] = os.path.dirname(os.path.abspath(__file__)) + os.pathsep + os.environ.get('PYTHONPATH', '')
            run = lambda: json.loads(subprocess.run([sys.executable, '-B', '-c', only_path],
                                                    capture_output=True, text=True, env=env, timeout=60).stdout)
            self.assertEqual([a['id'] for a in run()['agents']], ['opencode'])
            rules = Path(home) / '.config' / 'opencode' / 'AGENTS.md'
            rules.parent.mkdir(parents=True)
            rules.write_text(O.BLOCK_BEGIN + ' -->\nrules\n' + O.BLOCK_END + '\n')
            self.assertEqual(run()['agents'], [])


class SkillMountFailure(unittest.TestCase):
    """task-4xxj: the result page said only "Could not finish"; the step now says which skill, for which agent, and why."""

    def test_message_names_the_skill_the_agent_and_the_reason(self):
        import engines
        d = types.SimpleNamespace(AGENT_SKILL_DIRS={"opencode": []}, POOL="/nonexistent")
        w = types.SimpleNamespace(BUILTIN_SKILLS=("task-board", "computer-use"), link_builtin_skills=lambda pool: None, bundled_cli=lambda: "dispatch.py")
        runs = lambda argv, timeout, env: (0, "", "") if "task-board" in argv else (1, "", "Traceback…\nno skill named computer-use in the pool\n")
        with patch.object(O, '_mods', lambda: d), patch.object(O, 'D', d), patch.object(O, 'W', w, create=True), patch.object(O, 'E', engines), \
                patch.object(O, '_run', runs), patch.object(O, 'log_add', lambda *a, **k: None):
            r = O.apply_skills(["opencode"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["message"], "Could not add computer-use for OpenCode: no skill named computer-use in the pool")
        # the same reason for several skills is said once
        runs = lambda argv, timeout, env: (1, "", "FileExistsError: [Errno 17] File exists: '/x/skills'\n")
        with patch.object(O, '_mods', lambda: d), patch.object(O, 'D', d), patch.object(O, 'W', w, create=True), patch.object(O, 'E', engines), \
                patch.object(O, '_run', runs), patch.object(O, 'log_add', lambda *a, **k: None):
            r = O.apply_skills(["opencode"])
        self.assertEqual(r["message"], "Could not add task-board and computer-use for OpenCode: FileExistsError: [Errno 17] File exists: '/x/skills'")
