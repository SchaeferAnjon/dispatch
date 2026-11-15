// A long message in a session is one bubble (kanban task-2lobp): scrolled under the top, its pinned first line and the
// rest still on screen read as one rounded rectangle, square where they meet; once the rest has gone the pinned line
// is a whole bubble of its own, the same height. A short message keeps its 24 round bubble. And the "Finished with
// 2 steps" line above a reply opens to its steps and closes again, live and from history, with its chevron showing
// without a hover; while the reply runs the line shows the step under way.
// On OpenCode (the instance's cheap model). steps-codex.mjs and steps-claude.mjs walk the steps line on the other two.
import fs from 'node:fs';
import path from 'node:path';

export const meta = { needs: ['opencode'], timeout: 1800, instance: { motion: true }, title: 'Long message bubble and the steps line',
  description: 'A long message is one bubble when it scrolls under the top; a reply\'s steps line opens and closes.' };

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

const EMAIL = [
  'Guten Tag Herr Weber,',
  '',
  'vielen Dank für Ihre Nachricht vom letzten Donnerstag und für die ausführlichen Unterlagen zum Projekt.',
  'Wir haben die Dokumente im Team durchgesehen und möchten Ihnen heute eine erste Rückmeldung geben.',
  'Insgesamt sind wir mit dem bisherigen Stand sehr zufrieden, es gibt aber noch einige offene Punkte.',
  '',
  'Erstens: Der Zeitplan für die zweite Phase erscheint uns etwas knapp bemessen.',
  'Könnten Sie bitte prüfen, ob eine Verschiebung des Meilensteins um zwei Wochen möglich wäre?',
  'Das würde uns helfen, die interne Abstimmung mit der Rechtsabteilung sauber abzuschließen.',
  '',
  'Zweitens: Bei den Kosten für die Wartung fehlt uns noch eine Aufschlüsselung nach Leistungen.',
  'Eine kurze Tabelle mit den einzelnen Positionen und den jeweiligen Stundensätzen wäre ideal.',
  'Bitte geben Sie dabei auch an, welche Leistungen optional sind und welche fest vereinbart werden.',
  '',
  'Drittens: Für die Schulung der Mitarbeiter schlagen wir zwei Termine im November vor.',
  'Der erste Termin wäre am Dienstag, dem 11. November, jeweils von 9 bis 12 Uhr.',
  'Der zweite Termin wäre am Donnerstag, dem 13. November, ebenfalls am Vormittag.',
  'Bitte teilen Sie uns mit, ob diese Termine für Ihre Trainer passen.',
  '',
  'Viertens: Die Dokumentation sollte zusätzlich auf Englisch verfügbar sein.',
  'Einige unserer Kollegen am Standort in Rotterdam sprechen kein Deutsch.',
  'Eine maschinelle Übersetzung reicht dafür nach unserer Erfahrung leider nicht aus.',
  '',
  'Fünftens: Wir würden gern einen festen Ansprechpartner für den laufenden Betrieb benennen.',
  'Auf unserer Seite übernimmt das ab Dezember Frau Lehmann aus der IT-Abteilung.',
  'Könnten Sie uns ebenfalls eine Person nennen, die bei Störungen erreichbar ist?',
  '',
  'Sechstens: Die Abnahme der ersten Phase möchten wir gern bis Ende des Monats abschließen.',
  'Dazu fehlen uns nur noch die Testprotokolle der letzten beiden Sprints.',
  'Sobald diese vorliegen, können wir das Abnahmeprotokoll unterschreiben.',
  '',
  'Für Rückfragen stehe ich Ihnen selbstverständlich jederzeit gern zur Verfügung.',
  'Sie erreichen mich am besten telefonisch am Vormittag oder per E-Mail.',
  '',
  'Mit freundlichen Grüßen',
  'Anna Schäfer',
  'Projektleitung Digitalisierung',
  '',
  '(Test message, please ignore the letter above.)',
  'Reply with the numbers 1 to 60, one number per line, and nothing else. Do not use any tools.',
].join('\n');

