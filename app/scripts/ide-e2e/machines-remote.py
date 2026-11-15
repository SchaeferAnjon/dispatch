#!/usr/bin/env python3
"""Provision the explicit demo used by machines-live, without changing the remote user's server.

Run before instance start. Put the printed shim directory first on PATH for both instance start
and e2e run. The shim changes only the demo destination's server/landing HOME and launchd label;
Remote-SSH itself uses serverInstallPath. All SSH connections and application code remain real.
The remote demo board/project must already exist. Credentials stay in its private .env.local.
"""
import argparse
import json
import pathlib
import shlex
import subprocess
import sys
import shutil


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--target", required=True)
    p.add_argument("--remote", required=True)
    p.add_argument("--app", required=True)
    p.add_argument("--shim", required=True)
    p.add_argument("--opencode", default=shutil.which("opencode") or str(pathlib.Path.home() / ".opencode/bin/opencode"))
    args = p.parse_args()
    if not args.remote.startswith(("/private/tmp/dispatch-machines-", "/tmp/dispatch-machines-")):
        p.error("--remote must be an explicit temporary machines demo")
    resources = pathlib.Path(args.app) / "Contents/Resources/app"
    product = json.loads((resources / "product.json").read_text())
    root = args.remote.rstrip("/")
    home = root + "/isolated-home"
    server = home + "/.dispatch-ide-server"
    commit = product["commit"]
    ssh = ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", args.target]
    binary = pathlib.Path(args.opencode).resolve()
    local_version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    subprocess.run(ssh + ["mkdir -p " + shlex.quote(root + "/bin")], check=True, timeout=15)
    with binary.open("rb") as stream:
        subprocess.run(ssh + ["cat > " + shlex.quote(root + "/bin/opencode") + " && chmod 755 " + shlex.quote(root + "/bin/opencode")], stdin=stream, check=True, timeout=180)
    source = root + "/server-source/" + commit
    present = subprocess.run(ssh + ["test -x " + shlex.quote(source + "/bin/dispatch-ide-server")], capture_output=True, timeout=15)
    if present.returncode:
        archive = resources / "server" / f"{product['serverApplicationName']}-darwin-arm64.tar.gz"
        with archive.open("rb") as stream:
            subprocess.run(ssh + ["mkdir -p " + shlex.quote(source) + " && tar -xzf - --strip-components 1 -C " + shlex.quote(source)], stdin=stream, check=True, timeout=180)
    key = subprocess.check_output(["dispatch", "env", "get", "ZHIPU_API_KEY"], text=True).strip()
    if not key:
        raise RuntimeError("ZHIPU_API_KEY is required; no fallback model is allowed")
    config = {"root": root, "home": home, "server": server, "commit": commit, "key": key}
    # This program is passed on stdin, never written to a log or put in a process argument.
    setup = r'''
import json,os,pathlib,shlex,subprocess
c=CONFIG
r=pathlib.Path(c['root']); h=pathlib.Path.home(); testhome=pathlib.Path(c['home'])
assert (r/'board/.beads').is_dir() and (r/'projects/demo/.git').exists(), 'demo must be provisioned first'
src=r/'server-source'/c['commit']
assert (src/'bin/dispatch-ide-server').is_file(), 'install the matching build server first'
for name in ['state','home','rules','reh-data/data/Machine','xdg-config/opencode','xdg-data','xdg-cache','xdg-state','isolated-home/.dispatch','isolated-home/.local/bin']:
    (r/name).mkdir(parents=True,exist_ok=True)
link=testhome/'.dispatch/state'
if not link.exists(): link.symlink_to(r/'state',target_is_directory=True)
assert link.resolve()==(r/'state').resolve()
(r/'state/self-name.json').write_text(json.dumps({'name':'mini'}))
(r/'state/hosts.json').write_text('[]')
env={'BEADS_DIR':str(r/'board/.beads'),'DISPATCH_DIR':str(r/'state'),'DISPATCH_HOME':str(r/'home'),
 'DISPATCH_IDE_USER_DATA_DIRS':str(r/'reh-data/data'),'DISPATCH_SESSION_ROOT':str(r),
 'DISPATCH_FACTS_FILE':str(r/'rules/FACTS.md'),'DISPATCH_BIN':str(r/'dispatch-demo'),
 'XDG_CONFIG_HOME':str(r/'xdg-config'),'XDG_DATA_HOME':str(r/'xdg-data'),
 'XDG_CACHE_HOME':str(r/'xdg-cache'),'XDG_STATE_HOME':str(r/'xdg-state'),
 'VSCODE_CLI':'1','PATH':str(r/'bin')+':'+str(h/'.local/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
secret=r/'projects/demo/.env.local'
exclude=r/'projects/demo/.git/info/exclude'
exclude.parent.mkdir(parents=True,exist_ok=True)
if '.env.local' not in (exclude.read_text() if exclude.exists() else ''):
    with exclude.open('a') as f:f.write('\n.env.local\n')
fd=os.open(secret,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write('export ZHIPU_API_KEY='+shlex.quote(c['key'])+'\n')
cfg={'model':'zai-coding-plan/glm-5.3-flash','small_model':'zai-coding-plan/glm-5.3-flash',
 'enabled_providers':['zai-coding-plan'],'plugin':[],
 'provider':{'zai-coding-plan':{'npm':'@ai-sdk/openai-compatible','name':'ZAI Coding Plan',
 'options':{'baseURL':'https://open.bigmodel.cn/api/coding/paas/v4','apiKey':'{env:ZHIPU_API_KEY}'},
 'models':{'glm-5.3-flash':{'name':'GLM-5.3-Flash','limit':{'context':200000,'output':16000}}}}}}
(r/'xdg-config/opencode/opencode.json').write_text(json.dumps(cfg))
exports='\n'.join('export '+k+'='+shlex.quote(v) for k,v in env.items())
cli=(h/'.local/bin/dispatch').resolve()
wrapper='#!/bin/bash\n'+exports+'\nexec /opt/homebrew/bin/python3 '+shlex.quote(str(cli))+' "$@"\n'
(r/'dispatch-demo').write_text(wrapper); (r/'dispatch-demo').chmod(0o755)
for name,dest in [('dispatch',r/'dispatch-demo'),('opencode',r/'bin/opencode')]:
    link=testhome/'.local/bin'/name
    if not link.exists():link.symlink_to(dest)
dest=pathlib.Path(c['server'])/'bin'/c['commit'];(dest/'bin').mkdir(parents=True,exist_ok=True)
for name in ['product.json','package.json','node','out','node_modules','extensions']:
    link=dest/name
    if not link.exists():link.symlink_to(src/name,target_is_directory=(src/name).is_dir())
wrapper='#!/bin/bash\n'+exports+'\nexport HOME='+shlex.quote(str(testhome))+'\nsource '+shlex.quote(str(secret))+'\n'+shlex.quote(str(src/'bin/dispatch-ide-server'))+' "$@" --server-data-dir '+shlex.quote(str(r/'reh-data'))+' &\nchild=$!\ntrap \'kill -TERM "$child" 2>/dev/null; wait "$child"\' TERM INT\nwait "$child"\n'
entry=dest/'bin/dispatch-ide-server';entry.write_text(wrapper);entry.chmod(0o755)
(r/'reh-data/data/Machine/settings.json').write_text(json.dumps({'dispatch.commandLocation':str(r/'dispatch-demo')}))
print(json.dumps({'server':c['server'],'root':c['root'],'commit':c['commit'],'model':cfg['model']}))
'''.replace("CONFIG", repr(config), 1)
    result = subprocess.run(ssh + ["/opt/homebrew/bin/python3", "-"], input=setup, text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr)
    shim = pathlib.Path(args.shim)
    shim.mkdir(parents=True, exist_ok=True)
    script = '''#!PYTHON
import os,shlex,subprocess,sys
args=sys.argv[1:]; target=__TARGET__; home=__HOME__; data=None
if target in args:
    i=args.index(target); cmd=' '.join(args[i+1:])
    if '$HOME/.dispatch' in cmd:
        args[i+1:]=['export HOME='+shlex.quote(home)+'; '+cmd]
    elif cmd=='bash -s':
        data=sys.stdin.buffer.read()
        if b'dev.dispatch.ide-server' not in data:
            raise SystemExit('unexpected SSH script in machines demo')
        data=('export HOME='+shlex.quote(home)+'\\n').encode()+data.replace(b'dev.dispatch.ide-server',b'dev.dispatch.ide-server.gx-machines-test')
if data is None: os.execv('/usr/bin/ssh',['/usr/bin/ssh',*args])
raise SystemExit(subprocess.run(['/usr/bin/ssh',*args],input=data).returncode)
'''.replace("PYTHON", sys.executable).replace("__TARGET__", repr(args.target)).replace("__HOME__", repr(home))
    (shim / "ssh").write_text(script)
    (shim / "ssh").chmod(0o755)
    print(result.stdout.strip())
    print(f"Isolated OpenCode: {local_version}")
    print(f"SSH shim: {shim}")


if __name__ == "__main__":
    main()
