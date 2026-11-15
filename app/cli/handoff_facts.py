# -*- coding: utf-8 -*-
"""Facts a handoff collects by machine, and the quality gate for what the agent writes.

The "自动采集" section is written by Dispatch at handoff time; the author cannot edit it
(an author-supplied section of that name is dropped). Collection has a 5 second budget
and every item degrades to "取不到：<原因>" instead of failing the handoff.

`problems()` is the gate `handoff write` applies to the agent's own words: a next step
is required, and completed items must carry evidence (commit, file path or a number).
"""
import json
import os
import re
import subprocess
import threading
import time
from lang import t as _t
from types import SimpleNamespace

BUDGET = 5.0            # seconds for the whole collection
GIT_TIMEOUT = 2
SECTION = "自动采集"
SECTION_EN = "Collected by Dispatch"
SECTIONS = (SECTION, SECTION_EN)


def section_head():
    return "## " + _t(SECTION_EN, SECTION)


SECTION_HEAD = "## " + SECTION
KNOWN_REPOS = ("~/Projects/kanban",)  # Dispatch IDE's source is in its ide/ since 2026-10-07
BLANK = {"", "无", "没有", "none", "n/a", "na", "tbd", "todo", "待定", "未记录", "未记录。", "-", "无。"}

ALIASES = {
    "goal": ("目标", "goal"),
    "completed": ("已完成与证据", "已完成", "做完了什么", "completed", "done", "completed, with evidence"),
    "next": ("下一步", "next", "next steps"),
}
LABELS = {"goal": "目标", "completed": "做完了什么", "next": "下一步"}
LABELS_EN = {"goal": "Goal", "completed": "Completed", "next": "Next"}
EVIDENCE = re.compile(r"\d|~?/[\w.\-]+|[\w.\-~]+/[\w.\-]+|\b[\w\-]+\.(?:py|ts|tsx|js|jsx|md|json|sh|swift|patch|log|txt|css|html|ya?ml|toml)\b"
                      r"|\b[0-9a-f]{7,40}\b")
EXAMPLE_EN = {
    "goal": "one sentence on what this task is to achieve",
    "completed": ["changed app/cli/handoff.py, commit a1b2c3d", "npm run test:py: 1829 tests passed"],
    "next": "cd app && npm test, then dispatch done <task> --reason \"...\"",
    "pitfalls": "pitfalls you hit, or none",
    "test_log": "/tmp/test.log (optional: the path of your latest test output)",
}
EXAMPLE = {
    "goal": "一句话写清这条任务要做成什么",
    "completed": ["改了 app/cli/handoff.py，提交 a1b2c3d", "npm run test:py 1829 项通过"],
    "next": "cd app && npm test，然后 dispatch done <任务> --reason \"...\"",
    "pitfalls": "踩过的坑，没有就写无",
    "test_log": "/tmp/test.log（可选，最近一次测试输出的路径）",
}


# ---------------------------------------------------------------- the quality gate
def _items(value):
    if isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        parts = [str(x) for x in value]
    else:
        parts = re.split(r"\n+", str(value or ""))
    out = []
    for p in parts:
        p = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", p).strip()
        if p.lower() not in BLANK:
            out.append(p)
    return out


def has_evidence(item):
    return bool(EVIDENCE.search(item))


def sections(markdown):
    """{heading: body} for the ## sections of a Markdown handoff."""
    found, name, buf = {}, None, []
    for line in str(markdown).splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            if name is not None:
                found[name] = "\n".join(buf).strip()
            name, buf = m.group(1).strip(), []
        elif name is not None:
            buf.append(line)
    if name is not None:
        found[name] = "\n".join(buf).strip()
    return found


def _pick(found, key):
    for heading, body in found.items():
        if heading.lower().strip("：: ") in ALIASES[key]:
            return body
    return None