export async function until(ui, fn, what, ms) {
  for (const end = Date.now() + ms * SCALE; Date.now() < end; await ui.sleep(700)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`Timed out: ${what}`);
}

const LAST = `[...document.querySelectorAll('.part.sessionspart .monaco-list-rows .interactive-response')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).at(-1)`;

/** The steps line of the last reply: its title, whether it opens, what shows inside, its chevron. */
const STEPS = `(() => { const r = ${LAST}; if (!r) return null;
  const box = [...r.querySelectorAll('.chat-thinking-box')].filter(b => b.offsetParent).at(-1); if (!box) return { loading: r.classList.contains('chat-response-loading') };
  const btn = box.querySelector(':scope > .chat-used-context-label .monaco-button'); const chev = btn && btn.querySelector('.chat-collapsible-hover-chevron');
  const items = [...box.querySelectorAll('.chat-thinking-item, .chat-thinking-tool-wrapper')].filter(e => e.getBoundingClientRect().height > 2 && e.innerText.trim());
  return { loading: r.classList.contains('chat-response-loading'), title: btn ? btn.innerText.replace(/\\s+/g, ' ').trim() : '', expanded: btn && btn.getAttribute('aria-expanded'),
    clickable: !!btn && getComputedStyle(btn).pointerEvents !== 'none' && !box.classList.contains('chat-collapsible-not-expandable'),
    chevron: chev ? Number(getComputedStyle(chev).opacity) : -1, items: items.map(e => e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120)) }; })()`;

/** Type a message in the chat box and send it; while the reply runs, note what its steps line shows. */
export async function send(ui, text, re, seen = []) {
  await ui.click({ css: '.part.sessionspart .interactive-input-part .monaco-editor, .sessions-chat-editor' });
  await ui.type(text);
  await ui.press('Enter', { send: true });
  await ui.sleep(1500);
  // the new session page can still be starting its engine when Enter comes: the text stays in the box, the send key sends it
  const still = `(() => { const e = [...document.querySelectorAll('.sessions-chat-editor')].find(x => x.offsetParent); return !!e && e.innerText.includes(${JSON.stringify(text.slice(0, 30))}); })()`;
  for (let i = 0; i < 10 && await ui.eval(still); i++) {
    await ui.sleep(3000);
    if (await ui.eval(still)) await ui.click({ css: '.sessions-chat-send-button .monaco-button' });
  }
  await until(ui, async () => {
    const s = await ui.eval(STEPS);
    if (s && s.loading && s.title) seen.push({ title: s.title, items: s.items.slice(-2) });
    const t = await ui.eval(`(() => { const r = ${LAST}; return r && !r.classList.contains('chat-response-loading') ? r.innerText : ''; })()`);
    if (/401|unauthori[sz]ed|quota|usage limit|insufficient balance|rate limit/i.test(t) && !re.test(t)) throw new Error(`The test model failed: ${t.slice(0, 200)}`);
    return re.test(t);
  }, `the reply to ${text.slice(0, 40)}`, 300000);
  await ui.sleep(1500);
  return seen;
}

