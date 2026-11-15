// The title bar's Terminal and Editor are icon buttons like the rest of the title bar's (preferences「图标按钮不带字不带框」
// 「Editor 按钮悬停展开」): the icon alone and no frame at rest; on hover the word slides out and the icon takes a
// logo colour (Terminal green, Editor blue), as the editor window's Dispatch Agent button does.
export const meta = { title: '标题栏 Terminal / Editor 图标按钮', description: '平时只有图标、没有框；鼠标移上去滑出文字并上色，移开收回。', instance: { motion: true } };
export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  const rgb = h => `rgb(${[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
  const logo = async c => rgb(await ui.eval(`getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--dispatch-icon-${c}').trim()`));
  for (const [part, iconSel, prop, colour] of [['editor-top', '.dispatch-editor-top-ic', 'backgroundColor', 'blue'], ['terminal-top', '.dispatch-terminal-top-ic', 'color', 'green']]) {
    const btn = `.dispatch-title-side.dispatch-${part}`;
    await ui.waitFor({ css: btn });
    const read = () => ui.eval(`(() => { const b = document.querySelector('${btn}'); const t = b.querySelector('.dispatch-title-side-t'); const i = b.querySelector('${iconSel}'); const cs = getComputedStyle(b); return { width: Math.round(b.getBoundingClientRect().width), word: Math.round(t.getBoundingClientRect().width), wordOpacity: +getComputedStyle(t).opacity, icon: getComputedStyle(i).${prop}, border: [cs.borderTopColor, cs.borderTopWidth], fill: cs.backgroundColor }; })()`);
    await ui.mouse('mouseMoved', 5, 400); await ui.sleep(700);
    const rest = await read();
    if (rest.word > 1 || rest.wordOpacity > 0.05) throw Error(`${part}: the word shows at rest ` + JSON.stringify(rest));
    if (rest.width > 26) throw Error(`${part}: wider than an icon button at rest ` + JSON.stringify(rest));
    if (!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(rest.border[0]) && rest.border[1] !== '0px') throw Error(`${part}: has a frame ` + JSON.stringify(rest));
    if (!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(rest.fill) && !rest.fill.includes(', 0)')) throw Error(`${part}: has a fill at rest ` + JSON.stringify(rest));
    await ui.hover({ css: btn }); await ui.sleep(450);
    const hover = await read();
    if (hover.word < 20 || hover.wordOpacity < 0.95) throw Error(`${part}: the word did not slide out ` + JSON.stringify(hover));
    const want = await logo(colour);
    if (hover.icon !== want) throw Error(`${part}: icon ${hover.icon}, the logo's ${colour} ${want}`);
    await ui.screenshot(`${part}-hover`);
    await ui.mark({ css: btn }, { what: part === 'editor-top' ? 'Editor' : 'Terminal', where: '标题栏会话名旁边', how: '鼠标移上去滑出文字、图标上色' });
    await ui.mouse('mouseMoved', 5, 400); await ui.sleep(800);
    if ((await read()).word > 1) throw Error(`${part}: the word did not go back`);
  }
  await ui.screenshot('rest');
}
