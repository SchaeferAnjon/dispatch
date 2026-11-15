// Phone access is off until you pair, and says the truth (task-lj06.19, the person's choice of 2026-10-07: "turn on
// only when pairing"). A new instance: `dispatch mobile status` says off, Settings › Phone says off and that pairing
// turns it on. The title bar's phone button: a code, the service running, Settings says on. Turn off. Then another
// program holds the port: pairing gives no code, the panel and Settings say Phone access is not working, why (the
// port) and what to do; Use another port and the code comes. Run in an isolated instance (its own DISPATCH_DIR).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const run = promisify(execFile);
export const meta = { title: "手机访问默认关，没起来时如实说", description: "全新实例手机访问是关的；点标题栏手机按钮配对才打开；端口被占时不给配对码，说清原因和怎么办，换个端口就好。", timeout: 600 };
const BUTTON = ".dispatch-mobile-button-label";
const PANEL = ".dispatch-mobile-panel";
const PAGE = "(document.querySelector('.dispatch-settings-page')?.innerText || '')";
function assert(ok, message) { if (!ok) throw new Error(message); }

async function cli(ui, ...args) {
  const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],E.instance_env(r))";
  const out = await run("python3", ["-c", bootstrap, JSON.stringify(ui.rec), ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 90000 }).catch((e) => ({ stdout: e.stdout || "" }));
  return out.stdout.trim();
}
const status = async (ui) => JSON.parse((await cli(ui, "mobile", "status", "--json")) || "{}");
const panelText = (ui) => ui.eval(`document.querySelector('${PANEL}')?.innerText || ''`);

async function until(ui, fn, what, ms = 60000, every = 700) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await ui.sleep(every);
  }
  throw new Error(`Timed out: ${what}`);
}
async function closeTips(ui) {
  for (let i = 0; i < 4 && await ui.exists({ css: ".dispatch-tour-close" }); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
}
async function openPhoneSettings(ui) {
  if (!(await ui.exists({ css: ".dispatch-settings-nav", webview: false }))) await ui.press("Cmd+,");
  await ui.waitFor({ css: ".dispatch-settings-nav", webview: false }, { timeoutMs: 20000 });
  await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="phone"]`, webview: false });
  await until(ui, async () => /Phone access is (on|off|not working|turning on)/.test(await ui.eval(PAGE)), "Settings › Phone", 30000);
  await ui.sleep(800);
  return ui.eval(PAGE);
}
async function closeSettings(ui) {
  for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-settings-nav", webview: false })); i++) {
    await ui.click({ css: ".dispatch-settings-nav .dsn-back", webview: false }).catch(() => ui.press("Escape"));
    await ui.sleep(800);
  }
}
async function openPanel(ui) {
  if (!(await ui.exists({ css: PANEL }))) await ui.click({ css: BUTTON });
  await ui.waitFor({ css: PANEL }, { timeoutMs: 15000 });
}
async function closePanel(ui) {
  if (await ui.exists({ css: PANEL })) await ui.press("Escape");
  await ui.sleep(500);
}

/** Holds a port the way another program would: every interface, and the loopback one after it. */
function holdPort(port, out) {
  const code = `import socket,time
s=[]
for host,p in (("0.0.0.0",${port}),("127.0.0.1",${port + 1})):
    x=socket.socket(); x.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); x.bind((host,p)); x.listen(5); s.append(x)
