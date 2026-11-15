"""The hover details scenario's world (scenarios/hover-detail.mjs declares it: meta.instance.fixture "hover-detail"):
tasks of every kind on the instance's own board for the demo project, a plan, a delivery with its picture, something
only you can do, a decision, and the transcript index, written before the app starts. Nothing is sent to a model.
`python3 hover-detail.py <instance> --image <png>` still seeds a running instance by hand (the stages that send)."""
import argparse, datetime, json, os, shutil, struct, subprocess, sys, time, zlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'cli'))
import ide_e2e as E
import ide_sessions as I


def png(path, w=1200, h=800):
    """A plain picture standing in for a screenshot (PNG by hand: no Pillow needed)."""
    row = b"\0" + bytes([236, 232, 226] * (w // 2) + [196, 160, 120] * (w - w // 2))
    raw = zlib.compress(row * h, 6)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def seed(r, sid, image):
    env = E.instance_env(r)
    folder = Path(r['folder']).resolve()
    assert folder.name == 'demo' and folder.is_relative_to(Path(r['root']).resolve()), 'the instance\'s own demo project'
    folder.mkdir(parents=True,exist_ok=True)
    def run(argv,inp=None):
        p=subprocess.run(argv,cwd=folder,env=env,input=inp,text=True,capture_output=True,timeout=120)
        if p.returncode: raise RuntimeError(p.stderr[-2000:]+p.stdout[-2000:])
        return p.stdout
    def d(*args): return run([sys.executable,r['cli'],*args])
    if not (folder/'.git').exists():
        run(['git','init','-q']); (folder/'README.md').write_text('# Hover demo\n')
        run(['git','add','README.md']); run(['git','-c','user.name=Dispatch e2e','-c','user.email=e2e@localhost','commit','-qm','docs: demo project'])
    if not (Path(r['beads_dir'])/'config.yaml').exists():
        Path(r['beads_dir']).mkdir(parents=True,exist_ok=True)
        run(['bd','init','--prefix','task','--non-interactive','--quiet','--skip-agents','--skip-hooks'])
    run([sys.executable,r['cli'],'settings','--save','--json'],json.dumps({**{k:0 for k in E.NOTIFY_SETTINGS}, 'workspace_roots':[str(folder.parent)]}))
    d('projects-view','add',str(folder),'--name','demo','--json')
    local=folder/'opencode.json'
    local.write_text(json.dumps({'model':E.cheap_opencode_model(),'permission':{'bash':'ask','edit':'ask','external_directory':'ask'}},indent=2)+'\n')
    now=time.time(); iso=lambda offset: datetime.datetime.fromtimestamp(now+offset,datetime.timezone.utc).isoformat()
    native = next((key for root in (r['user_data_dir'], r['agents_user_data_dir']) if (key := I.native_id(root, sid))), '')
    note=folder/'docs'; note.mkdir(exist_ok=True)
    source=Path(image).resolve()
    raw=source.read_bytes()
    assert raw[:8] == b'\x89PNG\r\n\x1a\n', 'The screenshot must be PNG'
    size=struct.unpack('>II', raw[16:24])
    shutil.copy2(source,note/'task-graph.png')
    (note/'notes.md').write_text('# Hover detail demo\n\n## 在哪：任务详情\n\n![Task graph](task-graph.png)\n\n1. Task graph · Graph page · Hover a task\n2. Current state · Right column · Hover the current task\n')
    (note/'00-where.json').write_text(json.dumps({'image':'task-graph.png','size':list(size),'scale':2,'items':[{'n':1,'box':[560,190,960,350],'what':'Task graph','where':'Project graph','how':'Hover a task'},{'n':2,'box':[1550,180,270,210],'what':'Current state','where':'Right column','how':'Read current step'}]}))
    meta={'thing':'Hover details','plan':[{'text':'Read the complete request','state':'done'},{'text':'Show the complete detail beside the pointed row','state':'active'},{'text':'Verify actions and the diagonal pointer path','state':'todo'}],'deliverables':[{'kind':'file','ref':str(note/'notes.md'),'label':'Hover detail guide','at':int(now-180)}]}
    issues=[
     {'id':'task-hva1','title':'Show complete task context beside the hovered row','status':'in_progress','metadata':meta,'comments':[{'id':1,'author':'e2e','text':'The task detail now keeps the full plan and latest activity together.','created_at':iso(-60)}]},
     {'id':'task-hva2','title':'Verify the detail remains on the same task during a diagonal move','status':'in_progress','metadata':{**meta,'from':'task-hva1'}},
     {'id':'task-hvy1','title':'Send the signed form to the project coordinator','status':'open','labels':['dispatch:needs-you'],'description':'The signed form is in docs/form.pdf. Send it before Friday.','metadata':{'thing':'Hover details','story':'The coordinator is waiting for the signed form to finish registration. The reviewed copy is ready to send.'}},
     {'id':'task-hvd1','labels':['dispatch:decide'],'title':'Choose how the complete task detail opens from a hover card','status':'open','description':'Should the complete detail stay beside the hovered row so the list does not move, or expand beneath that row?', 'metadata':{'thing':'Hover details','flow':{'kind':'design','state':'deciding','prototype':str(note/'notes.md'),'options':[{'key':'A','title':'Keep the complete detail beside the pointed row'},{'key':'B','title':'Expand the full detail below the pointed row'}]}}},
    ]
    # Match the existing design-flow metadata contract used by Waiting for you.
    issues = [issues[3], issues[2], issues[0], issues[1]]
    for i,t in enumerate(issues):
        t.update(_type='issue',issue_type='task',priority=2,assignee='codex',created_by='codex',created_at=iso(-600+i*60),updated_at=iso(-30))
        t['labels']=['project:demo','session-origin:'+sid,*(['session:'+native] if native and native != sid else []),*t.get('labels',[])]
    existing={json.loads(line).get('id') for line in run(['bd','export']).splitlines() if line.startswith('{')}
    for t in issues:
        if t['id'] in existing: t.pop('comments',None)
    run(['bd','import','-i','-'],''.join(json.dumps(t)+'\n' for t in issues))
    # Timeline reads the transcript index; a fresh isolated instance has no index daemon.
    d('index','--json')
    waiting=json.loads(d('waiting','--json'))
    graph=json.loads(d('task','graph','-P','demo','--json'))
    return {'ok': True, 'tasks': len(graph['nodes']), 'waiting': waiting['counts'], 'session': sid}



def prepare(rec):
    """`instance start --fixture hover-detail`: the world above in the seeded demo project (the instance's own)."""
    image = os.path.join(rec["root"], "hover-picture.png")
    png(image)
    seed(rec, "hover-demo-session", image)
    return {}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed the isolated hover-detail scenario")
    parser.add_argument('instance')
    parser.add_argument('--session', default='hover-demo-session', help='Host session UUID from the instance catalog')
    parser.add_argument('--image', required=True, help='A real PNG screenshot used by the picture-detail fixture')
    a = parser.parse_args()
    print(json.dumps(seed(E.read_record(a.instance), a.session, a.image)))
