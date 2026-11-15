// OpenCode where every copy is older than 1.18: the input shows "OpenCode 1.14.31 is too old" with an Upgrade
// button instead of a 401 on the first message. The notice is the top of the input's shell (one rounded
// rectangle with the input), the input does not move when the notice comes and goes, and the upgrade wait
// has a progress bar. Start the instance so only a fake 1.14.31 can be found:
//   mkdir -p /tmp/dide-ocv-home/.opencode/bin   (this scenario writes the fake opencode itself, see FAKE below)
//   env HOME=/tmp/dide-ocv-home PATH=/tmp/dide-ocv-home/.opencode/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
//       dispatch ide instance start ocv-old --agents
// Run it with the same HOME (`env HOME=/tmp/dide-ocv-home dispatch ide e2e run ... --instance ocv-old`).
// OCV_THEME=light|dark picks the theme (the title bar's theme button of the test instance, never the real
// desktop); the fake is reset to 1.14.31 at the start, so restart the instance between two runs (the
// version is read at start). Screenshots are named <theme>-…; checks that fail throw.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1); // a loaded Mac's waits (runner.mjs TIME_SCALE)
export const meta = { instance: { motion: true, fixture: 'old-opencode' }, title: 'OpenCode version gate: too old', description: 'Notice above the input for OpenCode 1.14.31, joined to the input, Upgrade fails once, Retry shows a progress bar and succeeds, the notice goes away and the input never moves.' };
const fresh = '.sessions-chat-editor';
const picker = '.sessions-chat-session-type-picker';
const title = `[...document.querySelectorAll('.chat-input-notification-title')].map(e => e.textContent)`;
const body = `[...document.querySelectorAll('.chat-input-notification-description')].map(e => e.textContent)`;
const buttons = `[...document.querySelectorAll('.chat-input-notification-action-button')].map(e => e.textContent)`;
const inputRect = `(() => { const e = document.querySelector('.new-chat-input-area'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`;

// the fake opencode: --version says what its file says, `upgrade` bumps it, fails while $HOME/fail-upgrade
// exists, and takes 9 seconds while $HOME/slow-upgrade exists (so the progress bar can be photographed)
const FAKE = (version) => `#!/bin/sh
# fake opencode for the version-gate test
VERSION=${version}
case "$1" in
  --version) echo "$VERSION" ;;
  models) echo deepseek/deepseek-flash ;;
  upgrade)
    if [ -e "$HOME/fail-upgrade" ]; then echo "upgrade failed (fake)" >&2; exit 1; fi
    if [ -e "$HOME/slow-upgrade" ]; then sleep 9; fi
    sed 's/^VERSION=.*/VERSION=1.18.32/' "$0" > "$0.new" && chmod 755 "$0.new" && mv "$0.new" "$0" ;;
  *) echo "fake opencode: $*" >&2; exit 1 ;;
esac
`;

async function until(ui, fn, what, ms = 60000) {
  const end = Date.now() + ms * SCALE;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await ui.sleep(250);
  }
  throw new Error(`Timed out: ${what}`);
}

