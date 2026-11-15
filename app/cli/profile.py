# -*- coding: utf-8 -*-
"""关于我（~/.agents/rules/PROFILE.md）：Agent 自动维护的用户档案 —— `dispatch profile show|add|upcoming|done|inventory`.

会变的用户现状、处境与时间线，和 FACTS 的分工见文件头。`##` 节：我是谁 / 设备与服务现状 / 将来会发生的事 / 已发生。
条目都带「（日期 · actor[ · task]）」。Agent 在对话里得知新信息就 `dispatch profile add|upcoming`。"""
import datetime, hashlib, json, os, re, subprocess, sys, time

import backups
import dispatch as D
import dplatform as P
from lang import t as _t

# 关于我：Agent 自动维护的用户档案（本人、设备现状快照、将来安排）。与 FACTS 分工见文件头。
PROFILE_FILE = os.path.join(D.HOME, ".agents", "rules", "PROFILE.md")
PROFILE_INVENTORY_STATE = os.path.join(D.DISPATCH_DIR, "profile-inventory.json")
PROFILE_SSH_CONFIG = os.path.join(D.HOME, ".ssh", "config")

PROFILE_HEADINGS = {"我是谁": "Who I am", "设备与服务现状": "Devices and services",
                    "将来会发生的事": "Upcoming", "已发生": "Past events"}


def profile_heading(heading):
    for old, new in PROFILE_HEADINGS.items():
        if heading == old or heading.startswith(old + "（") or heading.startswith(old + " ("):
            return new + heading[len(old):].replace("（快照 · ", " (Snapshot · ").replace(" 实测）", " measured)").replace("）", ")")
    return heading


def profile_normalize(text):
    """Translate format-owned headings only, preserving entry text and line numbers."""
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        body = line.rstrip("\r\n")
        ending = line[len(body):]
        if body.startswith("# 关于我") or body == "# About me":
            lines[i] = "# Profile" + ending
        elif body.startswith("## "):
            lines[i] = "## " + profile_heading(body[3:]) + ending
    return "".join(lines)


def profile_migrate():
    """Explicit, local migration of Profile/Facts. Back up all changes before writing any."""
    changes = []
    for path, normalize in ((PROFILE_FILE, profile_normalize), (D.FACTS_FILE, D.facts_normalize)):
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8", newline="") as f:
            old = f.read()
        new = normalize(old)
        if new != old:
            backup = backups.save(path) or ""
            changes.append((path, backup, new))
    for path, _, new in changes:
        # Write through a symlink, retaining the user's existing rules-directory layout.
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
    return {"ok": True, "changed": [{"path": path, "backup": backup} for path, backup, _ in changes]}


# ---------------------------------------------------------------- profile: 关于我（~/.agents/rules/PROFILE.md）
# 会变的用户现状、处境与时间线，和 FACTS 的分工见文件头。`##` 节：我是谁 / 设备与服务现状 / 将来会发生的事 / 已发生。
# 条目都带「（日期 · actor[ · task]）」。Agent 在对话里得知新信息就 `dispatch profile add|upcoming`。

def profile_text():
    try:
        with open(PROFILE_FILE, encoding="utf-8") as f:
            return profile_normalize(f.read())
    except OSError:
        return ""


def profile_write_content(text):
    text = profile_normalize(text)
    os.makedirs(os.path.dirname(PROFILE_FILE), exist_ok=True)
    open(PROFILE_FILE, "w", encoding="utf-8").write(text if text.endswith("\n") else text + "\n")


def profile_today():
    return time.strftime("%Y-%m-%d")


def profile_actor(a=None):
    return (getattr(a, "actor", "") or os.environ.get("DISPATCH_ACTOR") or os.environ.get("BEADS_ACTOR") or "dispatch").strip() or "dispatch"


def profile_entry_line(text, actor, task=""):
    return f"- {text}（{profile_today()} · {actor}" + (f" · {task}" if task else "") + "）"


def profile_key(heading):
    """`设备与服务现状（快照 · 2026-09-12 22:30 · claude-code 实测）` → `设备与服务现状`."""
    return re.split(r"[\s（(·:：,，/]", profile_heading(heading.strip()), maxsplit=1)[0].lower()


