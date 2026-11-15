# -*- coding: utf-8 -*-
"""`dispatch flow design | pick | finish | show`: fixed flows several agents run together.

Design first (设计先行, the user's rule for interface and product work):

  1. `dispatch flow design <task> [--brief F]` runs the `designer` definition (~/.dispatch/agents/
     designer.md, `dispatch agent run`) in the task's project: a diagnosis of what is there now,
     two directions as clickable prototypes with real data (proto-*.html), and a notes.md whose
     direction headings are `## 方向 A: <name>` / `## 方向 B: <name>`; `dispatch deliver --kind
     proposal` makes the one delivery page from them (deliver.py, one template for every delivery).
     Output: <project>/design/<name>/redesign/ index.html, notes.md (or README.md), preview.png.
  2. `finish` (run by `design` once the designer is done, or by hand) delivers the generated page to
     the task, registers that page in the project's Docs, and puts the task into Waiting for you
     as a Decide row, "Pick a direction: A / B" (label dispatch:decide, metadata `flow`).
  3. The person picks in Waiting for you, or `dispatch flow pick <task> A --reason "…"`: the pick
     is remembered as a preference (prefs.py: a Like of the picked direction, the reason as their
     words, the prototype as the part; the other directions are not Avoids), an implementation task
     is made that cites the direction and the prototype, and the design task is done. FACTS.md
     「我的设计偏好」is not written any more: the preferences were imported from it.

The task's metadata carries the flow:

    flow  {"kind": "design", "state": running | deciding | picked | failed, "dir", "prototype",
           "readme", "preview", "options": [{"key", "title"}], "session", "picked", "reason", "impl"}
"""
import json, os, re, subprocess, sys, time

import ownership
import tasks_view as T
from lang import t as _t

D = None  # dispatch.py, bound by run()

DECIDE = "dispatch:decide"
WAITING = "dispatch:waiting"
DIRECTION = re.compile(r"^#{2,3}\s*(?:方向\s*|Direction\s+)?([A-F])\s*[:：.、·)）-]\s*(.+?)\s*$", re.M)

PROMPT_EN = """Design first (dispatch flow design). Task: "{title}" ({tid})

The request as written:
{desc}
{brief}
What to hand in, all of it under {out}/:
1. Look at what exists first: write a diagnosis against real screenshots (what is wrong and why), conclusions from the screenshots only. Screenshots go in {out}/shots/.
2. Make two directions, A and B, each a clickable prototype as a one-file HTML under {out}/ (proto-a.html and proto-b.html, or one file that switches screens by an address such as #scene=a1), with real data (from the dispatch CLI or the project's files), working offline and following the page's light and dark (read #theme= in the address and the dispatch-theme message, as the delivery-page skill shows); interface words follow the language the project's DESIGN.md asks for. Do not hand-write a whole index.html: the delivery page is made by `dispatch deliver` from one template, with the prototypes embedded.
3. Write {out}/notes.md (format in the delivery-page skill): the title on the first line, the conclusion as bullets under it; one section per direction, titled exactly "## Direction A: <name>" and "## Direction B: <name>", the name in the interface's language, at most 4 English words or 8 Chinese characters (the person picks by this name in Waiting for you), saying what it is, what is good about it and what it costs, with the prototype embedded as `![caption](proto-a.html#size=1440x887)`; "## Diagnosis" with real screenshots and numbered red boxes; a last section "## Recommendation".
4. Run `dispatch deliver {tid} --from {out} --kind proposal --model "<your model> · <effort>"` to make {out}/index.html (it files it in Docs, attaches it to the task and puts it in Waiting for you), then save a screenshot of index.html as {out}/preview.png (1440 wide).
Change no project code, commit nothing, make no task; write only files under {out}. When done, report the paths of these files."""
PROMPT = """设计先行流程（dispatch flow design）。任务：「{title}」（{tid}）

需求原文：
{desc}
{brief}
要交的东西，全部写在 {out}/ 下：
1. 先看现状：对着真实截图写诊断（哪里不好、为什么），只看截图下结论。截图放进 {out}/shots/。
2. 出两个方向 A 和 B，各做成一个可点的原型，写成 {out}/ 下的单文件 HTML（proto-a.html、proto-b.html，或一个文件按 #scene=a1 这样的地址切屏），用真实数据（从 dispatch CLI 或项目文件里取），离线能开，跟着页面的浅色深色（读地址里的 #theme= 和 dispatch-theme 消息，写法见 delivery-page 技能）；界面文案照项目 DESIGN.md 的语言要求。不要再手写整页 index.html：交付页由 `dispatch deliver` 用统一模板生成，原型嵌进去。
3. 写 {out}/notes.md（格式见 delivery-page 技能）：第一行是标题，下面结论写成 bullet；每个方向一节，标题严格写成「## 方向 A: <方向名>」「## 方向 B: <方向名>」，方向名用界面的语言，4 个英文词或 8 个汉字以内（Waiting for you 里用户就看这个名字选），节里写它是什么、好在哪、代价，并用 `![说明](proto-a.html#size=1440x887)` 把原型嵌进来；「## 诊断」用真机截图加编号红框；最后一节「## 推荐」。
4. 跑 `dispatch deliver {tid} --from {out} --kind proposal --model "<你的模型> · <档位>"` 生成 {out}/index.html（登记 Docs、挂到任务、进 Waiting for you 都由它做），再把 index.html 截一张图存成 {out}/preview.png（宽 1440）。
不改项目代码，不提交，不建任务，只写 {out} 下的文件。做完回报这几个文件的路径。"""


