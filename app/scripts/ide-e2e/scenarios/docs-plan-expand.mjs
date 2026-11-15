// A Docs row's source-task card: the plan is open when the card appears; the progress line closes it in place and opens it again.
// Real pointer and keyboard on the instance's demo project; no engine messages.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const meta = { title: 'Docs 悬停卡的计划进度默认展开', description: '悬停文档行出源任务卡，计划默认展开每条方向和状态；点进度行收起、再点展开，外框不动；收起不被记住；键盘 Enter 同样切换；浅深两色截图。' };

function cli(ui, args) {
  const rec = ui.rec, env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(key) && key !== 'CLAUDECODE') env[key] = value;
  }
  Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, 'Contents/Resources/app/tools')}:${process.env.PATH}` });
  const r = spawnSync('python3', [rec.cli, ...args], { env, encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) throw new Error(`dispatch ${args[0]}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function theme(ui, value) {
  for (const dir of [ui.rec.user_data_dir, ui.rec.agents_user_data_dir]) {
    const file = path.join(dir, 'User/settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(settings, { 'window.autoDetectColorScheme': false, 'workbench.colorTheme': value === 'light' ? 'Dispatch Light' : 'Dispatch Dark' });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  }
  const wanted = value === 'light' ? 'vs' : 'vs-dark';
  for (let i = 0; i < 40; i++) {
    if (await ui.eval(`document.querySelector('.monaco-workbench').classList.contains('${wanted}')`)) return;
    await ui.sleep(250);
  }
  throw new Error(`theme did not change: ${value}`);
}

async function away(ui) {
  // the card now opens left of the right panel, over the middle: leave through the title bar, and wait out the
  // card's grace period (VS Code-like, 400 ms)
  const r = await ui.eval(`({ x: Math.round(innerWidth / 2), y: 8 })`);
  await ui.mouse('mouseMoved', r.x, r.y);
  await ui.sleep(700);
}

async function capture(ui, name) {
  return ui.step('screenshot', name, async step => {
    const clip = await ui.eval(`(() => {
      const el = [...document.querySelectorAll('.part.editor .editor-group-container')].find(e => e.getBoundingClientRect().width > 0 && e.querySelector('.tabs-container'));
      const b = el.getBoundingClientRect(), p = document.querySelector('.dispatch-linked-preview')?.getBoundingClientRect();
      const x = Math.min(b.x, p ? p.x - 4 : b.x), bottom = p ? p.bottom + 8 : b.bottom;
      return { x, y: b.y, width: b.right - x, height: Math.min(innerHeight, bottom) - b.y, scale: 1 };
    })()`);
    const image = await ui.cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    const file = `${name}.png`;
    const png = Buffer.from(image.data, 'base64');
    fs.writeFileSync(path.join(ui.out, file), png);
    step.shot = file; step.clip = clip; ui.shots.push(file);
    const elements = await ui.eval(`(() => {
      const selectors = ['.dispatch-docs-row.dispatch-linked', '.dispatch-linked-plan-toggle', '.dispatch-linked-plan:not([hidden])'];
      return selectors.map((selector, i) => {
        const b = document.querySelector(selector)?.getBoundingClientRect();
        return b && { n: i + 1, box: [b.x, b.y, b.width, b.height] };
      }).filter(Boolean);
    })()`);
    // CDP screenshots use device pixels, while DOM rectangles use CSS pixels.
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
    const sx = size[0] / clip.width, sy = size[1] / clip.height;
    const items = elements.map(item => ({ ...item, box: [(item.box[0] - clip.x) * sx, (item.box[1] - clip.y) * sy, item.box[2] * sx, item.box[3] * sy], color: 'red' }));
    fs.writeFileSync(path.join(ui.out, `${name}.boxes.json`), JSON.stringify({ size, items }, null, 2));
    if (name === 'dark-1-open') {
      const notes = [
        { what: '关联文档', where: '右侧 Docs 列表', how: '悬停文档行，显示源任务卡' },
        { what: '计划进度', where: '源任务卡下部', how: '点击收起，再点展开；Tab 聚焦后 Enter 同样切换' },
        { what: '计划方向与状态', where: '进度行下方', how: '卡片一出现就展开，列出完成、进行中和待做的每条方向' },
      ];
      fs.writeFileSync(path.join(ui.out, '00-where.json'), JSON.stringify({ image: file, items: items.map(item => ({ ...item, ...notes[item.n - 1] })) }, null, 2));
    }
    return file;
  });
}

export default async function(ui) {
  const task = ui.rec.seed.tasks.in_progress;
  const file = path.join(ui.demoFolder, 'NOTES.md');
  cli(ui, ['task', 'deliver', task, '--file', file]);
  cli(ui, ['task', 'plan', task, '--active', '2']);
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const errors = [], checks = [];
  ui.cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  const expect = async (name, expression) => {
    if (!(await ui.eval(expression))) {
      fs.writeFileSync(path.join(ui.out, 'failure-state.json'), JSON.stringify(await ui.eval(`({focus: document.activeElement?.outerHTML.slice(0, 300), preview: document.querySelector('.dispatch-linked-preview')?.outerHTML.slice(0, 3000)})`), null, 2));
      throw new Error(name);
    }
    checks.push(name);
  };
  const doc = `.dispatch-docs-row[data-doc-path=${JSON.stringify(file)}]`;
  const preview = '.dispatch-linked-preview:not(.loading)';
  const toggle = `${preview} .dispatch-linked-plan-toggle`;
  const list = `${preview} .dispatch-linked-plan`;
  const steps = `JSON.stringify([...document.querySelectorAll('${list} li')].map(li => [li.className, li.innerText.trim(), li.querySelector('.codicon')?.className.match(/codicon-[a-z-]+/)?.[0]]))`;
  const want = JSON.stringify([['done', 'Read the wiki', 'codicon-pass-filled'], ['active', 'Draw the page', 'codicon-circle-large'], ['todo', 'Wire it to the CLI', 'codicon-circle-large']]);

  // Top, bottom, left, right of the card and top, bottom of its Show button, in CSS px.
  const frameOf = () => ui.eval(`(() => { const p = document.querySelector('${preview}').getBoundingClientRect(), b = document.querySelector('${preview} .dispatch-linked-open').getBoundingClientRect(); return [p.top, p.bottom, p.left, p.right, b.top, b.bottom]; })()`);
  const same = (name, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    checks.push(name);
  };
  const frames = {};
  const toggleStyle = `(() => { const t = document.querySelector('${toggle}'), s = getComputedStyle(t); return { outline: s.outlineStyle, outlineWidth: s.outlineWidth, background: s.backgroundColor, border: s.borderTopWidth, hover: t.matches(':hover') }; })()`;
  const iconColors = `(() => Object.fromEntries([...document.querySelectorAll('${list} li')].map(li => { const i = li.querySelector('.codicon'), s = getComputedStyle(i); return [li.className, { color: s.color, opacity: getComputedStyle(li.querySelector('.dispatch-plan-circle')).opacity, li: getComputedStyle(li).color, weight: getComputedStyle(li).fontWeight }]; })))()`;
  await ui.openTab('Docs');
  await ui.waitFor({ css: doc }, { timeoutMs: 30000 });
  for (const color of ['light', 'dark']) {
    await theme(ui, color);
    await ui.openTab('Docs');
    await ui.waitFor({ css: doc }, { timeoutMs: 30000 });
    await away(ui);
    await ui.hover({ css: doc });
    await ui.waitFor({ css: toggle }, { timeoutMs: 35000 });
    // The plan is open when the card appears: every step and its state are already there, nothing was clicked.
    await expect(`${color}: the card appears with the plan open`, `(() => { const t = document.querySelector('${toggle}'); return t.tagName === 'BUTTON' && t.getAttribute('aria-expanded') === 'true' && t.innerText.includes('1 of 3 steps done · Draw the page') && !document.querySelector('${list}').hidden; })()`);
    await expect(`${color}: every step with its state, from the first frame`, `${steps} === ${JSON.stringify(want)}`);
    await expect(`${color}: the open arrow already points down`, `(() => { const s = getComputedStyle(document.querySelector('${toggle} .codicon')); return s.transform === 'matrix(0, 1, -1, 0, 0, 0)'; })()`);
    await expect(`${color}: card keeps no duplicate progress note`, `!document.querySelector('${preview} .dispatch-hover-note')`);
    await expect(`${color}: the open card stays inside the window`, `(() => { const r = document.querySelector('${preview}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
    await expect(`${color}: Docs stays selected, the row still linked`, `!!document.querySelector('.tabs-container .tab[aria-label^="Docs"][aria-selected="true"]') && document.querySelector(${JSON.stringify(doc)}).classList.contains('dispatch-linked')`);
    frames[`${color}-open`] = await frameOf();
    const icons = await ui.eval(iconColors);
    // DESIGN.md「符号表」(task-o01fh): done the grey filled check, where it is and not started the grey large ring, the
    // step it is on told by its strong words; nothing faint
    if (icons.todo.opacity !== '1' || icons.done.opacity !== '1' || icons.active.opacity !== '1' || icons.active.color !== icons.todo.color || icons.todo.color !== icons.done.color || icons.active.weight !== '500') throw new Error(`${color}: the circles do not read done / in progress / not started: ${JSON.stringify(icons)}`);
    checks.push(`${color}: the check filled, the rings grey, the step it is on in strong words`);
    await capture(ui, `${color}-1-open`);
    // Real pointer: from the row into the card, onto the progress line, click closes it in place.
    await ui.hover({ css: toggle });
    await ui.sleep(300);
    await ui.click({ css: toggle });
    await expect(`${color}: click closes the plan`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'false' && document.querySelector('${list}').hidden`);
    await expect(`${color}: Docs stays selected, the row still linked after the click`, `!!document.querySelector('.tabs-container .tab[aria-label^="Docs"][aria-selected="true"]') && document.querySelector(${JSON.stringify(doc)}).classList.contains('dispatch-linked')`);
    await ui.sleep(250);
    same(`${color}: hover card frame and Show button unchanged when the plan closes`, frames[`${color}-open`], await frameOf());
    const style = await ui.eval(toggleStyle);
    if (style.outline !== 'none' || style.border !== '0px') throw new Error(`${color}: the toggle draws a frame after a click: ${JSON.stringify(style)}`);
    if (!style.hover || style.background === 'rgba(0, 0, 0, 0)') throw new Error(`${color}: no hover background on the toggle: ${JSON.stringify(style)}`);
    checks.push(`${color}: no frame after a click, hover background on the toggle`);
    await expect(`${color}: the closed arrow points right in 200ms`, `(() => { const s = getComputedStyle(document.querySelector('${toggle} .codicon')); return s.transform === 'none' && s.transitionDuration === '0.2s'; })()`);
    await capture(ui, `${color}-2-closed`);
    await ui.click({ css: toggle });
    await expect(`${color}: second click opens it again`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true' && !document.querySelector('${list}').hidden`);
    same(`${color}: hover card frame unchanged when the plan opens again`, frames[`${color}-open`], await frameOf());
    // A closed plan is not remembered: leave, come back, the card starts open again.
    await ui.click({ css: toggle });
    await ui.press('Escape');
    await away(ui);
    await ui.sleep(300);
    await expect(`${color}: the card is gone after leaving`, `!document.querySelector('.dispatch-linked-preview')`);
    await ui.click({ css: '.dispatch-docs-group-head' });
    await ui.click({ css: '.dispatch-docs-group-head' });
    await ui.hover({ css: doc });
    await ui.waitFor({ css: toggle }, { timeoutMs: 35000 });
    await expect(`${color}: a closed plan is not remembered, the card starts open`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true' && !document.querySelector('${list}').hidden`);
    same(`${color}: hover card frame is the same on every appearance`, frames[`${color}-open`], await frameOf());
    // Keyboard: Tab from the row lands on the toggle, Enter closes, Enter opens, Esc clears.
    await ui.press('Escape');
    await away(ui);
    await ui.click({ css: '.dispatch-docs-group-head' });
    await ui.click({ css: '.dispatch-docs-group-head' });
    for (let i = 0; i < 20; i++) {
      await ui.press('Tab');
      if (await ui.eval(`document.activeElement?.matches(${JSON.stringify(doc)})`)) break;
    }
    await ui.waitFor({ css: toggle }, { timeoutMs: 35000 });
    await ui.press('Tab');
    await expect(`${color}: Tab reaches the toggle`, `document.activeElement?.matches('.dispatch-linked-plan-toggle')`);
    await expect(`${color}: keyboard focus keeps its ring`, `(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle === 'solid' && s.outlineWidth === '1px'; })()`);
    await expect(`${color}: the keyboard card starts open too`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true'`);
    await ui.press('Enter');
    await expect(`${color}: Enter closes`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'false' && document.activeElement?.matches('.dispatch-linked-plan-toggle')`);
    same(`${color}: hover card frame unchanged on Enter`, frames[`${color}-open`], await frameOf());
    await ui.press('Enter');
    await expect(`${color}: Enter opens`, `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true'`);
    await ui.press('Escape');
    await expect(`${color}: Esc clears the card`, `!document.querySelector('.dispatch-linked-preview')`);
  }
  // A plan longer than the window: the card is capped, the list scrolls inside it, the Show button stays at the card bottom.
  const long = Array.from({ length: 8 }, (_, i) => `Step ${i + 1} of a long plan: this direction is written long enough to wrap onto a second and a third line inside the card`);
  cli(ui, ['task', 'plan', task, ...long.flatMap(text => ['--set', text])]);
  cli(ui, ['task', 'plan', task, '--active', '2']);
  await ui.press('Escape');
  await away(ui);
  await ui.openTab('Tasks'); // rebuild the Docs rows: Esc leaves the last row suppressed until the pointer leaves it
  await ui.openTab('Docs');
  await ui.waitFor({ css: doc }, { timeoutMs: 30000 });
  await ui.sleep(11000); // the hover reads are shared for 10 s
  await ui.hover({ css: doc });
  await ui.waitFor({ css: toggle }, { timeoutMs: 35000 });
  await expect('long plan: the list has every step', `document.querySelectorAll('${list} li').length === 8`);
  await expect('long plan: the card appears open', `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true' && !document.querySelector('${list}').hidden`);
  const capped = await frameOf();
  await expect('long plan: the card is capped inside the window', `(() => { const r = document.querySelector('${preview}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height <= 440; })()`);
  await expect('long plan: the list scrolls inside the card, Show in Tasks stays in view at the card bottom', `(() => { const l = document.querySelector('${list}'), p = document.querySelector('${preview}').getBoundingClientRect(), b = document.querySelector('${preview} .dispatch-linked-open').getBoundingClientRect(); return l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === 'auto' && b.bottom <= p.bottom - 12 && b.bottom >= p.bottom - 14; })()`);
  await expect('long plan: the scrollbar is themed, not the white system one', `getComputedStyle(document.querySelector('${list}')).scrollbarColor !== 'auto'`);
  await capture(ui, 'long-plan-open');
  await ui.hover({ css: toggle });
  await ui.click({ css: toggle });
  await expect('long plan: click closes it', `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'false' && document.querySelector('${list}').hidden`);
  same('long plan: hover card top and bottom unchanged when it closes', capped, await frameOf());
  await ui.click({ css: toggle });
  same('long plan: hover card top and bottom unchanged when it opens again', capped, await frameOf());
  fs.writeFileSync(path.join(ui.out, 'frames.json'), JSON.stringify(frames, null, 2));
  if (errors.length) throw new Error(`runtime exceptions: ${errors.join('\n')}`);
  fs.writeFileSync(path.join(ui.out, 'qa.json'), JSON.stringify({ checks, errors, task, file }, null, 2));
}
