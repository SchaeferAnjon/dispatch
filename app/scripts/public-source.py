#!/usr/bin/env python3
"""Export a reviewable source snapshot without private operational history/config.

Usage: python3 app/scripts/public-source.py /absolute/path/dispatch-source.tar.gz
Only tracked files from the documented product paths are included. No git history.
"""
import pathlib
import subprocess
import sys
import tarfile

root=pathlib.Path(__file__).resolve().parents[2]
destination=pathlib.Path(sys.argv[1]).resolve()
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
single={'README.md','LICENSE','.gitignore','app/README.md','app/package.json','app/package-lock.json','app/index.html','app/tsconfig.json','app/tsconfig.node.json','app/vite.config.ts','app/.gitignore','app/scripts/install.sh','app/scripts/public-source.py'}
paths=[p for p in tracked if p and (p in single or p.startswith(('app/src/','app/src-tauri/')) or (p.startswith('app/cli/') and p.endswith('.py')))]
assert paths and 'app/cli/dispatch.py' in paths and 'README.md' in paths
destination.parent.mkdir(parents=True,exist_ok=True)
with tarfile.open(destination,'w:gz') as archive:
    for p in paths: archive.add(root/p,arcname='dispatch/'+p,recursive=False)
destination.with_suffix('.manifest.txt').write_text('\n'.join(paths)+'\n')
print(f'{len(paths)} product files → {destination}')
