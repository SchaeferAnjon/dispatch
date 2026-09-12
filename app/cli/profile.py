"""关于我（~/.agents/rules/PROFILE.md）：Agent 自动维护的用户档案 —— `dispatch profile show|add|upcoming|done|inventory`.

会变的用户现状、处境与时间线，和 FACTS 的分工见文件头。`##` 节：我是谁 / 设备与服务现状 / 将来会发生的事 / 已发生。
条目都带「（日期 · actor[ · task]）」。Agent 在对话里得知新信息就 `dispatch profile add|upcoming`。"""
import datetime, json, os, re, subprocess, sys, time

import dispatch as D

# 关于我：Agent 自动维护的用户档案（本人、设备现状快照、将来安排）。与 FACTS 分工见文件头。
PROFILE_FILE = os.path.join(D.HOME, ".agents", "rules", "PROFILE.md")
PROFILE_INVENTORY_STATE = os.path.join(D.DISPATCH_DIR, "profile-inventory.json")
PROFILE_SSH_CONFIG = os.path.join(D.HOME, ".ssh", "config")


# ---------------------------------------------------------------- profile: 关于我（~/.agents/rules/PROFILE.md）
# 会变的用户现状、处境与时间线，和 FACTS 的分工见文件头。`##` 节：我是谁 / 设备与服务现状 / 将来会发生的事 / 已发生。
# 条目都带「（日期 · actor[ · task]）」。Agent 在对话里得知新信息就 `dispatch profile add|upcoming`。

