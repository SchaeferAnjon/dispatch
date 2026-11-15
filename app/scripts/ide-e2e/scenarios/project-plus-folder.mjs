// The + on a project's row opens the new session in the project's own folder, also when the project has sessions in
// copies (worktrees). It took the folder of one of those: kanban's + opened in kanban-wt/branch-00 and the agent's
// changes landed there (audit round 1, kanban task-cq11p). The fixture has three projects with worktree sessions;
// ALG's only session is in a worktree outside the project folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const meta = { instance: { fixture: "sidebar-groups" }, title: "项目行的加号开在项目自己的文件夹", description: "项目里有在副本里跑的会话时，悬停项目行点 +（New Session），新会话页的文件夹 chip 仍是这个项目，不是它的某个副本。kanban、TUTOR、ALG 各点一次。", timeout: 300 };

const chip = ui => ui.eval(`(() => {
  const t = document.querySelector('.sessions-workspace-picker-trigger');
  if (!t) return null;
  const labels = [t, ...t.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') || '').filter(Boolean);
  return { label: labels.find(l => /^Workspace/.test(l)) || labels[0] || '', text: t.innerText.replace(/\\s+/g, ' ').trim() };
})()`);

async function plusOn(ui, name) {
  // the way a person does it: the pointer on the project's row, then the + that shows on it. The list is still
  // filling in for a while after the window opens and a row drawn again loses the pointer: try again
  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      // the list only draws the rows in view: bring the project's row in first
      await ui.wheelUntil({ text: name, exact: true, within: ".agent-sessions-viewpane" }, { over: ".agent-sessions-viewpane" });
      await ui.hover({ text: name, exact: true, within: ".agent-sessions-viewpane" });
    } catch (e) { last = String(e.message || e); await ui.sleep(1500); continue; }
    await ui.sleep(600);
    last = await ui.eval(`(() => {
      document.querySelectorAll('[data-e2e-group]').forEach(e => e.removeAttribute('data-e2e-group'));
      const pane = document.querySelector('.agent-sessions-viewpane');
      const leaf = [...pane.querySelectorAll('*')].find(e => !e.children.length && e.textContent.trim() === ${JSON.stringify(name)} && e.getClientRects().length);
      if (!leaf) return { why: 'no text' };
      // the row: the nearest block around the name that carries a New Session action
      let row = leaf.parentElement;
      for (let i = 0; row && row !== pane && i < 8 && !row.querySelector('[aria-label^="New Session"]'); i++) row = row.parentElement;
      if (!row || row === pane || !row.querySelector('[aria-label^="New Session"]')) return { why: 'no New Session near the name', cls: String(leaf.parentElement.className) };
      row.setAttribute('data-e2e-group', 'it');
      return { cls: String(row.className), names: row.querySelectorAll('[aria-label^="New Session"]').length };
    })()`);
    if (last && last.names === 1 && await ui.exists({ aria: "New Session", within: '[data-e2e-group="it"]' })) {
      await ui.click({ aria: "New Session", within: '[data-e2e-group="it"]' });
      await ui.sleep(2500);
      return;
    }
    await ui.sleep(1200);
  }
  assert.fail(`+ on ${name}: the row's New Session never showed: ${JSON.stringify(last)}`);
}

export default async function (ui) {
  await ui.openAgents();
  // the side bar lists the fixture's seventeen projects by name and only draws the rows in view: kanban is below
  // the fold, plusOn wheels to each project
  await ui.waitFor({ text: "Projects", exact: true, within: ".agent-sessions-viewpane" }, { timeoutMs: 60000 });
  await ui.sleep(5000); // the fixture's hundred sessions are still coming into the list
  const worktrees = await ui.eval(`[...document.querySelectorAll('.agent-sessions-viewpane .session-section-label')].filter(e => e.innerText.trim() === 'Worktrees').length`);
  assert.ok(worktrees > 0, "the fixture shows no Worktrees group: nothing to tell apart");
  const seen = {};
  for (const name of ["kanban", "TUTOR", "ALG"]) {
    await plusOn(ui, name);
    const c = await chip(ui);
    seen[name] = c;
    fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(seen, null, 1));
    assert.ok(c, `no folder chip on the new-session page after + on ${name}`);
    const words = `${c.label} ${c.text}`;
    assert.ok(new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(words), `+ on ${name}: the folder is not ${name}: ${JSON.stringify(c)}`);
    assert.ok(!/branch-\d+|copy-\d+|agent-\d+|worktree/i.test(words), `+ on ${name}: the folder is one of its copies: ${JSON.stringify(c)}`);
    await ui.screenshot(`plus-${name}`);
  }
  await ui.mark({ css: ".sessions-workspace-picker-trigger" }, { what: "新会话的文件夹", where: "输入框上方", how: "项目行的 + 开出来的页，这里是项目自己" });
}
