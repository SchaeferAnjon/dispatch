// OpenCode's plugin kit from inside the app (dispatchOpenCodeKitModel.ts, kanban task-lj06.13): which
// config folders still need it. The same folders as kanban app/cli/opencode_kit.py config_dirs / needs_kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const kit = await import(moduleAt('platform/agentHost/node/opencode/dispatchOpenCodeKitModel.ts'));

function home() {
 const h = realpathSync(mkdtempSync(path.join(tmpdir(), 'oc-kit-')));
 mkdirSync(path.join(h, '.config', 'opencode', 'plugins'), { recursive: true });
 return h;
}

test('the kit sits in the app\'s tools folder, next to bd and dolt', () => {
 assert.equal(kit.OPENCODE_KIT_NAME, 'opencode-plugin-kit.tgz');
 assert.equal(kit.openCodeKitPath('/App/Contents/Resources/app', () => true), '/App/Contents/Resources/app/tools/opencode-plugin-kit.tgz');
 assert.equal(kit.openCodeKitPath('/App/Contents/Resources/app', () => false), undefined);
});

test('a new Mac: the config folder and ~/.opencode (OpenCode\'s installer made it) both need the kit', () => {
 const h = home();
 mkdirSync(path.join(h, '.opencode', 'bin'), { recursive: true });
 const dirs = kit.openCodeConfigDirs({}, undefined, h);
 assert.deepEqual(dirs, [path.join(h, '.config', 'opencode'), path.join(h, '.opencode')]);
 assert.deepEqual(dirs.filter(kit.needsOpenCodeKit), dirs);
});

test('folders that are not there are left out; XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR are followed', () => {
 const h = home();
 const xdg = path.join(h, 'xdg');
 mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
 const extra = path.join(h, 'extra');
 mkdirSync(extra);
 assert.deepEqual(kit.openCodeConfigDirs({ XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: extra }, undefined, h), [path.join(xdg, 'opencode'), extra]);
 assert.deepEqual(kit.openCodeConfigDirs({ OPENCODE_CONFIG_DIR: path.join(h, 'missing') }, undefined, h), [path.join(h, '.config', 'opencode')]);
});

test('a project\'s .opencode folders count from the session\'s folder up to its git root, not above', () => {
 const h = home();
 const repo = path.join(h, 'work', 'app');
 mkdirSync(path.join(repo, '.git'), { recursive: true });
 mkdirSync(path.join(repo, '.opencode'), { recursive: true });
 mkdirSync(path.join(repo, 'pkg', 'web', '.opencode'), { recursive: true });
 mkdirSync(path.join(h, 'work', '.opencode'), { recursive: true }); // above the git root: OpenCode does not read it
 const dirs = kit.openCodeConfigDirs({}, path.join(repo, 'pkg', 'web'), h);
 assert.deepEqual(dirs, [path.join(h, '.config', 'opencode'), path.join(repo, 'pkg', 'web', '.opencode'), path.join(repo, '.opencode')]);
 assert.deepEqual(kit.openCodeConfigDirs({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' }, path.join(repo, 'pkg', 'web'), h), [path.join(h, '.config', 'opencode')]);
});

test('a folder with packages of its own (the person\'s, or OpenCode\'s from an earlier start) is left alone', () => {
 const h = home();
 const cfg = path.join(h, '.config', 'opencode');
 assert.equal(kit.needsOpenCodeKit(cfg), true);
 for (const own of ['package.json', 'package-lock.json']) {
  const d = path.join(h, own);
  mkdirSync(d);
  writeFileSync(path.join(d, own), '{}');
  assert.equal(kit.needsOpenCodeKit(d), false, own);
 }
 const nm = path.join(h, 'nm');
 mkdirSync(path.join(nm, 'node_modules'), { recursive: true });
 assert.equal(kit.needsOpenCodeKit(nm), false);
 const locked = path.join(h, 'locked');
 mkdirSync(locked);
 chmodSync(locked, 0o555); // OpenCode does not install where it cannot write
 assert.equal(kit.needsOpenCodeKit(locked), false);
 chmodSync(locked, 0o755);
 assert.equal(kit.needsOpenCodeKit(path.join(h, 'missing')), false);
});
