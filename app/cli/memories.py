# -*- coding: utf-8 -*-
"""各 Agent 自己的长期记忆 —— `dispatch memories list|show|archive|summary`.

Each agent keeps its own long-term memory (where and in what shape: its adapter's memory_files, memory_where,
memory_rows); Dispatch lists and shows them, can archive one file, and lets the summary model write an overview.
An engine with no memory store (pi, Gemini: sessions + AGENTS.md/GEMINI.md only) never appears here."""
import glob, hashlib, json, os, re, shutil, sys, time

import dispatch as D
import engines as E
from lang import t as _t

# ---------------------------------------------------------------- agent memories (read-only)
def stores():
    """(engine, where its memories are) for each engine that keeps a memory of its own (its adapter's memory_files)."""
    return [(e, pat) for e in E.known() for pat in [e.memory_files(D.HOME)] if pat]


class Context:
    """What placing a memory in a project needs: project names, workspace roots, and lookups an engine makes once."""

    def __init__(self, names, roots):
        self.names, self.roots, self._cache = names, roots, {}

    def once(self, key, fn):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]


def parse_frontmatter(text):
    """(fields, body) of a memory file. Handles both schemas: flat top-level keys, and the nested
    `metadata:` form whose children (node_type / type / originSessionId / modified) are inlined.
    Folded / indented continuation lines are joined with a space. A file with no frontmatter
    (about one in ten) gives ({}, text)."""
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text
    fields, key, in_meta = {}, None, False
    for line in lines[1:end]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indented = line[:1] in (" ", "\t")
        if not indented and ":" in line:
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            in_meta = k == "metadata" and not v
            key = k
            fields[k] = "" if v in (">", "|", ">-", "|-") else v.strip('"').strip("'")
        elif in_meta and ":" in stripped:          # a child of `metadata:`
            k, v = stripped.split(":", 1)
            key = k.strip()
            fields[key] = v.strip().strip('"').strip("'")
        elif key and stripped:                      # folded / indented continuation of the last value
            fields[key] = (fields[key] + " " + stripped).strip()
    for k, v in list(fields.items()):
        if isinstance(v, str):
            fields[k] = re.sub(r"\s+", " ", v).strip('"').strip("'")
    return fields, "\n".join(lines[end + 1:]).lstrip("\n")


def project_name(real, names, roots):
    """Human project for a memory directory: `/` and $HOME are 通用, else the shared workspace /
    known-name / git-root rule, then the folder's own name."""
    if not real:
        return _t("General", "通用")
    real = os.path.normpath(real)
    if real in ("/", os.path.splitdrive(real)[0] + os.sep, os.path.normpath(D.HOME)):
        return _t("General", "通用")
    return D.project_of_cwd(real, names, roots) or os.path.basename(real) or _t("General", "通用")


def memory_entries():
    """Every memory as the Agent 记忆 page lists it: one entry per memory file and per entry of a one-file store
    (Codex's threads), with its project and whether that project directory still exists."""
    ctx = Context(D.project_names(), D.settings_load().get("workspace_roots") or [])
    rows = []
    for eng, pat in stores():
        if eng.memory_one_file:
            rows += eng.memory_rows(pat, ctx) if os.path.isfile(pat) else []
            continue
        for path in sorted(glob.glob(pat)):
            try:
                st = os.stat(path)
                if st.st_size == 0:
                    continue
                text = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            fields, body = parse_frontmatter(text)
            project, project_dir, expired = eng.memory_where(path, ctx)
            rows.append({
                "id": "file:" + path, "agent": eng.agent, "project": project, "project_dir": project_dir,
                "expired": expired, "path": path,
                "name": fields.get("name") or os.path.splitext(os.path.basename(path))[0],
                "description": fields.get("description", ""), "type": fields.get("type", ""),
                "index": os.path.basename(path) == "MEMORY.md", "size": st.st_size,
                "mtime": st.st_mtime, "body": body,
            })
    rows.sort(key=lambda r: (r["agent"], r["project"], r["index"], r["name"]))
    return rows


