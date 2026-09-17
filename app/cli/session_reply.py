# -*- coding: utf-8 -*-
"""Exact-session reply adapters and durable, idempotent delivery receipts.

Codex Desktop: local IPC owner discovery + follower API (versioned; fail closed).
Herdr: registered session PID must belong to the live pane, never match by cwd.
No new model process, account, or internet-facing listener is created here.
"""
import hashlib
import json
import os
import re
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time
import uuid
from contextlib import closing


class Rejected(Exception):
    """Known not to have submitted input."""


class Blocked(Rejected):
    """The pane is up but the TUI waits at a prompt (trust / permission / picker): the message
    can't go in yet, but keys from the phone can answer it."""
    def __init__(self, message, pane):
        super().__init__(message)
        self.pane = pane


class DesktopIPC:
    def __init__(self, home):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(8)
        self.client = 'uninitialized'
        try:
            self.sock.connect(os.path.join(home, '.codex', 'ipc', 'ipc.sock'))
            self.client = self.request('initialize', {'clientType': 'dispatch'}, version=0)['result']['clientId']
        except Exception:
            self.sock.close()
            raise

    def close(self):
        self.sock.close()

    def read(self, size):
        data = b''
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError('Codex 连接已断开')
            data += chunk
        return data

    def request(self, method, params, owner=None, version=1, wait=9):
        rid = str(uuid.uuid4())
        payload = dict(type='request', requestId=rid, sourceClientId=self.client,
                       method=method, params=params, version=version, timeoutMs=min(6000, int(wait * 1000)))
        if owner:
            payload['targetClientId'] = owner
        raw = json.dumps(payload).encode()
        self.sock.settimeout(min(8, wait))
        self.sock.sendall(struct.pack('<I', len(raw)) + raw)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            size = struct.unpack('<I', self.read(4))[0]
            if not 0 < size <= 32 * 1024 * 1024:
                raise ConnectionError('Codex IPC 消息格式已改变')
            result = json.loads(self.read(size))
            if result.get('type') == 'client-discovery-request':
                reply = json.dumps(dict(type='client-discovery-response', requestId=result['requestId'], response={'canHandle': False})).encode()
                self.sock.sendall(struct.pack('<I', len(reply)) + reply)
            if result.get('requestId') == rid and result.get('type') == 'response':
                return result
        raise TimeoutError('Codex 未确认收到消息')

    def owner(self, sid):
        # A thread no desktop window owns gets no answer at all (not an error): keep the wait
        # short, the phone polls this every 15 s.
        r = self.request('thread-owner-discovery', {'hostId': 'local', 'conversationId': sid}, wait=4)
        if r.get('resultType') != 'success':
            raise Rejected('请先在电脑的 Codex 中打开这个会话，然后点重新连接。')
        return r['handledByClientId']

    def send(self, ref, text, request_id):
        sid, cwd = ref['session_id'], ref['cwd']
        owner = self.owner(sid)
        inputs = [{'type': 'text', 'text': text, 'text_elements': []}]
        restore = dict(id=request_id, text=text, cwd=cwd, createdAt=int(time.time()*1000),
                       context=dict(prompt=text, addedFiles=[], fileAttachments=[], imageAttachments=[], ideContext=None, workspaceRoots=[cwd]))
        # The owner checks its actual live turn. Only an explicit inactive response
        # permits starting a turn; timeouts must never cause a second submission.
        r = self.request('thread-follower-steer-turn', dict(conversationId=sid, input=inputs,
                         restoreMessage=restore, attachments=[], clientUserMessageId=request_id), owner)
        if r.get('resultType') == 'error' and 'no active turn to steer' in r.get('error', '').lower():
            r = self.request('thread-follower-start-turn', dict(conversationId=sid, turnStart={
                'request': dict(threadId=sid, input=inputs, clientUserMessageId=request_id),
                'context': {'inheritThreadSettings': True}}), owner, version=2)
        if r.get('resultType') != 'success':
            raise RuntimeError(r.get('error') or 'Codex 未确认收到消息')
        return '已送达原 Codex 会话'

    # -- what the desktop knows about a thread: pending approvals / questions and whether a turn runs.
    # The desktop broadcasts a thread's state only to followers: announce ourselves, ask the owner
    # to load the complete history (it answers with a snapshot broadcast), read it, stop following.
    def _send(self, msg):
        raw = json.dumps(msg).encode()
        self.sock.sendall(struct.pack('<I', len(raw)) + raw)

    def _recv(self):
        size = struct.unpack('<I', self.read(4))[0]
        if not 0 < size <= 256 * 1024 * 1024:
            raise ConnectionError('Codex IPC 消息格式已改变')
        m = json.loads(self.read(size))
        if m.get('type') == 'client-discovery-request':
            self._send(dict(type='client-discovery-response', requestId=m['requestId'], response={'canHandle': False}))
        return m

    def _follow(self, sid, on):
        self._send(dict(type='broadcast', broadcastId=str(uuid.uuid4()), sourceClientId=self.client, method='thread-stream-following-changed',
                        params=dict(conversationId=sid, hostId='local', following=bool(on)), version=1))

    def snapshot(self, sid, owner=None):
        """The desktop's conversationState for the thread (raw)."""
        owner = owner or self.owner(sid)
        self._follow(sid, True)
        try:
            rid = str(uuid.uuid4())
            self._send(dict(type='request', requestId=rid, sourceClientId=self.client, targetClientId=owner, method='thread-follower-load-complete-history',
                            params=dict(conversationId=sid), version=1, timeoutMs=8000))
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                m = self._recv()
                if m.get('type') == 'broadcast' and m.get('method') == 'thread-stream-state-changed':
                    p = m.get('params') or {}
                    ch = p.get('change') or {}
                    if p.get('conversationId') == sid and ch.get('type') == 'snapshot' and isinstance(ch.get('conversationState'), dict):
                        return ch['conversationState']
                if m.get('type') == 'response' and m.get('requestId') == rid and m.get('resultType') == 'error':
                    raise RuntimeError(m.get('error') or 'Codex 没有返回会话状态')
            raise TimeoutError('Codex 没有返回会话状态')
        finally:
            try:
                self._follow(sid, False)
            except Exception:
                pass

    def state(self, sid):
        return desktop_state(self.snapshot(sid))

    def decide(self, sid, request_id, decision, answers=None):
        """Answer one pending request: command / file approvals take accept | acceptForSession |
        decline; a permission request takes accept | decline (scope: this turn); a question takes
        the answers. The request's method decides which follower call to make."""
        owner = self.owner(sid)
        st = desktop_state(self.snapshot(sid, owner))
        req = next((r for r in st['requests'] if r['id'] == request_id), None)
        if not req:
            raise Rejected('这个请求已经不在了（可能已在桌面端处理过），刷新看看。')
        kind = req['kind']
        if kind in ('command', 'file'):
            if decision not in ('accept', 'acceptForSession', 'decline'):
                raise Rejected('决定只能是 accept / acceptForSession / decline。')
            method = 'thread-follower-command-approval-decision' if kind == 'command' else 'thread-follower-file-approval-decision'
            r = self.request(method, dict(conversationId=sid, requestId=request_id, decision=decision), owner)
        elif kind == 'permission':
            if decision not in ('accept', 'decline'):
                raise Rejected('权限请求只能批准或拒绝。')
            granted = req.get('permissions') if decision == 'accept' else {}
            r = self.request('thread-follower-permissions-request-approval-response', dict(conversationId=sid, requestId=request_id, response={'permissions': granted or {}, 'scope': 'turn'}), owner)
        elif kind == 'question':
            if not isinstance(answers, dict) or not answers:
                raise Rejected('请填写答案。')
            r = self.request('thread-follower-submit-user-input', dict(conversationId=sid, requestId=request_id, response={'answers': answers}), owner)
        else:
            raise Rejected('这种请求只能在桌面端处理。')
        if r.get('resultType') != 'success':
            raise RuntimeError(r.get('error') or 'Codex 没有确认这个决定')
        return {'command': '已批准' if decision == 'accept' else '本会话都批准' if decision == 'acceptForSession' else '已拒绝', 'file': '已批准' if decision != 'decline' else '已拒绝', 'permission': '已批准' if decision == 'accept' else '已拒绝', 'question': '答案已提交'}[kind]

    def interrupt(self, sid):
        owner = self.owner(sid)
        st = desktop_state(self.snapshot(sid, owner))
        if not st['running']:
            raise Rejected('它现在没在跑，不用打断。')
        r = self.request('thread-follower-interrupt-turn', dict(conversationId=sid, mode='user-stop', expectedTurnId=st.get('turn_id')), owner, version=4)
        if r.get('resultType') != 'success':
            raise RuntimeError(r.get('error') or 'Codex 没有确认打断')
        return '已打断当前这轮'


