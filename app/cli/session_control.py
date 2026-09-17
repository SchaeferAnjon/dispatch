# -*- coding: utf-8 -*-
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
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
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
    # Temp and scratch directories are where agents work, not where you start a conversation.
    noise = ('/private/tmp', '/tmp', '/var/folders', os.path.join(d.HOME, 'Documents/Codex'))
    skip = lambda p: p.startswith(noise) or '/scratchpad' in p or '/.cache/' in p
    paths = list(dict.fromkeys(x.get('cwd') for x in recent if x.get('cwd') and os.path.isdir(x['cwd']) and not skip(x['cwd'])))[:12]
    return dict(path=path, parent=os.path.dirname(path), children=children[:300], truncated=len(children)>300, recent=paths)


def checked(d, args, timeout=30):
    r = d.herdr(None, args, timeout=timeout)
    if not isinstance(r, dict) or r.get('error'):
        raise Rejected((r.get('error') or {}).get('message', '无法连接电脑终端。') if isinstance(r, dict) else '无法连接电脑终端。')
    return r.get('result') or {}


def focus_herdr(d, pane):
    title = (pane.get('terminal_title_stripped') or '').strip()
    tab = (pane.get('tab_id') or pane['pane_id']) + (f"「{title}」" if title else '')
    app, how = d.show_herdr_pane(pane['pane_id'])
    if how == 'none':
        raise Rejected(f"会话在 Herdr 页签 {tab} 里，但这台电脑上没有窗口显示它。{d.herdr_attach_hint(d.herdr_session_name())}")
    return dict(message=(f"已开 {app} 窗口接上 Herdr，切到页签 {tab}" if how == 'attached' else f"已在 {app} 里切到 Herdr 页签 {tab}"), pane_id=pane['pane_id'], tab_id=pane.get('tab_id'))


def open_original(d, data):
    sid, agent = data.get('session_id', ''), data.get('agent', '')
    ref = exact_ref(d, sid, agent)
    if agent in KINDS:
        try:
            pane = herdr_target(d, ref, require_idle=False, allow_blocked=True)
        except Rejected:
            pane = None
        if pane:
            return focus_herdr(d, pane)
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
        return resume_in_herdr(d, ref, data.get('request_id'), focus_running=True)
    raise Rejected('这个 Agent 暂不支持精确打开原会话，可在 Dispatch 查看记录。')


def resume_in_herdr(d, ref, request_id=None, focus_running=False):
    """Bring a conversation that is not running anywhere on this Mac back as a Herdr tab
    (`claude --resume` / `codex resume` / pi), so the phone can address it. Restoring a
    historical session is explicit: never touch another conversation merely because it uses the
    same working directory. Running already: the desktop button focuses it (`focus_running`), the
    phone gets told where it is instead of a second copy. One resume in flight per session."""
    sid, agent = ref['session_id'], ref['agent']
    live = next((s for s in d.live_sessions(local_only=True) if s.get('session_id') == sid and s.get('agent', agent) == agent), None)
    if live:
        # Running here but not in a Herdr pane we can address: bring its own window forward
        # rather than claiming it cannot be found; name the place when even that fails.
        where = getattr(d, 'local_host_name', lambda: '这台电脑')()
        focus = getattr(d, 'focus_session', None)
        msg = None
        if focus_running:
            try:
                msg = focus(live) if callable(focus) else None
            except Exception:
                msg = None
        if msg:
            return dict(message=msg)
        h = live.get('herdr') or {}
        place = (f"Herdr 页签 {h.get('tab_id')}（{h.get('pane_id')}）" if h else f"{live.get('source_app') or '终端'}（进程 {live.get('agent_pid')}）")
        raise Rejected(f'会话正在 {where} 的 {place} 里运行，Dispatch 没能切过去；请在 {where} 上切到它，或用「电脑」页的屏幕共享打开。')
    with closing(connect(d)) as db:
        for row in db.execute('SELECT payload,result FROM launches'):
            old = json.loads(row['result'])
            if json.loads(row['payload']).get('resume') == sid and old['state'] in ('starting', 'running') and time.time()-old['created'] < 240:
                return old
    return enqueue(d, dict(request_id=request_id or str(uuid.uuid4()),
                           agent=agent, cwd=directory(d, ref['cwd']), prompt='', resume=sid, title=ref.get('title') or ''))


