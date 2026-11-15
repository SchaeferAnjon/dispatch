// A person who skips setup on its first screen still gets a task board (audit round 1, kanban task-cq11p). Without
// one, every task tool of an agent failed and the reply and the side pane showed bd's own error ("no beads database
// found"). The instance has a new person's HOME and no board yet.
import assert from "node:assert/strict";
import fs from "node:fs";

export const meta = { instance: { onboarding: "fresh" }, title: "跳过首次设置也有任务板", description: "全新 HOME 里向导第一屏就点 Skip setup：向导收成「Finish setting up Dispatch」，任务板照样建好。", timeout: 300 };

const filled = dir => fs.existsSync(dir) && fs.readdirSync(dir).length > 0;

export default async function (ui) {
  assert.ok(ui.rec.fixture_home, "Start this instance with --onboarding fresh");
  await ui.attach("agents", 60000);
  await ui.waitFor("Agents on this Mac", { timeoutMs: 90000 });
  await ui.sleep(1500);
  assert.equal(filled(ui.rec.beads_dir), false, `a board is there before setup did anything: ${ui.rec.beads_dir}`);
  await ui.screenshot("01-first-screen");
  await ui.click("Skip setup");
  await ui.waitFor({ aria: "Finish setting up Dispatch" }, { timeoutMs: 30000 });
  for (let t0 = Date.now(); !filled(ui.rec.beads_dir) && Date.now() - t0 < 30000;) await ui.sleep(300);
  assert.equal(filled(ui.rec.beads_dir), true, `no task board after Skip setup: ${ui.rec.beads_dir}`);
  await ui.screenshot("02-skipped");
  await ui.mark({ aria: "Finish setting up Dispatch" }, { what: "跳过以后向导收在这里", where: "窗口里", how: "点它接着设置；任务板这时已经建好" });
}