# ---------------------------------------------------------------- small helpers

def _sh(args, timeout=60):
    if D is not None:
        return D.sh(args, timeout=timeout)
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def _bd_json(argv):
    code, o, err = _sh(["bd", *argv])
    if code != 0:
        raise ValueError((err or o).strip() or f"bd {argv[0]} failed")
    s = o[min([i for i in (o.find("["), o.find("{")) if i >= 0] or [0]):]
    try:
        d = json.loads(s)
    except ValueError:
        return {}
    return d[0] if isinstance(d, list) and d else d


def slug(text):
    words = re.findall(r"[A-Za-z0-9]+", text or "")
    return "-".join(w.lower() for w in words)[:40].strip("-")


def flow_of(issue):
    f = T.meta(issue).get("flow")
    return f if isinstance(f, dict) else {}


def git_root(path):
    try:
        r = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def project_root(issue, given=""):
    """Where design/ goes: --project, else the git repository here, else the project's home."""
    if given:
        return os.path.abspath(os.path.expanduser(given))
    here = git_root(os.getcwd())
    if here:
        return here
    proj = T.project_of(issue)
    if D is not None and proj:
        home = D.project_home(proj)
        if home:
            return home
    raise ValueError("no project folder: run it in the repository or pass --project DIR")


def directions(readme_text):
    """[{"key": "A", "title": "…"}] from the README's `## A: …` headings, in order, one per key."""
    out = []
    for key, title in DIRECTION.findall(readme_text or ""):
        if key not in [o["key"] for o in out]:
            out.append({"key": key, "title": title.strip().strip("*「」\"")[:60]})
    return out


def phrase(options):
    return "Pick a direction: " + " / ".join(o["key"] for o in options)


def screenshot(html, png, width=1440, height=900):
    """preview.png when the designer did not leave one: headless Chrome, if it is installed."""
    import prefs
    return prefs.page_shot(html, png, width, height)


# ---------------------------------------------------------------- design

def design(tid, brief="", name="", project="", engine="claude", timeout_ms=3600000, agent_run=None):
    issue = T.show_issue(tid)
    root = project_root(issue, project)
    name = name or (slug(issue.get("title")) if len(slug(issue.get("title"))) >= 6 else "") or tid
    out = os.path.join(root, "design", name, "redesign")
    os.makedirs(out, exist_ok=True)
    brief_text = ""
    if brief:
        with open(os.path.expanduser(brief), encoding="utf-8") as f:
            brief_text = _t("\nMore notes (" + os.path.basename(brief) + "):\n", "\n补充说明（" + os.path.basename(brief) + "）：\n") + f.read().strip() + "\n"
    prompt = _t(PROMPT_EN, PROMPT).format(title=issue.get("title") or tid, tid=tid, desc=(issue.get("description") or "").strip() or _t("(none)", "（无）"),
                           brief=brief_text, out=out)
    T.set_meta(tid, flow={"kind": "design", "state": "running", "dir": out, "at": int(time.time())})
    if agent_run is None:
        import agents_defs
        agent_run = agents_defs.run
    try:
        res = agent_run("designer", prompt, project=root, engine=engine, timeout_ms=timeout_ms, auto=True)
    except SystemExit as e:
        T.set_meta(tid, flow={"kind": "design", "state": "failed", "dir": out, "error": str(e)[:300], "at": int(time.time())})
        raise ValueError(f"designer did not run: {e}")
    return finish(tid, out, session=res.get("session", ""), result_file=res.get("result_file", ""))


