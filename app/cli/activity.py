# -*- coding: utf-8 -*-
"""Incremental, local transcript activity and shared read receipts.

Stores only recent visible events. Reasoning/system content is never surfaced.
Read receipts acknowledge a particular reply, never whatever arrived afterwards.
"""
from contextlib import closing
from functools import lru_cache
import datetime
import glob
import hashlib
import json
import os
import pathlib
import re
import sqlite3
from lang import t as _t
import time

import dplatform as P


def session_root():
    """DISPATCH_SESSION_ROOT (folders, os.pathsep-separated): only sessions whose working folder is under
    one of them are listed. A Dispatch IDE test instance sets it to its own folder (ide_e2e.py), so the
    real sessions on this Mac stay out."""
    return (os.environ.get('DISPATCH_SESSION_ROOT') or '').strip()


def _roots(root):
    out = set()
    for r in root.split(os.pathsep):
        if r.strip():
            r = os.path.normpath(os.path.expanduser(r.strip()))
            out |= {r, os.path.realpath(r)}
    return out


def in_session_root(cwd, root=None):
    """True when there is no session root, or `cwd` is the root or inside it (/tmp and /private/tmp alike)."""
    root = session_root() if root is None else root
    if not root:
        return True
    if not cwd:
        return False
    cwd = os.path.normpath(cwd)
    for c in {cwd, os.path.realpath(cwd)}:
        for r in _roots(root):
            if c == r or c.startswith(r.rstrip(os.sep) + os.sep):
                return True
    return False


def _flat(path):
    return re.sub(r'[^A-Za-z0-9]+', '-', path).strip('-')


def folder_may_be_in_root(name, root=None):
    """Claude Code (-Users-me-x) and pi (--Users-me-x--) name a transcript folder after its working
    folder: a cheap first cut before any file is read. The row's own cwd decides in the end."""
    root = session_root() if root is None else root
    if not root:
        return True
    flat = _flat(name)
    return any(flat == r or flat.startswith(r + '-') for r in map(_flat, _roots(root)))


def transcript_roots(home):
    """(folder, agent) of the JSON-lines transcripts under `home` (each engine's adapter says where; for this Mac's own
    home Codex follows CODEX_HOME)."""
    import engines
    return tuple((e.transcript_root(home), e.agent) for e in engines.known() if e.transcript_root(home))


def epoch(value):
    try:
        return datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return 0


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if isinstance(b, dict) and b.get('type') in ('text', 'input_text', 'output_text'))


def patch_files(text):
    """Read file names from a supplied patch without executing its contents."""
    import re
    return list(dict.fromkeys(re.findall(r'\*\*\* (?:Update|Add|Delete) File: ([^\n\r]+)', text.replace('\\n', '\n'))))


# Text that arrives in the transcript with role=user but was written by the harness, not the
# person: hook output, background-task completions, slash-command echoes, IDE context. It must
# not become a title, count as a turn, or make the Agent's answer to it an unread reply.
SYNTHETIC_TAGS = ('recommended_plugins', 'in-app-browser-context', 'environment_context', 'system-reminder', 'task-notification')
SYNTHETIC_PREFIXES = ('# AGENTS.md instructions', '<local-command', '<command-name>', '<command-message>', '<bash-input>', '<bash-stdout>', '<bash-stderr>',
                      '<task-notification', '<ide_', '<environment_context>', '<system-reminder>', 'Base directory for this skill:', '<skill>',
                      'The TodoWrite', '# In app browser', '# Files mentioned', '# Applications mentioned')


# The Agents window's note of the browser pages an agent may use (VS Code's browserToolHelpers.ts), sent with
# the person's message: its own message for OpenCode, so a handoff wrote it as the person's words (task-lj06.31)
BROWSER_PAGES = re.compile(r'(?:^|\n)[ \t]*(?:The following browser pages are currently shared with you[^\n]*|No browser pages are currently shared with you\.)'
                           r'(?:\n+[ \t]*(?:(?:[-*]|\d+\.)[ \t]+)?(?:\[[0-9A-Fa-f-]{8,}\][^\n]*|\d+ pages? (?:is|are) open but[^\n]*|Use the \'open_browser_page\' tool[^\n]*|Network domain policy is active[^\n]*))*')


def user_text(text):
    # Desktop envelopes are not user messages and must not clear unread replies.
    for tag in SYNTHETIC_TAGS:
        text = re.sub(r'<' + tag + r'\b[^>]*>[\s\S]*?</' + tag + r'>', '', text)
    text = BROWSER_PAGES.sub('', text).strip()
    if text.startswith(SYNTHETIC_PREFIXES): return ''
    return text.removeprefix('## My request:').strip()


def is_synthetic_user(text):
    """Non-empty user-role text that user_text() throws away entirely."""
    return bool((text or '').strip()) and not user_text(text)


@lru_cache(maxsize=1)
def own_titles(home):
    """{agent: {session id: the title the agent gave it}} of the engines that keep them apart (Codex)."""
    import engines
    return {e.agent: e.own_titles(home) for e in engines.known() if e.supports("own_titles")}


# what a session waits on when its activity names a question (English, Chinese): decorate() reads it back
ASK_PREFIX = ('waiting for your answer: ', '等你回答：')
ASK_STARTS = ('waiting for your answer', '等你回答')


