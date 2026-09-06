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
import re
import sqlite3
import time


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


def user_text(text):
    # Desktop envelopes are not user messages and must not clear unread replies.
    for tag in ('recommended_plugins', 'in-app-browser-context', 'environment_context', 'system-reminder'):
        text = re.sub(r'<' + tag + r'\b[^>]*>[\s\S]*?</' + tag + r'>', '', text)
    text = text.strip()
    if text.startswith(('# AGENTS.md instructions', '<local-command', '<command-name>', '<bash-input>')): return ''
    return text.removeprefix('## My request:').strip()


@lru_cache(maxsize=1)
def codex_titles(home):
    titles = {}
    try:
        with open(os.path.join(home, '.codex/session_index.jsonl')) as f:
            for line in f:
                try:
                    row = json.loads(line)
                    if row.get('thread_name'): titles[row['id']] = row['thread_name']
                except (ValueError, KeyError): continue
    except OSError: pass
    return titles


def operation_summary(name, inp, raw):
    label = inp.get('title') or inp.get('description')
    if label: return str(label)[:180]
    command = inp.get('cmd') or inp.get('command')
    if command: return '运行命令 · ' + str(command).split('\n')[0][:150]
    path = inp.get('file_path') or inp.get('path')
    if path: return str(path)
    if inp.get('query'): return '搜索 · ' + str(inp['query'])[:150]
    if name.split('.')[-1] == 'apply_patch': return '修改文件 · ' + ', '.join(patch_files(str(raw)))[:160]
    if name.split('.')[-1] == 'exec':
        for key in ('title', 'cmd'):
            match = re.search(r'(?:"' + key + r'"|\b' + key + r')\s*:\s*("(?:\\.|[^"\\])*")', str(raw))
            if match:
                try: return ('运行命令 · ' if key == 'cmd' else '') + json.loads(match[1]).split('\n')[0][:160]
                except ValueError: pass
        if 'write_stdin' in str(raw): return '读取命令执行结果'
        if 'view_image' in str(raw): return '检查截图'
        return '正在调用工具'
    return name


def observe(state, d):
    t = d.get('type')
    p = d.get('payload') or d.get('message') or {}
    ts = epoch(d.get('timestamp'))
    role = ''; text = ''; tools = []; results = []; finished = False
    if t == 'session_meta':
        state['session_id'] = p.get('id') or p.get('session_id') or state.get('session_id')
        state['cwd'] = p.get('cwd', state.get('cwd', ''))
    if t == 'ai-title':
        state['title'] = d.get('aiTitle') or state.get('title', '')
    if t == 'turn_context':
        state['cwd'] = p.get('cwd', state.get('cwd', ''))
    if t == 'event_msg':
        if p.get('type') == 'task_started':
            state['state'] = 'working'; state['activity'] = '正在处理'; state['last_at'] = ts
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
    elif t in ('user', 'assistant') and not d.get('isSidechain'):
        role, text = t, text_of(p.get('content'))
        state['cwd'] = d.get('cwd') or state.get('cwd', '')
        for b in p.get('content') or []:
            if not isinstance(b, dict): continue
            if b.get('type') == 'tool_use': tools.append((b.get('id', ''), b.get('name', ''), b.get('input', {})))
            elif b.get('type') == 'tool_result': results.append((b.get('tool_use_id', ''), {'error': b.get('is_error', False)}))
        # Claude's assistant text without a tool call completes a response; hooks can override busy state.
        finished = role == 'assistant' and bool(text.strip()) and not tools
    if role == 'user': text = user_text(text)
    if not ts: return
    events = state.setdefault('events', [])
    def event(kind, summary, **extra):
        eid = hashlib.sha256((str(ts)+kind+summary).encode()).hexdigest()[:20]
        if not any(e['id'] == eid for e in events):
            events.append(dict(id=eid, ts=ts, kind=kind, text=summary[:400], **extra))
        state['last_at'] = max(ts, state.get('last_at', 0))
    if role == 'user' and text.strip() and not text.lstrip().startswith(('<environment_context>', '<system-reminder>', '<local-command', '<command-name>')):
        state['user_at'] = ts
        state['state'], state['activity'] = 'working', '正在处理你的消息'
        if not state.get('title'): state['title'] = text.strip().split('\n')[0][:100]
        event('user', text)
    elif role == 'assistant' and text.strip():
        event('reply' if finished else 'message', text)
        digest = hashlib.sha256(text.encode()).hexdigest()[:20]
        # task_complete may repeat the same final message; don't create another unread reply.
        if finished and (digest != state.get('reply_digest') or state.get('user_at', 0) > state.get('reply_at', 0)):
            state.update(reply_id=f'{ts}:{digest}', reply_at=ts, reply_digest=digest, reply_preview=text[:280])
        state['activity'] = '已回复' if finished else '正在回复'
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
    for call_id, output in results:
        op = pending.pop(call_id, None)
        if op:
            failed = isinstance(output, dict) and bool(output.get('error'))
            if isinstance(output, str):
                failed = '"isError":true' in output.replace(' ', '') or 'exit code 1' in output
            event('error' if failed else 'result', ('失败 · ' if failed else '已返回 · ') + op['name'], paths=op['paths'])
            if not failed:
                for path in op['paths']:
                    state.setdefault('files', {})[path] = ts
            state['activity'] = '工具执行失败' if failed else f'已执行 · {op.get("summary", op["name"])}'
            state['state'] = 'working'
    if finished:
        state['state'] = 'idle'
        state['activity'] = '已回复' if text else '本轮已结束'
    state['events'] = events[-80:]
    if len(pending) > 100: state['pending'] = dict(list(pending.items())[-100:])


