// Regression acceptance for project Tasks in a worktree and switching a running conversation to Codex. The conversation
// starts on OpenCode with the cheap test model (SWITCH_FROM="Claude Code" runs it from Claude Code, which spends the
// Claude allowance).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
export const meta = { needs: ['opencode', 'codex'], timeout: 900, title: "worktree Tasks 与引擎切换", description: "创建演示会话，切 Tasks 到项目，再切到 Codex 并检查归档标题。" };
const FROM = process.env.SWITCH_FROM || 'OpenCode';
export default async function(ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine(FROM, 240000);
  await ui.sleep(6000);
  await ui.click({css:'.sessions-chat-editor'});
  await ui.type('Reply exactly READY FOR SWITCH. Do not use any tools.');
  await ui.press('Enter',{send:true});
  // the reply, give or take a full stop (DeepSeek adds one)
  await ui.waitFor({text:'READY FOR SWITCH',within:'.interactive-response'},{timeoutMs:120000});
  await ui.sleep(2000);
  await ui.openTab('Tasks');
  await ui.click({css:'.dispatch-tasks-scope [role="tab"]',index:1});
  await ui.waitFor({text:'Add a Knowledge page',within:'.dispatch-tasks'},{timeoutMs:30000});
  await ui.screenshot('01-worktree-tasks');
  await ui.mark({css:'.dispatch-tasks'}, {what:'worktree 的项目任务',where:'右栏 Tasks',how:'点 demo'});
  await writeFile(path.join(ui.out, 'ui-state.json'),JSON.stringify(await ui.eval('document.body.innerText')));
  await ui.click({css:'.dispatch-harness-picker'});
  await ui.click({text:'Codex',exact:true,within:'.context-view'});
  // the note the next agent is given, in the person's language
  for (let t0 = Date.now(); ; await ui.sleep(1000)) {
    const body = await ui.eval(`document.querySelector('.interactive-list')?.innerText || ''`);
    if (body.includes(`从 ${FROM} 换到了 Codex`) || body.includes(`moved from ${FROM} to Codex`)) break;
    if (Date.now() - t0 > 120000) throw new Error(`the conversation never said it moved from ${FROM} to Codex`);
  }
  await ui.sleep(15000);
  // the Done group is listed by default now; the filter menu only when it is not (clicking Done there would hide it)
  const doneGroup = {css:'.agent-sessions-viewpane .monaco-list-row[aria-label^="Done,"]'};
  if (!(await ui.exists(doneGroup))) {
    await ui.click('Filter Sessions');
    await ui.hover({text:'Filter',exact:true,within:'.context-view'});
    await ui.click({text:'Done',exact:true,within:'.context-view'});
    await ui.press('Escape');
  }
  await ui.waitFor(doneGroup,{timeoutMs:30000});
  if ((await ui.eval(`document.querySelector('.agent-sessions-viewpane .monaco-list-row[aria-label^="Done,"]')?.getAttribute('aria-expanded')`)) !== 'true') await ui.click(doneGroup);
  await ui.waitFor({css:'.monaco-list-row[aria-label^="Switched to Codex:"]'},{timeoutMs:30000});
  await ui.screenshot('02-switched-title');
  await ui.mark({css:'.monaco-list-row[aria-label^="Switched to Codex:"]'},{what:'切换后的旧会话标题',where:'左栏 Done',how:'切到 Codex 后展开 Done'});
  await writeFile(path.join(ui.out, 'ui-state.json'),JSON.stringify(await ui.eval('document.body.innerText')));
}