def profile_sections(text):
    """Split on `## ` headings → [(heading, body)]; text before the first heading is dropped."""
    out, head, buf = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if head is not None:
                out.append((head, "\n".join(buf).strip()))
            head, buf = line[3:].strip(), []
        elif head is not None:
            buf.append(line)
    if head is not None:
        out.append((head, "\n".join(buf).strip()))
    return out


def profile_set_section_body(text, heading, body):
    """PROFILE.md with one `## heading` section's body replaced; the heading line, the other
    sections and the preamble stay. KeyError when there is no such heading."""
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("## ") and profile_heading(l[3:].strip()) == profile_heading(heading.strip())), None)
    if start is None:
        raise KeyError(heading)
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    new = [l.rstrip() for l in body.strip("\n").split("\n")] if body.strip() else []
    tail = [""] if end < len(lines) else []
    return "\n".join(lines[:start + 1] + [""] + new + tail + lines[end:]).rstrip("\n") + "\n"



def profile_section_rows(text):
    """`profile show --json` sections with their entries and where they sit (1-based lines)."""
    lines = text.split("\n")
    heads = [i for i, l in enumerate(lines) if l.startswith("## ")]
    rows = []
    for n, (h, b) in enumerate(profile_sections(text)):
        start = heads[n]
        end = heads[n + 1] if n + 1 < len(heads) else len(lines)
        rows.append({"heading": profile_heading(h), "key": profile_key(h), "body": b, "lines": len(b.splitlines()), "line": start + 1,
                     "items": D.md_items(lines, start + 1, end)})
    return rows


def profile_section_match(heading, prefix):
    heading, prefix = profile_heading(heading), profile_heading(prefix)
    return heading == prefix or heading.startswith(prefix)


def _profile_section_start(lines, prefix):
    for i, l in enumerate(lines):
        if l.startswith("## ") and profile_section_match(l[3:].strip(), prefix):
            return i
    return None


def _profile_section_end(lines, start):
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            return j
    return len(lines)


def profile_replace_section(text, heading_prefix, new_block):
    """Swap the section whose `## ` heading starts with heading_prefix (new_block carries its own
    heading). Missing section goes right after 我是谁; everything else is untouched."""
    lines = text.rstrip("\n").split("\n")
    block = new_block.rstrip("\n").split("\n")
    start = _profile_section_start(lines, heading_prefix)
    if start is None:
        who = _profile_section_start(lines, "我是谁")
        at = _profile_section_end(lines, who) if who is not None else len(lines)
        head, tail = lines[:at], lines[at:]
        while head and not head[-1].strip():
            head.pop()
        while tail and not tail[0].strip():
            tail.pop(0)
        return "\n".join(head + [""] + block + [""] + tail).rstrip("\n") + "\n"
    end = _profile_section_end(lines, start)
    return "\n".join(lines[:start] + block + lines[end:]).rstrip("\n") + "\n"


def profile_add_entry(text, section_prefix, entry_line):
    lines = text.rstrip("\n").split("\n")
    start = _profile_section_start(lines, section_prefix)
    if start is None:
        return text.rstrip("\n") + f"\n\n## {profile_heading(section_prefix)}\n{entry_line}\n"
    end = _profile_section_end(lines, start)
    at = end
    while at - 1 > start and not lines[at - 1].strip():
        at -= 1
    return "\n".join(lines[:at] + [entry_line] + lines[at:]) + "\n"


def profile_remove_entry(text, section_prefix, entry_line):
    lines = text.rstrip("\n").split("\n")
    start = _profile_section_start(lines, section_prefix)
    if start is None:
        return text
    end = _profile_section_end(lines, start)
    for i in range(start + 1, end):
        if lines[i] == entry_line:
            return "\n".join(lines[:i] + lines[i + 1:]) + "\n"
    return text


def profile_entries(text, section_prefix):
    for h, b in profile_sections(text):
        if profile_section_match(h, section_prefix):
            return [l for l in b.splitlines() if l.startswith("- ")]
    return []