REQUEST_KINDS = {
    'item/commandExecution/requestApproval': 'command', 'execCommandApproval': 'command',
    'item/fileChange/requestApproval': 'file', 'applyPatchApproval': 'file',
    'item/permissions/requestApproval': 'permission',
    'item/tool/requestUserInput': 'question',
    'item/tool/requestOptionPicker': 'option', 'mcpServer/elicitation/request': 'elicitation',
}


def _cmd_text(v):
    if isinstance(v, list):
        return ' '.join(str(x) for x in v)
    return str(v or '')


def desktop_state(cs):
    """A compact view of the desktop's conversationState: is a turn running, and what it waits for."""
    status = (cs.get('threadRuntimeStatus') or {}) if isinstance(cs.get('threadRuntimeStatus'), dict) else {}
    requests = []
    for r in cs.get('requests') or []:
        if not isinstance(r, dict):
            continue
        p = r.get('params') if isinstance(r.get('params'), dict) else {}
        kind = REQUEST_KINDS.get(r.get('method') or '', 'other')
        row = {'id': str(r.get('id')), 'method': r.get('method') or '', 'kind': kind, 'turn_id': p.get('turnId'), 'reason': str(p.get('reason') or '')[:400]}
        if kind == 'command':
            row['summary'] = _cmd_text(p.get('command') or p.get('parsedCmd') or p.get('cmd'))[:400]
            row['cwd'] = str(p.get('cwd') or '')
        elif kind == 'file':
            changes = p.get('changes') or p.get('fileChanges') or []
            paths = [str(c.get('path') or c.get('file') or '') for c in changes if isinstance(c, dict)] if isinstance(changes, list) else []
            row['summary'] = '修改 ' + '、'.join(x for x in paths if x)[:400] if paths else '修改文件'
            row['files'] = paths
        elif kind == 'permission':
            perms = p.get('permissions') if isinstance(p.get('permissions'), dict) else {}
            row['summary'] = '申请权限：' + ('、'.join(perms.keys()) if perms else str(p.get('reason') or ''))[:400]
            row['permissions'] = perms
        elif kind == 'question':
            qs = p.get('questions') if isinstance(p.get('questions'), list) else []
            row['questions'] = [{'id': str(q.get('id') or i), 'text': str(q.get('question') or q.get('header') or q.get('text') or '')[:400], 'options': [str(o.get('label') if isinstance(o, dict) else o) for o in (q.get('options') or [])]} for i, q in enumerate(qs) if isinstance(q, dict)]
            row['summary'] = '；'.join(q['text'] for q in row['questions'])[:400] or '它有问题要问'
        else:
            row['summary'] = str(p.get('message') or p.get('title') or r.get('method') or '')[:400]
        requests.append(row)
    return {'running': status.get('type') not in (None, '', 'idle'), 'status': status.get('type') or 'idle', 'turn_id': status.get('turnId') or status.get('turn_id'),
            'requests': requests, 'title': cs.get('title') or cs.get('generatedTitle') or '', 'cwd': cs.get('cwd') or '',
            'model': cs.get('latestModel') or '', 'approval_policy': ((cs.get('latestThreadSettings') or {}).get('approvalPolicy') if isinstance(cs.get('latestThreadSettings'), dict) else '') or '',
            'has_unread': bool(cs.get('hasUnreadTurn'))}



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
            raise Rejected(f"这台电脑上没有这个会话，它在 {'、'.join(elsewhere)} 上" + (f"（在那台上操作：{how}）" if how else '') + '。')
        raise Rejected('这台电脑找不到这个会话，请刷新后重新选择。')
    path, entry = max(matches, key=lambda pair: pair[1].get('mtime', 0))
    return dict(entry, path=path)


def herdr_target(d, ref, require_idle=True, allow_blocked=False):
    # Old presence records may point at a PID now running a newer conversation.
    records = []
    for name in os.listdir(d.SESS_DIR) if os.path.isdir(d.SESS_DIR) else []:
        try:
            with open(os.path.join(d.SESS_DIR, name)) as f:
                records.append(json.load(f))
        except (OSError, ValueError):
            pass
    rec = max((r for r in records if r.get('session_id') == ref['session_id'] and r.get('agent') == ref['agent']), key=lambda r: r.get('last_at', 0), default={})
    pid = rec.get('agent_pid')
    family = {'claude-code': 'claude', 'pi': 'pi', 'codex': 'codex'}.get(ref['agent'])
    panes = [p for p in d.herdr_agents() if p.get('agent') == family]
    # Herdr knows which conversation a pane runs (agent_session); that is exact, so try it first.
    exact = [p for p in panes if (p.get('agent_session') or {}).get('value') == ref['session_id']]
    if len(exact) > 1:
        raise Rejected('这个会话同时在多个终端运行，请在电脑上确认保留哪个窗口后重新连接。')
    # Live pane identity is stronger than missing/stale hook files. PID fallback is only for
    # older Herdr versions that do not report a session id; never override a different id.
    if not exact and not pid:
        # No hook record yet (a TUI Dispatch just resumed, stopped at a trust/login dialog before
        # its hooks ran): the pane Dispatch itself started with `--resume <id>` is still exact.
        live_sessions = getattr(d, 'live_sessions', None)
        try:
            rows = live_sessions(local_only=True) if callable(live_sessions) else []
        except Exception:
            rows = []
        for s in rows:
            h = s.get('herdr') or {}
            if s.get('agent') == ref['agent'] and s.get('probable_session_id') == ref['session_id'] and s.get('source_app') == 'Herdr' and h.get('pane_id'):
                exact = [p for p in panes if p.get('pane_id') == h['pane_id'] and not (p.get('agent_session') or {}).get('value')]
                pid = s.get('agent_pid') or pid
                break
    if not exact:
        if not pid:
            raise Rejected('这个终端会话未连接。请在电脑上恢复原会话后重新连接。')
        if any(r.get('agent_pid') == pid and r.get('session_id') != ref['session_id'] and r.get('last_at', 0) >= rec.get('last_at', 0) for r in records):
            raise Rejected('原终端已切换到另一个会话，请重新打开当前会话。')
    for pane in exact or [p for p in panes if not (p.get('agent_session') or {}).get('value')]:
        if pane not in exact:
            r = d.herdr(None, ['pane', 'process-info', '--pane', pane['pane_id']])
            processes = r.get('result', {}).get('process_info', {}).get('foreground_processes', [])
            if not any(p.get('pid') == pid for p in processes):
                continue
        if pane.get('agent_status') == 'blocked' and not allow_blocked:
            raise Rejected('原会话正在等待权限确认，请打开电脑屏幕处理。')
        # Herdr's status lags (pi looks idle while its bash tool runs); the hook record is the
        # other witness. Busy if either says so.
        busy = pane.get('agent_status') not in ('idle', 'done') or rec.get('state') == 'working'
        if not busy:
            # Third witness: the transcript itself (a turn with no final reply yet).
            try:
                from activity import activity_list
                row = next((a for a in activity_list(d.HOME, d.DISPATCH_DIR, d.load_index()) if a.get('session_id') == ref['session_id']), None)
                busy = bool(row and row.get('state') == 'working' and not row.get('stale'))
            except Exception:
                pass
        pane = dict(pane, busy=busy)
        if require_idle and pane['busy']:
            raise Rejected('Agent 正在执行，请等本轮结束后发送。')
        return pane
    raise Rejected('无法确认原会话所在的终端。请在电脑上恢复原会话后重新连接。')


