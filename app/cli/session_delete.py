# -*- coding: utf-8 -*-
"""`dispatch session-delete <agent:id>`: move one conversation's transcript to the Trash and forget it.

Refused while it works or a terminal process holds it. An idle conversation Dispatch's chatd holds is
closed first. Files go to the Trash (never deleted), so Finder can put them back; then the index
entry, preferences, read receipts and parsed-stream cache rows go, so no list shows it again.
"""
import os
import shutil
import subprocess
import sys
from contextlib import closing
from lang import t as _t


def agents():
    """The engines whose conversations can go to the Trash: the ones whose transcript files Dispatch can find."""
    import engines
    return tuple(e.agent for e in engines.known() if e.supports('transcript_of'))


class Rejected(Exception):
    pass


def trash(paths):
    """Move to the user's Trash: /usr/bin/trash (macOS 15+), else Finder."""
    if sys.platform != 'darwin':
        raise Rejected(_t('Conversations can only be deleted on a Mac.', '只有 Mac 上能删除会话。'))
    if shutil.which('trash') == '/usr/bin/trash':
        r = subprocess.run(['/usr/bin/trash', '-s', *paths], capture_output=True, text=True, timeout=60)
    else:
        items = ', '.join('POSIX file "%s"' % p.replace('\\', '\\\\').replace('"', '\\"') for p in paths)
        r = subprocess.run(['osascript', '-e', f'tell application "Finder" to delete {{{items}}}'], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise Rejected(_t(f'Could not move it to the Trash: {(r.stderr or r.stdout).strip()[:200]}', f'移到废纸篓失败：{(r.stderr or r.stdout).strip()[:200]}'))


def files_of(d, agent, sid, idx):
    """The transcript(s) and the folder next to one that belongs to it (Claude's sub-agents and tool results)."""
    import engines
    eng = engines.get(agent)
    paths = [p for p, e in idx.items() if e.get('agent') == agent and e.get('session_id') == sid and not e.get('subagent')]
    if not paths:  # not indexed yet
        paths = eng.transcript_of(sid, d.HOME) or []
    out = [p for p in paths if os.path.exists(p)]
    out += [side for side in (eng.side_folder(p, sid) for p in out) if side and os.path.isdir(side)]
    return out


def check_free(d, agent, sid, key):
    """Refuse a working conversation or one a terminal holds; close it in chatd when chatd holds it idle."""
    import activity, session_control
    held = activity.chat_held(d.DISPATCH_DIR)
    chat_pids = session_control.chat_held_pids(d)
    if any(s.get('session_id') == sid and s.get('agent') == agent and s.get('agent_pid') not in chat_pids
           for s in d.live_sessions(local_only=True)):
        raise Rejected(_t('This conversation is still open in a terminal: quit it there first, then delete it.', '这段会话还开在终端里：先在终端里退出它再删除。'))
    if key not in held:
        return
    import chat_client
    with chat_client.ChatClient.connect(d.DISPATCH_DIR) as c:
        st = next((r for r in c.request('list')['sessions'] if r['session'] == key), None)
        if st is None:
            return
        if st.get('lifecycle') not in ('idle', 'stopped', 'error'):
            raise Rejected(_t('The agent is working or waiting for your OK: stop it first, then delete it.', 'Agent 正在执行或在等你确认：先停下它再删除。'))
        c.request('close', session=key, timeout=30)


def forget(directory, key, sid, paths):
    import activity
    with closing(activity.connect(directory)) as db, db:
        db.execute('DELETE FROM session_preferences WHERE key=?', (key,))
        db.execute('DELETE FROM read_replies WHERE key=?', (key,))
        db.execute('DELETE FROM stream_sids WHERE sid=?', (sid,))
        for p in paths:
            db.execute('DELETE FROM streams WHERE path=?', (p,))


def delete(d, key, move_to_trash=trash):
    agent, _, sid = (key or '').partition(':')
    if not sid or '/' in sid:
        raise Rejected(_t('Not a conversation: write it as <agent>:<conversation id>', '无效的会话标识，要写成 <agent>:<会话 ID>'))
    if agent not in agents():
        raise Rejected(_t('Only Claude Code and Codex conversations can be deleted.', '只能删除 Claude 和 Codex 的会话。'))
    idx = d.load_index()
    paths = files_of(d, agent, sid, idx)
    if not paths:
        raise Rejected(_t('This Mac has no record of that conversation.', '这台电脑上找不到这段会话的记录。'))
    check_free(d, agent, sid, key)
    move_to_trash(paths)
    gone = set(paths)
    left = {p: e for p, e in idx.items() if not (p in gone or any(p.startswith(g + os.sep) for g in gone)
                                                  or (e.get('agent') == agent and e.get('session_id') == sid))}
    if len(left) != len(idx):
        d.save_index(left)
    forget(d.DISPATCH_DIR, key, sid, [p for p in idx if p not in left] + paths)
    return {'ok': True, 'key': key, 'trashed': paths}


def command(d, a):
    try:
        res = delete(d, a.key)
    except Rejected as e:
        raise SystemExit(str(e))
    d.out(res, a.json, lambda r: print(_t(f"Deleted: {len(r['trashed'])} files moved to the Trash", f"已删除，{len(r['trashed'])} 个文件移到了废纸篓")))
