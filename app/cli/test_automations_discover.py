# -*- coding: utf-8 -*-
"""`dispatch automations discover`: other tools' scheduled jobs, read-only. Everything lives in a temporary HOME."""
import datetime as dt
import hashlib
import json
import os
import plistlib
import sqlite3
import stat
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import automations_discover as A


def write(path, text, mode="w"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        f.write(text)
    return path


def at(y, mo, d, h, mi):
    return time.mktime(dt.datetime(y, mo, d, h, mi).timetuple())


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        env = {"HOME": self.tmp, "HERMES_HOME": "", "CODEX_HOME": "", "OPENCLAW_STATE_DIR": ""}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)

    def h(self, *parts):
        return os.path.join(self.tmp, *parts)


class Schedules(unittest.TestCase):
    def test_common_cron_lines_in_plain_words(self):
        self.assertEqual(A.say_cron("0 9 * * *"), "Every day at 9:00 AM")
        self.assertEqual(A.say_cron("30 18 * * 1-5"), "Weekdays at 6:30 PM")
        self.assertEqual(A.say_cron("0 21 * * 0"), "Every Sunday at 9:00 PM")
        self.assertEqual(A.say_cron("0 9,18 * * *"), "Every day at 9:00 AM and 6:00 PM")
        self.assertEqual(A.say_cron("*/15 * * * *"), "Every 15 minutes")
        self.assertEqual(A.say_cron("5 * * * *"), "Every hour at :05")
        self.assertEqual(A.say_cron("0 */2 * * *"), "Every 2 hours")
        self.assertEqual(A.say_cron("0 3 1 * *"), "Monthly on the 1st at 3:00 AM")
        self.assertEqual(A.say_cron("@daily"), "Every day at 12:00 AM")
        self.assertEqual(A.say_cron("not a cron"), "Custom schedule (not a cron)")

    def test_next_run_is_the_next_matching_minute_in_local_time(self):
        now = at(2026, 10, 1, 20, 30)  # a Thursday
        self.assertEqual(A.next_cron("0 9 * * *", now), at(2026, 10, 2, 9, 0))
        self.assertEqual(A.next_cron("45 20 * * *", now), at(2026, 10, 1, 20, 45))
        self.assertEqual(A.next_cron("0 9 * * 1", now), at(2026, 10, 5, 9, 0))      # next Monday
        self.assertEqual(A.next_cron("0 0 1 1 *", now), at(2027, 1, 1, 0, 0))
        self.assertIsNone(A.next_cron("0 0 31 2 *", now))                           # never
        self.assertIsNone(A.next_cron("rubbish", now))

    def test_codex_rrules_and_intervals(self):
        self.assertEqual(A.rrule_cron("FREQ=HOURLY;INTERVAL=24;BYMINUTE=0")[1], "Every day")
        self.assertEqual(A.rrule_cron("FREQ=DAILY;BYHOUR=9;BYMINUTE=0"), ("0 9 * * *", "Every day at 9:00 AM"))
        self.assertEqual(A.rrule_cron("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30")[1], "Weekdays at 8:30 AM")
        self.assertEqual(A.say_every(1800), "Every 30 minutes")
        self.assertEqual(A.say_every(7200), "Every 2 hours")
        self.assertEqual(A.launchd_cron({"Hour": 3, "Minute": 0}), ["0 3 * * *"])
        self.assertEqual(A.launchd_cron([{"Weekday": 1, "Hour": 9, "Minute": 15}]), ["15 9 * * 1"])

    def test_a_leading_it_is_now_only_sets_the_scene(self):
        self.assertEqual(A.does("现在是早上 9:00。请为用户生成「昨日回声」。然后发给他。"), "请为用户生成「昨日回声」。")
        self.assertEqual(A.does("It is now 7 AM. Summarize my inbox (see v1.2). Be short."), "Summarize my inbox (see v1.2).")
        self.assertEqual(A.does("Write to /Users/x/a.md. Then commit."), "Write to /Users/x/a.md.")
        self.assertEqual(A.say_cron("30 9-18 * * 1-5"), "Every hour at :30 from 9:30 AM to 6:30 PM on weekdays")

    def test_what_it_does_is_the_first_sentence_without_markdown(self):
        self.assertEqual(A.does("# Daily\n\nSummarize **yesterday's** commits. Then post them."), "Daily Summarize yesterday's commits.")
        self.assertEqual(A.does("", "fallback"), "fallback")
        self.assertEqual(A.plain("```bash\nrm -rf\n```\nDone [link](http://x)"), "Done link")