def adoptable(d, ref):
    """The live_sessions() row for `ref` when it is running on this machine outside Herdr (so
    `target` cannot find a pane for it) and its agent kind can be adopted — the same session
    `session_control.adopt` would take. None when it isn't live here, already in Herdr, or its
    kind can't be adopted this way (imported lazily: session_control imports this module)."""
    live_sessions = getattr(d, 'live_sessions', None)
    if not callable(live_sessions):
        return None
    import session_control
    if ref['agent'] not in session_control.KINDS:
        return None
    rows = [s for s in live_sessions(local_only=True) if s.get('agent') == ref['agent']]
    exact = [s for s in rows if s.get('session_id') == ref['session_id']]
    if any(s.get('herdr') for s in exact):
        return None
    # A guessed ChatGPT helper process must not override the registered original session.
    candidates = exact or [s for s in rows if (s.get('session_id') or '').startswith('pid-') and s.get('probable_session_id') == ref['session_id'] and not s.get('herdr')]
    return max(candidates, key=lambda s: s.get('last_at') or 0, default=None)


# ---------------------------------------------------------------- Ghostty (no Herdr pane)
#
# A session running in a plain Ghostty window (never taken into Herdr) has no pane Herdr can
# address, but Ghostty's own AppleScript dictionary can paste text and press keys into one of
# its terminal surfaces — if we can point at the right one. Ghostty's `terminal` class exposes
# only id / name / working directory: no pid, no tty (see ghostty.org/docs/features/applescript).
# Matching by cwd alone is never enough — several sessions routinely share a working directory —
# so `id` is the only thing we can reliably send to, and the only way to find it is to make the
# terminal say something unique back: write a one-off OSC 2 title straight to the pty device
# Ghostty itself owns (found from the process tree, since Claude Code's own CLI re-execs itself
# onto a *different*, nested pty — writing there would never reach Ghostty's display), then read
# it back off every terminal Ghostty knows about and see which one changed.


def _ps_table_tty():
    """Like dispatch.ps_table() but with each process's controlling tty, needed only to find the
    pty Ghostty itself created for a session (dispatch.ps_table()'s 3-column shape is a contract
    other callers unpack positionally, so this stays a separate helper)."""
    r = subprocess.run(['ps', '-axo', 'pid=,ppid=,tty=,comm='], capture_output=True, text=True, timeout=3)
    t = {}
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) == 4:
            try:
                t[int(parts[0])] = (int(parts[1]), parts[2], parts[3])
            except ValueError:
                pass
    return t


def _ghostty_tty(pid, table):
    """The terminal device of the process Ghostty itself spawned directly for this session (its
    `login`), found by climbing from `pid` until a process' parent is the Ghostty binary. That is
    the only pty guaranteed to reach Ghostty's display — the agent's own pid can sit on a nested
    pty of its own (Claude Code's CLI re-execs into one), and writes there go nowhere Ghostty
    reads. None when this pid's ancestry isn't hosted by Ghostty at all."""
    current = pid
    for _ in range(30):
        ent = table.get(current)
        if not ent:
            return None
        ppid, tty, _comm = ent
        parent = table.get(ppid)
        if parent and '/Ghostty.app/' in parent[2]:
            return tty if tty and tty != '??' else None
        if ppid <= 1:
            return None
        current = ppid
    return None


