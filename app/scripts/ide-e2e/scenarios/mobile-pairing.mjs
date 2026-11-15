// The phone button in the Agents window's title bar (kanban task-0ol): click it, see the QR code and the six
// digits, decode the QR from a real screenshot (macOS CIDetector), pair a simulated phone with the secret that
// came out of the decoded QR, see "Paired", remove the phone, and let a code expire to see "New code".
// Run only inside an isolated instance (`dispatch ide instance start NAME --agents`): installing the phone
// access there registers a LaunchAgent named after the instance (dev.dispatch-e2e-NAME.chatd), which the
// scenario removes at the end. EXPIRY=0 skips the ten-minute wait for the code to run out.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const run = promisify(execFile);
export const meta = { timeout: 1200, title: "手机配对按钮", description: "标题栏手机图标：服务没开时一键打开，二维码和六位码，扫码解码，配对成功，移除，过期后换新码。" };

const BUTTON = ".dispatch-mobile-button-label";
const PANEL = ".dispatch-mobile-panel";
// macOS's own QR reader (fixtures/qrdecode.swift), built once per Mac into the e2e tools folder; QR_DECODER picks another
async function decoder() {
  if (process.env.QR_DECODER) return process.env.QR_DECODER;
  const here = new URL(".", import.meta.url).pathname;
  const tool = "/tmp/dide-e2e/_tools/qrdecode";
  if (!existsSync(tool)) {
    mkdirSync("/tmp/dide-e2e/_tools", { recursive: true });
    await run("swiftc", ["-O", "-o", tool, `${here}../fixtures/qrdecode.swift`], { timeout: 300000 });
  }
  return tool;
}

function assert(ok, message) { if (!ok) throw new Error(message); }

async function py(ui, code, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,'-c',sys.argv[2],*sys.argv[3:]],E.instance_env(r))";
  const out = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), `import sys; sys.path.insert(0, ${JSON.stringify(ui.rec.cli.replace(/\/[^/]*$/, ""))})\n${code}`, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return out.stdout.trim();
}
async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  const out = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { maxBuffer: 8 * 1024 * 1024 }).catch((e) => ({ stdout: e.stdout || "" }));
  return out.stdout.trim();
}
const panelText = (ui) => ui.eval(`document.querySelector('${PANEL}')?.innerText || ''`);

async function decode(ui, name) {
  await ui.screenshot(name);
  const png = `${ui.out}/${name}.png`;
  const { stdout } = await run(await decoder(), [png]).catch((e) => { throw new Error(`the QR code in ${name}.png does not decode: ${e.message}`); });
  return stdout.trim().split("\n")[0];
}

async function simulatePhone(ui, url, device, name) {
  return py(ui, `
import sys, time, urllib.request, urllib.parse
import mobile
payload = mobile.parse_pairing_url(sys.argv[1])
key = mobile.hkdf(mobile.unb64url(payload["secret"]), mobile.KEY_LAN)
ts = int(time.time())
sig = mobile.sign(key, "GET", "/v1/hello", ts, b"")
req = urllib.request.Request("http://127.0.0.1:%d/v1/hello" % (payload["port"] + 1), headers={
    "X-Dispatch-Pair": payload["pair"], "X-Dispatch-Device": sys.argv[2], "X-Dispatch-Time": str(ts), "X-Dispatch-Sig": sig,
    "X-Dispatch-Device-Name": urllib.parse.quote(sys.argv[3])})
print(urllib.request.urlopen(req, timeout=10).status)
`, url, device, name);
}

