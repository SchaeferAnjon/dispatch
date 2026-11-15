"""The bottom bar's Builds block (scenarios/builds-block.mjs, meta.instance.fixture "builds-block"; task-7ve7v): a
builds folder of the instance's own, as the mini would have it, written before the app starts. Three agents' test
builds that failed (development builds, one in its build and two in their checks), one still building, and a full
package of yours (dispatch-update's: no request) that stopped while compiling. The CLI reads it as the build host
itself (DISPATCH_BUILD_SELF=mini), so nothing goes over ssh; DISPATCH_REPO points at an empty folder, so Try again
cannot start a real build."""
import json
import os
import time


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def build(bdir, name, *, ago, seconds, status=None, log="", requests=(), building=False):
    d = os.path.join(bdir, name)
    write(os.path.join(d, "pid"), "1" if building else "999999")  # pid 1 is always alive: "still building"
    t = time.time() - ago
    os.utime(os.path.join(d, "pid"), (t, t))
    write(os.path.join(d, "build.log"), log)
    if status:
        write(os.path.join(d, "status"), status + "\n")
    for rid, req, res in requests:
        write(os.path.join(d, "requests", rid, "request.json"), json.dumps(req))
        if res:
            write(os.path.join(d, "requests", rid, "result.json"), json.dumps(res))
    return d


def checks_failed(bdir, name, ref, scenario, ago):
    now = time.time()
    build(bdir, name, ago=ago, seconds=60, status="ok 60", log=f"== {name} on mini: development build\n== ide/dev.sh build\n== ok\n",
          requests=[("r-" + name, {"ref": ref, "dev": True, "e2e": [scenario]},
                     {"state": "failed", "stage": "e2e", "dev": True, "finished": int(now - ago + 120),
                      "e2e": {"state": "failed", "log": f"{bdir}/{name}/requests/r-{name}/e2e.log",
                              "runs": [{"scenario": scenario, "status": "failed"}]}})])


def prepare(rec):
    root = rec["root"]
    bdir = os.path.join(root, "builds")
    now = time.time()
    # the agents': a development build that did not compile, two whose checks failed, one compiling now
    build(bdir, "1111aaaa2222-dev", ago=900, seconds=40, status="failed 2 40",
          log="== 1111aaaa2222-dev on mini: development build\n== checkout\n== ide/dev.sh build\nsrc/x.ts(1,1): error TS2304\n== FAILED: dev.sh build exited 2 after 40s\n",
          requests=[("r1", {"ref": "gx/notes", "dev": True, "e2e": ["notes.mjs"]},
                     {"state": "failed", "stage": "build", "dev": True, "finished": int(now - 860)})])
    checks_failed(bdir, "3333bbbb4444-dev", "gx/tabs", "tabs.mjs", 700)
    checks_failed(bdir, "5555cccc6666-dev", "gx/motion", "motion.mjs", 500)
    build(bdir, "7777dddd8888-dev", ago=90, seconds=0, building=True,
          log="== 7777dddd8888-dev on mini: development build\n== ide/dev.sh build\n",
          requests=[("r4", {"ref": "gx/bars", "dev": True, "e2e": ["bars.mjs"]}, None)])
    write(os.path.join(bdir, ".dev.lock.name"), "7777dddd8888-dev\n")
    # yours: dispatch-update's full package, no request, stopped while compiling
    build(bdir, "9999eeeeffff", ago=600, seconds=252, status="failed 1 252",
          log="== 9999eeeeffff on mini, 2026-10-09 10:00:00: full package\n"
              "commit 9999eeeeffff0000000000000000000000000000 fix: the release you asked for\n"
              "node v22.20.0, fnm 1.38.1, free disk 120Gi\n== checkout\n== ide/build.sh\n[12:01:02] Compiling\n"
              "src/vs/sessions/contrib/dispatchStatusBar/browser/x.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n\n"
              "== FAILED: build.sh exited 1 after 4m12s\n")
    os.makedirs(os.path.join(root, "build-state"), exist_ok=True)
    os.makedirs(os.path.join(root, "no-repo"), exist_ok=True)
    return {"env": {"DISPATCH_BUILDS_DIR": bdir, "DISPATCH_BUILD_STATE": os.path.join(root, "build-state"),
                    "DISPATCH_BUILD_SELF": "mini", "DISPATCH_REPO": os.path.join(root, "no-repo"),
                    "DISPATCH_LSREGISTER": "/nonexistent/lsregister"},
            "record": {"builds_dir": bdir}}
