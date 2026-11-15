// The steps line above a Claude Code reply opens to its steps and closes again (msg-bubble.mjs walks it on OpenCode).
// Claude Code runs on Haiku (ui.pickEngine picks it in a test). It only runs with DISPATCH_E2E_CLAUDE=1 (the needs
// check): Claude's quota is kept for the person's own work, so by default this one is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { send, walkStepsLine } from './msg-bubble.mjs';

export const meta = { needs: ['claude'], timeout: 900, title: 'The steps line on Claude Code', description: 'A Claude Code reply\'s steps line opens to what it did and closes again.' };

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('Claude Code', 180000);
  let seen;
  try {
    seen = await send(ui, 'Run `ls` in this folder with your Bash tool, then run `wc -l README.md`, then reply with the number of lines of README.md only.', /\b\d+\b/);
  } catch (e) {
    if (/quota|usage limit|rate limit|insufficient/i.test(String(e))) return ui.skip(`Claude Code has no quota left: ${String(e).slice(0, 160)}`);
    throw e;
  }
  note('while_running', seen.map(s => s.title));
  await ui.screenshot('01-claude-steps-closed');
  const bad = await walkStepsLine(ui, note, '02-claude-steps', /ls|wc|README|Ran|command/i);
  if (bad.length) throw new Error(bad.join('\n'));
}
