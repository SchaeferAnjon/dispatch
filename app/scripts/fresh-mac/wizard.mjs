// A new Mac's first run, clicked the way a person clicks it. first-run.sh runs this inside the VM from vm.sh with the
// app's own Electron as Node (scripts/ide-e2e/runner.mjs; `ui` is its Ui), right after opening Dispatch IDE from
// /Applications with nothing set up. Shell steps run as the person in a new Terminal (a login, interactive zsh).
// Each check prints PASS / FAIL (first-run.sh counts them) and goes into checks.json next to the screenshots; a
// failed check does not stop the run, so one run shows every problem (the 2026-10-06 run found ten by hand).
//
//   the first window: the Agents window with the setup wizard, What's new not on top of it      task-xrah
//   the wizard's agents page offers Install where Node.js is missing; it ends with dispatch.md   task-jvtg, nb3v
//   setup finishes; ~/.dispatch/rules has dispatch.md                                            task-nb3v
//   Terminal: dispatch begin / log / done make a task (the app's own bd), in English            task-oatt, ztry
//   no agent yet: the new-session page says so, a send says why at once                          task-6vw2
//   Install OpenCode there: offered within seconds, new sessions start on it                      task-jl50, 6vw2
//   Set up comes back in the title bar to connect it; its rules file then has Dispatch's rules   task-vgll, nb3v
//   (the block teaches Dispatch's tools, task_begin …, and the dispatch MCP server is in OpenCode's config)
//   OpenCode answers; it makes a task with dispatch from its own shell                            task-oatt
//   Migrations says the folders Dispatch linked are new, not that a backup is missing             task-4o71
//   Codex's Install on a Mac without Node.js says why                                             task-jvtg
//   a setup step that fails says which part and why (a skills folder made unwritable on purpose) task-4xxj
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = { title: 'A new Mac: first run', description: 'Setup wizard, a task in Terminal, installing an agent and its first answer, on a Mac with nothing on it.', timeout: 2700 };

const HOME = os.homedir();
const CJK = /[　-〿一-鿿＀-￯]/;
const checks = [];
let out = '';

function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1));
  return !!ok;
}