def hermes_fixture(t):
    cron = t.h(".hermes", "cron")
    write(os.path.join(cron, "jobs.json"), json.dumps({"jobs": [
        {"id": "a1b2", "name": "Morning brief", "prompt": "Read my inbox and write a short brief. Keep it under 200 words.",
         "schedule": {"kind": "cron", "expr": "0 8 * * *", "display": "0 8 * * *"}, "enabled": True, "state": "scheduled",
         "next_run_at": "2026-10-02T08:00:00+02:00", "last_run_at": "2026-10-01T08:00:03+02:00", "last_status": "ok"},
        {"id": "c3d4", "prompt": "", "skills": ["arxiv"], "schedule": {"kind": "interval", "minutes": 90},
         "enabled": False, "state": "paused"},
    ]}))
    write(os.path.join(cron, "output", "a1b2", "2026-10-01_08-00-03.md"),
          "# Cron Job: Morning brief\n\n## Prompt\n\nRead my inbox\n\n## Response\n\nThree mails need you today.\n")
    write(os.path.join(cron, "output", "a1b2", "2026-09-30_08-00-01.md"),
          "# Cron Job: Morning brief (FAILED)\n\n## Error\n\n```\nRateLimitError: slow down\n```\n")
    con = sqlite3.connect(os.path.join(cron, "executions.db"))
    con.execute("CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER, process_started_at INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT, error TEXT)")
    con.execute("INSERT INTO executions VALUES ('e1','a1b2','tick','p',1,0,'completed','2026-10-01T08:00:03','2026-10-01T08:00:03','2026-10-01T08:01:00',NULL)")
    con.execute("INSERT INTO executions VALUES ('e2','a1b2','tick','p',1,0,'failed','2026-09-29T08:00:00','2026-09-29T08:00:00',NULL,'boom')")
    con.commit()
    con.close()


class Hermes(Home):
    def setUp(self):
        super().setUp()
        hermes_fixture(self)

    def test_jobs_schedule_next_run_and_runs_with_output(self):
        src, jobs = A.hermes()
        self.assertTrue(src["found"])
        self.assertIsNone(src["error"])
        self.assertEqual([j["name"] for j in jobs], ["Morning brief", "c3d4"])
        brief = jobs[0]
        self.assertEqual(brief["schedule"], "Every day at 8:00 AM")
        self.assertEqual(brief["does"], "Read my inbox and write a short brief.")
        self.assertEqual(brief["next_run"], dt.datetime.fromisoformat("2026-10-02T08:00:00+02:00").timestamp())
        self.assertEqual(brief["last_status"], "ok")
        self.assertEqual(brief["agent"], "hermes")
        self.assertEqual([r["status"] for r in brief["runs"]], ["ok", "failed", "failed"])  # two files, plus the db run with no file
        self.assertEqual(brief["runs"][0]["preview"], "Three mails need you today.")
        self.assertEqual(brief["runs"][0]["output"], "Three mails need you today.")  # the answer, not the prompt or its heading
        self.assertNotIn("Read my inbox", brief["runs"][0]["output"])
        self.assertTrue(brief["runs"][0]["path"].endswith("2026-10-01_08-00-03.md"))
        self.assertEqual(brief["runs"][1]["error"], "RateLimitError: slow down")
        self.assertEqual(brief["runs"][2]["error"], "boom")
        self.assertEqual(brief["manage"], "To change or stop it, open Hermes.")

    def test_paused_job_has_no_next_run_and_says_what_it_uses(self):
        paused = A.hermes()[1][1]
        self.assertFalse(paused["enabled"])
        self.assertIsNone(paused["next_run"])
        self.assertEqual(paused["schedule"], "Every 90 minutes")
        self.assertEqual(paused["does"], "Uses the skills arxiv")

    def test_hermes_home_moves_with_the_variable_and_a_broken_file_is_an_error_not_a_crash(self):
        other = self.h("elsewhere")
        write(os.path.join(other, "cron", "jobs.json"), "{not json")
        with mock.patch.dict(os.environ, {"HERMES_HOME": other}):
            src, jobs = A.hermes()
        self.assertEqual(jobs, [])
        self.assertIn("Could not read", src["error"])

    def test_a_flat_list_also_reads(self):
        write(self.h(".hermes", "cron", "jobs.json"), json.dumps([{"id": "z9", "prompt": "Hi there, check the weather.", "schedule": "every 2h"}]))
        jobs = A.hermes()[1]
        self.assertEqual(jobs[0]["schedule"], "Every 2 hours")


