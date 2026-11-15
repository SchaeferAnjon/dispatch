# -*- coding: utf-8 -*-
"""`dispatch capture` and `dispatch nextup`: what the person asks for in a chat goes on the board by itself,
and lines up behind the work already running (kanban design/chat-capture, direction B "Next up queue").

  capture note    one message the person sent (any session, the Assistant's too): a cheap model reads it with
                  the open tasks of its project and says what in it is new work, what is the same as an open
                  task, what adds a step to one, and what is a question or a "let's not". New work becomes a
                  task (label from-chat, their words quoted) that lines up as Next up (what they said is for
                  another time, "some day", "later", "not now", goes to Later instead); the same work only gets
                  their words as a comment; a question, chit-chat, thanks or "go on" is not noted at all.
                  Without a model the rules alone decide (the whole message is one thing, or nothing).
  capture list    the receipts of the last days with each thing's state now, for the line under the message
                  ("Noted 2 · next up #3") and the panel it opens.
  capture front | later | lineup | drop | undo | edit | merge | keep | seen
                  what the panel's buttons do: move to the front, not now (Later), line it up again, not a task
                  (taken off the board), undo that, change the title, merge into another task, keep separate
                  (a "same as" made into its own task) and the first-time sentence seen.
  nextup          the line: what is next up (in order) and what waits for later, paused or not, how many may
                  run at once. `pause`, `resume`, `limit <n>`, `engine <id> [--model m]`.
  capture hook    a prompt the person typed to an agent in Dispatch's own terminal (Claude Code and Codex run it
                  from their prompt hook through life_hook.py, OpenCode from Dispatch's plugin; the hook JSON on
                  stdin): read like a message in the window, in the background, filed under that terminal session.
                  Only the person's own agent in the terminal: not a sub-agent, not an agent another agent started.
  nextup idle     the tasks the board says are in progress that nobody works on: no live session on this Mac has
                  them and the board has not heard of them for an hour (an agent that stopped, a session closed
                  before it said done). `capture requeue <task>` puts one back in Next up (Undo puts it back),
                  `nextup requeue` all of them; the Tasks tab offers both.
  nextup settings how many may work at once, which agent starts them, paused or not (the Settings page reads it).
  nextup tick     when Start by itself is on (it is off until the person turns it on), fewer than `limit` sessions
                  are working and no session works in its project, the first thing in line starts by itself: a
                  session in its project's folder with the task claimed (chatd runs this every 20 s). Nothing
                  starts while it is off; running work goes on. A start that fails is tried again after 1 minute,
                  then 5; after the third failure the line stops and says why until `nextup retry`.

The order of the line lives on the tasks (metadata nextup, a number), Later is the label `later`, a thing
taken off the board is `deferred` with dispatch:trashed (so Undo brings it back as it was). The receipts are
DISPATCH_DIR/capture/receipts.jsonl, the line's switches DISPATCH_DIR/capture/queue.json.
"""
import sys

sys.dont_write_bytecode = True

import hashlib
import json
import os
import re
import time

import engines as E
import own_prompts

D = None

FROM = "from-chat"
NEXT = "nextup"
LATER = "later"
TRASH = "dispatch:trashed"
MERGED = "dispatch:merged"
DAYS = 14
LIMIT = 2              # sessions that may work at once before the line waits
STARTING_S = 180       # a thing started this recently counts as working until its session shows up
RETRY_S = (60, 300)    # a start that failed is tried again after 1 minute, then 5; the third failure stops the line
GIVE_UP = 3
TITLE_MAX = 60
QUOTE_MAX = 240
TEXT_MAX = 4000
JUDGE_TIMEOUT = 25
IDLE_S = 3600          # an in-progress task the board has not heard of for this long, and no live session has it: idle
OPEN_FOR_MODEL = 30    # open tasks the model sees, newest first


# ---------------------------------------------------------------- what is not noted at all

_CHAT = re.compile(r"^(?:ok(?:ay)?|k|yes|yep|yeah|no|nope|sure|thanks?(?: you)?|thx|ty|great|nice|cool|good|fine|got it|go on|go ahead|continue|"
                   r"carry on|keep going|do it|done|lgtm|perfect|hi|hello|hey|good (?:morning|night)|bye|"
                   r"好|好的|好吧|嗯|嗯嗯|对|对的|是|是的|行|可以|没问题|谢谢|多谢|继续|接着做|开始吧|开始|去做吧|做吧|收到|明白|了解|晚安|早|早上好|你好|辛苦了|不错|很好|棒)"
                   r"[\s!！.。,，~～?？]*$", re.I)
_ASKING = re.compile(r"^(?:what|why|how|when|where|who|which|is|are|was|were|does|do|did|has|have|should i|am i)\b|"
                     r"^(?:什么|为什么|怎么|如何|哪|谁|是不是|有没有|是否|能否告诉|请问)", re.I)
_REQUEST = re.compile(r"^(?:can|could|would|will) you\b|^please\b|^(?:let'?s|let us)\b|"
                      r"(?:能不能|可不可以|可以|麻烦|帮我|帮忙|请你|你去|你来|给我|我们要|要不要|应该|需要|加上|加一个|改成|改一下|修一下|修复|做一个|做个|实现)", re.I)
_NOT_NOW = re.compile(r"\b(?:now|yet|later|for now|today)\b|先不|暂时|以后|稍后|晚点|回头|现在不|今天不", re.I)
# the person says a piece of work is for some other time: it goes to Later, it does not start by itself
_SOMEDAY = re.compile(r"\b(?:some ?day|one day|someday|not (?:right )?now|not yet|later(?: on)?|eventually|at some point|in the future|"
                      r"down the (?:road|line)|no rush|when (?:you|we) (?:have|get) (?:the )?time|another time|next (?:week|month|time))\b|"
                      r"以后|改天|有空|将来|回头|先不|暂时不|不急|不着急|晚点|稍后|现在不|今天不|下次|哪天", re.I)
_NOT_DOING = re.compile(r"(?:不弄了|不做了|不要做|先不做|别做|不需要了|算了|drop (?:it|that)|forget (?:it|that)|never ?mind|let'?s not|don'?t do)", re.I)


def quick(text):
    """What the rules alone can say: 'chat' (nothing to note), 'question' (left out), 'not_doing', or None when
    the message needs reading."""
    t = " ".join(str(text or "").split())
    if not t:
        return "chat"
    if _CHAT.match(t) or len(t) <= 3:
        return "chat"
    sentences = [s for s in re.split(r"(?<=[.!?。！？\n])\s*", t) if s.strip()]
    if len(sentences) <= 1:
        if _NOT_DOING.search(t) and len(t) < 30 and not re.search(r"[,，;；]|另外|还有|\balso\b", t, re.I):
            return "not_doing"
        if (t.endswith(("?", "？")) or re.search(r"[吗呢]\s*[?？]?$", t)) and not _REQUEST.search(t):
            return "question"
        if _ASKING.match(t) and not _REQUEST.search(t) and len(t) < 120:
            return "question"
    return None


# ---------------------------------------------------------------- storage

def folder():
    # an agent's hook (hook.py) asks before the dispatch module is loaded (D is None there): the same folder
    base = D.DISPATCH_DIR if D is not None else (os.environ.get("DISPATCH_DIR") or E.DISPATCH_DIR)
    return os.path.join(base, "capture")


def _path(name):
    return os.path.join(folder(), name)


def norm(text):
    return " ".join(str(text or "").split())[:TEXT_MAX]


def text_key(text):
    return hashlib.sha1(norm(text).encode("utf-8")).hexdigest()[:16]