def finish(tid, out="", session="", result_file=""):
    """Deliver what the designer made and ask the person to pick."""
    issue = T.show_issue(tid)
    f = flow_of(issue)
    out = os.path.abspath(os.path.expanduser(out or f.get("dir") or ""))
    html, readme, png = (os.path.join(out, n) for n in ("index.html", "README.md", "preview.png"))
    if os.path.isfile(os.path.join(out, "notes.md")):
        readme = os.path.join(out, "notes.md")  # the delivery page's source (delivery-page skill) stands in for a README
    if not os.path.isfile(html) or not os.path.isfile(readme):
        missing = [os.path.basename(p) for p in (html, readme) if not os.path.isfile(p)]  # README.md or notes.md
        T.set_meta(tid, flow=dict(f, kind="design", state="failed", dir=out, error="missing " + ", ".join(missing), at=int(time.time())))
        raise ValueError(f"the designer left no {' / '.join(missing)} in {out}" + (f" (its report: {result_file})" if result_file else ""))
    if not os.path.isfile(png):
        screenshot(html, png)
    with open(readme, encoding="utf-8") as fh:
        options = directions(fh.read())
    if len(options) < 2:
        options = [{"key": "A", "title": ""}, {"key": "B", "title": ""}]
    now = int(time.time())
    items = T.clean_deliverables(T.meta(issue).get("deliverables"))
    with open(html, encoding="utf-8") as fh:
        generated = '<meta name="generator" content="dispatch deliver">' in fh.read(4096)
    outputs = ((html, "Proposal"),) if generated else ((html, "Prototype"), (readme, "Design notes"), (png, "Preview"))
    for path, label in outputs:
        if os.path.isfile(path):
            items = [x for x in items if x["ref"] != path] + [{"kind": "file", "ref": path, "label": label, "at": now}]
    flow = {"kind": "design", "state": "deciding", "dir": out, "prototype": html, "readme": readme,
            "preview": png if os.path.isfile(png) else "", "options": options, "session": session or f.get("session", ""),
            "result": result_file or f.get("result", ""), "at": now}
    T.set_meta(tid, deliverables=items, flow=flow)
    _sh(["bd", "update", tid, "--add-label", DECIDE, "--add-label", WAITING, "--json"])
    proj = T.project_of(issue)
    if D is not None:
        if proj:
            try:
                D.docs_register(proj, html if generated else readme, kind="设计")
            except Exception:
                pass
        D.phone_push("notify_needs_you", phrase(options), issue.get("title") or tid, f"/#/board/task/{tid}", level="high")
    return {"ok": True, "task": tid, "title": issue.get("title") or "", "state": "deciding", "options": options,
            "prototype": html, "readme": readme, "preview": flow["preview"], "phrase": phrase(options)}


# ---------------------------------------------------------------- pick

def remember_pick(title, key, chosen, reason, prototype, proj, preview=""):
    """The pick as a preference: a Like of the picked direction in the task's project, the reason as
    the person's words, the prototype's direction as the part it hangs on."""
    import prefs
    if D is not None:
        prefs.D = D
    item = {"text": _t(f"\"{title}\" is done the way of direction {key}, \"{chosen.get('title') or key}\".", f"「{title}」按方向 {key}「{chosen.get('title') or key}」做。"), "polarity": "like", "area": "design",
            "name": (chosen.get("title") or f"{title} {key}")[:24], "scope": proj or "everywhere", "quote": reason,
            "part": f"{prototype}#{key}" if prototype else "", "evidence": [preview] if preview and os.path.exists(preview) else []}
    res = prefs.add(item, cwd=os.path.dirname(prototype) if prototype else None)
    return res["remembered"][0] if res["remembered"] else {}


