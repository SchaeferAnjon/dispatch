"""The cross-agent /insights report: a model reads a digest of the recent sessions of every
agent (Claude Code, Codex, pi, ZCode) and writes a structured review — what you worked on,
how the agents behaved, where they failed, what went well, what to change in rules/skills.

    dispatch insights report [--days 14] [--model M] [--wait]   generate one (background by default)
    dispatch insights list                                     past reports, newest first
    dispatch insights show [<id>|latest]                       one report as JSON
    dispatch insights schedule [--every 0|7|14|30]             auto-run cadence (0 = off)
    dispatch insights due                                      run a report if the cadence says so

Reports live in ~/tasks/.dispatch/insights/<stamp>.json (+ .html, self-contained, opens in a
browser tab). The signal counts from `dispatch insights` (regex cues) go into the digest so
the model interprets them instead of the reader guessing.
"""
import json, os, re, subprocess, sys, time
from html import escape

import dispatch as D

DIR = os.path.join(D.DISPATCH_DIR, "insights")
SCHEDULE = os.path.join(DIR, "schedule.json")
RUNNING = os.path.join(DIR, "running.json")
MAX_SESSIONS = 60           # most relevant sessions in the digest
SECTION_ORDER = ["overview", "projects", "patterns", "wins", "friction", "features", "suggestions", "signals"]
SECTION_TITLES = {"overview": "一眼看完", "projects": "这段时间在做什么", "patterns": "你是怎么用 Agent 的", "wins": "做得漂亮的事", "friction": "哪里出了问题", "features": "可以试试的做法", "suggestions": "建议改什么", "signals": "行为信号解读"}
NATIVE_DIR = os.path.join(D.HOME, ".claude", "usage-data")


def _stamp():
    return time.strftime("%Y-%m-%d_%H%M")


def schedule_load():
    try:
        return json.load(open(SCHEDULE))
    except Exception:
        return {"every_days": 0}


def schedule_save(d):
    os.makedirs(DIR, exist_ok=True)
    json.dump(d, open(SCHEDULE, "w"), ensure_ascii=False)


def running():
    try:
        r = json.load(open(RUNNING))
        if time.time() - r.get("started", 0) < 20 * 60:
            return r
    except Exception:
        pass
    return None


def native_reports():
    """Claude Code's own /insights reports (~/.claude/usage-data/report-*.html), listed alongside ours."""
    out = []
    for name in sorted(os.listdir(NATIVE_DIR) if os.path.isdir(NATIVE_DIR) else [], reverse=True):
        m = re.match(r"report-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.html$", name)
        if not m:
            continue
        p = os.path.join(NATIVE_DIR, name)
        head = ""
        try:
            txt = open(p, encoding="utf-8", errors="replace").read(200000)
            mm = re.search(r"(\d+ messages across [^<|]+\|[^<]+)", txt)
            head = mm.group(1).strip() if mm else ""
        except OSError:
            pass
        out.append({"id": "native-" + name[7:-5], "source": "claude-code", "created_at": f"{m[1]}-{m[2]}-{m[3]} {m[4]}:{m[5]}", "days": None, "model": "", "sessions": 0, "headline": head or "Claude Code /insights 报告", "path": "", "html": p, "error": ""})
    return out


def list_reports():
    out = []
    for name in sorted(os.listdir(DIR) if os.path.isdir(DIR) else [], reverse=True):
        if not name.endswith(".json") or name in ("schedule.json", "running.json"):
            continue
        p = os.path.join(DIR, name)
        try:
            r = json.load(open(p))
        except Exception:
            continue
        out.append({"id": name[:-5], "source": "dispatch", "created_at": r.get("created_at", ""), "days": r.get("days"), "model": r.get("model", ""), "sessions": r.get("session_count", 0),
                    "headline": (r.get("report") or {}).get("headline", ""), "path": p, "html": p[:-5] + ".html", "error": r.get("error", "")})
    return out


def all_reports():
    return sorted(list_reports() + native_reports(), key=lambda r: r["created_at"], reverse=True)


