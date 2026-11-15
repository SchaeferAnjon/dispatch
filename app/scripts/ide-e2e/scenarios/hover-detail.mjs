// Shared hover details, direction A, on the seeded demo project with the world of fixtures/hover_detail.py (tasks of
// every kind, a plan, a delivery with its picture, something only you can do, a decision: meta.instance.fixture).
// Without HOVER_STAGE it checks Waiting for you's and the Task graph's details; the HOVER_STAGE stages are run by hand.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
const approvedFile = ui => JSON.parse(readFileSync(`${ui.rec.root}/hover-approval.json`,"utf8")).file;
const run = promisify(execFile);
const cli = async (ui, ...args) => {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  return JSON.parse((await run("python3", ["-c",bootstrap,JSON.stringify(ui.rec),...args,"--json"], {env:process.env,maxBuffer:8*1024*1024})).stdout);
};
export const meta = { instance: { fixture: "hover-detail" }, timeout: 600, title: "悬停详情", description: "七处悬停入口、四类等你事项、任务详情、斜向移动和放大图。" };
const panel = ".dispatch-hover-detail-panel";
const model = "zai-coding-plan/glm-5.3-flash";
function assert(value, message) { if (!value) throw new Error(message); }
async function waitingItems(ui) {
  const until=Date.now()+60000;
  do {
    const result=await cli(ui,'waiting');
    if (!result.partial?.length) return result.items;
    await ui.sleep(1000);
  } while (Date.now()<until);
  throw new Error('Waiting for you did not return a complete Agent Host snapshot');
}
async function visibleDetail(ui, row, name) {
  await ui.waitFor({css:row},{timeoutMs:60000});
  await ui.hover({ css: row }, { settleMs: 450 });
  await ui.waitFor({ css: panel });
  await ui.waitFor({css:`${panel} .dispatch-detail-loading`},{gone:true,timeoutMs:30000});
  const geometry = await ui.eval(`(() => {
    const d = document.querySelector('${panel}'), r = document.querySelector('${row}');
    const b = d.getBoundingClientRect(), a = r.getBoundingClientRect();
    const style=getComputedStyle(d), title=d.querySelector('.dispatch-hover-head'), field=d.querySelector('.dispatch-detail-field');
    return { x:b.x, y:b.y, w:b.width, h:b.height, rowY:a.y, side:d.dataset.side, vw:innerWidth, vh:innerHeight, text:d.innerText,
      style:{padding:style.padding,gap:style.gap,radius:style.borderRadius,background:style.backgroundColor,
        title:title ? {whiteSpace:getComputedStyle(title).whiteSpace,overflow:getComputedStyle(title).textOverflow} : null,
        field:field ? {display:getComputedStyle(field).display,columns:getComputedStyle(field).gridTemplateColumns,gap:getComputedStyle(field).gap} : null},
      fields:[...d.querySelectorAll('.dispatch-detail-field')].map(f=>{const k=f.querySelector('dt').getBoundingClientRect(),v=f.querySelector('dd').getBoundingClientRect();return {label:f.querySelector('dt').textContent,labelWidth:k.width,valueX:v.x,gap:v.x-k.right};}) };
  })()`);
  assert(geometry.x >= 7 && geometry.y >= 7 && geometry.x + geometry.w <= geometry.vw - 7 && geometry.y + geometry.h <= geometry.vh - 7, `Detail outside viewport: ${JSON.stringify(geometry)}`);
  assert(!geometry.text.includes("task-"), "Opaque task id in detail");
  writeFileSync(`${ui.out}/${name}.json`,JSON.stringify(geometry,null,2));
  await ui.screenshot(name);
  await ui.mark({ css: panel }, { what: name, where: "指向的行旁边", how: "悬停看完整内容，移入后可直接操作" });
  return geometry;
}

async function whatsNew(ui) {
    if (!(await ui.exists({css:".dispatch-whats-new-entry"}))) {
      await ui.step("key","F1",async()=>{
        await ui.cdp.send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"F1",code:"F1",windowsVirtualKeyCode:112});
        await ui.cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"F1",code:"F1",windowsVirtualKeyCode:112});
      });
      await ui.waitFor({css:".quick-input-widget input"});
      await ui.type("Show What's New as After an Update",{into:{css:".quick-input-widget input"}});
      await ui.press("Enter");
      await ui.waitFor({css:".dispatch-whats-new-entry"});
    }
    await ui.click({css:".dispatch-whats-new-entry"});
    await ui.waitFor({css:".dispatch-whats-new-card .wnrow"});
    await visibleDetail(ui,".dispatch-whats-new-card .wnrow","07-whats-new-picture");
    const image=await ui.eval(`(() => { const i=document.querySelector('${panel} img'); return {loaded:!!i?.naturalWidth,text:document.querySelector('${panel}')?.innerText}; })()`);
    assert(image.loaded,"Enlarged picture did not load");
    return image;
}

