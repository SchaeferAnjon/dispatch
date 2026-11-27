// Sub-agents in three places, all VS Code's own pill (the person 2026-11-16, task-518qw, design/subagent-now/redesign
// direction A, 「左栏做成这种的就可以」): a real OpenCode session in the demo project sends out two general sub-agents
// at once. While they work: under the session in the sidebar one pill per sub-agent (spinner, name, "Working for …",
// the step under it), above the message box "2 agents working ⌄", in Now "2 agents working" over the same pills; the
// three look the same (computed styles compared with the block in the conversation, which is VS Code's
// ChatSubagentContentPart); no "⌄ N" count on the session's row. "Open Subagent" in the block opens a read-only tab
// whose × is always there and never under its spinner; the × closes it, a click on a sidebar row opens it again. Once
// both are back: the strip goes, the sidebar and Now say "2 finished", the tab's spinner is gone; "2 finished" opens
// the two in place, and × puts one away. Cheap model only (GLM 5.3 Flash, DeepSeek Flash or a free Flash), never Claude.
import { writeFileSync } from 'node:fs';
import { until, offscreen, focusInput, chooseCheapModel, closeTips, onDemo, toDemo } from './session-now.mjs';

export const meta = { instance: { motion: true }, needs: ['opencode'], timeout: 1800,
  title: '子 Agent 三处一个样：左栏、输入框上方、Now 都是 VS Code 原版胶囊',
  description: 'OpenCode 会话同时派两个子 Agent：左栏父会话下面一行一个原版胶囊（转圈、名字、用时、当前一步），输入框上方「2 agents working ⌄」，Now 里「2 agents working」，三处计算样式一致、和对话里的原版块一致；父行没有「⌄ N」；Open Subagent 开只读页签，× 一直在、不被转圈盖住；跑完条消失、两处「2 finished」、转圈没了；× 清掉一个。',
};

const MESSAGE = 'In ONE reply, call your task tool two times at once (in parallel, not one after the other) to start two general subagents. First: description "Count files slowly", prompt "Run the shell command: sleep 40; ls -A | wc -l. Reply with the number only.". Second: description "Read the README slowly", prompt "Run the shell command: sleep 50; head -1 README.md. Reply with that line only.". After both are back, reply with one short line saying what they found.';

/** This session's row in the sidebar and the rows under it (another scenario in the instance may have sessions too). */
const MINE = `(() => {
  const rows = [...document.querySelectorAll('.session-item, .session-chat-item')].filter(e => e.offsetParent)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  let at = rows.findIndex(e => e.classList.contains('session-item') && /call your task tool|Count files|README/i.test(e.innerText));
  if (at < 0) at = rows.findIndex(e => e.classList.contains('session-item') && e.closest('.monaco-list-row')?.classList.contains('selected'));
  if (at < 0) return { session: null, chats: [] };
  const chats = [];
  for (const e of rows.slice(at + 1)) { if (e.classList.contains('session-item')) break; chats.push(e); }
  return { session: rows[at], chats };
})()`;

/** The styles that must agree in the three places and in the conversation's own block. */
const STYLE = `(pill) => { if (!pill) return null; const cs = (e, p) => e ? getComputedStyle(e)[p] : '';
  const c = pill.querySelector('.chat-subagent-pill-content'); const d = pill.querySelector('.chat-subagent-pill-duration'); const t = pill.querySelector('.chat-subagent-pill-active-tool');
  return { font: cs(pill.querySelector('.chat-subagent-pill-widget'), 'fontSize'), color: cs(pill.querySelector('.chat-subagent-pill-widget'), 'color'), border: cs(c, 'borderTopWidth') + ' ' + cs(c, 'borderTopStyle') + ' ' + cs(c, 'borderTopColor'),
    radius: cs(c, 'borderTopLeftRadius'), padding: cs(c, 'padding'), durFont: cs(d, 'fontSize') + ' ' + cs(d, 'fontStyle'), toolFont: t && t.offsetParent ? cs(t, 'fontSize') : '' }; }`;