def _as_lit(s):
    """A Python string as an AppleScript string literal (backslash/quote escaped; a real
    newline inside the source is valid AppleScript and needs no escaping)."""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def _osascript_file(body, timeout=8):
    """Run one Ghostty AppleScript from a temp file — never `-e`: a message can carry quotes,
    backslashes and literal newlines that only a real script file handles safely. Raises Rejected
    with a specific, actionable message when macOS has not granted Ghostty automation permission
    yet (error -1743) rather than a generic failure."""
    path = os.path.join(tempfile.gettempdir(), f'dispatch-ghostty-{uuid.uuid4().hex}.applescript')
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(body)
        try:
            r = subprocess.run(['osascript', path], capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Rejected('Ghostty 没有及时响应，请稍候重试。')
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if r.returncode != 0:
        err = (r.stderr or '').strip()
        if '-1743' in err or 'not authorized' in err.lower():
            app = 'iTerm2' if 'iTerm' in body else 'Terminal' if 'application "Terminal"' in body else 'Ghostty'
            raise Rejected(f'这台电脑还没给 {app} 自动化权限：系统设置 → 隐私与安全性 → 自动化，找到运行 dispatch 的程序（通常显示为 osascript）并勾选允许它控制 {app}，授权后重试。')
        raise Rejected('Ghostty 没有响应' + ('：' + err.splitlines()[-1][:200] if err else '') + '。')
    return r.stdout


def _ghostty_terminals():
    """[{id, name, cwd}] for every terminal surface Ghostty currently has open, across all its
    windows and tabs (the `terminals` element is flat at the application level). Fields are
    joined with ASCII 31/30 (unit/record separator), not `tab`/`linefeed` — inside a `tell
    application "Ghostty"` block those names resolve to Ghostty's own `tab` *class* and are not
    the whitespace constants, so a literal `& tab &` silently outputs the letters "tab" and this
    used to never parse into 3 fields."""
    body = ('tell application "Ghostty"\n'
            'set out to ""\n'
            'repeat with t in terminals\n'
            'set out to out & (id of t) & (character id 31) & (name of t) & (character id 31) & (working directory of t) & (character id 30)\n'
            'end repeat\n'
            'return out\n'
            'end tell\n')
    raw = _osascript_file(body)
    rows = []
    for row in raw.split('\x1e'):
        parts = row.split('\x1f')
        if len(parts) == 3:
            rows.append({'id': parts[0], 'name': parts[1], 'cwd': parts[2]})
    return rows


def _ghostty_terminal_exists(term_id):
    out = _osascript_file('tell application "Ghostty" to exists terminal id %s\n' % _as_lit(term_id))
    return out.strip() == 'true'


def _write_tty_title(tty, text):
    """Set the OSC 2 title on `tty` — output written to a pty's slave device is exactly what a
    foreground process on it would print to its own stdout, so this reaches Ghostty's display
    without touching that process' stdin (no keystrokes are injected)."""
    with open('/dev/' + tty, 'w') as f:
        f.write('\x1b]2;%s\x07' % text)


_GHOSTTY_CACHE_TTL = 30


def _ghostty_cache_path(d):
    return os.path.join(d.DISPATCH_DIR, 'ghostty-tty-cache.json')


def _ghostty_cache_get(d, tty):
    try:
        with open(_ghostty_cache_path(d)) as f:
            c = json.load(f)
    except (OSError, ValueError):
        return None
    e = c.get(tty)
    return e.get('id') if e and time.time() - e.get('ts', 0) < _GHOSTTY_CACHE_TTL else None


def _ghostty_cache_put(d, tty, term_id):
    path = _ghostty_cache_path(d)
    try:
        with open(path) as f:
            c = json.load(f)
    except (OSError, ValueError):
        c = {}
    now = time.time()
    c[tty] = {'id': term_id, 'ts': now}
    c = {k: v for k, v in c.items() if now - v.get('ts', 0) < 300}  # never let this grow stale
    os.makedirs(d.DISPATCH_DIR, exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(c, f)
    os.replace(tmp, path)


def _ghostty_terminal_id(d, tty):
    """The Ghostty terminal id whose pty is `tty`. A short-lived cache (re-verified — a closed
    window must never be reused) skips the probe on the common case of sending twice in a row;
    otherwise flash a unique marker onto the tty's title and see which terminal shows it. Returns
    None when the marker never showed up on exactly one terminal (not found, or — several tabs
    somehow sharing the same pty display — ambiguous); never guesses. The title is restored on
    every exit from the probe — found, ambiguous, not found, or an error mid-probe — so a user's
    tab is never left stuck reading our marker."""
    cached = _ghostty_cache_get(d, tty)
    if cached and _ghostty_terminal_exists(cached):
        return cached
    marker = 'dispatch-probe-' + uuid.uuid4().hex[:12]
    before = {t['id']: t['name'] for t in _ghostty_terminals()}
    try:
        _write_tty_title(tty, marker)
    except OSError as e:
        raise Rejected('没能连上 Ghostty 的终端设备（%s），请重新连接。' % e)
    found = None
    try:
        for _ in range(10):
            hits = [t['id'] for t in _ghostty_terminals() if t['name'] == marker]
            if len(hits) == 1:
                found = hits[0]
                break
            if len(hits) > 1:
                found = None
                break
            time.sleep(0.15)
    finally:
        try:
            hits_now = [t['id'] for t in _ghostty_terminals() if t['name'] == marker]
            if hits_now:
                _write_tty_title(tty, before.get(hits_now[0], ''))
        except Exception:
            pass  # Claude Code redraws its own status-line title on the next turn regardless
    if found:
        _ghostty_cache_put(d, tty, found)
    return found


def _hook_or_transcript_busy(d, ref, rec):
    """Two witnesses shared by every target kind (Herdr adds its own pane status on top): the
    hook record's own state, and the transcript itself (a turn with no final reply yet — catches
    e.g. an interrupted turn whose hook record lagged)."""
    if rec.get('state') == 'working':
        return True
    try:
        from activity import activity_list
        row = next((a for a in activity_list(d.HOME, d.DISPATCH_DIR, d.load_index()) if a.get('session_id') == ref['session_id']), None)
        return bool(row and row.get('state') == 'working' and not row.get('stale'))
    except Exception:
        return False


def ghostty_target(d, ref):
    """When `ref`'s agent process tree is hosted inside a plain Ghostty window (not Herdr), the
    terminal surface running it — or None when it plainly isn't a Ghostty session (no hook
    record, or its process tree isn't under Ghostty at all). Once we know it *is* Ghostty-hosted,
    any further failure to pin down exactly one terminal is a Rejected with a specific message,
    not a silent None — the caller should not fall back to the generic "can't find it" wording."""
    records = []
    for name in os.listdir(d.SESS_DIR) if os.path.isdir(d.SESS_DIR) else []:
        try:
            with open(os.path.join(d.SESS_DIR, name)) as f:
                records.append(json.load(f))
        except (OSError, ValueError):
            pass
    rec = next((r for r in records if r.get('session_id') == ref['session_id'] and r.get('agent') == ref['agent']), None)
    if not rec or not rec.get('agent_pid'):
        return None
    pid = rec['agent_pid']
    if any(r.get('agent_pid') == pid and r.get('session_id') != ref['session_id'] and r.get('last_at', 0) >= rec.get('last_at', 0) for r in records):
        return None
    table = _ps_table_tty()
    if pid not in table:
        return None
    tty = _ghostty_tty(pid, table)
    if not tty:
        return None
    term_id = _ghostty_terminal_id(d, tty)
    if term_id is None:
        raise Rejected('在 Ghostty 里没能唯一定位到这个会话的窗口（可能有几个标签同名或同目录），没有发送；可以先在电脑上手动切到那个窗口，或点「接进 Herdr 再发」。')
    working = _hook_or_transcript_busy(d, ref, rec)
    label = 'Agent 正在执行：可以排队（本轮结束就看到）或打断' if working else '回复到 Ghostty 里的原会话'
    return {'kind': 'ghostty', 'terminal_id': term_id, 'working': working, 'label': label}


def ghostty_submit(d, ref, t, text, wire, mode, images, attach):
    """Deliver into the Ghostty terminal `target()` resolved. Re-resolves right before sending —
    a window can close between status() and send — and refuses if it now points somewhere else,
    same discipline as the Herdr path's own pid re-check. One AppleScript does the whole
    sequence in order: Esc first when interrupting a busy turn, each image path pasted alone with
    a beat after (Claude Code only turns a lone pasted path into an attachment — the same trick
    the Herdr path uses), the words, Enter."""
    check = ghostty_target(d, ref)
    if check is None or check['terminal_id'] != t['terminal_id']:
        raise Rejected('会话位置发生变化，消息未发送，请重试。')
    term_id = check['terminal_id']
    lines = ['tell application "Ghostty"']
    if check['working'] and mode == 'interrupt':
        lines.append('send key "escape" to terminal id %s' % _as_lit(term_id))
        lines.append('delay 1.2')
    if attach:
        for p in images:
            lines.append('input text %s to terminal id %s' % (_as_lit(p), _as_lit(term_id)))
            lines.append('delay 0.9')
        lines.append('input text %s to terminal id %s' % (_as_lit(' ' + text.strip()), _as_lit(term_id)))
    else:
        lines.append('input text %s to terminal id %s' % (_as_lit(wire), _as_lit(term_id)))
    lines.append('send key "enter" to terminal id %s' % _as_lit(term_id))
    lines.append('end tell')
    timeout = 10 + len(images) * 2 + (2 if check['working'] and mode == 'interrupt' else 0)
    _osascript_file('\n'.join(lines) + '\n', timeout=timeout)
    if check['working']:
        return '已打断并送达，Agent 会先处理这条' if mode == 'interrupt' else '已排队，本轮结束后 Agent 就会看到'
    return '已送达 Ghostty 里的原会话'


# ---------------------------------------------------------------- Terminal.app / iTerm2 (no Herdr pane)
#
# Both expose each tab's tty to AppleScript and accept text for a tab, so a session running in
# one is addressed by the tty its process sits on — no window titles, no focus changes.

TTY_TERMINALS = (('/Terminal.app/', 'Terminal'), ('/iTerm.app/', 'iTerm2'), ('/iTerm2.app/', 'iTerm2'))


def _tty_terminal_of(pid, table):
    """(app, '/dev/ttysNNN') when `pid` runs inside Terminal.app or iTerm2, else None. The tty is
    the one of the process the terminal spawned for the tab (its `login`): that is what the tab
    reports as its `tty`."""
    current = pid
    for _ in range(30):
        ent = table.get(current)
        if not ent:
            return None
        ppid, tty, _comm = ent
        parent = table.get(ppid)
        if parent:
            app = next((name for key, name in TTY_TERMINALS if key in parent[2]), None)
            if app:
                return (app, '/dev/' + tty) if tty and tty != '??' else None
        if ppid <= 1:
            return None
        current = ppid
    return None


def _session_record(d, ref):
    """The hook record of `ref` when it is the latest session of its process, else None."""
    records = []
    for name in os.listdir(d.SESS_DIR) if os.path.isdir(d.SESS_DIR) else []:
        try:
            with open(os.path.join(d.SESS_DIR, name)) as f:
                records.append(json.load(f))
        except (OSError, ValueError):
            pass
    rec = next((r for r in records if r.get('session_id') == ref['session_id'] and r.get('agent') == ref['agent']), None)
    if not rec or not rec.get('agent_pid'):
        return None
    pid = rec['agent_pid']
    if any(r.get('agent_pid') == pid and r.get('session_id') != ref['session_id'] and r.get('last_at', 0) >= rec.get('last_at', 0) for r in records):
        return None
    return rec


def tty_terminal_target(d, ref):
    rec = _session_record(d, ref)
    if rec is None:
        return None
    table = _ps_table_tty()
    if rec['agent_pid'] not in table:
        return None
    hit = _tty_terminal_of(rec['agent_pid'], table)
    if not hit:
        return None
    app, tty = hit
    working = _hook_or_transcript_busy(d, ref, rec)
    label = ('Agent 正在执行：消息会排队，本轮结束就看到' if working else f'回复到 {app} 里的原会话')
    return {'kind': 'tty-terminal', 'app': app, 'tty': tty, 'working': working, 'label': label}


def tty_terminal_script(app, tty, text):
    """AppleScript that types `text` + Return into the tab whose tty is `tty`; prints ok / missing."""
    if app == 'iTerm2':
        return ('tell application "iTerm2"\n repeat with w in windows\n  repeat with tb in tabs of w\n   repeat with ss in sessions of tb\n'
                '    if (tty of ss) is %s then\n     tell ss to write text %s\n     return "ok"\n    end if\n   end repeat\n  end repeat\n end repeat\n return "missing"\nend tell\n'
                % (_as_lit(tty), _as_lit(text)))
    return ('tell application "Terminal"\n repeat with w in windows\n  repeat with tb in tabs of w\n'
            '   if (tty of tb) is %s then\n    do script %s in tb\n    return "ok"\n   end if\n  end repeat\n end repeat\n return "missing"\nend tell\n'
            % (_as_lit(tty), _as_lit(text)))


def tty_terminal_submit(d, ref, t, wire, mode):
    """Type the message into the Terminal.app / iTerm2 tab. One line only: a newline would submit
    early, so line breaks travel as spaces. There is no key-level access here, so 「打断」 is not
    available: a busy agent gets the message queued in its input box, like typing it by hand."""
    check = tty_terminal_target(d, ref)
    if check is None or check['tty'] != t['tty']:
        raise Rejected('会话位置发生变化，消息未发送，请重试。')
    text = ' '.join(x.strip() for x in wire.splitlines() if x.strip())
    out = _osascript_file(tty_terminal_script(check['app'], check['tty'], text), timeout=12).strip()
    if out != 'ok':
        raise Rejected(f"在 {check['app']} 里没找到这个会话所在的标签页（它可能刚被关掉），没有发送；可以点「接进 Herdr 再发」。")
    if check['working']:
        return '已排队，本轮结束后 Agent 就会看到' + ('（这个终端不支持打断，已按排队处理）' if mode == 'interrupt' else '')
    return f"已送达 {check['app']} 里的原会话"


def codex_desktop_target(d, ref):
    """The Codex desktop app (ChatGPT.app) owning this thread, or None. The app answers owner
    discovery only for threads one of its windows has open; for anything else it stays silent
    until our wait runs out, and a socket left behind by a closed app refuses. Neither is a
    reason to tell the phone 「暂时无法连接」 — the session is simply not in the desktop."""
    if not os.path.exists(os.path.join(d.HOME, '.codex', 'ipc', 'ipc.sock')):
        return None
    try:
        with closing(DesktopIPC(d.HOME)) as ipc:
            owner = ipc.owner(ref['session_id'])
            try:
                desktop = desktop_state(ipc.snapshot(ref['session_id'], owner))
            except Exception:
                desktop = None
    except (Rejected, OSError, ValueError):
        return None
    return {'kind': 'codex-desktop', 'label': '回复到原 Codex 会话', 'working': bool(desktop and desktop['running']), 'desktop': desktop}


def target(d, ref):
    if ref['agent'] in ('claude-code', 'pi', 'codex'):
        # A working agent can still take a message: the TUIs queue typed input for the next turn,
        # and Esc interrupts the current one — the app offers both.
        try:
            pane = herdr_target(d, ref, require_idle=False, allow_blocked=True)
        except Rejected as herdr_err:
            desktop_target = codex_desktop_target(d, ref) if ref['agent'] == 'codex' else None
            if desktop_target:
                return desktop_target
            # Not in Herdr — maybe it's a plain Ghostty window instead. A definite Ghostty
            # failure (found it, couldn't pin the exact terminal) surfaces its own message;
            # "not Ghostty at all" falls through to the original Herdr rejection (and its
            # adoptable-elsewhere hint from status()).
            g = ghostty_target(d, ref)
            if g is not None:
                return g
            tt = tty_terminal_target(d, ref)
            if tt is not None:
                return tt
            raise herdr_err
        if pane.get('agent_status') == 'blocked':
            raise Blocked('原会话在电脑上停在一个确认框，先回答它再发。', pane)
        working = bool(pane.get('busy'))
        return {'kind': 'herdr', 'pane': pane, 'working': working, 'label': 'Agent 正在执行：可以排队（本轮结束就看到）或打断' if working else '回复到电脑上的原会话'}
    raise Rejected('此 Agent 暂未提供直接回复接口。可打开电脑屏幕继续对话。')


def connect(d):
    os.makedirs(d.DISPATCH_DIR, exist_ok=True)
    path = os.path.join(d.DISPATCH_DIR, 'reply-receipts.sqlite')
    db = sqlite3.connect(path, timeout=10)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, sid TEXT, agent TEXT, digest TEXT, text TEXT, state TEXT, note TEXT, created REAL)')
    return db


def landed(ref, text, images=(), wait=12.0):
    """True once the words (or the picture note) show up in the session's own transcript. The
    TUIs log the user turn within a second when idle; a resumed Codex replaying 16 MB of history
    took ~10 s in practice, hence the generous wait. False = not seen, not 'lost'."""
    path = ref.get('path') or ''
    if not path or not os.path.exists(path):
        return False
    probe = (text.strip() or with_images(text, list(images)) or '').strip()[:60]
    if not probe:
        return False
    needles = {probe.encode(), json.dumps(probe, ensure_ascii=False)[1:-1].encode(), json.dumps(probe)[1:-1].encode()}
    size0 = os.path.getsize(path)
    deadline = time.time() + wait
    while True:
        try:
            with open(path, 'rb') as f:
                f.seek(max(0, size0 - 512 * 1024))
                tail = f.read()
        except OSError:
            tail = b''
        if any(n in tail for n in needles):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.8)


