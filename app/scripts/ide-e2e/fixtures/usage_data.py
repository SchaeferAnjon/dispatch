"""Made-up usage for the Usage page (scenarios/usage-page.mjs declares it: meta.instance.fixture "usage-data"), shaped like
a busy person's month: three Claude accounts (one in use, one at its weekly limit, one whose readings were never
named), Codex whose last session reported no limits, the GLM Coding Plan and a DeepSeek balance; sixty days of Claude
Code, Codex, Pi and OpenCode sessions in three projects with sub-agents, MCP tools that fail, skills, hooks and slash
commands; MCP servers offered and never called; a skill and a sub-agent installed and never used.

Everything lives in the instance's own folder: a HOME of its own (<instance>/usage-home: ~/.claude, ~/.codex, ~/.pi,
OpenCode's database), the instance's Dispatch data (quota readings, OpenCode's service answers, the Tab completion
ledger) and Dispatch home (the saved accounts, without any login: only names, plans and usage numbers). No value here
is a real key or token; the page never asks a server in a test instance (usage.py build)."""
import base64
import json
import os
import random
import sqlite3
import subprocess
import time
from datetime import datetime, timezone

import accounts as A

PROJECTS = ("kanban", "harbor", "ALG")
DAY = 86400
WEEK = 7 * DAY


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def line(**d):
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return path


def flat(cwd):
    return "".join(c if c.isalnum() else "-" for c in cwd)


def usage(rnd, model):
    big = model.startswith("claude-opus") or model.startswith("claude-fable")
    return {"input_tokens": rnd.randint(2, 40), "output_tokens": rnd.randint(200, 4000),
            "cache_read_input_tokens": rnd.randint(150_000, 900_000) if big else rnd.randint(20_000, 200_000),
            "cache_creation_input_tokens": rnd.randint(2000, 30000),
            "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": rnd.randint(2000, 30000)}}


