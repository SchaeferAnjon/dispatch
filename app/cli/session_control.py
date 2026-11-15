# -*- coding: utf-8 -*-
"""`dispatch session-control`: the folder picker of the new-conversation dialogs (`browse`) and
「接管到 Dispatch」 (`release`: stop the idle terminal process holding a conversation, so the in-app
chat can resume it without a second writer). Transport routing stays in dispatch --host.
"""
import json
import os
import sys
sys.dont_write_bytecode = True  # never write __pycache__ next to these files: inside Dispatch.app that breaks the code signature
import tempfile
import time

import dplatform as P
from lang import t as _t
from session_reply import Rejected, exact_ref


def directory(d, path):
    if not isinstance(path, str) or '\0' in path:
        raise Rejected(_t('Choose a valid folder.', '请选择有效的文件夹。'))
    path = d.HOME + path[1:] if path == '~' or path.startswith(('~/', '~\\') if P.IS_WIN else '~/') else path
    if not os.path.isabs(path):
        raise Rejected(_t('Type the whole path of the folder, or pick one from the list.', '请输入完整的文件夹路径，或从列表选择。'))
    path = os.path.realpath(path)
    if not os.path.isdir(path):
        raise Rejected(_t('That folder does not exist. Choose another.', '这个文件夹不存在，请重新选择。'))
    return path


# Temp and scratch directories are where agents work, not where you start a conversation.
NOISE = ('/private/tmp', '/tmp', '/var/folders')
WIN_HIDDEN = 0x2 | 0x4  # FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM


def noise_dir(d, p):
    if P.IS_WIN:
        roots = (tempfile.gettempdir(), os.path.join(d.HOME, 'Documents', 'Codex'))
        q = P.norm_path(p).replace('\\', '/')
        return any(P.is_under(p, r) for r in roots) or '/scratchpad' in q or '/.cache/' in q
    return p.startswith(NOISE + (os.path.join(d.HOME, 'Documents/Codex'),)) or '/scratchpad' in p or '/.cache/' in p


def hidden_entry(x):
    """Dot folders everywhere; on Windows also folders marked hidden or system (AppData, $Recycle.Bin)."""
    if x.name.startswith('.'):
        return True
    if P.IS_WIN:
        try:
            return bool(getattr(x.stat(follow_symlinks=False), 'st_file_attributes', 0) & WIN_HIDDEN)
        except OSError:
            return True
    return False


def browse(d, path):
    path = directory(d, path or d.HOME)
    try:
        with os.scandir(path) as it:
            children = sorted([{'name': x.name, 'path': x.path} for x in it
                               if not hidden_entry(x) and x.is_dir()], key=lambda x: x['name'].casefold())
    except OSError:
        raise Rejected(_t('Dispatch cannot read this folder. Check the Mac\'s file access settings for it.', '无法读取这个文件夹，请检查电脑上的文件访问权限。'))
    recent = sorted(d.load_index().values(), key=lambda x: x.get('mtime', 0), reverse=True)
    paths = list(dict.fromkeys(x.get('cwd') for x in recent if x.get('cwd') and os.path.isdir(x['cwd']) and not noise_dir(d, x['cwd'])))[:12]
    out = dict(path=path, parent=os.path.dirname(path), children=children[:300], truncated=len(children)>300, recent=paths)
    if P.IS_WIN:  # the app gets forward slashes (C:/Users/x/proj) and sends them back to directory()
        out.update(path=P.to_slash(out['path']), parent=P.to_slash(out['parent']), recent=[P.to_slash(p) for p in paths],
                   children=[dict(c, path=P.to_slash(c['path'])) for c in out['children']])
    return out