def profile_text():
    try:
        with open(PROFILE_FILE, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def profile_write_content(text):
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
    return re.split(r"[\s（(·:：,，/]", heading.strip(), maxsplit=1)[0].lower()


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


def profile_section_match(heading, prefix):
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
        return text.rstrip("\n") + f"\n\n## {section_prefix}\n{entry_line}\n"
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
    """`- WHEN · 事项（日期 · actor）` → (WHEN, 事项, 事项＋出处)."""
    s = line[2:].strip() if line.startswith("- ") else line.strip()
    when, sep, rest = s.partition(" · ")
    if not sep:
        return s, "", ""
    return when.strip(), re.sub(r"（[^（）]*）\s*$", "", rest).strip(), rest.strip()


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
        rows.append({"when": when, "date": d, "text": item, "days_left": left, "overdue": left < 0})
    rows.sort(key=lambda r: (r["date"], r["when"]))
    return rows


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
    """This machine, every other Mac in hosts.json, and the ssh aliases FACTS names — deduped."""
    rows = [{"name": D.local_host_name(), "kind": "local", "ssh": ""}]
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
    env = dict(os.environ)
    env["PATH"] = D.PATH_EXTRA + ":" + env.get("PATH", "")
    cmd = (["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", ssh, "sh", "-s"]
           if ssh else ["sh", "-s"])
    try:
        r = subprocess.run(cmd, input=PROFILE_INVENTORY_SCRIPT, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, f"{timeout} 秒无响应"
    except Exception as e:
        return None, str(e)[:160]
    if r.returncode != 0:
        return None, (r.stderr or r.stdout or f"退出码 {r.returncode}").strip()[:300]
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
        print("盘点需要一个模型：在 dispatch env 里放 ZHIPU_API_KEY（或 SUMMARY_MODEL），或装 Claude Code 用订阅", file=sys.stderr)
        sys.exit(1)
    text = profile_text()
    old = next((b for h, b in profile_sections(text) if profile_section_match(h, "设备与服务现状")), "")
    tried = "\n".join(f"- {t['name']}（{t['kind']}）：{'ok' if t['state'] == 'ok' else t['error']}" for t in results)
    body = summarize.chat(p, PROFILE_INVENTORY_PROMPT, f"现有内容：\n{old}\n\n每台机器结果：\n{tried}\n\n实测输出：\n{dumps}", timeout=180, use="profile_inventory").strip()
    # The model sometimes leads with its own `# 设备与服务现状`; the section already has a heading.
    body = re.sub(r"^(?:#+\s*[^\n]*\n+)+", "", body).strip()
    if not body:
        print("模型没有返回盘点内容", file=sys.stderr)
        sys.exit(1)
    heading = f"## 设备与服务现状（快照 · {at_text} · {actor} 实测）"
    section = heading + "\n\n" + body[:6000]
    profile_write_content(profile_replace_section(text, "设备与服务现状", section))
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump({"at": at}, open(PROFILE_INVENTORY_STATE, "w"), ensure_ascii=False)   # a success clears `tried`
    return {"path": PROFILE_FILE, "at": at, "at_text": at_text, "model": f"{p['id']}:{p['model']}", "targets": results, "section": section}


def profile_inventory_spawn():
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    args = [sys.executable, os.path.abspath(__file__), "profile", "inventory", "--refresh"]
    try:
        subprocess.Popen(args, cwd=D.HOME, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
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
        return {"due": False, "reason": f"不到一天前盘点过（{D.ago(last)}）"}
    if tried and now - tried < 6 * 3600:
        return {"due": False, "reason": f"上次盘点没成功（{D.ago(tried)}前），6 小时内不重试"}
    summarize = D._mod("summarize")
    if not summarize.use_enabled("profile_inventory"):
        return {"due": False, "reason": summarize.gate_message("profile_inventory")}
    if not summarize.provider(""):
        return {"due": False, "reason": "没有可用的模型：设置里选一个总结模型后才会自动盘点"}
    os.makedirs(D.DISPATCH_DIR, exist_ok=True)
    json.dump({**st, "tried": int(now)}, open(PROFILE_INVENTORY_STATE, "w"), ensure_ascii=False)
    profile_inventory_spawn()
    return {"due": True, "reason": "已开始盘点"}


def cmd_profile(a):
    op = a.op
    args = list(getattr(a, "args", []) or [])
    actor = profile_actor(a)
    task = (getattr(a, "task", "") or "").strip()
    if op == "path":
        print(PROFILE_FILE)
        return
    if op == "write":
        text = sys.stdin.read()
        profile_write_content(text)
        print(f"已写入 {PROFILE_FILE}（{len(text.splitlines())} 行）")
        return
    if op == "show":
        text = profile_text()
        res = {"path": PROFILE_FILE, "exists": os.path.exists(PROFILE_FILE), "content": text,
               "sections": [{"heading": h, "key": profile_key(h), "body": b, "lines": len(b.splitlines())} for h, b in profile_sections(text)],
               "inventory_at": profile_inventory_at(text)}
        D.out(res, a.json, lambda x: print(x["content"], end="" if x["content"].endswith("\n") else "\n"))
        return
    if op == "add":
        fact = args[0].strip() if args else ""
        if not fact:
            print('用法：dispatch profile add "事实" [--actor A] [--task T]', file=sys.stderr)
            sys.exit(2)
        entry = profile_entry_line(fact, actor, task)
        text = profile_add_entry(profile_text(), "我是谁", entry)
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "entry": entry, "content": text}, a.json, lambda x: print(f"已记录：{x['entry']}"))
        return
    if op == "upcoming":
        if len(args) < 2 or not args[0].strip() or not args[1].strip():
            print('用法：dispatch profile upcoming "WHEN" "事项" [--actor A] [--task T]', file=sys.stderr)
            sys.exit(2)
        when, item = args[0].strip(), args[1].strip()
        entry = f"- {when} · {item}（{profile_today()} · {actor}" + (f" · {task}" if task else "") + "）"
        text = profile_add_entry(profile_text(), "将来会发生的事", entry)
        text = profile_sort_section(text, "将来会发生的事")
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "entry": entry, "content": text}, a.json, lambda x: print(f"已记入将来：{x['entry']}"))
        return
    if op == "done":
        kw = args[0].strip() if args else ""
        if not kw:
            print("用法：dispatch profile done <关键词>", file=sys.stderr)
            sys.exit(2)
        text = profile_text()
        hits = [e for e in profile_entries(text, "将来会发生的事") if kw in e]
        if not hits:
            print(f"「将来」里没有含「{kw}」的条目（`dispatch profile show` 看全文）", file=sys.stderr)
            sys.exit(1)
        if len(hits) > 1:
            print(f"「{kw}」匹配到 {len(hits)} 条，换更具体的关键词：", file=sys.stderr)
            for e in hits:
                print("  " + e, file=sys.stderr)
            sys.exit(2)
        entry = hits[0]
        moved = f"- {profile_today()} · {entry[2:] if entry.startswith('- ') else entry}"
        text = profile_add_entry(profile_remove_entry(text, "将来会发生的事", entry), "已发生", moved)
        profile_write_content(text)
        D.out({"path": PROFILE_FILE, "removed": entry, "moved": moved, "content": text}, a.json, lambda x: print(f"已移入已发生：{x['moved']}"))
        return
    if op == "inventory":
        if not getattr(a, "refresh", False) and not getattr(a, "due", False):
            print("用法：dispatch profile inventory --refresh（现在盘点）或 --due（到期才盘）", file=sys.stderr)
            sys.exit(2)
        if getattr(a, "refresh", False):
            D.out(profile_inventory_generate(actor), a.json, lambda x: print(x["section"]))
        else:
            D.out(profile_inventory_due(), a.json, lambda x: print(x["reason"]))
        return
    print(f"未知操作：{op}", file=sys.stderr)
    sys.exit(2)
