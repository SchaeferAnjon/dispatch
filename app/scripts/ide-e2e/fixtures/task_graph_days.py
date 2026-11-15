"""The Task graph's sliding-axis scenario's world (scenarios/task-graph-scroll.mjs: meta.instance.fixture "task-graph-days"):
the demo project's board with 51 tasks in 8 things over the last 26 days, written before the app starts. Some days are
busy (one with nine tasks from morning to night), some empty; a few tasks are in progress or still to do; some titles are
long (the right-hand column must show them whole). Nothing is sent to a model."""
import datetime, json, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'cli'))
import ide_e2e as E

# (thing, [(days ago, hour or None for "a bit ago today", title), …])
PLAN = [
    ('Graph scrolling', [(25, 10, 'Read how the Projects timeline draws its axis'), (24, 15, 'Sketch the day-by-day axis'), (19, 11, 'Pick the easing for opening a day'),
                          (16, 9, 'Axis module with pure functions and tests'), (16, 14, 'Wire the axis into the Task graph page'), (9, 9, 'Wheel and drag move the focus'),
                          (9, 10, 'Glide to the nearest day when the movement stops'), (9, 13, 'Cross-fade a day\'s mark into its hours'), (9, 14, 'Keyboard: arrows move one day'),
                          (9, 15, 'Frame time under 16 ms on 364 tasks'), (9, 16, 'Reduced motion jumps instead of gliding'), (9, 22, 'Review the page at 900 and 1440 wide'),
                          (3, 11, 'Right column wide enough for a whole title'), (0, None, 'Check the sliding page the way a person uses it')]),
    ('Billing export', [(22, 10, 'Export invoices as CSV'), (22, 16, 'Fix the rounding of tax in the export'), (21, 9, 'Add a column for the cost centre'), (20, 14, 'Send the first export to accounting'),
                         (18, 11, 'Accounting wants the export monthly: schedule it')]),
    ('Onboarding tour', [(14, 10, 'List the six places a new user gets lost'), (13, 15, 'Draw the first tip bubble'), (12, 9, 'Tips close on Escape and on click'), (11, 12, 'Do not show tips twice'),
                          (9, 11, 'Tour state survives a restart'), (6, 10, 'Tour copy review'), (5, 16, 'Tour works in a narrow window'), (1, 14, 'Tour: skip all button')]),
    ('Mobile pairing', [(12, 9, 'QR code for pairing'), (12, 11, 'Pairing expires after five minutes'), (11, 15, 'Show the paired phone in Settings'), (6, 13, 'Unpair from the phone'), (5, 10, 'Pairing over the local network only')]),
    ('Docs search', [(8, 10, 'Index the docs folder'), (8, 14, 'Search results show the matching line'), (7, 11, 'Open a result at the line'), (7, 15, 'Search stays fast with 5,000 docs')]),
    ('Release notes', [(4, 10, 'Collect the changes since 0.9.1'), (3, 14, 'Write the notes in plain words'), (3, 16, 'Screenshots for the notes'), (2, 10, 'Release notes page in What\'s new'), (0, None, 'Proofread the release notes before publishing them to every user of the app')]),
    ('Fix flaky e2e', [(2, 9, 'First-run scenario fails one time in five'), (2, 12, 'The tip covers the button: close tips before clicking'), (1, 10, 'Wait for the graph to draw before the hover'), (0, None, 'Run the suite twice on the mini')]),
    ('Design tokens', [(20, 14, 'Stone palette to CSS variables'), (10, 11, 'Dark mode contrast check'), (10, 15, 'Radius scale: small, medium, large'), (7, 9, 'Focus ring colour'), (4, 13, 'Motion tokens: ease-std and the durations'),
                        (0, None, 'Name the spacing scale')]),
]
OPEN = {'Check the sliding page the way a person uses it': 'in_progress', 'Run the suite twice on the mini': 'in_progress', 'Name the spacing scale': 'open',
        'Proofread the release notes before publishing them to every user of the app': 'open', 'Tour: skip all button': 'in_progress'}


def prepare(rec):
    env = E.instance_env(rec)
    folder = Path(rec['folder']).resolve()
    assert folder.name == 'demo' and folder.is_relative_to(Path(rec['root']).resolve()), 'the instance\'s own demo project'
    folder.mkdir(parents=True, exist_ok=True)

    def run(argv, inp=None):
        p = subprocess.run(argv, cwd=folder, env=env, input=inp, text=True, capture_output=True, timeout=120)
        if p.returncode:
            raise RuntimeError(p.stderr[-2000:] + p.stdout[-2000:])
        return p.stdout

    def d(*args):
        return run([sys.executable, rec['cli'], *args])
    if not (folder / '.git').exists():
        run(['git', 'init', '-q'])
        (folder / 'README.md').write_text('# Task graph demo\n')
        run(['git', 'add', 'README.md'])
        run(['git', '-c', 'user.name=Dispatch e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qm', 'docs: demo project'])
    if not (Path(rec['beads_dir']) / 'config.yaml').exists():
        Path(rec['beads_dir']).mkdir(parents=True, exist_ok=True)
        run(['bd', 'init', '--prefix', 'task', '--non-interactive', '--quiet', '--skip-agents', '--skip-hooks'])
    run([sys.executable, rec['cli'], 'settings', '--save', '--json'], json.dumps({**{k: 0 for k in E.NOTIFY_SETTINGS}, 'workspace_roots': [str(folder.parent)]}))
    d('projects-view', 'add', str(folder), '--name', 'demo', '--json')
    now = time.time()
    midnight = datetime.datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
    issues, n = [], 0
    for thing, tasks in PLAN:
        prev = None
        for days, hour, title in tasks:
            n += 1
            if hour is None:   # today: a while ago, but after midnight
                t = max(midnight.timestamp() + 600, now - (20 + 25 * n % 60) * 60)
            else:
                t = (midnight - datetime.timedelta(days=days)).replace(hour=hour, minute=(7 * n) % 50).timestamp()
            tid = 'task-gd%02d' % n
            status = OPEN.get(title, 'closed')
            row = {'id': tid, 'title': title, 'status': status, '_type': 'issue', 'issue_type': 'task', 'priority': 2, 'assignee': 'codex', 'created_by': 'codex',
                   'created_at': iso(t), 'updated_at': iso(min(now, t + 1800)), 'labels': ['project:demo', 'session-origin:graph-days-session'],
                   'metadata': {'thing': thing, **({'from': prev} if prev else {})}}
            if status == 'closed':
                row['closed_at'] = iso(min(now, t + 1800))
            issues.append(row)
            prev = tid
    run(['bd', 'import', '-i', '-'], ''.join(json.dumps(t) + '\n' for t in issues))
    graph = json.loads(d('task', 'graph', '-P', 'demo', '--json'))
    assert len(graph['nodes']) >= 50, 'the board has the tasks'
    return {'record': {'graph_tasks': len(graph['nodes']), 'graph_things': len(graph.get('things', []))}}
