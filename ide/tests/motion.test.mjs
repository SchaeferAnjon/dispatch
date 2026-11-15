import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.env.DISPATCH_VSCODE_SOURCE;
const moduleAt = relative => src ? pathToFileURL(path.join(src, 'src/vs', relative)) : new URL('../vscode/src/vs/' + relative, import.meta.url);
const m = await import(moduleAt('workbench/contrib/dispatchMotion/browser/dispatchMotionModel.ts'));

test('Motion has four choices, Less between Full and None (task-wl9fo)', () => {
 for (const c of ['auto', 'full', 'less', 'none']) {
  const s = m.motionSettings(c);
  assert.equal(m.motionChoice(s.reduce, s.dispatchMotion), c, c);
 }
});

test('Less follows the Mac, so the Mac\'s Reduce motion still stops everything', () => {
 assert.equal(m.motionSettings('less').reduce, 'auto');
 assert.equal(m.motionChoice('on', 'less'), 'none');
 assert.equal(m.motionChoice(undefined, undefined), 'auto');
 assert.equal(m.motionChoice('off', undefined), 'full');
});