def operation_summary(name, inp, raw):
    label = inp.get('title') or inp.get('description')
    if label: return str(label)[:180]
    command = inp.get('cmd') or inp.get('command')
    if command: return _t('running · ', '运行命令 · ') + str(command).split('\n')[0][:150]
    path = inp.get('file_path') or inp.get('path')
    if path: return str(path)
    if inp.get('query'): return _t('searching · ', '搜索 · ') + str(inp['query'])[:150]
    if name.split('.')[-1] == 'apply_patch': return _t('changing files · ', '修改文件 · ') + ', '.join(patch_files(str(raw)))[:160]
    if name.split('.')[-1] == 'exec':
        for key in ('title', 'cmd'):
            match = re.search(r'(?:"' + key + r'"|\b' + key + r')\s*:\s*("(?:\\.|[^"\\])*")', str(raw))
            if match:
                try: return (_t('running · ', '运行命令 · ') if key == 'cmd' else '') + json.loads(match[1]).split('\n')[0][:160]
                except ValueError: pass
        if 'write_stdin' in str(raw): return _t('reading a command\'s output', '读取命令执行结果')
        if 'view_image' in str(raw): return _t('looking at a screenshot', '检查截图')
        return _t('using a tool', '正在调用工具')
    return name


OPTION_LINE = re.compile(r'^(?:[-*•+]|\d{1,2}[.)、]|[A-Za-z][.)])\s+')


def question_of(text):
    """The question a finished reply ends on, as its last sentence ('' when it ends on a statement).
    A question followed by a list of options ("压测目标定多少？\n1. 1000 rps\n2. 2000 rps") counts
    too: the list is skipped and the line above it is the question. The workbench marks such a
    conversation 问你 and shows this sentence instead of the digest."""
    text = (text or '').strip()
    if not text or text.endswith('```'): return ''  # ends on a code block, not on words to the person
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    clean = lambda l: re.sub(r'[*_`#]+', '', OPTION_LINE.sub('', re.sub(r'^>\s+', '', l))).strip()
    last = clean(lines[-1])
    if not last.endswith(('?', '？')):
        # Walk up over the trailing option list; the line above it must be a plain question line
        # (not a heading, not another list item).
        i = len(lines) - 1
        while i >= 0 and OPTION_LINE.match(lines[i]): i -= 1
        if i == len(lines) - 1 or i < 0 or lines[i].startswith('#') or len(lines) - 1 - i > 9: return ''
        last = clean(lines[i])
        if not last.endswith(('?', '？', ':', '：')) or not re.search(r'[?？]', last): return ''
        last = last.rstrip(':：').strip()
        if not last.endswith(('?', '？')): last = last[:max(last.rfind('?'), last.rfind('？')) + 1]
    parts = [x for x in re.split(r'(?<=[。！？!?；;])\s*|(?<=\.)\s+', last) if x and x.strip()]
    q = parts[-1].strip()
    if len(q) < 8 and len(parts) > 1: q = parts[-2].strip() + ' ' + q
    return q[:200]


