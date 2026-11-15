# -*- coding: utf-8 -*-
"""`dispatch reply`: the reply box on the phone (and for a conversation the desktop has not opened
yet). Every message goes to the running Dispatch's chatd, which holds the conversation or opens the
same transcript again; its turn_started / queued reply is the receipt. Receipts are durable and
idempotent per request id, so a retried send never goes out twice.
"""
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import closing

import chat_client
from lang import t as _t



class Rejected(Exception):
    """Known not to have submitted input."""


# Quotes: what Dispatch IDE's Quote (⇧⌘L) sends in front of a message, the same text for the agent
# (dispatch-ide patches/315-quote.patch, dispatchQuoteAttachmentMeta.ts renderDispatchQuoteText):
# each quote a `>` paragraph, one from a file or a diff first names `file:line`; blank lines between
# them, a blank line, then the person's words.
QUOTE_MAX_LINES = 20
QUOTE_MAX_CHARS = 1500
_LOCATION = re.compile(r'^(?P<file>[^\s>][^\n]*?):(?P<line>\d+)(?:-(?P<end>\d+))?$')


def quote_lines(text):
    lines = text.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n').split('\n')
    cut = len(lines) > QUOTE_MAX_LINES
    joined = '\n'.join(lines[:QUOTE_MAX_LINES])
    if len(joined) > QUOTE_MAX_CHARS:
        joined, cut = joined[:QUOTE_MAX_CHARS], True
    return '\n'.join(f'> {l}' if l else '>' for l in joined.split('\n')) + ('\n> …' if cut else '')


def compose_quoted(text, quotes):
    """`quotes`: [{'text', 'from'?: 'NOTES.md:9'}] in order. The message the agent reads."""
    parts = []
    for q in quotes or []:
        body = (q.get('text') or '').strip('\n')
        if not body.strip():
            continue
        where = (q.get('from') or '').strip()
        parts.append(f'{where}\n{quote_lines(body)}' if where else quote_lines(body))
    if not parts:
        return text
    head = '\n\n'.join(parts)
    return f'{head}\n\n{text}' if text.strip() else head


def parse_quotes(text):
    """The quotes in front of a user message (the `>` paragraphs, each maybe after a `file:line` line),
    as [{'text', 'from': 'reply' | 'file', 'file'?, 'line'?, 'end'?}]; [] when it does not start with one."""
    if not text or not (text.startswith('>') or '\n>' in text[:400]):
        return []
    out = []
    paras = re.split(r'\n[ \t]*\n', text)
    for para in paras:
        lines = para.split('\n')
        loc = _LOCATION.match(lines[0]) if len(lines) > 1 else None
        body = lines[1:] if loc else lines
        if not body or not all(l.startswith('>') for l in body):
            break
        quoted = '\n'.join(l[2:] if l.startswith('> ') else l[1:] for l in body)
        item = {'text': quoted.strip('\n'), 'from': 'file' if loc else 'reply'}
        if loc:
            item['file'] = loc.group('file')
            item['line'] = int(loc.group('line'))
            if loc.group('end'):
                item['end'] = int(loc.group('end'))
        out.append(item)
    return out


def exact_ref(d, sid, agent):
    # Do not use resolve(), which deliberately accepts task IDs and ID prefixes.
    matches = [(path, e) for path, e in d.load_index().items()
               if e.get('session_id') == sid and e.get('agent') == agent and not e.get('subagent')]
    if not matches:
        # Same id on another Mac (a moved/forked conversation): say where instead of "not found".
        elsewhere = []
        try:
            elsewhere = sorted({r.get('host_name') or r.get('host') for r in (d.remote_refs() if callable(getattr(d, 'remote_refs', None)) else [])
                                if r.get('session_id') == sid and r.get('agent') == agent})
        except Exception:
            pass
        if elsewhere:
            hosts = [h for h in (d.hosts() if callable(getattr(d, 'hosts', None)) else []) if h.get('name') in elsewhere]
            how = '；'.join(f"dispatch --host {h['id']} …" for h in hosts)
            raise Rejected(_t(f"This Mac does not have that conversation; it is on {', '.join(elsewhere)}" + (f" (do it there: {how})" if how else '') + '.',
                              f"这台电脑上没有这个会话，它在 {'、'.join(elsewhere)} 上" + (f"（在那台上操作：{how}）" if how else '') + '。'))
        raise Rejected(_t('This Mac cannot find that conversation. Refresh and pick it again.', '这台电脑找不到这个会话，请刷新后重新选择。'))
    path, entry = max(matches, key=lambda pair: pair[1].get('mtime', 0))
    return dict(entry, path=path)



def connect(d):
    os.makedirs(d.DISPATCH_DIR, exist_ok=True)
    path = os.path.join(d.DISPATCH_DIR, 'reply-receipts.sqlite')
    db = sqlite3.connect(path, timeout=10)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, sid TEXT, agent TEXT, digest TEXT, text TEXT, state TEXT, note TEXT, created REAL)')
    return db

def key_of(ref):
    return f"{ref['agent']}:{ref['session_id']}"