/** What the window shows of the sub-agents, in the three places and the conversation. */
const READ = `(() => {
  const shown = e => !!e && !!e.offsetParent && e.getBoundingClientRect().height > 0;
  const style = ${STYLE};
  const pillOf = e => ({ text: e.innerText.replace(/\\s+/g, ' ').trim(), state: e.dataset.state || '', spinner: !!e.querySelector('.chat-subagent-pill-icon .monaco-pixel-spinner'), step: (e.querySelector('.chat-subagent-pill-active-tool') || {}).innerText || '' });
  const mine = ${MINE};
  const side = mine.chats.map(e => ({ sub: e.classList.contains('dispatch-subagent'), more: e.classList.contains('dispatch-subagent-more'), text: e.innerText.replace(/\\s+/g, ' ').trim(), pill: e.querySelector('.dispatch-subagent-pill') ? pillOf(e.querySelector('.dispatch-subagent-pill')) : null, h: Math.round(e.getBoundingClientRect().height) }));
  const strip = [...document.querySelectorAll('.dispatch-subagents')].find(shown);
  const head = strip && strip.querySelector('.dsa-head');
  const now = [...document.querySelectorAll('.dispatch-now-tab')].find(shown);
  const nowBlock = now && now.querySelector('[data-part="now-subagents"]');
  const block = [...document.querySelectorAll('.interactive-response .chat-subagent-part')].filter(shown);
  const headStyle = h => { if (!h) return null; const l = h.querySelector('.dispatch-subagent-head-label'); const i = h.querySelector('.dispatch-subagent-head-icon'); return { text: l ? l.textContent : '', font: getComputedStyle(l).fontSize + '/' + getComputedStyle(l).fontWeight, color: getComputedStyle(l).color, icon: i ? i.className.includes('codicon-agent') && getComputedStyle(i).fontSize : '' }; };
  return {
    count: !!document.querySelector('.dispatch-subagent-count'),
    side,
    sideStyle: style(mine.chats.map(e => e.querySelector('.dispatch-subagent-pill')).find(Boolean)),
    strip: strip ? { head: headStyle(head), expanded: head.getAttribute('aria-expanded'), line: (head.querySelector('.dsa-line') || {}).textContent || '', pills: [...strip.querySelectorAll('.dispatch-subagent-pill')].map(pillOf), finished: (strip.querySelector('[data-part="finished"]') || {}).textContent || '', style: style(strip.querySelector('.dispatch-subagent-pill')) } : null,
    now: nowBlock ? { head: headStyle(nowBlock.querySelector('.dispatch-subagent-head')), pills: [...nowBlock.querySelectorAll('.dispatch-subagent-pill')].map(pillOf), finished: (nowBlock.querySelector('[data-part="finished"]') || {}).textContent || '', style: style(nowBlock.querySelector('.dispatch-subagent-pill')) } : null,
    block: block.map(b => ({ text: b.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160), style: style(b.querySelector('.chat-subagent-open-chat-toolbar')) })),
  };
})()`;

/** The chat tabs over the conversation: which, read only, the × and the spinner and whether they overlap. */
const TABS = `(() => [...document.querySelectorAll('.session-chat-tabs-bar .chat-composite-bar-tab')].filter(t => t.offsetParent).map(t => {
  const x = t.querySelector('.chat-composite-bar-tab-actions .action-label'); const s = t.querySelector('.chat-composite-bar-tab-indicator');
  const rx = x && x.getBoundingClientRect(); const rs = s && getComputedStyle(s).display !== 'none' ? s.getBoundingClientRect() : null;
  const label = t.querySelector('.chat-composite-bar-tab-label').getBoundingClientRect();
  return { title: t.querySelector('.chat-composite-bar-tab-label').textContent, main: t.dataset.isMainChat === 'true', readOnly: t.classList.contains('read-only'), working: t.classList.contains('in-progress'),
    close: x ? { opacity: getComputedStyle(x).opacity, w: Math.round(rx.width), x: Math.round(rx.left) } : null,
    spinner: rs ? { x: Math.round(rs.left), w: Math.round(rs.width), leftOfTitle: rs.right <= label.left + 1 } : null,
    overlap: !!(rx && rs && rs.left < rx.right && rs.right > rx.left), labelEndsBeforeClose: !!(rx && label.right <= rx.left + 1) };
}))()`;