def remember_topic(state, text):
    """An extractive overview of user goals across the transcript, not last reply.

    Keep the opening goal and recent distinct changes even after event trimming.
    Only user-visible text is used; no reasoning or tool payloads are summarized.
    """
    if '## My request' in text:
        text = re.split(r'## My request[^\n]*\n', text)[-1]
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\[Image[^\]]*\]', '', text, flags=re.IGNORECASE).strip()
    text = re.sub(r'!\[[^]]*\]\([^)]*\)', '', text)
    text = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'[*`#]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) < 12 or text.startswith(('【Dispatch 连通性测试】', '[Request interrupted')):
        return
    topic = text[:100].rstrip() + ('…' if len(text) > 100 else '')
    topics = state.setdefault('topics', [])
    if topic in topics: return
    topics.append(topic)
    if len(topics) > 24: topics[1:2] = []
    selected = topics if len(topics) <= 3 else [topics[0], *topics[-2:]]
    state['overview'] = (_t('First: ', '最初：') + selected[0] + _t('; then: ', '；后续：') + _t('; ', '；').join(selected[1:])) if len(selected) > 1 else selected[0]


TASK_DONE = ('completed', 'failed', 'killed', 'stopped', 'cancelled', 'error')


def observe_background(state, d, t, p, ts):
    """Claude Code background sub-agents. Launching one writes a tool result whose toolUseResult is
    {isAsync, status: async_launched, agentId}; it ending comes back as a <task-notification> (in a
    queued_command attachment, a queue-operation or a user record — idempotent here). The turn that
    launched them can end long before they do; activity_list uses this to keep the session working."""
    tr = d.get('toolUseResult')
    if isinstance(tr, dict) and tr.get('isAsync') and tr.get('agentId'):
        bg = state.setdefault('bg_agents', {})
        bg[str(tr['agentId'])] = {'at': ts, 'desc': str(tr.get('description') or '')[:120]}
        if len(bg) > 40: state['bg_agents'] = dict(list(bg.items())[-40:])
    if not state.get('bg_agents'): return
    a = d.get('attachment') if isinstance(d.get('attachment'), dict) else {}
    raw = a.get('prompt') if a.get('type') == 'queued_command' else d.get('content') if t == 'queue-operation' else text_of(p.get('content')) if t == 'user' and isinstance(p, dict) else ''
    if not isinstance(raw, str) or '<task-notification>' not in raw: return
    for block in raw.split('<task-notification>')[1:]:
        tid = re.search(r'<task-id>([^<]+)</task-id>', block); status = re.search(r'<status>([^<]+)</status>', block)
        rec = state['bg_agents'].get(tid.group(1).strip()) if tid else None
        if rec is not None and status and status.group(1).strip() in TASK_DONE:
            rec['done_at'] = max(ts, rec.get('done_at', 0))


def background_running(s, path, now=None):
    """The session's background sub-agents still at work: not reported finished, or written to again
    after their last report (resumed with SendMessage), and their own transcript touched recently.
    A launch whose file never appeared counts only for a minute (it may be starting)."""
    now = now or time.time()
    folder = os.path.join(path[:-len('.jsonl')] if path.endswith('.jsonl') else path, 'subagents')
    out = []
    for aid, rec in (s.get('bg_agents') or {}).items():
        try: mtime = os.stat(os.path.join(folder, f'agent-{aid}.jsonl')).st_mtime
        except OSError: mtime = 0
        if not mtime:
            if not rec.get('done_at') and now - rec.get('at', 0) < 60: out.append((aid, rec, rec.get('at', 0)))
            continue
        if now - mtime > BACKGROUND_QUIET: continue
        if not rec.get('done_at') or mtime > rec['done_at'] + 2: out.append((aid, rec, mtime))
    return out


BACKGROUND_QUIET = 15 * 60  # a sub-agent silent this long has died or hangs; stop claiming the session works


def observe(state, d):
    t = d.get('type')
    p = d.get('payload') or d.get('message') or {}
    ts = epoch(d.get('timestamp'))
    if ts: observe_background(state, d, t, p, ts)
    role = ''; text = ''; tools = []; results = []; finished = False
    if t == 'session_meta':
        state['session_id'] = p.get('id') or p.get('session_id') or state.get('session_id')
        state['cwd'] = p.get('cwd', state.get('cwd', ''))
        # Which Codex front end started it (VS Code extension, desktop app, terminal, `codex exec`).
        src = (p.get('source') or p.get('originator') or '').strip().lower()
        state['entrypoint'] = {'vscode': 'vscode', 'codex_vscode': 'vscode', 'codex desktop': 'desktop', 'codex_work_desktop': 'desktop', 'exec': 'exec', 'codex_exec': 'exec'}.get(src, 'cli' if src else state.get('entrypoint', ''))
    if t == 'ai-title':
        state['title'] = d.get('aiTitle') or state.get('title', '')
    if t == 'turn_context':
        state['cwd'] = p.get('cwd', state.get('cwd', ''))
    if t == 'event_msg':
        if p.get('type') == 'task_started':
            state['state'] = 'working'; state['activity'] = _t('working', '正在处理'); state['last_at'] = ts
        elif p.get('type') in ('task_complete', 'turn_aborted'):
            finished = True
            if p.get('last_agent_message'):
                role, text = 'assistant', p['last_agent_message']
    elif t == 'response_item':
        if p.get('type') == 'message':
            role, text = p.get('role'), text_of(p.get('content'))
            finished = role == 'assistant' and p.get('phase') == 'final'
        elif p.get('type') in ('function_call', 'custom_tool_call'):
            tools = [(p.get('call_id', ''), p.get('name', ''), p.get('arguments', p.get('input', '')))]
        elif p.get('type') in ('function_call_output', 'custom_tool_call_output'):
            results = [(p.get('call_id', ''), p.get('output', ''))]
    elif t == 'session' and isinstance(d.get('cwd'), str):
        # pi: the first record names the session and its directory.
        state['session_id'] = d.get('id') or state.get('session_id'); state['cwd'] = d.get('cwd') or state.get('cwd', '')
    elif t == 'message' and isinstance(p, dict) and p.get('role') in ('user', 'assistant', 'toolResult'):
        # pi: one record per message; tool calls and thinking are blocks inside an assistant message.
        r = p.get('role')
        role, text = (r if r != 'toolResult' else ''), (text_of(p.get('content')) if r != 'toolResult' else '')
        for b in p.get('content') or []:
            if not isinstance(b, dict): continue
            if b.get('type') == 'toolCall': tools.append((b.get('id', ''), b.get('name', ''), b.get('arguments', {})))
        if r == 'toolResult':
            results = [(p.get('toolCallId', ''), {'error': bool(p.get('isError'))})]
        finished = role == 'assistant' and bool(text.strip()) and not tools
    elif t in ('user', 'assistant') and not d.get('isSidechain'):
        role, text = t, text_of(p.get('content'))
        state['cwd'] = d.get('cwd') or state.get('cwd', '')
        for b in p.get('content') or []:
            if not isinstance(b, dict): continue
            if b.get('type') == 'tool_use': tools.append((b.get('id', ''), b.get('name', ''), b.get('input', {})))
            elif b.get('type') == 'tool_result': results.append((b.get('tool_use_id', ''), {'error': b.get('is_error', False)}))
        # Claude's assistant text without a tool call completes a response; hooks can override busy state.
        finished = role == 'assistant' and bool(text.strip()) and not tools
    raw_user = text if role == 'user' else ''
    if role == 'user': text = user_text(text)
    if not ts: return
    if role == 'user' and raw_user.strip() and not text.strip():
        if '<task-notification' in raw_user:
            # A background task finishing is not harness noise: the report the agent writes after it
            # is the reply the person actually waits for, so earlier hook events stop counting.
            state['synthetic_at'] = 0
        else:
            # A harness event (hook, command echo). Remember when, so the reply it provokes is not
            # counted as an answer the person is waiting for.
            state['synthetic_at'] = max(ts, state.get('synthetic_at', 0))
    events = state.setdefault('events', [])
    def event(kind, summary, **extra):
        eid = hashlib.sha256((str(ts)+kind+summary).encode()).hexdigest()[:20]
        if not any(e['id'] == eid for e in events):
            events.append(dict(id=eid, ts=ts, kind=kind, text=summary[:400], **extra))
        state['last_at'] = max(ts, state.get('last_at', 0))
    if role == 'user' and text.strip() and not text.lstrip().startswith(('<environment_context>', '<system-reminder>', '<local-command', '<command-name>')):
        state['user_at'] = ts
        remember_topic(state, text)
        state['state'], state['activity'] = 'working', _t('working on your message', '正在处理你的消息')
        if not state.get('title'): state['title'] = text.strip().split('\n')[0][:100]
        event('user', text)
    elif role == 'assistant' and text.strip():
        event('reply' if finished else 'message', text)
        digest = hashlib.sha256(text.encode()).hexdigest()[:20]
        # task_complete may repeat the same final message; don't create another unread reply.
        # The person's last message was already answered and what came since was a harness event:
        # this reply answers the machine, not them — keep the existing reply_id so nothing turns unread.
        answered = state.get('reply_at', 0) >= state.get('user_at', 0) and state.get('reply_id')
        synthetic_turn = answered and state.get('synthetic_at', 0) > state.get('user_at', 0)
        if finished and not synthetic_turn and (digest != state.get('reply_digest') or state.get('user_at', 0) > state.get('reply_at', 0)):
            state.update(reply_id=f'{ts}:{digest}', reply_at=ts, reply_digest=digest, reply_preview=text[:280], question=question_of(text))
        state['activity'] = _t('replied', '已回复') if finished else _t('replying', '正在回复')
        state['state'] = 'idle' if finished else 'working'
    pending = state.setdefault('pending', {})
    for call_id, name, raw in tools:
        try: inp = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError): inp = {}
        inp = inp if isinstance(inp, dict) else {}
        summary = operation_summary(name, inp, raw)
        paths = patch_files(str(raw)) if name.split('.')[-1] == 'apply_patch' else []
        if name.lower() in ('edit', 'write', 'write_file', 'edit_file', 'notebookedit'):
            path = inp.get('file_path') or inp.get('path')
            if path: paths.append(path)
        pending[call_id] = {'name': name, 'paths': paths, 'summary': summary[:160]}
        # Display operation names, not hidden model reasoning.
        event('tool', summary, tool=name, paths=paths)
        state['state'], state['activity'] = 'working', f'{name} · {summary[:160]}'
        if name == 'AskUserQuestion':
            # The turn is parked on a picker; say what it asks, so the list shows the question.
            qs = inp.get('questions') if isinstance(inp, dict) else None
            first = qs[0].get('question', '') if isinstance(qs, list) and qs and isinstance(qs[0], dict) else ''
            state['activity'] = ASK_PREFIX[_t(0, 1)] + first[:140] if first else _t('waiting for your answer to a question', '等你回答一个问题')
    for call_id, output in results:
        op = pending.pop(call_id, None)
        if op:
            failed = isinstance(output, dict) and bool(output.get('error'))
            if isinstance(output, str):
                failed = '"isError":true' in output.replace(' ', '') or 'exit code 1' in output
            event('error' if failed else 'result', (_t('failed · ', '失败 · ') if failed else _t('returned · ', '已返回 · ')) + op['name'], paths=op['paths'])
            if not failed:
                for path in op['paths']:
                    state.setdefault('files', {})[path] = ts
            state['activity'] = _t('a tool failed', '工具执行失败') if failed else _t('ran · ', '已执行 · ') + str(op.get('summary', op['name']))
            state['state'] = 'working'
    if finished:
        state['state'] = 'idle'
        state['activity'] = _t('replied', '已回复') if text else _t('this turn is over', '本轮已结束')
    state['events'] = events[-80:]
    if len(pending) > 100: state['pending'] = dict(list(pending.items())[-100:])