class OpenClaw(Home):
    def test_jobs_state_and_run_log(self):
        base = self.h(".openclaw", "cron")
        write(os.path.join(base, "jobs.json"), json.dumps({"version": 1, "jobs": [
            {"id": "j1", "name": "Standup", "enabled": True, "schedule": {"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Europe/Berlin"},
             "payload": {"kind": "agentTurn", "message": "Post the standup notes to the team chat."},
             "state": {"nextRunAtMs": 1790000000000, "lastRunAtMs": 1789900000000, "lastStatus": "error", "lastError": "no channel"}},
            {"id": "j2", "enabled": False, "schedule": {"kind": "every", "everyMs": 3600000}, "payload": {"text": "ping"}, "state": {}},
        ]}))
        write(os.path.join(base, "runs", "j1.jsonl"),
              json.dumps({"ts": 1789900005000, "jobId": "j1", "action": "finished", "status": "error", "error": "no channel", "runAtMs": 1789900000000}) + "\n"
              + json.dumps({"ts": 1789800005000, "jobId": "j1", "action": "finished", "status": "ok", "summary": "Posted.", "runAtMs": 1789800000000}) + "\n"
              + "garbage\n")
        src, jobs = A.openclaw()
        self.assertTrue(src["found"])
        j1, j2 = jobs
        self.assertEqual(j1["schedule"], "Weekdays at 9:00 AM (Europe/Berlin)")
        self.assertEqual(j1["next_run"], 1790000000.0)
        self.assertEqual(j1["last_status"], "failed")
        self.assertEqual(j1["last_error"], "no channel")
        self.assertEqual([r["status"] for r in j1["runs"]], ["failed", "ok"])
        self.assertEqual(j1["runs"][1]["output"], "Posted.")
        self.assertFalse(j2["enabled"])
        self.assertEqual(j2["schedule"], "Every hour")
        self.assertEqual(j2["name"], "ping")


class Codex(Home):
    def test_automations_and_their_runs_from_the_codex_app_database(self):
        db = self.h(".codex", "sqlite", "codex-dev.db")
        os.makedirs(os.path.dirname(db))
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
        con.execute("CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at INTEGER, thread_title TEXT, source_cwd TEXT, inbox_title TEXT, inbox_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_user_message TEXT, archived_assistant_message TEXT, archived_reason TEXT)")
        con.execute("INSERT INTO automations VALUES ('au1','Find bugs','Look for bugs in yesterday''s commits. Report them.','ACTIVE',1790000000000,1789900000000,'[\"/x/repo\"]','FREQ=DAILY;BYHOUR=7;BYMINUTE=0',1,2)")
        con.execute("INSERT INTO automations VALUES ('au2','Old','Nothing.','PAUSED',NULL,NULL,'[]','FREQ=WEEKLY',1,1)")
        con.execute("INSERT INTO automation_runs VALUES ('t1','au1','ACCEPTED',NULL,'Bugs','/x/repo','2 bugs found','Two off-by-one bugs in parser.py',1789900000000,1,NULL,NULL,NULL)")
        con.commit()
        con.close()
        src, jobs = A.codex()
        self.assertTrue(src["found"])
        au1, au2 = sorted(jobs, key=lambda j: j["name"])[0], sorted(jobs, key=lambda j: j["name"])[1]
        self.assertEqual(au1["schedule"], "Every day at 7:00 AM")
        self.assertEqual(au1["next_run"], 1790000000.0)
        self.assertEqual(au1["workdir"], "/x/repo")
        self.assertEqual(au1["runs"][0]["status"], "ok")
        self.assertEqual(au1["runs"][0]["title"], "2 bugs found")
        self.assertEqual(au1["runs"][0]["preview"], "Two off-by-one bugs in parser.py")
        self.assertFalse(au2["enabled"])
        self.assertIsNone(au2["next_run"])

    def test_no_codex_app_means_nothing_found(self):
        src, jobs = A.codex()
        self.assertFalse(src["found"])
        self.assertEqual(jobs, [])