def adopt(d, data):
    """Take a session running in some other terminal (Warp, iTerm, Terminal, VS Code…) into
    Herdr: stop the old process when it is idle, then resume the same transcript in a new
    Herdr tab. Works for sessions the hooks registered and, best-effort, for bare `pid-…`
    processes whose transcript we can guess from their working directory."""
    key = data.get('session_id', '')
    live = d.live_sessions(local_only=True)
    s = next((x for x in live if x.get('session_id') == key or (key and x.get('session_id', '').startswith(key))), None)
    if not s:
        raise Rejected('这个会话现在没在本机运行；已结束的会话用「打开原会话」恢复即可。')
    agent = s.get('agent')
    if agent not in KINDS:
        raise Rejected(f'{agent} 不能用命令行恢复，接不进 Herdr。')
    sid = s['session_id'] if not s['session_id'].startswith('pid-') else s.get('probable_session_id', '')
    if not sid:
        raise Rejected('没找到这个进程对应的会话记录（它还没写过一条消息，或者目录对不上）；等它说过话再试。')
    try:
        pane = herdr_target(d, dict(session_id=sid, agent=agent), require_idle=False, allow_blocked=True)
    except Rejected:
        if s.get('herdr'):
            raise Rejected('会话的终端连接已变化，请重新连接后再试。')
    else:
        return dict(state='ready', message='已连接 Herdr 中的原会话', session_id=sid, pane_id=pane['pane_id'], tab_id=pane.get('tab_id'))
    if s.get('state') == 'working' and not data.get('force'):
        raise Rejected('它正在跑，现在接管会打断它；等它停下来（状态变成「等你」）再接。')
    d.refresh_index()
    try:
        ref = exact_ref(d, sid, agent)
    except Rejected:
        raise Rejected('它还没有会话记录（一句话都没说过），没什么可接的；直接在 Herdr 里新开一个吧。')
    pid = s.get('agent_pid')
    cwd = s.get('cwd') or ref.get('cwd', '')
    stopped = False
    if pid and not data.get('keep'):
        # Two processes on one transcript interleave their writes; stop the old one first.
        import signal
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise Rejected('那个进程属于别的用户，停不掉；让对方自己退出后再接。')
        for _ in range(40):
            if int(pid) not in d.ps_table():
                stopped = True
                break
            time.sleep(0.25)
        if not stopped:
            raise Rejected('原进程 10 秒内没有退出，没有动它；在那个终端里退出 Agent 后再接一次。')
        # Its hook record is stale now; the resumed process will register itself.
        for path in (os.path.join(d.SESS_DIR, f'{agent}__{sid}.json'), os.path.join(d.SESS_DIR, f'{agent}__pid-{pid}.json')):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
    title = s.get('title') or ref.get('title') or ''
    r = enqueue(d, dict(request_id=data.get('request_id') or str(uuid.uuid4()), agent=agent, cwd=directory(d, cwd), prompt='', resume=sid, title=title))
    r = dict(r, adopted_from=s.get('source_app', ''), stopped_pid=pid if stopped else None, guessed=s['session_id'].startswith('pid-'),
             message=f"已停掉 {s.get('source_app') or '原终端'} 里的进程，正在 Herdr 里恢复同一个会话…" if stopped else f"正在 Herdr 里恢复会话（{s.get('source_app') or '原终端'} 里那个还开着，记得关）…")
    return r


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
    # focus: bring the terminal hosting Herdr to the front once the session is ready (the desktop app asks for it on this Mac).
    payload = dict(agent=data['agent'], cwd=cwd, prompt=prompt.strip(), resume=data.get('resume'), focus=bool(data.get('focus')))
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


def settle_pane(d, pid, timeout=45, quiet=2.0):
    """Wait until the agent in `pid` is idle and its screen has not changed for `quiet` seconds
    (or `timeout` passes — the caller then proceeds; the reply path verifies delivery anyway)."""
    deadline = time.time() + timeout
    last, since = None, time.time()
    while time.time() < deadline:
        try:
            screen = d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True) or ''
            info = d.herdr(None, ['agent', 'get', pid]).get('result', {}).get('agent', {})
        except Exception:
            screen, info = '', {}
        now = time.time()
        if screen != last:
            last, since = screen, now
        elif screen.strip() and info.get('agent_status') in ('idle', 'done') and info.get('interactive_ready', True) and now - since >= quiet:
            return True
        time.sleep(0.7)
    return False


def tab_label(d, p):
    """The Herdr tab is named after the project first, then the conversation, so a restored
    session reads as `kanban · 工作台显示 ZCode 会话` instead of a generic 恢复会话."""
    cwd = p.get('cwd') or ''
    root_name = getattr(d, 'git_root_name', None)
    project = (root_name(cwd) if root_name else '') or os.path.basename(cwd.rstrip('/'))
    title = ((p.get('title') or '').strip() or (p.get('prompt') or '').strip()).split('\n')[0]
    title = ''.join(ch for ch in title if ord(ch) >= 32).strip()
    return (f'{project} · {title}' if project and title else project or title or '恢复会话')[:32]


