# -*- coding: utf-8 -*-
"""The session brief `dispatch prime` prints: what is going on right now, in the order that matters, inside a budget
that Claude Code and Codex both deliver whole.

The rules (how to use the board, preferences, reporting) are not here: they ride in every agent's rules file
(`dispatch rules sync`), which an engine reads whole at the start of a session. This text only carries the state,
because both engines cut a hook's output that is too long and give the agent a preview of it:

  * Claude Code: over 10,000 characters it saves the whole output to a file and shows the first 2,000 characters
    and the file name; it does not ask the agent to read the file (a limit with no setting).
  * Codex: over about 2,500 tokens (default; `additionalContextLimit` on the hook raises it) it saves the output to a
    file and shows a head and a tail. Codex counts tokens roughly as bytes / 4, so 10,000 bytes.

A byte is never fewer than a character, so one budget in bytes keeps both. Every part has its own cap; a part that
is over says how many are left and the command that lists them ("N more, `…`"). Everything is in the person's
language (lang.py): English, or Chinese for a Chinese speaker. The parts come in the order of
importance; if all the caps together still do not fit, the ones at the end go first, and the full text is written to
a file whose path is the first line of the brief."""

CLAUDE_CHARS = 10000       # Claude Code's limit for one hook output
CODEX_BYTES = 10000        # Codex's default, 2,500 tokens, at bytes / 4
BUDGET_BYTES = 9000        # what the brief keeps to: inside both, with room for a longer project name or one long line

BOARD_LINES, BOARD_BYTES = 8, 1600
PEER_LINES, TRACKED_LINES, PEERS_BYTES, TRACKED_BYTES = 4, 3, 1100, 400
DUE_BYTES = 600
PREF_ITEMS, PREF_CHARS, PREFS_BYTES = 14, 1400, 2700
PIT_COUNT, PIT_WIDTH, PITS_BYTES = 5, 90, 1500
from lang import t


def pointer():
    return t("Look up: tasks `dispatch task list`; all preferences `dispatch prefs list`; the wiki `dispatch wiki search <word>`; "
             "names of keys `dispatch env list`; skills and plugins `dispatch catalog -q <word>`; facts `dispatch facts get <topic>`; "
             "about the person `dispatch profile show`.",
             "查阅：任务 `dispatch task list`；全部偏好 `dispatch prefs list`；知识库 `dispatch wiki search <词>`；"
             "密钥名单 `dispatch env list`；技能和插件 `dispatch catalog -q <词>`；常用信息 `dispatch facts get <主题词>`；"
             "关于用户 `dispatch profile show`。")


def size(text):
    """(characters, bytes) of a text: the two things the engines count."""
    return len(text), len(text.encode("utf-8"))


def nbytes(lines):
    return len("\n".join(lines).encode("utf-8")) + 1 if lines else 0


def clip(text, width):
    text = " ".join(str(text).split())
    return text if len(text) <= width else text[:width - 1].rstrip() + "…"


def cap(lines, max_bytes, more, max_lines=None, extra=0):
    """Whole lines from the top while they fit in `max_bytes` (and `max_lines`); when some are left out, or `extra`
    more exist that were never given, one line says how many (`more(n)`), which takes its own room."""
    lines = list(lines)
    if not extra and (max_lines is None or len(lines) <= max_lines) and nbytes(lines) <= max_bytes:
        return lines
    room = max_bytes - nbytes([more(len(lines) + extra)])
    kept, used = [], 0
    for line in lines:
        n = len(line.encode("utf-8")) + 1
        if (max_lines is not None and len(kept) >= max_lines) or used + n > room:
            break
        kept.append(line)
        used += n
    left = len(lines) - len(kept) + extra
    return kept + [more(left)] if left else kept


def board(tasks, proj, status_of, actor="", note_of=None):
    """1. This project's tasks in progress and waiting for the person (all projects' in-progress ones when the folder
    belongs to none). `tasks`: bd's task dicts; `status_of`: tasks_view.status_of; `note_of(task)`: the person's
    unanswered note on a task this agent holds."""
    def in_project(t):
        label = next((l.split(":", 1)[1] for l in t.get("labels") or [] if l.startswith("project:")), "")
        return not proj or label == proj
    live = [t for t in tasks if in_project(t) and status_of(t) in ("in_progress", "waiting")]
    live.sort(key=lambda t: (status_of(t) != "in_progress", t.get("priority", 9)))
    if not proj:
        live = [t for t in live if status_of(t) == "in_progress"]
    todo = len([t for t in tasks if in_project(t) and status_of(t) == "todo"]) if proj else 0
    rows = []
    for t_ in live:
        by = next((l.split(":", 1)[1] for l in t_.get("labels") or [] if l.startswith("delegated-by:")), "")
        who = f" [{t_.get('assignee')}]" if t_.get("assignee") else ""
        mark = "◐" if status_of(t_) == "in_progress" else t("◇ waiting for you", "◇ 等你")
        title = clip(t_.get('title', ''), 70)
        row = (t(f"{mark} \"{title}\" ({t_['id']}){who}", f"{mark} 「{title}」（{t_['id']}）{who}")
               + (t(f" ← handed over by {by}", f" ← {by} 派的") if by else ""))
        if note_of and len(rows) < BOARD_LINES and status_of(t_) == "in_progress" and actor and t_.get("assignee") == actor:
            note = note_of(t_)
            if note:
                row += t("\n💬 The person's note (not answered yet): ", "\n💬 用户留言（未回复）：") + clip(note, 160)
        rows.append(row)
    if not rows and not todo:
        return []
    cmd = "`dispatch task list`"
    head = t(f"## On the board ({clip(proj or 'all projects', 40)}: in progress and waiting for you)",
             f"## 板上（{clip(proj or '全部', 40)}：进行中和等你）")
    footer = t(f"{todo} more to do: {cmd}", f"另有 {todo} 条待办：{cmd}")
    lines = cap(rows, BOARD_BYTES - nbytes([head]) - (nbytes([footer]) if todo else 0),
                lambda n: t(f"…{n} more in progress or waiting" + (f", {todo} more to do" if todo else "") + f": {cmd}",
                            f"…还有 {n} 条进行中或等你的" + (f"，另有 {todo} 条待办" if todo else "") + f"：{cmd}"), BOARD_LINES)
    if todo and lines == rows:
        lines.append(footer)
    return [head, *lines]