export async function scrollBy(ui, dy) {
  const box = await ui.eval(`(() => { const b = document.querySelector('.part.sessionspart .interactive-list').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await ui.mouse('mouseWheel', box.x, box.y, { deltaX: 0, deltaY: dy });
  await ui.sleep(250);
}

/** Wheel the last reply's steps line to the middle of the chat and click it with the mouse. */
export async function clickStepsLine(ui) {
  const find = `(() => { const r = ${LAST}; const b = r && [...r.querySelectorAll('.chat-thinking-box > .chat-used-context-label .monaco-button')].filter(e => e.offsetParent).at(-1);
    if (!b) return null; const rr = b.getBoundingClientRect(); const l = document.querySelector('.part.sessionspart .interactive-list').getBoundingClientRect();
    const x = rr.left + Math.min(40, rr.width / 2), y = rr.top + rr.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, off: y - (l.top + l.height / 2), hit: !!hit && b.contains(hit) }; })()`;
  let at = null;
  for (let i = 0; i < 30; i++) {
    at = await ui.eval(find);
    if (!at) { await scrollBy(ui, 600); continue; }
    if (Math.abs(at.off) < 80) break;
    await scrollBy(ui, at.off);
  }
  if (!at || !at.hit) throw new Error(`The steps line is not under the pointer: ${JSON.stringify(at)}`);
  await ui.mouse('mouseMoved', at.x, at.y);
  await ui.mouse('mousePressed', at.x, at.y, { clickCount: 1 });
  await ui.mouse('mouseReleased', at.x, at.y, { clickCount: 1 });
  await ui.sleep(1200);
}

/** The last reply's steps line: shows its chevron, opens to the steps on a click, closes on the next. Returns problems. */
export async function walkStepsLine(ui, note, key, want) {
  const bad = [];
  const before = await ui.eval(STEPS);
  note(`${key}_before`, before);
  if (!before || !before.title) return [`${key}: no steps line above the reply`];
  if (!before.clickable) bad.push(`${key}: "${before.title}" does not open`);
  if (!(before.chevron >= 0.5)) bad.push(`${key}: the chevron of "${before.title}" does not show without a hover (opacity ${before.chevron})`);
  await clickStepsLine(ui);
  const open = await ui.eval(STEPS);
  note(`${key}_open`, open);
  await ui.screenshot(`${key}-open`);
  if (open.expanded !== 'true') bad.push(`${key}: a click did not open "${before.title}"`);
  if (!open.items.length) bad.push(`${key}: "${before.title}" opened to nothing`);
  else if (want && !open.items.some(t => want.test(t))) bad.push(`${key}: the steps do not mention ${want}: ${JSON.stringify(open.items)}`);
  await clickStepsLine(ui);
  const closed = await ui.eval(STEPS);
  note(`${key}_closed`, closed);
  if (closed.expanded !== 'false') bad.push(`${key}: the second click did not close it`);
  return bad;
}

const SRC = `[...document.querySelectorAll('.part.sessionspart .monaco-list-rows .interactive-request .value > .rendered-markdown')].find(e => e.innerText.startsWith('Guten Tag'))`;

/** The long bubble and its pinned copy at the top, as boxes and styles. */
const BUBBLE = `(() => {
  const st = (e) => { if (!e) return null; const s = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(parseFloat), bg: s.backgroundColor + ' ' + s.backgroundImage, transition: s.transitionProperty }; };
  const row = document.querySelector('.part.sessionspart .monaco-tree-sticky-container .monaco-tree-sticky-row.request');
  const pin = row && row.querySelector('.interactive-request .value > .rendered-markdown');
  const src = ${SRC};
  const p = st(pin), s = st(src);
  // what is drawn just under the pinned line, in the middle of it: the rest of the same bubble, or nothing
  const under = p ? document.elementsFromPoint((p.left + p.right) / 2, p.bottom + 3).find(e => e.matches('.interactive-request .value > .rendered-markdown')) : null;
  // what is drawn on top in the middle of the pinned line: the pinned line itself, not a piece of the bubble behind it
  const onTop = p ? document.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2) : null;
  const fade = pin ? getComputedStyle(pin, '::after') : null;
  return { partial: !!row && row.classList.contains('source-node-partially-visible'), pin: p, src: s, fade: fade && fade.content !== 'none' ? { image: fade.backgroundImage, mask: fade.maskImage || fade.webkitMaskImage, height: parseFloat(fade.height) } : null, underIsSource: !!under && under === src, topIsPin: !!onTop && !!row && row.contains(onTop),
    bubbles: [...document.querySelectorAll('.part.sessionspart .interactive-request .value > .rendered-markdown')].filter(e => { const r = e.getBoundingClientRect(); return p && r.bottom > p.top - 1 && r.top < p.bottom + 1 && r.height > 0; }).length };
})()`;

/** Wheel until the long bubble's top is at `top` px from the chat's top. */
async function placeBubble(ui, top) {
  const where = `(() => { const l = document.querySelector('.part.sessionspart .interactive-list').getBoundingClientRect(); const s = ${SRC}; return s ? s.getBoundingClientRect().top - l.top : null; })()`;
  for (let i = 0; i < 30; i++) {
    const now = await ui.eval(where);
    if (now === null) { await scrollBy(ui, -300); continue; }
    if (Math.abs(now - top) < 3) break;
    await scrollBy(ui, now - top);
  }
  await ui.sleep(600); // the corner transition (120 ms) is over
  return ui.eval(where);
}

const SHORT = `(() => { const b = [...document.querySelectorAll('.part.sessionspart .monaco-list-rows .interactive-request .value > .rendered-markdown')].find(e => e.innerText.trim().startsWith('hi, reply')); if (!b) return null;
  const s = getComputedStyle(b); return { radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(parseFloat), padding: s.padding, height: b.getBoundingClientRect().height }; })()`;

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  const bad = [];
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('OpenCode', 180000);

  // the steps line: while the reply runs it shows the step under way, then it opens and closes
  const seen = await send(ui, 'Use your read tool to read README.md, then use it again to read NOTES.md, then reply with the first line of README.md only.', /Demo/);
  note('while_running', seen);
  if (!seen.length) bad.push('the steps line never showed while the reply ran');
  else if (!seen.some(s => s.items.some(t => /README|NOTES/.test(t)) || /README|NOTES/.test(s.title))) bad.push(`while the reply ran the steps line never showed the file being read: ${JSON.stringify(seen)}`);
  await ui.screenshot('01-steps-closed');
  bad.push(...await walkStepsLine(ui, note, '02-steps', /README|NOTES|read/i));

  // the same reply from history: the window reloads, the session opens again, its steps line still opens
  const title = await ui.eval(`(document.querySelector('.part.sidebar .monaco-list-row.session-list-inset-row') || {}).innerText || ''`);
  note('session_title', title);
  await ui.reloadWindow();
  await ui.sleep(3000);
  await ui.click({ text: title.split('\n')[0].trim(), exact: true, within: '.part.sidebar' });
  await until(ui, async () => ui.eval(`[...document.querySelectorAll('.part.sessionspart .monaco-list-rows .interactive-response')].some(r => /Demo/.test(r.innerText))`), 'the reply after the reload', 60000);
  await ui.sleep(1500);
  bad.push(...await walkStepsLine(ui, note, '03-history-steps', /README|NOTES|read/i));

  // a short message: the 24 round bubble, 12 / 16 inside
  await send(ui, 'hi, reply with OK only. Do not use any tools.', /\bOK\b/);
  const short = await ui.eval(SHORT);
  note('short', short);
  if (!short || short.radius.some(r => r !== 24) || short.padding !== '12px 16px') bad.push(`the short bubble changed: ${JSON.stringify(short)}`);

  // a long message: one bubble while it scrolls under the top
  await send(ui, EMAIL, /\b60\b/);
  await ui.setTheme('light');
  await ui.sleep(1200);
  for (let i = 0; i < 30 && !(await ui.eval(`!!${SRC}`)); i++) await scrollBy(ui, -300);
  const h = await ui.eval(`${SRC}.getBoundingClientRect().height`);
  note('long_height', h);
  await placeBubble(ui, 20);
  await ui.screenshot('10-long-top');
  const top = await ui.eval(BUBBLE);
  note('top', top);
  if (!top.src || top.src.radius.some(r => r !== 24)) bad.push(`the long bubble at rest: corners ${top.src && top.src.radius} (want 24 all round)`);

  note('partial_at', await placeBubble(ui, -Math.round(h / 3)));
  const partial = await ui.eval(BUBBLE);
  note('partial', partial);
  await ui.screenshot('11-long-pinned-rest-below');
  if (!partial.pin || !partial.partial) bad.push(`no pinned line while the rest is on screen: ${JSON.stringify(partial)}`);
  else {
    const p = partial.pin, s = partial.src;
    if (p.radius[0] !== 24 || p.radius[1] !== 24 || p.radius[2] !== 0 || p.radius[3] !== 0) bad.push(`pinned line corners while the rest is below: ${p.radius} (want 24 24 0 0)`);
    if (!s || s.radius[2] !== 24 || s.radius[3] !== 24) bad.push(`the rest's bottom corners: ${s && s.radius} (want 24)`);
    if (!s || Math.abs(p.left - s.left) > 1 || Math.abs(p.right - s.right) > 1) bad.push(`pinned line and the rest differ in width: ${JSON.stringify([p.left, p.right, s && s.left, s && s.right])}`);
    if (!s || p.bg !== s.bg) bad.push(`pinned line and the rest differ in colour: ${p.bg} / ${s && s.bg}`);
    if (!partial.underIsSource) bad.push('right under the pinned line is not the rest of the same bubble (a gap)');
    if (!partial.topIsPin) bad.push('something else is drawn over the pinned line');
    if (!partial.fade || !/gradient/.test(partial.fade.mask) || !(partial.fade.height >= 12)) bad.push(`no fade over the line cut in half under the pinned line: ${JSON.stringify(partial.fade)}`);
    if (s && s.bottom - 24 < p.bottom) bad.push('the rest is shorter than its own corners');
    if (!/border-bottom-left-radius/.test(p.transition)) bad.push(`the corners do not ease: ${p.transition}`);
  }

  // the same in the dark theme
  await ui.setTheme('dark');
  await ui.sleep(1200);
  await placeBubble(ui, -Math.round(h / 3));
  const dark = await ui.eval(BUBBLE);
  note('dark', dark);
  await ui.screenshot('11-long-pinned-rest-below-dark');
  if (!dark.pin || !dark.partial || dark.pin.radius[2] !== 0 || !dark.underIsSource || !dark.src || dark.pin.bg !== dark.src.bg) bad.push(`dark: the pinned line and the rest are not one bubble: ${JSON.stringify(dark)}`);
  await ui.setTheme('light');
  await ui.sleep(1200);

  // scrolled until the rest is all under the pinned line (as far as the reply below lets the chat scroll)
  note('collapsed_at', await placeBubble(ui, -Math.round(h - 10)));
  const collapsed = await ui.eval(BUBBLE);
  note('collapsed', collapsed);
  await ui.screenshot('12-long-pinned-alone');
  if (!collapsed.pin || collapsed.partial) bad.push(`no pinned line once the rest has gone: ${JSON.stringify(collapsed)}`);
  else {
    if (collapsed.pin.radius.some(r => r !== 24)) bad.push(`pinned line alone: corners ${collapsed.pin.radius} (want 24 all round)`);
    if (collapsed.underIsSource) bad.push('pinned line alone: a piece of the bubble still shows under it');
    if (!collapsed.topIsPin) bad.push('pinned line alone: something else is drawn over it');
    if (collapsed.fade) bad.push(`pinned line alone: a fade hangs under it: ${JSON.stringify(collapsed.fade)}`);
    if (partial.pin && Math.abs(collapsed.pin.height - partial.pin.height) > 0.5) bad.push(`the pinned line jumps from ${partial.pin.height} to ${collapsed.pin.height} px`);
  }

  // back down past the bubble and up again: the pinned line comes and goes without a seam on the way
  note('back_at', await placeBubble(ui, -Math.round(h / 2)));
  const back = await ui.eval(BUBBLE);
  note('back', back);
  if (!back.pin || !back.partial || back.pin.radius[2] !== 0 || !back.underIsSource) bad.push(`scrolled back, the pinned line and the rest are not one bubble: ${JSON.stringify(back)}`);

  await ui.mark({ css: '.part.sessionspart .interactive-list' }, { what: '长消息一整块：顶上固定的第一行和下面的正文连成一个圆角矩形', where: '会话中间', how: '往上滚一条长消息' });
  if (bad.length) throw new Error(bad.join('\n'));
}
