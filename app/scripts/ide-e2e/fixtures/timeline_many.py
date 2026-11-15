"""The Timeline scenario's world (scenarios/timeline-design.mjs: meta.instance.fixture "timeline-many"): a busy day
of the person's own sessions for the Assistant's Timeline tab, written before the app starts. Nothing is sent to a
model and no agent is started.

- Claude Code transcripts in the instance's own Claude folder (CLAUDE_CONFIG_DIR, given to the app through `env`):
  30 sessions over the last 8 hours in four projects under the instance, their work in stretches with breaks between,
  most with a title Claude Code gave them, a few without one (their first message is a long brief with file paths, as
  real ones are); 9 of them started helpers (sub-agents), one of them six.
- A Turbo run in the demo project at the moment design/frenzy/proto-a.html draws (scene "live"): the same ten parts
  in the same states. It never runs: the run's runner is a stand-in process that only sleeps (`turbo <run id>` in its
  command line, which is what Turbo checks), its agent is OpenCode, and the scenario stops the run and the stand-in at
  the end. `TIMELINE_RUN=0` leaves the run out.
"""
import datetime, json, os, random, subprocess, sys, time, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'cli'))
import ide_e2e as E

PROJECTS = ['kanban', 'notes-site', 'thesis-code', 'demo']

# (project, title Claude Code gave it or None, first message, stretches as (minutes ago it started, minutes long), helpers)
SESSIONS = [
    ('kanban', 'Timeline 泳道按设计稿重做', '按 design/frenzy/proto-a.html 重做 Assistant 的 Timeline 页签，代码在 ide/vscode/src/vs/sessions/contrib/dispatchTurbo/browser/dispatchTimeline.ts，先并排截图再改', [(52, 52)],
     [('Read the prototype lanes', 50, 6), ('Find the lane CSS', 44, 5), ('Check the session index', 38, 9), ('Draft the comparison', 30, 12), ('Build on the mini', 16, 10), ('Screenshot light and dark', 5, 5)]),
    ('kanban', '首页背景和新建页一致', '首页也用新会话页那种渐变底加浮动方块，参考 dispatchAssistantLead.css', [(35, 35)], [('Measure the new session page', 30, 8)]),
    ('kanban', '状态色统一成图标配色', None, [(140, 25), (70, 40)], [('Collect the state colours', 66, 10), ('Compare with the app icon', 52, 8)]),
    ('kanban', 'Home 和 Timeline 同宽', 'Home 和 Timeline 切换时标题和输入框位置不动', [(200, 30), (95, 20)], []),
    ('kanban', '签名重试时间戳服务', '签名时 Apple 时间戳服务没应答就重签', [(300, 45)], [('Read codesign logs', 290, 12)]),
    ('kanban', 'dispatch-update 挑最新构建', None, [(260, 20), (230, 15)], []),
    ('kanban', '向导 Agents 页复审', '向导 Agents 页按 designer 复审改', [(380, 40)], []),
    ('kanban', '首次设置焦点框', None, [(420, 18)], []),
    ('kanban', 'first-run.sh 打 zip 带扩展属性', 'first-run.sh 打 zip 时把扩展属性放进 __MACOSX', [(180, 22)], []),
    ('kanban', '构建队列底栏方块', None, [(330, 25), (150, 10)], []),
    ('kanban', None, '用户真机 0.9.2：Assistant 页的 Timeline 标签很丑，和之前的设计稿不一样，要求「找到之前的设计稿，重新做」。设计依据：design/frenzy/index.html 和 design/frenzy/proto-a.html；代码在 ide/vscode/src/vs/sessions/contrib/dispatchTurbo/dispatchTurboModel.ts', [(25, 25)],
     [('Explore design folders', 22, 7), ('Read DESIGN.md tokens', 15, 6)]),
    ('kanban', '会话历史搜索变慢', None, [(460, 30)], []),
    ('notes-site', 'Blog post layout', 'Make the blog post page use the new two-column layout from notes-site/src/layouts/Post.astro', [(120, 35), (40, 20)], [('Check the RSS output', 36, 6)]),
    ('notes-site', 'Fix the broken image links', None, [(240, 15)], []),
    ('notes-site', 'Dark mode for code blocks', 'Code blocks in dark mode are unreadable: src/styles/code.css', [(310, 25)], []),
    ('notes-site', 'Deploy preview on push', None, [(400, 20)], []),
    ('notes-site', None, 'Write the weekly digest from posts/2026-10-*.md and put it in drafts/digest.md, keep it under 400 words, link every post, and say what changed in the site', [(80, 18)], []),
    ('notes-site', 'Search index for tags', None, [(170, 12)], []),
    ('thesis-code', 'Rerun the ablation table', 'Rerun experiments/ablation.py with seeds 1 to 5 and update tables/ablation.tex', [(220, 80), (60, 60)],
     [('Seed 1 and 2', 215, 30), ('Seed 3 to 5', 180, 40), ('Rebuild the table', 55, 12)]),
    ('thesis-code', 'Plot the loss curves', None, [(130, 30)], []),
    ('thesis-code', 'Chapter 3 citations', 'Check every \\cite in chapters/3-method.tex against refs.bib and fix the missing ones', [(350, 30)], []),
    ('thesis-code', 'Speed up the data loader', None, [(280, 25), (110, 15)], [('Profile the loader', 105, 9)]),
    ('thesis-code', 'Figure 4 colours', None, [(440, 10)], []),
    ('thesis-code', None, 'The training script crashes at epoch 12 with CUDA out of memory, see logs/run-1009.txt; find out why and fix it without changing the batch size', [(15, 15)], []),
    ('demo', 'Rename the demo tasks', None, [(90, 10)], []),
    ('demo', 'README for the demo', 'Write a README for the demo project', [(160, 12)], []),
    ('demo', 'Demo release notes', None, [(250, 8)], []),
    ('demo', 'Try the Turbo switch', None, [(45, 6)], []),
    ('kanban', '交付页图库两列', None, [(205, 16)], []),
    ('notes-site', 'Footer links', None, [(470, 8)], []),
]
WORKING = {0, 1, 10, 12, 23}  # their last line is written by the scenario right before it looks (RUNNING_S is 90 s)

