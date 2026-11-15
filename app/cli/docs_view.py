# -*- coding: utf-8 -*-
"""`dispatch docs list | add | seen | rm` as the Docs tab of the Agents window reads them
(design/docs-tab/redesign, direction A; Dispatch IDE patches/435-docs.patch).

dispatch.py keeps the storage (one bd memory per project, `docs_registered` / `docs_save`) and the
scan of design/, docs/ and 研究/. This module turns those rows into the list the tab shows:

  * one row per document: a README.md and the index.html next to it are one row (the page is the
    row's `attachments`), a copy in a git worktree or on another Mac (/Users/<someone>/Projects/<p>/…)
    is not listed next to the local file, a file that is gone is not listed, "Remove from Docs"
    leaves a tombstone so a scanned file stays out;
  * `group`: delivered | design | research | notes, the tab's four groups (Delivered, Designs, Reviews,
    Notes; `shelf`), and `today`; the tab's picker is Today, one group, or All (`FILTERS`);
  * `display_title`: the title without a trailing bookkeeping bracket, （task-aenb）,（A 组，2026-09-27）;
  * `tasks`: [{id, title, status, delivered_at}] the tasks it was delivered for (a task's `file`
    deliverables, and `docs add --task`), newest first; `delivered_at` the newest of those;
  * `session` (the conversation that registered it), `in_session` (for `--session`), `unseen`;
  * `where`: the 00-where.json next to it (the numbered boxes of its "Where to look" picture).

The entry kept per registered document: {id, path, title, kind, added_at} plus
tasks [ids], session, delivered_at, seen_at, hidden.
"""
import json, os, re, time
from lang import t as _t

D = None  # the dispatch module, bound by the caller

GROUPS = ("delivered", "design", "research", "notes")
WHERE_JSON = "00-where.json"
UNSEEN_DAYS = 3  # a delivery older than this is not bold any more, seen or not

_BOOKKEEPING = re.compile(r"\s*[（(]([^（）()]*)[）)]\s*$")
_BOOK_PART = re.compile(r"^(task-[a-z0-9]{2,8}|\d{4}-\d{2}-\d{2}|[A-Za-z0-9]{1,3}\s*组|完成|草稿|wip)$", re.I)
_DELIVERED_PATH = re.compile(r"/(impl|phase1|codepilot-impl)(/|$)")
_DELIVERED_TITLE = ("真机截图", "实现截图", "真机验收", "实机验收")
_RESEARCH_TITLE = ("调研", "复审", "审读", "复核")
_NOTES_FILE = re.compile(r"^(DECISIONS|PLAN|NOTES)(\.[a-z]+)?$", re.I)
_NOTES_TITLE = ("定稿", "设计偏好", "实施计划")
_WORKTREE = re.compile(r"/\.claude/worktrees/[^/]+/|/[^/]+\.worktrees/[^/]+/")
_PROJECTS = re.compile(r"/(?:Users|home)/[^/]+/Projects/([^/]+)/(.+)$")

# A delivery: one `dispatch deliver` page (its head says so) and the source documents that produced
# it. The page is the row the Docs tab shows; notes.md / README.md / a same-title .md next to it hang
# under it (its `sources`) and are not listed again.
_PAGE_HTML = ("index.html", "index.htm")
SOURCE_NAMES = ("readme.md", "notes.md")
_GENERATOR = re.compile(r'<meta\s+name="generator"\s+content="dispatch deliver"', re.I)