class Claude(Home):
    def test_desktop_scheduled_tasks_with_their_runs(self):
        write(self.h("Documents", "Claude", "Scheduled", "nightly", "SKILL.md"),
              "---\nname: nightly\ndescription: Check my tools every night\n---\n\nYou are doing a nightly audit.\n")
        write(self.h(".claude", "scheduled-tasks", "old-one", "SKILL.md"), "---\nname: old-one\n---\nSummarize Plane tasks. Then stop.\n")
        sess = self.h("Library", "Application Support", "Claude", "local-agent-mode-sessions", "u", "o")
        write(os.path.join(sess, "local_1.json"), json.dumps({"scheduledTaskId": "nightly", "createdAt": 1789900000000, "lastActivityAt": 1789900060000, "title": "Tool audit"}))
        write(os.path.join(sess, "local_2.json"), json.dumps({"createdAt": 1789900000000, "title": "not scheduled"}))
        src, jobs = A.claude_desktop()
        self.assertTrue(src["found"])
        by = {j["name"]: j for j in jobs}
        self.assertEqual(by["nightly"]["does"], "Check my tools every night")
        self.assertEqual(by["nightly"]["schedule"], "Set in the Claude app")
        self.assertEqual(by["nightly"]["run_count"], 1)
        self.assertEqual(by["nightly"]["last_run"], 1789900000.0)
        self.assertEqual(by["nightly"]["runs"][0]["title"], "Tool audit")
        self.assertEqual(by["old-one"]["does"], "Summarize Plane tasks.")
        self.assertEqual(by["old-one"]["agent"], "claude")

    def test_claude_code_saved_loops_in_project_folders(self):
        write(self.h("Projects", "app", ".claude", "scheduled_tasks.json"),
              json.dumps({"tasks": [{"id": "x1", "cron": "*/30 * * * *", "prompt": "Check the deploy and tell me if it failed.", "recurring": True}]}))
        src, jobs = A.claude_code()
        self.assertTrue(src["found"])
        self.assertEqual(jobs[0]["schedule"], "Every 30 minutes")
        self.assertEqual(jobs[0]["workdir"], self.h("Projects", "app"))
        self.assertIsNotNone(jobs[0]["next_run"])
        self.assertIn("open", jobs[0]["note"])