# design/frenzy/proto-a.html, scene "live" (19:15): the parts, their states and when each did what (minutes from the
# run's start at 18:10, which here is 65 minutes ago)
PARTS = [
    (1, '首次安装走查修复', ['onboarding.py', 'init_wizard.py'], [], 'combined', [(0, 18)], 33, 1),
    (2, '首次设置问要不要开 YOLO 模式', ['init_wizard.py', 'defaults.ts'], [1], 'combined', [(36, 62)], 64, 2),
    (3, '添加项目三种方式', ['projects_view.py', 'projects.ts'], [], 'needs', [(0, 35), (35, 65, 'needs')], None, None),
    (4, '内置终端', ['terminal.ts', 'session_control.py'], [], 'working', [(0, 48), (48, 54, 'fix'), (54, 65)], None, None),
    (5, 'Assistant 一图看全会话和任务', ['assistant.py', 'assistant.ts'], [], 'working', [(0, 65)], None, None),
    (6, '新用户先在 Assistant 里问没做完的事', ['assistant.py', 'assistant.ts'], [5], 'waiting', [], None, None),
    (7, '检测并支持所有编程 Agent', ['agents_catalog.py', 'engines.py'], [], 'working', [(33, 65)], None, None),
    (8, '像 Orca 那样用弹窗提示引导用户用功能', ['tours.ts', 'guided-tours.patch'], [], 'working', [(62, 65)], None, None),
    (9, '交接和重启后模型不变', ['chat_life.py', 'chatd.py'], [], 'waiting', [], None, None),
    (10, 'Codex 默认权限下也能跑 dispatch', ['chat_codex.py', 'chat_handoff.py'], [], 'waiting', [], None, None),
]
STEPS = {4: 'Building on the Mac mini and trying it', 5: 'Relaying between two sessions in a test window',
         7: 'Session picker shows only those', 8: 'Tour bubbles anchored to the window'}


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def line(d):
    return json.dumps(d, ensure_ascii=False, separators=(',', ':')) + '\n'


def transcript(path, sid, cwd, first, title, stretches, now, rnd, parent=None):
    """A Claude Code transcript: the first message, then a reply every minute or two inside each stretch of work."""
    rows = []
    start = now - stretches[0][0] * 60
    base = {'cwd': cwd, 'sessionId': parent or sid, 'entrypoint': 'cli', 'version': '2.1.0', 'gitBranch': 'main'}
    rows.append(line({**base, 'type': 'user', 'message': {'role': 'user', 'content': first}, 'timestamp': iso(start), 'uuid': str(uuid.uuid4())}))
    if title:
        rows.append(line({'type': 'ai-title', 'aiTitle': title, 'sessionId': sid}))
    last = start
    for ago, length in stretches:
        t = now - ago * 60
        end = t + length * 60
        while t <= end:
            rows.append(line({**base, 'type': 'assistant', 'message': {'role': 'assistant', 'model': 'claude-opus-5', 'content': [{'type': 'text', 'text': 'Working on it.'}],
                                                                       'usage': {'input_tokens': 10, 'output_tokens': 20}}, 'timestamp': iso(min(t, now)), 'uuid': str(uuid.uuid4())}))
            last = min(t, now)
            t += rnd.uniform(50, 110)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(rows), encoding='utf-8')
    os.utime(path, (last, last))
    return last


