// The steps line above a Codex reply opens to its steps and closes again (msg-bubble.mjs walks it on OpenCode).
// Codex runs on the smallest model its menu lists. Out of Codex quota: the run is skipped and says so.
import fs from 'node:fs';
import path from 'node:path';
import { send, walkStepsLine } from './msg-bubble.mjs';

export const meta = { needs: ['codex'], timeout: 900, title: 'The steps line on Codex', description: 'A Codex reply\'s steps line opens to what it did and closes again.' };

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('Codex', 180000);
  try { note('model', await ui.pickModel(/mini|nano|spark/i, 'a small Codex model', 30000)); } catch (e) { note('model', `Codex's default (${String(e).slice(0, 120)})`); }
  let seen;
  try {
    seen = await send(ui, 'Run `ls` in this folder with your shell tool, then run `wc -l README.md`, then reply with the number of lines of README.md only.', /\b\d+\b/);
  } catch (e) {
    if (/quota|usage limit|rate limit|insufficient/i.test(String(e))) return ui.skip(`Codex has no quota left: ${String(e).slice(0, 160)}`);
    throw e;
  }
  note('while_running', seen.map(s => s.title));
  await ui.screenshot('01-codex-steps-closed');
  const bad = await walkStepsLine(ui, note, '02-codex-steps', /ls|wc|README|Ran|command/i);
  if (bad.length) throw new Error(bad.join('\n'));
}