def load_report(rid="latest"):
    reps = list_reports()
    if not reps:
        return None
    if rid in ("", "latest"):
        return json.load(open(reps[0]["path"]))
    hit = next((r for r in reps if r["id"] == rid or r["id"].startswith(rid)), None)
    return json.load(open(hit["path"])) if hit else None


# ---------------------------------------------------------------- digest: what the model reads

def digest(days):
    rep = D.insights_scan(days)
    rep["findings"] = D.insights_findings(rep)
    idx = D.load_index() or D.refresh_index()
    by_sid = {e.get("session_id"): (k, e) for k, e in idx.items() if not e.get("subagent")}
    sessions = []
    ranked = rep.get("all_sessions", rep["sessions"])
    # Most signal-heavy first, then the most recent; cap the digest size.
    recent = sorted(ranked, key=lambda r: r.get("last_at", ""), reverse=True)
    picked, seen = [], set()
    for r in ranked[:MAX_SESSIONS // 2] + recent:
        if r["session_id"] in seen or len(picked) >= MAX_SESSIONS:
            continue
        seen.add(r["session_id"]); picked.append(r)
    for r in picked:
        k, e = by_sid.get(r["session_id"], (None, None))
        if not e:
            continue
        first, last = "", ""
        try:
            d = D.read_session_detail(dict(e, path=k, subagents=[]), limit=400)
            U = [m for m in d["messages"] if m["role"] == "user" and m["text"].strip()]
            A = [m for m in d["messages"] if m["role"] == "assistant" and m["text"].strip()]
            first = U[0]["text"][:400] if U else ""
            last = A[-1]["text"][-500:] if A else ""
            tools = sorted(d.get("tool_counts", {}).items(), key=lambda x: -x[1])[:6]
            files = [f["path"].replace(D.HOME, "~") for f in d.get("files", [])][:8]
        except Exception:
            tools, files = [], []
        tok = e.get("tokens") or {}
        sessions.append({"agent": r["agent"], "session_id": r["session_id"][:8], "title": (e.get("title") or "")[:80], "project": os.path.basename((e.get("cwd") or "").rstrip("/")),
                         "date": r["last_ts"], "user_turns": r["user_turns"], "tokens": sum(v for v in tok.values() if isinstance(v, (int, float))),
                         "signals": {k: r[k] for k in ("correction", "asktail", "approve", "continue", "overflow", "tool_errors", "no_board", "ends_on_question") if r.get(k)},
                         "tools": tools, "files": files, "first_prompt": first, "last_reply": last})
    return {"days": days, "generated_at": time.strftime("%Y-%m-%d %H:%M"), "total_sessions": rep["total_sessions"], "per_agent": rep["per_agent"], "findings": rep["findings"],
            "rules": D.INSIGHT_RULES, "samples": rep["samples"], "sessions": sessions}


PROMPT = """你是一个复盘分析师。下面（stdin）是一份 JSON 摘要：过去 {days} 天里这台电脑上所有 AI 编程 Agent（Claude Code、Codex、pi、ZCode）的会话——每个会话的第一句话、最后回复、用到的工具、改过的文件、token 用量，以及一组用正则数出来的行为信号（用户纠错、助手以问句收尾、上下文溢出、工具报错、长会话没上任务板等；`rules` 字段解释每个信号怎么算）和纠错/问句样本。

请写一份跟 Claude Code 的 /insights 报告同样结构的跨 Agent 复盘。要求：
- 只输出一个 JSON 对象，不要 Markdown 代码块，不要多余文字。全部中文，术语可保留英文。
- 结构（sections 按此顺序，key 固定）：
{{
  "headline": "一句话总结这段时间（≤40 字）",
  "sections": [
    {{"key": "overview", "title": "一眼看完", "summary": "2-3 句概览", "items": [
        {{"title": "在起作用的", "detail": "..."}}, {{"title": "在拖后腿的", "detail": "..."}}, {{"title": "马上能改的", "detail": "..."}}, {{"title": "值得试的大动作", "detail": "..."}}]}},
    {{"key": "projects", "title": "这段时间在做什么", "summary": "1-2 句", "items": [{{"title": "项目/主题", "detail": "做了什么、进展如何（2-4 句）", "evidence": ["会话 id 前 8 位"], "metric": "如 12 个会话 · 1.2M token"}}]}},
    {{"key": "patterns", "title": "你是怎么用 Agent 的", "summary": "...", "items": [{{"title": "习惯", "detail": "...", "evidence": []}}]}},
    {{"key": "wins", "title": "做得漂亮的事", "summary": "...", "items": [{{"title": "...", "detail": "...", "evidence": []}}]}},
    {{"key": "friction", "title": "哪里出了问题", "summary": "...", "items": [{{"title": "问题类型", "detail": "具体表现，引用样本原话", "evidence": ["id"], "action": "对应的一条可执行改法"}}]}},
    {{"key": "features", "title": "可以试试的做法", "summary": "...", "items": [{{"title": "做法", "detail": "为什么适合这个人、怎么用（dispatch 子命令、技能、子 Agent、任务板、多机派活等都算）"}}]}},
    {{"key": "suggestions", "title": "建议改什么", "summary": "...", "items": [{{"title": "一条建议", "detail": "改哪个文件/规则/技能、改成什么样、为什么", "priority": "高|中|低"}}]}},
    {{"key": "signals", "title": "行为信号解读", "summary": "...", "items": [{{"title": "信号名（沿用 rules 里的 name）", "metric": "数字", "detail": "这个数字说明什么、值不值得管", "evidence": []}}]}}
  ]
}}
- 每个 section 的 summary 是给「概览」用的，要能独立成句；items 是展开后看的细节，每节 3-6 条，用事实和会话 id 佐证，不编造。
- friction 和 suggestions 最重要：把纠错样本归类（没用工具 / 做过头 / 停太早 / 无效确认 / 忘记录 / 原地打转），每类给具体改法，能落到 ~/.agents/rules/GLOBAL.md 或某个 SKILL.md 的直接写出建议条文。
- 数字以摘要为准；不要复述规则原文。"""


def generate(days, model=None, wait=True):
    """Run the model once and store JSON + HTML. Returns the stored record."""
    os.makedirs(DIR, exist_ok=True)
    started = time.time()
    json.dump({"started": started, "days": days, "pid": os.getpid()}, open(RUNNING, "w"))
    dig = digest(days)
    stamp = _stamp()
    rec = {"id": stamp, "created_at": time.strftime("%Y-%m-%d %H:%M"), "days": days, "model": model or "", "session_count": dig["total_sessions"], "digest_sessions": len(dig["sessions"]),
           "signals": dig["per_agent"], "findings": dig["findings"], "rules": dig["rules"], "stats": chart_stats(dig), "report": None, "error": "", "duration_s": 0}
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    env["PATH"] = D.PATH_EXTRA + ":" + env.get("PATH", "")
    cmd = ["claude", "-p", PROMPT.format(days=days), "--output-format", "text", "--tools", "", "--permission-mode", "bypassPermissions"]
    if model:
        cmd += ["--model", model]
    try:
        r = subprocess.run(cmd, input=json.dumps(dig, ensure_ascii=False), capture_output=True, text=True, timeout=15 * 60, env=env, cwd=D.HOME)
        text = r.stdout.strip()
        if r.returncode != 0 and not text:
            raise RuntimeError((r.stderr or "claude 退出码 %d" % r.returncode).strip()[:400])
        m = re.search(r"\{.*\}", text, re.S)
        report = json.loads(m.group(0)) if m else None
        if not report or "sections" not in report:
            raise RuntimeError("模型没有返回可解析的报告：" + text[:300])
        order = {k: i for i, k in enumerate(SECTION_ORDER)}
        report["sections"] = sorted([s for s in report["sections"] if isinstance(s, dict)], key=lambda s: order.get(s.get("key"), 99))
        for s in report["sections"]:
            s.setdefault("title", SECTION_TITLES.get(s.get("key", ""), s.get("key", "")))
            s.setdefault("items", [])
        rec["report"] = report
        rec["model"] = model or _model_used(r.stderr) or "claude 默认模型"
    except subprocess.TimeoutExpired:
        rec["error"] = "模型 15 分钟没有返回"
    except Exception as e:
        rec["error"] = str(e)[:600]
    rec["duration_s"] = round(time.time() - started)
    path = os.path.join(DIR, stamp + ".json")
    json.dump(rec, open(path, "w"), ensure_ascii=False, indent=1)
    if rec["report"]:
        open(path[:-5] + ".html", "w").write(render_html(rec))
    try:
        os.remove(RUNNING)
    except FileNotFoundError:
        pass
    return rec


def _model_used(stderr):
    m = re.search(r"model[\"':\s]+([\w.-]+)", stderr or "")
    return m.group(1) if m else ""


def spawn(days, model=None):
    """Generate in a detached process so the app's call returns at once."""
    os.makedirs(DIR, exist_ok=True)
    json.dump({"started": time.time(), "days": days, "pid": 0}, open(RUNNING, "w"))
    args = [sys.executable, os.path.abspath(__file__), "--worker", str(days)] + ([model] if model else [])
    subprocess.Popen(args, cwd=D.HOME, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"state": "running", "days": days, "started": time.time()}


def due():
    """Generate when the cadence says the last report is old enough (called by the app every hour)."""
    sc = schedule_load()
    every = int(sc.get("every_days") or 0)
    if not every:
        return {"due": False, "reason": "自动生成已关闭"}
    if running():
        return {"due": False, "reason": "正在生成"}
    reps = [r for r in list_reports() if not r["error"]]
    last = reps[0]["created_at"] if reps else ""
    if last:
        age = (time.time() - time.mktime(time.strptime(last, "%Y-%m-%d %H:%M"))) / 86400
        if age < every:
            return {"due": False, "reason": f"上次 {last}，{every} 天一次，还差 {every - age:.1f} 天"}
    spawn(every)
    return {"due": True, "reason": "已开始生成"}


def chart_stats(dig):
    """Numbers for the report's charts: tokens and sessions per agent and per project, from the digest."""
    agents, projects = {}, {}
    for x in dig["sessions"]:
        a = agents.setdefault(x["agent"], {"sessions": 0, "tokens": 0, "turns": 0})
        a["sessions"] += 1; a["tokens"] += x["tokens"]; a["turns"] += x["user_turns"]
        pr = projects.setdefault(x["project"] or "（家目录）", {"sessions": 0, "tokens": 0})
        pr["sessions"] += 1; pr["tokens"] += x["tokens"]
    top = sorted(projects.items(), key=lambda kv: -kv[1]["tokens"])[:8]
    return {"agents": agents, "projects": dict(top)}


def _fmt_tok(n):
    return f"{n / 1e9:.2f}B" if n >= 1e9 else f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}K" if n >= 1e3 else str(int(n))


