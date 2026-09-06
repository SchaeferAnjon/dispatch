"""Exact-session reply adapters and durable, idempotent delivery receipts.

Codex Desktop: local IPC owner discovery + follower API (versioned; fail closed).
Herdr: registered session PID must belong to the live pane, never match by cwd.
No new model process, account, or internet-facing listener is created here.
"""
import hashlib
import json
import os
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


def exact_ref(d, sid, agent):
    # Do not use resolve(), which deliberately accepts task IDs and ID prefixes.
    matches = [(path, e) for path, e in d.load_index().items()
               if e.get('session_id') == sid and e.get('agent') == agent and not e.get('subagent')]
    if not matches:
        raise Rejected('这台电脑找不到这个会话，请刷新后重新选择。')
    path, entry = max(matches, key=lambda pair: pair[1].get('mtime', 0))
    return dict(entry, path=path)


def herdr_target(d, ref):
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
        if pane.get('agent_status') not in ('idle', 'done'):
            reason = '原会话正在等待权限确认，请打开电脑屏幕处理。' if pane.get('agent_status') == 'blocked' else 'Agent 正在执行，请等本轮结束后发送。'
            raise Rejected(reason)
        return pane
    raise Rejected('无法确认原会话所在的终端。请在电脑上恢复原会话后重新连接。')


def target(d, ref):
    if ref['agent'] == 'codex' and os.path.exists(os.path.join(d.HOME, '.codex', 'ipc', 'ipc.sock')):
        with closing(DesktopIPC(d.HOME)) as ipc:
            ipc.owner(ref['session_id'])
        return {'kind': 'codex-desktop', 'label': '回复到原 Codex 会话'}
    if ref['agent'] in ('claude-code', 'pi', 'codex'):
        pane = herdr_target(d, ref)
        return {'kind': 'herdr', 'pane': pane, 'label': '回复到电脑上的原会话'}
    raise Rejected('此 Agent 暂未提供直接回复接口。可打开电脑屏幕继续对话。')


def connect(d):
    os.makedirs(d.DISPATCH_DIR, exist_ok=True)
    path = os.path.join(d.DISPATCH_DIR, 'reply-receipts.sqlite')
    db = sqlite3.connect(path, timeout=10)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, sid TEXT, agent TEXT, digest TEXT, text TEXT, state TEXT, note TEXT, created REAL)')
    return db


def status(d, ref):
    with closing(connect(d)) as db, db:
        pending = db.execute("SELECT * FROM replies WHERE sid=? AND agent=? AND state IN ('sending','unknown')", (ref['session_id'], ref['agent'])).fetchall()
        if pending:
            messages = d.read_session_detail(d.ref_of(ref['path'], ref))['messages']
            from datetime import datetime
            for receipt in pending:
                found = False
                for m in messages:
                    try:
                        stamp = datetime.fromisoformat(m.get('ts', '').replace('Z', '+00:00')).timestamp()
                    except ValueError:
                        continue
                    if m['role'] == 'user' and m['text'].strip() == receipt['text'].strip() and stamp >= receipt['created'] - 10:
                        found = True
                if found:
                    db.execute("UPDATE replies SET state='accepted',note='已在原会话确认收到' WHERE id=?", (receipt['id'],))
                elif receipt['state'] == 'sending' and time.time() - receipt['created'] > 45:
                    db.execute("UPDATE replies SET state='unknown',note='未确认送达，请先查看原会话。' WHERE id=?", (receipt['id'],))
        receipts = [dict(r) for r in db.execute('SELECT id,text,state,note,created FROM replies WHERE sid=? AND agent=? ORDER BY created DESC LIMIT 10', (ref['session_id'], ref['agent']))]
    try:
        t = target(d, ref)
        return dict(available=True, label=t['label'], receipts=receipts)
    except Exception as e:
        return dict(available=False, label=str(e) if isinstance(e, Rejected) else '暂时无法连接原 Agent，请重新连接。', receipts=receipts)


def submit(d, ref, text, request_id):
    if not text.strip() or len(text) > 16000:
        raise Rejected('请输入回复，最多 16000 字。')
    try:
        uuid.UUID(request_id)
    except (ValueError, TypeError):
        raise Rejected('无效的消息编号，请刷新页面。')
    digest = hashlib.sha256((ref['agent'] + '\0' + ref['session_id'] + '\0' + text).encode()).hexdigest()
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
        db.execute('INSERT INTO replies VALUES (?,?,?,?,?,?,?,?)', (request_id, ref['session_id'], ref['agent'], digest, text, 'sending', '正在发送', time.time()))
    state, note = 'accepted', ''
    try:
        if t['kind'] == 'codex-desktop':
            with closing(DesktopIPC(d.HOME)) as ipc:
                note = ipc.send(ref, text, request_id)
        else:
            pane = herdr_target(d, ref)
            focus = d.herdr(None, ['tab', 'focus', pane['tab_id']])
            if focus.get('error'):
                raise Rejected('无法连接原终端，消息未发送。')
            # Focusing cannot select the target: it must still match the same PID.
            check = herdr_target(d, ref)
            if check['pane_id'] != pane['pane_id']:
                raise Rejected('会话位置发生变化，消息未发送，请重试。')
            result = d.herdr(None, ['agent', 'prompt', pane['pane_id'], text], timeout=15)
            if result.get('error'):
                err = result['error']
                if err.get('code') in ('agent_blocked', 'agent_pane_busy', 'agent_not_found'):
                    raise Rejected('Agent 当前无法接收回复，消息未发送，请重新连接。')
                raise RuntimeError('终端未确认收到消息')
            if 'result' not in result:
                raise RuntimeError('终端未确认收到消息')
            note = '已送达原终端会话'
    except Rejected as e:
        state, note = 'failed', str(e)
    except Exception:
        state, note = 'unknown', '暂时无法确认是否送达，请先查看最新对话，避免重复发送。'
    with closing(connect(d)) as db, db:
        db.execute('UPDATE replies SET state=?,note=? WHERE id=?', (state, note, request_id))
        return dict(db.execute('SELECT * FROM replies WHERE id=?', (request_id,)).fetchone())


def command(d, a):
    ref = exact_ref(d, a.key, a.agent)
    if a.op == 'status':
        result = status(d, ref)
    else:
        import sys
        text = sys.stdin.read(16001)
        result = submit(d, ref, text, a.request)
    d.out(result, a.json, lambda x: print(json.dumps(x, ensure_ascii=False)))