export default async function(ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:885,deviceScaleFactor:2,mobile:false});
  ui.viewport=await ui.eval("({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})");
  await ui.newSession();
  const theme=process.env.HOVER_THEME;
  if (theme === 'light' || theme === 'dark') {
    await ui.setTheme(theme);
  }
  if (process.env.HOVER_STAGE === "setup" || process.env.HOVER_STAGE === "approve-setup") {
    const picker = ".sessions-chat-session-type-picker";
    await ui.pickEngine("OpenCode");
    await ui.waitFor({css:'.model-picker-name[aria-label*="GLM-5.3-Flash"]'},{timeoutMs:30000});
    const selected = await ui.eval(`document.querySelector('.model-picker-name')?.getAttribute('aria-label')`);
    assert(/GLM-5\.3-Flash/i.test(selected) && /Z\.AI Coding Plan/i.test(selected), `Expected ${model}, got ${selected}`);
    writeFileSync(`${ui.out}/engine.json`, JSON.stringify({engine:"OpenCode",model,selected},null,2));
    const isolation='.sessions-chat-isolation-checkbox [role="checkbox"][aria-checked="true"]';
    if (await ui.exists({css:isolation})) await ui.click({css:isolation});
    await ui.click({css:".sessions-chat-editor"});
    if (process.env.HOVER_STAGE === "approve-setup") {
      assert(ui.demoFolder.includes("/gx-hover-demo/") && ui.demoFolder.endsWith("/demo"),"Approval test needs the disposable gx-hover-demo project");
      writeFileSync(`${ui.rec.root}/hover-approval.json`, JSON.stringify({file:resolve(ui.demoFolder,`hover-approval-${Date.now()}.txt`)}));
    }
    const prompt = process.env.HOVER_STAGE === "approve-setup"
      ? `Hover approval demo\n\nUse the bash tool once to run this exact command: printf HOVER_APPROVED > '${approvedFile(ui)}'. The file belongs to this disposable demo repository. Do not call other tools or retry if denied. After the write completes, reply with exactly: The demo file was written successfully. It contains HOVER_APPROVED. This reply provides the complete summary that the hover detail should display, including every sentence after the first. The final sentence confirms that there is no additional work queued for this demo.`
      : "Reply exactly: Hover detail demo ready.";
    await ui.type(prompt);
    await ui.press("Enter",{send:true});
    if (process.env.HOVER_STAGE === "setup") {
      // the model may answer in its own words (in Chinese with the Dispatch plugin): wait for its answer, not the exact text
      await ui.waitFor({css:".interactive-list .interactive-response:not(.chat-response-loading)"},{timeoutMs:120000});
    } else {
      await ui.sleep(12000);
      await ui.click({css:".dispatch-waiting-section"});
      await ui.waitFor({css:".dispatch-waiting-page"},{timeoutMs:30000});
      await ui.waitFor({css:'.dispatch-waiting-card[data-kind="approve"]'},{timeoutMs:90000});
      // Give the disposable session a complete readable name before capturing its detail.
      await ui.step("rename-session","Hover approval demo",async()=>{
        const r=await ui.find({css:".session-item .session-title"}); const b=r.hits[0].box;
        const x=b.x+b.w/2,y=b.y+b.h/2;
        await ui.mouse("mouseMoved",x,y);
        for(const n of [1,2]) { await ui.mouse("mousePressed",x,y,{clickCount:n}); await ui.mouse("mouseReleased",x,y,{clickCount:n}); }
      });
      await ui.waitFor({css:".session-title-input input"});
      await ui.type("Hover approval demo");
      await ui.press("Enter");
      await ui.click({css:".dispatch-waiting-section"});
      await ui.waitFor({css:".dispatch-waiting-page"},{timeoutMs:30000});
      await ui.waitFor({css:'.dispatch-waiting-card[data-kind="approve"]'},{timeoutMs:30000});
    }
    await ui.screenshot("demo-session");
    return {text:await ui.eval("document.body.innerText.slice(-5000)")};
  }
  if (process.env.HOVER_STAGE === "whats-new") return whatsNew(ui);
  if (process.env.HOVER_STAGE === "sidebar" || process.env.HOVER_STAGE === "diagnose") {
    await ui.hover({text:"demo",within:".session-section"},{settleMs:900});
    await ui.waitFor({css:".dispatch-tasks-hover"});
    await visibleDetail(ui,".dispatch-tasks-hover .dispatch-hover-row:has(.dispatch-task-mark[data-status=in_progress])","02-project-detail");
    if (process.env.HOVER_STAGE === "diagnose") {
      await ui.sleep(1500);
      await ui.screenshot("project-detail-settled");
      const metrics = await ui.eval(`Array.from(document.querySelectorAll('${panel} .dispatch-detail-field')).map(e=>({html:e.outerHTML,display:getComputedStyle(e).display,columns:getComputedStyle(e).gridTemplateColumns,gap:getComputedStyle(e).gap,children:Array.from(e.children).map(c=>({tag:c.tagName,display:getComputedStyle(c).display,x:c.getBoundingClientRect().x,w:c.getBoundingClientRect().width}))}))`);
      writeFileSync(`${ui.out}/metrics.json`,JSON.stringify(metrics,null,2));
      return;
    }
    await ui.press("Escape");
    await ui.hover({css:".session-item"},{settleMs:900});
    await ui.waitFor({css:".dispatch-tasks-hover-session:not(.hidden)"},{timeoutMs:20000});
    await visibleDetail(ui,".dispatch-tasks-hover-session .dispatch-hover-row","03-session-detail");
    await ui.click({text:"Open session",exact:true,within:panel});
    await ui.waitFor({css:".interactive-list .interactive-response"},{timeoutMs:30000});
    return;
  }
  if (process.env.HOVER_STAGE === "timeline") {
    await ui.click({text:"Projects",exact:true});
    await ui.waitFor({text:"Timeline",exact:true},{timeoutMs:30000});
    await ui.click({text:"Timeline",exact:true});
    await ui.waitFor({css:".dispatch-projects-tl-mk.dot"},{timeoutMs:90000});
    // the demo folder keeps sessions of earlier runs: take the newest dot whose card lists this run's session
    const dots = await ui.eval(`document.querySelectorAll('.dispatch-projects-tl-mk.dot').length`);
    let row = -1;
    for (let i = dots - 1; i >= 0 && row < 0; i--) {
      await ui.hover({css:".dispatch-projects-tl-mk.dot", index:i},{settleMs:700});
      await ui.waitFor({css:".dispatch-projects-card-row"},{timeoutMs:10000}).catch(() => undefined);
      row = await ui.eval(`[...document.querySelectorAll('.dispatch-projects-card-row')].findIndex(r => /Hover detail demo/i.test(r.innerText))`);
    }
    assert(row >= 0, "No Timeline dot lists this run's Hover detail demo session");
    // that dot can hold several demo sessions: the fixture's is the one whose detail lists its tasks
    // (a session row's detail: the session's title, then "Tasks · N" and a row per task)
    const tasksShown = `(() => { const d = document.querySelector('${panel}'); return !!d && /Tasks · \\d+/.test(d.innerText) && d.querySelectorAll('.dispatch-projects-session-task').length > 0; })()`;
    const rows = await ui.eval(`document.querySelectorAll('.dispatch-projects-card-row').length`);
    for (let r = rows - 1; r >= 0; r--) {
      await ui.hover({css:".dispatch-projects-card-row", index:r},{settleMs:900});
      await ui.sleep(1500); // the tasks come from the CLI after the card opens
      if (await ui.eval(tasksShown)) { row = r; break; }
    }
    await ui.hover({css:".dispatch-projects-card-row", index:row},{settleMs:450});
    await ui.waitFor({css:`${panel} .dispatch-projects-session-task`},{timeoutMs:30000});
    const card = await ui.eval(`(() => { const d = document.querySelector('${panel}'); return { head: d.querySelector('.dispatch-hover-head')?.innerText || '', text: d.innerText, tasks: [...d.querySelectorAll('.dispatch-projects-session-task')].map(b => b.innerText.trim()) }; })()`);
    assert(card.head.trim().length > 0, "the detail's head is the session's title");
    assert(/Tasks · \d+/.test(card.text) && card.tasks.length > 0, "the session's detail lists its tasks");
    assert(/OpenCode|Claude Code|Codex/.test(card.text), "the detail names the engine as people write it");
    await visibleDetail(ui,".dispatch-projects-card-row","05-timeline-detail");
    return;
  }
  if (process.env.HOVER_STAGE === "pictures") {
    await ui.openTab("Tasks");
    await ui.click({text:"demo",within:".dispatch-tasks"});
    await ui.waitFor({css:".dispatch-task-deliverable-icon.where"},{timeoutMs:30000});
    await ui.hover({css:".dispatch-task-deliverable-icon.where"},{settleMs:900});
    await ui.waitFor({css:".dispatch-where-snippet"});
    await visibleDetail(ui,".dispatch-where-snippet .dispatch-where-leg li","06-deliverable-picture");
    await ui.hover({css:`${panel} .dispatch-detail-btn`});
    await ui.click({text:"Whole picture",exact:true,within:panel});
    await ui.screenshot("picture-whole");
    await ui.press("Escape");
    return whatsNew(ui);
  }
  if (process.env.HOVER_STAGE === "edge") {
    await ui.cdp.send("Emulation.setDeviceMetricsOverride",{width:820,height:886,deviceScaleFactor:2,mobile:false});
    try {
      await ui.sleep(600);
      ui.viewport=await ui.eval("({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})");
      await ui.click({css:".dispatch-waiting-section"});
      await ui.waitFor({css:".dispatch-waiting-page"},{timeoutMs:30000});
      await ui.hover({css:".dispatch-waiting-page"});
      await ui.hover({css:".dispatch-waiting-section"},{settleMs:900});
      await ui.waitFor({css:".dispatch-waiting-hover"});
      const metrics=await visibleDetail(ui,'.dispatch-waiting-hover [data-id="task:task-hvy1"]',"narrow-detail");
      writeFileSync(`${ui.out}/edge.json`,JSON.stringify(metrics,null,2));
      assert(metrics.side==='inline' || metrics.side==='left','Narrow detail did not use the fallback');
    } finally {
      await ui.cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    return;
  }
  await ui.click({css:".dispatch-waiting-section"});
  await ui.waitFor({css:".dispatch-waiting-page"},{timeoutMs:30000});
  await ui.hover({css:".dispatch-waiting-page"});
  await ui.hover({css:".dispatch-waiting-section"},{settleMs:900});
  await ui.waitFor({css:".dispatch-waiting-hover"});
  if (process.env.HOVER_STAGE === "before") {
    await ui.hover({css:".dispatch-waiting-hover .dispatch-hover-row"},{settleMs:500});
    await ui.screenshot("before-waiting");
    await ui.press("Escape");
    await ui.newSession(); await ui.openTab("Tasks"); await ui.click({css:".dispatch-tasks-graph"});
    await ui.waitFor({css:".dispatch-tg-empty, .dispatch-tg-lane"},{timeoutMs:40000});
    await ui.click({text:"demo",within:".dispatch-tg-seg"});
    await ui.waitFor({css:".dispatch-tg-hit"},{timeoutMs:40000});
    await ui.hover({css:".dispatch-tg-hit"},{settleMs:800});
    if(await ui.exists({css:".dispatch-tg-card-row"})) await ui.hover({css:".dispatch-tg-card-row"},{settleMs:500});
    await ui.screenshot("before-graph");
    return;
  }
  if (["approve","deny","unread"].includes(process.env.HOVER_STAGE)) {
    const kind = process.env.HOVER_STAGE;
    const expected = (await waitingItems(ui)).find(x=>x.kind===(kind==='deny'?'approve':kind));
    const row = expected ? `.dispatch-waiting-hover [data-id=${JSON.stringify(expected.id)}]` : '';
    assert(expected,`Missing ${kind} item in CLI`);
    const detail = await visibleDetail(ui,row,`${kind}-detail`);
    assert(detail.text.includes(kind === 'unread' ? 'Mark read' : 'Allow'), `Wrong waiting detail: ${detail.text}`);
    if (kind === 'deny') {
      await ui.click({text:'Deny',exact:true,within:panel});
      await ui.waitFor({text:'Denied',exact:true,within:panel},{timeoutMs:120000});
      assert(!existsSync(approvedFile(ui)),'Denied command wrote the file');
      await ui.screenshot('approve-denied');
    } else if (kind === 'approve') {
      const boxes = await ui.eval(`(() => { const r=document.querySelector('${row}').getBoundingClientRect(), d=document.querySelector('${panel}').getBoundingClientRect(); const b=[...document.querySelectorAll('${panel} button')].find(x=>x.textContent==='Allow').getBoundingClientRect(); return {r:{x:r.x,y:r.y,w:r.width,h:r.height},d:{x:d.x,y:d.y,w:d.width,h:d.height},b:{x:b.x,y:b.y,w:b.width,h:b.height},id:document.querySelector('${panel} [data-waiting-id]').dataset.waitingId}; })()`);
      await ui.step('diagonal-pointer', 'Allow', async () => {
        const start={x:boxes.r.x+boxes.r.w/2,y:boxes.r.y+boxes.r.h/2}, end={x:boxes.b.x+boxes.b.w/2,y:boxes.b.y+boxes.b.h/2};
        for (const t of [.25,.5,.75,1]) await ui.mouse('mouseMoved',start.x+(end.x-start.x)*t,start.y+(end.y-start.y)*t);
        await ui.sleep(320);
        const id=await ui.eval(`document.querySelector('${panel} [data-waiting-id]')?.dataset.waitingId`);
        assert(id===boxes.id,'Diagonal move changed the active detail');
        const linked=await ui.eval(`document.querySelector('.dispatch-waiting-item.linked')?.dataset.id`);
        assert(linked===boxes.id,'Diagonal move changed the linked page item');
      });
      await ui.screenshot('approve-diagonal');
      await ui.click({text:'Allow',exact:true,within:panel});
      await ui.waitFor({text:'Allowed',exact:true,within:panel},{timeoutMs:120000});
      await ui.screenshot('approve-allowed');
      await ui.sleep(2500);
      assert(readFileSync(`${approvedFile(ui)}`,'utf8').trim()==='HOVER_APPROVED','Allow did not complete the approved command');
    } else {
      assert(expected.summary && detail.text.includes(expected.summary.trim()),'Unread detail lost the full summary from the CLI');
      await ui.click({text:'Mark read',exact:true,within:panel});
      await ui.waitFor({text:'Undo',exact:true,within:panel},{timeoutMs:120000});
      await ui.screenshot('unread-marked');
      assert(!(await waitingItems(ui)).some(x=>x.id===expected.id),'Mark read did not remove the unread item');
    }
    return;
  }
  if (process.env.HOVER_STAGE === "decide") {
    await visibleDetail(ui,'.dispatch-waiting-hover [data-id="task:task-hvd1"]',"decide-detail");
    const styles=await ui.eval(`Array.from(document.querySelectorAll('${panel} .dispatch-detail-options button')).map(e=>({cls:e.className,width:getComputedStyle(e).borderTopWidth,color:getComputedStyle(e).borderTopColor,widget:getComputedStyle(e).getPropertyValue('--vscode-widget-border'),hover:getComputedStyle(e).getPropertyValue('--vscode-editorHoverWidget-border')}))`);
    writeFileSync(`${ui.out}/button-styles.json`,JSON.stringify(styles,null,2));
    await ui.click({css:`${panel} .dispatch-detail-options button`});
    await ui.waitFor({css:".dispatch-reason-input"});
    await ui.screenshot("decide-reason");
    await ui.type("The list stays in place while reading the full request.",{into:{css:".dispatch-reason-input"}});
    await ui.press("Enter");
    await ui.waitFor({text:"Answered",exact:true,within:panel},{timeoutMs:120000});
    await ui.screenshot("decide-answered");
    const flow=await cli(ui,"flow","show","task-hvd1");
    assert(flow.picked==="A" && flow.reason.includes("list stays"),"The pick or its reason was not saved");
    return;
  }
  if (process.env.HOVER_STAGE === "only-you") {
    await visibleDetail(ui,'.dispatch-waiting-hover [data-id="task:task-hvy1"]',"only-you-detail");
    await ui.click({text:"Done",exact:true,within:panel});
    await ui.waitFor({text:"Undo",exact:true,within:panel},{timeoutMs:120000});
    await ui.screenshot("only-you-done");
    await ui.click({text:"Undo",exact:true,within:panel});
    await ui.sleep(1500);
    assert((await waitingItems(ui)).some(x=>x.task==="task-hvy1"),"Undo did not restore Only you");
    return;
  }
  const waiting = await visibleDetail(ui, ".dispatch-waiting-hover .dispatch-hover-row", "01-waiting-detail");
  await ui.press("Escape");
  await ui.newSession(); await ui.openTab("Tasks"); await ui.click({css:".dispatch-tasks-graph"});
  await ui.waitFor({css:".dispatch-tg-empty, .dispatch-tg-lane"},{timeoutMs:40000});
  await ui.click({text:"demo",within:".dispatch-tg-seg"});
  await ui.waitFor({css:".dispatch-tg-hit"},{timeoutMs:40000});
  await ui.hover({css:".dispatch-tg-hit"},{settleMs:700});
  const graph = await visibleDetail(ui, ".dispatch-tg-card-row", "04-task-graph-detail");
  for(const label of ["Plan", "Delivered", "Session", "Branched off", "Last activity", "Who"]) assert(graph.text.includes(label), `Task detail missing ${label}`);
  await ui.click({text:"Open task",exact:true,within:panel});
  await ui.waitFor({css:".dispatch-task-page"},{timeoutMs:30000});
  await ui.screenshot("open-task");
  return {waiting,graph};
}