def chat_state(c, ref):
    """chatd's `state` row for this conversation, or None when it does not hold it."""
    return next((r for r in c.request('list')['sessions'] if r['session'] == key_of(ref)), None)


def client(d):
    try:
        return chat_client.ChatClient.connect(d.DISPATCH_DIR)
    except chat_client.NotRunning as e:
        raise Rejected(str(e))


def check_agent(ref):
    import engines
    runnable = engines.runnable()  # the engines with a chat driver: chatd can type into their sessions
    if ref['agent'] not in [e.agent for e in runnable]:
        raise Rejected(_t(f'Only {engines.join_words([e.name for e in runnable], "and")} conversations can be answered from here.', f'只有 {engines.join_words([e.name for e in runnable], "和")} 的会话能从这里回复。'))


def receipts(d, ref):
    with closing(connect(d)) as db, db:
        rows = db.execute('SELECT id,text,state,note,created FROM replies WHERE sid=? AND agent=? ORDER BY created DESC LIMIT 10',
                          (ref['session_id'], ref['agent'])).fetchall()
    return [dict(r, delivered=r['state'] == 'accepted') for r in rows]


def terminal_holds(d, ref):
    """A terminal still writes this transcript and the engine has no lock (Claude Code: chatd would refuse to open
    it). Codex terminals share the app-server thread with Dispatch, so they never block."""
    import engines
    if not engines.get(ref['agent']).chat_single_writer:
        return False
    import session_control
    held = session_control.chat_held_pids(d)
    return any(s.get('session_id') == ref['session_id'] and s.get('agent') == ref['agent'] and s.get('agent_pid') not in held
               for s in d.live_sessions(local_only=True))


def status(d, ref):
    """`where`: 'terminal' when a terminal process holds it, 'desktop' when chatd does, '' otherwise."""
    info = dict(available=False, label='', working=False, where='', receipts=receipts(d, ref))
    try:
        check_agent(ref)
        with client(d) as c:
            st = chat_state(c, ref)
    except Rejected as e:
        return dict(info, label=str(e))
    if st is None and terminal_holds(d, ref):
        return dict(info, where='terminal', label=_t('This conversation is still open in a terminal: quit it there, or take it over in Dispatch on the Mac.', '这段会话还开在终端里：在终端里退出它，或在电脑上的 Dispatch 里点「接管到 Dispatch」。'))
    if st is not None:
        info['where'] = 'desktop'
    life = (st or {}).get('lifecycle')
    if life in ('waiting_permission', 'waiting_input'):
        return dict(info, blocked=True, label=_t('The conversation waits at a question for your OK: allow or deny it in Dispatch on the Mac.', '原会话停在一个确认框：到电脑上的 Dispatch 里点允许或拒绝。'))
    working = life in ('running', 'starting')
    return dict(info, available=True, working=working,
                label=_t('The agent is working: queue it (it sees it when this turn ends) or interrupt', 'Agent 正在执行：可以排队（本轮结束就看到）或打断') if working else _t('Reply to Dispatch on the Mac', '回复到电脑上的 Dispatch'))


