// Asking once for a GitHub star (kanban task-j2h8; app/cli/star.py, app/ide-ext/src/star.ts), the way a person meets it:
// for the first week nothing appears; once Dispatch has been used a week and ten sessions and the repository is
// public, one notification in the Agents window asks; "Not now" closes it and it never comes back, even when the
// state changes again. The instance's own Dispatch data is set up as "eight days in, twelve sessions, public"
// (the real repository is still private, so GitHub itself is not asked here). No engine messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const meta = {
  title: '请用户点星：用了一段时间才问、只问一次',
  description: '头一周不出现；用满一周、十个会话、仓库公开后，Agents 窗口右下角出一条通知请去 GitHub 点星；点 Not now 以后不再出现。',
};

const DAY = 86400;

function assert(ok, message) { if (!ok) throw new Error(message); }

function cliEnv(rec) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(key) && key !== 'CLAUDECODE') env[key] = value;
  }
  return Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli });
}

function cli(ui, args) {
  const r = spawnSync('python3', [ui.rec.cli, ...args], { env: cliEnv(ui.rec), encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`dispatch ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const TOAST = { css: '.notification-toast-container .notification-list-item', webview: false };
const toastText = (ui) => ui.eval("[...document.querySelectorAll('.notification-toast-container .notification-list-item')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')");

export default async function (ui) {
  const facts = {};
  const dir = ui.rec.dispatch_dir;
  const starFile = path.join(dir, 'star.json');
  await ui.openAgents();
  await ui.sleep(2000);

  // 1. a new person: nothing is asked, and the CLI says why
  const now = Date.now() / 1000;
  writeFileSync(starFile, JSON.stringify({ first_seen: now - 2 * DAY }));
  facts.newPerson = cli(ui, ['star', 'check', '--json']);
  assert(!facts.newPerson.due && /days/.test(facts.newPerson.why), `day two: ${JSON.stringify(facts.newPerson)}`);
  await ui.sleep(7000);
  facts.toastDayTwo = await toastText(ui);
  assert(!/star on GitHub/i.test(facts.toastDayTwo), `asked on day two: ${facts.toastDayTwo}`);
  await ui.screenshot('01-day-two-nothing');

  // 2. eight days and twelve sessions later, the repository public: one notification
  const index = {};
  for (let i = 0; i < 12; i++) index[`${dir}/e2e-star/${i}.jsonl`] = { agent: 'claude-code', session_id: `e2e-${i}`, cwd: ui.demoFolder || dir, mtime: now - DAY, size: 1, assistant_msgs: 2, subagent: false };
  writeFileSync(path.join(dir, 'transcript-index.json'), JSON.stringify(index));
  writeFileSync(starFile, JSON.stringify({ first_seen: now - 8 * DAY, public: true, public_checked_at: now, starred: false }));
  // the bridge looks when star.json changes, or a minute after the window opened when it was not watching yet
  const askedFrom = Date.now();
  await ui.waitFor({ text: 'Has Dispatch been useful? A star on GitHub helps other people find it', webview: false }, { timeoutMs: 90000 });
  facts.askedAfterSeconds = Math.round((Date.now() - askedFrom) / 1000);
  facts.toast = await toastText(ui);
  assert(/only time we ask/.test(facts.toast), `the notification says: ${facts.toast}`);
  // Dispatch's own notifications speak as the app: no VS Code "Source: Dispatch Bridge" line under them (round 2, 10-06)
  assert(!/Source:|Dispatch Bridge/.test(facts.toast), `the notification names the extension: ${facts.toast}`);
  await ui.screenshot('02-asked-once');
  await ui.mark(TOAST, { what: '请用户去 GitHub 点星', where: 'Agents 窗口右下角的通知', how: '用满一周、十个会话后自动出现一次' });
  facts.asked = cli(ui, ['star', '--json']);
  assert(facts.asked.asked, `after showing it the CLI does not know it was asked: ${JSON.stringify(facts.asked)}`);

  // 3. Not now: it goes away and never comes back
  await ui.click({ text: 'Not now', exact: true, webview: false });
  await ui.sleep(1500);
  facts.afterLater = cli(ui, ['star', '--json']);
  assert(facts.afterLater.answer === 'later', `answer recorded: ${JSON.stringify(facts.afterLater)}`);
  const again = JSON.parse(fs.readFileSync(starFile, 'utf8'));
  writeFileSync(starFile, JSON.stringify({ ...again, public_checked_at: Date.now() / 1000 }));
  await ui.sleep(12000);
  facts.toastAfter = await toastText(ui);
  assert(!/star on GitHub/i.test(facts.toastAfter), `asked a second time: ${facts.toastAfter}`);
  await ui.screenshot('03-not-again');
  writeFileSync(path.join(ui.out, 'facts.json'), JSON.stringify(facts, null, 2));
}