class Launchd(Home):
    def plist(self, name, data, d=None):
        d = d or self.h("Library", "LaunchAgents")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name + ".plist"), "wb") as f:
            plistlib.dump(data, f)

    def test_only_scheduled_jobs_that_start_an_agent(self):
        log = write(self.h("logs", "nightly.log"), "starting\nall good: 3 files tidied\n")
        self.plist("com.me.nightly", {"Label": "com.me.nightly", "ProgramArguments": ["/opt/homebrew/bin/claude", "-p", "Tidy my Downloads folder. Be careful."],
                                      "StartCalendarInterval": {"Hour": 2, "Minute": 30}, "StandardOutPath": log})
        script = write(self.h("bin", "review.sh"), "#!/bin/sh\ncd ~/x && codex exec 'review the diff'\n")
        self.plist("com.me.review", {"Label": "com.me.review", "ProgramArguments": ["/bin/sh", script], "StartInterval": 3600})
        self.plist("com.me.gateway", {"Label": "com.me.gateway", "ProgramArguments": ["hermes", "gateway"], "KeepAlive": True, "RunAtLoad": True})
        self.plist("com.me.backup", {"Label": "com.me.backup", "ProgramArguments": ["/usr/bin/rsync", "-a"], "StartInterval": 60})
        self.plist("dev.dispatch.chatd", {"Label": "dev.dispatch.chatd", "ProgramArguments": ["claude"], "StartInterval": 60})
        src, jobs = A.launchd(status={"com.me.nightly": (None, 1)}, dirs=[self.h("Library", "LaunchAgents")])
        by = {j["id"]: j for j in jobs}
        self.assertEqual(sorted(by), ["launchd:com.me.nightly", "launchd:com.me.review"])
        n = by["launchd:com.me.nightly"]
        self.assertEqual(n["name"], "nightly")
        self.assertEqual(n["agent"], "claude")
        self.assertEqual(n["schedule"], "Every day at 2:30 AM")
        self.assertEqual(n["does"], "Tidy my Downloads folder.")
        self.assertIsNotNone(n["next_run"])
        self.assertEqual(n["last_status"], "failed")
        self.assertEqual(n["runs"][0]["preview"], "all good: 3 files tidied")
        r = by["launchd:com.me.review"]
        self.assertEqual(r["agent"], "codex")  # found inside the script it runs
        self.assertEqual(r["schedule"], "Every hour")
        self.assertTrue(r["does"].startswith("Starts Codex"))

    def test_a_cron_line_named_after_its_script_with_its_log_as_the_last_run(self):
        script = write(self.h("site", "summarize-rss.sh"), "#!/bin/sh\nclaude -p 'summarize the feeds'\n")
        log = write(self.h("logs", "rss.log"), "fetched 12 feeds\nwrote summary.md\n")
        src, jobs = A.crontab(f"0 7-22 * * * {script} >> {log} 2>&1\n")
        self.assertEqual(jobs[0]["name"], "summarize-rss")
        self.assertEqual(jobs[0]["agent"], "claude")
        self.assertEqual(jobs[0]["schedule"], "Every hour from 7:00 AM to 10:00 PM")
        self.assertEqual(jobs[0]["runs"][0]["preview"], "wrote summary.md")
        self.assertEqual(jobs[0]["last_run"], os.path.getmtime(log))

    def test_cron_lines_that_start_an_agent(self):
        src, jobs = A.crontab("MAILTO=\"\"\n# comment\n0 7 * * 1-5 cd ~/x && claude -p 'Summarize the open PRs.'\n*/5 * * * * /usr/bin/true\n@reboot claude\n")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["schedule"], "Weekdays at 7:00 AM")
        self.assertEqual(jobs[0]["does"], "Summarize the open PRs.")
        self.assertEqual(jobs[0]["agent"], "claude")


class ReadOnly(Home):
    def snapshot(self):
        out = {}
        for root, dirs, files in os.walk(self.tmp):
            for f in files:
                p = os.path.join(root, f)
                with open(p, "rb") as fh:
                    out[p] = (hashlib.sha1(fh.read()).hexdigest(), os.stat(p).st_mtime_ns)
        return out

    def test_discovery_changes_no_file_and_creates_none(self):
        hermes_fixture(self)
        db = self.h(".codex", "sqlite", "codex-dev.db")
        os.makedirs(os.path.dirname(db))
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT, next_run_at INTEGER, last_run_at INTEGER, cwds TEXT, rrule TEXT, created_at INTEGER, updated_at INTEGER)")
        con.commit()
        con.close()
        for root, dirs, files in os.walk(self.tmp):
            for f in files:
                os.chmod(os.path.join(root, f), stat.S_IRUSR)  # read-only: a write would raise
        before = self.snapshot()
        data = A.discover(launchctl=False, cron=False)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual({s["id"] for s in data["sources"]}, {"hermes", "openclaw", "codex", "claude", "claude-code", "launchd"})
        self.assertEqual(len([j for j in data["jobs"] if j["source"] == "hermes"]), 2)
        self.assertTrue(data["jobs"][0]["enabled"])  # enabled jobs first

    def test_one_broken_source_does_not_hide_the_others(self):
        with mock.patch.object(A, "openclaw", side_effect=RuntimeError("bad")):
            data = A.discover(launchctl=False, cron=False)
        errs = [s for s in data["sources"] if s.get("error")]
        self.assertEqual(len(errs), 1)
        self.assertIn("bad", errs[0]["error"])