def submit(d, ref, text, request_id, mode='queue', images=()):
    check_agent(ref)
    images = [p for p in (images or []) if isinstance(p, str) and p.strip()]
    text = text if text.strip() else (_t('Look at these pictures', '看一下这几张图') if images else text)
    if not text.strip() or len(text) > 16000:
        raise Rejected(_t('Type a reply of at most 16000 characters.', '请输入回复，最多 16000 字。'))
    if any(not os.path.isfile(p) for p in images):
        raise Rejected(_t('A picture did not come through. Add it again.', '有图片没传上来，请重新添加。'))
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError):
        raise Rejected(_t('That message number is not valid. Refresh the page.', '无效的消息编号，请刷新页面。'))
    digest = hashlib.sha256((ref['agent'] + '\0' + ref['session_id'] + '\0' + text + '\0' + '\n'.join(images)).encode()).hexdigest()
    with closing(connect(d)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        old = db.execute('SELECT * FROM replies WHERE id=?', (request_id,)).fetchone()
        if old:
            if old['digest'] != digest:
                raise Rejected(_t('That message number belongs to another message. Refresh and try again.', '消息编号已用于另一条内容，请刷新后重试。'))
            return dict(old)
        db.execute('INSERT INTO replies VALUES (?,?,?,?,?,?,?,?)', (request_id, ref['session_id'], ref['agent'], digest, text, 'sending', _t('Sending', '正在发送'), time.time()))
    state, note = 'accepted', ''
    try:
        with client(d) as c:
            if chat_state(c, ref) is None:
                c.request('open', agent=ref['agent'], cwd=ref.get('cwd') or d.HOME, resume=ref['session_id'], timeout=120)
            r = c.request('send', session=key_of(ref), message_id=request_id, text=text, images=[{'path': p} for p in images],
                          mode='interrupt' if mode == 'interrupt' else 'queue', timeout=120)
        if r.get('ev') == 'queued':
            note = _t('Queued: the agent sees it when this turn ends', '已排队，本轮结束后 Agent 就会看到')
    except chat_client.ChatError as e:
        state, note = 'failed', (_t('This conversation is still open in a terminal, so the phone cannot write to it. Quit it there, then go on in Dispatch and on the phone.',
                                    '这段会话还开在终端里，手机发不进去；在终端里退出它，之后就能在 Dispatch 和手机上接着聊。')
                                 if e.code == 'writer_conflict' else _t(f'Not sent: {e}', f'没发出去：{e}'))
    except Rejected as e:
        state, note = 'failed', str(e)
    with closing(connect(d)) as db, db:
        db.execute('UPDATE replies SET state=?,note=? WHERE id=?', (state, note, request_id))
        return dict(db.execute('SELECT * FROM replies WHERE id=?', (request_id,)).fetchone())


def control(d, ref, payload):
    """Interrupt the running turn, or take back a message still waiting in chatd's queue."""
    check_agent(ref)
    with client(d) as c:
        try:
            if payload.get('interrupt'):
                c.request('interrupt', session=key_of(ref), timeout=30)
                return dict(state='accepted', note=_t('Interrupted', '已打断'))
            if payload.get('withdraw'):
                c.request('withdraw', session=key_of(ref), message_id=payload['withdraw'], timeout=30)
            else:
                raise Rejected(_t('Answer questions and change the mode or model in Dispatch on the Mac.', '确认框、模式和模型到电脑上的 Dispatch 里操作。'))
        except chat_client.ChatError as e:
            raise Rejected(_t(f'That did not work: {e}', f'没做成：{e}'))
    with closing(connect(d)) as db, db:
        row = db.execute('SELECT text FROM replies WHERE id=?', (payload['withdraw'],)).fetchone()
        db.execute("UPDATE replies SET state='failed', note=? WHERE id=?", (_t('Withdrawn', '已撤回'), payload['withdraw']))
    return dict(state='accepted', note=_t('Withdrawn', '已撤回'), text=row['text'] if row else '')


def _markdown_commands(folder, kind, description=''):
    """`<folder>/<name>.md` → /name (Claude Code custom commands, pi prompt templates)."""
    rows = []
    if not os.path.isdir(folder):
        return rows
    for fn in sorted(os.listdir(folder)):
        if not fn.endswith('.md') or fn.startswith('.'):
            continue
        desc = description
        try:
            with open(os.path.join(folder, fn), encoding='utf-8') as f:
                head = f.read(2000)
            m = re.search(r'^description:\s*(.+)$', head, re.M) if head.startswith('---') else None
            if m:
                desc = m.group(1).strip().strip('"').strip("'")
            elif not desc:
                desc = next((l.strip('# ').strip() for l in head.splitlines() if l.strip()), '')
        except OSError:
            pass
        rows.append(dict(name=fn[:-3], description=desc, kind=kind))
    return rows


def _skill_commands(d, dirs, prefix=''):
    rows = []
    for folder in dirs:
        if not os.path.isdir(folder):
            continue
        for n in sorted(os.listdir(folder)):
            p = os.path.join(folder, n)
            if os.path.isdir(p) and not n.startswith('.') and os.path.exists(os.path.join(p, 'SKILL.md')):
                rows.append(dict(name=prefix + n, description=d.read_frontmatter(p).get('description', ''), kind='skill'))
    return rows


def commands(d, ref):
    """Slash commands this session accepts: built-ins, then skills and custom commands
    visible to the agent from its working directory. Dedup by name, first wins."""
    agent, cwd = ref['agent'], ref.get('cwd') or ''
    import engines
    rows = [dict(name=n, description=desc, kind='builtin') for n, desc in engines.get(agent).builtin_commands]
    eng = engines.get(agent)
    if eng.slash_skills:  # its skills and its own command files are slash commands too
        own = eng.slash_folder.format(home=cwd)
        rows += _skill_commands(d, [os.path.join(own, 'skills')] + d.AGENT_SKILL_DIRS[eng.id])
        rows += _markdown_commands(os.path.join(own, 'commands'), 'command')
        rows += _markdown_commands(os.path.join(eng.slash_folder.format(home=d.HOME), 'commands'), 'command')
    seen, out = set(), []
    for r in rows:
        if r['name'] in seen:
            continue
        seen.add(r['name'])
        out.append(r)
    return out


def command(d, a):
    import sys
    try:
        ref = exact_ref(d, a.key, a.agent)
        if a.op == 'status':
            result = status(d, ref)
        elif a.op == 'commands':
            result = commands(d, ref)
        elif a.op == 'control':
            result = control(d, ref, json.loads(sys.stdin.read() or '{}'))
        else:
            text = compose_quoted(sys.stdin.read(16001), getattr(a, 'quote', None) or [])
            result = submit(d, ref, text, a.request, mode=getattr(a, 'mode', 'queue') or 'queue', images=getattr(a, 'image', None) or [])
    except Rejected as e:
        result = dict(state='failed', note=str(e), available=False, label=str(e), receipts=[])
    d.out(result, a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))
