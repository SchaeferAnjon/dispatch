"""Session launch jobs: exact identity, local folders and retry-safe creation.

Transport routing stays in dispatch --host. Workers use the same installed CLI
directory as their caller; only the selected computer touches its filesystem.
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from urllib.parse import quote

from session_reply import Rejected, exact_ref, herdr_target

KINDS = {'claude-code': 'claude', 'codex': 'codex', 'pi': 'pi'}


def directory(d, path):
    if not isinstance(path, str) or '\0' in path:
        raise Rejected('请选择有效的文件夹。')
    path = d.HOME + path[1:] if path == '~' or path.startswith('~/') else path
    if not os.path.isabs(path):
        raise Rejected('请输入完整的文件夹路径，或从列表选择。')
    path = os.path.realpath(path)
    if not os.path.isdir(path):
        raise Rejected('这个文件夹不存在，请重新选择。')
    return path


def browse(d, path):
    path = directory(d, path or d.HOME)
    try:
        with os.scandir(path) as it:
            children = sorted([{'name': x.name, 'path': x.path} for x in it
                               if not x.name.startswith('.') and x.is_dir()], key=lambda x: x['name'].casefold())
    except OSError:
        raise Rejected('无法读取这个文件夹，请检查电脑上的文件访问权限。')
    recent = sorted(d.load_index().values(), key=lambda x: x.get('mtime', 0), reverse=True)
    paths = list(dict.fromkeys(x.get('cwd') for x in recent if x.get('cwd') and os.path.isdir(x['cwd'])))[:12]
    return dict(path=path, parent=os.path.dirname(path), children=children[:300], truncated=len(children)>300, recent=paths)


def checked(d, args, timeout=30):
    r = d.herdr(None, args, timeout=timeout)
    if not isinstance(r, dict) or r.get('error'):
        raise Rejected((r.get('error') or {}).get('message', '无法连接电脑终端。') if isinstance(r, dict) else '无法连接电脑终端。')
    return r.get('result') or {}


def open_original(d, data):
    sid, agent = data.get('session_id', ''), data.get('agent', '')
    ref = exact_ref(d, sid, agent)
    if agent == 'codex':
        code, _, _ = d.sh(['open', 'codex://threads/' + quote(sid, safe='')], timeout=10)
        if code:
            raise Rejected('这台电脑未安装可打开会话的 Codex 桌面端。')
        return dict(message='已在 Codex 中打开原会话')
    if agent == 'claude-code' and ref.get('entrypoint') == 'desktop':
        code, _, _ = d.sh(['open', 'claude://code/continue?session=' + quote(sid, safe='')], timeout=10)
        if code:
            raise Rejected('这台电脑无法打开 Claude 桌面端。')
        return dict(message='已在 Claude 桌面端打开原会话')
    if agent in KINDS:
        try:
            pane = herdr_target(d, ref, require_idle=False)
        except Rejected:
            # Restoring a historical session is explicit. Never focus another
            # conversation merely because it uses the same working directory.
            if any(s.get('session_id') == sid for s in d.live_sessions(local_only=True)):
                raise Rejected('原会话仍在运行，但无法定位窗口。请在电脑上打开原 Agent。')
            with closing(connect(d)) as db:
                for row in db.execute('SELECT payload,result FROM launches'):
                    old = json.loads(row['result'])
                    if json.loads(row['payload']).get('resume') == sid and old['state'] in ('starting', 'running') and time.time()-old['created'] < 240:
                        return old
            return enqueue(d, dict(request_id=data.get('request_id') or str(uuid.uuid4()),
                                   agent=agent, cwd=directory(d, ref['cwd']), prompt='', resume=sid, title=ref.get('title') or ''))
        checked(d, ['agent', 'focus', pane['pane_id']])
        table = d.ps_table()
        host = next((d.host_app_of(pid, table) for pid, (_, comm) in table.items() if os.path.basename(comm) == 'herdr'), None)
        d.activate(host or 'Ghostty')
        return dict(message='已在终端中打开原会话')
    raise Rejected('这个 Agent 暂不支持精确打开原会话，可在 Dispatch 查看记录。')


def connect(d):
    os.makedirs(d.DISPATCH_DIR, exist_ok=True)
    path = os.path.join(d.DISPATCH_DIR, 'session-launches.sqlite')
    db = sqlite3.connect(path, timeout=10)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, digest TEXT, payload TEXT, result TEXT)')
    return db


def save(d, rid, **fields):
    with closing(connect(d)) as db, db:
        row = db.execute('SELECT result FROM launches WHERE id=?', (rid,)).fetchone()
        r = json.loads(row['result']); r.update(fields)
        db.execute('UPDATE launches SET result=? WHERE id=?', (json.dumps(r), rid))
    return r


def status(d, rid):
    with closing(connect(d)) as db:
        row = db.execute('SELECT result FROM launches WHERE id=?', (rid,)).fetchone()
    if not row:
        raise Rejected('找不到这次创建记录。')
    r = json.loads(row['result'])
    if r['state'] in ('starting', 'running') and time.time()-r['created'] > 240:
        r.update(state='attention', message='启动尚未确认，请查看电脑终端。不会重复创建。')
    return r


def enqueue(d, data):
    rid = data.get('request_id', '')
    try:
        uuid.UUID(rid)
    except (ValueError, TypeError):
        raise Rejected('无效的创建编号，请重新打开新建会话。')
    if data.get('agent') not in KINDS:
        raise Rejected('请选择 Claude Code、Codex 或 pi。')
    cwd = directory(d, data.get('cwd', ''))
    prompt = data.get('prompt', '')
    if not isinstance(prompt, str) or len(prompt) > 16000 or (not data.get('resume') and not prompt.strip()):
        raise Rejected('请输入第一条消息，最多 16000 字。')
    payload = dict(agent=data['agent'], cwd=cwd, prompt=prompt.strip(), resume=data.get('resume'))
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    with closing(connect(d)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        old = db.execute('SELECT digest,result FROM launches WHERE id=?', (rid,)).fetchone()
        if old:
            if old['digest'] != digest:
                raise Rejected('这个创建编号已使用，请重新打开新建会话。')
            return json.loads(old['result'])
        checked(d, ['agent', 'list'])
        result = dict(request_id=rid, state='starting', created=time.time(), agent=data['agent'], cwd=cwd, message='正在启动电脑上的 Agent…')
        db.execute('INSERT INTO launches VALUES (?,?,?,?)', (rid, digest, json.dumps(payload), json.dumps(result)))
    try:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), '--worker', rid], cwd=d.HOME,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return save(d, rid, state='failed', message='无法启动会话进程。请重新打开新建会话。')
    return result


def worker(d, rid):
    with closing(connect(d)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT payload,result FROM launches WHERE id=?', (rid,)).fetchone()
        result = json.loads(row['result'])
        if result['state'] != 'starting':
            return
        result['state'] = 'running'
        db.execute('UPDATE launches SET result=? WHERE id=?', (json.dumps(result), rid))
    p = json.loads(row['payload']); agent = p['agent']; start = time.time()
    try:
        before = {r.get('session_id') for r in d.load_index().values()}
        # The tab is named after the conversation, so a restored session reads as itself in Herdr.
        label = (p.get('title') or '')[:32] or p['prompt'][:24] or '恢复会话'
        tab = checked(d, ['tab', 'create', '--cwd', directory(d, p['cwd']), '--focus', '--label', label])
        pane = tab.get('root_pane', tab); pid = pane['pane_id']; tid = pane.get('tab_id')
        save(d, rid, pane_id=pid, tab_id=tid, message='已打开终端，正在连接 Agent…')
        sid = p['resume'] or (str(uuid.uuid4()) if agent == 'claude-code' else None)
        if sid:
            save(d, rid, expected_session_id=sid)
        extra = (['--session', p['resume']] if agent == 'pi' else ['--resume', p['resume']]) if p['resume'] else (['--session-id', sid] if sid else [])
        if p['prompt']:
            extra += ['--', p['prompt']]
        args = ['agent', 'start', 'dispatch-'+hashlib.sha256(rid.encode()).hexdigest()[:10], '--kind', KINDS[agent], '--pane', pid, '--timeout', '60000', '--', *extra]
        for attempt in range(6):
            try:
                checked(d, args, timeout=75)
                break
            except Rejected as e:
                if 'shell' not in str(e).lower() and 'busy' not in str(e).lower() or attempt == 5:
                    raise
                time.sleep(1)
        # A launch is finished only when its actual transcript is visible.
        # Claude has an assigned UUID; other agents require an unambiguous new
        # transcript with the exact first message, never a cwd-only match.
        for _ in range(30):
            idx = d.refresh_index()
            candidates = []
            for path, r in idx.items():
                if r.get('agent') != agent or r.get('subagent'):
                    continue
                if sid and r.get('session_id') == sid:
                    candidates.append(r)
                elif not sid and r.get('session_id') not in before and r.get('cwd') == p['cwd'] and r.get('mtime', 0) >= start:
                    messages = d.read_session_detail(d.ref_of(path, r))['messages']
                    if any(m['role'] == 'user' and m['text'].strip() == p['prompt'] for m in messages):
                        candidates.append(r)
            ids = {r['session_id'] for r in candidates}
            if len(ids) == 1:
                sid = ids.pop()
                # CLI agents without Dispatch hooks still get an exact PID
                # association for phone replies. Never replace an existing hook.
                record = os.path.join(d.SESS_DIR, agent+'__'+sid+'.json')
                if not os.path.exists(record):
                    processes = checked(d, ['pane', 'process-info', '--pane', pid]).get('process_info', {}).get('foreground_processes', [])
                    processes = [process for process in processes if process.get('name') in (KINDS[agent], agent)]
                    if len(processes) == 1:
                        os.makedirs(d.SESS_DIR, exist_ok=True)
                        try:
                            with open(record, 'x') as f:
                                json.dump(dict(agent=agent, session_id=sid, agent_pid=processes[0]['pid'], cwd=p['cwd'], source_kind='terminal', source_app='Herdr', state='unknown', last_at=time.time()), f)
                        except FileExistsError:
                            pass
                save(d, rid, state='ready', session_id=sid, message='会话已创建，可以查看和回复' if not p['resume'] else '已恢复原会话')
                return
            pane_info = checked(d, ['agent', 'get', pid]).get('agent', {})
            if pane_info.get('agent_status') == 'blocked':
                save(d, rid, state='attention', message='Agent 已启动，正在电脑上等待确认。处理登录或权限提示后，会话会出现在工作台。')
                return
            time.sleep(2)
        save(d, rid, state='attention', message='终端已启动，尚未读到会话记录。请检查电脑上的登录或权限提示。')
    except Exception as e:
        save(d, rid, state='attention', message='启动尚未完成：'+str(e)[:240]+'。请查看电脑终端，不会自动重复创建。')


def command(d, a):
    try:
        data = json.loads(sys.stdin.read() or '{}')
        if a.op == 'browse': r = browse(d, data.get('path'))
        elif a.op == 'open': r = open_original(d, data)
        elif a.op == 'start':
            if data.get('resume'): raise Rejected('恢复会话请使用打开原会话。')
            r = enqueue(d, data)
        else: r = status(d, data.get('request_id'))
        print(json.dumps(r, ensure_ascii=False))
    except (Rejected, ValueError) as e:
        raise SystemExit(str(e))


if __name__ == '__main__':
    import dispatch
    worker(dispatch, sys.argv[2])