export default async function (ui) {
  const qa = { checks: [], failed: [] };
  const note = () => writeFileSync(`${ui.out}/qa.json`, JSON.stringify(qa, null, 1));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? 'ok' : 'FAILED'}: ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const same = (a, b, keys) => !!a && !!b && keys.every(k => a[k] === b[k]);

  await offscreen(ui);
  await ui.openAgents(ui.demoFolder);
  await offscreen(ui);
  await closeTips(ui);
  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine('OpenCode', 360000);
  await ui.sleep(1500);
  qa.model = await chooseCheapModel(ui, '.sessions-chat-editor');
  await focusInput(ui, '.sessions-chat-editor');
  await ui.type(MESSAGE);
  const sentAt = Date.now();
  await ui.press('Enter', { send: true });
  await ui.openNowTab().catch(() => undefined);

  // 1 while they work: the three places, as many working as there are at the most
  let most = null;
  await until(ui, async () => {
    const r = await ui.eval(READ);
    const n = r.side.filter(x => x.sub && x.pill && x.pill.state === 'sub-agent').length;
    if (n && (!most || n > most.n)) most = { n, r, at: Date.now() - sentAt };
    return n >= 2 && r.strip && r.now && r.now.pills.length >= 2 ? r : null;
  }, 360000, 'two sub-agents working in the sidebar, the strip and Now', 500).catch(() => null);
  check('two sub-agents worked at once (else the rest is read with the most that did)', most && most.n >= 2, most && { n: most.n });
  // the strip opens to show which ones (folded by default: "2 agents working ⌄")
  let r = await ui.eval(READ);
  qa.folded = r.strip && { expanded: r.strip.expanded, line: r.strip.line, head: r.strip.head };
  check('the strip starts folded: one line "N agents working" and the first one\'s step', !!r.strip && r.strip.expanded === 'false' && /^\d+ agents? working$/.test(r.strip.head.text), qa.folded);
  if (r.strip && r.strip.expanded === 'false') {
    await ui.click({ css: '.dispatch-subagents .dsa-head' });
    await ui.sleep(500);
  }
  r = await ui.eval(READ);
  qa.working = r;
  const working = r.side.filter(x => x.sub && x.pill && x.pill.state === 'sub-agent');
  check('no "⌄ N" count on the session\'s row', !r.count);
  check('the sidebar: one pill per working sub-agent under the session, with the spinner and "Working for"', working.length >= 1 && working.every(x => x.pill.spinner && /Working for \d/.test(x.pill.text)), working);
  check('the strip: "N agents working" over the same pills', !!r.strip && r.strip.head.text === `${working.length} agent${working.length === 1 ? '' : 's'} working` && r.strip.pills.filter(p => p.state === 'sub-agent').length === working.length, r.strip);
  check('Now: the same "N agents working" over the same pills', !!r.now && !!r.now.head && r.now.head.text === r.strip?.head.text && r.now.pills.filter(p => p.state === 'sub-agent').length === working.length, r.now);
  check('the strip\'s and Now\'s heads look the same (agent icon, size, weight, colour)', !!r.now?.head && same(r.strip?.head, r.now.head, ['font', 'color', 'icon']), { strip: r.strip?.head, now: r.now?.head });
  const keys = ['font', 'color', 'border', 'radius', 'padding', 'durFont'];
  check('the pills look the same in the sidebar, the strip, Now and the conversation\'s own block', !!r.block.length && same(r.sideStyle, r.strip?.style, keys) && same(r.sideStyle, r.now?.style, keys) && same(r.sideStyle, r.block[0].style, keys), { side: r.sideStyle, strip: r.strip?.style, now: r.now?.style, block: r.block[0]?.style });
  check('the conversation has VS Code\'s own sub-agent block for each', r.block.length >= working.length, r.block.map(b => b.text));
  await ui.mouse('mouseMoved', 1000, 150);
  await ui.sleep(600);
  await ui.screenshot('01-working-three-places');
  // the same moment in the light theme, then back
  await ui.setTheme('light');
  await ui.sleep(900);
  await ui.screenshot('01b-working-three-places-light');
  await ui.setTheme('dark');
  await ui.sleep(600);
  await ui.mark({ css: '.session-chat-item.dispatch-subagent' }, { what: '左栏：父会话下面一行一个在跑的子 Agent，VS Code 原版胶囊', where: '左栏会话下面', how: '转圈、名字、Working for、下一行当前一步' }).catch(() => undefined);
  await ui.mark({ css: '.dispatch-subagents' }, { what: '输入框上方：N agents working，展开是同样的胶囊', where: '输入框正上方', how: '点头一行收起展开' }).catch(() => undefined);
  await ui.mark({ css: '[data-part="now-subagents"]' }, { what: 'Now：同样的 N agents working 和胶囊', where: '右栏 Now，挂在正在做的那一步下面', how: '点胶囊开只读页签' }).catch(() => undefined);

  // 2 "Open Subagent" in the conversation's block: a read-only tab next to the conversation, its × always there
  const tabsBefore = (await ui.eval(TABS)).length;
  await ui.click({ css: '.interactive-response .chat-subagent-part .chat-subagent-pill-content' });
  const tabs = await until(ui, async () => { const t = await ui.eval(TABS); return t.length > tabsBefore && t.some(x => !x.main) ? t : null; }, 20000, 'the read-only tab', 300).catch(async () => ui.eval(TABS));
  qa.tabOpen = tabs;
  const ro = tabs.find(x => !x.main);
  check('Open Subagent opens a read-only tab next to the conversation', !!ro && ro.readOnly, tabs);
  check('its × shows without pointing at it and nothing sits under it', !!ro && !!ro.close && ro.close.opacity === '1' && !ro.overlap && ro.labelEndsBeforeClose, ro);
  check('while it works its spinner is left of the title, not where the × is', !ro || !ro.working || (!!ro.spinner && ro.spinner.leftOfTitle), ro);
  await ui.mouse('mouseMoved', 1000, 150);
  await ui.sleep(500);
  await ui.screenshot('02-readonly-tab');
  await ui.mark({ css: '.session-chat-tabs-bar .chat-composite-bar-tab[data-is-main-chat="false"]' }, { what: '子 Agent 的只读页签：× 一直在，转圈在标题左边', where: '对话上方的页签', how: '点 × 关掉' }).catch(() => undefined);
  // the × closes it
  if (ro) {
    await ui.click({ css: '.session-chat-tabs-bar .chat-composite-bar-tab[data-is-main-chat="false"] .chat-composite-bar-tab-actions .action-label' });
    const closed = await until(ui, async () => { const t = await ui.eval(TABS); return !t.some(x => !x.main) ? t : null; }, 10000, 'the tab closed by its ×', 300).catch(() => null);
    check('the × closes the read-only tab with one click', !!closed);
  }
  // a click on a sidebar row opens it again, the same way
  await ui.click({ css: '.session-chat-item.dispatch-subagent .chat-subagent-pill-content' });
  const again = await until(ui, async () => { const t = await ui.eval(TABS); return t.some(x => !x.main && x.readOnly) ? t : null; }, 20000, 'the tab from the sidebar row', 300).catch(() => null);
  check('a click on a sidebar row opens the same read-only tab', !!again, again);

  // 3 both back: the strip goes, the sidebar and Now say "2 finished", the tab's spinner is gone
  const done = await until(ui, async () => {
    const x = await ui.eval(READ);
    const more = x.side.find(s => s.more);
    return !x.strip && more && !x.side.some(s => s.sub && s.pill?.state === 'sub-agent') && x.now && /^\d+ finished$/.test(x.now.finished) ? x : null;
  }, 900000, 'both back: no strip, N finished', 1500).catch(async () => { qa.doneTimeout = await ui.eval(READ); note(); return null; });
  qa.done = done;
  check('both back: the strip is gone', !!done && !done.strip);
  check('both back: the sidebar says "2 finished" and lists none as working', !!done && done.side.some(s => s.more && /2 finished/.test(s.text)), done && done.side);
  check('both back: Now says "2 finished", no "agents working" head', !!done && done.now.finished === '2 finished' && !done.now.head, done && done.now);
  const tabsDone = await ui.eval(TABS);
  qa.tabsDone = tabsDone;
  check('both back: the read-only tab has no spinner any more', tabsDone.filter(x => !x.main).every(x => !x.working && !x.spinner), tabsDone);
  await ui.mouse('mouseMoved', 1000, 150);
  await ui.sleep(600);
  await ui.screenshot('03-finished');
  await ui.mark({ css: '.session-chat-item.dispatch-subagent-more' }, { what: '跑完的收进「2 finished」', where: '左栏会话下面', how: '点开就地展开' }).catch(() => undefined);

  // 4 "2 finished" opens the two in place (Worked for …); × puts one away
  await ui.click({ css: '.session-chat-item.dispatch-subagent-more .dispatch-subagent-finished-toggle' });
  const opened = await until(ui, async () => { const x = await ui.eval(READ); const p = x.side.filter(s => s.sub && s.pill); return p.length === 2 ? p : null; }, 15000, 'the two finished pills', 300).catch(async () => (await ui.eval(READ)).side);
  qa.finishedOpen = opened;
  check('"2 finished" opens the two pills in place: no spinner, "Worked for"', Array.isArray(opened) && opened.length === 2 && opened.every(p => p.pill && !p.pill.spinner && /Worked for/.test(p.pill.text)), opened);
  await ui.mouse('mouseMoved', 1000, 150);
  await ui.screenshot('04-finished-open');
  await ui.hover({ css: '.session-chat-item.dispatch-subagent' });
  await ui.sleep(300);
  await ui.click({ css: '.session-chat-item.dispatch-subagent .dispatch-subagent-dismiss' });
  const left = await until(ui, async () => { const x = await ui.eval(READ); return x.side.some(s => s.more && /^1 finished/.test(s.text)) ? x.side : null; }, 10000, '1 finished after putting one away', 300).catch(async () => (await ui.eval(READ)).side);
  qa.afterDismiss = left;
  check('× on a finished one puts it away: "1 finished"', Array.isArray(left) && left.some(s => s.more && /^1 finished/.test(s.text)), left);

  qa.tookMs = Date.now() - sentAt;
  note();
  if (qa.failed.length) {
    throw new Error(`${qa.failed.length} check(s) failed: ${qa.failed.join(' | ').slice(0, 1500)}`);
  }
}