def load_receipts(days=DAYS, now=None):
    now = now or time.time()
    out = []
    try:
        with open(_path("receipts.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("id") and (not days or now - float(r.get("at") or 0) <= days * 86400):
                    out.append(r)
    except OSError:
        pass
    # a receipt written again (an edit) replaces the older line with its id
    seen = {}
    for r in out:
        seen[r["id"]] = r
    return list(seen.values())


def save_receipt(r):
    os.makedirs(folder(), exist_ok=True)
    with open(_path("receipts.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return r


def queue_state():
    try:
        with open(_path("queue.json"), encoding="utf-8") as f:
            q = json.load(f)
    except (OSError, ValueError):
        q = {}
    q = q if isinstance(q, dict) else {}
    lim = q.get("limit")
    q["limit"] = lim if isinstance(lim, int) and not isinstance(lim, bool) and 0 < lim <= 20 else LIMIT
    # Start by itself is off until the person turns it on: what they say along the way waits in Next up and an agent
    # never starts on it unasked (a Mac that has the switches saved keeps its own setting)
    q["paused"] = bool(q.get("paused", True))
    f = q.get("failed")
    q["failed"] = f if isinstance(f, dict) and f.get("task") else {}
    q["starting"] = {k: v for k, v in (q.get("starting") or {}).items() if isinstance(v, (int, float))}
    q["engine"] = q.get("engine") if isinstance(q.get("engine"), str) else ""
    q["model"] = q.get("model") if isinstance(q.get("model"), str) else ""
    q["hint_seen"] = bool(q.get("hint_seen"))
    return q


def _mark_lined():
    """Something was lined up on this Mac: chatd asks `nextup tick` until the line is empty again."""
    q = queue_state()
    if not q.get("lined"):
        q["lined"] = True
        save_queue(q)


def save_queue(q):
    os.makedirs(folder(), exist_ok=True)
    import threading
    tmp = _path("queue.json.%d.%d.tmp" % (os.getpid(), threading.get_ident()))  # two writers at once each have their own
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False)
    os.replace(tmp, _path("queue.json"))
    return q


# ---------------------------------------------------------------- the board

def _tv():
    TV = D._mod("tasks_view")
    TV.D = D
    return TV


def issues():
    try:
        return _tv().board_export()
    except Exception as e:
        D.debug("capture.board", e)
        return []


def noted_issues():
    """The tasks Dispatch noted from chats (label from-chat), by one label query: about 13 KB where the whole
    board is 6 MB, which `dispatch begin` parsed every time (seconds at load 190, 10-10)."""
    code, o, err = D.sh(["bd", "list", "--label", FROM, "--all", "--json", "-n", "0"], timeout=60)
    if code != 0:
        raise ValueError((err or o or "").strip()[:300] or "The board did not answer.")
    rows = json.loads(o[o.find("["):]) if "[" in o else []
    return [t for t in rows if isinstance(t, dict) and t.get("id")]


def bd(argv):
    """One bd call; its JSON answer (or {}). Raises ValueError with bd's words when it fails."""
    code, o, err = D.sh(["bd"] + argv, timeout=60)
    if code != 0:
        raise ValueError((err or o or "").strip()[:300] or "The board did not answer.")
    s = o or ""
    i = min([x for x in (s.find("{"), s.find("[")) if x >= 0] or [-1])
    if i < 0:
        return {}
    try:
        j = json.loads(s[i:])
    except ValueError:
        return {}
    return j[0] if isinstance(j, list) and j else j if isinstance(j, dict) else {}


def labels(t):
    return t.get("labels") or []


def meta(t):
    return _tv().meta(t)


def chat_of(t):
    m = meta(t).get("chat")
    return m if isinstance(m, dict) else {}


def order_of(t):
    try:
        return float(meta(t).get("nextup"))
    except (TypeError, ValueError):
        return float(_tv().epoch(t.get("created_at")) or 0)


def project_of(t):
    return _tv().project_of(t)


def state_of(t):
    """next | later | working | waiting | done | gone | merged | todo."""
    ls = labels(t)
    st = t.get("status") or "open"
    if MERGED in ls:
        return "merged"
    if TRASH in ls or st == "deferred":
        return "gone"
    s = _tv().status_of(t)
    if s == "done":
        return "done"
    if s == "in_progress":
        return "working"
    if s == "waiting":
        return "waiting"
    if LATER in ls:
        return "later"
    if NEXT in ls:
        return "next"
    return "todo"


def line(all_issues=None):
    """The open things in line, in order: [issue]."""
    xs = [t for t in (all_issues if all_issues is not None else issues()) if state_of(t) == "next"]
    xs.sort(key=lambda t: (order_of(t), t.get("id") or ""))
    return xs


def by_id(all_issues, tid):
    return next((t for t in all_issues if t.get("id") == tid), None)


def show(tid):
    return _tv().show_issue(tid)


def set_meta(tid, **changes):
    return _tv().set_meta(tid, **changes)


# ---------------------------------------------------------------- where a session lives

def projects():
    try:
        PV = D._mod("projects_view")
        PV.D = D
        return [{"name": r["name"], "dir": (r.get("dir") or "").rstrip("/")} for r in PV.registry(resolve_dirs=False) if r.get("name") and not r.get("archived")]
    except Exception as e:
        D.debug("capture.projects", e)
        return []


def main_checkout(cwd):
    """The main checkout of a git worktree (a session's own worktree belongs to its project); '' when it is not one."""
    import subprocess
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    common = r.stdout.strip() if r.returncode == 0 else ""
    if not common or os.path.basename(common.rstrip("/")) != ".git":
        return ""
    return os.path.dirname(common.rstrip("/"))


def project_for(cwd, known=None):
    """The registered project a folder is (or is inside, or a worktree of); '' for none."""
    cwd = os.path.realpath(os.path.expanduser(cwd or "")).rstrip("/") if cwd else ""
    if not cwd:
        return ""
    known = known if known is not None else projects()
    hit = _project_at(cwd, known)
    if hit or not os.path.isdir(cwd):
        return hit
    main = main_checkout(cwd)
    return _project_at(os.path.realpath(main).rstrip("/"), known) if main and os.path.realpath(main).rstrip("/") != cwd else ""


def _project_at(cwd, known):
    best = ""
    best_len = -1
    for p in known:
        d = p.get("dir") or ""
        if not d:
            continue
        rd = os.path.realpath(os.path.expanduser(d)).rstrip("/")
        if (cwd == rd or cwd.startswith(rd + "/")) and len(rd) > best_len:
            best, best_len = p["name"], len(rd)
    return best


def is_assistant(cwd):
    try:
        import assistant as A
        return bool(cwd) and os.path.realpath(cwd).rstrip("/") == os.path.realpath(A.folder()).rstrip("/")
    except Exception:
        return False


# ---------------------------------------------------------------- reading a message

PROMPT = """You keep a person's task board. Read ONE message the person just sent to an AI agent and list what in it is work to put on the board.

Return JSON only, no prose:
{"things": [{"kind": "new"|"same"|"part", "title": "...", "quote": "...", "task": "", "project": "", "now": false, "later": false}],
 "left_out": [{"kind": "question"|"not_doing", "quote": "..."}]}

- new: a piece of work the person wants done (a request, a wish, a bug they report, "we should ..."). title: what will be delivered, 3 to 12 words (or 4 to 20 Chinese characters), in the message's language (an English message gets an English title, never a translation), no ending punctuation.
- same: the same work as one of the OPEN TASKS below. task: its id. Nothing new goes on the board; their words are added there.
- part: a small addition to one of the OPEN TASKS (one more step of it). task: its id; title: the step.
- now: true for each thing the person asks this conversation's agent to do (it is theirs: the agent is working on the message), false for things only mentioned along the way (an idea for elsewhere, "we should some time ..."). Always false when CONVERSATION is "assistant".
- later: true when the person says this piece of work is for another time, not now ("some day", "later", "not now", "eventually", "no rush", "以后", "改天"). It waits until they ask for it; it does not start by itself. A thing said plainly ("also add X") is not later.
- project: for new things, one of PROJECTS when the message makes it clear; else "".
- quote: the exact words from MESSAGE that say it (copy them, at most 120 characters; never from PASTED TEXT or the agent's reply).
- question: the person asks for information or an explanation -> left_out, not a thing.
- not_doing: the person drops a piece of work altogether ("let's not do X", "forget the voice input") -> left_out. "Not now", "later", "do not do them yet" only say when; that is not not_doing, say nothing about it.
- Say nothing at all for greetings, thanks, "ok", "go on", approvals, answers to the agent's own question, remarks about the reply itself, and requests only to look or report ("what is running", "check my projects").
- Only the person's own words are requests. PASTED TEXT is what they copied in (an email, a letter, a document, a log): what it asks for, offers or decides is not the person's request; at most the person asks for one thing about it ("reply to this", "translate it") and that is said in their own words in MESSAGE.
- Words that tell the agent how to word or change its draft or reply ("tell them …", "say that …", "make it shorter", "你就说…", "改成…") are remarks about the reply: say nothing. Text from AGENT'S LAST REPLY (a draft it wrote) is never the person's request, and never a quote.
- Split a message that asks for several separate pieces of work into several things. Do not invent work the message does not ask for.
- A last step of the same request said in the same breath ("..., then commit it", "and push it", "test it", "然后提交") is part of that thing, not a thing of its own.
"""
# a commit, a push or a test run said along with the work it finishes ("Create the page. Then commit it."): a step of
# that work, never its own task (it stayed in Next up after the commit, task-lj06.18)
_STEP_ONLY = re.compile(r"^\W*(?:and |then |also |finally |然后|再|并)?(?:commit\b|push\b|deploy\b|run (?:the )?tests\b|test it\b|提交|推送|跑测试)", re.I)


# what the person pasted in rather than wrote: an email or letter (a greeting and a sign-off, or its header lines), a
# fenced block, quoted lines, or a long paragraph in another script than their own words (a German email under a
# Chinese line). What it asks for is not their request (task-p0za2: a garage's email became "Reparatur beauftragen",
# lined up to start by itself).
_GREETING = re.compile(r"(?:^|(?<=[\n.!?。！？:：]))[ \t]*(?:sehr geehrte[rs]?|guten (?:tag|morgen|abend)|hallo|liebe[rs]?|moin|servus|dear|hello|hi|hey|good (?:morning|afternoon|evening)|"
                       r"bonjour|madame|monsieur|buongiorno|hola|estimad[oa]s?|尊敬的|您好|你好)\b[^\n]{0,80}?[,，:：!！\n]", re.I)
_SIGNOFF = re.compile(r"(?:mit freundlichen gr(?:ü|ue)(?:ß|ss)en|freundliche gr(?:ü|ue)(?:ß|ss)e|viele gr(?:ü|ue)(?:ß|ss)e|beste gr(?:ü|ue)(?:ß|ss)e|liebe gr(?:ü|ue)(?:ß|ss)e|"
                      r"\bmfg\b|best regards|kind regards|warm regards|\bsincerely\b|yours (?:truly|faithfully)|"
                      r"cordialement|distinti saluti|saludos|此致|敬礼|祝好|顺祝)", re.I)
_HEADER = re.compile(r"^[ \t]*(?:from|to|cc|subject|sent|date|von|an|betreff|gesendet|datum|发件人|收件人|主题|时间)\s*[:：]", re.I | re.M)
_FENCE = re.compile(r"```.*?(?:```|$)", re.S)
_QUOTED = re.compile(r"^[ \t]*>.*$", re.M)


def split_pasted(text):
    """(own, pasted): the person's own words and what they pasted in, each with its line breaks."""
    t = str(text or "")
    spans = [(m.start(), m.end()) for m in _FENCE.finditer(t)] + [(m.start(), m.end()) for m in _QUOTED.finditer(t)]
    heads = list(_HEADER.finditer(t))
    if len(heads) >= 2:
        # a forwarded email: from its first header line to the end of its signature
        spans.append((heads[0].start(), _letter_end(t, heads[0].end())))
    for g in _GREETING.finditer(t):
        end = _letter_end(t, g.end(), need_signoff=True)
        if end:
            spans.append((g.start(), end))
            break
    own, pasted, i = [], [], 0
    for x, y in sorted(spans):
        if x > i:
            own.append(t[i:x])
        if y > max(i, x):
            pasted.append(t[max(i, x):y])
        i = max(i, y)
    own.append(t[i:])
    own_text = "".join(own)
    if _cjk(own_text):
        # a long paragraph without a Chinese character among Chinese words: pasted
        keep = []
        for para in re.split(r"(\n[ \t]*\n)", own_text):
            (pasted if len(para.strip()) >= 160 and not _cjk(para) else keep).append(para)
        own_text = "".join(keep)
    return own_text.strip(), "\n\n".join(x.strip() for x in pasted if x.strip())


def _letter_end(t, start, need_signoff=False):
    """Where a letter that starts before `start` ends: its sign-off and the name, address and phone lines under it
    (up to a blank line, or the end). Without a sign-off: 0 when `need_signoff`, else the end of its first paragraph."""
    so = _SIGNOFF.search(t, start)
    if not so:
        if need_signoff:
            return 0
        blank = re.search(r"\n[ \t]*\n", t[start:])  # no sign-off: its first paragraph
        return start + blank.start() if blank else len(t)
    blank = re.search(r"\n[ \t]*\n", t[so.end():])
    tail = t[so.end():so.end() + blank.start()] if blank else t[so.end():]
    # the signature: the rest of the sign-off's line and the short lines under it; a long line is the person again
    end = so.end()
    for n, ln in enumerate(re.split(r"(?<=\n)", tail)):
        if n and len(ln) > 160:
            break
        end += len(ln)
    return end


def _squash(text):
    return re.sub(r"[\s「」『』“”\"'‘’`*_()（）\[\]]+", "", str(text or "")).lower()


def in_own_words(quote, own):
    """Whether a thing's quote is the person's own words: found in them (spaces and quote marks aside), or most of
    its words are. A quote from the pasted text or from the agent's reply is not."""
    q, o = _squash(quote).rstrip("….。.!！?？"), _squash(own)
    if not q or not o:
        return False
    if q in o:
        return True
    words = re.findall(r"[\u3400-\u9fff]|[^\W\d_]{2,}", str(quote or "").lower())
    if not words:
        return False
    return sum(1 for w in words if w in o) / len(words) >= 0.8


def provider():
    """The model that reads messages: it has to answer in a second or two, so a cheap model behind an API key comes
    first (`dispatch env`, then a key the person already gave OpenCode), the summaries' model only after that
    (`claude -p` takes 8 s or more). `capture_model` (provider:model) in the settings picks one explicitly."""
    S = D._mod("summarize")
    try:
        pick = (D.settings_load().get("capture_model") or "").strip()
    except Exception:
        pick = ""
    if pick:
        return S.provider(pick)
    retired = S.retired_providers()
    env = {i["name"]: i["value"] for i in D.env_read()}
    for key, pid, base, model in S.PROVIDERS:
        if env.get(key) and pid not in retired:
            return {"id": pid, "base": base, "model": model, "key": env[key]}
    for eng in E.known():  # then a key the person already gave an engine (OpenCode's auth.json)
        for pid, base, model, key in eng.api_keys():
            if key and pid not in retired:
                return {"id": pid, "base": base, "model": model, "key": key}
    return S.provider()


def _open_for_model(all_issues, project):
    TV = _tv()
    rows = []
    for t in all_issues:
        s = state_of(t)
        if s in ("done", "gone", "merged"):
            continue
        if project and TV.project_of(t) != project:
            continue
        rows.append(t)
    rows.sort(key=lambda t: -(TV.epoch(t.get("updated_at")) or 0))
    return [{"id": t["id"], "title": t.get("title") or "", "project": TV.project_of(t)} for t in rows[:OPEN_FOR_MODEL]]


def _parse(raw):
    s = str(raw or "").strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    i, j = s.find("{"), s.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("no JSON in the answer")
    d = json.loads(s[i:j + 1])
    if not isinstance(d, dict):
        raise ValueError("not an object")
    return d


def clip(text, n):
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


def _cjk(text):
    return bool(re.search(r"[\u3400-\u9fff\uf900-\ufaff]", str(text or "")))


def rule_title(text):
    """A title from the message itself when no model is there: its first sentence, cut short."""
    t = norm(text)
    first = re.split(r"(?<=[.!?。！？;；])\s*|\n", t)[0] or t
    first = re.sub(r"^(?:please|can you|could you|would you|let'?s|also|and|请|麻烦|帮我|还有|另外|然后|我们)\s*", "", first, flags=re.I).strip(" ,，.。")
    return clip(first, TITLE_MAX) or clip(t, TITLE_MAX)


def judge(text, reply="", open_tasks=(), known_projects=(), assistant=False, model_ok=True, pasted=""):
    """{things, left_out, by}: by 'model' or 'rules'. `text` is the person's own words, `pasted` what they pasted in
    (split_pasted)."""
    q = quick(text)
    if q == "chat":
        return {"things": [], "left_out": [], "by": "rules"}
    if q in ("question", "not_doing"):
        return {"things": [], "left_out": [{"kind": q, "quote": clip(text, QUOTE_MAX)}], "by": "rules"}
    p = None
    if model_ok:
        try:
            if D._mod("summarize").use_enabled("capture"):
                p = provider()
        except Exception as e:
            D.debug("capture.provider", e)
            p = None
    if p:
        user = {"CONVERSATION": "assistant" if assistant else "project session",
                "PROJECTS": [x["name"] for x in known_projects][:40],
                "OPEN TASKS": list(open_tasks),
                "AGENT'S LAST REPLY": clip(reply, 1200),
                "MESSAGE": norm(text)}
        if pasted:
            user["PASTED TEXT"] = clip(pasted, 1500)
        user = json.dumps(user, ensure_ascii=False)
        try:
            raw = D._mod("summarize").chat(p, PROMPT, user, timeout=JUDGE_TIMEOUT, max_tokens=1600, use="capture", grace=0)
            d = _parse(raw)
            return {"things": [x for x in d.get("things") or [] if isinstance(x, dict)],
                    "left_out": [x for x in d.get("left_out") or [] if isinstance(x, dict)], "by": "model", "model": f"{p.get('id')}:{p.get('model')}"}
        except Exception as e:
            D.debug("capture.judge", e)
    # the rules alone: the message is one piece of work. Sent to a conversation with its agent, it is that agent's (claimed
    # for it, not lined up in Next up: 「还是不懂干嘛的 讲的简单点」 stood there on hold while the session answered it,
    # task-dctuo); to the Assistant it lines up
    later = bool(_SOMEDAY.search(norm(text)))
    return {"things": [{"kind": "new", "title": rule_title(text), "quote": clip(text, 120), "now": not assistant and not later, "later": later}],
            "left_out": [], "by": "rules"}


# ---------------------------------------------------------------- noting

def _desc(quote, title_of_session, at):
    when = time.strftime("%H:%M", time.localtime(at))
    where = f" in {title_of_session}" if title_of_session else ""
    return f"From chat ({when}{where}): 「{quote}」"


def _new_task(title, project, quote, session, at, receipt_id, now_here, all_issues, session_title="", later=False):
    """now_here: what this conversation does right now (claimed for it); later: what the person said is for another
    time (Later, it never starts by itself); else it lines up as Next up."""
    ls = [FROM, f"host:{D.local_host_name()}"] + ([f"project:{project}"] if project else [])
    sid = session_id(session)
    later = later and not now_here
    if sid:
        ls.append("session-origin:" + sid)
    if now_here and sid:
        ls.append("session:" + sid)
    elif not now_here:
        ls.append(LATER if later else NEXT)
    order = max([order_of(t) for t in line(all_issues)] + [0.0]) + 1
    m = {"chat": {"session": session, "at": at, "quote": quote, "receipt": receipt_id}}
    if now_here:
        m["chat"]["now"] = True  # Dispatch claimed it for the agent in this conversation: that agent takes it (dispatch begin / claim)
    elif not later:
        m["nextup"] = order
    issue = bd(["create", title, "-t", "task", "-p", "2", "--json", "-l", ",".join(ls),
                "--description", _desc(quote, session_title, at), "--metadata", json.dumps(m, ensure_ascii=False)])
    tid = issue.get("id")
    if not tid:
        raise ValueError("The board did not take the task.")
    if not now_here and not later:
        _mark_lined()
    if now_here:
        # claimed under the name of the conversation's agent (claude-code, codex …), not the person's: that agent's
        # claim and close then never meet "claimed by <person>" when its own id of the conversation is not on record yet
        agent = agent_of_session(session)
        try:
            bd(["update", tid, "--assignee", agent, "--status", "in_progress", "--json"] if agent else ["update", tid, "--claim", "--json"])
        except ValueError as e:
            D.debug("capture.claim", e)
        _untaken_add(tid)
    return tid


def agent_of_session(session):
    """The board name of the agent a session resource belongs to (`agent-host-claude:/…` → claude-code), '' when the
    resource names no engine."""
    scheme = re.sub(r"^(?:vscode-)?agent-host-", "", (session or "").partition(":")[0])
    eng = E.find(scheme) if scheme else None
    return eng.agent if eng else ""


def _untaken_path():
    return _path("untaken.json")


def untaken_ids():
    """The tasks Dispatch claimed for a conversation that its agent may not have taken yet: a turn's end looks at the
    board (capture settle) only while there are some, so an agent's Stop hook costs nothing otherwise."""
    try:
        with open(_untaken_path(), encoding="utf-8") as f:
            ids = json.load(f)
        return [x for x in ids if isinstance(x, str)] if isinstance(ids, list) else []
    except (OSError, ValueError):
        return []


def _untaken_write(ids):
    os.makedirs(folder(), exist_ok=True)
    tmp = _untaken_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(list(dict.fromkeys(ids)), f)
    os.replace(tmp, _untaken_path())


def _untaken_add(tid):
    try:
        _untaken_write(untaken_ids() + [tid])
    except OSError as e:
        D.debug("capture.untaken", e)


def session_id(session):
    """The bare id of a session resource (`agent-host-claude:/x/abc` → abc), '' when it is not one."""
    s = (session or "").strip()
    s = re.sub(r"^[a-z][\w+.-]*:/*", "", s, flags=re.I)
    s = s.split("?")[0].split("#")[0].rstrip("/").split("/")[-1]
    return s if re.fullmatch(r"[A-Za-z0-9_-]{8,120}", s) else ""


def note(session, text, cwd="", project="", reply="", title="", now=None, model_ok=True, chat=False):
    """Read one message and put what is new on the board. Returns the receipt (see receipts()). The same message
    told twice at once (a hook that fires twice, two windows) is read once: the second waits and gets the first's."""
    now = now or time.time()
    os.makedirs(folder(), exist_ok=True)
    try:
        import fcntl
    except ImportError:
        fcntl = None
    with open(_path("note-%s.lock" % text_key(norm(text))), "w") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return _note(session, text, cwd, project, reply, title, now, model_ok, chat)
        finally:
            try:
                os.unlink(lock.name)
            except OSError:
                pass


def _note(session, text, cwd, project, reply, title, now, model_ok, chat=False):
    raw = str(text or "")
    text = norm(text)
    key = text_key(text)
    for r in load_receipts(1, now):
        if r.get("key") == key and (r.get("session") == session or not session) and now - float(r.get("at") or 0) < 600:
            return view([r])[0]  # the same message twice (two windows, a retry): one receipt
    own = own_prompts.lookup(text, now)
    if own is not None:
        # Dispatch's own words sent in the person's place ("Let the agent fix it", a handoff to another agent):
        # not a request of theirs. Only what they typed into it themselves is read.
        if not norm(own.get("user")):
            receipt = {"id": "n" + key[:10] + hex(int(now))[-4:], "session": session, "key": key, "text": text[:1200], "at": now,
                       "project": project, "assistant": False, "items": [], "left_out": [], "by": "dispatch"}
            return save_receipt(receipt) and view([receipt])[0]
        raw = own["user"]
        text = norm(raw)
    if not reply and session:
        # the person answering what Dispatch's own prompt made the agent ask ("Git needs your name and email"):
        # the model sees that prompt as the agent's side of the conversation, so an answer is not new work
        asked = [r for r in load_receipts(1, now) if r.get("session") == session and r.get("by") == "dispatch"
                 and 0 <= now - float(r.get("at") or 0) < 1800]
        if asked:
            reply = "(Dispatch asked the agent this on the person's behalf) " + str(asked[-1].get("text") or "")
    S = D._mod("summarize")
    try:
        on = S.use_enabled("capture")
    except Exception:
        on = True
    known = projects()
    assistant = is_assistant(cwd)
    project = project or ("" if assistant or chat else project_for(cwd, known))
    # a session without a project folder (the Agents window's Chats, an agent started in the home folder): a one-off
    # conversation. Dispatch puts nothing of it on the board (no task, no project, nothing lined up to start by
    # itself); the receipt is the session's own record of the message. The agent there files its work itself, in no
    # project (dispatch begin). task-p0za2
    import dispatch_dir
    chat = not assistant and not project and (chat or dispatch_dir.chats_folder(cwd))
    own_words, pasted = split_pasted(raw)
    all_issues = issues()
    rid = "n" + key[:10] + hex(int(now))[-4:]
    receipt = {"id": rid, "session": session, "key": key, "text": text[:1200], "at": now, "project": project, "assistant": assistant,
               "items": [], "left_out": [], "by": "off"}
    if chat:
        receipt["chat"] = True
    if pasted:
        receipt["pasted"] = True
    if not on:
        return save_receipt(receipt) and view([receipt])[0]
    if chat:
        receipt["by"] = "chat"
        return save_receipt(receipt) and view([receipt])[0]
    if not norm(own_words):
        # only what they pasted in (an email, a log): nothing of theirs to note
        receipt["by"] = "rules"
        return save_receipt(receipt) and view([receipt])[0]
    got = judge(own_words, reply, _open_for_model(all_issues, project), known, assistant, model_ok, pasted=pasted)
    receipt["by"] = got.get("by")
    names = {p["name"] for p in known}
    open_ids = {t["id"] for t in all_issues if state_of(t) not in ("done", "gone", "merged")}
    seen_titles = []
    news = [x for x in got["things"][:8] if x.get("kind") in (None, "", "new")]
    if len(news) > 1:
        got["things"] = [x for x in got["things"] if not (x in news and _STEP_ONLY.search(x.get("title") or "") and _STEP_ONLY.search(x.get("quote") or x.get("title") or ""))]
    for x in got["things"][:8]:
        kind = x.get("kind") if x.get("kind") in ("new", "same", "part") else "new"
        quote = clip(x.get("quote") or own_words, QUOTE_MAX)
        if not in_own_words(quote, own_words):
            continue  # from the pasted text or the agent's reply: not something the person asked for
        t_title = clip(x.get("title") or "", TITLE_MAX)
        if t_title and not _cjk(text) and _cjk(t_title):
            # the title is in the message's language (task-7lptn): a model that wrote Chinese for an English
            # message gets the person's own words instead
            t_title = rule_title(quote)
        target = x.get("task") if x.get("task") in open_ids else ""
        # the model's project counts only when the person named it: a session with no project of its own (the
        # Assistant, an unknown folder) otherwise got "找手机设计稿" filed under the project 手机ai摄影 (2026-10-11)
        proj = project or (x.get("project") if x.get("project") in names and _named(x.get("project"), own_words) else "")
        if kind in ("same", "part") and not target:
            kind = "new"
        if kind == "new":
            if not t_title:
                continue
            if any(_same_words(t_title, s) for s in seen_titles):
                continue
            # the board decides too: the same work open there already (without a model, from fewer shared words)
            dup = _duplicate(t_title, proj, all_issues, rules=got.get("by") == "rules")
            if dup:
                kind, target = "same", dup
            elif got.get("by") == "rules" and not assistant and session_id(session) and not (x.get("later") is True or _SOMEDAY.search(quote)):
                # without a model nothing tells a request from a question: a new thing said to a conversation is left to
                # its agent, which files its own task when it is one (claimed for the agent, a question stayed in progress
                # with nothing to settle it; review 10-22)
                receipt.setdefault("left_out", []).append({"kind": "for_agent", "quote": quote, "why": "no model to read it with: the conversation's agent files its own task"})
                continue
        try:
            if kind == "new":
                here = bool(x.get("now")) and not assistant and bool(session_id(session))
                later = not here and (x.get("later") is True or bool(_SOMEDAY.search(quote)))
                tid = _new_task(t_title, proj, quote, session, now, rid, here, all_issues, title, later=later)
                seen_titles.append(t_title)
                receipt["items"].append({"kind": "new", "task": tid, "title": t_title, "quote": quote, "project": proj})
                all_issues = issues()
            elif kind == "same":
                bd(["comments", "add", target, f"From chat, said again: 「{quote}」"])
                tt = (by_id(all_issues, target) or {}).get("title") or ""
                receipt["items"].append({"kind": "same", "task": target, "title": tt, "quote": quote})
            else:
                _add_step(target, t_title or quote)
                bd(["comments", "add", target, f"From chat, one more step: 「{quote}」"])
                tt = (by_id(all_issues, target) or {}).get("title") or ""
                receipt["items"].append({"kind": "part", "task": target, "title": tt, "step": t_title or clip(quote, TITLE_MAX), "quote": quote})
        except ValueError as e:
            D.debug("capture.write", e)
    for x in got["left_out"][:4]:
        if not in_own_words(x.get("quote") or own_words, own_words):
            continue
        if x.get("kind") == "not_doing" and _NOT_NOW.search(x.get("quote") or ""):
            continue  # "not now" says when, not that it is dropped
        if x.get("kind") in ("question", "not_doing"):
            receipt["left_out"].append({"kind": x["kind"], "quote": clip(x.get("quote") or own_words, QUOTE_MAX)})
    save_receipt(receipt)
    return view([receipt])[0]


def _named(name, words):
    """Whether the person's own words contain the project's name."""
    return bool(name) and norm(name).lower() in norm(words).lower()


def _same_words(a, b):
    S = D._mod("assistant_survey")
    return S._same(a, b) or S.overlap(a, b) >= 0.75


def _duplicate(title, project, all_issues, rules=False):
    """An open task of that project that is the same work by its words; '' for none.

    rules: no model read the message, so the title is the person's whole sentence ("Put fixing the RSS feed dates
    in notes-site on my board"), its asking words diluting the work's own. Then half of its words in an open task's
    title, at least three of them, is the same work: the person's words go on that task as a comment and the line
    under the message offers Keep separate, where a second task for the same work would sit on the board unseen."""
    S = D._mod("assistant_survey")
    TV = _tv()
    best, score = "", 0.0
    mine = S.words(title)
    for t in TV.select(all_issues, project=project) if project else all_issues:
        if state_of(t) in ("done", "gone", "merged"):
            continue
        other = t.get("title") or ""
        sc = 1.0 if S._same(title, other) else S.overlap(title, other)
        enough = sc >= 0.75 or (rules and sc >= 0.5 and len(mine & S.words(other)) >= 3)
        if enough and sc > score:
            best, score = t["id"], sc
    return best


def _add_step(tid, step):
    t = show(tid)
    plan = list(meta(t).get("plan") or [])
    plan.append({"text": clip(step, 120), "state": "todo"})
    set_meta(tid, plan=_tv().clean_plan(plan))


# ---------------------------------------------------------------- what the receipts say now

def item_view(it, t, pos, q):
    x = dict(it)
    if t is None:
        x["state"] = "gone"
        return x
    st = state_of(t)
    x["state"] = st if it["kind"] == "new" else ("same" if it["kind"] == "same" else "part")
    x["task_state"] = st
    x["title"] = t.get("title") or it.get("title") or ""
    x["project"] = project_of(t)
    if st == "next":
        x["pos"] = pos.get(t["id"], 0)
        x["ahead"] = max(0, x["pos"] - 1)
    if st == "done":
        x["done_at"] = _tv().epoch(t.get("closed_at"))
    if st == "merged":
        x["into"] = meta(t).get("merged_into") or ""
        x["into_title"] = meta(t).get("merged_into_title") or ""
    return x


def view(receipts, all_issues=None, now=None):
    all_issues = all_issues if all_issues is not None else issues()
    q = queue_state()
    ids = {t["id"]: t for t in all_issues}
    pos = {t["id"]: i + 1 for i, t in enumerate(line(all_issues))}
    out = []
    for r in receipts:
        items = [item_view(it, ids.get(it.get("task")), pos, q) for it in r.get("items") or []]
        live = [x for x in items if x["state"] not in ("gone", "merged")]
        nexts = sorted(x["pos"] for x in items if x.get("state") == "next" and x.get("pos"))
        out.append(dict(r, items=items, count=len(live), next_pos=nexts[0] if nexts else 0, paused=q["paused"],
                        first=not q["hint_seen"] and bool(items)))
    return out


def receipts(session="", days=DAYS, now=None):
    rs = load_receipts(days, now)
    if session:
        rs = [r for r in rs if r.get("session") == session]
    rs = [r for r in rs if r.get("items") or r.get("left_out")]
    rs.sort(key=lambda r: r.get("at") or 0)
    return {"receipts": view(rs[-200:]), "paused": queue_state()["paused"]}


# ---------------------------------------------------------------- the panel's buttons

def _sid(value):
    import session_life as SL
    return SL.key(value).split(":", 1)[-1]


def live_ids():
    """The session ids of the agents alive on this Mac now (their own ids, any engine)."""
    out = set()
    try:
        live = D.live_sessions(local_only=True)
    except Exception as e:
        D.debug("capture.live", e)
        return None
    for x in live:
        for k in ("session_id", "probable_session_id"):
            if x.get(k):
                out.add(_sid(x[k]))
    return out


def idle(all_issues=None, now=None, live=None):
    """The tasks the board says are in progress that nobody works on: not waiting for the person, not this Mac's
    work elsewhere (another host's label), no live session claimed or logged on them, and nothing on the board
    for IDLE_S. [issue], oldest first. None of them when the live sessions cannot be read."""
    tv = _tv()
    all_issues = all_issues if all_issues is not None else issues()
    live = live_ids() if live is None else live
    if live is None:
        return []
    now = now or time.time()
    here = (D.local_host_name() if hasattr(D, "local_host_name") else "") or ""
    out = []
    for t in all_issues:
        if tv.status_of(t) != "in_progress" or tv.hidden(t) or state_of(t) != "working":
            continue
        hosts = [l.split(":", 1)[1] for l in labels(t) if l.startswith("host:")]
        if hosts and here and here not in hosts:
            continue
        m = meta(t)
        if m.get("turbo") or (t.get("title") or "").startswith("Turbo: "):
            continue  # a Turbo run's own task: the run's runner has it
        sessions = [m.get("claim_session")] + list(tv.sessions_of(t) or [])
        if any(s and _sid(s) in live for s in sessions):
            continue
        if now - (tv.epoch(t.get("updated_at")) or 0) < IDLE_S:
            continue
        out.append(t)
    out.sort(key=lambda t: tv.epoch(t.get("updated_at")) or 0)
    return out


def requeue(tid):
    """An in-progress task nobody works on goes back in Next up, at the end of the line; Undo puts it back."""
    t = show(tid)
    if _tv().status_of(t) != "in_progress":
        raise ValueError("%s is not in progress" % tid)
    m = meta(t)
    m["requeued_from"] = {"status": t.get("status") or "in_progress", "claim_session": m.get("claim_session") or "",
                          "assignee": t.get("assignee") or "", "at": int(time.time())}
    m.pop("claim_session", None)
    xs = line()
    m[NEXT] = max([order_of(x) for x in xs] + [0.0]) + 1
    bd(["update", tid, "--status", "open", "--add-label", NEXT, "--remove-label", LATER,
        "--metadata", json.dumps(m, ensure_ascii=False), "--json"])
    bd(["comments", "add", tid, "Back in Next up: it was in progress with nobody working on it."])
    _mark_lined()
    return {"ok": True, "task": tid}


def requeue_idle():
    xs = idle()
    for t in xs:
        requeue(t["id"])
    return {"ok": True, "tasks": [t["id"] for t in xs]}


def front(tid):
    xs = line()
    first = min([order_of(t) for t in xs if t["id"] != tid] + [order_of(show(tid)) + 1])
    set_meta(tid, nextup=first - 1)
    return {"ok": True, "task": tid}


def later(tid):
    bd(["update", tid, "--add-label", LATER, "--remove-label", NEXT, "--json"])
    return {"ok": True, "task": tid}


def lineup(tid):
    xs = line()
    last = max([order_of(t) for t in xs] + [0.0])
    bd(["update", tid, "--add-label", NEXT, "--remove-label", LATER, "--json"])
    set_meta(tid, nextup=last + 1)
    _mark_lined()
    return {"ok": True, "task": tid}


def drop(tid):
    """Not a task: off the board (deferred, dispatch:trashed); Undo brings it back as it was."""
    t = show(tid)
    m = meta(t)
    m["dropped_from"] = {"status": t.get("status") or "open", "labels": [l for l in labels(t) if l in (NEXT, LATER)]}
    bd(["update", tid, "--status", "deferred", "--add-label", TRASH, "--remove-label", NEXT, "--remove-label", LATER,
        "--metadata", json.dumps(m, ensure_ascii=False), "--json"])
    return {"ok": True, "task": tid}


def undo(tid):
    t = show(tid)
    m = meta(t)
    back = m.pop("requeued_from", None)
    if back and NEXT in labels(t) and not m.get("dropped_from"):
        # put back in progress as it was (Undo right after Back to Next up)
        if back.get("claim_session"):
            m["claim_session"] = back["claim_session"]
        m.pop(NEXT, None)
        bd(["update", tid, "--status", "in_progress", "--remove-label", NEXT, "--metadata", json.dumps(m, ensure_ascii=False), "--json"])
        return {"ok": True, "task": tid}
    was = m.pop("dropped_from", None) or {"status": "open", "labels": [NEXT]}
    m.pop("merged_into", None)
    m.pop("merged_into_title", None)
    if NEXT in (was.get("labels") or []):
        _mark_lined()
    argv = ["update", tid, "--status", was.get("status") if was.get("status") in ("open", "in_progress", "blocked") else "open",
            "--remove-label", TRASH, "--remove-label", MERGED]
    for l in was.get("labels") or []:
        argv += ["--add-label", l]
    bd(argv + ["--metadata", json.dumps(m, ensure_ascii=False), "--json"])
    return {"ok": True, "task": tid}


def edit(tid, title):
    title = clip(title, 120)
    if not title:
        raise ValueError("What should it say?")
    bd(["update", tid, "--title", title, "--json"])
    return {"ok": True, "task": tid, "title": title}


def merge(tid, into):
    """Merge a noted thing into another task: its words go there as a comment, the thing leaves the board."""
    if tid == into:
        raise ValueError("Pick another task to merge into.")
    t, target = show(tid), show(into)
    quote = chat_of(t).get("quote") or t.get("title") or ""
    bd(["comments", "add", into, f"From chat, merged in: 「{quote}」"])
    m = meta(t)
    m["dropped_from"] = {"status": t.get("status") or "open", "labels": [l for l in labels(t) if l in (NEXT, LATER)]}
    m["merged_into"] = into
    m["merged_into_title"] = target.get("title") or ""
    bd(["update", tid, "--status", "deferred", "--add-label", MERGED, "--remove-label", NEXT, "--remove-label", LATER,
        "--metadata", json.dumps(m, ensure_ascii=False), "--json"])
    return {"ok": True, "task": tid, "into": into, "into_title": target.get("title") or ""}


def keep(receipt_id, index):
    """A "same as" that the person says is different: made into its own task, lined up."""
    rs = load_receipts(0)
    r = next((x for x in rs if x.get("id") == receipt_id), None)
    if not r:
        raise ValueError("That note is gone.")
    items = r.get("items") or []
    if not (0 <= index < len(items)) or items[index].get("kind") != "same":
        raise ValueError("Only a 'same as' can be kept apart.")
    it = items[index]
    title = rule_title(it.get("quote") or "")
    tid = _new_task(title, r.get("project") or "", it.get("quote") or "", r.get("session") or "", float(r.get("at") or time.time()), r["id"], False, issues())
    items[index] = {"kind": "new", "task": tid, "title": title, "quote": it.get("quote") or "", "project": r.get("project") or ""}
    save_receipt(dict(r, items=items))
    return {"ok": True, "task": tid, "title": title}


def note_left_out(receipt_id, index):
    """A question left out that the person wants on the board after all ("Note it")."""
    rs = load_receipts(0)
    r = next((x for x in rs if x.get("id") == receipt_id), None)
    if not r:
        raise ValueError("That note is gone.")
    lo = r.get("left_out") or []
    if not (0 <= index < len(lo)):
        raise ValueError("Nothing there to note.")
    quote = lo[index].get("quote") or ""
    title = rule_title(quote)
    tid = _new_task(title, r.get("project") or "", quote, r.get("session") or "", float(r.get("at") or time.time()), r["id"], False, issues())
    lo = lo[:index] + lo[index + 1:]
    save_receipt(dict(r, left_out=lo, items=(r.get("items") or []) + [{"kind": "new", "task": tid, "title": title, "quote": quote, "project": r.get("project") or ""}]))
    return {"ok": True, "task": tid, "title": title}


def targets(tid, limit=6):
    """Tasks a noted thing could be merged into: the same project's open ones, the likeliest first."""
    all_issues = issues()
    t = by_id(all_issues, tid) or show(tid)
    S = D._mod("assistant_survey")
    proj = project_of(t)
    rows = []
    for o in all_issues:
        if o.get("id") == tid or state_of(o) in ("done", "gone", "merged"):
            continue
        if proj and project_of(o) != proj:
            continue
        rows.append((S.overlap(t.get("title") or "", o.get("title") or ""), _tv().epoch(o.get("updated_at")), o))
    rows.sort(key=lambda r: (-r[0], -r[1]))
    return {"task": tid, "targets": [{"id": o["id"], "title": o.get("title") or "", "state": state_of(o)} for _, _, o in rows[:limit]]}


def seen():
    q = queue_state()
    q["hint_seen"] = True
    save_queue(q)
    return {"ok": True}


# ---------------------------------------------------------------- the line

def queue_view(all_issues=None, now=None):
    all_issues = all_issues if all_issues is not None else issues()
    q = queue_state()
    now = now or time.time()

    said = {r.get("id"): clip(r.get("text") or "", QUOTE_MAX) for r in load_receipts(DAYS, now)}

    def row(t, i=0):
        c = chat_of(t)
        r = {"id": t["id"], "title": t.get("title") or "", "project": project_of(t), "quote": c.get("quote") or "", "at": c.get("at") or _tv().epoch(t.get("created_at")),
             "session": c.get("session") or "", "new": now - float(c.get("at") or 0) < 3600,
             # the message it came from, for a group head over the things one message lined up
             "receipt": c.get("receipt") or "", "said": said.get(c.get("receipt")) or c.get("quote") or ""}
        if i:
            r["pos"] = i
        return r
    nxt = [row(t, i + 1) for i, t in enumerate(line(all_issues))]
    lat = [row(t) for t in all_issues if state_of(t) == "later"]
    lat.sort(key=lambda r: -(r["at"] or 0))
    tv = _tv()
    idl = [dict(row(t), since=tv.epoch(t.get("updated_at")) or 0) for t in idle(all_issues, now)]
    return {"paused": q["paused"], "limit": q["limit"], "engine": q["engine"], "model": q["model"], "next": nxt, "later": lat,
            "idle": idl, "failed": failed_view(q)}


def failed_view(q):
    """The thing that did not start, for the line's note: {task, title, why, tries, stuck, retry_at}; {} when none."""
    f = q.get("failed") or {}
    if not f.get("task"):
        return {}
    return {"task": f["task"], "title": f.get("title") or "", "why": f.get("why") or "", "tries": int(f.get("tries") or 0),
            "stuck": int(f.get("tries") or 0) >= GIVE_UP, "retry_at": f.get("retry_at") or 0}


def set_paused(paused):
    q = queue_state()
    q["paused"] = bool(paused)
    if not paused:
        q["failed"] = {}  # turned on again: a failed start is tried again
    save_queue(q)
    return {"ok": True, "paused": q["paused"]}


def set_limit(n):
    if not (0 < n <= 20):
        raise ValueError("Between 1 and 20 at once.")
    q = queue_state()
    q["limit"] = n
    save_queue(q)
    return {"ok": True, "limit": n}


def set_engine(engine, model=""):
    if engine and not _runnable(engine):
        raise ValueError(E.join_words((e.id for e in E.runnable()), "or"))
    q = queue_state()
    # the same agent picked again (Settings has no model to give): the model chosen with it stays
    keep = q["model"] if not model and (engine or "") == q["engine"] else ""
    q["engine"], q["model"] = engine or "", model or keep
    q["failed"] = {}  # another agent: try again with it
    save_queue(q)
    return {"ok": True, "engine": q["engine"], "model": q["model"]}


def working_now():
    """The sessions working on this Mac (the home's Working lane): [{key, task}]."""
    import assistant_live as L
    L.D = D
    rows = L.own_rows()
    return [{"key": r.get("key") or "", "task": (r.get("task") or {}).get("id") or "", "cwd": r.get("cwd") or ""} for r in rows if r.get("status") == "working"]


def _runnable(name):
    """The engine `name` means when Dispatch can run it (claude-code and claude are one), else None."""
    eng = E.find(name)
    return eng if eng and eng.runnable else None


def engine_for(q):
    first = E.runnable()[0].id
    if q.get("engine"):
        return (_runnable(q["engine"]) or E.get(first)).id
    try:
        import agents_catalog as AC
        d = AC.load_choice().get("default") or ""
        if d:
            return (_runnable(d) or E.get(first)).id
    except Exception as e:
        D.debug("capture.engine", e)
    return first


def brief(t):
    c = chat_of(t)
    quote = c.get("quote") or ""
    return (f"Work on this task from the person's chat: {t.get('title') or ''} ({t['id']}).\n"
            + (f"Their words: 「{quote}」\n" if quote else "")
            + "It is claimed for you already. With Dispatch's tools: plan it (task_plan), do it, commit, deliver "
              f"(task_deliver with commit true) and finish with task_done and the reason, all for {t['id']}. "
              "If it needs the person's decision first, ask once and stop.")


def folder_for(t):
    proj = project_of(t)
    d = ""
    if proj:
        try:
            d = D.project_home(proj) or ""
        except Exception as e:
            D.debug("capture.folder", e)
        if not d:
            d = next((p["dir"] for p in projects() if p["name"] == proj and p.get("dir")), "")
    if not d or not os.path.isdir(os.path.expanduser(d)):
        d = os.path.join(D.DISPATCH_DIR, "chats", t["id"])
        os.makedirs(d, exist_ok=True)
    return os.path.expanduser(d)


def tick(now=None, start=None, working=None):
    """Start the first thing in line when there is room. Returns {started, reason}. One tick at a time on this
    Mac (a window's chatd and the resident one may both ask)."""
    os.makedirs(folder(), exist_ok=True)
    try:
        import fcntl
    except ImportError:
        fcntl = None
    with open(_path("tick.lock"), "w") as lock:
        if fcntl:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return {"started": "", "reason": "busy"}
        return _tick(now, start, working)


def _tick(now=None, start=None, working=None):
    now = now or time.time()
    q = queue_state()
    if q["paused"]:
        return {"started": "", "reason": "paused"}
    all_issues = issues()
    xs = line(all_issues)
    q["starting"] = {k: v for k, v in q["starting"].items() if now - v < STARTING_S and state_of(by_id(all_issues, k) or {"status": "closed"}) != "done"}
    if not xs:
        q["lined"] = False  # chatd stops asking until something is lined up again
        q["failed"] = {}
        save_queue(q)
        return {"started": "", "reason": "empty"}
    f = q["failed"]
    if f and not any(t["id"] == f.get("task") for t in xs):
        f = q["failed"] = {}  # the thing that did not start left the line (started by hand, dropped, done)
    if f and int(f.get("tries") or 0) >= GIVE_UP:
        save_queue(q)
        return {"started": "", "reason": "stuck", "why": f.get("why") or ""}
    if f and float(f.get("retry_at") or 0) > now:
        save_queue(q)
        return {"started": "", "reason": "retry_later", "retry_at": f.get("retry_at"), "why": f.get("why") or ""}
    busy = working() if working else working_now()
    on_tasks = {w["task"] for w in busy if w.get("task")}
    n = len(busy) + len([k for k in q["starting"] if k not in on_tasks])
    if n >= q["limit"]:
        save_queue(q)
        return {"started": "", "reason": "full", "working": n}
    # a session still working in a project (the one the person said it in, often): its things wait until it is done,
    # so two agents never change the same folder at once
    busy_projects = _projects_of(busy)
    free = [t for t in xs if not (project_of(t) and project_of(t) in busy_projects)]
    if not free:
        save_queue(q)
        return {"started": "", "reason": "project_busy", "working": n}
    t = free[0]
    if f and f.get("task") != t["id"]:
        f = q["failed"] = {}
    q["starting"][t["id"]] = now
    save_queue(q)
    try:
        bd(["update", t["id"], "--remove-label", NEXT, "--json"])
    except ValueError as e:
        D.debug("capture.unline", e)
    try:
        (start or start_session)(t, q)
    except ValueError as e:
        return _start_failed(t, q, str(e), now)
    qq = queue_state()
    if qq["failed"]:
        qq["failed"] = {}
        save_queue(qq)
    return {"started": t["id"], "title": t.get("title") or "", "working": n + 1}


def _projects_of(busy):
    """The projects the working sessions are in (a worktree counts as its project)."""
    names = set()
    known = None
    for w in busy:
        cwd = w.get("cwd") or ""
        if not cwd:
            continue
        if known is None:
            known = projects()
        p = project_for(cwd, known)
        if p:
            names.add(p)
    return names


def _start_failed(t, q, err, now):
    """A start that did not happen: put back in front, say why in plain words, try again later (1 min, then 5), and
    stop trying after the third time until the person says Try again, picks another agent or turns the line on again."""
    try:
        bd(["update", t["id"], "--add-label", NEXT, "--json"])
    except ValueError:
        pass
    qq = queue_state()
    qq["starting"].pop(t["id"], None)
    was = qq["failed"] if qq["failed"].get("task") == t["id"] else {}
    tries = int(was.get("tries") or 0) + 1
    engine = engine_for(q)
    qq["failed"] = {"task": t["id"], "title": t.get("title") or "", "tries": tries, "at": now,
                    "retry_at": (now + RETRY_S[min(tries, len(RETRY_S)) - 1]) if tries < GIVE_UP else 0,
                    "why": why_not_started(err, engine), "detail": clip(err, 300), "engine": engine}
    save_queue(qq)
    D.debug("capture.start", err)
    return {"started": "", "reason": "failed" if tries < GIVE_UP else "stuck", "task": t["id"], "why": qq["failed"]["why"], "tries": tries}


def why_not_started(err, engine):
    """What went wrong when a thing in line did not start, in words the person can act on."""
    name = E.get(engine).name or "The agent"
    e = str(err or "")
    if re.search(r"not installed|no such file|command not found|cannot start|agent_missing|enoent|not found on this mac", e, re.I):
        head = f"{name} is not installed on this Mac."
    elif re.search(r"log(?:ged)? ?in|sign(?:ed)? ?in|not authenticated|auth|credential|\b401\b|api key|subscription", e, re.I):
        head = f"{name} is not signed in."
    elif re.search(r"daemon_down|connection refused|did not answer|no chat service|chatd", e, re.I):
        head = "Dispatch's session service did not answer."
    elif re.search(r"folder does not exist", e, re.I):
        head = "The project's folder is not there any more."
    else:
        head = f"{name} did not start."
    return head + " Pick another agent under Settings > Agents > Next up, or try again."


def retry():
    """Try again: the next tick starts the first thing in line now (the person's click after a failure)."""
    q = queue_state()
    q["failed"] = {}
    save_queue(q)
    _mark_lined()
    return {"ok": True}


def start_session(t, q):
    """`dispatch agent start <engine> --task <id> --cwd <folder> --prompt <brief> --no-wait`, as its own process.
    ValueError with what it said when it did not start (_tick puts the thing back and says why)."""
    import subprocess
    argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "agent", "start", engine_for(q),
            "--task", t["id"], "--cwd", folder_for(t), "--label", clip(t.get("title") or "", 60), "--prompt", brief(t), "--no-wait", "--json"]
    if q.get("model"):
        argv += ["--model", q["model"]]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ValueError(f"did not answer: {e}")
    if r.returncode != 0:
        raise ValueError((r.stderr or r.stdout or "").strip()[-300:] or "The session did not start.")
    return r.stdout


def taken(tid):
    """An agent took a task Dispatch noted for its conversation (dispatch begin / claim): it is that agent's now."""
    try:
        t = show(tid)
        c = dict(chat_of(t))
        if c.get("now") and not c.get("taken"):
            c["taken"] = True
            set_meta(tid, chat=c)
    except ValueError as e:
        D.debug("capture.taken", e)


def whose(t, sid):
    """Whose a thing Dispatch noted from a chat is, for the agent of session `sid`: "mine" (it was said in this
    conversation), "other" (said in another one: that conversation's agent takes it) or "any" (no conversation on
    record). The window's id and the engine's own ids of one conversation (OpenCode's ses_…, a /clear's new id)
    all count as this conversation (tasks_view.session_keys, what the Tasks pane files it under)."""
    said_in = str(chat_of(t).get("session") or "").strip()
    if not session_id(said_in):
        return "any"
    me = session_id(sid)
    if not me:
        return "other"
    try:
        keys = _tv().session_keys(said_in)
    except Exception as e:  # noqa: BLE001 - the bare id still tells the conversation
        D.debug("capture.whose", e)
        keys = []
    keys = [k for k in keys + [session_id(said_in)] if k]

    def same(x):
        return bool(x) and any(x == k or (len(k) >= 8 and x.startswith(k)) or (len(x) >= 8 and k.startswith(x)) for k in keys)
    return "mine" if same(me) or same(window_of(me)) else "other"


def window_of(sid):
    """The Agents window's id of a conversation an agent knows by its own id (Codex's thread, OpenCode's ses_…, what
    its hooks say), '' when the window does not run it. The window files that before each turn goes out (`dispatch
    handoff assess --register`, session_life's "managed"); what it files at the turn's end comes after the agent's
    Stop hook, so Codex's turn end found nothing of its conversation on the board (task-lj06.18)."""
    if not sid:
        return ""
    try:
        import session_life as L
        for eng in E.known():
            m = L.load(L.path_for("managed", f"{eng.agent}:{sid}"))
            if m.get("session"):
                return session_id(str(m["session"]))
    except Exception as e:  # noqa: BLE001 - the agent's own id still tells the conversation
        D.debug("capture.window_of", e) if D is not None else None
    return ""


def claim_noted(title, project, sid):
    """For `dispatch begin`: a thing Dispatch noted from the chat that is the same work as `title`.
    {id, state, for_this_chat} or None. An agent that begins it takes that task instead of making a second one;
    for_this_chat: Dispatch claimed it for the conversation it was said in, and no agent took it yet.
    What Dispatch claimed for another conversation is that conversation's: never offered here (task-lj06.17). What
    only waits in Next up or Later is anybody's to take, so the same work is not done twice."""
    all_issues = noted_issues()
    S = D._mod("assistant_survey")
    best, score = None, 0.0
    for t in all_issues:
        if FROM not in labels(t) or state_of(t) not in ("next", "later", "todo", "working"):
            continue
        if project and project_of(t) and project_of(t) != project:
            continue
        if state_of(t) == "working" and whose(t, sid) == "other":
            continue  # claimed for the conversation it was said in: that one's agent does it
        sc = 1.0 if S._same(title, t.get("title") or "") else S.overlap(title, t.get("title") or "")
        if sc >= 0.5 and sc > score:
            best, score = t, sc
    if not best:
        return None
    c = chat_of(best)
    return {"id": best["id"], "title": best.get("title") or "", "state": state_of(best), "for_this_chat": bool(c.get("now")) and not c.get("taken")}


# ---------------------------------------------------------------- the end of an agent's turn

SETTLE_PROMPT = """A person asked an AI agent for a piece of work, and their task board holds it. Read the agent's reply at the end of its turn and say where that piece of work stands now.

Return JSON only, no prose: {"state": "done" | "not_needed" | "open", "why": "<one short sentence, in the reply's language>"}

- done: the reply says this piece of work is finished (made, changed, fixed, committed, answered).
- not_needed: the reply says it needs no change (it already is that way, there is nothing to do), or the person dropped it.
- open: anything else: still working on it, a question back to the person, only a plan, partly done, failed, or the reply is about something else.
"""
SETTLE_TIMEOUT = 20
NOTE_WAIT = 60      # a turn's end waits this long at most for a message still being read (note-*.lock)
MAP_WAIT = 20       # ... and this long for the window to file which conversation an agent's own id is
NOTE_LOCK_FRESH = 180  # a lock older than this is left behind by a reader that died, not a reading


def notes_in_flight():
    """Whether a message is being read right now (note() holds note-<key>.lock while it reads): an agent that
    answers in seconds ("it is already blue") ends its turn before its message is on the board."""
    import glob
    now = time.time()
    for f in glob.glob(os.path.join(folder(), "note-*.lock")):
        try:
            if now - os.path.getmtime(f) < NOTE_LOCK_FRESH:
                return True
        except OSError:
            continue
    return False


def mine_untaken(sid, all_issues=None):
    """What Dispatch noted from this conversation's messages as its work now, that no agent took (dispatch begin /
    claim): the tasks the board says are in progress for the conversation while its agent does not know them."""
    rows = issues() if all_issues is None else all_issues
    return [t for t in rows if FROM in labels(t) and state_of(t) == "working" and chat_of(t).get("now")
            and not chat_of(t).get("taken") and whose(t, sid) == "mine"]


def _last_reply(agent, sid):
    """The agent's last reply: from its own store when it keeps one (OpenCode's database: its plugin's turn end
    carries no text, and the session index may not have the conversation yet; Codex's rollout file), else from its
    transcript through the index ('' when it cannot be read)."""
    name = E.get(agent).agent
    if name in getattr(D, "SQLITE_STORES", {}):
        last = D.zcode_query("select id from message where session_id=? and json_extract(data,'$.role')='assistant' "
                             "order by time_created desc limit 1", (sid,), agent=name)
        if last:
            parts = D.zcode_query("select json_extract(data,'$.text') text from part where message_id=? and json_extract(data,'$.type')='text' "
                                  "and coalesce(json_extract(data,'$.synthetic'),0)=0 order by time_created", (last[0]["id"],), agent=name)
            text = "\n".join(r["text"] for r in parts if r["text"]).strip()
            if text:
                return text
    # an engine that keeps one file per conversation (Codex's rollout): read straight from it; the session index may
    # not have the conversation yet (Codex's turn end found no reply and closed nothing, 10-08)
    try:
        paths = E.get(agent).transcript_of(sid, os.path.expanduser("~")) or []
    except Exception as e:  # noqa: BLE001
        D.debug("capture.settle.find", e)
        paths = []
    for path in paths[:1]:
        try:
            msgs = D.read_session_detail({"agent": name, "path": path, "session_id": sid, "cwd": ""}).get("messages") or []
        except Exception as e:  # noqa: BLE001 - the index below may still have it
            D.debug("capture.settle.detail", e)
            break
        last_user = max([i for i, m in enumerate(msgs) if m.get("role") == "user" and not m.get("synthetic")] or [-1])
        text = "\n".join((m.get("text") or "").strip() for m in msgs[last_user + 1:] if m.get("role") == "assistant" and (m.get("text") or "").strip())
        if text:
            return text
    try:
        turns, _, _ = D._mod("summarize").transcript_turns(f"{E.get(agent).agent}:{sid}")
    except Exception as e:  # noqa: BLE001 - nothing to read: nothing is closed
        D.debug("capture.settle.read", e)
        return ""
    return next((text for who, text in reversed(turns) if who == "Agent"), "")


def settle_judge(t, reply, model_call=None):
    """{state, why} for one noted task against the agent's reply: by the cheap model, "open" without one. A model
    that does not answer is asked once more with longer to answer (a busy Mac kept tasks open, 10-08); "error" says
    what went wrong when it still did not."""
    user = json.dumps({"TASK": t.get("title") or "", "THE PERSON'S WORDS": chat_of(t).get("quote") or "",
                       "AGENT'S REPLY": clip(reply, 3000)}, ensure_ascii=False)
    err = ""
    for timeout in (SETTLE_TIMEOUT, SETTLE_TIMEOUT * 3):
        try:
            if model_call is None:
                if not D._mod("summarize").use_enabled("capture"):
                    return {"state": "open", "why": "", "error": "reading messages is off"}
                p = provider()
                if not p:
                    return {"state": "open", "why": "", "error": "no model to read with"}
                raw = D._mod("summarize").chat(p, SETTLE_PROMPT, user, timeout=timeout, max_tokens=300, use="capture", grace=0)
            else:
                raw = model_call(user)
            d = _parse(raw)
        except Exception as e:  # noqa: BLE001 - a model that does not answer leaves the task as it is
            D.debug("capture.settle.judge", e)
            err = str(e)[:200] or type(e).__name__
            continue
        state = d.get("state") if d.get("state") in ("done", "not_needed", "open") else "open"
        return {"state": state, "why": clip(str(d.get("why") or ""), 200)}
    return {"state": "open", "why": "", "error": err}


def _settle_log(row):
    """One line per turn's end that had something to settle (capture/settle.jsonl, the last 200): what was asked and
    what the model said, to see why a task stayed open."""
    try:
        path = _path("settle.jsonl")
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()[-199:]
        except OSError:
            lines = []
        lines.append(json.dumps(row, ensure_ascii=False))
        os.makedirs(folder(), exist_ok=True)
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(path + ".tmp", path)
    except OSError as e:
        if D is not None:
            D.debug("capture.settle.log", e)


def settle(session, reply="", agent="claude-code", model_call=None, close=None, wait=NOTE_WAIT, sleep=time.sleep):
    """At the end of an agent's turn (its Stop hook): what Dispatch noted from this conversation as its work now and
    the agent never took is closed when the agent's reply says it is done or not needed. It stayed in progress for
    good, and a commit asked for in the same breath stayed in Next up (task-lj06.18). {closed: [{task, state, why}]}."""
    sid = session_id(session)
    if not sid:
        return {"closed": [], "why": "no session"}
    t0 = time.time()
    end = time.time() + wait
    while notes_in_flight() and time.time() < end:  # its message is still being read: what it puts on the board counts
        sleep(1)
    all_issues = issues()
    try:  # the list of what may still be untaken keeps only what still is
        _untaken_write([t["id"] for t in all_issues if FROM in labels(t) and state_of(t) == "working" and chat_of(t).get("now") and not chat_of(t).get("taken")])
    except OSError as e:
        D.debug("capture.untaken", e)
    mine = mine_untaken(sid, all_issues)
    # a conversation's first turn: the window files which conversation the agent's own id (Codex's thread) is only at
    # the turn's end, just after the agent's Stop hook (half a second late on 10-08)
    end = time.time() + MAP_WAIT
    while not mine and untaken_ids() and not window_of(sid) and time.time() < end:
        sleep(1)
        mine = mine_untaken(sid, all_issues)
    if not mine:
        if untaken_ids():
            _settle_log({"at": round(time.time(), 1), "session": sid, "agent": agent, "outcome": "none of the untaken tasks is this conversation's"})
        return {"closed": []}
    reply = (reply or "").strip() or _last_reply(agent, sid)
    if not reply.strip():
        _settle_log({"at": round(time.time(), 1), "session": sid, "agent": agent, "outcome": "no reply to read", "tasks": [t["id"] for t in mine]})
        return {"closed": [], "why": "no reply to read"}
    closed, seen = [], []
    for t in mine:
        v = settle_judge(t, reply, model_call)
        seen.append({"task": t["id"], **v})
        if v["state"] == "open":
            continue
        why = v["why"] or ("The agent said it is done." if v["state"] == "done" else "The agent said it needs no change.")
        reason = ("Not needed: " if v["state"] == "not_needed" else "") + why + " (closed by Dispatch at the end of the agent's turn)"
        try:
            (close or _close)(t["id"], reason)
            closed.append({"task": t["id"], "state": v["state"], "why": why})
        except (ValueError, OSError) as e:
            D.debug("capture.settle.close", e)
            seen[-1]["close_error"] = str(e)[:200]
    _settle_log({"at": round(time.time(), 1), "session": sid, "agent": agent, "seconds": round(time.time() - t0, 1), "reply": clip(reply, 200), "tasks": seen})
    if closed:
        try:
            _untaken_write([x for x in untaken_ids() if x not in {c["task"] for c in closed}])
        except OSError as e:
            D.debug("capture.untaken", e)
    return {"closed": closed}


def _close(tid, reason):
    import subprocess
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "done", tid, "--reason", reason],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise ValueError((r.stderr or r.stdout or "").strip()[-300:])


def settle_from_hook(data, agent="claude-code", spawn=None):
    """A Stop hook: `capture settle` in the background for that session (the agent's turn does not wait for a model)."""
    if not isinstance(data, dict) or str(data.get("hook_event_name") or "Stop") != "Stop" or data.get("agent_id"):
        return {"started": False}
    sid = session_id(str(data.get("session_id") or ""))
    if not sid or os.environ.get("DISPATCH_WORKER") or not (untaken_ids() or notes_in_flight()):
        return {"started": False}
    reply = data.get("last_assistant_message") if isinstance(data.get("last_assistant_message"), str) else ""
    _settle_log({"at": round(time.time(), 1), "session": sid, "agent": agent, "outcome": "started at the turn's end", "reply_chars": len(reply)})
    (spawn or _spawn_settle)(sid, agent, reply)
    return {"started": True}


def _spawn_settle(sid, agent, reply):
    import subprocess
    argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "capture", "settle",
            "--session", sid, "--agent", agent, "--text", "-", "--json"]
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        p.stdin.write((reply or "")[:TEXT_MAX].encode("utf-8"))
        p.stdin.close()
    except OSError:
        pass
    return p