/** A command typed into a new Terminal window: login, interactive zsh, as the person. Kept in terminal.txt. */
function term(cmd, timeout = 180000) {
  let r;
  try {
    r = { ok: true, out: execFileSync('/bin/zsh', ['-lic', cmd], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { HOME, USER: os.userInfo().username, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }) };
  } catch (e) {
    r = { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.stdout || e.stderr ? '' : e.message}` };
  }
  fs.appendFileSync(path.join(out, 'terminal.txt'), `$ ${cmd}\n${r.out}${r.out.endsWith('\n') ? '' : '\n'}${r.ok ? '' : '(failed)\n'}\n`);
  return r;
}

/** A screenshot and its numbered boxes (<name>.boxes.json, the delivery page draws them): what each box is. */
async function shot(ui, name, items = []) {
  await ui.screenshot(name);
  const [w, h, dpr] = await ui.eval('[innerWidth, innerHeight, devicePixelRatio]');
  const doc = { size: [Math.round(w * dpr), Math.round(h * dpr)], items: [] };
  for (const it of items) {
    const hit = (await ui.candidates(it.spec).catch(() => ({ hits: [] }))).hits[0];
    if (hit) doc.items.push({ n: doc.items.length + 1, box: [hit.box.x, hit.box.y, hit.box.w, hit.box.h].map(v => Math.round(v * dpr)), color: 'red', what: it.what });
  }
  if (doc.items.length) fs.writeFileSync(path.join(out, `${name}.boxes.json`), JSON.stringify(doc, null, 1));
}

async function until(ui, fn, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn().catch(() => null);
    if (r) return r;
    if (Date.now() > end) return null;
    await ui.sleep(every);
  }
}

const text = (ui, css = 'body') => ui.eval(`document.querySelector(${JSON.stringify(css)})?.innerText || ''`);
const shown = (ui, needle) => ui.eval(`document.body.innerText.includes(${JSON.stringify(needle)})`);
// the notice above the input (the page's live region repeats its words after it is gone)
const notice = async (ui, needle) => (await text(ui, '.chat-input-notification-container')).includes(needle);

async function targetsNow(ui) {
  const r = await fetch(`http://127.0.0.1:${ui.port}/json/list`);
  return (await r.json()).filter(t => t.type === 'page');
}
const kindOf = url => /sessions\.html/.test(url) ? 'agents' : /workbench(\.esm)?\.html/.test(url) ? 'editor' : 'other';

/** Click Set up Dispatch (or Retry setup) and wait for Start or Retry setup; answers the extension trust dialog on the way. */
async function finishSetup(ui, label, button = 'Set up Dispatch') {
  // the button waits for the page's plan (the rules it will write): a click before that does nothing
  await until(ui, () => ui.eval(`[...document.querySelectorAll('.dispatch-onboarding .dob-btn')].some(b => b.innerText.trim() === ${JSON.stringify(button)} && b.getAttribute('aria-disabled') !== 'true' && !b.classList.contains('disabled'))`), 60000);
  await ui.click({ text: button, exact: true, within: '.dispatch-onboarding' });
  await ui.sleep(1500);
  const end = Date.now() + 360000;
  let result = '';
  while (Date.now() < end && !result) {
    if (await ui.exists({ text: 'Start', exact: true, within: '.dispatch-onboarding' })) result = 'start';
    else if (await ui.exists({ text: 'Retry setup', exact: true, within: '.dispatch-onboarding' })) result = 'retry';
    else if (await ui.exists({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' })) await ui.click({ text: 'Trust Publisher & Install', exact: true, within: '.monaco-dialog-box' });
    else await ui.sleep(1000);
  }
  await shot(ui, label, [{ spec: { css: '.dispatch-onboarding .dob-pr.failed' }, what: 'The step that did not finish, and why' }, { spec: { css: '.dispatch-onboarding p.dob-sub' }, what: 'What the page says about the whole setup' }]);
  return result;
}

/** Off the wizard's welcome and first-time tips. */
async function closeOverlays(ui) {
  for (let i = 0; i < 3; i++) {
    if (await ui.exists({ css: '.dispatch-whats-new-card' })) await ui.press('Escape');
    await ui.sleep(400);
  }
}

/** The new-session page (a new Mac has no project yet: its folder menu's Add Project... makes one, as a person does). */
async function newSessionPage(ui) {
  await closeOverlays(ui);
  if (!(await ui.exists({ css: '.sessions-chat-editor' }))) {
    await ui.click('New Session').catch(() => ui.press('Cmd+N'));
    await ui.sleep(1500);
  }
  if (!(await until(ui, () => ui.exists({ css: '.sessions-chat-editor' }), 30000))) return false;
  const inProject = () => ui.eval(`(document.querySelector('.new-session-workspace-picker-container')?.innerText || '').includes('demo')`);
  if (!(await inProject())) {
    // setup ends in the Assistant, whose page has no folder menu: a person makes the project from Projects then
    // ("No projects yet" · Add a project) and starts a session from its page; elsewhere the folder menu does it
    const viaProjects = await ui.exists({ css: '.new-session-workspace-picker-container.dispatch-assistant-page' });
    if (viaProjects) {
      await ui.click({ text: 'Projects', exact: true });
      await ui.waitFor({ css: 'button.dispatch-ap-empty-btn' }, { timeoutMs: 30000 });
      await ui.click({ css: 'button.dispatch-ap-empty-btn' });
    } else {
      await clickPastTips(ui, '.sessions-workspace-picker-trigger');
      await ui.click('Add Project...');
    }
    await ui.waitFor({ css: '.dispatch-ap' }, { timeoutMs: 15000 });
    await ui.click({ text: 'Start a new project', exact: true, within: '.dispatch-ap' });
    await ui.type('demo', { into: { css: '.dispatch-ap input[data-field="name"]' } });
    // a new Mac's Git has no name and email yet: the dialog asks for them, as they go on every commit
    for (const [field, value] of [['gitName', 'Fresh Mac'], ['gitEmail', 'fresh-mac@example.com']]) {
      const css = `.dispatch-ap input[data-field="${field}"]`;
      if (await ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); return !!e && !e.value.trim(); })()`)) {
        await ui.type(value, { into: { css } });
      }
    }
    await ui.press('Enter');
    await ui.waitFor({ css: '.dispatch-ap' }, { gone: true, timeoutMs: 240000 });
    // the folder Dispatch just made still asks whether its authors are trusted; a person says yes
    if (await until(ui, () => ui.exists({ text: 'Trust Folder & Continue', exact: true, within: '.monaco-dialog-box' }), 20000)) {
      await shot(ui, '08b-trust-new-project', [{ spec: { css: '.monaco-dialog-box' }, what: 'A folder Dispatch just made, and it asks to trust its authors' }]);
      await ui.click({ text: 'Trust Folder & Continue', exact: true, within: '.monaco-dialog-box' });
    }
    if (viaProjects) {
      // the project's page opens on its own after Add a project; its New Session starts there
      const pageButton = () => ui.eval(`(() => {
        const els = [...document.querySelectorAll('a, button, .monaco-button, .action-label')]
          .filter(e => (e.getAttribute('aria-label') || '').split(' (')[0].trim() === 'New Session' || (e.innerText || '').trim() === 'New Session')
          .map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.left > 400).sort((a, b) => b.left - a.left);
        return els[0] ? { x: els[0].left + els[0].width / 2, y: els[0].top + els[0].height / 2 } : null;
      })()`);
      const b = await until(ui, pageButton, 60000);
      if (!b) throw new Error("the project's page has no New Session after Add a project");
      await ui.mouse('mouseMoved', b.x, b.y);
      await ui.mouse('mousePressed', b.x, b.y, { clickCount: 1 });
      await ui.mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
    }
    await until(ui, inProject, 120000, 1000);
  }
  return inProject();
}

/** Click an element; a first-time tip lying on top of it is closed first, as a person would close it. */
async function clickPastTips(ui, css) {
  for (let i = 0; i < 4 && (await hitTest(ui, css)).startsWith('tip'); i++) {
    await ui.click({ css: '.dispatch-tour button.dispatch-tour-close' }).catch(() => ui.press('Escape'));
    await ui.sleep(600);
  }
  await ui.click({ css });
}

/** What is under the middle of an element: the element itself, or what covers it (a click there goes to that). */
const hitTest = (ui, css) => ui.eval(`(() => { const e = document.querySelector(${JSON.stringify(css)}); if (!e) return 'missing'; const r = e.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h && (h === e || e.contains(h)) ? 'itself' : !h ? 'nothing' : (h.closest('.dispatch-tour') ? 'tip: ' + h.closest('.dispatch-tour').innerText.split('\\n')[0] : h.tagName + '.' + String(h.className).slice(0, 80)); })()`);

async function focusInput(ui) {
  // the new-session page's box, or the one under a running session's chat
  const css = (await ui.exists({ css: '.sessions-chat-editor' })) ? '.sessions-chat-editor' : '.interactive-session .chat-input-container .monaco-editor';
  for (let i = 0; i < 8; i++) {
    await ui.click({ css: i % 2 ? `${css} .view-lines` : css });
    await ui.sleep(400);
    if (await ui.eval(`!!document.activeElement && !!document.activeElement.closest('${css}')`)) return true;
    await ui.sleep(600);
  }
  return false;
}

export default async function (ui) {
  out = ui.out;
  // FRESH_FROM=n starts at section n (a VM that is already past the first ones), FRESH_TO=m stops after section m
  const FROM = Number(process.env.FRESH_FROM || 1);
  const TO = Number(process.env.FRESH_TO || 99);
  if (FROM > 1) await ui.attach('agents', 60000);

  // 1 the first window a person sees
  if (FROM <= 1 && 1 <= TO) {
    const pages = await until(ui, async () => { const p = await targetsNow(ui); return p.some(t => kindOf(t.url) !== 'other') ? p : null; }, 60000);
    const kinds = (pages || []).map(t => kindOf(t.url));
    check('the first window is the Agents window, not the editor (task-xrah)', kinds.includes('agents') && !kinds.includes('editor'), kinds.join(', '));
    await ui.attach('agents', 60000);
    const wizard = await until(ui, () => ui.exists({ css: '.dispatch-onboarding' }), 90000);
    check('the setup wizard is up by itself', wizard);
    await ui.sleep(3000); // What's new used to come up a moment later, on top of the wizard
    // the What's new card (its welcome is also called Welcome to Dispatch, like the wizard's first page)
    const welcome = await ui.exists({ css: '.dispatch-whats-new-card' });
    check("What's new waits for the wizard (task-xrah)", !welcome);
    await shot(ui, '01-first-window', [{ spec: { css: '.dispatch-onboarding' }, what: 'The setup wizard, in the Agents window, first thing on screen' }]);

  }

  // 2 the agents page: Install where Node.js is missing
  if (FROM <= 2 && 2 <= TO) {
    // the page looks at this Mac first ("It only takes a moment."): read it once its rows are drawn, as a person does
    const t0 = Date.now();
    const drawn = await until(ui, () => ui.eval(`!document.querySelector('.dispatch-onboarding .dob-skeleton') && !!document.querySelector('.dispatch-onboarding .dob-r')`), 30000);
    check('the agents page is drawn within 30 s ("It only takes a moment.")', !!drawn, `${((Date.now() - t0) / 1000).toFixed(1)} s after the first look`);
    const first = await text(ui, '.dispatch-onboarding');
    const installs = await ui.eval(`[...document.querySelectorAll('.dispatch-onboarding .dob-r .monaco-button, .dispatch-onboarding .dob-r button')].filter(b => b.innerText.trim() === 'Install').length`);
    check('the agents page offers Install for Claude Code and OpenCode on a Mac without Node.js (task-jvtg)', installs >= 2, `${installs} Install buttons`);
    await shot(ui, '02-wizard-agents', [{ spec: { text: 'Install', exact: true, within: '.dispatch-onboarding' }, what: 'Install, on a Mac without Node.js' }]);

  }

  // 3 on through the pages to Set up Dispatch
  if (FROM <= 3 && 3 <= TO) {
    for (let i = 0; i < 10 && !(await ui.exists({ text: 'Set up Dispatch', exact: true, within: '.dispatch-onboarding' })); i++) {
      await ui.click({ css: '.dob-foot .dob-btn.fill' });
      await ui.sleep(1500);
    }
    // the last page lists what it will set up once it has looked (a busy Mac takes a while): read it then
    await until(ui, async () => /dispatch\.md/.test(await text(ui, '.dispatch-onboarding')), 30000);
    const last = await text(ui, '.dispatch-onboarding');
    check("the last page lists Dispatch's own rules, dispatch.md, built in (task-nb3v)", /dispatch\.md/.test(last) && /Built in/.test(last) && !/Missing from this copy/.test(last), (last.match(/dispatch\.md[^\n]*/) || [''])[0]);
    check('with no agent the last page says where to install one and that Set up comes back (task-vgll)', /Go Back to install one/.test(last) && !/run Set up again from the title bar/.test(last), (last.match(/No agent is installed yet[^\n]*/) || [''])[0]);
    await shot(ui, '03-wizard-connect', [{ spec: { text: 'dispatch.md', exact: true, within: '.dispatch-onboarding' }, what: "Dispatch's own rules, built in" }, { spec: { css: '.dispatch-onboarding p.dob-note' }, what: 'Where to install an agent' }]);
    const setup = await finishSetup(ui, '04-setup-done');
    check('setup finishes', setup === 'start', setup === 'retry' ? await text(ui, '.dispatch-onboarding .dob-well.prog') : setup || 'no Start after 6 min');
    if (setup === 'start') await ui.click({ text: 'Start', exact: true, within: '.dispatch-onboarding' });
    await ui.sleep(7000); // the window lands on the Assistant after setup
    if (await ui.exists({ css: '.dispatch-whats-new-card' })) { await ui.screenshot('05-welcome-after-setup'); }
    await closeOverlays(ui);

  }

  // 4 what setup left on disk, and a task made in a new Terminal
  if (FROM <= 4 && 4 <= TO) {
    const md = term('test -s ~/.dispatch/rules/dispatch.md && head -c 200 ~/.dispatch/rules/dispatch.md');
    check("setup put Dispatch's agent rules in ~/.dispatch/rules/dispatch.md (task-nb3v)", md.ok, md.out.split('\n')[0]);
    const where = term('command -v dispatch');
    check('a new Terminal finds the dispatch command', where.ok && /dispatch$/.test(where.out.trim()), where.out.trim());
    const begin = term('cd ~ && dispatch begin "Board check: the first task on this Mac" -P demo -d "A new person makes the first task in Terminal to see that the task board works from start to end." 2>&1');
    const id = (begin.out.match(/task-[a-z0-9]+/) || [''])[0];
    check('dispatch begin makes a task in Terminal with the bd inside the app (task-oatt)', begin.ok && !!id, begin.out.trim().split('\n').pop());
    check('what dispatch begin says is in English (task-ztry)', /created and claimed/.test(begin.out) && !CJK.test(begin.out), begin.out.trim().split('\n').pop());
    if (id) {
      const log = term(`dispatch log ${id} "made from Terminal on a new Mac" 2>&1 && dispatch done ${id} --reason "checked in Terminal" 2>&1`);
      check('dispatch log and done answer in English (task-ztry)', log.ok && /logged/.test(log.out) && /done/.test(log.out) && !CJK.test(log.out), log.out.trim().replace(/\n/g, ' | '));
    }
    const codex = term('dispatch engines upgrade codex --json 2>&1');
    check('installing Codex without Node.js says why (task-jvtg)', /no_installer/.test(codex.out) && /Node\.js/.test(codex.out), (codex.out.match(/"message": "[^"]*"/) || [codex.out.slice(-200)])[0]);

  }

  // 5 no agent yet: the new-session page says so and a send says why
  if (FROM <= 5 && 5 <= TO) {
    const page = await newSessionPage(ui);
    check('the new-session page opens', page);
    const up = await until(ui, () => notice(ui, 'No agent on this Mac yet'), 30000);
    check('with no agent the new-session page says so, with Install buttons (task-6vw2)', up && await ui.exists({ text: 'Install OpenCode', exact: true }), up ? 'notice up' : 'no notice');
    const picker = await ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim() || ''`);
    check('with no agent the agent picker says No agent yet, not Claude Code (task-bp58a)', picker === 'No agent yet', `picker says ${picker}`);
    await shot(ui, '06-no-agent', [{ spec: { css: '.chat-input-notification-container' }, what: 'No agent on this Mac yet, with Install buttons' }]);
    if (await focusInput(ui)) {
      await ui.type('hello');
      await ui.press('Enter', { send: true });
      const said = await until(ui, () => ui.eval(`[...document.querySelectorAll('.notifications-toasts .notification-toast')].some(t => t.innerText.includes('No agent is on this Mac yet'))`), 10000);
      const kept = await ui.eval(`(document.querySelector('.sessions-chat-editor')?.innerText || '').includes('hello')`);
      check('sending with no agent says why at once and keeps the text (task-6vw2)', said && kept, `toast ${!!said}, text kept ${kept}`);
      await ui.press('End');
      for (let i = 0; i < 6; i++) await ui.press('Backspace');
      await shot(ui, '07-send-without-agent', [{ spec: { css: '.notifications-toasts .notification-toast' }, what: 'Why it was not sent' }, { spec: { css: '.sessions-chat-editor' }, what: 'The text is kept' }]);
    } else {
      check('the message box takes the focus', false);
    }

  }

  // 6 install OpenCode from there
  if (FROM <= 6 && 6 <= TO) {
    // the input had the focus (the message above): the button must take the click all the same
    if (await focusInput(ui)) await ui.sleep(300);
    const under = await hitTest(ui, '.chat-input-notification-container .monaco-button');
    check('the Install button is not covered while the input has the focus', under === 'itself', under);
    await ui.click({ text: 'Install OpenCode', exact: true });
    check('a click on Install OpenCode starts the install', await until(ui, () => notice(ui, 'Installing OpenCode'), 8000, 300));
    await ui.sleep(1000);
    await shot(ui, '08-installing-opencode', [{ spec: { css: '.chat-input-notification-container' }, what: 'Installing OpenCode' }]);
    const t0 = Date.now();
    const gone = await until(ui, async () => !(await notice(ui, 'No agent on this Mac yet')) && !(await notice(ui, 'Installing OpenCode')), 420000, 1000);
    const failedInstall = await notice(ui, 'could not be installed');
    check('Install OpenCode on the new-session page works', gone && !failedInstall, failedInstall ? await text(ui, '.chat-input-notification-container') : `${Math.round((Date.now() - t0) / 1000)} s`);
    const t1 = Date.now();
    const picked = await until(ui, async () => (await ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim()`)) === 'OpenCode', 60000, 1000);
    check('OpenCode is offered within seconds, and a new session starts on it (task-jl50, task-6vw2)', picked, picked ? `${Math.round((Date.now() - t1) / 1000)} s after the install` : `picker says ${await ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim()`)}`);
    await shot(ui, '09-opencode-ready', [{ spec: { css: '.sessions-chat-session-type-picker' }, what: 'OpenCode, without a restart' }]);

  }

  // 7 Set up comes back to connect it
  if (FROM <= 7 && 7 <= TO) {
    const pill = await until(ui, () => ui.exists({ css: '.dispatch-setup-entry' }), 40000);
    check('Set up is in the title bar to connect OpenCode (task-vgll)', pill);
    await shot(ui, '10-setup-in-title-bar', [{ spec: { css: '.dispatch-setup-entry' }, what: 'Set up, to connect OpenCode' }]);
    if (pill) {
      // the wizard from the Command Palette this time (Set Up Dispatch): Set up goes from the title bar at once and
      // stays away while the wizard is up (task-bp58a)
      await ui.press('F1');
      await ui.type('Set Up Dispatch');
      await ui.sleep(800);
      await ui.press('Enter');
      const seen = [];
      for (let i = 0; i < 12; i++) {
        seen.push(await ui.exists({ css: '.dispatch-setup-entry' }) ? 'pill' : '-');
        await ui.sleep(250);
      }
      await until(ui, () => ui.exists({ text: 'Set up Dispatch', exact: true, within: '.dispatch-onboarding' }), 60000);
      for (let i = 0; i < 8; i++) {
        seen.push(await ui.exists({ css: '.dispatch-setup-entry' }) ? 'pill' : '-');
        await ui.sleep(250);
      }
      check('opened from the Command Palette, the wizard has no Set up next to it in the title bar (task-bp58a)', !seen.includes('pill'), seen.join(''));
      await shot(ui, '11-connect-opencode', [{ spec: { css: '.dispatch-onboarding .dob-row.agent' }, what: 'OpenCode gets the rules block and the plugin' }]);
      const again = await finishSetup(ui, '12-connect-done');
      check('connecting OpenCode finishes', again === 'start', again === 'retry' ? await text(ui, '.dispatch-onboarding .dob-well.prog') : again);
      if (again === 'start') await ui.click({ text: 'Start', exact: true, within: '.dispatch-onboarding' });
      await ui.sleep(7000); // the window lands on the Assistant after setup
      await closeOverlays(ui);
    }
    // the rules teach Dispatch's tools (task_begin …, 10-08 Soul), which OpenCode reaches through the dispatch MCP server
    const rules = term('grep -c "BEGIN DISPATCH GLOBAL RULES" ~/.config/opencode/AGENTS.md; grep -c "task_begin" ~/.config/opencode/AGENTS.md; grep -c \'"dispatch"\' ~/.config/opencode/opencode.json*');
    const [block, usage, server] = rules.out.trim().split('\n').map(Number);
    check("OpenCode's rules have Dispatch's block with how to use the task board, and its tools are there (task-nb3v)", block >= 1 && usage >= 1 && server >= 1, `block ${block}, mentions of task_begin ${usage}, dispatch MCP server ${server}`);

  }

  // 8 OpenCode answers, and makes a task from its own shell (its free models are on OpenCode's servers: a busy one
  // can answer "Endpoint is unavailable", so a turn that ends with no answer is asked once more)
  if (FROM <= 8 && 8 <= TO) {
    await newSessionPage(ui);
    await until(ui, async () => (await ui.eval(`document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim()`)) === 'OpenCode', 30000);
    const lastReply = () => ui.eval(`(() => { const r = [...document.querySelectorAll('.interactive-response')].at(-1); return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);
    const ask = async (message, want, ms) => {
      if (!(await focusInput(ui))) return '';
      await ui.type(message);
      await ui.press('Enter', { send: true });
      const end = Date.now() + ms;
      let reply = '';
      while (Date.now() < end) {
        for (const label of ['Allow', 'Always Allow', 'Approve', 'Allow Once']) {
          if (await ui.exists({ text: label, exact: true, within: '.interactive-session' })) await ui.click({ text: label, exact: true, within: '.interactive-session' });
        }
        reply = await lastReply();
        if (want.test(reply)) break;
        await ui.sleep(2000);
      }
      return reply;
    };
    let pong = await ask('Reply with exactly one word: PONG', /PONG/, 240000);
    if (!/PONG/.test(pong)) pong = await ask('Reply with exactly one word: PONG', /PONG/, 240000);
    await shot(ui, '13-opencode-answers', [{ spec: { css: '.interactive-response' }, what: "OpenCode's answer" }]);
    check('OpenCode answers', /PONG/.test(pong), pong.trim().slice(-200));
    const made = await ask('Run this in your shell: dispatch begin "Agent check: OpenCode makes a task" -P demo -d "OpenCode on a new Mac makes a task with the dispatch command to show agents can use the task board." Then reply with the task id it printed.', /task-[a-z0-9]+/, 360000);
    await shot(ui, '13b-opencode-makes-a-task', [{ spec: { css: '.interactive-response' }, what: 'OpenCode ran dispatch begin' }]);
    const board = term('dispatch task list --project demo --status all --json 2>&1 | head -c 4000');
    check('OpenCode made a task with dispatch from its shell (task-oatt)', /Agent check: OpenCode makes a task/.test(board.out), (made.match(/task-[a-z0-9]+/) || [''])[0] || made.trim().slice(-160));
  }

  // 9 Migrations on a Mac that had no agents folder
  if (FROM <= 9 && 9 <= TO) {
    await ui.openCustomizations('Migrations');
    await until(ui, () => ui.exists({ css: '.dispatch-import-row' }), 45000);
    const mig = await ui.eval(`[...document.querySelectorAll('.dispatch-import-row')].map(r => r.innerText.replace(/\\s+/g, ' ')).join('\\n')`);
    check('Migrations says the folders Dispatch linked are new, not that a backup is missing (task-4o71)', !/backup is missing/.test(mig) && /no folder here before/.test(mig), (mig.match(/[^\n]*no folder here before[^\n]*/) || [''])[0]);
    await shot(ui, '14-migrations', [{ spec: { text: 'New link: there was no folder here before, so there is nothing to restore.', exact: true }, what: 'A new link, nothing missing' }]);

  }

  // 10 Codex's Install on a Mac without Node.js: Settings (⌘,) › Agents, where a person installs an agent now
  if (FROM <= 10 && 10 <= TO) {
    if (!(await ui.exists({ css: '.part.sidebar.dispatch-settings-open .dispatch-settings-nav', webview: false }))) await ui.press('Cmd+,');
    await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="agents"]', webview: false });
    const row = '.dispatch-settings-page .dset-row[data-agent="codex"]';
    await until(ui, () => ui.exists({ css: row }), 20000);
    await ui.click({ text: 'Install', exact: true, within: row });
    const toast = await until(ui, () => ui.eval(`[...document.querySelectorAll('.notifications-toasts .notification-toast')].map(t => t.innerText).find(t => t.includes('Codex')) || ''`), 60000);
    check("Codex's Install says why it failed and what to do (task-jvtg)", !!toast && /Node\.js/.test(toast), String(toast).replace(/\s+/g, ' '));
    await shot(ui, '15-codex-install-failed', [{ spec: { css: '.notifications-toasts .notification-toast' }, what: 'Why Codex was not installed, and what to do' }, { spec: { css: row }, what: 'Codex in Settings › Agents' }]);
    await ui.press('Escape');
  }

  // 11 a step that fails says which part and why: OpenCode's skills folder made unwritable on purpose
  if (FROM <= 11 && 11 <= TO) {
    term('rm -rf ~/.config/opencode/skills && mkdir -p ~/.config/opencode && touch ~/.config/opencode/skills');
    const reopen = await (async () => { try { await ui.click({ css: '.dispatch-setup-entry' }); return true; } catch { return false; } })();
    if (!reopen) {
      // Set up is not in the title bar once everything is connected: the setup's own command reopens it
      await ui.press('F1');
      await ui.type('Set Up Dispatch');
      await ui.sleep(800);
      await ui.press('Enter');
    }
    await until(ui, () => ui.exists({ css: '.dispatch-onboarding' }), 30000);
    for (let i = 0; i < 10 && !(await ui.exists({ text: 'Set up Dispatch', exact: true, within: '.dispatch-onboarding' })); i++) {
      await ui.click({ css: '.dob-foot .dob-btn.fill' });
      await ui.sleep(1500);
    }
    const broken = await finishSetup(ui, '16-setup-step-failed');
    const prog = await text(ui, '.dispatch-onboarding');
    check('a failed step says which part and why, and the page does not say ready (task-4xxj)', broken === 'retry' && /Could not add/.test(prog) && !/Your setup is ready/.test(prog), (prog.match(/Could not add[^\n]*/) || [prog.slice(0, 200)])[0]);
    term('rm -f ~/.config/opencode/skills');
    if (broken === 'retry') {
      const fixed = await finishSetup(ui, '17-setup-retried', 'Retry setup').catch(() => '');
      if (fixed === 'start') await ui.click({ text: 'Start', exact: true, within: '.dispatch-onboarding' });
    }

  }

  const failed = checks.filter(c => !c.ok).length;
  console.log(`  checks: ${checks.length - failed} passed, ${failed} failed`);
}