AGENT_COLOR = {"claude-code": "#c8693a", "codex": "#2f7d6b", "zcode": "#6b5bd6", "pi": "#5a7d2f"}


def svg_bars(rows, fmt=str, width=560, color=None):
    """Horizontal bars, one row per (label, value[, colour]); inline SVG, no scripts."""
    if not rows:
        return ""
    mx = max(v for _, v, *_ in rows) or 1
    h = 22 * len(rows) + 4
    out = [f"<svg viewBox='0 0 {width} {h}' width='100%' height='{h}' role='img' style='font:12px -apple-system,sans-serif;display:block'>"]
    for i, row in enumerate(rows):
        label, v = row[0], row[1]
        c = row[2] if len(row) > 2 else (color or "#5b6ee1")
        y = 4 + i * 22; w = max(2, (width - 260) * v / mx)
        out.append(f"<text x='0' y='{y + 14}' fill='#3a3a3c' font-weight='600'>{escape(str(label))[:24]}</text><rect x='150' y='{y + 3}' rx='4' width='{w:.1f}' height='14' fill='{c}'/><text x='{150 + w + 8:.1f}' y='{y + 14}' fill='#6e6e73'>{escape(fmt(v))}</text>")
    out.append("</svg>")
    return "".join(out)


def charts_html(rec):
    st = rec.get("stats") or {}
    sig = rec.get("signals") or {}
    parts = []
    ag = st.get("agents") or {}
    if ag:
        rows = sorted(ag.items(), key=lambda kv: -kv[1]["tokens"])
        parts.append("<section><h2>图表</h2><h3>每个 Agent 烧了多少</h3>" + svg_bars([(k, v["tokens"], AGENT_COLOR.get(k, "#5b6ee1")) for k, v in rows], _fmt_tok))
        parts.append("<h3>每个 Agent 的会话数</h3>" + svg_bars([(k, v["sessions"], AGENT_COLOR.get(k, "#5b6ee1")) for k, v in rows], lambda v: f"{v} 个"))
    pr = st.get("projects") or {}
    if pr:
        parts.append("<h3>token 花在哪些项目</h3>" + svg_bars([(k, v["tokens"]) for k, v in pr.items()], _fmt_tok, color="#8e8e93"))
    if sig:
        for key, title in (("correction", "用户纠错/催促"), ("asktail", "助手以问句收尾"), ("tool_errors", "工具报错")):
            rows = [(k, c.get(key, 0), AGENT_COLOR.get(k, "#5b6ee1")) for k, c in sig.items() if c.get(key)]
            if rows:
                parts.append(f"<h3>{title}（按 Agent）</h3>" + svg_bars(rows, lambda v: f"{v} 次"))
    if parts:
        parts.append("</section>")
    return "".join(parts)