/** Everything the review asked for, read from the page: the shell geometry, type, button and colours. */
const MEASURE = `(() => {
  const n = document.querySelector('.chat-input-notice.chat-input-notification-widget');
  if (!n) return null;
  const stack = n.closest('.chat-input-stack');
  const input = stack.querySelector('.new-chat-input-area, .chat-input-container');
  const rect = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
  const cs = (e) => getComputedStyle(e);
  const corners = (e) => { const s = cs(e); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(parseFloat); };
  const visibleBg = (e) => cs(e).backgroundColor + ' over ' + cs(e).backgroundImage;
  const q = (sel) => n.querySelector(sel);
  const title = q('.chat-input-notification-title'), desc = q('.chat-input-notification-description'), btn = q('.chat-input-notification-action-button');
  const icon = q('.chat-input-notification-icon .codicon');
  const text2 = cs(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-descriptionForeground').trim();
  const probe = document.createElement('span'); probe.style.color = text2; document.body.appendChild(probe); const text2rgb = cs(probe).color; probe.remove();
  const out = {
    notice: rect(n), input: rect(input), noticeRadius: corners(n), inputRadius: corners(input),
    noticeBorder: { top: cs(n).borderTopColor, left: cs(n).borderLeftColor, right: cs(n).borderRightColor, bottomWidth: cs(n).borderBottomWidth, width: cs(n).borderTopWidth },
    inputBorder: { top: cs(input).borderTopColor, left: cs(input).borderLeftColor, right: cs(input).borderRightColor, bottom: cs(input).borderBottomColor, width: cs(input).borderLeftWidth, topWidth: cs(input).borderTopWidth },
    noticeBg: visibleBg(n), inputBg: visibleBg(input),
    text2: text2rgb,
    title: title && { fs: cs(title).fontSize, fw: cs(title).fontWeight },
    desc: desc && { fs: cs(desc).fontSize, fw: cs(desc).fontWeight, color: cs(desc).color },
    icon: icon && { color: cs(icon).color, size: rect(icon) },
    button: btn && { rect: rect(btn), padL: cs(btn).paddingLeft, padR: cs(btn).paddingRight, borderW: cs(btn).borderLeftWidth, fs: cs(btn).fontSize, fw: cs(btn).fontWeight, radius: cs(btn).borderTopLeftRadius, bg: cs(btn).backgroundColor },
    focused: !!stack.classList.contains('chat-input-stack-input-focused'),
  };
  const bar = q('.chat-input-notification-progress'), band = q('.chat-input-notification-progress-band');
  out.progress = bar && { rect: rect(bar), band: rect(band), radius: cs(bar).borderTopLeftRadius, bg: cs(bar).backgroundColor, bandBg: cs(band).backgroundColor, anim: cs(band).animationName + ' ' + cs(band).animationDuration + ' ' + cs(band).animationTimingFunction, role: bar.getAttribute('role') };
  return out;
})()`;

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
function checkShell(m, label) {
  const bad = [];
  const [nx, ny, nw, nh] = m.notice, [ix, iy, iw] = m.input;
  if (!near(nx, ix) || !near(nw, iw)) bad.push(`notice and input differ in x or width: ${m.notice} vs ${m.input}`);
  if (!near(ny + nh, iy)) bad.push(`notice bottom ${ny + nh} is not the input top ${iy}`);
  if (m.noticeRadius.join() !== '24,24,0,0') bad.push(`notice radius ${m.noticeRadius}, want 24,24,0,0`);
  if (m.inputRadius[0] !== 0 || m.inputRadius[1] !== 0 || m.inputRadius[2] !== 24 || m.inputRadius[3] !== 24) bad.push(`input radius ${m.inputRadius}, want 0,0,24,24`);
  if (m.noticeBorder.bottomWidth !== '0px') bad.push(`notice draws a bottom line: ${m.noticeBorder.bottomWidth}`);
  if (m.noticeBorder.width !== '1px' || m.inputBorder.width !== '1px') bad.push(`border widths ${m.noticeBorder.width} / ${m.inputBorder.width}`);
  if (m.noticeBorder.left !== m.inputBorder.left || m.noticeBorder.right !== m.inputBorder.right) bad.push(`side lines differ: notice ${m.noticeBorder.left}, input ${m.inputBorder.left}`);
  if (m.inputBorder.topWidth !== '0px') bad.push(`input keeps a top line: ${m.inputBorder.topWidth}`);
  if (m.noticeBg !== m.inputBg) bad.push(`fill differs: notice ${m.noticeBg}, input ${m.inputBg}`);
  if (m.title.fs !== '13px' || m.title.fw !== '500') bad.push(`title ${m.title.fs}/${m.title.fw}, want 13px/500`);
  if (m.desc.fs !== '12px' || m.desc.color !== m.text2) bad.push(`description ${m.desc.fs} ${m.desc.color}, want 12px ${m.text2}`);
  if (m.icon.color !== m.text2) bad.push(`icon ${m.icon.color}, want ${m.text2}`);
  if (m.button) {
    if (!near(m.button.rect[3], 24, 0.1)) bad.push(`button height ${m.button.rect[3]}`);
    if (m.button.padL !== '8px' || m.button.padR !== '8px' || m.button.borderW !== '0px') bad.push(`button sides ${m.button.padL}/${m.button.padR} border ${m.button.borderW}`);
    if (m.button.fs !== '12px' || m.button.fw !== '500') bad.push(`button type ${m.button.fs}/${m.button.fw}`);
  }
  if (bad.length) throw new Error(`${label}: ${bad.join('; ')}`);
}

async function setTheme(ui, mode) {
  await ui.setTheme(mode.toLowerCase());
}

