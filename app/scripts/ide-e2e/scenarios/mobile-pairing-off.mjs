// The phone popover when nothing serves the phone: the instance's own chatd is stopped (only the one whose
// command line names this instance's folder), the popover says phone access is off, one button turns it on
// (a LaunchAgent named after the instance, removed at the end), and the code shows. Runs in a new instance of its own.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const run = promisify(execFile);
export const meta = { title: "手机访问没开", description: "后台部分没在跑时，弹层只说「手机访问没开」，一个按钮打开，之后出二维码。" };
const BUTTON = ".dispatch-mobile-button-label";
const PANEL = ".dispatch-mobile-panel";
function assert(ok, message) { if (!ok) throw new Error(message); }

export default async function (ui) {
  const label = `dev.dispatch-e2e-${ui.rec.name}.chatd`;
  const reg = `${ui.rec.dispatch_dir}/chatd.json`;
  try {
    await ui.attach("agents", 60000, "Dispatch Agent");
    await ui.closeOverlays();
    // a new instance may have no background part running at all; one that has gets its own stopped (nothing else's)
    let pid = 0;
    try { pid = JSON.parse(readFileSync(reg, "utf8")).pid; } catch { /* nothing serves the phone yet */ }
    const cmd = pid ? (await run("ps", ["-o", "command=", "-p", String(pid)]).catch(() => ({ stdout: "" }))).stdout : "";
    if (cmd) {
      assert(cmd.includes(ui.rec.root) && cmd.includes("chatd"), `pid ${pid} is not this instance's chatd: ${cmd}`);
      process.kill(pid, "SIGTERM");
      await ui.sleep(2500);
    }
    await ui.click({ css: BUTTON });
    // phone access turns on when you pair (the person's choice of 2026-10-07, task-lj06.19): the button goes to the code;
    // a popover that still says it is off has one button that does
    const panelText = () => ui.eval(`document.querySelector('${PANEL}')?.innerText || ''`);
    const t0 = Date.now();
    let first = null;
    let clicked = Date.now();
    while (!first && Date.now() - t0 < 90000) {
      if (await ui.exists({ css: `${PANEL} .dispatch-mobile-tile svg` })) first = "code";
      else if (/Turn on phone access/.test(await panelText())) first = "off";
      else {
        // a click that came while the title bar was still being drawn opened nothing: the person clicks again
        if (!(await ui.exists({ css: PANEL })) && Date.now() - clicked > 8000) {
          await ui.click({ css: BUTTON });
          clicked = Date.now();
        }
        await ui.sleep(1000);
      }
    }
    assert(first, `neither a code nor Turn on phone access: ${await panelText()}`);
    if (first === "off") {
      const text = await panelText();
      assert(!/chatd|daemon|service|terminal|CLI|port/i.test(text), `technical words: ${text}`);
      await ui.screenshot("01-off");
      await ui.mark({ css: PANEL }, { what: "手机访问没开时", where: "按钮的弹层", how: "点 Turn on phone access，之后出二维码" });
      await ui.click("Turn on phone access");
    }
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-tile svg` }, { timeoutMs: 90000 });
    // the code is the proof the service runs: how it was started (chatd, a LaunchAgent, `dispatch serve`) is Dispatch's
    // business (pairing starts it since task-lj06.19), and a test registers no LaunchAgent of its own
    await ui.screenshot("02-code-after-turn-on");
    await ui.click({ css: `${BUTTON}` });
    await ui.waitFor({ css: PANEL }, { gone: true, timeoutMs: 5000 });
    // outside click closes it too
    await ui.click({ css: BUTTON });
    await ui.waitFor({ css: PANEL });
    await ui.click({ css: ".monaco-workbench .part.sidebar, .monaco-workbench .part.editor" }).catch(() => undefined);
  } finally {
    await run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]).catch(() => undefined);
    await run("sh", ["-c", `rm -f "$HOME/Library/LaunchAgents/${label}.plist"`]).catch(() => undefined);
  }
}