# ---------------------------------------------------------------- HTML: one self-contained page

CSS = """body{font:15px/1.6 -apple-system,'PingFang SC','Helvetica Neue',sans-serif;color:#1d1d1f;background:#f6f6f4;margin:0}main{max-width:900px;margin:0 auto;padding:36px 24px 80px}
h1{font-size:26px;margin:0 0 6px}.meta{color:#6e6e73;font-size:13px;margin-bottom:26px}.head{font-size:18px;color:#3a3a3c;margin:0 0 28px;padding:14px 18px;background:#fff;border:1px solid #e5e5ea;border-radius:12px}
section{background:#fff;border:1px solid #e5e5ea;border-radius:12px;padding:18px 22px;margin-bottom:16px}section h2{font-size:17px;margin:0 0 6px}section h3{font-size:13px;color:#6e6e73;margin:14px 0 4px;font-weight:600}section>p{margin:0 0 10px;color:#3a3a3c}
details{border-top:1px solid #f0f0f0;padding:8px 0}details summary{cursor:pointer;font-weight:600;list-style:none;display:flex;gap:10px;align-items:baseline}details summary::before{content:'›';color:#98989d;transition:transform .15s}details[open] summary::before{transform:rotate(90deg)}
.metric{font:12px ui-monospace,Menlo,monospace;color:#6e6e73;margin-left:auto;white-space:nowrap}.pri{font-size:11px;padding:1px 7px;border-radius:5px;background:#eef2ff;color:#3b4fd8}.pri.高{background:#fde8e8;color:#b42318}
details p{margin:8px 0 4px 18px;color:#3a3a3c}.ev{margin-left:18px;font:12px ui-monospace,Menlo,monospace;color:#98989d}.action{margin:6px 0 0 18px;padding:8px 12px;background:#f6f6f4;border-radius:8px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}td,th{padding:5px 8px;text-align:right;border-bottom:1px solid #f0f0f0}th:first-child,td:first-child{text-align:left}
@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}section,.head{background:#2c2c2e;border-color:#3a3a3c}section>p,details p,.head{color:#d1d1d6}details{border-color:#3a3a3c}td,th{border-color:#3a3a3c}.action{background:#1c1c1e}}"""