def seed_sessions(rec, claude_dir, now):
    rnd = random.Random(1009)
    root = Path(rec['root']).resolve()
    folders = {}
    for name in PROJECTS:
        f = Path(rec['folder']).resolve() if name == 'demo' and rec.get('folder') else root / 'projects' / name
        f.mkdir(parents=True, exist_ok=True)
        if not (f / '.git').exists():
            subprocess.run(['git', 'init', '-q'], cwd=f, check=True, timeout=30)
        folders[name] = str(f)
    working = []
    for i, (proj, title, first, stretches, helpers) in enumerate(SESSIONS):
        cwd = folders[proj]
        sid = str(uuid.UUID(int=rnd.getrandbits(128)))
        pdir = Path(claude_dir) / 'projects' / cwd.replace('/', '-').replace('.', '-')
        path = pdir / (sid + '.jsonl')
        transcript(path, sid, cwd, first or title, title, stretches, now, rnd)
        if i in WORKING:
            working.append(str(path))
        for k, (desc, ago, length) in enumerate(helpers):
            aid = '%016x' % rnd.getrandbits(64)
            hp = pdir / sid / 'subagents' / ('agent-%s.jsonl' % aid)
            brief = ('%s. You are a helper of the main session. Read ide/vscode/src/vs/sessions/contrib/dispatchTurbo/browser/'
                     'dispatchTimeline.ts and app/cli/turbo.py, then report back in under 200 words with file paths and line numbers.') % desc
            transcript(hp, aid, cwd, brief, None, [(ago, length)], now, rnd, parent=sid)
            (hp.parent / ('agent-%s.meta.json' % aid)).write_text(json.dumps({'agentType': 'general-purpose', 'description': desc}), encoding='utf-8')
            if i in WORKING and ago - length <= 1:
                working.append(str(hp))
    return working


def seed_run(rec, env, now):
    """The Turbo run of proto-a's scene "live", in the demo project: written by a child in the instance's environment
    (Turbo keeps runs under the instance's DISPATCH_DIR, which a module imported here would not see)."""
    r = subprocess.run([sys.executable, __file__, '--seed-run', json.dumps({'cli': rec['cli'], 'folder': rec['folder'], 'now': now})],
                       env=env, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(r.stdout.strip().splitlines()[-1])


def _seed_run_here(cli, folder, now):
    sys.path.insert(0, os.path.dirname(cli))
    import dispatch
    import turbo as T
    T.D = dispatch
    run = T.new_run('下一版：新功能全合进来、bug 全修掉，按用户路径验收后装上', folder, 'opencode', title='下一版：新功能全合进来、bug 全修掉，按用户路径验收后装上', slots=4)
    t0 = now - 65 * 60
    m = lambda x: t0 + x * 60
    parts = []
    for n, name, files, after, status, segs, combined_at, combined_n in PARTS:
        p = {'n': n, 'name': name, 'full': name, 'files': files, 'after': after, 'est': 40, 'status': status,
             'segs': [[m(s[0]), m(s[1]), s[2] if len(s) > 2 else 'work'] for s in segs]}
        if segs:
            p['started_at'] = m(segs[0][0])
        if combined_at is not None:
            p.update(combined_at=m(combined_at), combined_n=combined_n, ended_at=m(segs[-1][1]))
        if n in STEPS:
            p.update(said=STEPS[n], said_at=now, launched_at=m(segs[0][0]))
        if status == 'needs':
            p['ask'] = {'question': 'Can I use your GitHub login to test cloning a private repository?', 'options': ['Allow once', 'Skip this check']}
        parts.append(p)
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4 * 3600)', 'turbo', run['id']],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    run.update(state='running', started_at=t0, parts=parts, slots=4, runner={'pid': proc.pid},
               quota={'known': True, 'used': 45, 'resets_at': now + 45 * 60, 'readings': [[t0, 27], [m(30), 34], [now, 45]]})
    T.save(run)
    print(json.dumps({'run': run['id'], 'runner_pid': proc.pid}))


def prepare(rec):
    """`instance start --fixture timeline-many`: the sessions and the run above (the instance's own Claude folder and board)."""
    claude_dir = os.path.join(rec['root'], 'claude-home')
    os.makedirs(claude_dir, exist_ok=True)
    now = time.time()
    working = seed_sessions(rec, claude_dir, now)
    env = dict(E.instance_env(rec), CLAUDE_CONFIG_DIR=claude_dir)
    record = {'timeline_working': working, 'timeline_claude_dir': claude_dir}
    if os.environ.get('TIMELINE_RUN', '1') != '0':
        record.update(seed_run(rec, env, now))
    subprocess.run([sys.executable, rec['cli'], 'index', '--json'], env=env, capture_output=True, timeout=300, check=True)
    return {'env': {'CLAUDE_CONFIG_DIR': claude_dir}, 'record': record}


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--seed-run':
    a = json.loads(sys.argv[2])
    _seed_run_here(a['cli'], a['folder'], a['now'])