def plain_title(title):
    """A heading's inline Markdown as the words it shows: `code`, **bold**, *em*, [text](link)."""
    t = (title or "").strip()
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"(\*\*|__)(.+?)\1", r"\2", t)
    t = re.sub(r"(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def display_title(title):
    """「任务模块真机截图（task-ha7k，2026-09-27）」→「任务模块真机截图」: a trailing bracket that holds
    only task ids, dates and group names goes; a bracket that says something stays."""
    t = plain_title(title)
    m = _BOOKKEEPING.search(t)
    if m and t[:m.start()].strip():
        parts = [p.strip() for p in re.split(r"[，,、;；\s]\s*", m.group(1)) if p.strip()]
        # "A 组" splits into "A" and "组": glue a lone 组 back onto the part before it
        glued = []
        for p in parts:
            if p == "组" and glued:
                glued[-1] += " 组"
            else:
                glued.append(p)
        if glued and all(_BOOK_PART.match(p) for p in glued):
            return t[:m.start()].rstrip()
    return t


def group_of(row):
    kind = row.get("kind") or ""
    path = row.get("path") or ""
    title = row.get("title") or ""
    name = os.path.basename(path)
    if kind in ("交付", "截图"):
        return "delivered"
    if kind in ("调研", "复审") or any(w in title for w in _RESEARCH_TITLE):
        return "research"
    if _DELIVERED_PATH.search(path) or any(w in title for w in _DELIVERED_TITLE):
        return "delivered"
    if _NOTES_FILE.match(name) or any(w in title for w in _NOTES_TITLE):
        return "notes"
    if kind == "设计":
        return "design"
    return "notes"


def is_delivery_page(path):
    """A `dispatch deliver` page: an .html whose head carries the generator meta (index.html, or the
    name --out gave it)."""
    if not path or os.path.splitext(path)[1].lower() not in (".html", ".htm"):
        return False
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return bool(_GENERATOR.search(f.read(4096)))
    except OSError:
        return False


_DELIVERY_KIND = re.compile(r'<meta\s+name="dispatch-delivery"\s+content="(impl|proposal)"', re.I)


def delivery_kind(path):
    """A delivery page's own word for itself: "impl" (what was built) or "proposal" (a design), else ""."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(4096)
    except OSError:
        return ""
    m = _DELIVERY_KIND.search(head) if _GENERATOR.search(head) else None
    return m.group(1).lower() if m else ""


def delivery_page_in(folder):
    """The delivery page the folder's source documents belong to: index.html first, else any page."""
    if not os.path.isdir(folder):
        return ""
    for n in _PAGE_HTML:
        p = os.path.join(folder, n)
        if os.path.isfile(p) and is_delivery_page(p):
            return p
    for n in sorted(os.listdir(folder)):
        p = os.path.join(folder, n)
        if os.path.isfile(p) and is_delivery_page(p):
            return p
    return ""


def page_for(path):
    """The delivery page a source document belongs to; '' for a page itself and for anything else."""
    if os.path.splitext(path)[1].lower() in (".html", ".htm"):
        return ""
    page = delivery_page_in(os.path.dirname(path))
    if not page:
        return ""
    name = os.path.basename(path).lower()
    if name in SOURCE_NAMES:
        return page
    if is_source_md(name) and D is not None and \
            title_key({"title": D.docs_title(path)}) == title_key({"title": D.docs_title(page)}):
        return page
    return ""


def title_key(r):
    """A row's title for matching: the words the list shows, without bookkeeping brackets."""
    return display_title(r.get("title") or "") or (r.get("title") or "")


def is_page_row(r):
    if r.get("url") or r.get("host"):
        return False
    if r.get("kind") in ("交付", "截图") and os.path.splitext(r["path"])[1].lower() in (".html", ".htm"):
        return True
    return is_delivery_page(r.get("path") or "")


def is_source_md(name):
    return os.path.splitext(name)[1].lower() in (".md", ".markdown")


def source_paths(row):
    out = []
    for p in row.get("sources") or []:
        if isinstance(p, str) and p and p not in out:
            out.append(p)
    return out


def copy_key(path):
    """The same document wherever it is: a worktree copy and a copy under another Mac's home
    (registered there, /Users/apple/Projects/kanban/…) share the key of the local file."""
    p = _WORKTREE.sub("/", path or "")
    m = _PROJECTS.search(p)
    return f"{m.group(1)}/{m.group(2)}" if m else p


def _is_copy(path):
    """A path that is not the canonical local file: in a worktree, or under another home."""
    if _WORKTREE.search(path or ""):
        return True
    home = os.path.expanduser("~")
    return bool(_PROJECTS.search(path or "")) and not (path or "").startswith(home + "/")


def task_index(issues, T):
    """{realpath: [(task row, delivered_at)]} from every task's file / draft deliverables."""
    idx, by_id = {}, {}
    for t in issues:
        if not t.get("id"):
            continue
        by_id[t["id"]] = t
        for d in T.clean_deliverables(T.meta(t).get("deliverables")):
            if d["kind"] not in ("file", "draft") or not d["ref"].startswith("/"):
                continue
            ref = os.path.realpath(d["ref"])
            if os.path.isdir(ref):
                ref = os.path.join(ref, "README.md")
            idx.setdefault(ref, []).append((t, d.get("at") or 0))
    return idx, by_id


def _task_json(t, at, T):
    return {"id": t["id"], "title": t.get("title") or "", "status": T.status_of(t), "delivered_at": int(at or 0),
            "sessions": T.sessions_of(t)}


def link_tasks(rows, issues, T):
    """Each row's tasks: deliverables pointing at it (or at the page folded into it), and the ids
    `docs add --task` put on its entry."""
    idx, by_id = task_index(issues, T)
    for r in rows:
        seen, out = set(), []
        paths = [r["path"]] + [a["path"] for a in r.get("attachments") or []] + source_paths(r)
        for p in paths:
            for t, at in idx.get(os.path.realpath(p), []):
                if t["id"] not in seen:
                    seen.add(t["id"]); out.append(_task_json(t, at, T))
        for tid in r.get("tasks_registered") or []:
            if tid in seen or tid not in by_id:
                continue
            seen.add(tid)
            out.append(_task_json(by_id[tid], r.get("delivered_at") or r.get("mtime") or 0, T))
        out.sort(key=lambda x: -x["delivered_at"])
        r["tasks"] = out
        if out:
            r["delivered_at"] = max(int(r.get("delivered_at") or 0), out[0]["delivered_at"])
    return rows


def absorb_source(host, r):
    """A source document goes under the delivery page: its tasks, times, session and files carry."""
    host["tasks_registered"] = list(dict.fromkeys((host.get("tasks_registered") or []) + (r.get("tasks_registered") or [])))
    host["delivered_at"] = max(int(host.get("delivered_at") or 0), int(r.get("delivered_at") or 0))
    host["seen_at"] = max(int(host.get("seen_at") or 0), int(r.get("seen_at") or 0))
    host["mtime"] = max(host.get("mtime") or 0, r.get("mtime") or 0)
    if not host.get("session") and r.get("session"):
        host["session"] = r["session"]
    kinds = (host.get("kind") or "", r.get("kind") or "")
    if "交付" in kinds or "截图" in kinds:
        host["kind"] = "交付"
    elif not host.get("kind"):
        host["kind"] = r.get("kind") or ""
    if not (host.get("title") or "").strip():
        host["title"] = r.get("title") or ""
    srcs = source_paths(host)
    for p in [r["path"]] + source_paths(r):
        if p not in srcs:
            srcs.append(p)
    host["sources"] = srcs
    atts = list(host.get("attachments") or [])
    have = {a.get("path") for a in atts if isinstance(a, dict)}
    for a in r.get("attachments") or []:
        if isinstance(a, dict) and a.get("path") and a["path"] not in have:
            atts.append(a); have.add(a["path"])
    host["attachments"] = atts


def fold(rows, include_all=False):
    """One row per document: copies, gone files, hidden ones out; a delivery is its page, with the
    notes.md / README.md / same-title .md next to it under it (and a folder's hand-made index.html
    folded into its README.md), unless include_all."""
    rows = [r for r in rows if not r.get("url") and not r.get("host")] + [r for r in rows if r.get("url") or r.get("host")]
    if include_all:
        for r in rows:
            r.setdefault("attachments", [])
        return rows
    # copies: the local file wins; its registration's title, kind and tasks carry over
    by_key = {}
    for r in rows:
        if r.get("url") or r.get("host"):
            continue
        by_key.setdefault(copy_key(r["path"]), []).append(r)
    drop = set()
    for key, same in by_key.items():
        if len(same) < 2:
            continue
        keep = next((r for r in same if not _is_copy(r["path"]) and os.path.isfile(r["path"])), None) or \
            next((r for r in same if os.path.isfile(r["path"])), same[0])
        for r in same:
            if r is keep:
                continue
            drop.add(id(r))
            if r.get("source") == "registered":
                for k in ("title", "kind", "session"):
                    if r.get(k) and not (keep.get("source") == "registered" and keep.get(k)):
                        keep[k] = r[k]
                keep["tasks_registered"] = list(dict.fromkeys((keep.get("tasks_registered") or []) + (r.get("tasks_registered") or [])))
    out = []
    for r in rows:
        if id(r) in drop or r.get("hidden"):
            continue
        if not r.get("url") and not r.get("host") and not os.path.isfile(r["path"]):
            continue
        out.append(r)
    for r in out:
        r.setdefault("attachments", [])
        r.setdefault("sources", [])
    # a delivery page and its sources are one row, and the page is it: the notes.md / README.md / md
    # with the same title next to it are not listed again
    pages = {}
    for r in out:
        if is_page_row(r):
            pages.setdefault(os.path.dirname(r["path"]), []).append(r)
    drop = set()
    for r in out:
        if id(r) in drop or is_page_row(r) or not is_source_md(os.path.basename(r["path"])):
            continue
        same = [p for p in pages.get(os.path.dirname(r["path"]), []) if p is not r]
        if not same:
            continue
        exact = [p for p in same if title_key(p) == title_key(r)]
        if exact:
            host = exact[0]
        elif os.path.basename(r["path"]).lower() == "readme.md" and len(same) == 1:
            host = same[0]
        else:
            continue
        absorb_source(host, r)
        drop.add(id(r))
    # a folder's README.md and a hand-made index.html: one row, the page is an attachment
    readme = {os.path.dirname(r["path"]): r for r in out if id(r) not in drop and not r.get("url") and os.path.basename(r["path"]).lower() == "readme.md"}
    rows2 = []
    for r in out:
        if id(r) in drop:
            continue
        d = os.path.dirname(r["path"]) if not r.get("url") else ""
        if d in readme and readme[d] is not r and os.path.basename(r["path"]).lower() in ("index.html", "index.htm"):
            host = readme[d]
            host["attachments"].append({"path": r["path"], "title": r.get("title") or "", "kind": "prototype"})
            host["mtime"] = max(host.get("mtime") or 0, r.get("mtime") or 0)
            if r.get("tasks_registered"):
                host["tasks_registered"] = list(dict.fromkeys((host.get("tasks_registered") or []) + r["tasks_registered"]))
            continue
        rows2.append(r)
    return rows2


def decorate(rows, session="", now=None):
    now = now or time.time()
    sid = _session_key(session)
    counts = {g: 0 for g in GROUPS}
    for r in rows:
        r["group"] = shelf(r) or group_of(r)
        counts[r["group"]] += 1
        r["display_title"] = display_title(r.get("title") or "") or r.get("title") or ""
        r.setdefault("tasks", [])
        r["delivered_at"] = int(r.get("delivered_at") or 0)
        r["seen_at"] = int(r.get("seen_at") or 0)
        r["unseen"] = bool(r["delivered_at"]) and r["seen_at"] < r["delivered_at"] and now - r["delivered_at"] < UNSEEN_DAYS * 86400
        r["today"] = is_today(r, now)
        p = r.get("path") or ""
        r["where"] = where_of(p) if not r.get("url") and not r.get("host") and os.path.splitext(p)[1].lower() in (".md", ".markdown", ".html", ".htm") else None
        r["session"] = r.get("session") or ""
        # the sessions it belongs to, so the Docs tab can tell "This session" from a cached list (ide-ext core/docsQuick.ts)
        mine = [r["session"]] + [s for t in r["tasks"] for s in t.get("sessions") or []]
        r["sessions"] = list(dict.fromkeys(k for k in (_session_key(s) for s in mine if s) if k))
        if sid:
            r["in_session"] = any(k == sid or (len(sid) >= 8 and k.startswith(sid)) for k in r["sessions"])
        r.pop("tasks_registered", None)
    # the newest first: a delivery counts from when it was delivered, anything else from its file
    rows.sort(key=lambda r: -(max(r["delivered_at"], r.get("mtime") or 0)))
    return rows, counts


def where_of(doc_path):
    """The "Where to look" of a document: 00-where.json in its folder, else the .json that
    `dispatch annotate` wrote next to a 00-where*.png. {json, image, size, items} or None."""
    d = os.path.dirname(doc_path)
    cands = [os.path.join(d, WHERE_JSON)] + sorted(
        os.path.join(d, n) for n in (os.listdir(d) if os.path.isdir(d) else [])
        if n.startswith("00-where") and n.endswith(".json") and n != WHERE_JSON)
    for js in cands:
        if not os.path.isfile(js):
            continue
        try:
            with open(js, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and not isinstance(data.get("items"), list) and isinstance(data.get("marks"), list):
            data["items"] = data["marks"]  # the marks JSON (design/annotations/redesign 第 6 节) says marks
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            continue
        # made from e2e marks (dispatch deliver): no picture of its own, every item names its frame
        top = data.get("image") or next((it.get("image") for it in data["items"] if isinstance(it, dict) and it.get("image")), "")
        img = os.path.join(d, str(top or ""))
        if not top or not os.path.isfile(img):
            continue
        if not data.get("image"):
            data["size"] = next((it.get("size") for it in data["items"] if isinstance(it, dict) and it.get("image") == top), None)
        items = []
        for i, it in enumerate(data["items"], 1):
            if not isinstance(it, dict):
                continue
            box = it.get("box")
            if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
                continue
            row = {"n": int(it.get("n") or i), "box": [int(v) for v in box],
                   "what": str(it.get("what") or ""), "where": str(it.get("where") or ""), "how": str(it.get("how") or "")}
            # a delivery page's 00-where.json may put one item on another screenshot of the folder
            other = os.path.join(d, str(it.get("image") or "")) if it.get("image") else ""
            if other and os.path.isfile(other) and os.path.realpath(other) != os.path.realpath(img):
                row["image"] = other
            items.append(row)
        size = data.get("size") if isinstance(data.get("size"), list) and len(data["size"]) == 2 else None
        # boxes already in the picture (dispatch annotate's figure, or "drawn"): the reader only dims
        # around them; on a plain screenshot it rings each one
        drawn = bool(data.get("drawn")) or os.path.basename(img).startswith("00-where")
        return {"json": js, "image": img, "size": size, "items": items, "drawn": drawn}
    return None


def _session_key(s):
    s = (s or "").strip()
    s = re.sub(r"^[a-z][\w+.-]*:/*", "", s, flags=re.I)
    return s.split("?")[0].split("#")[0].rstrip("/").split("/")[-1]


_SCRATCH_PATH = re.compile(r"/design/e2e/|/scratchpad/")
_WORK_PATH = re.compile(r"/design/handoff/|/handoffs/")
_REPORT_NAME = re.compile(r"(^|[-_])report\.md$", re.I)
_PROPOSAL_PAGES = ("index.html", "index.htm", "proposal.html")

# The Docs tab's picker (user 2026-10-01, the filter of the build the mini still runs): Today, then one
# shelf each, then All. Inside each choice the list keeps its groups (Delivered, Designs, Reviews, Notes).
FILTERS = ("today", "delivered", "design", "research", "notes", "all")


def _side_file(r):
    """A proposal's or delivery's side file (verification log, designer notes, a second prototype page):
    it hangs under the page in its folder, never a row of its own."""
    path = r.get("path") or ""
    name = os.path.basename(path).lower()
    if r.get("url") or r.get("host") or name in SOURCE_NAMES or name in _PROPOSAL_PAGES or "/design/" not in path:
        return False
    folder = os.path.dirname(path)
    return any(os.path.isfile(os.path.join(folder, n)) for n in _PROPOSAL_PAGES)


def shelf(r):
    """Which of the four groups a row of the Docs list sits in, or None when it is not a row at all.

    Delivery pages and proposals: Delivered and Designs (the list of 2026-09-29), and so is every other
    prototype page under design/ (proto-a.html next to a proposal, 2026-10-09). Reviews and research
    (复审, 调研, a designer's review.md next to a page): Reviews. Decisions, plans, worker reports,
    briefs and context handoffs: Notes, as the old filter had them (2026-10-01; they still hang on their
    task too). Not rows: test scenarios (design/e2e), scratch files, and a page's side notes."""
    if is_page_row(r):
        group = group_of(r)
        # a page `dispatch deliver` made for what was built is a delivery wherever it sits
        if group in ("design", "notes") and not r.get("url") and delivery_kind(r.get("path") or "") == "impl":
            return "delivered"
        return group
    kind = r.get("kind") or ""
    path = r.get("path") or ""
    name = os.path.basename(path)
    if _SCRATCH_PATH.search(path):
        return None
    if kind in ("handoff", "Handoff", "交接") or _WORK_PATH.search(path):
        return "notes"  # a handoff, a brief, a worker's report (a brief "按 designer 复审改" is no review)
    group = group_of(r)
    if group == "research" or kind == "复审":
        return "research"
    if _REPORT_NAME.search(name) or (r.get("title") or "").rstrip().endswith("报告"):
        return "notes"
    if _side_file(r):
        # a second prototype page next to a proposal (proto-a.html, graphs.html) is a design of its own (user
        # 2026-10-09: "docs 里面的设计稿都去哪了"); its notes and logs still hang under the page
        return "design" if os.path.splitext(name)[1].lower() in (".html", ".htm") else None
    return group


def listed(r):
    """Any row of the Docs list (one of the picker's groups)."""
    return shelf(r) is not None


def is_today(r, now=None):
    """Delivered or changed since local midnight: the picker's Today."""
    t = max(int(r.get("delivered_at") or 0), int(r.get("mtime") or 0))
    lt = time.localtime(now or time.time())
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    return t >= midnight


def in_filter(r, which, now=None):
    which = which or "all"
    if which == "all":
        return True
    if which == "today":
        return is_today(r, now)
    return r.get("group") == which


def list_view(project, dirs, issues=None, session="", include_all=False, with_reader=False, which="all", now=None):
    """The Docs tab's answer: {docs, counts}. Every row carries its `group` and `today`; `which` (one of
    FILTERS) keeps the rows of one picker choice, counts stay those of the whole list. with_reader: also
    the rows that are no row of the list (test scenarios, a page's side files) as a third value, so the
    reader still says which task one belongs to when it is opened from elsewhere."""
    import tasks_view as T
    if which not in FILTERS:
        raise ValueError(_t("The filter must be one of: ", "筛选只能是：") + " / ".join(FILTERS))
    rows = D.docs_list(project, dirs)
    rows = fold(rows, include_all)
    reader = []
    if not include_all:
        reader = [r for r in rows if not listed(r)]
        rows = [r for r in rows if listed(r)]
    if issues is None:
        from board_export import export_issues
        issues = export_issues(D.sh, beads_dir=D.BEADS_DIR, dispatch_dir=D.DISPATCH_DIR, home=D.HOME)
    link_tasks(rows + reader, issues, T)
    rows, counts = decorate(rows, session, now)
    rows = [r for r in rows if in_filter(r, which, now)]
    if not with_reader:
        return rows, counts
    reader, _ = decorate(reader, session, now)
    return rows, counts, reader


def current_session(explicit=""):
    if explicit:
        return explicit
    import engines
    for k in engines.session_env_names():
        v = os.environ.get(k)
        if v:
            return v
    return ""


def _absorb_registered_sources(entries, entry, page):
    """Registered sources of the page (notes.md / README.md next to it, or a same-title .md): their
    tasks, times and session move onto the page and their entries go."""
    folder = os.path.dirname(page)
    key = title_key({"title": D.docs_title(page)})
    keep = []
    for e in entries:
        p = e.get("path") or ""
        name = os.path.basename(p)
        same = (not D.docs_is_url(p) and os.path.dirname(p) == folder and e["id"] != entry["id"]
                and (name.lower() in SOURCE_NAMES
                     or (is_source_md(name) and title_key({"title": e.get("title") or D.docs_title(p)}) == key)))
        if not same:
            keep.append(e)
            continue
        ts = list(dict.fromkeys((entry.get("tasks") or []) + (e.get("tasks") or [])))
        if ts:
            entry["tasks"] = ts
        if e.get("delivered_at"):
            entry["delivered_at"] = max(int(entry.get("delivered_at") or 0), int(e["delivered_at"]))
        if e.get("seen_at"):
            entry["seen_at"] = max(int(entry.get("seen_at") or 0), int(e["seen_at"]))
        if e.get("session") and not entry.get("session"):
            entry["session"] = e["session"]
        srcs = source_paths(entry)
        if p not in srcs:
            srcs.append(p)
        entry["sources"] = srcs
    return keep, entry


def register(project, value, title="", kind="", tasks=(), session="", delivered_at=0):
    """`docs add` and `task deliver`: register (or update) one document. An existing registration
    keeps its title and kind unless new ones are given; tasks add up. A delivery page and its source
    documents are one registration: the page is it, the sources hang under it in `sources`."""
    name = (project or "").strip()
    if not name:
        raise ValueError(_t("Give the project's name", "请给出项目名"))
    value = (value or "").strip().strip("<>")
    if not value:
        raise ValueError(_t("Give the document's path or URL", "请给出文档路径或 URL"))
    if kind and kind not in D.DOC_KINDS:
        raise ValueError(_t("The kind must be one of: ", "类型只能是：") + " / ".join(D.DOC_KINDS))
    url = D.docs_is_url(value)
    path = value if url else os.path.abspath(os.path.expanduser(value))
    if not url and not os.path.isfile(path):
        raise ValueError(_t("No such file: ", "找不到这个文件：") + path)
    entries = D.docs_registered(name)
    page = page_for(path) if not url else ""
    target = page or path
    did = D.docs_id(target)
    old = next((e for e in entries if e["id"] == did), None)
    entry = dict(old or {})
    entry.update({"id": did, "path": target})
    entry.pop("hidden", None)
    if title and not page:
        entry["title"] = title.strip()[:120]
    elif not entry.get("title") and not url:
        entry["title"] = D.docs_title(target)
    if kind and not page:
        entry["kind"] = kind
    elif not entry.get("kind"):
        entry["kind"] = "交付" if page else D.docs_kind_in_design(path, "其他" if url else D.docs_kind_of(os.path.basename(path)))
    entry.setdefault("added_at", time.time())
    ts = [t for t in (entry.get("tasks") or []) if isinstance(t, str)]
    for t in tasks or ():
        if t and t not in ts:
            ts.append(t)
    if ts:
        entry["tasks"] = ts
    if session and not entry.get("session"):
        entry["session"] = session
    if delivered_at:
        entry["delivered_at"] = int(delivered_at)
    if page:
        srcs = source_paths(entry)
        if path not in srcs:
            srcs.append(path)
        entry["sources"] = srcs
    entries = [e for e in entries if e["id"] != did]
    if page and D.docs_id(path) != did:
        entries = [e for e in entries if e["id"] != D.docs_id(path)]
    if is_delivery_page(target):
        entries, entry = _absorb_registered_sources(entries, entry, target)
    entries.append(entry)
    D.docs_save(name, entries)
    return D.docs_registered_rows([entry])[0]


def mark_seen(project, doc_id, now=None):
    entries = D.docs_registered(project)
    hit = next((e for e in entries if e["id"] == doc_id), None)
    if not hit:
        return False
    hit["seen_at"] = int(now or time.time())
    D.docs_save(project, entries)
    return True


def remove(project, doc_id, rows=None):
    """"Remove from Docs": the registration goes; a file the scan would list again (and the
    registration of a copy of it) stays out behind a tombstone."""
    entries = D.docs_registered(project)
    if rows is None:
        rows = fold(D.docs_list(project))
    row = next((r for r in rows if r["id"] == doc_id), None) or next((e for e in entries if e["id"] == doc_id), None)
    if not row:
        return False
    path = row.get("path") or ""
    gone = [(doc_id, path)]
    for s in source_paths(row):
        if not D.docs_is_url(s):
            gone.append((D.docs_id(s), s))
    if path and os.path.basename(path).lower() == "readme.md":
        # the row was the README and the hand-made page next to it: both go
        for n in ("index.html", "index.htm"):
            page = os.path.join(os.path.dirname(path), n)
            if os.path.isfile(page):
                gone.append((D.docs_id(page), page))
    ids = {i for i, _ in gone}
    keep = [e for e in entries if e["id"] not in ids]
    for i, p in gone:
        if p and not D.docs_is_url(p) and os.path.isfile(p):
            keep.append({"id": i, "path": p, "title": "", "kind": "", "added_at": time.time(), "hidden": True})
    D.docs_save(project, keep)
    return True


def on_deliver(project, task_id, path, session=""):
    """`task deliver --file`: a .md / .html goes into the project's Docs (as 交付 unless it is
    registered already), with the task on it."""
    if not project or not path or not os.path.isfile(path) or os.path.splitext(path)[1].lower() not in (".md", ".html", ".htm"):
        return None
    did = D.docs_id(path)
    known = next((e for e in D.docs_registered(project) if e["id"] == did and not e.get("hidden")), None)
    return register(project, path, kind="" if known else "交付", tasks=[task_id],
                    session=current_session(session), delivered_at=time.time())


def text(r):
    lines = [_t(f"{r['project']}: {len(r['docs'])} documents", f"{r['project']}：{len(r['docs'])} 份文档")]
    for g in GROUPS:
        rows = [d for d in r["docs"] if d.get("group") == g]
        if not rows:
            continue
        lines.append(f"  {g} {len(rows)}")
        for d in rows:
            extra = f"  → {d['tasks'][0]['title']}" if d.get("tasks") else ""
            lines.append(f"    {d['display_title']} · {d['path']}{extra}")
    return "\n".join(lines)