def problems(content):
    """What is wrong with the agent's handoff, as short phrases. Empty list means accepted."""
    bad = []
    if isinstance(content, dict):
        if not _items(content.get("next")):
            bad.append(_t("next is missing or empty", "缺「下一步」（next）或它是空的"))
        done = _items(content.get("completed"))
        if done and not any(has_evidence(x) for x in done):
            bad.append(_t("no completed item has evidence (a commit hash, a file path or a test count)", "「做完了什么」（completed）没有一条带证据（提交号、文件路径或测试数字）"))
        return bad
    found = sections(content)
    goal, done, nxt = (_pick(found, k) for k in ("goal", "completed", "next"))
    for key, body in (("goal", goal), ("completed", done), ("next", nxt)):
        if body is None:
            bad.append(_t(f"the {LABELS_EN[key]} section is missing (start it with ## {LABELS_EN[key]})", f"缺「{LABELS[key]}」这一节（用 ## {ALIASES[key][0]} 开头）"))
    if nxt is not None and not _items(nxt):
        bad.append(_t("Next is empty", "「下一步」是空的"))
    if goal is not None and not _items(goal):
        bad.append(_t("Goal is empty", "「目标」是空的"))
    if done is not None:
        items = _items(done)
        if items and not any(has_evidence(x) for x in items):
            bad.append(_t("no Completed item has evidence (a commit hash, a file path or a test count)", "「做完了什么」没有一条带证据（提交号、文件路径或测试数字）"))
    return bad


def rejection(bad):
    example = json.dumps(_t(EXAMPLE_EN, EXAMPLE), ensure_ascii=False, indent=2)
    return _t("The handoff was refused: nothing was saved and the context is not cleared: " + "; ".join(bad) +
              ". Add what is missing and run the same command again, with JSON on stdin or Markdown with ## Goal / ## Completed / ## Next; "
              "a minimal valid JSON:\n" + example,
              "交接被拒收，没有保存，上下文不会清空：" + "；".join(bad) +
              "。请补上后用同一条命令重写，stdin 给 JSON 或带 ## 目标 / ## 做完了什么 / ## 下一步 的 Markdown，"
              "最小合格 JSON 如下：\n" + example)


def strip_auto(markdown):
    """Drop an author-written 自动采集 section from a Markdown handoff; the machine writes its own."""
    out, skipping = [], False
    for line in str(markdown).splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            skipping = m.group(1).strip().startswith(SECTIONS)
        if not skipping:
            out.append(line)
    return "\n".join(out).strip()


def test_log_of(content):
    """Path the author gave for the latest test output: JSON key test_log, or a Markdown line."""
    if isinstance(content, dict):
        return str(content.get("test_log") or "").strip()
    m = re.search(r"^\s*[-*]?\s*(?:测试日志|test[_ ]log)\s*[:：]\s*`?(\S+?)`?\s*$", str(content), re.I | re.M)
    return m.group(1) if m else ""


# ---------------------------------------------------------------- collectors
def _git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=GIT_TIMEOUT)
    if r.returncode:
        raise ValueError((r.stderr or r.stdout).strip()[:120] or _t("git failed", "git 失败"))
    return r.stdout.strip()


def repo_candidates(cwd):
    """Existing repositories on this machine: the known two plus the one the session runs in.
    A worktree shares its repository's git dir, so it is listed once."""
    seen, out = set(), []
    for path in [os.path.expanduser(p) for p in KNOWN_REPOS] + [cwd]:
        if not path or not os.path.isdir(path):
            continue
        try:
            top = _git(path, "rev-parse", "--show-toplevel")
            common = os.path.realpath(os.path.join(top, _git(top, "rev-parse", "--git-common-dir")))
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
        if common not in seen:
            seen.add(common)
            out.append((os.path.basename(top), top))
    return out