def connect(directory):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, 'activity.sqlite')
    db = sqlite3.connect(path, timeout=15)
    os.chmod(path, 0o600)
    db.execute('CREATE TABLE IF NOT EXISTS streams (path TEXT PRIMARY KEY, inode INTEGER, off INTEGER, mtime REAL, data TEXT)')
    # Which session each cached stream belongs to, so one session is found by index instead of a
    # LIKE over every path. A table of its own, on purpose: the desktop app, the phone service and a
    # source checkout can be different versions sharing this file, and an older one writes `streams`
    # with positional values — adding a column there broke every activity read (task-lhk2).
    db.execute('CREATE TABLE IF NOT EXISTS stream_sids (path TEXT PRIMARY KEY, sid TEXT)')
    db.execute('CREATE INDEX IF NOT EXISTS stream_sids_sid ON stream_sids(sid)')
    db.execute('CREATE TABLE IF NOT EXISTS read_replies (key TEXT, reply_id TEXT, PRIMARY KEY(key, reply_id))')
    db.execute('CREATE TABLE IF NOT EXISTS session_preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL)')
    db.execute('INSERT OR IGNORE INTO settings VALUES (?, ?)', ('started_at', time.time()))
    db.commit()
    return db


def read_stream(db, path, agent):
    st = os.stat(path)
    row = db.execute('SELECT inode,off,mtime,data FROM streams WHERE path=?', (path,)).fetchone()
    state = json.loads(row[3]) if row and row[0] == st.st_ino and row[1] <= st.st_size else {}
    if state.get('parser_version') != 8: state = {}  # 8: the question a reply ends on
    off = row[1] if state else 0
    state['parser_version'] = 8
    if row and off > 0 and row[2] == st.st_mtime and off == st.st_size: return state
    state.setdefault('agent', agent)
    state.setdefault('session_id', os.path.basename(path).removesuffix('.jsonl'))
    with open(path, 'rb') as f:
        f.seek(off)
        while True:
            line = f.readline()
            if not line: break
            if not line.endswith(b'\n'): break  # don't consume an in-flight JSON record
            off = f.tell()
            try: observe(state, json.loads(line))
            except (ValueError, TypeError, AttributeError): continue
    state['version'] = f'{st.st_ino}:{off}'
    db.execute('INSERT OR REPLACE INTO streams VALUES (?,?,?,?,?)', (path, st.st_ino, off, st.st_mtime, json.dumps(state, ensure_ascii=False)))
    if state.get('session_id'): db.execute('INSERT OR REPLACE INTO stream_sids VALUES (?,?)', (path, state['session_id']))
    return state