def profile_entry_parts(line):
    """`- WHEN[|事项|标签] · 正文（日期 · actor）` → (date, text, text with attribution)."""
    s = line[2:].strip() if line.startswith("- ") else line.strip()
    when, sep, rest = s.partition(" · ")
    if not sep:
        return s, "", ""
    return when.split("|", 1)[0].strip(), re.sub(r"（[^（）]*）\s*$", "", rest).strip(), rest.strip()


def profile_when_date(when):
    """A `YYYY-MM-DD` date, or the last day of a `YYYY-MM` month (a month deadline is not missed
    until the month is over); everything else (下次回国/待办/…) is undated."""
    when = (when or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", when)
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.match(r"^(\d{4})-(\d{2})$", when)
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    if not 1 <= mo <= 12:
        return None
    return (datetime.date(y + 1, 1, 1) if mo == 12 else datetime.date(y, mo + 1, 1)) - datetime.timedelta(days=1)


def profile_sort_upcoming(entries):
    """Dated entries ascending first, undated (下次回国/待办/…) after, both stable."""
    def key(pair):
        i, line = pair
        d = profile_when_date(profile_entry_parts(line)[0])
        return (0, d.toordinal(), i) if d else (1, 0, i)
    return [line for _, line in sorted(enumerate(entries), key=key)]


def profile_sort_section(text, section_prefix):
    lines = text.rstrip("\n").split("\n")
    start = _profile_section_start(lines, section_prefix)
    if start is None:
        return text
    end = _profile_section_end(lines, start)
    body = lines[start + 1:end]
    idx = [i for i, l in enumerate(body) if l.startswith("- ")]
    if not idx:
        return text
    ordered = profile_sort_upcoming([body[i] for i in idx])
    new_body = body[:idx[0]] + ordered + body[idx[-1] + 1:]
    return "\n".join(lines[:start + 1] + new_body + lines[end:]) + "\n"


def profile_upcoming_due(text, days=14, now=None):
    """Dated 将来 entries due now or within `days`, oldest first; undated ones never appear."""
    today = now or datetime.date.today()
    if isinstance(today, datetime.datetime):
        today = today.date()
    rows = []
    for line in profile_entries(text, "将来会发生的事"):
        when, item, _ = profile_entry_parts(line)
        d = profile_when_date(when)
        if not d:
            continue
        left = (d - today).days
        if left > days:
            continue
        # Attribution can change when another agent records the same item. Its date, pipe
        # fields and body identify the reminder; a rescheduled item gets a new receipt.
        identity = re.sub(r"（[^（）]*）\s*$", "", line).strip()
        rows.append({"when": when, "date": d, "text": item, "days_left": left, "overdue": left < 0,
                     "key": hashlib.sha256(identity.encode("utf-8")).hexdigest()})
    rows.sort(key=lambda r: (r["date"], r["when"]))
    return rows


def profile_take_overdue(rows, select=None):
    """Claim only delivered overdue items across concurrent prime processes.

    `select(fresh)` renders the final brief while the receipt lock is held, and returns
    the rows that survived both section and total budgets. Omitted rows stay pending.
    """
    select = select or (lambda fresh: fresh)
    overdue = [r for r in rows if r["overdue"]]
    if not overdue:
        return select([])
    from instructions import _Locked, atomic_write
    path = os.path.join(D.DISPATCH_DIR, "profile-overdue.json")
    try:
        os.makedirs(D.DISPATCH_DIR, exist_ok=True)
        with _Locked(path + ".lock"):
            try:
                with open(path, encoding="utf-8") as f:
                    seen = json.load(f)
                if not isinstance(seen, dict):
                    seen = {}
            except (OSError, ValueError):
                seen = {}
            fresh = select([r for r in overdue if r["key"] not in seen])
            for r in fresh:
                seen[r["key"]] = profile_today()
            if fresh:
                atomic_write(path, json.dumps(seen, ensure_ascii=False) + "\n")
            return fresh
    except OSError as e:
        D.debug("prime overdue receipts", e)
        return select(overdue)


def profile_due_line(row):
    age = (_t(f"{abs(row['days_left'])} days overdue", f"已过期 {abs(row['days_left'])} 天") if row["overdue"]
           else _t(f"in {row['days_left']} days", f"{row['days_left']} 天后"))
    return f"- {row['when']} · {row['text']}" + _t(f" ({age})", f"（{age}）")


def profile_due_lines(rows, overdue, title):
    due = [r for r in rows if not r["overdue"]]
    lines = [title] if due or overdue else []
    lines.extend(profile_due_line(r) for r in due)
    if overdue:
        lines.append(_t("These are overdue; are they done?", "这几条过期了，做完了吗："))
        lines.extend(profile_due_line(r) for r in overdue)
    return lines


def profile_prime_brief(text, render, days=3, mark=True):
    """Render a capped brief, then remember only the overdue rows actually injected."""
    rows = profile_upcoming_due(text, days)
    result = ""

    def select(overdue):
        nonlocal result
        result = render(profile_due_lines(rows, overdue, _t(f"## Due soon (within {days} days)", f"## 快到期（{days} 天内）")))
        delivered = set(result.splitlines())
        return [r for r in overdue if profile_due_line(r) in delivered]

    if mark:
        profile_take_overdue(rows, select=select)
    else:
        select([r for r in rows if r["overdue"]])
    return result


def profile_prime_lines(text, days=14, now=None, mark=True, title=None):
    """What is due within `days`, and what is overdue. An overdue item is told once (the receipt is kept in local state);
    `mark=False` (someone running `dispatch prime` by hand) tells it without using up that one time."""
    rows = profile_upcoming_due(text, days, now)
    overdue = profile_take_overdue(rows) if mark else [r for r in rows if r["overdue"]]
    return profile_due_lines(rows, overdue, title or _t(f"## About me (due within {days} days)", f"## 关于我（{days} 天内到期）"))


def profile_inventory_at(text):
    for h, _ in profile_sections(text):
        if profile_section_match(h, "设备与服务现状"):
            m = re.search(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})", h)
            if m:
                return f"{m.group(1)} {m.group(2)}"
    return ""