def commits(task, since, cwd):
    if not task:
        return _t("No task, so no commits are looked up by task id.", "无任务，不按任务 id 找提交。")
    lines, errors = [], []
    repos = repo_candidates(cwd)
    if not repos:
        return _t("Not available: no git repository found on this Mac.", "取不到：本机没有找到 git 仓库。")
    for name, top in repos:
        args = ["log", "--all", "-F", "--grep=" + task, "-n", "20", "--format=%h %ad %s", "--date=short"]
        if since:
            args.append(f"--since={int(since)}")
        try:
            rows = _git(top, *args).splitlines()
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            errors.append(_t(f"Not available: {name}'s commits ({e})", f"取不到：{name} 的提交（{e}）"))
            continue
        lines += [f"- {name} {row}" for row in rows]
    lines += ["- " + e for e in errors]
    looked = ', '.join(n for n, _ in repos)
    head = _t(f"{'Since the last handoff' if since else 'For this task so far'}, commits whose message has {task} (looked in: {looked}):\n",
              f"{'自上次交接以来' if since else '这条任务到现在'}，提交信息里带 {task} 的提交（查过：{'、'.join(n for n, _ in repos)}）：\n")
    return head + ("\n".join(lines) if lines else _t("none.", "无。"))


def worktree(cwd):
    top = _git(cwd, "rev-parse", "--show-toplevel")
    rows = _git(top, "status", "--porcelain").splitlines()
    if not rows:
        return _t(f"{top} has nothing uncommitted.", f"{top} 工作树干净。")
    more = _t(f"\n{len(rows) - 30} more not listed.", f"\n还有 {len(rows) - 30} 个没列出。") if len(rows) > 30 else ""
    return _t(f"{top} has {len(rows)} uncommitted files:\n", f"{top} 有 {len(rows)} 个没提交的文件：\n") + "\n".join("- " + r for r in rows[:30]) + more


def board(task, issue, comments, plan):
    if not task:
        return _t("No task.", "无任务。")
    if _t("en", "zh") == "en":
        marks = {"done": "done", "active": "in progress", "todo": "to do"}
        out = ["Plan: " + ("; ".join(f"{p['text']} ({marks.get(p['state'], p['state'])})" for p in plan) if plan else "none."),
               f"State: {(issue or {}).get('status', 'unknown')}"]
    else:
        marks = {"done": "完成", "active": "进行中", "todo": "待做"}
        out = ["计划：" + ("；".join(f"{p['text']}（{marks.get(p['state'], p['state'])}）" for p in plan) if plan else "无。"),
               f"状态：{(issue or {}).get('status', '未知')}"]
    recent = [c for c in comments if "[handoff:" not in str(c.get("text") or c.get("body") or "")][-5:]
    if recent:
        out.append(_t("Latest progress notes:", "最近进度记录："))
        for c in recent:
            text = " ".join(str(c.get("text") or c.get("body") or "").split())[:220]
            out.append(f"- {str(c.get('created_at') or '')[:16]} {text}")
    else:
        out.append(_t("Latest progress notes: none.", "最近进度记录：无。"))
    return "\n".join(out)


def workers_and_notes(task, base):
    import dispatch as D
    import wake
    import workers as W
    d = D if not base or base == D.DISPATCH_DIR else SimpleNamespace(DISPATCH_DIR=base)
    out = []
    try:
        rows = [r for r in W.Store(D).load(timeout=3)["workers"].values()
                if not task or task in W.worker_tasks(r)]
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        rows = None
        out.append(_t(f"workers: not available: {str(e)[:120]}", f"worker：取不到：{str(e)[:120]}"))
    if rows is not None:
        if not rows:
            out.append(_t("workers: none registered for this task.", "worker：这条任务没有登记的 worker。"))
        for r in rows:
            try:
                state, why = wake.report_state(r)
                active = W.alive(r)
            except (ValueError, OSError, subprocess.SubprocessError) as e:
                state, why, active = "", str(e), None
            label = (_t("running", "在跑") if active else _t("handed back", "已交回") if state == "reported" else _t("quit without a report", "退出没交报告") if state == "failed"
                     else _t("on another Mac, state not available", "在别的机器上，取不到状态") if active is None else _t("finished", "已结束"))
            out.append(_t(f"worker {r['name']}: {label}, report {r.get('report', '')}" + (f" ({why})" if why else ""), f"worker {r['name']}：{label}，报告 {r.get('report', '')}" + (f"（{why}）" if why else "")))
    try:
        unread = [n for n in wake.unread(d) if not task or task in (n.get("tasks") or [n.get("task")])]
        out.append(_t(f"Unread notifications: {len(unread)}", f"未读通知：{len(unread)} 条") + ("" if not unread else "\n" + "\n".join("- " + n["text"] for n in unread[:5])))
    except (ValueError, OSError) as e:
        out.append(_t(f"Unread notifications: not available: {str(e)[:120]}", f"未读通知：取不到：{str(e)[:120]}"))
    return "\n".join(out)


