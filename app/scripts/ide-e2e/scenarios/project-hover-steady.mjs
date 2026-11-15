// The project row's card in the sidebar stays put while the pointer moves along the row (task-fz0fn): it used to be
// drawn afresh for every element the pointer entered (the folder icon, the name, New Session, Task Graph), so it
// flickered across the row. The pointer moves along the row 4 px at a time, the card's element is counted.
import fs from 'node:fs';
import path from 'node:path';

export const meta = { title: 'Project row card: steady along the row', description: 'Moving along a project row over its buttons does not draw the card again and again.', timeout: 600 };

export default async function (ui) {
  const out = {};
  const save = () => fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(out, null, 2));
  await ui.openAgents(ui.demoFolder);
  await ui.sleep(2000);
  const ROW = `[...document.querySelectorAll('.agent-sessions-viewpane .session-section')].find(s => /\\bdemo\\b/.test(s.querySelector('.session-section-label')?.textContent || ''))`;
  for (let i = 0; i < 30 && !(await ui.eval(`!!(${ROW})`)); i++) await ui.sleep(1000);
  const box = await ui.eval(`(() => { const r = (${ROW}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  out.row = box;
  // count every new card element: each one gets a number the first time it is seen
  await ui.eval(`(() => { window.__cards = 0; window.__seen = []; new MutationObserver(() => { const h = [...document.querySelectorAll('.workbench-hover')].find(e => e.offsetParent && e.innerText.length > 0); if (h && !h.dataset.e2eCard) { h.dataset.e2eCard = String(++window.__cards); window.__seen.push(h.innerText.slice(0, 40)); } }).observe(document.body, { childList: true, subtree: true }); })()`);
  const y = box.y + box.h / 2;
  await ui.mouse('mouseMoved', box.x + 30, y);
  await ui.sleep(1800); // the card shows after its delay
  out.first = await ui.eval(`window.__cards`);
  // along the row to its right end (the buttons sit there), and back
  for (let x = box.x + 30; x <= box.x + box.w - 4; x += 4) { await ui.mouse('mouseMoved', x, y); await ui.sleep(40); }
  for (let x = box.x + box.w - 4; x >= box.x + 30; x -= 4) { await ui.mouse('mouseMoved', x, y); await ui.sleep(40); }
  await ui.sleep(800);
  out.cards = await ui.eval(`window.__cards`);
  out.seen = await ui.eval(`window.__seen`);
  out.buttons = await ui.eval(`[...(${ROW}).querySelectorAll('.session-section-toolbar .action-label')].map(a => a.getAttribute('aria-label'))`);
  save();
  await ui.screenshot('01-card-on-the-row');
  // the card drawn once on the way out and once on the way back at most, plus the buttons' own small hovers
  if (out.first < 1) throw new Error('the card did not show');
  const cardDraws = out.seen.filter(t => !out.buttons.some(b => b && t.startsWith(b.split(' (')[0]))).length;
  out.cardDraws = cardDraws;
  save();
  if (cardDraws > 3) throw new Error(`the card was drawn ${cardDraws} times while the pointer went along the row: ${JSON.stringify(out.seen)}`);
}