# ---------------------------------------------------------------- a prompt typed in a Dispatch terminal

TERMINAL_ENV = "DISPATCH_TERMINAL_SESSION"   # termd sets it in every shell of the Agents window's terminal
TERMINAL_SCHEME = "dispatch-terminal:/"      # the terminal session's resource in the window


def _is_agent(args):
    """Whether a process's command line is an agent CLI Dispatch runs (`claude`, `codex`, `opencode`: a path to one, the
    native binary Codex's npm wrapper starts, Claude Code's versioned binary), or node / bun running one of them."""
    parts = (args or "").split()
    if not parts:
        return False

    def named(word):
        w = word.replace("\\", "/")
        base = w.rsplit("/", 1)[-1].lower()
        base = re.sub(r"\.(?:c|m)?js$", "", base)
        return any(e.is_command(base, w) for e in E.runnable())
    if named(parts[0]):
        return True
    return parts[0].rsplit("/", 1)[-1].lower() in ("node", "bun") and len(parts) > 1 and named(parts[1])


def _processes():
    import subprocess
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,args="], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    table = {}
    for line in out.splitlines():
        bits = line.strip().split(None, 2)
        if len(bits) >= 2 and bits[0].isdigit() and bits[1].isdigit():
            table[int(bits[0])] = (int(bits[1]), bits[2] if len(bits) > 2 else "")
    return table