def test_output(path):
    if not path:
        return _t("Not given (put the log's path in test_log in the handoff JSON so whoever takes over sees the test results).", "未提供（在交接 JSON 里给 test_log 日志路径，接手的人才看得到测试结果）。")
    path = os.path.expanduser(path)
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - 6000))
            tail = f.read().decode("utf-8", "replace")
        mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(path)))
    except OSError as e:
        return _t(f"Not available: {path} cannot be read ({e.strerror or e}).", f"取不到：{path} 读不了（{e.strerror or e}）。")
    lines = [" ".join(x.split())[:180] for x in tail.splitlines() if x.strip()]
    summary = [x for x in lines if re.search(r"\bRan \d+ tests?\b|\bOK\b|FAILED|\bpassed\b|\bfailed\b|Tests?:|Test Files|\berrors?\b", x)][-6:]
    shown = summary or lines[-8:]
    return _t(f"{path} ({mtime}, {size} bytes), the end of it:\n", f"{path}（{mtime}，{size} 字节）尾部摘要：\n") + ("\n".join("    " + x for x in shown) if shown else _t("    The log is empty.", "    日志是空的。"))


# ---------------------------------------------------------------- the section
def collect(task, issue, plan, base=None, cwd="", test_log="", since=0, comments=None, budget=BUDGET):
    """The 自动采集 section (Markdown, starts with its ## heading). Never raises.
    `comments` is a callable so the board read runs inside the time budget."""
    started = time.time()
    cwd = cwd or os.getcwd()
    names = _t(("Commits since the last handoff", "Uncommitted files", "Task board", "Workers and notifications", "Latest test output"),
               ("自上次交接以来的提交", "没提交的文件", "任务板", "worker 和通知", "最近一次测试输出"))
    jobs = dict(zip(names, (
        lambda: commits(task, since, cwd),
        lambda: worktree(cwd),
        lambda: board(task, issue, comments() if callable(comments) else (comments or []), plan),
        lambda: workers_and_notes(task, base),
        lambda: test_output(test_log),
    )))
    results = {}

    def run(name, fn):
        try:
            results[name] = fn()
        except Exception as e:  # collection must never fail a handoff
            results[name] = _t("Not available: ", "取不到：") + (str(e)[:160] or type(e).__name__)

    threads = [threading.Thread(target=run, args=(n, f), daemon=True) for n, f in jobs.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(max(0.0, budget - (time.time() - started)))
    parts = [section_head(), "", _t("Read from this Mac by Dispatch at handoff time; the author cannot change it. "
                                    f"Collected at {time.strftime('%Y-%m-%d %H:%M:%S')}, took {time.time() - started:.1f} s.",
                                    "以下由 Dispatch 在交接时从机器上读出，作者不能改。"
                                    f"采集时间 {time.strftime('%Y-%m-%d %H:%M:%S')}，用时 {time.time() - started:.1f} 秒。")]
    for name in jobs:
        parts += ["", f"### {name}", "", results.get(name, _t(f"Not available: no answer within {budget:g} s.", f"取不到：超过 {budget:g} 秒没有返回。"))]
    return "\n".join(parts)