def claude_session(rnd, home, cwd, sid, t0, turns, title, mcp_fail=0.0, subagents=0):
    """One Claude Code session: answers with usage and tool calls, their results, hooks, the MCP tools it was offered."""
    lines, t = [], t0
    model = rnd.choice(("claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"))
    lines.append(line(type="attachment", timestamp=iso(t), cwd=cwd, sessionId=sid, attachment={"type": "deferred_tools_delta", "addedNames": [
        "WebFetch", "mcp__harbor__add_tasks", "mcp__harbor__list_pending_tasks", "mcp__claude_ai_Claude_Docs__batch", "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__get_page_text", "mcp__plugin_playwright_playwright__browser_click",
        "mcp__plugin_sales_apollo__authenticate", "mcp__plugin_sales_apollo__complete_authentication"]}))
    lines.append(line(type="attachment", timestamp=iso(t), cwd=cwd, attachment={"type": "hook_success", "hookEvent": "SessionStart", "hookName": "SessionStart:startup",
                                                                               "exitCode": 0, "command": '"$HOME/.local/bin/dispatch" prime --hook-json'}))
    lines.append(line(type="user", timestamp=iso(t), cwd=cwd, sessionId=sid, message={"role": "user", "content": title}))
    if rnd.random() < 0.3:
        lines.append(line(type="user", timestamp=iso(t), cwd=cwd, sessionId=sid, message={"role": "user", "content": "<command-name>/%s</command-name>" % rnd.choice(("model", "login", "clear", "effort"))}))
    n = 0
    for i in range(turns):
        t += rnd.randint(30, 400)
        n += 1
        tid = "toolu_%s_%d" % (sid[:8], n)
        r = rnd.random()
        if r < 0.55:
            name, inp = "Bash", {"command": "ls"}
        elif r < 0.7:
            name, inp = rnd.choice(("Read", "Edit", "Write")), {"file_path": cwd + "/x"}
        elif r < 0.82:
            name, inp = rnd.choice(("mcp__claude-in-chrome__computer", "mcp__claude-in-chrome__get_page_text", "mcp__plugin_playwright_playwright__browser_click")), {}
        elif r < 0.92:
            name, inp = "Skill", {"skill": rnd.choice(("designer", "delivery-page", "task-board"))}
        else:
            name, inp = "Agent", {"subagent_type": rnd.choice(("opus-high", "designer", "general-purpose"))}
        lines.append(line(type="assistant", timestamp=iso(t), cwd=cwd, sessionId=sid, requestId="req_%s_%d" % (sid[:8], n),
                          message={"model": model, "usage": usage(rnd, model), "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}))
        failed = (name.startswith("mcp__claude-in-chrome") and rnd.random() < mcp_fail) or (name == "Bash" and rnd.random() < 0.03)
        lines.append(line(type="user", timestamp=iso(t + 2), cwd=cwd, sessionId=sid, message={"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tid, "content": "failed" if failed else "ok", **({"is_error": True} if failed else {})}]}))
        if name == "Bash":
            lines.append(line(type="attachment", timestamp=iso(t + 3), cwd=cwd, attachment={
                "type": "hook_success", "hookEvent": "PostToolUse", "hookName": "PostToolUse:Bash", "exitCode": 0,
                "command": "/usr/bin/python3 /opt/dispatch/cli/dispatch.py handoff hook --agent claude-code # dispatch-life"}))
    lines.append(line(type="system", subtype="stop_hook_summary", timestamp=iso(t + 5), hookInfos=[{"command": "node /opt/hooks/cc-status-hook.js"}],
                      hookErrors=["node /opt/hooks/cc-status-hook.js: exit 1"] if rnd.random() < 0.5 else []))
    folder = os.path.join(home, ".claude", "projects", flat(cwd))
    path = write(os.path.join(folder, sid + ".jsonl"), lines)
    os.utime(path, (t, t))
    for k in range(subagents):
        st = t0 + 60 * (k + 1)
        sub = [line(type="assistant", timestamp=iso(st), cwd=cwd, sessionId=sid, isSidechain=True, requestId="req_sub_%s_%d" % (sid[:8], k),
                    message={"model": "claude-opus-5-5", "usage": usage(rnd, "claude-opus-5-5"), "content": [{"type": "text", "text": "done"}]})]
        p = write(os.path.join(folder, sid, "subagents", "agent-a%04d.jsonl" % k), sub)
        os.utime(p, (st, st))
    return path


def codex_session(home, cwd, t0, readings, sid, skill=True):
    lines = [line(timestamp=iso(t0), type="session_meta", payload={"id": sid, "cwd": cwd, "originator": "codex_cli_rs"}),
             line(timestamp=iso(t0), type="turn_context", payload={"model": "gpt-6", "cwd": cwd})]
    total = [0, 0, 0]
    for i, (dt, week) in enumerate(readings):
        total = [total[0] + 60_000, total[1] + 45_000, total[2] + 2_000]
        payload = {"type": "token_count", "info": {"total_token_usage": {"input_tokens": total[0], "cached_input_tokens": total[1], "output_tokens": total[2]}}}
        if week is not None:
            payload["rate_limits"] = {"secondary": {"used_percent": week, "window_minutes": 10080}}
        lines.append(line(timestamp=iso(t0 + dt), type="response_item", payload={"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Carry on"}]}))
        lines.append(line(timestamp=iso(t0 + dt), type="response_item", payload={"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done"}]}))
        lines.append(line(timestamp=iso(t0 + dt), type="event_msg", payload=payload))
        lines.append(line(timestamp=iso(t0 + dt), type="response_item", payload={"type": "function_call", "name": "exec_command",
                                                                                 "arguments": json.dumps({"cmd": "cat ~/.agents/skills/task-board/SKILL.md" if skill and i == 0 else "git status"})}))
    d = datetime.fromtimestamp(t0)
    path = write(os.path.join(home, ".codex", "sessions", d.strftime("%Y/%m/%d"), "rollout-%s-%s.jsonl" % (d.strftime("%Y-%m-%dT%H-%M-%S"), sid)), lines)
    end = t0 + (readings[-1][0] if readings else 0)
    os.utime(path, (end, end))


def pi_session(home, cwd, t0, sid, calls):
    lines = [line(type="session", version=3, id=sid, timestamp=iso(t0), cwd=cwd)]
    for i in range(calls):
        t = t0 + i * 60
        lines.append(line(type="message", timestamp=iso(t), message={"role": "assistant", "provider": "deepseek", "model": "deepseek-v4.1-flash",
                                                                     "usage": {"input": 4000, "output": 300, "cacheRead": 12000, "cacheWrite": 0, "cost": {"total": 0.0021}},
                                                                     "content": [{"type": "toolCall", "id": "c%d" % i, "name": "bash", "arguments": {}}]}))
        lines.append(line(type="message", timestamp=iso(t + 1), message={"role": "toolResult", "toolCallId": "c%d" % i, "toolName": "bash", "isError": i % 7 == 3, "content": []}))
    d = datetime.fromtimestamp(t0)
    path = write(os.path.join(home, ".pi", "agent", "sessions", "-" + flat(cwd) + "--", "%s_%s.jsonl" % (d.strftime("%Y-%m-%dT%H-%M-%S-000Z"), sid)), lines)
    os.utime(path, (t0 + calls * 60, t0 + calls * 60))


def opencode_db(home, cwd, now):
    path = os.path.join(home, ".local", "share", "opencode", "opencode.db")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript("""
        create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null,
                              title text not null, version text not null, time_created integer not null, time_updated integer not null);
        create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
        create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null,
                           time_updated integer not null, data text not null);
    """)
    for s in range(6):
        sid = "ses_usage_%02d" % s
        t = int((now - (s * 4 + 1) * DAY) * 1000)
        con.execute("insert into session values (?,?,?,?,?,?,?,?,?)", (sid, "p1", None, sid, cwd, "Tidy the reading list %d" % s, "1", t, t + 600_000))
        for m in range(12):
            mt = t + m * 30_000
            data = {"role": "assistant", "modelID": "deepseek-v4.1-flash", "providerID": "deepseek", "cost": 0.0042,
                    "tokens": {"input": 5000, "output": 400, "reasoning": 100, "cache": {"read": 20000, "write": 0}}, "time": {"created": mt}}
            con.execute("insert into message values (?,?,?,?,?)", ("msg_%d_%d" % (s, m), sid, mt, mt, json.dumps(data)))
            part = {"type": "tool", "tool": "bash" if m % 3 else "read", "state": {"status": "error" if m == 5 else "completed"}}
            con.execute("insert into part values (?,?,?,?,?,?)", ("prt_%d_%d" % (s, m), "msg_%d_%d" % (s, m), sid, mt, mt, json.dumps(part)))
    con.commit()
    con.close()


def jwt(payload):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return "%s.%s.fake" % (enc({"alg": "none"}), enc(payload))


def reading(at, week, five, reset, account=None):
    r = {"agent": "claude-code", "at": round(at, 1), "plan": "", "weekly": {"used": week, "resets_at": reset}}
    if five is not None:
        r["session"] = {"used": five, "resets_at": at + 3 * 3600}
    if account:
        r["account"] = account
    return r


def next_at(anchor, now):
    r = anchor
    while r <= now:
        r += WEEK
    return r


def prepare(rec):
    rnd = random.Random(7)
    now = time.time()
    root = rec["root"]
    home = os.path.join(root, "usage-home")
    places = os.path.join(root, "places", "Projects")
    cwds = {}
    for p in PROJECTS:
        cwds[p] = os.path.join(places, p)
        os.makedirs(cwds[p], exist_ok=True)
        subprocess.run(["git", "init", "-q"], cwd=cwds[p], check=True, timeout=30)

    # ---- Claude Code: sixty days, most of them in kanban, the costliest three with many sub-agents
    titles = ["Usage page, all on one page", "Fix the session list storm", "Lecture notes for ALG", "Harbor task import",
              "Release 0.9.3", "Design rules and delivery pages", "Dark theme contrast", "Tidy the board", "Phone pairing"]
    sessions = 0
    for d in range(60, -1, -1):
        if rnd.random() < 0.35 and d > 2:
            continue
        for k in range(rnd.choice((1, 1, 2, 3))):
            proj = rnd.choice(("kanban", "kanban", "kanban", "harbor", "ALG"))
            t0 = now - d * DAY - rnd.randint(1, 10) * 3600
            big = sessions % 11 == 0
            claude_session(rnd, home, cwds[proj], "%08x-1111-4111-8111-%012x" % (sessions, sessions), t0, rnd.randint(40, 160) if big else rnd.randint(6, 40),
                           rnd.choice(titles), mcp_fail=0.18, subagents=rnd.randint(8, 30) if big else 0)
            sessions += 1

    # ---- Codex: a week of readings, a quiet week, two more; the last session reported none
    codex_session(home, cwds["kanban"], now - 13 * DAY, [(h * 3600, min(100, 10 + h * 3)) for h in range(0, 30, 2)], "01a0e004-fa97-7150-a46a-0e4622765930")
    codex_session(home, cwds["kanban"], now - 4 * DAY, [(0, 1.0), (3600, 2.0)], "01a0e004-fa97-7150-a46a-0e4622765931")
    codex_session(home, cwds["harbor"], now - 1 * DAY, [(0, None), (1800, None)], "01a0e004-fa97-7150-a46a-0e4622765932", skill=False)
    for d in (20, 9, 6, 3):
        codex_session(home, cwds[rnd.choice(PROJECTS)], now - d * DAY, [(0, None)], "01a0e004-fa97-7150-a46a-0e46227659%02d" % d, skill=False)

    # ---- Pi and OpenCode: DeepSeek billed per call
    for i, d in enumerate((25, 12, 5, 2)):
        pi_session(home, cwds["ALG"], now - d * DAY, "01a09812-0ea8-7798-985b-6fcebfd755%02d" % i, 30 + i * 10)
    opencode_db(home, cwds["harbor"], now)

    # ---- the accounts: names, plans and usage numbers only
    dhome = rec["dispatch_home"]
    anchors = {"one": now + 2 * DAY + 5 * 3600, "two": now + 3 * DAY - 2 * 3600, "three": now - 6 * 3600}
    emails = {"one": "sam.rivera@example.com", "two": "sam.work@example.com", "three": "sam.lab@example.com"}
    tiers = {"one": "default_claude_max_20x", "two": "default_claude_max_5x", "three": "default_claude_max_20x"}
    st = {"version": 1, "accounts": [], "last_written": {}}
    for k in ("one", "two"):
        oa = {"accountUuid": "uuid-" + k, "emailAddress": emails[k], "organizationUuid": "org-" + k, "organizationRateLimitTier": tiers[k]}
        ident = A.claude_identity_from_oauth_account(oa)
        st["accounts"].append({"id": "claude-fake%s" % k, "engine": "claude", "key": A.identity_key(ident), "label": "", "added_at": now - 30 * DAY,
                               "email": emails[k], "plan": "max", "oauth_account": oa, "needs_signin": False})
    os.makedirs(os.path.join(dhome, "accounts", "usage"), exist_ok=True)
    with open(os.path.join(dhome, "accounts", "accounts.json"), "w") as f:
        json.dump(st, f, indent=1)
    with open(os.path.join(dhome, "accounts", "usage", "claude-faketwo.json"), "w") as f:
        json.dump({"at": now - 20 * 60, "windows": [{"kind": "session", "used_percent": 0.0, "resets_at": None},
                                                     {"kind": "weekly", "used_percent": 100.0, "resets_at": next_at(anchors["two"], now)}]}, f)
    # the account in use, where Claude Code names it: ~/.claude.json, or .claude.json in CLAUDE_CONFIG_DIR (the instance sets one)
    for where in (os.path.join(home, ".claude.json"), os.path.join(home, ".claude", ".claude.json")):
        os.makedirs(os.path.dirname(where), exist_ok=True)
        with open(where, "w") as f:
            json.dump({"oauthAccount": {"accountUuid": "uuid-one", "emailAddress": emails["one"], "organizationUuid": "org-one",
                                        "organizationRateLimitTier": tiers["one"]}}, f)
    os.makedirs(os.path.join(home, ".codex"), exist_ok=True)
    with open(os.path.join(home, ".codex", "auth.json"), "w") as f:
        json.dump({"tokens": {"id_token": jwt({"email": "sam.rivera@example.com", "https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_user_id": "u1"}}),
                              "access_token": "fake", "account_id": "ws1"}}, f)

    # ---- fourteen days of Claude readings: account one named from yesterday on, the others never named
    hist = []
    for h in range(0, 14 * 24, 2):
        at = now - 14 * DAY + h * 3600
        if now - 9 * DAY < at < now - 5 * DAY:
            continue  # the window was closed: nothing read for four days
        for k in ("one", "two", "three"):
            if (k == "two" and at < now - 8 * DAY) or (k == "three" and not (now - 12 * DAY < at < now - 10 * DAY)):
                continue
            last_reset = anchors[k] - WEEK * ((anchors[k] - at) // WEEK + (1 if anchors[k] > at else 0))
            reset = last_reset + WEEK
            week = min(100.0, round((at - last_reset) / WEEK * (130 if k == "two" else 80), 1))
            hist.append(reading(at, week, round(rnd.uniform(5, 100), 0), reset, emails[k] if k == "one" and at > now - DAY else None))
    usage_dir = os.path.join(rec["dispatch_dir"], "usage")
    os.makedirs(usage_dir, exist_ok=True)
    with open(os.path.join(usage_dir, "quota.jsonl"), "w") as f:
        for r in sorted(hist, key=lambda r: r["at"]):
            f.write(json.dumps(r) + "\n")

    # ---- OpenCode's services and the Tab completion ledger
    with open(os.path.join(rec["dispatch_dir"], "opencode-quota.json"), "w") as f:
        json.dump({"zhipuai-coding-plan": {"at": now - 600, "rows": [
            {"kind": "window", "label": "5-hour", "used_percent": 12, "resets_at": now + 3 * 3600, "plan": "lite"},
            {"kind": "window", "label": "weekly", "used_percent": 84, "resets_at": now + 2 * DAY, "plan": "lite"}]},
            "deepseek": {"at": now - 600, "rows": [{"kind": "balance", "label": "Balance", "amount": 26.59, "currency": "CNY"}]}}, f)
    os.makedirs(os.path.join(rec["dispatch_dir"], "ide"), exist_ok=True)
    with open(os.path.join(rec["dispatch_dir"], "ide", "tab-usage-days.json"), "w") as f:
        json.dump({datetime.fromtimestamp(now - d * DAY).strftime("%Y-%m-%d"): {"count": 20, "usd": 0.0012} for d in range(0, 20, 3)}, f)

    # ---- installed and never used: a skill and a sub-agent
    for s in ("designer", "delivery-page", "task-board", "teaching-master", "getnote"):
        os.makedirs(os.path.join(dhome, "skills", s), exist_ok=True)
        with open(os.path.join(dhome, "skills", s, "SKILL.md"), "w") as f:
            f.write("---\nname: %s\ndescription: made up for the e2e test\n---\n" % s)
    os.makedirs(os.path.join(dhome, "agents"), exist_ok=True)
    for a in ("opus-high", "designer", "sonnet-max"):
        with open(os.path.join(dhome, "agents", a + ".md"), "w") as f:
            f.write("---\nname: %s\ndescription: made up\n---\nDo the work.\n" % a)

    env = {"HOME": home, "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"), "CODEX_HOME": os.path.join(home, ".codex"), "XDG_DATA_HOME": os.path.join(home, ".local", "share"),
           "DISPATCH_SKILL_POOL": os.path.join(dhome, "skills")}
    return {"env": env, "record": {"usage_data": {"home": home, "sessions": sessions, "emails": emails, "places": places}}}