class OtherMacs(Home):
    def setUp(self):
        super().setUp()
        self.remote = self.h("remote")
        bin_dir = self.h("fakebin")
        # a stand-in ssh: runs the remote command here, with the script on stdin, as the other Mac would
        write(os.path.join(bin_dir, "ssh"), '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
        os.chmod(os.path.join(bin_dir, "ssh"), 0o755)
        p = mock.patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", "")})
        p.start()
        self.addCleanup(p.stop)
        write(self.h(".hermes", "cron", "jobs.json"), json.dumps({"jobs": [{"id": "m1", "name": "Mini job", "prompt": "Back up notes.", "schedule": "0 4 * * *"}]}))

    def D(self, hosts):
        return types.SimpleNamespace(hosts=lambda: hosts, host_entry=lambda x: next((h for h in hosts if h["id"] == x), None),
                                     local_host_name=lambda: "This Mac", REMOTE_DIR=self.remote)

    def test_the_script_runs_on_the_other_mac_and_its_answer_is_cached(self):
        data, err = A.ask_mac({"id": "mini", "ssh": "me@mini"}, self.remote)
        self.assertIsNone(err)
        self.assertEqual(data["jobs"][0]["name"], "Mini job")
        self.assertTrue(os.path.exists(os.path.join(self.remote, "mini.automations.json")))
        with mock.patch.object(A.subprocess, "run", side_effect=AssertionError("asked again")):
            again, err = A.ask_mac({"id": "mini", "ssh": "me@mini"}, self.remote)
        self.assertEqual(again["jobs"][0]["name"], "Mini job")

    def test_an_unreachable_mac_is_remembered_for_a_minute(self):
        with mock.patch.object(A.subprocess, "run", return_value=types.SimpleNamespace(returncode=255, stdout="", stderr="no route")):
            data, err = A.ask_mac({"id": "off", "ssh": "me@off"}, self.remote)
        self.assertEqual(err, "unreachable")
        self.assertIsNone(data)
        with mock.patch.object(A.subprocess, "run", side_effect=AssertionError("asked again")):
            self.assertEqual(A.ask_mac({"id": "off", "ssh": "me@off"}, self.remote)[1], "unreachable")

    def test_command_tags_each_job_with_its_mac(self):
        args = types.SimpleNamespace(op="discover", remote=True, host="", fresh=True, json=True)
        D = self.D([{"id": "mini", "name": "Mac mini", "ssh": "me@mini"}, {"id": "off", "name": "Old Mac", "ssh": "me@off"}])
        os.makedirs(self.remote, exist_ok=True)
        open(os.path.join(self.remote, "off.down"), "w").close()  # it was off a moment ago
        from io import StringIO
        buf = StringIO()
        with mock.patch("sys.stdout", buf):
            self.assertEqual(A.command(args, D), 0)
        out = json.loads(buf.getvalue())
        machines = {m["id"]: m for m in out["machines"]}
        self.assertTrue(machines["mini"]["reachable"])
        self.assertFalse(machines["off"]["reachable"])
        job = next(j for j in out["jobs"] if j["name"] == "Mini job")
        self.assertEqual(job["host"], "mini")
        self.assertEqual(job["host_name"], "Mac mini")
        self.assertTrue(job["id"].startswith("mini/hermes:"))

    def test_the_other_macs_with_none_set_up_is_nothing_not_this_mac_again(self):
        args = types.SimpleNamespace(op="discover", remote=True, host="", fresh=False, json=True)
        from io import StringIO
        buf = StringIO()
        with mock.patch("sys.stdout", buf), mock.patch.object(A, "discover", side_effect=AssertionError("looked here")):
            A.command(args, self.D([]))
        self.assertEqual(json.loads(buf.getvalue()), {"machines": [], "sources": [], "jobs": []})

    def test_this_mac_by_default(self):
        args = types.SimpleNamespace(op="discover", remote=False, host="", fresh=False, json=True)
        from io import StringIO
        buf = StringIO()
        with mock.patch("sys.stdout", buf), mock.patch.object(A, "launchctl_status", return_value={}), \
                mock.patch.object(A, "crontab", return_value=({"id": "cron", "label": "cron", "found": False, "where": "crontab", "error": None}, [])):
            A.command(args, self.D([{"id": "mini", "name": "Mac mini", "ssh": "me@mini"}]))
        out = json.loads(buf.getvalue())
        self.assertEqual([m["id"] for m in out["machines"]], ["local"])
        self.assertEqual(out["jobs"][0]["host"], "local")


if __name__ == "__main__":
    unittest.main()