def pick(tid, key, reason=""):
    issue = T.show_issue(tid)
    f = flow_of(issue)
    if f.get("kind") != "design" or f.get("state") != "deciding":
        raise ValueError(f"{tid} is not waiting for a direction (state: {f.get('state') or 'none'})")
    key = (key or "").strip().upper()
    options = f.get("options") or []
    chosen = next((o for o in options if o["key"] == key), None)
    if not chosen:
        raise ValueError(f"pick one of {', '.join(o['key'] for o in options)}")
    title = issue.get("title") or tid
    reason = " ".join((reason or "").split())
    # the implementation task: same project and session line, carries the design task on
    proj = T.project_of(issue)
    pref = remember_pick(title, key, chosen, reason, f.get("prototype", ""), proj, f.get("preview", ""))
    labels = [l for l in T.labels_of(issue) if l.startswith(("project:", "host:", "session-origin:"))]
    impl_title = f"Implement direction {key}: {title}"
    if D is not None:
        impl_title = D.trim_title(impl_title)[0]
    desc = _t(f"Design first ({tid}) picked direction {key}, \"{chosen['title']}\"." + (f"\nWhy: {reason}" if reason else "") +
              f"\nPrototype: {f.get('prototype', '')}\nDesign notes: {f.get('readme', '')}\n\nBuild direction {key} as the prototype shows, with existing components only; when done, have the designer review real screenshots.",
              f"设计先行（{tid}）选定方向 {key}「{chosen['title']}」。" + (f"\n理由：{reason}" if reason else "") +
              f"\n原型：{f.get('prototype', '')}\n设计说明：{f.get('readme', '')}\n\n照原型里方向 {key} 实现，界面只用现成组件；做完请 designer 对真实截图复审。")
    argv = ["create", impl_title, "-t", "task", "-p", "2", "--description", desc, "--deps", f"discovered-from:{tid}", "--json"]
    if labels:
        argv += ["-l", ",".join(labels)]
    impl = _bd_json(argv)
    impl_id = impl.get("id") or ""
    if impl_id:
        T.set_meta(impl_id, follows=tid)
    T.set_meta(tid, flow=dict(f, state="picked", picked=key, reason=reason, impl=impl_id, picked_at=int(time.time())))
    _sh(["bd", "update", tid, "--remove-label", DECIDE, "--remove-label", WAITING, "--json"])
    _sh(["bd", "close", tid, "--reason", f"Picked direction {key}: {chosen['title']}".strip().rstrip(":"), "--json"])
    try:
        ownership.forget(tid)
    except Exception:
        pass
    return {"ok": True, "task": tid, "picked": key, "option": chosen, "reason": reason, "preference": {"id": pref.get("id", ""), "name": pref.get("name", ""), "text": pref.get("text", "")}, "project": proj,
            "impl": {"id": impl_id, "title": impl_title}, "message": f"Picked {key}" + (f": {chosen['title']}" if chosen["title"] else "")}


# ---------------------------------------------------------------- the command

def spawn_background(a):
    """`flow design --bg`: the same command detached, its output in <DISPATCH_DIR>/flows/<task>.log."""
    d = os.path.join(D.DISPATCH_DIR if D is not None else ownership.dispatch_dir(), "flows")
    os.makedirs(d, exist_ok=True)
    log = os.path.join(d, f"{a.task}.log")
    argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "flow", "design", a.task, "--json"]
    for flag, val in (("--brief", a.brief), ("--name", a.name), ("--project", a.project), ("--engine", a.engine)):
        if val:
            argv += [flag, os.path.abspath(os.path.expanduser(val)) if flag in ("--brief", "--project") else val]
    with open(log, "a", encoding="utf-8") as fh:
        p = subprocess.Popen(argv, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True, cwd=os.getcwd())
    return {"ok": True, "task": a.task, "state": "running", "pid": p.pid, "log": log,
            "message": f"designer started in the background; when it is done the task waits for you to pick (log: {log})"}


def text_of(r):
    if r.get("message"):
        return r["message"]
    if r.get("state") == "deciding":
        return f"{r['phrase']}\n" + "\n".join(f"  {o['key']}: {o['title']}" for o in r["options"]) + f"\nprototype: {r['prototype']}"
    return json.dumps(r, ensure_ascii=False)


def command(a):
    if not a.task:
        raise ValueError("dispatch flow design|pick|finish|show <task>")
    if a.op == "design":
        if getattr(a, "bg", False):
            return spawn_background(a)
        return design(a.task, a.brief or "", a.name or "", a.project or "", a.engine or "claude", a.timeout)
    if a.op == "finish":
        return finish(a.task, a.dir or "")
    if a.op == "pick":
        return pick(a.task, a.option or "", a.reason or "")
    if a.op == "show":
        issue = T.show_issue(a.task)
        return dict(flow_of(issue), ok=True, task=a.task, title=issue.get("title") or "")
    raise ValueError(f"unknown op {a.op}")


def run(a, d_module=None):
    global D
    if d_module is not None:
        D = d_module
        T.D = d_module
    try:
        r = command(a)
    except ValueError as e:
        if a.json:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        else:
            print(str(e), file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print(text_of(r))
    return 0