def acknowledge(directory, key, reply_id):
    float(reply_id.split(':', 1)[0])  # validate the cursor format
    with closing(connect(directory)) as db, db:
        db.execute('INSERT OR IGNORE INTO read_replies VALUES (?,?)', (key, reply_id))
    return {'ok': True}


def unacknowledge(directory, key):
    """Forget the read receipt so the latest reply shows as unread again (the menu's 标为未读)."""
    with closing(connect(directory)) as db, db:
        db.execute('DELETE FROM read_replies WHERE key=?', (key,))
    return {'ok': True, 'unread': True}


def set_preferences(directory, key, changes):
    if not isinstance(key, str) or ':' not in key or len(key) > 250: raise ValueError(_t('Not a valid session id', '无效的会话标识'))
    if not isinstance(changes, dict) or set(changes) - {'scheduled', 'project_override', 'title_override', 'starred', 'archived', 'summary', 'summary_at', 'summary_version', 'summary_by', 'summary_mtime', 'unread_summary', 'unread_summary_reply', 'unread_summary_at', 'unread_summary_by', 'switched_from', 'switched_to'}: raise ValueError(_t('Not a valid field', '无效的分类字段'))
    for flag in ('scheduled', 'starred', 'archived'):
        if flag in changes and type(changes[flag]) is not bool: raise ValueError(_t('A flag must be true or false', '标记必须是布尔值'))
    if 'project_override' in changes:
        value=changes['project_override']
        if not isinstance(value, str) or len(value.strip()) > 120 or any(ord(c)<32 for c in value): raise ValueError(_t('Not a valid project name', '无效的项目名称'))
        changes={**changes, 'project_override':value.strip()}
    if 'title_override' in changes:  # a name the user gave the conversation; empty restores the derived title
        value=changes['title_override']
        if not isinstance(value, str) or len(value.strip()) > 120 or any(ord(c)<32 for c in value): raise ValueError(_t('Not a valid session name', '无效的会话名称'))
        changes={**changes, 'title_override':value.strip()}
    with closing(connect(directory)) as db, db:
        row=db.execute('SELECT data FROM session_preferences WHERE key=?',(key,)).fetchone()
        data={**(json.loads(row[0]) if row else {}), **changes}
        db.execute('INSERT OR REPLACE INTO session_preferences VALUES (?,?)',(key,json.dumps(data,ensure_ascii=False)))
    return data


def session_preferences(directory):
    with closing(connect(directory)) as db:
        return {key: json.loads(data) for key, data in db.execute('SELECT key,data FROM session_preferences')}


def apply_preferences(row, prefs):
    """Fold a conversation's stored preferences into its row; a user-given name replaces the derived title."""
    row.update(prefs or {})
    if row.get('title_override'):
        row['title'] = row['title_override']
    return row


# ZCode (an OpenCode-based desktop app) and OpenCode keep conversations in one SQLite file each instead of
# transcripts (each engine's adapter says where: sqlite_store). Their sessions are read into the same row shape
# observe() produces, so the workbench and inbox treat them like every other agent's. {agent: (file under the home,
# the column that orders parts)}.
def _sqlite_stores():
    import engines
    return {e.agent: (e.sqlite_store("")["db"], e.sqlite_store("")["seq"]) for e in engines.known() if e.supports("sqlite_store")}


SQLITE_STORES = _sqlite_stores()
ZCODE_PARSER = 3


