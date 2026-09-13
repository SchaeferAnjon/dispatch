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
import time
import uuid
from contextlib import closing


class Rejected(Exception):
    """Known not to have submitted input."""


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

    def request(self, method, params, owner=None, version=1):
        rid = str(uuid.uuid4())
        payload = dict(type='request', requestId=rid, sourceClientId=self.client,
                       method=method, params=params, version=version, timeoutMs=6000)
        if owner:
            payload['targetClientId'] = owner
        raw = json.dumps(payload).encode()
        self.sock.sendall(struct.pack('<I', len(raw)) + raw)
        deadline = time.monotonic() + 9
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
        r = self.request('thread-owner-discovery', {'hostId': 'local', 'conversationId': sid})
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
    rec = next((r for r in records if r.get('session_id') == ref['session_id'] and r.get('agent') == ref['agent']), None)
    if not rec or not rec.get('agent_pid'):
        raise Rejected('这个终端会话未连接。请在电脑上恢复原会话后重新连接。')
    pid = rec['agent_pid']
    if any(r.get('agent_pid') == pid and r.get('session_id') != ref['session_id'] and r.get('last_at', 0) >= rec.get('last_at', 0) for r in records):
        raise Rejected('原终端已切换到另一个会话，请重新打开当前会话。')
    family = {'claude-code': 'claude', 'pi': 'pi', 'codex': 'codex'}.get(ref['agent'])
    for pane in d.herdr_agents():
        if pane.get('agent') != family:
            continue
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


def target(d, ref):
    if ref['agent'] == 'codex' and os.path.exists(os.path.join(d.HOME, '.codex', 'ipc', 'ipc.sock')):
        try:
            herdr_target(d, ref, require_idle=False)
        except Rejected:
            pass
        else:
            return {'kind': 'herdr', 'pane': herdr_target(d, ref), 'label': '回复到电脑上的原 Codex 会话'}
        with closing(DesktopIPC(d.HOME)) as ipc:
            owner = ipc.owner(ref['session_id'])
            try:
                desktop = desktop_state(ipc.snapshot(ref['session_id'], owner))
            except Exception:
                desktop = None
        return {'kind': 'codex-desktop', 'label': '回复到原 Codex 会话', 'working': bool(desktop and desktop['running']), 'desktop': desktop}
    if ref['agent'] in ('claude-code', 'pi', 'codex'):
        # A working agent can still take a message: the TUIs queue typed input for the next turn,
        # and Esc interrupts the current one — the app offers both.
        pane = herdr_target(d, ref, require_idle=False)
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
    try:
        t = target(d, ref)
        extra = tui_state(d, t['pane']['pane_id']) if t['kind'] == 'herdr' and ref['agent'] == 'claude-code' else {}
        return dict(available=True, label=t['label'], working=bool(t.get('working')), receipts=receipts, **({'desktop': t['desktop']} if t.get('desktop') else {}), **extra)
    except Exception as e:
        return dict(available=False, label=str(e) if isinstance(e, Rejected) else '暂时无法连接原 Agent，请重新连接。', receipts=receipts)


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
        attach = bool(images) and t['kind'] == 'herdr' and ref['agent'] == 'claude-code'
        wire = text if attach else with_images(text, images)
        db.execute('INSERT INTO replies VALUES (?,?,?,?,?,?,?,?)', (request_id, ref['session_id'], ref['agent'], digest, with_images(text, images) if not attach else text, 'sending', '正在发送', time.time()))
    state, note = 'accepted', ''
    try:
        if t['kind'] == 'codex-desktop':
            with closing(DesktopIPC(d.HOME)) as ipc:
                note = ipc.send(ref, wire, request_id)
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
            note = ('已打断并送达，Agent 会先处理这条' if mode == 'interrupt' else '已排队，本轮结束后 Agent 就会看到') if busy else '已送达原终端会话'
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


def control(d, ref, payload):
    """Switch the permission mode (Shift+Tab cycles: default → acceptEdits → plan → bypass) or
    the model (/model <alias>, confirming the cache warning) of a Claude Code terminal session.
    For a Codex desktop session: approvals, answers and interrupts over its IPC."""
    if ref['agent'] == 'codex' and (payload.get('interrupt') or payload.get('request_id')):
        return desktop_control(d, ref, payload)
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
