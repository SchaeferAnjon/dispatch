// The side pane's tabs (task-fecz, task-gcc5): a click on a tab's name switches to it and never closes it (the
// close button sat over the name), and in a narrow pane every tab stays inside the pane and takes a click (the
// last one used to sit under the buttons at the end of the strip). Real input on the demo project; no engine messages.
export const meta = { title: 'Side pane tabs', description: 'Clicking a tab name switches to it; a narrow pane keeps every tab in reach.' };

// a session that has run has Now and Changes too; the new session page has Files, Docs and Tasks
let TABS = ['Files', 'Docs', 'Tasks'];

/** Drag the side pane's left edge until the pane is `width` wide (the way a person narrows it). */
async function paneWidth(ui, width) {
  const info = await ui.eval(`(() => {
    const g = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
    const r = g.getBoundingClientRect();
    const sash = [...document.querySelectorAll('.monaco-sash.vertical')].map(e => e.getBoundingClientRect()).find(b => b.height > 200 && Math.abs(b.x + b.width / 2 - r.x) < 12);
    return { right: r.right, sash: sash ? { x: sash.x + sash.width / 2, y: sash.y + sash.height / 2 } : null };
  })()`);
  if (!info.sash) throw new Error('No edge to drag on the side pane');
  await ui.mouse('mouseMoved', info.sash.x, info.sash.y);
  await ui.mouse('mousePressed', info.sash.x, info.sash.y, { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) await ui.mouse('mouseMoved', info.sash.x + (info.right - width - info.sash.x) * i / 10, info.sash.y, { button: 'left', buttons: 1 });
  await ui.mouse('mouseReleased', info.right - width, info.sash.y, { button: 'left', clickCount: 1 });
  await ui.sleep(800);
  return ui.eval(`Math.round([...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0).getBoundingClientRect().width)`);
}

/** Each tab: where its name is, what a click on the middle of its name lands on, whether it is inside the pane. */
const strip = `(() => {
  const pane = [...document.querySelectorAll('.part.editor')].find(e => e.getBoundingClientRect().width > 0);
  const scroller = pane.querySelector('.tabs-and-actions-container > .monaco-scrollable-element');
  const p = scroller.getBoundingClientRect();
  return [...pane.querySelectorAll('.tabs-container > .tab')].map(t => {
    const r = t.getBoundingClientRect();
    const name = t.querySelector('.monaco-icon-label-container');
    const n = name && name.offsetParent ? name.getBoundingClientRect() : r;
    const x = n.left + n.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { tab: t.getAttribute('aria-label'), left: Math.round(r.left), right: Math.round(r.right), inside: r.left >= p.left - 1 && r.right <= p.right + 1,
      nameShown: !!(name && name.offsetParent), x: Math.round(x), y: Math.round(y), hitsTab: !!hit && hit.closest('.tab') === t, hitsClose: !!hit && !!hit.closest('.tab-actions'),
      active: t.classList.contains('active'), strip: [Math.round(p.left), Math.round(p.right)], cls: pane.querySelector('.editor-group-container > .title').className };
  });
})()`;

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  // a session that has run (all five tabs) when the instance has one, else the new session page
  const title = await ui.eval(`([...document.querySelectorAll('.part.sidebar .monaco-list-row.session-list-inset-row')].map(r => r.innerText.split('\\n')[0].trim()).find(t => t && !/>_|Terminal/.test(t))) || ''`);
  if (title) {
    await ui.click({ text: title, exact: true, within: '.part.sidebar' });
    await ui.sleep(2500);
    TABS = ['Changes', 'Files', 'Docs', 'Tasks'];
  } else {
    await ui.newSession();
  }
  // every tab in the strip; openTab clicks the middle of the name and fails when that closes the tab
  for (const name of TABS) await ui.openTab(name);
  const wide = await ui.eval(strip);

  // the pointer rests on a tab behind: its close button does not come up over the name
  const files = wide.find(t => t.tab === 'Files');
  await ui.mouse('mouseMoved', files.x, files.y);
  await ui.sleep(500);
  const hover = (await ui.eval(strip)).find(t => t.tab === 'Files');
  if (!hover.hitsTab || hover.hitsClose) throw new Error(`Pointing at the name of Files lands on ${hover.hitsClose ? 'its close button' : 'something else'}`);
  await ui.screenshot('01-hover-name');
  await ui.mark({ css: '.part.editor .tabs-container > .tab[aria-label="Files"]' }, { what: 'Files 页签：点名字就切过去', where: '右栏顶上的页签条', how: '鼠标停在名字上，关闭按钮不再压在字上' });
  await ui.click({ aria: 'Files', exact: true, within: '.tabs-container', webview: false });
  await ui.sleep(500);
  const afterClick = await ui.eval(strip);
  if (!afterClick.find(t => t.tab === 'Files')?.active) throw new Error('Files did not come to the front when its name was clicked');

  // a narrow pane: every tab inside the pane and a click on each switches to it
  const results = {};
  for (const width of [340, 300]) {
    const got = await paneWidth(ui, width);
    const tabs = await ui.eval(strip);
    results[width] = { got, tabs };
    for (const t of tabs) {
      if (!t.inside) throw new Error(`At ${got} px the ${t.tab} tab is outside the strip (${t.left}-${t.right}, strip ${t.strip.join('-')})`);
    }
    await ui.screenshot(`0${width === 340 ? 2 : 3}-pane-${width}`);
    for (const name of [...TABS].reverse()) {
      await ui.click({ aria: name, exact: true, within: '.tabs-container', webview: false });
      await ui.sleep(400);
      const now = await ui.eval(strip);
      const me = now.find(t => t.tab === name);
      if (!me) throw new Error(`At ${got} px clicking ${name} closed it`);
      if (!me.active) throw new Error(`At ${got} px clicking ${name} did not bring it to the front`);
    }
  }
  await ui.mark({ css: '.part.editor .tabs-container > .tab[aria-label="Tasks"]' }, { what: 'Tasks 页签：窄右栏里也点得到', where: '右栏页签条最右边', how: '右栏窄时后面的页签只留图标，名字在悬停里' });

  // wide again: the names come back
  const back = await paneWidth(ui, 600);
  const named = (await ui.eval(strip)).every(t => t.nameShown);
  if (!named) throw new Error(`At ${back} px the tabs did not get their names back`);
  await ui.screenshot('04-pane-wide-again');
  return { wide, results, back };
}