def render_html(rec):
    rep = rec["report"]
    parts = [f"<!doctype html><meta charset=utf-8><title>洞察 · {escape(rec['created_at'])}</title><style>{CSS}</style><main>",
             f"<h1>跨 Agent 洞察报告</h1><div class=meta>生成于 {escape(rec['created_at'])} · 最近 {rec['days']} 天 · {rec['session_count']} 个会话（摘要含 {rec.get('digest_sessions', 0)} 个）· 模型 {escape(rec.get('model') or '')} · 用时 {rec.get('duration_s', 0)} 秒</div>",
             f"<p class=head>{escape(rep.get('headline', ''))}</p>", charts_html(rec)]
    for s in rep["sections"]:
        parts.append(f"<section><h2>{escape(s.get('title', ''))}</h2><p>{escape(s.get('summary', ''))}</p>")
        for it in s.get("items", []):
            pri = it.get("priority")
            parts.append("<details><summary>" + escape(str(it.get("title", ""))) + (f" <span class='pri {escape(pri)}'>{escape(pri)}</span>" if pri else "") + (f"<span class=metric>{escape(str(it['metric']))}</span>" if it.get("metric") else "") + "</summary>")
            if it.get("detail"):
                parts.append(f"<p>{escape(str(it['detail']))}</p>")
            if it.get("action"):
                parts.append(f"<div class=action>改法：{escape(str(it['action']))}</div>")
            if it.get("evidence"):
                parts.append("<div class=ev>会话：" + escape(" · ".join(map(str, it["evidence"]))) + "</div>")
            parts.append("</details>")
        parts.append("</section>")
    sig = rec.get("signals") or {}
    if sig:
        cols = [("sessions", "会话"), ("user_turns", "轮"), ("correction", "纠错"), ("asktail", "问句"), ("ends_on_question", "停问"), ("overflow", "溢出"), ("tool_errors", "报错"), ("no_board", "没上板"), ("long", "超长")]
        parts.append("<section><h2>信号统计（正则计数）</h2><table><tr><th>Agent</th>" + "".join(f"<th>{l}</th>" for _, l in cols) + "</tr>")
        for ag, c in sig.items():
            parts.append(f"<tr><td>{escape(ag)}</td>" + "".join(f"<td>{c.get(k, 0)}</td>" for k, _ in cols) + "</tr>")
        parts.append("</table></section>")
    parts.append("</main>")
    return "".join(parts)


