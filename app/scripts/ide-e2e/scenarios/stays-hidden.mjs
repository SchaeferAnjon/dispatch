// The test instance stays off the person's screen and out of their keyboard (task-4cpnb): no window of it can be seen
// (CGWindowList: on screen and not transparent), and it is never the frontmost app (lsappinfo front), while its
// windows still draw (a CDP picture).
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";

export const meta = { title: "Test windows stay hidden and never take focus", description: "No window of the instance can be seen and it is never the frontmost app (task-4cpnb); its windows still draw", exclusive: true };

const front = () => {
  const out = execFileSync("/bin/sh", ["-c", "lsappinfo info -only pid -only name $(lsappinfo front)"], { encoding: "utf8", timeout: 5000 });
  const pid = Number((out.match(/"pid"=(\d+)/) || [])[1]);
  return { pid, name: (out.match(/"LSDisplayName"="([^"]*)"/) || [])[1] || "" };
};

export default async function (ui) {
  if (process.platform !== "darwin") return ui.skip("macOS only");
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const f = front();
    const shown = ui.windowsOnScreen();
    seen.push({ at: i * 500, front: f, onScreen: shown });
    if (f.pid === ui.rec.pid) throw new Error(`the test instance (pid ${ui.rec.pid}) is the frontmost app: ${JSON.stringify(seen)}`);
    if (shown === null) throw new Error("the window list cannot be read");
    if (shown.length) throw new Error(`windows of the test instance can be seen: ${JSON.stringify(shown)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  await ui.openAgents();
  await ui.screenshot("agents-drawn");
  const f = front();
  if (f.pid === ui.rec.pid) throw new Error(`after switching windows the test instance is the frontmost app (pid ${f.pid})`);
  writeFileSync(join(ui.out, "focus.json"), JSON.stringify({ instancePid: ui.rec.pid, samples: seen, after: f }, null, 1));
}
