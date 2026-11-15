import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
export const meta = { title: 'Docs 标题栏固定工具', description: '阅读页、列表、单图放大、整篇放大和滚动绘制。' };
const baseline = process.env.DOCS_TOOLBAR_BASELINE === '1';
export default async function(ui) {
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR:rec.beads_dir, DISPATCH_DIR:rec.dispatch_dir, DISPATCH_HOME:rec.dispatch_home, DISPATCH_BIN:rec.cli, DISPATCH_E2E_INSTANCE:rec.name };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  const cli = (...args) => execFileSync('python3', [rec.cli,...args], {env, cwd:rec.folder, encoding:'utf8', timeout:90000});
  const check = async (name, expr) => { if (!await ui.eval(expr)) throw Error(name); console.error('ok: '+name); };
  await ui.openAgents(rec.folder);
  await ui.newSession(rec.folder);
  await ui.openTab('Docs');
  await ui.screenshot('00-demo');
  const dir=path.join(rec.folder,'design','docs-toolbar'); fs.mkdirSync(dir,{recursive:true});
  fs.copyFileSync(path.join(ui.out,'00-demo.png'),path.join(dir,'screen.png'));
  fs.writeFileSync(path.join(dir,'reader.md'),'# Toolbar regression\n\n'+Array.from({length:8},(_,i)=>`## Section ${i+1}\n\nRead, scroll and draw on this document.\n\n![Section ${i+1}](screen.png)\n`).join('\n'));
  const show = file => cli('ide','show',path.join(dir,file),'--json');
  show('reader.md');
  await ui.waitFor({css:'.dispatch-docs-md img'});
  await ui.hover({css:'.dispatch-docs-md img'});
  await ui.screenshot('01-reader');
  if (baseline) {
    fs.writeFileSync(path.join(ui.out,'observed.json'),JSON.stringify(await ui.eval(`({bar:document.querySelector('.dispatch-draw-bar')?.className,head:[...document.querySelectorAll('.dispatch-docs-reader-head button')].map(b=>b.getAttribute('aria-label')||b.textContent)})`),null,2));
    return;
  }
  const head='.dispatch-docs-reader-head';
  await check('no image hover toolbar', `!document.querySelector('.dispatch-draw-bar.visible')`);
  const noOverlap = sel => `(() => {const a=[...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);return a.every((r,i)=>a.every((s,j)=>i===j||r.right<=s.left+1||s.right<=r.left+1||r.bottom<=s.top+1||s.bottom<=r.top+1))})()`;
  await check('reader buttons do not overlap',noOverlap(head+' button'));
  await ui.mark({css:head},{what:'固定工具栏',where:'Docs 阅读页顶行',how:'笔绘制整篇，放大占满窗口，菜单保留文件操作'});
  await ui.click({css:'.dispatch-docs-md img'});
  await ui.waitFor({css:'.dispatch-docs-picture'});
  await ui.screenshot('02-picture');
  await ui.press('Escape');
  await ui.waitFor({css:'.dispatch-docs-picture'},{gone:true});
  // the reader has no Enlarge of its own any more (fb6a2ee2): the side pane's own size is the one
  await check('no Enlarge in the reader',`!document.querySelector(${JSON.stringify(head)}+' .dispatch-docs-enlarge')`);
  await ui.click({aria:'Draw and ask',exact:true,within:head});
  await ui.waitFor({css:'.dispatch-draw-overlay'},{timeoutMs:60000});
  await ui.screenshot('04-draw');
  // Continue in the built app: verify the drawing canvas pans using real wheel input.
  const vp=await ui.eval(`(() => { const e=document.querySelector('.dispatch-draw-overlay .canvas'); if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  if (!vp) throw Error('no drawing viewport');
  const before=await ui.eval(`document.querySelector('.dispatch-draw-overlay .canvas')?.scrollTop`);
  await ui.mouse('mouseWheel',vp.x,vp.y,{deltaX:0,deltaY:450}); await ui.sleep(350);
  await check('drawing scroll moves the page',`document.querySelector('.dispatch-draw-overlay .canvas')?.scrollTop!==${JSON.stringify(before)}`);
  await ui.screenshot('05-draw-scrolled');
  await ui.press('Escape');
  await ui.waitFor({css:'.dispatch-draw-overlay'},{gone:true});
  await ui.click({aria:'More Actions',exact:true,within:head});
  await ui.waitFor({text:'Open in Editor',exact:true});
  await ui.press('Escape');
  await ui.click({css:'.dispatch-docs-back'});
  await ui.waitFor({css:'.dispatch-docs-bar'});
  await check('list buttons do not overlap',noOverlap('.dispatch-docs-bar button'));
  await ui.click({css:'.dispatch-docs-search-box'});
  await ui.type('Toolbar',{into:{css:'.dispatch-docs-search-input'}});
  await check('search and tools do not overlap',noOverlap('.dispatch-docs-bar button,.dispatch-docs-search-box'));
  await ui.screenshot('06-list-search');
  await ui.press('Escape');
  fs.writeFileSync(path.join(dir,'notes.md'),'# Toolbar delivery\n\n- Fixed controls.\n\n## 在哪：Docs toolbar\n\n1. Toolbar · Docs · Open a document\n\n## 改了什么\n\n![Picture](screen.png)\n\n'+Array.from({length:5},(_,i)=>`### Section ${i+1}\n\n![Picture](screen.png)\n`).join('\n')+'\n## 没做的\n\n没有\n');
  fs.writeFileSync(path.join(dir,'00-where.json'),JSON.stringify({image:'screen.png',items:[{n:1,box:[10,40,250,100],what:'Toolbar',where:'Docs',how:'Open document'}]}));
  const task=JSON.parse(cli('begin','Toolbar fixture','-P','demo','-d','isolated toolbar test','--force','--json'));
  cli('deliver',task.id||task.task,'--from',dir,'--model','GPT 6 astra · high','--show','--json');
  // a delivery page opens in the integrated browser, in its own tab (fb6a2ee2)
  await ui.waitFor({css:'.tabs-container .tab.dispatch-tab-doc.active'},{timeoutMs:30000});
  const page=await ui.browserPage('127.0.0.1:');
  await ui.sleep(1200);
  // the page's own Enlarge (a page in its own tab: the template's button, no reader around it)
  await page.click('.where .enl');
  if (!await page.eval(`document.querySelector('.where').classList.contains('full')`)) throw Error('Enlarge did not enlarge the picture');
  // Esc reaches the page itself (a key pressed in the window goes to the workbench, not the native page)
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  if (await page.eval(`document.querySelector('.where').classList.contains('full')`)) throw Error('picture Escape failed');
  await ui.screenshot('07-delivery');
  await ui.mark({css:'.tabs-container .tab.dispatch-tab-doc.active'},{what:'交付页在自己的标签里',where:'右栏',how:'dispatch deliver --show；点图片看大图，Esc 关'});
}