def nested(pid=None, table=None):
    """Whether the agent this runs under was started by another agent (a `claude -p` an agent ran in its shell): up the
    line of parent processes, two agents with something else (a shell) between them. An agent and the wrapper that
    started it (Codex's npm script and its binary) are one."""
    table = _processes() if table is None else table
    pid = os.getppid() if pid is None else pid
    groups, inside, seen = 0, False, set()
    while pid and pid > 1 and pid in table and pid not in seen and len(seen) < 64:
        seen.add(pid)
        ppid, args = table[pid]
        agent = _is_agent(args)
        if agent and not inside:
            groups += 1
        inside = agent
        pid = ppid
    return groups >= 2


def from_hook(data, agent="claude-code", env=None, spawn=None, table=None):
    """A prompt from an agent's prompt hook. Noted (in the background, the agent does not wait) only when it was typed
    in a Dispatch terminal to the agent the person runs there. Returns {noted, why}."""
    env = os.environ if env is None else env
    term = (env.get(TERMINAL_ENV) or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,120}", term):
        return {"noted": False, "why": "not in a Dispatch terminal"}
    if not isinstance(data, dict) or (data.get("hook_event_name") or "UserPromptSubmit") != "UserPromptSubmit":
        return {"noted": False, "why": "not a prompt"}
    if data.get("agent_id") or env.get("DISPATCH_WORKER"):
        return {"noted": False, "why": "a helper, not the person"}
    if E.foreign_session(agent, data.get("session_id")):
        # OpenCode replaying Claude Code's hooks (a plugin such as oh-my-openagent): Dispatch's own OpenCode
        # plugin notes that prompt, once
        return {"noted": False, "why": "OpenCode's own plugin notes it"}
    if str(env.get("CLAUDE_CODE_ENTRYPOINT") or "").startswith("sdk"):
        return {"noted": False, "why": "started with a prompt, not typed"}
    text = data.get("prompt") or data.get("user_prompt") or data.get("text") or ""
    text = text if isinstance(text, str) else ""
    t = norm(text)
    if not t or t.startswith("/") or quick(t) == "chat":
        return {"noted": False, "why": "nothing to note"}
    if nested(table=table):
        return {"noted": False, "why": "an agent started by another agent"}
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) and os.path.isabs(data.get("cwd") or "") else os.getcwd()
    session = TERMINAL_SCHEME + term
    title = (E.find(agent).name if E.find(agent) else "An agent") + " in the terminal"
    (spawn or _spawn_note)(session, text, cwd, title, env)
    return {"noted": True, "session": session}