def queued_delivered(ref):
    """(text, epoch) of every message Claude Code took from its queue in this transcript: the
    `queued_command` attachment it logs when it folds one into the running turn."""
    out = []
    path = ref.get('path') or ''
    if not path or not os.path.isfile(path):
        return out
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if 'queued_command' not in line and 'queue-operation' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                text, ts = '', d.get('timestamp') or ''
                if d.get('type') == 'attachment' and (d.get('attachment') or {}).get('type') == 'queued_command':
                    text = (d['attachment'].get('prompt') or '')
                elif d.get('type') == 'queue-operation' and d.get('operation') == 'remove':
                    text = d.get('content') or ''
                if not text:
                    continue
                try:
                    from datetime import datetime as _dt
                    epoch = _dt.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                except ValueError:
                    epoch = 0
                out.append((plain_text(text), epoch))
    except OSError:
        pass
    return out


def status(d, ref):
    with closing(connect(d)) as db, db:
        pending = db.execute("SELECT * FROM replies WHERE sid=? AND agent=? AND state IN ('sending','unknown')", (ref['session_id'], ref['agent'])).fetchall()
        if pending:
            messages = d.read_session_detail(d.ref_of(ref['path'], ref))['messages']
            from datetime import datetime
            taken = queued_delivered(ref) if ref['agent'] == 'claude-code' else []
            for receipt in pending:
                found = any(t == plain_text(receipt['text']) and ts >= receipt['created'] - 10 for t, ts in taken)
                for m in messages:
                    try:
                        stamp = datetime.fromisoformat(m.get('ts', '').replace('Z', '+00:00')).timestamp()
                    except ValueError:
                        continue
                    if m['role'] == 'user' and plain_text(m['text']) == plain_text(receipt['text']) and stamp >= receipt['created'] - 10:
                        found = True
                if found:
                    db.execute("UPDATE replies SET state='accepted',note='已在原会话确认收到' WHERE id=?", (receipt['id'],))
                elif receipt['state'] == 'sending' and time.time() - receipt['created'] > 45:
                    db.execute("UPDATE replies SET state='unknown',note='未确认送达，请先查看原会话。' WHERE id=?", (receipt['id'],))
        receipts = [dict(r) for r in db.execute('SELECT id,text,state,note,created FROM replies WHERE sid=? AND agent=? ORDER BY created DESC LIMIT 10', (ref['session_id'], ref['agent']))]
    # Delivered = the words are in the conversation. A message queued while Claude Code worked never
    # becomes a user turn: it is absorbed mid-turn and logged as a queued_command attachment / a
    # queue-operation, so those count too.
    absorbed = queued_delivered(ref) if ref['agent'] == 'claude-code' else []
    try:
        shown = d.read_session_detail(d.ref_of(ref['path'], ref))['messages'] if receipts else []
    except Exception:
        shown = []
    from datetime import datetime as _dt
    for r in receipts:
        want = plain_text(r['text'])
        hit = any(t == want and ts >= r['created'] - 10 for t, ts in absorbed)
        if not hit:
            for m in shown:
                try:
                    stamp = _dt.fromisoformat(m.get('ts', '').replace('Z', '+00:00')).timestamp()
                except ValueError:
                    continue
                if m['role'] == 'user' and plain_text(m['text']) == want and stamp >= r['created'] - 10:
                    hit = True
                    break
        r['delivered'] = hit
        if hit and r['state'] == 'unknown':
            r.update(state='accepted', note='已送达原终端会话（稍后确认到的）')
            with closing(connect(d)) as db, db:
                db.execute("UPDATE replies SET state=?,note=? WHERE id=? AND state='unknown'", (r['state'], r['note'], r['id']))
    try:
        t = target(d, ref)
        extra = tui_state(d, t['pane']['pane_id']) if t['kind'] == 'herdr' and ref['agent'] == 'claude-code' else {}
        if t['kind'] == 'ghostty':
            extra = dict(extra, terminal='ghostty')
        if t['kind'] == 'tty-terminal':
            extra = dict(extra, terminal=t['app'].lower(), no_interrupt=True)
        return dict(available=True, label=t['label'], working=bool(t.get('working')), receipts=receipts, **({'desktop': t['desktop']} if t.get('desktop') else {}), **extra)
    except Blocked as e:
        # Show the prompt itself so the person can answer it with the keys below the box.
        pid = e.pane['pane_id']
        screen = d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True)
        screen = screen if isinstance(screen, str) else ''
        return dict(available=False, label=str(e), receipts=receipts, blocked=True,
                    screen='\n'.join(line.rstrip() for line in screen.splitlines() if line.strip())[-1600:])
    except Exception as e:
        info = dict(available=False, label=str(e) if isinstance(e, Rejected) else '暂时无法连接原 Agent，请重新连接。', receipts=receipts)
        live = adoptable(d, ref)
        if live is not None:
            where = live.get('source_app') or '其它终端'
            kind = live.get('source_kind') or ''
            # An editor extension (VS Code / Cursor…) has no terminal to type into: the message can
            # only go in after the same transcript is resumed in Herdr, which stops the editor's copy.
            label = ('原会话在这台电脑的 %s 扩展里跑。这里发不进编辑器面板；接进 Herdr 后 %s 里那份会停，之后在 Herdr 或手机上继续' % (where, where)
                     if kind == 'editor' else '原会话在这台电脑的 %s 里跑，没接进 Herdr' % where)
            info.update(label=label, adoptable=True, adopt_state='working' if live.get('state') == 'working' else 'idle',
                        source_app=live.get('source_app') or '', source_kind=kind)
        elif resumable(d, ref):
            # Not in Herdr, not in the desktop, not in any other terminal: the process is gone.
            # 「重新连接」 can never succeed — say so, and offer to bring it back (a Herdr tab
            # resuming the same transcript), which the phone can do on its own.
            info.update(label='这个会话现在没在电脑上运行。可以先在电脑上恢复它，再发。', resumable=True)
        return info