# ---------------------------------------------------------------- CLI

def main(a):
    op = getattr(a, "op", None) or "report"
    if op == "report":
        if running() and not a.force:
            r = running()
            return D.out({"state": "running", "started": r["started"], "days": r["days"]}, a.json, lambda x: print(f"已经在生成（{int(time.time() - x['started'])} 秒前开始），稍等"))
        if a.wait:
            rec = generate(a.days, a.model)
            return D.out(rec, a.json, lambda r: print(r["error"] or f"报告已生成：{os.path.join(DIR, r['id'] + '.html')}\n{r['report']['headline']}"))
        return D.out(spawn(a.days, a.model), a.json, lambda x: print(f"开始生成最近 {x['days']} 天的洞察报告（后台，一般 1-3 分钟）；dispatch insights list 看结果"))
    if op == "list":
        rows = all_reports()
        st = {"running": running(), "schedule": schedule_load(), "reports": rows}
        return D.out(st, a.json, lambda x: [print(f"{r['created_at']}  {'Claude Code' if r['source'] == 'claude-code' else 'dispatch':<11} {str(r['days'] or '-') + ' 天':>6}  {r['headline'] or ('失败：' + r['error'][:80])}") for r in x["reports"]] or print("还没有报告；dispatch insights report 生成一份"))
    if op == "show":
        rec = load_report(a.id or "latest")
        if not rec:
            raise SystemExit("没有这份报告")
        return D.out(rec, a.json, lambda r: print(json.dumps(r["report"], ensure_ascii=False, indent=1)))
    if op == "schedule":
        sc = schedule_load()
        if a.every is not None:
            sc["every_days"] = int(a.every); sc["updated_at"] = time.strftime("%Y-%m-%d %H:%M"); schedule_save(sc)
        return D.out(sc, a.json, lambda x: print(f"自动生成：{'每 %d 天' % x['every_days'] if x.get('every_days') else '关闭'}"))
    if op == "due":
        return D.out(due(), a.json, lambda x: print(x["reason"]))
    if op == "open":
        reps = [r for r in all_reports() if not r["error"] and (not a.id or r["id"] == a.id or r["id"].startswith(a.id))]
        if not reps:
            raise SystemExit("还没有报告")
        D.sh(["open", reps[0]["html"]], timeout=5)
        return D.out({"opened": reps[0]["html"]}, a.json, lambda x: print(x["opened"]))


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[1] == "--worker":
    generate(int(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None)
