// The Agents window's title bar: the light or dark button left of the devices (preference「标题栏切换深浅」). A click
// goes to the other of the two from what shows, System included; Settings › Appearance follows.
export const meta = { title: '标题栏白天/夜晚切换', description: '右上角设备按钮左边的按钮，一点就在浅色和深色之间换。' };
export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  const btn = { aria: 'Switch light or dark', webview: false };
  await ui.waitFor(btn);
  const dark = () => ui.eval(`document.querySelector('.monaco-workbench').classList.contains('vs-dark')`);
  const place = await ui.eval(`(() => { const items = [...document.querySelectorAll('.titlebar-right .action-item, .part.titlebar .action-item')].filter(e => e.offsetParent); const i = items.findIndex(e => e.querySelector('[aria-label^="Switch light or dark"]')); const m = items.findIndex(e => e.querySelector('[aria-label^="Machines"], .dispatch-machines-button-label')); return { i, m }; })()`);
  if (!(place.i >= 0 && place.m > place.i)) throw Error('not left of the devices: ' + JSON.stringify(place));
  const first = await dark();
  await ui.click(btn); await ui.sleep(1200);
  const second = await dark();
  if (second === first) throw Error('one click did not switch light or dark');
  const mode = await ui.eval(`document.querySelector('.monaco-workbench').className.match(/\\bvs(-dark)?\\b/)?.[0]`);
  await ui.screenshot(second ? '02-dark' : '02-light');
  await ui.mark(btn, { what: '白天/夜晚', where: '标题栏右上角，设备按钮左边', how: '点一下换浅色或深色' });
  await ui.click(btn); await ui.sleep(1200);
  if (await dark() !== first) throw Error('a second click did not switch back');
  await ui.screenshot('03-back');
  if (!mode) throw Error('no theme class');
}