def resumable(d, ref):
    """True when the conversation is one Herdr can resume (Claude Code / Codex / pi) and no
    process on this Mac runs it right now."""
    import session_control
    if ref['agent'] not in session_control.KINDS:
        return False
    live_sessions = getattr(d, 'live_sessions', None)
    if not callable(live_sessions):
        return False
    try:
        rows = live_sessions(local_only=True)
    except Exception:
        return False
    return not any(s.get('agent') == ref['agent'] and (s.get('session_id') == ref['session_id'] or s.get('probable_session_id') == ref['session_id']) for s in rows)


def revive(d, ref, data):
    """Phone-side 「在电脑上恢复」: resume the conversation in a Herdr tab on this Mac. Same
    launch bookkeeping as the desktop's 打开原会话 (one request id → one launch; a resume already
    in flight is returned, not doubled); unlike it, never opens a desktop app instead."""
    import session_control
    if ref['agent'] not in session_control.KINDS:
        raise Rejected('这个 Agent 不能用命令行恢复。')
    return session_control.resume_in_herdr(d, ref, data.get('request_id'))


IMAGE_NOTE = '附图（用 Read 看）：'
# What a picture looks like in a transcript: Claude Code's marker, or the bare path it logs for a pasted attachment.
IMAGE_MARK = re.compile(r'\[Image: source: [^\]]*\]|(?:^|(?<=\s))/[^\s]+\.(?:png|jpe?g|gif|webp|heic|heif)\b', re.I)


def with_images(text, paths):
    """The one-string form: text plus where the pictures are (for agents whose input box has no
    picture attachments)."""
    return f"{text.strip() or '看一下这几张图'} {IMAGE_NOTE}{' '.join(paths)}" if paths else text.strip()


def plain_text(text):
    """A message with its picture markers and the 附图 note removed, for comparing what was sent
    with what the transcript shows. Content blocks (a list) count by their text parts."""
    if isinstance(text, list):
        text = '\n'.join((b.get('text') or '') if isinstance(b, dict) else str(b) for b in text)
    elif not isinstance(text, str):
        text = str(text or '')
    t = IMAGE_MARK.sub('', text)
    i = t.find(IMAGE_NOTE)
    if i >= 0:
        t = t[:i]
    return re.sub(r'\s+', ' ', t).strip()