def _spawn_note(session, text, cwd, title, env):
    """`dispatch capture note` as its own process: the model takes a few seconds and the agent's turn goes on."""
    import subprocess
    e = {k: v for k, v in env.items() if k != TERMINAL_ENV}
    argv = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), "capture", "note", "--text", "-",
            "--session", session, "--cwd", cwd, "--title", title, "--json"]
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=e, cwd=cwd if os.path.isdir(cwd) else None,
                         start_new_session=True)
    try:
        p.stdin.write(text[:TEXT_MAX].encode("utf-8"))
        p.stdin.close()
    except OSError:
        pass
    return p


def settings_view():
    q = queue_state()
    return {"paused": q["paused"], "limit": q["limit"], "engine": q["engine"], "model": q["model"], "default_engine": _default_engine(),
            "failed": failed_view(q)}


def _default_engine():
    try:
        import agents_catalog as AC
        return AC.load_choice().get("default") or ""
    except Exception:
        return ""


# ---------------------------------------------------------------- the commands

def _text_arg(a):
    t = getattr(a, "text", "") or ""
    if t == "-" or (not t and not sys.stdin.isatty()):
        t = sys.stdin.read()
    return t


def command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    op = a.op
    args = list(getattr(a, "args", []) or [])
    try:
        if op == "hook":
            try:
                data = json.loads(sys.stdin.read() or "{}")
            except ValueError:
                data = {}
            res = from_hook(data, getattr(a, "agent", "") or "claude-code")
        elif op == "settle":
            res = settle(a.session or "", _text_arg(a) if getattr(a, "text", "") else "", getattr(a, "agent", "") or "claude-code")
        elif op == "note":
            res = note(a.session or "", _text_arg(a), cwd=a.cwd or "", project=a.project or "", reply=a.reply or "", title=a.title or "",
                       chat=bool(getattr(a, "chat", False)))
        elif op == "list":
            res = receipts(a.session or "", a.days or DAYS)
        elif op in ("front", "later", "lineup", "drop", "undo", "requeue") and args:
            res = {"front": front, "later": later, "lineup": lineup, "drop": drop, "undo": undo, "requeue": requeue}[op](args[0])
        elif op == "edit" and len(args) >= 2:
            res = edit(args[0], " ".join(args[1:]))
        elif op == "merge" and len(args) >= 2:
            res = merge(args[0], args[1])
        elif op == "targets" and args:
            res = targets(args[0])
        elif op == "keep" and len(args) >= 2:
            res = keep(args[0], int(args[1]))
        elif op == "noteit" and len(args) >= 2:
            res = note_left_out(args[0], int(args[1]))
        elif op == "seen":
            res = seen()
        else:
            raise SystemExit("dispatch capture note --session <s> --cwd <folder> \"<message>\" | hook --agent <a> | list [--session <s>] | front|later|lineup|drop|undo|requeue <task> | "
                             "edit <task> \"<title>\" | merge <task> <into> | targets <task> | keep <receipt> <n> | noteit <receipt> <n> | seen")
    except ValueError as e:
        res = {"ok": False, "error": str(e)}
        D.out(res, a.json, lambda r: print(r["error"], file=sys.stderr))
        return 1
    D.out(res, a.json, _note_text if op == "note" else lambda r: print(json.dumps(r, ensure_ascii=False)))
    return 0


