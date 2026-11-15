"""Twenty-odd projects for Settings › Projects (scenarios/settings-projects.mjs declares it: meta.instance.fixture
"many-projects"), shaped like a real person's list: folders in a Projects folder and in Documents, four deep in
iCloud Drive with long Chinese names, one whose folder was deleted, three registered on another Mac this one has no
host for, one with no folder at all. Every folder is in the instance's own folder; the iCloud ones sit under
<instance>/home/Library/Mobile Documents/com~apple~CloudDocs, which the window shows as iCloud Drive the way it does
for a home folder's. The registrations are written straight into the instance's board (one `bd remember`), as
`dispatch project` keeps them."""
import json
import os
import shutil
import subprocess

import ide_e2e

MAC = [
    ("harbor", "Projects/harbor"),
    ("bookmark", "Projects/bookmark"),
    ("GetNewWord", "Projects/GetNewWord"),
    ("kanban", "Projects/kanban"),
    ("pipeline", "Projects/media/nas/pipeline"),
    ("poker-trainer", "Projects/poker-trainer"),
    ("ReadOut", "Projects/ReadOut"),
    ("redraft", "Projects/redraft"),
    ("typefree", "Documents/github_projects/typefree"),
    ("workflow", "Projects/workflow"),
    ("手机ai摄影", "Projects/手机ai摄影"),
    ("自媒体", "Documents/自媒体"),
    ("雅思刷题网站", "Projects/雅思刷题网站"),
    ("a-project-with-a-rather-long-name", "Projects/clients/2026/acme-corporation/website-redesign/phase-two/a-project-with-a-rather-long-folder-name-that-keeps-going-and-going"),
]
ICLOUD = [
    ("Signals and Systems", "河湾大学/2026ss/Signals and Systems"),
    ("ALG", "河湾大学/2025WS/ALG"),
    ("TUTOR", "河湾大学/河湾大学兼职/TUTOR"),
    ("tutor2", "河湾大学/河湾大学兼职/tutor2"),
]
# registered on a Mac this instance has no host for: its folder is another person's home
ELSEWHERE = [
    ("会议记录", "/Users/studio/Projects/会议记录", None),
    ("后台", "/Users/studio/Projects/后台", None),
    ("内在知识提升", "/Users/studio/Projects/内在知识提升", "讲书"),
]


def prepare(rec):
    root = rec["root"]
    places = os.path.join(root, "places")
    icloud = os.path.join(root, "home", "Library", "Mobile Documents", "com~apple~CloudDocs")
    env = ide_e2e.instance_env(rec)
    flags_add = {}
    for name, rel in MAC:
        flags_add[name] = os.path.join(places, rel)
    for name, rel in ICLOUD:
        flags_add[name] = os.path.join(icloud, rel)
    for name, folder in flags_add.items():
        os.makedirs(folder, exist_ok=True)
        subprocess.run(["git", "init", "-q"], cwd=folder, check=True, timeout=30)
    # Probe: a folder that was there when it was registered and has since been deleted
    probe = os.path.join(places, "dbg", "Probe")
    flags = {}
    code = subprocess.run(["bd", "memories", "--json"], env=env, capture_output=True, text=True, timeout=60)
    if code.returncode == 0 and code.stdout.strip():
        mem = json.loads(code.stdout[code.stdout.find("{"):])
        flags = json.loads(mem.get("dispatch-projects") or "{}")
    for name, folder in flags_add.items():
        flags[name] = {"dir": folder, "starred": True}
    flags["Probe"] = {"dir": probe, "starred": True}
    for name, folder, alias in ELSEWHERE:
        flags[name] = {"dir": folder, "starred": True, **({"alias": alias} if alias else {})}
    flags["scratch"] = {"starred": True}
    flags["old-notes"] = {"dir": os.path.join(places, "Projects", "old-notes"), "archived": True}
    os.makedirs(flags["old-notes"]["dir"], exist_ok=True)
    shutil.rmtree(probe, ignore_errors=True)
    subprocess.run(["bd", "remember", json.dumps(flags, ensure_ascii=False), "--key", "dispatch-projects"],
                   env=env, check=True, capture_output=True, text=True, timeout=60)
    return {"record": {"many_projects": {"icloud": icloud, "places": places, "probe": probe,
                                          "live": len([f for f in flags.values() if not f.get("archived")])}}}