def peers(neighbours, conflict_line="", tracked=(), self_line=""):
    """2. The sessions in this folder (what stops two agents from writing the same file) and the conversations the
    person follows in this project."""
    rows = list(neighbours)
    tracked = list(tracked)
    if not rows and not tracked:
        return []
    out = []
    if rows:
        head = t(f"## Running in this folder ({len(rows)})", f"## 同目录在跑（{len(rows)}）")
        tail = [clip(l, 160) for l in (conflict_line, self_line) if l]
        room = PEERS_BYTES - nbytes([head, *tail])
        out += [head, *cap(rows, room, lambda n: t(f"…{n} more, `dispatch sessions`", f"…还有 {n} 个，`dispatch sessions`"), PEER_LINES), *tail]
    if tracked:
        head = t(f"## Conversations the person follows ({len(tracked)})", f"## 追踪中的会话（{len(tracked)}）")
        out += [head, *cap(tracked, TRACKED_BYTES - nbytes([head]), lambda n: t(f"…{n} more, `dispatch sessions`", f"…还有 {n} 个，`dispatch sessions`"), TRACKED_LINES)]
    return out


def due(profile_lines):
    """3. What is due within 3 days; what is overdue is asked about once (profile.py keeps the memory of that)."""
    lines = list(profile_lines)
    if not lines:
        return []
    head, rows, prefix = lines[0], [], []
    for line in lines[1:]:
        if line.startswith("- "):
            rows.append("\n".join([*prefix, line]))
            prefix = []
        else:
            prefix.append(line)
    return [head, *cap(rows, DUE_BYTES - nbytes([head]), lambda n: t(f"…{n} more, `dispatch profile show`", f"…还有 {n} 条，`dispatch profile show`"), 8)]


def prefs(pref_lines):
    """4. The person's preferences that apply here (prefs.prime_section already ranks and counts them)."""
    return cap(pref_lines, PREFS_BYTES, lambda n: t(f"…{n} more lines, `dispatch prefs list`", f"…还有 {n} 行，`dispatch prefs list`"), 40)


def pits(items, proj, line_of):
    """5. The newest five relevant pits, project and shared together. `items`: dated entries, oldest first."""
    relevant = [it for it in items if it.get("kind") == "pit" and
                (not it.get("project") or (proj and it["project"].lower() == proj.lower()))]
    if not relevant:
        return []
    rows = [line_of(it, PIT_WIDTH) for it in reversed(relevant[-PIT_COUNT:])]
    left = len(relevant) - len(rows)
    head = t(f"## Latest pitfalls ({clip(proj, 40) + ' + ' if proj else ''}shared)", f"## 最近的坑（{clip(proj, 40) + ' + ' if proj else ''}通用）")
    return [head, *cap(rows, PITS_BYTES - nbytes([head]), lambda n: t(f"…{n} more, `dispatch wiki search <word>`", f"…还有 {n} 条，`dispatch wiki search <词>`"), extra=left)]


def build(identity, sections, save=None, budget=BUDGET_BYTES):
    """The brief: the identity line, then the parts in order (empty ones left out), the pointer line last. When they do
    not fit in `budget`, whole parts go from the end (the pointer stays: it is the way to everything left out) and
    `save(full_text)` writes the complete text to a file; its path becomes the first line. Returns (text, cut)
    where `cut` names the parts that went."""
    parts = [(name, lines) for name, lines in sections if lines]
    keep = list(parts)
    identity = clip(identity, 160)
    def body():
        return [identity, *[line for _, lines in keep for line in lines], pointer()]
    full = "\n".join(body())
    if nbytes(body()) <= budget:
        return full, []
    try:
        where = save(full) if save else ""
    except OSError:
        where = ""
    location = (t(f"the whole brief is in {where}; read that file in full first", f"全文在 {where}，请先完整读取该文件") if where
                else t("the whole brief could not be saved; use the commands on the last line", "全文未能保存，用末行命令查阅"))
    cut = []
    def notice():
        return t(f"({location}; the brief was over its budget, so {', '.join(reversed(cut))} left out.)",
                 f"（{location}；简报超预算，{'、'.join(reversed(cut))} 未注入。）")
    # Include the actual path and notice, not a fixed estimate for them. Long paths and
    # section names must not push a supposedly bounded hook back over the engine limit.
    while keep and nbytes([notice(), *body()]) > budget:
        cut.append(keep.pop()[0])
    return "\n".join([notice(), *body()]), cut