def memory_entry_fingerprint(entries):
    """Digest of a set of entries (path + mtime + size, plus id for Codex blocks), so the summary
    cache rebuilds as soon as a memory is added, edited or archived."""
    h = hashlib.sha256()
    for e in sorted(entries, key=lambda x: x.get("id", "")):
        h.update(f"{e.get('path', '')}|{e.get('mtime', 0)}|{e.get('size', 0)}|{e.get('id', '')}".encode("utf-8"))
    return h.hexdigest()[:16]


def memory_archive(path):
    """Move one memory file into `<its dir>/archived/<name>`. Only files inside an engine's memory directory can be
    archived; an engine whose memory is one file (Codex) has nothing to move."""
    real = os.path.realpath(path or "")
    if not os.path.isfile(real):
        raise ValueError(_t(f"No such memory file: {path}", f"没有这个记忆文件：{path}"))
    allowed, kept = set(), []
    for eng, pat in stores():
        if eng.memory_one_file:
            if os.path.realpath(pat) == real:
                raise ValueError(_t(f"{eng.name}'s memory is one file; there is no archiving one entry", f"{eng.name} 的记忆是单个文件，没有单文件归档"))
            continue
        allowed |= {os.path.realpath(d) for d in glob.glob(os.path.dirname(pat))}
        kept.append(eng.name)
    if os.path.dirname(real) not in allowed:
        raise ValueError(_t(f"{path} is not in a memory folder (the memory/ of {' / '.join(kept)})", f"{path} 不在记忆目录里（{' / '.join(kept)} 的 memory/）"))
    dest = os.path.join(os.path.dirname(real), "archived", os.path.basename(real))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(real, dest)
    return {"from": path, "to": dest}


MEMORY_SUMMARY_PROMPT_EN = (
    "You summarize agents' long-term memory. The user message lists memory entries by \"agent|project\" (one a line). Summarize in English "
    "and output one JSON object only (not a code block, no extra words). overall is one real overview of the memory, sorted into four kinds: "
    "preferences about me, feedback for the agents, project facts, reference links (leave out kinds with nothing); the keys of projects are the given \"agent|project\" keys, "
    "each value one sentence of at most 30 words about that project, leaving out projects with nothing. Write it from the memory itself; never copy an example.")
MEMORY_SUMMARY_PROMPT = (
    "你是 Agent 长期记忆的总结者。用户消息按「Agent|项目」列出记忆条目（每行一条）。用简体中文总结，"
    "只输出一个 JSON 对象（不是代码块，不要多余文字）。overall 是一段真实的记忆总览，按四类归纳："
    "关于我的偏好、给 Agent 的反馈、项目事实、参考链接（没有内容的类别不写）；projects 的键用给定的「Agent|项目」，"
    "值是该项目不超过 60 字的一句概括，没有内容的项目不写。根据记忆内容自己写，不要照抄任何示例。")


def _memory_summary_material(rows, limit=30000):
    """Descriptions first: they are already one-line human summaries, so the model gets the whole
    picture without the full bodies (which easily blows past the model's context on this machine)."""
    groups = {}
    for r in rows:
        groups.setdefault(f"{r['agent']}|{r['project']}", []).append(r)
    parts = [_t(f"Project keys to summarize: {', '.join(groups) or '(none)'}", f"要总结的项目键：{'、'.join(groups) or '（无）'}")]
    for key, items in groups.items():
        parts.append(f"\n## {key}")
        for r in items:
            text = (r.get("description") or "").strip() or re.sub(r"\s+", " ", r.get("body") or "").strip()[:160]
            meta = r.get("type") or ""
            parts.append(f"- {r['name']}" + (_t(f" ({meta})", f"（{meta}）") if meta else "") + (_t(f": {text}", f"：{text}") if text else ""))
    return "\n".join(parts)[:limit]


def _memory_summary_json(text):
    """The model's JSON object, found defensively: `raw_decode` from the first `{` respects braces
    inside string values (the summary text), which naive brace counting does not."""
    i = (text or "").find("{")
    if i < 0:
        return {}
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[i:])
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _summary_text(v):
    """A summary value may be a string, a list of lines, or a {category: text} object
    (Claude tends to nest the four categories); flatten it to markdown."""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        return "\n".join(f"**{k}**：{_summary_text(x)}" for k, x in v.items()).strip()
    if isinstance(v, list):
        return "\n".join(_summary_text(x) for x in v).strip()
    return str(v).strip() if v else ""


