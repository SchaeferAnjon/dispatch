// A Mac that has never run Dispatch (start the instance with --onboarding fresh; its agents are the fixture's
// stand-ins, so nothing here spends a real allowance). Bug fixes of 2026-10-06, group nextup:
//   task-5k8a  the first tips on the page setup lands on (a new chat, since 2026-11-11: the Assistant is gone) keep
//              clear of the agent picker
//   task-9rxf  Settings › Agents › Next up: Start by itself is off for a new person, and the line says so
//   task-9qas  a thing in line whose agent cannot start: the line says why, it is not tried every 20 s, Try again
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)

export const meta = { instance: { onboarding: 'fresh', tips: true },
  title: 'Next up on a new Mac',
  description: 'New person: the first tips keep clear of the agent picker, Start by itself is off, and a start that fails says why and waits.',
  timeout: 1500,
};

function cli(ui, args, timeout = 60000) {
  const out = execFileSync(path.join(ui.rec.bin_dir, 'dispatch'), args, { encoding: 'utf8', timeout });
  const i = Math.min(...['{', '['].map(c => out.indexOf(c)).filter(x => x >= 0));
  return JSON.parse(out.slice(i));
}

async function until(ui, fn, what, ms = 60000, every = 500) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}

const overlaps = (a, b) => !!a && !!b && a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const rectOf = (css) => `(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`;

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, 'Start this instance with --onboarding fresh');
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  await ui.attach('agents', 90000);

  // the first-run setup, as a new person clicks through it (skipped when this instance is past it)
  if (await ui.waitFor('Agents on this Mac', { timeoutMs: 60000 }).then(() => true, () => false)) {
    for (let i = 0; i < 8 && !(await ui.exists({ text: 'Set up Dispatch', exact: true })); i++) {
      if (await ui.exists({ css: '.dispatch-whats-new-auto' })) await ui.press('Escape');
      await ui.click({ css: '.dob-foot .dob-btn.fill' });
      await ui.sleep(1500);
    }
    await ui.clickWhenEnabled({ text: 'Set up Dispatch', exact: true });
    for (let i = 0; i < 150; i++) {
      if ((await ui.exists({ text: 'Start', exact: true })) || (await ui.exists({ text: 'Retry setup', exact: true }))) break;
      if (await ui.exists({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' })) await ui.click({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' });
      await ui.sleep(1000);
    }
    await ui.click({ text: 'Start', exact: true });
    if (await ui.waitFor('Welcome to Dispatch', { timeoutMs: 30000 }).then(() => true, () => false)) await ui.press('Escape');
  }

  // 1 task-5k8a: every first tip on the page setup lands on (a new chat with the first suggestions) keeps clear of the
  //   agent picker; the Waiting for you tip comes after the Start here tip
  await until(ui, async () => ui.eval(`!!document.querySelector('.new-session-prompt-option')`), 'the first suggestions on a new chat', 60000);
  const tipNow = () => ui.eval(`(() => { const t = document.querySelector('.dispatch-tour'); if (!t || getComputedStyle(t).visibility === 'hidden') return null; const r = t.getBoundingClientRect(); return { step: t.dataset.step, side: t.dataset.side, count: t.querySelector('.dispatch-tour-count')?.textContent || '', box: { left: r.left, top: r.top, width: r.width, height: r.height } }; })()`);
  const seen = [];
  let tip = null;
  for (const until_ = Date.now() + 90000; Date.now() < until_;) {
    const t = await tipNow();
    if (t && !seen.some(x => x.step === t.step)) {
      await ui.sleep(1500); // it follows the page for a moment (re-placed every 100 ms)
      const settled = await tipNow();
      const picker = await ui.eval(rectOf('.sessions-chat-session-type-picker'));
      seen.push({ ...settled, picker, overlaps: overlaps(settled.box, picker) });
      if (settled.step === 'waiting-row') { tip = settled; break; }
      await ui.screenshot(`01a-tip-${settled.step}`);
      await ui.click({ css: 'button.dispatch-tour-close' }).catch(() => null); // the person closes Start here
    }
    await ui.sleep(500);
  }
  note('tips', { seen });
  assert.ok(tip, 'the Waiting for you tip never showed: ' + JSON.stringify(seen));
  const bubble = tip.box;
  await ui.screenshot('01-first-tip');
  await ui.mark({ css: '.dispatch-tour' }, { what: '提示卡 Waiting for you', where: '首次设置后的新对话页，左栏旁边', how: '新用户走完首次设置就出现' });
  assert.ok(seen.every(x => !x.overlaps), `a tip covers the agent picker: ${JSON.stringify({ seen })}`);
  for (let i = 0; i < 5 && (await ui.exists({ css: 'button.dispatch-tour-close' })); i++) {
    await ui.click({ css: 'button.dispatch-tour-close' });
    await ui.sleep(600);
  }

  // 3 task-9rxf: Settings › Agents › Next up, Start by itself is off for a new person
  const settings0 = cli(ui, ['nextup', 'settings', '--json']);
  note('settings_at_start', settings0);
  assert.equal(settings0.paused, true, 'Start by itself is on for a new person');
  await ui.press('Cmd+,');
  await ui.waitFor({ css: '.dispatch-settings-nav', webview: false }, { timeoutMs: 15000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
  const sw = await until(ui, async () => ui.eval(`(() => { const s = [...document.querySelectorAll('[aria-label="Start by itself"]')].find(e => e.offsetParent); if (!s) return null; s.scrollIntoView({ block: 'center' }); return { checked: s.getAttribute('aria-checked') ?? String(!!s.checked), sub: [...document.querySelectorAll('.dset-sub')].map(e => e.textContent).find(t => /lines up behind/.test(t)) || '' }; })()`), 'the Start by itself switch', 30000);
  note('settings_switch', sw);
  await ui.sleep(600);
  await ui.screenshot('04-settings-start-by-itself-off');
  await ui.mark({ css: '[aria-label="Start by itself"]' }, { what: 'Start by itself 默认关：说过的事排着，不自己开工', where: '设置 › Agents › Next up', how: '⌘, 打开设置，点 Agents，往下翻到 Next up' });
  assert.equal(sw.checked, 'false', 'the switch shows off');
  assert.match(sw.sub, /for later waits in Later/);
  await ui.press('Escape');

  // 4 task-9qas: a thing in line whose agent cannot start (this Mac's Claude Code is the fixture's stand-in)
  const proj = path.join(ui.rec.fixture_home, 'Projects', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  fs.writeFileSync(path.join(proj, 'README.md'), '# Shop\n');
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qam', 'readme', '--allow-empty'], { cwd: proj });
  cli(ui, ['project', 'shop', '--dir', proj, '--json']);
  cli(ui, ['nextup', 'engine', 'claude', '--json']);
  const noted = cli(ui, ['capture', 'note', '--session', 'agent-host-opencode:/fixture/ses_e2e_nextup_1', '--cwd', proj, '--json', '--text=Line this up behind your work: add a size chart to the shop']);
  note('noted', noted);
  // where it lands is the reading model's call (a free one said Later or "this session's work" now and then); what this
  // step is about is a thing in line whose agent cannot start: put it in Next up as the line's own menu does
  const item = (noted.items || [])[0] || {};
  if (item.task && item.state === 'later') cli(ui, ['capture', 'lineup', item.task, '--json']);
  else if (item.task && item.state === 'working') cli(ui, ['capture', 'requeue', item.task, '--json']);
  const lined = cli(ui, ['nextup', '--json']);
  note('line_before', lined);
  assert.equal(lined.next.length, 1, 'one thing in Next up: ' + JSON.stringify(lined));
  // the person turns it on (Settings › Agents › Start by itself, the same as the line's own switch in a project's Tasks
  // tab; the Assistant's Now that showed the whole Mac's line went 2026-11-11)
  assert.equal(lined.paused, true, 'Start by itself is off before the person turns it on');
  cli(ui, ['nextup', 'resume', '--json']);
  const failed = await until(ui, async () => { const f = cli(ui, ['nextup', '--json']).failed; return f && f.task ? f : null; }, 'the start failing', 240000, 2000);
  note('failed_first', failed);
  assert.equal(failed.tries, 1);
  assert.match(failed.why, /did not start|not installed|not signed in/);
  assert.ok(failed.retry_at - Date.now() / 1000 > 20, 'tried again within 20 s: ' + JSON.stringify(failed));
  // not every 20 s: 45 s later it is still the first try
  await ui.sleep(45000);
  const still = cli(ui, ['nextup', '--json']).failed;
  note('failed_after_45s', still);
  assert.equal(still.tries, 1, 'it was tried again within a minute: ' + JSON.stringify(still));
  // Try again (the line's own button runs the same)
  cli(ui, ['nextup', 'retry', '--json']);
  // Try again clears it and the next round (within 20 s) tries at once: a new failure, counted from one
  const again = await until(ui, async () => { const f = cli(ui, ['nextup', '--json']).failed; return f && f.task && f.retry_at > still.retry_at ? f : null; }, 'Try again starting it at once', 240000, 2000);
  note('failed_after_try_again', again);
  assert.equal(again.tries, 1, 'Try again counts from one');
  await ui.screenshot('07-after-try-again');
}