def unsafe_argument(text):
    """True when Herdr would reject the text as a command-line argument (control characters)."""
    return any(ch in text for ch in '\n\r\t\x00')


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
    if p.get('resume'):
        # Two processes resuming one id write into the same transcript. If it already runs here
        # (another terminal, a hand-typed `claude --resume`), say where instead of starting a copy.
        try:
            live = next((s for s in d.live_sessions(local_only=True) if s.get('session_id') == p['resume'] and s.get('agent', agent) == agent), None)
        except Exception:
            live = None
        if live:
            h = live.get('herdr') or {}
            where = f"Herdr 页签 {h.get('tab_id')}" if h else f"{live.get('source_app') or '终端'}（进程 {live.get('agent_pid')}）"
            save(d, rid, state='attention', message=f'这个会话已经在这台电脑的 {where} 里运行，没有再开一份。')
            return
    try:
        before = {r.get('session_id') for r in d.load_index().values()}
        label = tab_label(d, p)
        tab = checked(d, ['tab', 'create', '--cwd', directory(d, p['cwd']), '--focus', '--label', label])
        pane = tab.get('root_pane', tab); pid = pane['pane_id']; tid = pane.get('tab_id')
        save(d, rid, pane_id=pid, tab_id=tid, message='已打开终端，正在连接 Agent…')
        sid = p['resume'] or (str(uuid.uuid4()) if agent == 'claude-code' else None)
        if sid:
            save(d, rid, expected_session_id=sid)
        # Each CLI resumes differently: Claude `--resume <id>`, pi `--session <id>`, Codex a `resume <id>` subcommand.
        extra = ({'pi': ['--session', p['resume']], 'codex': ['resume', p['resume']]}.get(agent, ['--resume', p['resume']])) if p['resume'] else (['--session-id', sid] if sid else [])
        # Herdr refuses agent arguments it cannot encode for the pane's shell (a newline in a
        # multi-line prompt is the usual case). Such prompts are sent after start instead.
        prompt_later = bool(p['prompt']) and unsafe_argument(p['prompt'])
        if p['prompt'] and not prompt_later:
            extra += ['--', p['prompt']]
        name = 'dispatch-'+hashlib.sha256(rid.encode()).hexdigest()[:10]
        args = ['agent', 'start', name, '--kind', KINDS[agent], '--pane', pid, '--timeout', '60000', '--', *extra]
        for attempt in range(6):
            try:
                checked(d, args, timeout=75)
                break
            except Rejected as e:
                if 'shell' not in str(e).lower() and 'busy' not in str(e).lower() or attempt == 5:
                    raise
                time.sleep(1)
        if prompt_later:
            checked(d, ['agent', 'prompt', name, p['prompt']], timeout=30)
        if p.get('resume'):
            # Herdr reports the TUI interactive as soon as it draws; a resumed conversation then
            # spends seconds (a 16 MB Codex transcript: ~10 s) replaying history, and keys typed
            # meanwhile vanish. 「已恢复」 means the screen has stopped changing with the agent idle.
            settle_pane(d, pid)
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
                    # Claude Code's native binary reports its version as the process name
                    # ('2.1.273'); argv0 / argv[0] still say what was run.
                    names = (KINDS[agent], agent)
                    processes = [process for process in processes if process.get('name') in names or process.get('argv0') in names
                                 or os.path.basename(str((process.get('argv') or [''])[0])) in names]
                    if len(processes) == 1:
                        os.makedirs(d.SESS_DIR, exist_ok=True)
                        try:
                            with open(record, 'x') as f:
                                json.dump(dict(agent=agent, session_id=sid, agent_pid=processes[0]['pid'], cwd=p['cwd'], source_kind='terminal', source_app='Herdr', state='unknown', last_at=time.time()), f)
                        except FileExistsError:
                            pass
                if p['resume']:
                    # A resumed TUI can stop at a dialog before it takes input (Claude Code's
                    # 「trust this folder?」, a login): that is not 「已恢复」. The record above still
                    # ties the pane to the conversation, so the phone can answer the dialog by keys.
                    try:
                        blocked = checked(d, ['agent', 'get', pid]).get('agent', {}).get('agent_status') == 'blocked'
                    except Rejected:
                        blocked = False
                    if blocked:
                        save(d, rid, state='attention', session_id=sid, message='已在电脑上恢复，但它停在一个确认框（信任文件夹 / 权限 / 登录）。手机上可以直接按键回答，或打开电脑屏幕处理。')
                        return
                save(d, rid, state='ready', session_id=sid, message='会话已创建，可以查看和回复' if not p['resume'] else '已恢复原会话')
                if p.get('focus'):
                    try: d.focus_session({'agent': agent, 'session_id': sid, 'herdr': {'pane_id': pid, 'tab_id': tid, 'title': label}})
                    except Exception: pass
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
        elif a.op == 'adopt': r = adopt(d, data)
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