def zcode_state(z, s, agent='zcode', seq='sequence'):
    sid = s['id']
    state = {'parser_version': ZCODE_PARSER, 'agent': agent, 'session_id': sid, 'cwd': s['directory'] or '', 'title': (s['title'] or '')[:100],
             'last_at': s['time_updated'] / 1000, 'state': 'idle', 'activity': '', 'events': [], 'version': f'0:{s["time_updated"]}'}
    events = state['events']
    def event(ts, kind, summary, **extra):
        eid = hashlib.sha256((str(ts) + kind + summary).encode()).hexdigest()[:20]
        if not any(e['id'] == eid for e in events):
            events.append(dict(id=eid, ts=ts, kind=kind, text=summary[:400], **extra))
    parts = {}
    for r in z.execute(f"SELECT message_id, data FROM part WHERE session_id=? AND json_extract(data,'$.type') IN ('text','tool') ORDER BY time_created, {seq}", (sid,)):
        try: parts.setdefault(r['message_id'], []).append(json.loads(r['data']))
        except (ValueError, TypeError): continue
    for r in z.execute(f'SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, {seq}', (sid,)):
        try: m = json.loads(r['data'])
        except (ValueError, TypeError): continue
        t = m.get('time') or {}
        created = (t.get('created') or 0) / 1000
        completed = (t.get('completed') or 0) / 1000
        if not created: continue
        text = '\n'.join(p.get('text', '') for p in parts.get(r['id'], []) if p.get('type') == 'text')
        if m.get('role') == 'user':
            text = user_text(text)
            if not text.strip(): continue
            state['user_at'] = created
            remember_topic(state, text)
            state['state'], state['activity'] = 'working', _t('working on your message', '正在处理你的消息')
            if not state.get('title'): state['title'] = text.strip().split('\n')[0][:100]
            event(created, 'user', text)
            continue
        for p in parts.get(r['id'], []):
            if p.get('type') != 'tool': continue
            name = p.get('tool', ''); st = p.get('state') or {}
            inp = st.get('input') if isinstance(st.get('input'), dict) else {}
            summary = operation_summary(name, inp, json.dumps(inp, ensure_ascii=False))
            paths = [x for x in [inp.get('filePath') or inp.get('file_path') or inp.get('path')] if x] if name.lower() in ('edit', 'write') else []
            event(created, 'tool', summary, tool=name, paths=paths)
            status = st.get('status')
            if status in ('completed', 'error'):
                failed = status == 'error'
                event(completed or created, 'error' if failed else 'result', (_t('failed · ', '失败 · ') if failed else _t('returned · ', '已返回 · ')) + name, paths=paths)
                if not failed:
                    for path in paths: state.setdefault('files', {})[path] = completed or created
                state['activity'] = _t('a tool failed', '工具执行失败') if failed else _t('ran · ', '已执行 · ') + summary[:160]
            else:
                state['activity'] = f'{name} · {summary[:160]}'
            state['state'] = 'working'
        # A turn is over when the model stopped on its own; 'tool-calls' means another step follows.
        finished = bool(completed) and m.get('finish') != 'tool-calls'
        if text.strip():
            event(completed or created, 'reply' if finished else 'message', text)
            if finished:
                digest = hashlib.sha256(text.encode()).hexdigest()[:20]
                if digest != state.get('reply_digest') or state.get('user_at', 0) > state.get('reply_at', 0):
                    state.update(reply_id=f'{completed}:{digest}', reply_at=completed, reply_digest=digest, reply_preview=text[:280], question=question_of(text))
            state['activity'] = _t('replied', '已回复') if finished else _t('replying', '正在回复')
        if finished:
            state['state'] = 'idle'
            if not text.strip(): state['activity'] = _t('this turn is over', '本轮已结束')
        elif not completed:
            state['state'] = 'working'
    state['events'] = events[-80:]
    return state


def ro_uri(path):
    """Read-only sqlite URI for `path`. pathlib builds a proper file: URI on every OS (a Windows
    path's drive letter and backslashes break a hand-made one; spaces and # are escaped)."""
    return pathlib.Path(os.path.abspath(path)).as_uri() + '?mode=ro'


def zcode_sessions(home, db, limit=60, agent='zcode'):
    rel, seq = SQLITE_STORES[agent]
    path = os.path.join(home, rel)
    if not os.path.exists(path): return []
    try:
        z = sqlite3.connect(ro_uri(path), uri=True, timeout=2)
        z.row_factory = sqlite3.Row
    except sqlite3.Error: return []
    rows = []
    with closing(z):
        try:
            sessions = z.execute('SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?', (limit,)).fetchall()
        except sqlite3.Error: return []
        for s in sessions:
            key = f'{agent}:{s["id"]}'
            cached = db.execute('SELECT off,data FROM streams WHERE path=?', (key,)).fetchone()
            if cached and cached[0] == s['time_updated']:
                state = json.loads(cached[1])
                if state.get('parser_version') == ZCODE_PARSER:
                    rows.append(state); continue
            try: state = zcode_state(z, s, agent, seq)
            except sqlite3.Error: continue
            db.execute('INSERT OR REPLACE INTO streams VALUES (?,?,?,?,?)', (key, 0, s['time_updated'], s['time_updated'] / 1000, json.dumps(state, ensure_ascii=False)))
            if state.get('session_id'): db.execute('INSERT OR REPLACE INTO stream_sids VALUES (?,?)', (key, state['session_id']))
            rows.append(state)
    return rows


# Hermes Agent keeps its sessions (CLI chats, Telegram / 微信 turns, cron jobs) in ~/.hermes/state.db:
# `sessions` + `messages` with OpenAI-style tool_calls and one `tool` row per result.
def transcript_states(directory, session_ids):
    """What each transcript last said about a session: {session_id: (state, last_at)}.
    Read from the parsed-stream cache, so this costs one small query per session."""
    out = {}
    if not session_ids: return out
    with closing(connect(directory)) as db:
        for sid in session_ids:
            hits = db.execute('SELECT s.data FROM stream_sids i JOIN streams s ON s.path=i.path WHERE i.sid=?', (sid,)).fetchall()
            # Streams cached before the side table existed (or by an older version) are still found by path.
            for (data,) in hits or db.execute('SELECT data FROM streams WHERE path LIKE ?', ('%' + sid + '%',)):
                try: s = json.loads(data)
                except ValueError: continue
                if s.get('session_id') != sid or not s.get('last_at'): continue
                if sid not in out or s['last_at'] > out[sid][1]: out[sid] = (s.get('state', ''), s['last_at'])
    return out