def _note_text(r):
    if not r["items"] and not r["left_out"]:
        print("Nothing to note.")
        return
    for it in r["items"]:
        word = {"new": "Noted", "same": "Same as", "part": "One more step on"}[it["kind"]]
        where = f" · next up #{it['pos']}" if it.get("pos") else (f" · {it['state']}" if it.get("state") else "")
        print(f"{word}: {it.get('title')} ({it.get('task')}){where}")
    for lo in r["left_out"]:
        print(f"Left out ({lo['kind']}): {lo['quote']}")


def nextup_command(a, dispatch_module=None):
    global D
    if dispatch_module is not None:
        D = dispatch_module
    op = a.op or "list"
    args = list(getattr(a, "args", []) or [])
    try:
        if op == "list":
            res = queue_view()
        elif op == "pause":
            res = set_paused(True)
        elif op == "resume":
            res = set_paused(False)
        elif op == "limit" and args:
            res = set_limit(int(args[0]))
        elif op == "engine":
            res = set_engine("" if not args or args[0] == "default" else args[0], getattr(a, "model", "") or "")
        elif op == "settings":
            res = settings_view()
        elif op == "tick":
            res = tick()
        elif op == "retry":
            res = retry()
        elif op == "idle":
            res = {"ok": True, "idle": queue_view()["idle"]}
        elif op == "requeue":
            res = requeue_idle()
        else:
            raise SystemExit("dispatch nextup [list] | settings | pause | resume | retry | idle | requeue | limit <n> | engine <claude|codex|opencode|default> [--model m] | tick")
    except ValueError as e:
        res = {"ok": False, "error": str(e)}
        D.out(res, a.json, lambda r: print(r["error"], file=sys.stderr))
        return 1

    def text(r):
        if op != "list":
            print(json.dumps(r, ensure_ascii=False))
            return
        print(("Start by itself is off. " if r["paused"] else "") + f"{len(r['next'])} next up, {len(r['later'])} later, up to {r['limit']} at once.")
        if r.get("failed"):
            f = r["failed"]
            print(f"Did not start: {f['title']} ({f['task']}). {f['why']}" + (" Stopped trying: dispatch nextup retry." if f["stuck"] else ""))
        for x in r["next"]:
            print(f"  {x['pos']:>2}. {x['title']}  ({x['id']}{', ' + x['project'] if x['project'] else ''})")
        for x in r["later"]:
            print(f"  later: {x['title']}  ({x['id']})")
        for x in r.get("idle") or []:
            print(f"  in progress, nobody on it: {x['title']}  ({x['id']})")
    D.out(res, a.json, text)
    return 0