def memory_summary(project="", force=False):
    """One model call writes the overall + per-project one-liners; the result is cached against a
    fingerprint of the entries, so the page only pays for a call when a memory actually changed."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import summarize
    if not summarize.use_enabled("memories"):
        raise RuntimeError(summarize.gate_message("memories"))
    rows = memory_entries()
    feed = [r for r in rows if not project or r["project"] == project]
    fp = memory_entry_fingerprint(feed)
    cache_path = os.path.join(D.DISPATCH_DIR, "memory-summaries.json")
    try:
        cache = json.load(open(cache_path, encoding="utf-8"))
    except Exception:
        cache = None
    valid = {f"{r['agent']}|{r['project']}" for r in feed}
    if cache and not force and cache.get("fingerprint") == fp and (cache.get("overall") or cache.get("projects")):
        projects = {k: v for k, v in (cache.get("projects") or {}).items() if k in valid}
        return {"at": cache.get("at", 0), "model": cache.get("model", ""), "cached": True,
                "fingerprint": fp, "overall": cache.get("overall", ""), "projects": projects}
    p = summarize.provider("")
    if not p:
        raise RuntimeError(_t("No model to use: put ZHIPU_API_KEY (Zhipu GLM) in dispatch env, or use a Claude subscription", "没有可用的模型：在 dispatch env 里放 ZHIPU_API_KEY（智谱 glm），或用 Claude 订阅"))
    text = summarize.chat(p, _t(MEMORY_SUMMARY_PROMPT_EN, MEMORY_SUMMARY_PROMPT), _memory_summary_material(feed), timeout=180, max_tokens=4000, use="memories")
    parsed = _memory_summary_json(text or "")
    overall = _summary_text(parsed.get("overall"))
    projects = {k: _summary_text(v) for k, v in (parsed.get("projects") or {}).items() if k in valid}
    projects = {k: v for k, v in projects.items() if v}
    model = f"{p['id']}:{p['model']}"
    rec = {"at": int(time.time()), "model": model, "fingerprint": fp, "overall": overall, "projects": projects}
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        json.dump(rec, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
    except OSError:
        pass
    return {"at": rec["at"], "model": model, "cached": False, "fingerprint": fp,
            "overall": overall, "projects": projects}


def _memory_summary_text(r):
    print(r.get("overall") or _t("(no summary)", "（没有总结）"))
    for k, v in sorted((r.get("projects") or {}).items()):
        print(f"{k}" + _t(": ", "：") + f"{v}")


def cmd_memories(a):
    if a.op == "archive":
        try:
            res = memory_archive(a.path)
        except ValueError as e:
            print(str(e), file=sys.stderr); sys.exit(2)
        D.out(res, a.json, lambda r: print(_t(f"Archived: {r['from']} → {r['to']}", f"已归档：{r['from']} → {r['to']}")))
        return
    if a.op == "summary":
        try:
            res = memory_summary(project=getattr(a, "project", ""), force=getattr(a, "force", False))
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False) if a.json else f"✗ {e}", file=sys.stderr); sys.exit(1)
        D.out(res, a.json, _memory_summary_text)
        return
    rows = memory_entries()
    if a.op == "show":
        want = os.path.realpath(a.path or a.query)
        hit = next((r for r in rows if os.path.realpath(r["path"]) == want), None)
        if not hit:
            print(_t(f"{a.path or a.query} is not among the memory files (`dispatch memories list`)", f"{a.path or a.query} 不在记忆文件列表里（`dispatch memories list`）"), file=sys.stderr); sys.exit(2)
        t = open(hit["path"], encoding="utf-8", errors="replace").read()
        print(json.dumps({**hit, "content": t}, ensure_ascii=False) if a.json else t, end="" if (t.endswith("\n") and not a.json) else "\n")
        return
    if a.agent:
        rows = [r for r in rows if r["agent"] == a.agent]
    D.out(rows, a.json, lambda rs: [print(f"{r['agent']:<12} {r['project']:<40} {r['name']:<36} {r['size']:>6}  {time.strftime('%m-%d %H:%M', time.localtime(r['mtime']))}") for r in rs] or print(_t(f"\n{len(rs)} memory files", f"\n{len(rs)} 个记忆文件")))