export default async function (ui) {
  const instance = ui.rec.name;
  // a port of its own: the real Mac's phone service (7788) stays alone
  // (only once: the service keeps the port it started on)
  const current = JSON.parse(await cli(ui, "mobile", "config", "port", "--json")).port;
  if (String(current) === "7788") await cli(ui, "mobile", "config", "port", String(20000 + Math.floor(Math.random() * 2000) * 2));
  const label = `dev.dispatch-e2e-${instance}.chatd`;
  try {
    await ui.attach("agents", 60000, "Dispatch Agent");
    await ui.closeOverlays();
    await ui.waitFor({ css: BUTTON });
    await ui.mark({ css: BUTTON }, { what: "手机配对按钮", where: "标题栏右侧，面板开关的左边", how: "点一下，弹出二维码" });
    const before = await ui.eval(`(() => { const b = document.querySelector('${BUTTON}').getBoundingClientRect(); const next = [...document.querySelectorAll('.titlebar-session-actions-container .action-item')].filter(e => /side panel/i.test(e.querySelector('[aria-label]')?.getAttribute('aria-label') || e.getAttribute('aria-label') || '')).map(e => e.getBoundingClientRect().x); return { x: b.x, w: b.width, aria: document.querySelector('${BUTTON}').getAttribute('aria-label'), nextX: next.length ? Math.min(...next) : null, right: !!document.querySelector('${BUTTON}').closest('.titlebar-session-actions-container') && b.x > innerWidth / 2 }; })()`);
    assert(before.aria === "Pair iPhone", `button label: ${before.aria}`);
    // on a page (the Assistant's home) the side panel toggle is not shown: the button is in the title bar's right group
    assert(before.nextX === null ? before.right : before.x + before.w <= before.nextX, `the phone button is not left of the side panel toggle: ${JSON.stringify(before)}`);

    // 1. the popover; with no background service the one button that turns it on
    await ui.click({ css: BUTTON });
    await ui.waitFor({ css: PANEL });
    await ui.waitFor("Pair your iPhone");
    // the popover asks the Mac first: wait until it says off or shows a code, not while it still loads
    let text = await panelText(ui);
    for (const end = Date.now() + 60000; !/Phone access is off/.test(text) && !(await ui.exists({ css: `${PANEL} .dispatch-mobile-tile svg` })) && Date.now() < end; text = await panelText(ui)) await ui.sleep(500);
    const down = /Phone access is off/.test(text);
    if (down) {
      assert(/Turn on phone access/.test(text), "the off state has no Turn on phone access button");
      assert(!/chatd|daemon|service|terminal|CLI|port/i.test(text), `technical words in the off state: ${text}`);
      await ui.screenshot("01-off");
      await ui.mark({ css: PANEL }, { what: "手机访问没开时", where: "按钮的弹层", how: "点 Turn on phone access" });
      await ui.click("Turn on phone access");
    }
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-tile svg` }, { timeoutMs: 90000 });

    // 2. the code and the QR
    text = await panelText(ui);
    const digits = (await ui.eval(`document.querySelector('.dispatch-mobile-code')?.textContent || ''`)).replace(/\s/g, "");
    assert(/^\d{6}$/.test(digits), `six digits expected, got ${digits}`);
    assert(/Pair your iPhone/.test(text) && /tap Scan/.test(text) && /Expires in \d+:\d\d/.test(text), `popover text: ${text}`);
    assert(!/chatd|daemon|service|terminal|CLI|port/i.test(text), `technical words in the popover: ${text}`);
    const box = await ui.eval(`(() => { const r = document.querySelector('${PANEL} .dispatch-mobile-tile svg').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    assert(box.w >= 200 && box.h >= 200, `QR too small: ${JSON.stringify(box)}`);
    const url = await decode(ui, "02-code");
    assert(url.startsWith("dispatch://pair?d="), `decoded QR is not a pairing link: ${url.slice(0, 40)}`);
    await ui.mark({ css: `${PANEL} .dispatch-mobile-tile` }, { what: "二维码", where: "弹层中间", how: "用 iPhone 上的 Dispatch 扫" });
    const pending = JSON.parse(await cli(ui, "mobile", "devices", "--json")).filter((d) => d.status === "pending");
    const decodedPair = JSON.parse(Buffer.from(url.split("d=")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).pair;
    assert(pending.some((d) => d.id === decodedPair), "the decoded QR is not the pairing the Mac is waiting for");
    writeFileSync(`${ui.out}/decoded.txt`, `${url}\npair ${decodedPair}\ncode ${digits}\n`);

    // 3. a phone pairs with what came out of the QR
    await simulatePhone(ui, url, "sim-phone-1", "Test iPhone");
    // the popover's own "Paired phones" heading is always there: wait for the line about this phone
    for (const end = Date.now() + 30000; !/Test iPhone is connected to this Mac/.test(text = await panelText(ui)) && Date.now() < end; ) await ui.sleep(500);
    assert(/Test iPhone is connected to this Mac/.test(text), `paired text: ${text}`);
    await ui.screenshot("03-paired");
    await ui.mark({ css: `${PANEL} .dispatch-mobile-done` }, { what: "配对成功", where: "弹层中间", how: "手机扫完自动出现" });
    assert(/Paired phones/.test(text) && /Test iPhone/.test(text), "the phone is not in the list");

    // 4. another one, then remove both
    await ui.click("Pair another phone");
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-tile svg` }, { timeoutMs: 30000 });
    const url2 = await decode(ui, "04-another");
    assert(url2 !== url, "a new code was expected");
    await simulatePhone(ui, url2, "sim-phone-2", "Second iPhone");
    await ui.waitFor("Second iPhone is connected", { timeoutMs: 15000 });
    await ui.click({ css: `${PANEL} .dispatch-mobile-remove`, index: 0 });
    let rows = -1;
    for (const until = Date.now() + 10000; Date.now() < until && rows !== 1; await ui.sleep(300)) rows = await ui.eval(`document.querySelectorAll('${PANEL} .dispatch-mobile-row').length`);
    assert(rows === 1, `one phone should be left, ${rows} rows`);
    await ui.click({ css: `${PANEL} .dispatch-mobile-remove`, index: 0 });
    await ui.waitFor("No phone is paired yet", { timeoutMs: 10000 });
    await ui.screenshot("05-removed");
    const left = JSON.parse(await cli(ui, "mobile", "devices", "--json")).filter((d) => d.status === "paired");
    assert(left.length === 0, `phones left on the Mac: ${JSON.stringify(left)}`);

    // 5. a code that runs out: a countdown, then Code expired and New code
    await ui.click("Pair another phone").catch(() => undefined);
    if (process.env.EXPIRY !== "0") {
      await ui.waitFor({ css: `${PANEL} .dispatch-mobile-countdown` }, { timeoutMs: 30000 });
      const first = await ui.eval(`document.querySelector('.dispatch-mobile-code')?.textContent`);
      const t0 = await ui.eval(`document.querySelector('.dispatch-mobile-countdown').textContent`);
      await ui.sleep(3000);
      const t1 = await ui.eval(`document.querySelector('.dispatch-mobile-countdown').textContent`);
      assert(t0 !== t1, `the countdown does not move: ${t0} / ${t1}`);
      await ui.waitFor("Code expired", { timeoutMs: 11 * 60 * 1000 });
      await ui.screenshot("06-expired");
      await ui.mark({ css: `${PANEL} .dispatch-mobile-expiry` }, { what: "过期后", where: "二维码下面", how: "点 New code 换一个" });
      await ui.click("New code");
      await ui.waitFor("Expires in", { timeoutMs: 30000 });
      const second = await ui.eval(`document.querySelector('.dispatch-mobile-code')?.textContent`);
      assert(second !== first, "New code gave the same code");
      const pend = JSON.parse(await cli(ui, "mobile", "devices", "--json")).filter((d) => d.status === "pending");
      assert(pend.length === 1, `exactly one waiting code expected, got ${pend.length}`);
    }
    await ui.click({ css: BUTTON });
    await ui.waitFor({ css: PANEL }, { gone: true, timeoutMs: 5000 });
  } finally {
    // the LaunchAgent this scenario installed under its own name, and its plist
    await run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]).catch(() => undefined);
    await run("sh", ["-c", `rm -f "$HOME/Library/LaunchAgents/${label}.plist"`]).catch(() => undefined);
  }
}