def stop_process(d, agent, sid, pid):
    """Stop the terminal process holding a transcript (two processes on one transcript interleave
    their writes), wait up to 10 s, then drop its hook record. Returns True; Rejected otherwise."""
    if P.IS_WIN:
        # TerminateProcess; callers only get here for an idle session, so no turn is cut off.
        if not P.terminate(int(pid)) and P.pid_alive(int(pid)):
            raise Rejected(_t('That process cannot be stopped (it may belong to another user or run as administrator). Quit the agent in its terminal, then take it over.', '那个进程停不掉（可能属于别的用户或以管理员身份运行）；在它的终端里退出 Agent 后再接。'))
    else:
        import signal
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise Rejected(_t('That process belongs to another user and cannot be stopped. Ask them to quit it, then take it over.', '那个进程属于别的用户，停不掉；让对方自己退出后再接。'))
        except OSError as e:
            raise Rejected(_t(f'That process could not be stopped ({e.strerror or e}). Quit the agent in its terminal, then take it over.', f'停不掉那个进程（{e.strerror or e}）；在它的终端里退出 Agent 后再接。'))
    stopped = False
    for _ in range(40):
        if int(pid) not in d.ps_table():
            stopped = True
            break
        time.sleep(0.25)
    if not stopped:
        raise Rejected(_t('The process did not quit within 10 seconds and was left alone. Quit the agent in that terminal, then try again.', '原进程 10 秒内没有退出，没有动它；在那个终端里退出 Agent 后再接一次。'))
    # Its hook record is stale now; the next process will register itself.
    for path in (os.path.join(d.SESS_DIR, f'{agent}__{sid}.json'), os.path.join(d.SESS_DIR, f'{agent}__pid-{pid}.json')):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    return True


def chat_held_pids(d):
    """Agent processes Dispatch's own chat sidecar runs (chatd.json, while chatd is alive)."""
    try:
        from chatd import read_registry
        reg = read_registry(d.DISPATCH_DIR) or {}
    except Exception:
        return set()
    return {v.get('pid') for v in (reg.get('sessions') or {}).values() if isinstance(v, dict) and v.get('pid')}


def release(d, data):
    """Terminal → Dispatch: stop the idle terminal process that holds this conversation so the
    in-app chat can resume it (`chatd open {resume}`) without a second writer. Nothing is started
    here. A working session is refused unless `force`; one not running anywhere is already free."""
    sid, agent = data.get('session_id', ''), data.get('agent', '')
    import engines
    takers = [e for e in engines.runnable() if e.chat_takes_terminal]
    if agent not in [e.agent for e in takers] or not sid:
        raise Rejected(_t(f'Only {engines.join_words([e.name for e in takers], "and")} conversations can be taken over into Dispatch.', f'只有 {engines.join_words([e.name for e in takers], "和")} 会话能接到 Dispatch 里。'))
    try:
        exact_ref(d, sid, agent)
    except Rejected:
        d.refresh_index()
        exact_ref(d, sid, agent)
    held = chat_held_pids(d)
    live = [s for s in d.live_sessions(local_only=True)
            if s.get('session_id') == sid and s.get('agent', agent) == agent and s.get('agent_pid') and s.get('agent_pid') not in held]
    if not live:
        return dict(state='released', stopped_pid=None, message=_t('It is not running in a terminal: go on with it in Dispatch.', '它没在终端里跑，可以直接在 Dispatch 里接着聊。'))
    s = live[0]
    if s.get('state') == 'working' and not data.get('force'):
        raise Rejected(_t('It is working right now. Take it over once it stops.', '它正在跑，等它停下来再接'))
    pid = s['agent_pid']
    stop_process(d, agent, sid, pid)
    where = s.get('source_app') or _t('the terminal', '终端')
    return dict(state='released', stopped_pid=pid, message=_t(f'Stopped the process in {where}: go on with it in Dispatch.', f'已停掉 {where} 里的进程，可以在 Dispatch 里接着聊。'))


def branch(d, path):
    """The git branch a folder is on, for the line under the reply box (「main」); '' outside a repo or on a detached HEAD."""
    import subprocess
    path = directory(d, path or d.HOME)
    try:
        r = subprocess.run(['git', '-C', path, 'symbolic-ref', '--short', '-q', 'HEAD'], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return dict(path=P.to_slash(path) if P.IS_WIN else path, branch='')
    name = r.stdout.strip() if r.returncode == 0 else ''
    return dict(path=P.to_slash(path) if P.IS_WIN else path, branch=name)


def command(d, a):
    try:
        data = json.loads(sys.stdin.read() or '{}')
        r = browse(d, data.get('path')) if a.op == 'browse' else branch(d, data.get('path')) if a.op == 'branch' else release(d, data)
        print(json.dumps(r, ensure_ascii=False))
    except (Rejected, ValueError) as e:
        raise SystemExit(str(e))