def connect(directory):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, 'activity.sqlite')
    db = sqlite3.connect(path, timeout=15)
    os.chmod(path, 0o600)
    db.execute('CREATE TABLE IF NOT EXISTS streams (path TEXT PRIMARY KEY, inode INTEGER, off INTEGER, mtime REAL, data TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS read_replies (key TEXT, reply_id TEXT, PRIMARY KEY(key, reply_id))')
    db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL)')
    db.execute('INSERT OR IGNORE INTO settings VALUES (?, ?)', ('started_at', time.time()))
    db.commit()
    return db


def read_stream(db, path, agent):
    st = os.stat(path)
    row = db.execute('SELECT inode,off,mtime,data FROM streams WHERE path=?', (path,)).fetchone()
    state = json.loads(row[3]) if row and row[0] == st.st_ino and row[1] <= st.st_size else {}
    if state.get('parser_version') != 3: state = {}
    off = row[1] if state else 0
    state['parser_version'] = 3
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
    return state


def acknowledge(directory, key, reply_id):
    float(reply_id.split(':', 1)[0])  # validate the cursor format
    with closing(connect(directory)) as db, db:
        db.execute('INSERT OR IGNORE INTO read_replies VALUES (?,?)', (key, reply_id))
    return {'ok': True}


def activity_list(home, directory, index):
    paths = []
    for folder, agent in (('.claude/projects', 'claude-code'), ('.codex/sessions', 'codex')):
        for path in glob.glob(os.path.join(home, folder, '**', '*.jsonl'), recursive=True):
            if '/subagents/' in path: continue
            try: paths.append((os.stat(path).st_mtime, path, agent))
            except OSError: pass
    paths.sort(reverse=True)
    rows = []
    titles = codex_titles(home)
    with closing(connect(directory)) as db, db:
        started_at = db.execute('SELECT value FROM settings WHERE key=?', ('started_at',)).fetchone()[0]
        for _, path, agent in paths[:120]:
            try: s = dict(read_stream(db, path, agent))
            except OSError: continue
            if not s.get('last_at'): continue
            e = index.get(path, {})
            s['title'] = (titles.get(s['session_id']) if agent == 'codex' else None) or user_text(e.get('title') or '') or user_text(s.get('title') or '') or os.path.basename(s.get('cwd', '')) or '未命名会话'
            s['tasks'] = list(e.get('tasks', {}))
            s['path'] = path
            s['project'] = os.path.basename(s.get('cwd', ''))
            s['key'] = s['agent'] + ':' + s['session_id']
            receipt = db.execute('SELECT reply_id FROM read_replies WHERE key=? AND reply_id=?', (s['key'], s.get('reply_id'))).fetchone()
            s['unread'] = bool(s.get('reply_at', 0) > max(started_at, s.get('user_at', 0)) and (not receipt or receipt[0] != s.get('reply_id')))
            s['tracking_since'] = started_at
            s['stale'] = s.get('state') == 'working' and time.time() - s['last_at'] > 180
            s['source'] = 'transcript'
            s.pop('pending', None); s.pop('reply_digest', None)
            rows.append(s)
    # A resumed Codex task can have more than one rollout file with the same id.
    # Keep its newest observation; duplicate React keys otherwise accumulate rows.
    unique = {}
    for row in sorted(rows, key=lambda s: -s['last_at']): unique.setdefault(row['key'], row)
    return list(unique.values())


def workspace_changes(cwd):
    """Current Git workspace diff, explicitly not attributed to one conversation."""
    import subprocess
    def git(*args):
        r = subprocess.run(['git', '-C', cwd, *args], capture_output=True, timeout=5)
        if r.returncode: raise ValueError('不是 Git 工作区或暂时无法读取')
        return r.stdout.decode('utf-8', 'replace')
    try:
        root = git('rev-parse', '--show-toplevel').strip()
        cwd = root
        # Include staged and unstaged changes, paths from NUL-delimited Git output.
        paths = git('diff', 'HEAD', '--name-only', '-z').split('\0')
        untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
        files = []
        for path in list(dict.fromkeys(paths + untracked)):
            if not path: continue
            files.append({'path': path, 'untracked': path in untracked})
        patch = git('diff', '--no-ext-diff', '--no-color', 'HEAD', '--')
        return {'root': root, 'files': files, 'patch': patch[:100000], 'truncated': len(patch) > 100000}
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return {'root': cwd, 'files': [], 'patch': '', 'unavailable': str(e)}
