// Extra acceptance for the Docs toolbar: real sash drag, search, scroll, light/dark, and HTML drawing.
import fs from 'fs';
import path from 'path';
export const meta={title:'Docs 工具栏宽窄与深浅色验收',description:'阅读页和列表 420 / 800 宽，网页绘制滚动。'};
export default async function(ui) {
  await ui.openAgents(ui.rec.folder);
  await ui.openTab('Docs');
  // A fresh instance has nothing open: show a long HTML page in the reader first (it used to rely on
  // docs-toolbar having run just before on the same instance).
  const rec = ui.rec;
  const env = { ...process.env, BEADS_DIR:rec.beads_dir, DISPATCH_DIR:rec.dispatch_dir, DISPATCH_HOME:rec.dispatch_home, DISPATCH_BIN:rec.cli, DISPATCH_E2E_INSTANCE:rec.name };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') || k.startsWith('CODEX_')) delete env[k];
  const dir = path.join(rec.folder, 'design', 'docs-toolbar'); fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, 'toolbar-regression.html');
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><title>Toolbar regression</title></head><body style="font:16px system-ui;margin:24px">' +
    Array.from({ length: 30 }, (_, i) => `<h2>Section ${i + 1}</h2><p>Read, scroll and draw on this page. Line ${i + 1}.</p>`).join('') + '</body></html>');
  (await import('child_process')).execFileSync('python3', [rec.cli, 'ide', 'show', page, '--json'], { env, cwd: rec.folder, encoding: 'utf8', timeout: 90000 });
  await ui.waitFor({ css: '.dispatch-docs-reader-head' }, { timeoutMs: 60000 });
  await ui.sleep(1500);
  const results=[];
  const width=async w=>{
    const b=await ui.eval(`(()=>{const p=document.querySelector('.dispatch-docs').getBoundingClientRect();const s=[...document.querySelectorAll('.monaco-sash.vertical')].map(e=>e.getBoundingClientRect()).find(r=>r.height>200&&Math.abs(r.x+r.width/2-p.x)<15);return s?{x:s.x+s.width/2,y:s.y+s.height/2,right:p.right}:null})()`);
    if(!b)throw Error('no Docs sash');
    await ui.mouse('mouseMoved',b.x,b.y);await ui.mouse('mousePressed',b.x,b.y,{button:'left',clickCount:1});
    for(let i=1;i<=8;i++)await ui.mouse('mouseMoved',b.x+(b.right-w-b.x)*i/8,b.y,{button:'left',buttons:1});
    await ui.mouse('mouseReleased',b.right-w,b.y,{button:'left',clickCount:1});await ui.sleep(400);
  };
  const shot=async name=>{
    const r=await ui.eval(`(()=>{const r=document.querySelector('.dispatch-docs').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
    const image=await ui.cdp.send('Page.captureScreenshot',{format:'png',clip:r});
    fs.writeFileSync(path.join(ui.out,name+'.png'),Buffer.from(image.data,'base64'));
    const rects=await ui.eval(`(()=>{const root=document.querySelector('.dispatch-docs');const h=root.querySelector('.dispatch-docs-reader-head,.dispatch-docs-bar');return [...h.querySelectorAll('button,.dispatch-docs-search-box')].filter(e=>e.offsetWidth&&e.offsetHeight).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.textContent,x:r.x,y:r.y,right:r.right,bottom:r.bottom}})})()`);
    for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.x<b.right-1&&a.right>b.x+1&&a.y<b.bottom-1&&a.bottom>b.y+1)throw Error('overlap: '+JSON.stringify([a,b]));}
    results.push({name,width:r.width,rects});
  };
  const theme=async t=>{
    for(const dir of [ui.rec.user_data_dir,ui.rec.agents_user_data_dir]){
      const f=path.join(dir,'User','settings.json');const settings=JSON.parse(fs.readFileSync(f,'utf8'));
      Object.assign(settings,{'window.autoDetectColorScheme':false,'workbench.colorTheme':t==='light'?'Dispatch Light':'Dispatch Dark'});fs.writeFileSync(f,JSON.stringify(settings));
    }
    await ui.sleep(1300);
  };
  for(const t of ['light','dark']){
    await theme(t);
    for(const w of [420,800]){await width(w);await shot(`reader-${w}-${t}`);}
  }
  await width(420);
  await ui.click({aria:'Draw and ask',exact:true,within:'.dispatch-docs-reader-head'});
  await ui.waitFor({css:'.dispatch-draw-overlay'},{timeoutMs:90000});
  const canvas=await ui.eval(`(()=>{const e=document.querySelector('.dispatch-draw-overlay .canvas'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,top:e.scrollTop,height:e.scrollHeight,vh:e.clientHeight}})()`);
  if(canvas.height<=canvas.vh)throw Error('HTML draw did not capture whole page');
  await ui.mouse('mouseWheel',canvas.x,canvas.y,{deltaX:0,deltaY:500});await ui.sleep(500);
  if(await ui.eval(`document.querySelector('.dispatch-draw-overlay .canvas').scrollTop`)===canvas.top)throw Error('HTML drawing cannot scroll');
  await ui.screenshot('html-draw-scrolled');await ui.press('Escape');
  await ui.waitFor({css:'.dispatch-draw-overlay'},{gone:true});
  await ui.click({css:'.dispatch-docs-back'});
  for(const t of ['light','dark']){
    await theme(t);
    for(const w of [420,800]){
      await width(w);await shot(`list-${w}-${t}`);
      await ui.click({css:'.dispatch-docs-search'});await ui.type('Toolbar',{into:{css:'.dispatch-docs-search-input'}});await shot(`search-${w}-${t}`);await ui.press('Escape');
    }
  }
  fs.writeFileSync(path.join(ui.out,'layout.json'),JSON.stringify(results,null,2));
}
