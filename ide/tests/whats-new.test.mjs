import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../whats-new/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('whats-new.json', dir), 'utf8'));

test('What\'s new is this version\'s: dated on or after its newest feature, at most five, at most three badges (task-4z1k)', () => {
 assert.ok(data.features.length >= 1 && data.features.length <= 5);
 assert.ok(data.features.filter(f => f.badge).length <= 3);
 const newest = data.features.map(f => f.version).sort().at(-1);
 assert.ok(data.date >= newest, `date ${data.date} is older than ${newest}`);
 assert.ok(data.date >= '2026-10-06', 'still the September card');
 assert.equal(new Set(data.features.map(f => f.id)).size, data.features.length);
});

test('every feature has its picture, its marks and the mark it points at', () => {
 for (const f of data.features) {
  assert.ok(f.title && f.description && f.where, f.id);
  assert.ok(fs.existsSync(new URL(f.image, dir)), `${f.id}: ${f.image}`);
  const marks = JSON.parse(fs.readFileSync(new URL(f.marks, dir), 'utf8'));
  assert.equal(marks.image, f.image, f.id);
  assert.ok(marks.marks.some(m => m.n === (f.mark ?? 1)), `${f.id}: mark ${f.mark}`);
  for (const m of marks.marks) {
   const [x, y, w, h] = m.box;
   assert.ok(x >= 0 && y >= 0 && x + w <= marks.size[0] && y + h <= marks.size[1], `${f.id}: box outside the picture`);
  }
 }
});

test('no picture is left in the folder that no feature uses', () => {
 const used = new Set(data.features.flatMap(f => [f.image, f.marks]));
 for (const name of fs.readdirSync(dir)) {
  if (name !== 'whats-new.json') { assert.ok(used.has(name), `unused ${name}`); }
 }
});