print("held",flush=True)
time.sleep(900)`;
  const p = spawn("python3", ["-c", code], { stdio: ["ignore", "pipe", "inherit"] });
  writeFileSync(`${out}/port-holder.pid`, String(p.pid));
  return new Promise((resolve, reject) => {
    p.stdout.once("data", () => resolve(p));
    p.once("exit", (c) => reject(new Error(`the port holder exited ${c}`)));
  });
}

export default async function (ui) {
  const facts = {};
  let holder;
  try {
    await ui.openAgents(ui.demoFolder);
    await ui.closeOverlays();
    await closeTips(ui);

    // 1. a new Mac: off, and nothing listens
    facts.fresh = await status(ui);
    assert(facts.fresh.access === "off" && facts.fresh.running === false && !facts.fresh.problem, `a fresh instance is not off: ${JSON.stringify({ access: facts.fresh.access, running: facts.fresh.running, problem: facts.fresh.problem })}`);
    // a port of its own: the Mac's real phone service (7788) stays alone
    const port = 21000 + Math.floor(Math.random() * 1500) * 2;
    await cli(ui, "mobile", "config", "port", String(port));
    facts.port = port;
    let page = await openPhoneSettings(ui);
    facts.settingsFresh = page;
    assert(/Phone access is off/.test(page) && /It turns on when you pair a phone/.test(page) && !/Phone access is on/.test(page), `Settings › Phone on a new Mac: ${page}`);
    await ui.screenshot("01-settings-off");
    await ui.mark({ css: '.dset-row[data-access]', webview: false }, { what: "新用户：手机访问默认是关的，说明配对手机时才打开", where: "设置 › Phone 第一行", how: "⌘, 打开设置，点 Phone" });
    await closeSettings(ui);

    // 2. the phone button: pairing turns it on, a code comes, the service is this instance's own. With no background
    //    service running yet the panel has one button that starts it (a LaunchAgent named after the instance,
    //    removed at the end), as mobile-pairing-off checks
    await openPanel(ui);
    const first = await until(ui, async () => (await ui.exists({ css: `${PANEL} .dispatch-mobile-tile svg` })) ? "code" : /Turn on phone access/.test(await panelText(ui)) ? "off" : null, "a code or the button that turns it on", 60000);
    facts.firstPanel = first;
    if (first === "off") {
      await ui.screenshot("02a-no-background-service");
      await ui.click("Turn on phone access");
    }
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-tile svg` }, { timeoutMs: 90000 });
    const digits = (await ui.eval(`document.querySelector('.dispatch-mobile-code')?.textContent || ''`)).replace(/\s/g, "");
    assert(/^\d{6}$/.test(digits), `six digits expected, got ${digits}`);
    facts.afterPair = await status(ui);
    assert(facts.afterPair.access === "on" && facts.afterPair.running === true && facts.afterPair.port === port, `after pairing: ${JSON.stringify({ access: facts.afterPair.access, running: facts.afterPair.running, port: facts.afterPair.port })}`);
    await ui.screenshot("02-pair-turns-it-on");
    await ui.mark({ css: `${PANEL} .dispatch-mobile-tile` }, { what: "点标题栏手机按钮去配对，这时才打开手机访问", where: "标题栏手机按钮的弹层", how: "点手机图标" });
    await closePanel(ui);
    page = await openPhoneSettings(ui);
    assert(/Phone access is on/.test(page) && /Turn off/.test(page), `Settings after pairing: ${page}`);
    await ui.screenshot("03-settings-on");
    await ui.mark({ css: '.dset-row[data-access]', webview: false }, { what: "配对后：手机访问开着，可以关", where: "设置 › Phone 第一行", how: "Turn off 关掉" });

    // 3. Turn off: off at once, and the service goes
    await ui.click({ text: "Turn off", exact: true, within: ".dispatch-settings-page" });
    await until(ui, async () => /Phone access is off/.test(await ui.eval(PAGE)), "Settings saying off", 20000);
    await until(ui, async () => { const s = await status(ui); return s.access === "off" && !s.running; }, "the service stopping", 30000, 1500);
    facts.afterOff = true;
    await closeSettings(ui);

    // 4. another program holds the port: no code, why and what to do
    await until(ui, async () => (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).then((r) => r.stdout, () => "")) === "", "the port to be free", 30000, 1000);
    holder = await holdPort(port, ui.out);
    await openPanel(ui);
    const down = await until(ui, async () => { const t = await panelText(ui); return /Phone access is not working/.test(t) ? t : null; }, "the panel saying it is not working", 60000);
    facts.panelProblem = down;
    assert(new RegExp(`port ${port}`).test(down) && /Quit that program/.test(down) && /Use another port/.test(down) && /Try again/.test(down), `the panel: ${down}`);
    assert(!(await ui.exists({ css: `${PANEL} .dispatch-mobile-code` })) && !(await ui.exists({ css: `${PANEL} .dispatch-mobile-tile svg` })), "a pairing code was shown although nothing answers the phone");
    facts.statusProblem = (await status(ui)).problem;
    assert(facts.statusProblem?.reason === "port_in_use" && !(await status(ui)).running, `status: ${JSON.stringify(facts.statusProblem)}`);
    await ui.screenshot("04-port-taken-panel");
    await ui.mark({ css: `${PANEL} .dispatch-mobile-down` }, { what: "端口被别的程序占着：不给配对码，说清原因和怎么办", where: "标题栏手机按钮的弹层", how: "Use another port 换个端口，或关掉占着的程序再 Try again" });
    await closePanel(ui);
    page = await openPhoneSettings(ui);
    facts.settingsProblem = page;
    assert(/Phone access is not working/.test(page) && new RegExp(`port ${port}`).test(page) && /Use another port/.test(page) && !/Phone access is on/.test(page), `Settings with the port taken: ${page}`);
    await ui.screenshot("05-port-taken-settings");
    await ui.mark({ css: '.dset-row[data-access]', webview: false }, { what: "设置也如实说没开、为什么、怎么办", where: "设置 › Phone 第一行", how: "Use another port / Try again / Turn off" });
    await closeSettings(ui);

    // 5. Use another port: a code, on a free port
    await openPanel(ui);
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-another-port` }, { timeoutMs: 20000 });
    await ui.click({ css: `${PANEL} .dispatch-mobile-another-port` });
    await ui.waitFor({ css: `${PANEL} .dispatch-mobile-tile svg` }, { timeoutMs: 90000 });
    facts.afterAnotherPort = await status(ui);
    assert(facts.afterAnotherPort.running === true && facts.afterAnotherPort.port !== port, `after Use another port: ${JSON.stringify({ running: facts.afterAnotherPort.running, port: facts.afterAnotherPort.port })}`);
    await ui.screenshot("06-another-port-code");
    await ui.mark({ css: `${PANEL} .dispatch-mobile-tile` }, { what: "换了端口，配对码出来了", where: "弹层", how: "点 Use another port" });
    await closePanel(ui);
  } finally {
    writeFileSync(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
    if (holder) holder.kill("SIGTERM");
    const label = `dev.dispatch-e2e-${ui.rec.name}.chatd`;
    if (facts.firstPanel === "off") {
      await run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]).catch(() => undefined);
      await run("sh", ["-c", `rm -f "$HOME/Library/LaunchAgents/${label}.plist"`]).catch(() => undefined);
    }
    await cli(ui, "mobile", "off", "--json").catch(() => undefined);
  }
}