async function pickEngine(ui, name) {
  if ((await ui.eval(`document.querySelector('${picker}')?.innerText.trim()`)) === name) return;
  await ui.click({ css: picker });
  await ui.click({ text: name, exact: true, within: '.context-view' });
  await ui.sleep(600);
}

export default async function (ui) {
  // the instance's own HOME where only the fake is (fixtures/old_opencode.py); by hand, the HOME it was started with
  const home = ui.rec.ocv_home || process.env.OCV_HOME || '/tmp/dide-ocv-home';
  const T = process.env.OCV_THEME === 'dark' ? 'dark' : 'light';
  const bin = `${home}/.opencode/bin/opencode`;
  mkdirSync(`${home}/.opencode/bin`, { recursive: true });
  rmSync(`${home}/fail-upgrade`, { force: true }); rmSync(`${home}/slow-upgrade`, { force: true });
  writeFileSync(bin, FAKE('1.14.31')); chmodSync(bin, 0o755);
  const result = { theme: T, steps: [], shell: {} };
  const log = (k, v) => { result.steps.push({ k, v }); };
  await ui.openAgents(ui.demoFolder);
  await setTheme(ui, T === 'dark' ? 'Dark' : 'Light');
  if (process.env.OCV_INJECT_CSS) {
    // dry run only: try a stylesheet before it is built into the app
    const css = (await import('node:fs')).readFileSync(process.env.OCV_INJECT_CSS, 'utf8');
    await ui.eval(`(() => { const s = document.createElement('style'); s.id = 'ocv-inject'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
  }
  await ui.newSession();

  // the baseline: where the input sits while another engine is picked (no notice)
  await ui.click({ css: picker });
  await ui.sleep(500);
  const engines = await ui.eval(`[...document.querySelectorAll('.context-view .action-label, .context-view [role=menuitem], .context-view .monaco-list-row')].map(e => e.textContent.trim()).filter(Boolean)`);
  await ui.press('Escape');
  log('engineChoices', engines);
  const other = engines.find(n => /^codex/i.test(n)) || engines.find(n => n && n !== 'OpenCode');
  if (!other) throw new Error(`No second engine to compare against: ${engines}`);
  await pickEngine(ui, other);
  await ui.sleep(1200);
  const baseline = await ui.eval(inputRect);
  log('baselineInput', baseline);
  await pickEngine(ui, 'OpenCode');
  await until(ui, async () => (await ui.eval(title)).length > 0, 'the version notice');
  await ui.sleep(700);
  const withNotice = await ui.eval(inputRect);
  log('input with notice', withNotice);
  if (!withNotice.every((v, i) => near(v, baseline[i]))) throw new Error(`The input moved when the notice appeared: ${baseline} -> ${withNotice}`);
  log('title', await ui.eval(title)); log('body', await ui.eval(body)); log('buttons', await ui.eval(buttons));
  await ui.click({ css: fresh });
  await ui.sleep(500);
  const m1 = await ui.eval(MEASURE);
  if (!m1.focused) throw new Error('The input does not report focus after a click');
  checkShell(m1, 'new session, input focused');
  result.shell.focused = m1;
  await ui.screenshot(`${T}-01-too-old`);
  await ui.mark({ css: '.chat-input-notice' }, { what: 'Version notice, the top of the input', where: 'Directly above the message box on a new OpenCode session, one rounded shell with the box', how: 'Shows while every OpenCode on this Mac is older than 1.18.0' });
  await ui.mark({ css: '.chat-input-notification-action-button' }, { what: 'Upgrade button', where: 'Right end of the notice', how: 'Click to run the upgrade' });
  // the line follows the focus: unfocused the shell keeps the quiet colour, still one colour on both parts
  await ui.eval(`document.activeElement && document.activeElement.blur()`);
  await ui.sleep(500);
  const m1b = await ui.eval(MEASURE);
  if (m1b.focused) throw new Error('The input still reports focus after blur');
  checkShell(m1b, 'new session, input not focused');
  result.shell.unfocused = m1b;
  await ui.screenshot(`${T}-01b-unfocused`);

  // a message must not hang on a 401: the answer says which version is installed and which is needed
  await ui.click({ css: fresh });
  await ui.type('Reply with the single word PONG.');
  await ui.press('Enter', { send: true });
  const answer = await until(ui, async () => {
    const t = await ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);
    return /older than|401|unauthori[sz]ed|not installed/i.test(t) && t;
  }, 'an answer to the first message', 60000);
  log('answerToFirstMessage', answer.slice(0, 300));
  if (/401|unauthori[sz]ed/i.test(answer)) throw new Error(`The first message still ends in an auth error: ${answer.slice(0, 200)}`);
  await ui.sleep(1500);
  if (await ui.eval(`!!document.querySelector('.interactive-session .chat-input-notification-title')`)) {
    const ms = await ui.eval(MEASURE);
    try { checkShell(ms, 'running session'); } catch (e) { if (!process.env.OCV_LENIENT) throw e; log('sessionCheckFailed', String(e.message)); }
    result.shell.session = ms;
  } else {
    log('sessionNotice', 'not shown in the running session');
  }
  await ui.screenshot(`${T}-01c-in-session`);

  // a new session: Upgrade fails once, then Retry runs slowly so the bar can be seen, then it succeeds
  await ui.newSession();
  await pickEngine(ui, 'OpenCode');
  await until(ui, async () => (await ui.eval(title)).length > 0, 'the version notice on the next new session');
  await ui.sleep(700);
  const startInput = await ui.eval(inputRect);
  writeFileSync(`${home}/fail-upgrade`, '1');
  await ui.click({ text: 'Upgrade', exact: true, within: '.chat-input-notification-widget' });
  await until(ui, async () => (await ui.eval(body)).some(t => /did not finish/.test(t)), 'the failed state');
  await ui.sleep(500);
  log('failedBody', await ui.eval(body)); log('failedButtons', await ui.eval(buttons));
  const m2 = await ui.eval(MEASURE);
  checkShell(m2, 'failed state');
  result.shell.failed = m2;
  const failedInput = await ui.eval(inputRect);
  if (!failedInput.every((v, i) => near(v, startInput[i]))) throw new Error(`The input moved in the failed state: ${startInput} -> ${failedInput}`);
  await ui.screenshot(`${T}-02-upgrade-failed`);
  rmSync(`${home}/fail-upgrade`);
  writeFileSync(`${home}/slow-upgrade`, '1');
  await ui.click({ text: 'Retry', exact: true, within: '.chat-input-notification-widget' });
  await until(ui, async () => ui.eval(`!!document.querySelector('.chat-input-notification-progress')`), 'the progress bar');
  await ui.sleep(300);
  const p1 = await ui.eval(MEASURE);
  await ui.screenshot(`${T}-03a-upgrading`);
  await ui.sleep(700);
  const p2 = await ui.eval(MEASURE);
  await ui.screenshot(`${T}-03b-upgrading`);
  log('upgradingTitle', await ui.eval(title)); log('upgradingBody', await ui.eval(body));
  result.shell.upgrading = { a: p1, b: p2 };
  checkShell({ ...p1, button: undefined }, 'upgrading state');
  if (!p1.progress || p1.progress.rect[3] !== 4 || p1.progress.radius !== '999px' || p1.progress.role !== 'progressbar') throw new Error(`Progress bar is wrong: ${JSON.stringify(p1.progress)}`);
  if (!/^dispatch-notice-sweep 1.5s linear/.test(p1.progress.anim)) throw new Error(`Progress animation is ${p1.progress.anim}`);
  if (p2?.progress && p1.progress.band[0] === p2.progress.band[0]) throw new Error('The progress band did not move between the two frames'); // gone by the second frame: the upgrade was done sooner
  const upgradingInput = await ui.eval(inputRect);
  if (!upgradingInput.every((v, i) => near(v, startInput[i]))) throw new Error(`The input moved while upgrading: ${startInput} -> ${upgradingInput}`);
  await until(ui, async () => (await ui.eval(title)).length === 0, 'the notice to go away after the upgrade', 90000);
  log('afterUpgradeTitles', await ui.eval(title));
  await ui.sleep(1200);
  const endInput = await ui.eval(inputRect);
  if (!endInput.every((v, i) => near(v, startInput[i]))) throw new Error(`The input moved when the notice went away: ${startInput} -> ${endInput}`);
  log('inputRects', { baseline, withNotice, startInput, failedInput, upgradingInput, endInput });
  await ui.screenshot(`${T}-04-after-upgrade`);
  writeFileSync(`${ui.out}/result-old-${T}.json`, JSON.stringify(result, null, 2));
}