def submit(d, ref, text, request_id, mode='queue', images=()):
    images = [p for p in (images or []) if isinstance(p, str) and p.strip()]
    text = text if text.strip() else ('看一下这几张图' if images else text)
    if not text.strip() or len(text) > 16000:
        raise Rejected('请输入回复，最多 16000 字。')
    if any(not os.path.isfile(p) for p in images):
        raise Rejected('有图片没传上来，请重新添加。')
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError):
        raise Rejected('无效的消息编号，请刷新页面。')
    digest = hashlib.sha256((ref['agent'] + '\0' + ref['session_id'] + '\0' + text + '\0' + '\n'.join(images)).encode()).hexdigest()
    with closing(connect(d)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        old = db.execute('SELECT * FROM replies WHERE id=?', (request_id,)).fetchone()
        if old:
            if old['digest'] != digest:
                raise Rejected('消息编号已用于另一条内容，请刷新后重试。')
            return dict(old)
        running = db.execute("SELECT id FROM replies WHERE sid=? AND agent=? AND state='sending' AND created>?", (ref['session_id'], ref['agent'], time.time()-60)).fetchone()
        if running:
            raise Rejected('上一条消息还在发送，请稍候。')
        # Resolve first: a disconnected/blocked target never gets a receipt claiming
        # submission. The second identity check is done immediately before writing.
        t = target(d, ref)
        # Claude Code takes pictures as attachments (each path pasted alone becomes [Image #n]); the
        # others read them from a note in the text. The receipt keeps the text only.
        attach = bool(images) and t['kind'] in ('herdr', 'ghostty') and ref['agent'] == 'claude-code'
        wire = text if attach else with_images(text, images)
        db.execute('INSERT INTO replies VALUES (?,?,?,?,?,?,?,?)', (request_id, ref['session_id'], ref['agent'], digest, with_images(text, images) if not attach else text, 'sending', '正在发送', time.time()))
    state, note = 'accepted', ''
    try:
        if t['kind'] == 'codex-desktop':
            with closing(DesktopIPC(d.HOME)) as ipc:
                note = ipc.send(ref, wire, request_id)
        elif t['kind'] == 'ghostty':
            note = ghostty_submit(d, ref, t, text, wire, mode, images, attach)
        elif t['kind'] == 'tty-terminal':
            note = tty_terminal_submit(d, ref, t, wire, mode)
        else:
            pane = herdr_target(d, ref, require_idle=False)
            focus = d.herdr(None, ['tab', 'focus', pane['tab_id']])
            if focus.get('error'):
                raise Rejected('无法连接原终端，消息未发送。')
            # Focusing cannot select the target: it must still match the same PID.
            check = herdr_target(d, ref, require_idle=False)
            if check['pane_id'] != pane['pane_id']:
                raise Rejected('会话位置发生变化，消息未发送，请重试。')
            busy = bool(check.get('busy'))
            if busy and mode == 'interrupt':
                # Esc stops the current turn in Claude Code, Codex and pi; give the TUI a moment to settle.
                d.herdr(None, ['agent', 'send-keys', pane['pane_id'], 'esc'])
                time.sleep(1.2)
            if attach:
                # Pasting a path that ends in an image extension turns it into an attachment — and,
                # when other text rides along in the same paste, Claude Code drops that text (and any
                # second path). So: one paste per picture, a beat for the conversion, then the words.
                for p in images:
                    d.herdr(None, ['pane', 'send-text', pane['pane_id'], p], raw=True)  # prints nothing on success
                    time.sleep(0.9)
                result = d.herdr(None, ['agent', 'prompt', pane['pane_id'], ' ' + text.strip()], timeout=15)
            else:
                result = d.herdr(None, ['agent', 'prompt', pane['pane_id'], wire], timeout=15)
            if result.get('error'):
                err = result['error']
                if err.get('code') in ('agent_blocked', 'agent_pane_busy', 'agent_not_found'):
                    raise Rejected('Agent 当前无法接收回复，消息未发送，请重新连接。')
                raise RuntimeError('终端未确认收到消息')
            if 'result' not in result:
                raise RuntimeError('终端未确认收到消息')
            if busy:
                note = '已打断并送达，Agent 会先处理这条' if mode == 'interrupt' else '已排队，本轮结束后 Agent 就会看到'
            elif landed(ref, text, images):
                note = '已送达原终端会话'
            else:
                # Herdr typed it, but the conversation does not show it: a TUI still loading a
                # resumed transcript, a dialog in the way… Do not claim delivery — the phone keeps
                # the draft, and status() upgrades this receipt if the words turn up later.
                state, note = 'unknown', '终端收到了键入，但对话里还没出现这条。草稿已保留，稍后点「确认发送结果」核对，不会重复发送。'
    except Rejected as e:
        state, note = 'failed', str(e)
    except Exception:
        state, note = 'unknown', '暂时无法确认是否送达，请先查看最新对话，避免重复发送。'
    with closing(connect(d)) as db, db:
        db.execute('UPDATE replies SET state=?,note=? WHERE id=?', (state, note, request_id))
        return dict(db.execute('SELECT * FROM replies WHERE id=?', (request_id,)).fetchone())


# Slash commands the reply box can offer for each agent. Built-ins are the ones that
# make sense typed from another screen; a dialog-only command still works, it just
# needs the desktop to finish it.
BUILTIN_COMMANDS = {
    'claude-code': [
        ('compact', '压缩对话上下文，后面可加一句要保留的重点'),
        ('clear', '清空对话，开始新任务'),
        ('context', '看当前上下文占用'),
        ('cost', '看本会话用量与额度'),
        ('status', '会话与账号状态'),
        ('model', '切换模型'),
        ('memory', '查看/编辑记忆文件'),
        ('review', '审查当前改动'),
        ('rewind', '回退到之前的对话或代码状态'),
        ('resume', '恢复另一个会话'),
        ('init', '生成 CLAUDE.md'),
        ('permissions', '权限设置'),
        ('mcp', 'MCP 服务器'),
        ('export', '导出对话'),
        ('doctor', '诊断安装'),
        ('help', '帮助'),
    ],
    'codex': [
        ('compact', '压缩对话上下文'),
        ('new', '开始新会话'),
        ('status', '状态与用量'),
        ('model', '切换模型'),
        ('approvals', '审批策略'),
        ('review', '审查当前改动'),
        ('diff', '看 git diff'),
        ('init', '生成 AGENTS.md'),
        ('mcp', 'MCP 服务器'),
    ],
    'pi': [
        ('compact', '压缩对话上下文'),
        ('new', '开始新会话'),
        ('model', '切换模型'),
        ('thinking', '思考等级'),
        ('session', '会话信息'),
        ('tree', '会话树'),
        ('fork', '从某条消息分叉'),
        ('resume', '恢复会话'),
        ('name', '给会话命名'),
        ('export', '导出对话'),
        ('settings', '设置'),
    ],
}


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
    rows = [dict(name=n, description=desc, kind='builtin') for n, desc in BUILTIN_COMMANDS.get(agent, [])]
    if agent == 'claude-code':
        rows += _skill_commands(d, [os.path.join(cwd, '.claude', 'skills')] + d.AGENT_SKILL_DIRS['claude'])
        rows += _markdown_commands(os.path.join(cwd, '.claude', 'commands'), 'command')
        rows += _markdown_commands(os.path.join(d.HOME, '.claude', 'commands'), 'command')
    elif agent == 'pi':
        rows += _markdown_commands(os.path.join(cwd, '.pi', 'prompts'), 'command')
        rows += _markdown_commands(os.path.join(d.HOME, '.pi', 'agent', 'prompts'), 'command')
        rows += _skill_commands(d, [os.path.join(cwd, '.pi', 'skills'), os.path.join(d.HOME, '.pi', 'agent', 'skills'), os.path.join(d.HOME, '.agents', 'skills')], prefix='skill:')
    seen, out = set(), []
    for r in rows:
        if r['name'] in seen:
            continue
        seen.add(r['name'])
        out.append(r)
    return out


# Answering Claude Code's AskUserQuestion picker by key presses, the way a person would:
# number keys pick (single) or toggle (multi), → moves to the next question, the last
# choice lands on a review screen where 1 submits. "Type something" is option n+1.
# Claude Code's status line: "[Sonnet 5] │ dir" and "⏵⏵ accept edits on (shift+tab to cycle)".
MODE_LABELS = {'manual mode on': 'default', 'accept edits on': 'acceptEdits', 'plan mode on': 'plan', 'bypass permissions on': 'bypassPermissions'}
MODE_ORDER = ['default', 'acceptEdits', 'plan', 'bypassPermissions']


def pane_tail(d, pid):
    """The bottom of the pane. The visible screen is current (history keeps stale status lines);
    it can come back short when the pane is scrolled up, then the history read fills in."""
    r = d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True) or ''
    if '│' not in r:
        r = d.herdr(None, ['agent', 'read', pid, '--lines', '6'], raw=True) or ''
    return '\n'.join(r.splitlines()[-12:])


def tui_state(d, pid):
    """{model, mode} as the Claude Code status line shows them; empty when unreadable."""
    t = pane_tail(d, pid)
    m = re.search(r'\[([^\]\n]{2,40})\] │', t)
    # The status line only redraws with the next turn; a fresh "/model" answer is newer than it.
    set_to = re.findall(r'Set model to (.+?) and saved', t)
    mode = next((v for k, v in MODE_LABELS.items() if k in t), None)
    out = {}
    if set_to:
        out['model'] = set_to[-1].strip()
    elif m:
        out['model'] = m.group(1).strip()
    if mode:
        out['mode'] = mode
    return out


def desktop_control(d, ref, payload):
    """Codex desktop: approve / decline a pending request, answer its question, or interrupt the turn."""
    t = target(d, ref)
    if t['kind'] != 'codex-desktop':
        raise Rejected('这个会话不在 Codex 桌面端里打开，审批和打断得在它运行的地方做。')
    with closing(DesktopIPC(d.HOME)) as ipc:
        if payload.get('interrupt'):
            note = ipc.interrupt(ref['session_id'])
        elif payload.get('request_id'):
            note = ipc.decide(ref['session_id'], str(payload['request_id']), payload.get('decision') or '', payload.get('answers'))
        else:
            raise Rejected('没有要做的事。')
        try:
            desktop = ipc.state(ref['session_id'])
        except Exception:
            desktop = None
    return dict(state='accepted', note=note, **({'desktop': desktop} if desktop else {}))


KEYS_ALLOWED = {'up', 'down', 'left', 'right', 'enter', 'esc', 'tab', 'space', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9'}


def press_keys(d, ref, keys):
    """Answer the dialog a TUI stopped at (trust this folder? allow this command? which option?)
    from the phone: a few named keys into the pane, only while Herdr reports it blocked — never
    into a running agent's input box. Returns the screen afterwards."""
    keys = [str(k).lower() for k in keys][:6]
    if not keys or any(k not in KEYS_ALLOWED for k in keys):
        raise Rejected('只能按 ↑ ↓ ← → ⏎ Esc Tab 空格 y n 和数字。')
    pane = herdr_target(d, ref, require_idle=False, allow_blocked=True)
    if pane.get('agent_status') != 'blocked':
        raise Rejected('原终端现在没有在等确认，直接发消息就行。')
    pid = pane['pane_id']
    for k in keys:
        r = d.herdr(None, ['agent', 'send-keys', pid, k])
        if isinstance(r, dict) and r.get('error'):
            raise Rejected('按键没发进去，请重试。')
        time.sleep(0.4)
    time.sleep(1.2)
    screen = d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True) or ''
    still = (d.herdr(None, ['agent', 'get', pid]).get('result', {}).get('agent', {}).get('agent_status') == 'blocked')
    return dict(state='accepted', note='已按下' if still else '确认框已过，可以发消息了', blocked=still,
                screen='\n'.join(line.rstrip() for line in screen.splitlines() if line.strip())[-1600:])


QUEUE_HINT = 'Press up to edit queued messages'