# ---------------------------------------------------------------- profile inventory: 实测各台机器
# Remote login shells are fish, so the script always goes over `sh -s` (stdin), never as a quoted
# remote command. One unreachable host must never abort the whole run.

PROFILE_INVENTORY_SCRIPT = r'''#!/bin/sh
echo "### uname"
uname -a 2>/dev/null || echo "(unknown)"
echo "### uptime"
uptime 2>/dev/null || echo "(unknown)"
echo "### mem"
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  echo "mem_bytes: $(sysctl -n hw.memsize 2>/dev/null)"
  vm_stat 2>/dev/null | head -6
  sysctl -n vm.swapusage 2>/dev/null
else
  free -m 2>/dev/null || echo "(no free)"
fi
echo "### procs"
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  ps -axo rss=,comm= 2>/dev/null | sort -rn | head -10
else
  ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -10
fi
echo "### docker"
if docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}' 2>/dev/null; then :
elif sudo -n docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}' 2>/dev/null; then :  # NAS: docker needs sudo -n (passwordless)
else echo "(no docker)"; fi
echo "### systemd"
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  echo "(not darwin)"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -60
else
  echo "(no systemd)"
fi
echo "### launchd"
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  launchctl list 2>/dev/null | awk 'NR>1 && $3 !~ /^com\.apple/ {print $1, $2, $3}' | head -40
else
  echo "(not darwin)"
fi
'''