def hook_presence(directory):
    """Sessions whose hooks report a live process, by session id. A transcript goes quiet for
    the whole of a long tool call, but a running pid whose last hook event said working is
    still working, not stale."""
    folder = os.path.join(directory, 'sessions')
    out = {}
    for name in (os.listdir(folder) if os.path.isdir(folder) else []):
        try:
            with open(os.path.join(folder, name), encoding='utf-8') as f: rec = json.load(f)
        except (OSError, ValueError): continue
        pid = rec.get('agent_pid')
        if not rec.get('session_id') or not isinstance(pid, int) or pid <= 0: continue
        if not P.pid_alive(pid): continue  # alive also when owned by someone else
        out[rec['session_id']] = rec
    return out


def transcript_files(root):
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    if e.is_dir(follow_symlinks=False):
                        if e.name != 'subagents': stack.append(e.path)
                    elif e.name.endswith('.jsonl'):
                        yield e.path
        except OSError:
            continue


_VAULTS = {}
def obsidian_vault(cwd):
    """True when cwd (or a parent up to the home folder) is an Obsidian vault (has .obsidian/)."""
    if not cwd: return False
    if cwd not in _VAULTS:
        d, found = os.path.abspath(cwd), False
        home = os.path.expanduser('~')
        while d and d != os.path.dirname(d) and d != home:
            if os.path.isdir(os.path.join(d, '.obsidian')): found = True; break
            d = os.path.dirname(d)
        _VAULTS[cwd] = found
    return _VAULTS[cwd]


def chat_held(directory):
    """{key: registry entry} of the sessions Dispatch's in-app chat sidecar holds (chatd.json while
    that chatd is alive)."""
    try:
        from chatd import read_registry
        reg = read_registry(directory)
    except Exception:
        return {}
    return dict((reg or {}).get('sessions') or {})


def chat_started(directory):
    """Keys of every conversation that ever ran in Dispatch's in-app chat."""
    try:
        import chat_protocol
        return chat_protocol.read_started(directory)
    except Exception:
        return {}


def runner_of(key, held, live):
    """Where a conversation runs: 'dispatch' (chatd holds it), 'terminal' (a terminal process does)
    or ''. A session chatd only keeps as stopped (idle-reaped) loses to a live terminal process."""
    h = held.get(key)
    if h is not None and not (live and isinstance(h, dict) and h.get('lifecycle') == 'stopped'):
        return 'dispatch'
    return 'terminal' if live else ''