def withdraw(d, ref, receipt_id):
    """Take back a message still waiting in Claude Code's queue (sent while it was working).
    The TUI's own affordance: ↑ moves the newest queued message into the input box; backspaces
    empty it. Only the newest queued receipt can go — that is the one ↑ returns. Each step is
    checked on screen before the next; a half-done state is reported, never papered over."""
    if ref['agent'] != 'claude-code':
        raise Rejected('只有 Claude Code 的排队消息能撤回。')
    with closing(connect(d)) as db:
        row = db.execute('SELECT id,text,state,created FROM replies WHERE id=? AND sid=? AND agent=?', (receipt_id, ref['session_id'], ref['agent'])).fetchone()
        newest = db.execute("SELECT id FROM replies WHERE sid=? AND agent=? AND state='accepted' ORDER BY created DESC LIMIT 1", (ref['session_id'], ref['agent'])).fetchone()
    if not row or row['state'] != 'accepted':
        raise Rejected('这条不在排队中了。')
    if not newest or newest['id'] != receipt_id:
        raise Rejected('只能撤回最后排队的那条（Claude Code 的 ↑ 只取最后一条）。')
    text = row['text']
    pane = herdr_target(d, ref, require_idle=False, allow_blocked=True)
    pid = pane['pane_id']
    screen = lambda: (d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True) or '')
    if QUEUE_HINT not in screen():
        raise Rejected('原终端上没有排队中的消息（可能已经开始处理了），刷新看看。')
    d.herdr(None, ['agent', 'send-keys', pid, 'up'])
    time.sleep(1.2)
    probe = re.sub(r'\s+', '', text)[:12]
    if probe not in re.sub(r'\s+', '', screen()):
        raise Rejected('按了 ↑ 但输入框里不是这条，没有动它；看一下原终端。')
    for _ in range(len(text) + 4):
        d.herdr(None, ['agent', 'send-keys', pid, 'backspace'])
    time.sleep(1.0)
    if probe in re.sub(r'\s+', '', screen()):
        raise Rejected('这条已经回到原终端的输入框，但没能清空；去电脑上删掉它。')
    with closing(connect(d)) as db, db:
        db.execute("UPDATE replies SET state='failed', note='已撤回' WHERE id=?", (receipt_id,))
    return dict(state='accepted', note='已撤回', text=text)


def control(d, ref, payload):
    """Switch the permission mode (Shift+Tab cycles: default → acceptEdits → plan → bypass) or
    the model (/model <alias>, confirming the cache warning) of a Claude Code terminal session.
    For a Codex desktop session: approvals, answers and interrupts over its IPC."""
    if ref['agent'] == 'codex' and (payload.get('interrupt') or payload.get('request_id')):
        return desktop_control(d, ref, payload)
    if payload.get('keys'):
        return press_keys(d, ref, payload['keys'])
    if payload.get('withdraw'):
        return withdraw(d, ref, payload['withdraw'])
    if ref['agent'] != 'claude-code':
        raise Rejected('只有 Claude Code 的会话能在这里切模式和模型。')
    pane = herdr_target(d, ref, require_idle=False)
    pid = pane['pane_id']
    want_mode, want_model = payload.get('mode'), (payload.get('model') or '').strip()
    if want_mode:
        if want_mode not in MODE_ORDER:
            raise Rejected('未知的模式。')
        for _ in range(len(MODE_ORDER) + 1):
            cur = tui_state(d, pid).get('mode')
            if cur == want_mode:
                return dict(state='accepted', note='模式已切换', **tui_state(d, pid))
            d.herdr(None, ['pane', 'send-text', pid, '\x1b[Z'])  # Shift+Tab as the terminal sends it
            time.sleep(1.0)
        return dict(state='unknown', note='按了 Shift+Tab 但没读到目标模式（这个模式可能没开放），看一下原终端。', **tui_state(d, pid))
    if want_model:
        if not re.fullmatch(r'[\w.\-\[\]]{2,60}', want_model):
            raise Rejected('模型名不合法。')
        if pane.get('busy'):
            raise Rejected('Agent 正在执行，等本轮结束再切模型。')
        r = d.herdr(None, ['agent', 'prompt', pid, f'/model {want_model}'], timeout=15)
        if r.get('error'):
            raise Rejected('终端没接受命令，请重新连接。')
        time.sleep(2.0)
        t = pane_tail(d, pid)
        if 'Yes, switch' in t or 'switch to' in t:
            d.herdr(None, ['pane', 'send-keys', pid, '1']); time.sleep(1.5)
        st = tui_state(d, pid)
        return dict(state='accepted' if st.get('model') else 'unknown', note='模型已切换' if st.get('model') else '没读到状态行，看一下原终端。', **st)
    raise Rejected('没有要切换的内容。')


PICKER_MARKS = ('Esc to cancel', 'Chat about this', 'Review your answers', 'Ready to submit', '✔ Submit', '❯ 1.')


def answer(d, ref, payload):
    if ref['agent'] != 'claude-code':
        raise Rejected('只有 Claude Code 的选择题能在这里作答。')
    questions = payload.get('questions') or []
    answers = payload.get('answers') or []
    if not questions or len(answers) != len(questions):
        raise Rejected('答案和问题数量不一致，请刷新后重试。')
    pane = herdr_target(d, ref, require_idle=False, allow_blocked=True)  # Herdr reports the picker as blocked
    pid = pane['pane_id']
    # While the picker is up Herdr calls the pane blocked and only serves the visible screen —
    # and that capture can stop short of the bottom, so the checks below are lenient.
    visible = lambda: d.herdr(None, ['agent', 'read', pid, '--source', 'visible'], raw=True) or ''
    tail = lambda: '\n'.join(visible().splitlines()[-20:])
    screen = visible()
    if not (any(m in screen for m in PICKER_MARKS) or any(str(q.get('question', ''))[:12] in screen for q in questions)):
        raise Rejected('原终端上现在没有这道题（可能已经答过或被取消），刷新看看。')
    keys = lambda *ks: d.herdr(None, ['agent', 'send-keys', pid, *ks])
    for i, (q, a) in enumerate(zip(questions, answers)):
        n = len(q.get('options') or [])
        picks = [int(x) for x in (a.get('picks') or [])]
        other = (a.get('other') or '').strip()
        if other:
            keys(str(n + 1)); time.sleep(0.6)
            r = d.herdr(None, ['agent', 'prompt', pid, other], timeout=15)
            if r.get('error'):
                raise RuntimeError('自定义答案没输进去')
        elif not picks or any(p < 1 or p > n for p in picks):
            raise Rejected(f'第 {i + 1} 题没有选择。')
        elif q.get('multiSelect'):
            for p in picks:
                keys(str(p)); time.sleep(0.4)
            keys('right')
        else:
            keys(str(picks[0]))
        time.sleep(0.8)
    # One single-choice question submits by itself; anything else lands on a review screen.
    for _ in range(8):
        t = tail()
        if 'Review your answers' in t or 'Ready to submit' in t:
            keys('1'); time.sleep(1.2)
            continue
        if 'User answered' in t or not any(m in t for m in PICKER_MARKS):
            return dict(state='accepted', note='答案已提交，Agent 继续了')
        time.sleep(1.0)
    return dict(state='unknown', note='按键发过去了，但没确认对话框已关闭；看一下原终端。')


def command(d, a):
    ref = exact_ref(d, a.key, a.agent)
    if a.op == 'status':
        result = status(d, ref)
    elif a.op == 'commands':
        result = commands(d, ref)
    elif a.op == 'control':
        import sys
        try:
            result = control(d, ref, json.loads(sys.stdin.read() or '{}'))
        except Rejected as e:
            result = dict(state='failed', note=str(e))
    elif a.op == 'revive':
        import sys
        try:
            result = revive(d, ref, json.loads(sys.stdin.read() or '{}'))
        except Rejected as e:
            result = dict(state='failed', message=str(e))
    elif a.op == 'answer':
        import sys
        try:
            result = answer(d, ref, json.loads(sys.stdin.read() or '{}'))
        except Rejected as e:
            result = dict(state='failed', note=str(e))
        except Exception:
            result = dict(state='unknown', note='按键没能全部发出去，看一下原终端再决定要不要重答。')
    else:
        import sys
        text = sys.stdin.read(16001)
        result = submit(d, ref, text, a.request, mode=getattr(a, 'mode', 'queue') or 'queue', images=getattr(a, 'image', None) or [])
    d.out(result, a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))