def profile_ssh_config_hosts():
    """`Host` aliases in ~/.ssh/config, wildcards (zitigate-*/headnode-*) skipped."""
    try:
        with open(PROFILE_SSH_CONFIG, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        m = re.match(r"^Host\s+(.+)", line)
        if not m:
            continue
        for a in m.group(1).split():
            if "*" in a or not a or a in out:
                continue
            out.append(a)
    return out


def profile_ssh_aliases(facts_text):
    """ssh-config aliases FACTS.md names, either as `ssh <alias>` or as a backticked token
    (the ssh/config paragraph writes `hetzner` that way). Sorted intersection."""
    config = set(profile_ssh_config_hosts())
    if not config:
        return []
    facts = facts_text or ""
    named = set(re.findall(r"\bssh\s+([A-Za-z0-9][A-Za-z0-9_.-]*)", facts))
    named |= set(re.findall(r"`([A-Za-z0-9][A-Za-z0-9_.-]*)`", facts))
    return sorted(named & config)


def profile_inventory_targets():
    """This machine, every other Mac in hosts.json, and the ssh aliases FACTS names — deduped.
    On Windows this machine is left out (the survey is a POSIX sh script); remote ones still work."""
    rows = [] if P.IS_WIN else [{"name": D.local_host_name(), "kind": "local", "ssh": ""}]
    for h in D.hosts():
        rows.append({"name": h.get("name") or h.get("id") or "", "kind": "mac", "ssh": h.get("ssh") or ""})
    for alias in profile_ssh_aliases(D.facts_text()):
        rows.append({"name": alias, "kind": "server", "ssh": alias})
    seen, out = set(), []
    for r in rows:
        key = r["ssh"] or r["name"]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def profile_run_script(ssh="", timeout=30):
    if P.IS_WIN:
        env = P.path_env()
    else:
        env = dict(os.environ)
        env["PATH"] = D.PATH_EXTRA + ":" + env.get("PATH", "")
    cmd = (["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", ssh, "sh", "-s"]
           if ssh else ["sh", "-s"])
    try:
        r = subprocess.run(cmd, input=PROFILE_INVENTORY_SCRIPT, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, _t(f"no answer within {timeout} s", f"{timeout} 秒无响应")
    except Exception as e:
        return None, str(e)[:160]
    if r.returncode != 0:
        return None, (r.stderr or r.stdout or _t(f"exit code {r.returncode}", f"退出码 {r.returncode}")).strip()[:300]
    return r.stdout.strip(), ""


def profile_inventory_collect(targets, timeout=30):
    results, dumps = [], []
    for t in targets:
        body, err = profile_run_script(t.get("ssh") or "", timeout=timeout)
        if err:
            results.append({"name": t["name"], "kind": t["kind"], "state": "error", "error": err})
        else:
            results.append({"name": t["name"], "kind": t["kind"], "state": "ok", "error": ""})
            dumps.append(f"=== {t['name']}（{t['kind']}） ===\n{body[:4000]}")
    return results, "\n\n".join(dumps)


PROFILE_INVENTORY_PROMPT = ("你是设备清单整理者。下面（用户消息）是几台机器/服务器的实测输出，以及现有的「设备与服务现状」内容。"
                            "用简体中文写一段 Markdown 正文，不要写 `##` 标题行：每台机器一个小标题或加粗行加要点，先给结论（哪台吃紧、哪台空闲、有没有服务异常）。"
                            "保留现有内容里的「分配原则」段落（如果存在）原文。只写实测输出里能看到的事实，绝不编造。不超过 1500 字。")


def profile_inventory_generate(actor="dispatch", timeout=30):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    if not summarize.use_enabled("profile_inventory"):
        print(summarize.gate_message("profile_inventory"), file=sys.stderr)
        sys.exit(1)
    at = int(time.time())
    at_text = time.strftime("%Y-%m-%d %H:%M", time.localtime(at))
    targets = profile_inventory_targets()
    results, dumps = profile_inventory_collect(targets, timeout=timeout)
    p = summarize.provider("")
    if not p:
        print(_t("Taking stock needs a model: put ZHIPU_API_KEY (or SUMMARY_MODEL) in dispatch env, or install Claude Code to use its subscription", "盘点需要一个模型：在 dispatch env 里放 ZHIPU_API_KEY（或 SUMMARY_MODEL），或装 Claude Code 用订阅"), file=sys.stderr)
        sys.exit(1)
    text = profile_text()
    old = next((b for h, b in profile_sections(text) if profile_section_match(h, "设备与服务现状")), "")
    tried = "\n".join(f"- {t['name']}（{t['kind']}）：{'ok' if t['state'] == 'ok' else t['error']}" for t in results)
    body = summarize.chat(p, PROFILE_INVENTORY_PROMPT, f"现有内容：\n{old}\n\n每台机器结果：\n{tried}\n\n实测输出：\n{dumps}", timeout=180, use="profile_inventory").strip()
    # The model sometimes leads with its own `# 设备与服务现状`; the section already has a heading.
    body = re.sub(r"^(?:#+\s*[^\n]*\n+)+", "", body).strip()
    if not body:
        print(_t("The model returned no stock-taking", "模型没有返回盘点内容"), file=sys.stderr)
        sys.exit(1)
    heading = f"## Devices and services (Snapshot · {at_text} · {actor} measured)"
    section = heading + "\n\n" + body[:6000]
    profile_write_content(profile_replace_section(text, "设备与服务现状", section))
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump({"at": at}, open(PROFILE_INVENTORY_STATE, "w"), ensure_ascii=False)   # a success clears `tried`
    return {"path": PROFILE_FILE, "at": at, "at_text": at_text, "model": f"{p['id']}:{p['model']}", "targets": results, "section": section}


def profile_inventory_spawn():
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    # Through dispatch.py: this module has no command-line entry of its own, so running it directly
    # imported it and exited, and the inventory never happened.
    args = [sys.executable, os.path.abspath(D.__file__), "profile", "inventory", "--refresh"]
    try:
        P.spawn_detached(args, cwd=D.HOME, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def profile_inventory_state():
    try:
        with open(PROFILE_INVENTORY_STATE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def profile_inventory_due(now=None):
    """Called by the app every hour: start a background inventory when the last one is a day
    old. Nothing is spawned when the use is switched off or no model can write the section
    (the sweep ssh-es every machine, so a doomed run is not free), and a failed attempt is not
    retried for six hours."""
    now = time.time() if now is None else now
    st = profile_inventory_state()
    last, tried = int(st.get("at") or 0), int(st.get("tried") or 0)
    if last and now - last < 86400:
        return {"due": False, "reason": _t(f"took stock less than a day ago ({D.ago(last)})", f"不到一天前盘点过（{D.ago(last)}）")}
    if tried and now - tried < 6 * 3600:
        return {"due": False, "reason": _t(f"the last stock-taking failed ({D.ago(tried)} ago); no retry within 6 hours", f"上次盘点没成功（{D.ago(tried)}前），6 小时内不重试")}
    summarize = D._mod("summarize")
    if not summarize.use_enabled("profile_inventory"):
        return {"due": False, "reason": summarize.gate_message("profile_inventory")}
    if not summarize.provider(""):
        return {"due": False, "reason": _t("no model to use: stock is taken by itself once a summary model is picked in Settings", "没有可用的模型：设置里选一个总结模型后才会自动盘点")}
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump({**st, "tried": int(now)}, open(PROFILE_INVENTORY_STATE, "w"), ensure_ascii=False)
    profile_inventory_spawn()
    return {"due": True, "reason": _t("taking stock started", "已开始盘点")}


def cmd_profile(a):
    op = a.op
    args = list(getattr(a, "args", []) or [])
    actor = profile_actor(a)
    task = (getattr(a, "task", "") or "").strip()
    if op == "migrate":
        D.out(profile_migrate(), a.json, lambda r: print("Migrated Profile and Facts: " + str(len(r["changed"])) + " file(s)."))
        return
    if op == "path":
        print(PROFILE_FILE)
        return
    if op == "write":
        text = D.guarded_whole_file_text(a, PROFILE_FILE)
        profile_write_content(text)
        print(_t(f"Wrote {PROFILE_FILE} ({len(text.splitlines())} lines)", f"已写入 {PROFILE_FILE}（{len(text.splitlines())} 行）"))
        return
    if op == "show":
        text = profile_normalize(profile_text())
        res = {"path": PROFILE_FILE, "exists": os.path.exists(PROFILE_FILE), "content": text,
               "sections": profile_section_rows(text),
               "inventory_at": profile_inventory_at(text)}
        D.out(res, a.json, lambda x: print(x["content"], end="" if x["content"].endswith("\n") else "\n"))
        return
    if op == "edit":
        # the Knowledge page in Dispatch IDE (About me): one section at a time, so what an agent
        # added to another section meanwhile is kept
        heading = " ".join(args).strip()
        if not heading:
            D.fail_answer(a.json, 'Usage: dispatch profile edit "<section heading>" < body', 2)
        try:
            text = profile_set_section_body(profile_text(), heading, sys.stdin.read())
        except KeyError:
            D.fail_answer(a.json, f"Section {heading} not found in PROFILE.md", 1)
        profile_write_content(text)
        D.out({"ok": True, "heading": heading, "path": PROFILE_FILE}, a.json, lambda o: print(_t(f"Updated \"{o['heading']}\"", f"已更新「{o['heading']}」")))
        return
    if op == "drop":
        # the Knowledge page's Delete on one About me entry: `dispatch profile drop <line> --text "<entry>"`
        try:
            line = int(args[0]) if args else 0
            text = D.md_drop_item(profile_text(), line, getattr(a, "text", "") or "")
        except ValueError as e:
            D.fail_answer(a.json, str(e) if str(e) else "Usage: dispatch profile drop <line> --text <entry>", 1)
        profile_write_content(text)
        D.out({"ok": True, "line": line, "path": PROFILE_FILE}, a.json, lambda o: print(_t(f"Removed the entry on line {o['line']}", f"已删掉第 {o['line']} 行那条")))
        return
    if op == "add":
        fact = args[0].strip() if args else ""
        if not fact:
            print(_t('Usage: dispatch profile add "fact" [--actor A] [--task T]', '用法：dispatch profile add "事实" [--actor A] [--task T]'), file=sys.stderr)
            sys.exit(2)
        entry = profile_entry_line(fact, actor, task)
        text = profile_add_entry(profile_text(), "我是谁", entry)
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "entry": entry, "content": text}, a.json, lambda x: print(_t(f"Recorded: {x['entry']}", f"已记录：{x['entry']}")))
        return
    if op == "upcoming":
        if len(args) < 2 or not args[0].strip() or not args[1].strip():
            print(_t('Usage: dispatch profile upcoming "WHEN" "what" [--actor A] [--task T]', '用法：dispatch profile upcoming "WHEN" "事项" [--actor A] [--task T]'), file=sys.stderr)
            sys.exit(2)
        when, item = args[0].strip(), args[1].strip()
        entry = f"- {when} · {item}（{profile_today()} · {actor}" + (f" · {task}" if task else "") + "）"
        text = profile_add_entry(profile_text(), "将来会发生的事", entry)
        text = profile_sort_section(text, "将来会发生的事")
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "entry": entry, "content": text}, a.json, lambda x: print(_t(f"Recorded as upcoming: {x['entry']}", f"已记入将来：{x['entry']}")))
        return
    if op == "done":
        kw = args[0].strip() if args else ""
        if not kw:
            print(_t("Usage: dispatch profile done <words>", "用法：dispatch profile done <关键词>"), file=sys.stderr)
            sys.exit(2)
        text = profile_text()
        hits = [e for e in profile_entries(text, "将来会发生的事") if kw in e]
        if not hits:
            print(_t(f"Nothing upcoming contains \"{kw}\" (`dispatch profile show` shows the whole file)", f"「将来」里没有含「{kw}」的条目（`dispatch profile show` 看全文）"), file=sys.stderr)
            sys.exit(1)
        if len(hits) > 1:
            print(_t(f"\"{kw}\" matches {len(hits)} entries; use more specific words:", f"「{kw}」匹配到 {len(hits)} 条，换更具体的关键词："), file=sys.stderr)
            for e in hits:
                print("  " + e, file=sys.stderr)
            sys.exit(2)
        entry = hits[0]
        moved = f"- {profile_today()} · {entry[2:] if entry.startswith('- ') else entry}"
        text = profile_add_entry(profile_remove_entry(text, "将来会发生的事", entry), "已发生", moved)
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "removed": entry, "moved": moved, "content": text}, a.json, lambda x: print(_t(f"Moved to past events: {x['moved']}", f"已移入已发生：{x['moved']}")))
        return
    if op == "inventory":
        if not getattr(a, "refresh", False) and not getattr(a, "due", False):
            print(_t("Usage: dispatch profile inventory --refresh (take stock now) or --due (only when it is due)", "用法：dispatch profile inventory --refresh（现在盘点）或 --due（到期才盘）"), file=sys.stderr)
            sys.exit(2)
        if getattr(a, "refresh", False):
            D.out(profile_inventory_generate(actor), a.json, lambda x: print(x["section"]))
        else:
            D.out(profile_inventory_due(), a.json, lambda x: print(x["reason"]))
        return
    print(f"Unknown operation: {op}", file=sys.stderr)
    sys.exit(2)