def activity_list(home, directory, index):
    import engines
    paths = []
    root = session_root()
    by_folder = {e.agent: e.transcript_by_folder for e in engines.known()}
    for folder, agent in transcript_roots(home):
        # Walk instead of a recursive glob: sub-agent folders (often the bulk of the files) are
        # pruned without being listed, and scandir hands over each entry's type for free.
        for path in transcript_files(folder):
            if root and by_folder.get(agent) and not folder_may_be_in_root(os.path.relpath(path, folder).split(os.sep)[0], root):
                continue
            try: paths.append((os.stat(path).st_mtime, path, agent))
            except OSError: pass
    paths.sort(reverse=True)
    rows = []
    titles = own_titles(home)
    presence = hook_presence(directory)
    held = chat_held(directory)
    in_app = chat_started(directory)
    with closing(connect(directory)) as db, db:
        started_at = db.execute('SELECT value FROM settings WHERE key=?', ('started_at',)).fetchone()[0]
        def decorate(s, path, agent):
            e = index.get(path, {})
            s['title'] = titles.get(agent, {}).get(s['session_id']) or user_text(e.get('title') or '') or user_text(s.get('title') or '') or os.path.basename(s.get('cwd', '')) or 'Untitled session'
            s['tasks'] = list(e.get('tasks', {}))
            s['path'] = path
            s['project'] = os.path.basename(s.get('cwd', ''))
            s['entrypoint'] = e.get('entrypoint') or s.get('entrypoint', '')
            s['key'] = s['agent'] + ':' + s['session_id']
            if s['key'] in in_app:
                # started (or taken over) in Dispatch: `claude -p` wrote "sdk-cli", but a person chats here
                s['entrypoint'] = 'dispatch'
            elif s['entrypoint'] == 'sdk-ts' and obsidian_vault(s.get('cwd', '')):
                # Claudian (Claude Code inside Obsidian) runs through the TypeScript Agent SDK, so its entrypoint
                # looks like a script's; a vault folder as cwd marks it as a person's chat. `claude -p` (sdk-cli)
                # in a vault is still a script.
                s['app'] = 'claudian'
            prefs = db.execute('SELECT data FROM session_preferences WHERE key=?', (s['key'],)).fetchone()
            apply_preferences(s, json.loads(prefs[0]) if prefs else {})
            receipt = db.execute('SELECT reply_id FROM read_replies WHERE key=? AND reply_id=?', (s['key'], s.get('reply_id'))).fetchone()
            s['unread'] = bool(s.get('reply_at', 0) > max(started_at, s.get('user_at', 0)) and (not receipt or receipt[0] != s.get('reply_id')))
            s['tracking_since'] = started_at
            live = presence.get(s['session_id'])
            # Where it runs: Dispatch's chat sidecar holds it, a terminal process does, or nothing.
            s['runner'] = runner_of(s['key'], held, live)
            if s['runner'] == 'dispatch' and isinstance(held.get(s['key']), dict):
                # chatd's own word on it: running / idle / waiting_* while its process is up, stopped once the idle reaper closed it
                s['chat_lifecycle'] = held[s['key']].get('lifecycle') or ''
            if s.get('bg_agents'):  # Claude Code's background sub-agents (its records name them)
                running = background_running(s, path)
                if running:
                    # The reply is out but its sub-agents still work: the session is not done. Their
                    # writes are its latest activity (so a Stop hook's "idle" does not win the merge).
                    first = running[0][1].get('desc') or _t('sub-agent', '子 Agent')
                    s['state'] = 'working'
                    s['activity'] = _t(f'sub-agent running · {first}', f'子 Agent 在跑 · {first}') + (_t(f' and {len(running) - 1} more', f' 等 {len(running)} 个') if len(running) > 1 else '')
                    s['last_at'] = max(s['last_at'], *(m for _, _, m in running))
                    s['background_agents'] = [{'id': aid, 'description': rec.get('desc', '')} for aid, rec, _ in running]
            quiet = s.get('state') == 'working' and time.time() - s['last_at'] > 180
            # A quiet transcript with a live process whose hooks still say working is a long tool
            # call or a long reply being written, not a dead session.
            held_here = s.pop('held', False)
            s['stale'] = quiet and not (live and live.get('state') == 'working') and not held_here
            s['source'] = 'transcript'
            # What the person first asked, for the Detail's 「你当时说」 once the row carries a short name.
            s['first_prompt'] = (s.get('topics') or [''])[0]
            # What the conversation waits on: a permission dialog or picker (the hook says so), or a
            # question its latest reply ends on. The workbench sorts 要确认 / 问你 ahead of plain replies.
            asks = s.get('question') if s.get('reply_at', 0) >= s.get('user_at', 0) and s.get('state') != 'working' else ''
            if live and live.get('attention') == 'input':
                picker = str(s.get('activity', ''))
                s['waiting'] = 'question' if picker.startswith(ASK_STARTS) else 'dialog'
                prefix = next((p for p in ASK_PREFIX if picker.startswith(p)), '')
                if prefix: asks = s['question'] = picker[len(prefix):]
            else:
                s['waiting'] = 'question' if asks else ''
            # An in-app chat stopped on a permission card or a question: chatd's registry says so, the transcript does not.
            h = held.get(s['key']) if s['runner'] == 'dispatch' else None
            if isinstance(h, dict) and h.get('lifecycle') in ('waiting_permission', 'waiting_input'):
                s['waiting'] = 'question' if h['lifecycle'] == 'waiting_input' else 'dialog'
            if not asks and s['waiting'] != 'question': s.pop('question', None)
            s.pop('topics', None); s.pop('pending', None); s.pop('reply_digest', None); s.pop('bg_agents', None)
            rows.append(s)
        for _, path, agent in paths[:120]:
            try: s = dict(read_stream(db, path, agent))
            except OSError: continue
            if not s.get('last_at'): continue
            decorate(s, path, agent)
        for agent in SQLITE_STORES:
            for s in zcode_sessions(home, db, agent=agent):
                if s.get('last_at'): decorate(dict(s), f'{agent}:{s["session_id"]}', agent)
        # an engine that keeps its conversations in a store of its own (Hermes' state.db, Gemini CLI's JSON files)
        # reads them into the same rows (its adapter's activity_sessions)
        import engines
        for eng in engines.known():
            if eng.supports('activity_sessions'):
                for key, s in eng.activity_sessions(home, db):
                    if s.get('last_at'): decorate(dict(s), key, eng.agent)
    # A resumed Codex task can have more than one rollout file with the same id.
    # Keep its newest observation; duplicate React keys otherwise accumulate rows.
    unique = {}
    for row in sorted(rows, key=lambda s: -s['last_at']):
        if in_session_root(row.get('cwd'), root): unique.setdefault(row['key'], row)
    return list(unique.values())


WORKSPACE_FILES_MAX = 500


def workspace_changes(cwd):
    """Current Git workspace diff, explicitly not attributed to one conversation."""
    import subprocess
    def git(*args):
        r = subprocess.run(['git', '-C', cwd, *args], capture_output=True, timeout=5, creationflags=P.no_window_flags())
        if r.returncode: raise ValueError(_t('Not a Git work folder, or it cannot be read right now', '不是 Git 工作区或暂时无法读取'))
        return r.stdout.decode('utf-8', 'replace')
    try:
        root = git('rev-parse', '--show-toplevel').strip()
        cwd = root
        # Include staged and unstaged changes, paths from NUL-delimited Git output.
        paths = git('diff', 'HEAD', '--name-only', '-z').split('\0')
        untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
        untracked_set = set(untracked)
        files = []
        for path in list(dict.fromkeys(paths + untracked)):
            if not path: continue
            files.append({'path': path, 'untracked': path in untracked_set})
        patch = git('diff', '--no-ext-diff', '--no-color', 'HEAD', '--')
        # An unignored node_modules is tens of thousands of paths: megabytes the page would parse on
        # every open for a folded list nobody reads. Keep the first ones and say how many there are.
        return {'root': root, 'files': files[:WORKSPACE_FILES_MAX], 'total': len(files), 'patch': patch[:100000], 'truncated': len(patch) > 100000}
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return {'root': cwd, 'files': [], 'patch': '', 'unavailable': str(e)}
