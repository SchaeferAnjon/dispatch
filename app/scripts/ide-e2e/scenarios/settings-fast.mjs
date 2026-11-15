// Settings opens at once (kanban design/settings-fast): ⌘, and then every page in the side bar, the way a person
// clicks through them, twice (the first visit after the window opened, then again). For each click: the time from the
// click to the page's last change (its content complete), whether a loading placeholder or the word Loading showed
// at any moment, and which `dispatch` commands the window ran meanwhile (from the bridge's log). Writes timing.json,
// then fails when any page showed a loading placeholder. Nothing here starts an agent or changes a setting.
import fs from "node:fs";
import path from "node:path";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = { title: "设置秒开", description: "打开设置，左栏每一页点两遍：每页从点击到内容齐的毫秒数、有没有出现加载占位、期间跑了哪些 dispatch 命令。", timeout: 900 };

const PAGES = ["account", "agents", "soul", "keys", "appearance", "notifications", "awake", "network", "phone", "macs", "projects",
  "abilities", "skills", "tools", "plugins", "hooks", "instructions", "subagents", "knowledge"];

/** In the window: click `sel`, then watch the Settings page until it has not changed for `quietMs`: when it first and
 *  last changed, and every loading placeholder or Loading word seen on the way. */
const MEASURE = `(sel, quietMs, maxMs) => new Promise((resolve) => {
  const root = () => document.querySelector('.dispatch-settings-page');
  // what shows on the page (innerText: a section the embedded editor keeps, hidden, is not on screen), without the
  // line that says when a part was read and its spinner
  const textOf = (r) => {
    let out = r.innerText || '';
    for (const f of r.querySelectorAll('.dset-fresh')) { const t = f.innerText; if (t) out = out.split(t).join(''); }
    return out;
  };
  const loadingNow = () => {
    const r = root();
    if (!r) return [];
    const out = [];
    // what is on screen: the abilities' editor is made ahead, hidden, and draws its own first read there
    const shown = (sel) => [...r.querySelectorAll(sel)].filter(e => !e.closest('[hidden]'));
    if (shown('.dset-loading').length) out.push('skeleton');
    if (shown('.dset-pending').length) out.push('first read');
    if (shown('.dset-tile-val').some(e => !e.textContent.trim())) out.push('tile placeholder');
    const text = textOf(r);
    const m = text.match(/(Loading…|Loading\.\.\.|Reading…|Reading what git has…)/);
    if (m) out.push('text: ' + m[0]);
    if (r.querySelector('.monaco-progress-container.active, .monaco-progress-container.infinite')) out.push('progress bar');
    const spin = [...r.querySelectorAll('.codicon-loading')].filter(e => !e.closest('.dset-motion-preview, .dset-fresh') && e.offsetParent);
    if (spin.length) out.push('spinner x' + spin.length);
    return out;
  };
  const sig = () => { const r = root(); return r ? textOf(r) : ''; };
  const t0 = performance.now();
  const wall0 = performance.timeOrigin + t0;
  let last = sig();
  const el = document.querySelector(sel);
  if (!el) { resolve({ error: 'nothing matches ' + sel }); return; }
  el.click();
  // the window's next frame: a page drawn at the click shows then (an instance in the background gets fewer frames)
  let rafMs = null;
  requestAnimationFrame(() => { rafMs = Math.round(performance.now() - t0); });
  let first = null, lastAt = t0, seen = new Set();
  const changes = [];
  const tick = () => {
    const now = performance.now();
    const s = sig();
    for (const l of loadingNow()) seen.add(l);
    if (s !== last) {
      last = s;
      lastAt = now;
      if (first === null) first = now - t0;
      if (changes.length < 40) changes.push(Math.round(now - t0));
    }
    if (now - lastAt >= quietMs || now - t0 >= maxMs) {
      resolve({ wall0, rafMs, firstMs: first === null ? null : Math.round(first), doneMs: Math.round(lastAt - t0), settled: now - lastAt >= quietMs,
        loading: [...seen], changes, text: (root()?.innerText || '').slice(0, 3000) });
      return;
    }
    setTimeout(tick, 8);
  };
  tick();
})`;

/** The bridge's log lines (`dispatch <args> → code (ms)`) of every window of the instance, with their end time. */
function cliCalls(ui) {
  const dirs = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir, path.join(ui.rec.root || "", "user-data"), path.join(ui.rec.root || "", "agents-user-data")].filter(Boolean);
  const files = [];
  const walk = (d, depth) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 6) walk(p, depth + 1);
      else if (e.isFile() && /Dispatch\.log$/.test(e.name)) files.push(p);
    }
  };
  for (const d of new Set(dirs)) walk(path.join(d, "logs"), 0);
  const calls = [];
  const day = new Date().toISOString().slice(0, 10);
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      // the channel's own time stamp, then ours: "2026-10-09 10:11:12.345 [info] 10:11:12.340 dispatch a b → 0 (412 ms)"
      const m = line.match(/(\d\d:\d\d:\d\d\.\d{3}) (dispatch .+?) → (\S+) \((\d+) ms\)/);
      if (!m) continue;
      const end = Date.parse(`${day}T${m[1]}Z`);
      calls.push({ end, ms: Number(m[4]), start: end - Number(m[4]), what: m[2], code: m[3], file: path.basename(path.dirname(f)) });
    }
  }
  return calls;
}

export default async function (ui) {
  await ui.openAgents();
  await ui.waitFor({ css: ".sessions-chat-editor, .interactive-input-part", webview: false }, { timeoutMs: 60000 * SCALE }).catch(() => undefined);
  // a new window settles first (its agents connect, the first-run tip comes up): Settings is opened by a person a
  // moment after the window, not in its first second
  await ui.sleep(20000);
  for (let i = 0; i < 4 && (await ui.exists({ css: "button.dispatch-tour-close", webview: false })); i++) {
    await ui.click({ css: "button.dispatch-tour-close", webview: false }).catch(() => undefined);
    await ui.sleep(400);
  }
  await ui.waitFor({ css: ".sidebar-footer .dset-entry", webview: false });
  // what Settings shows is read once the window settled (one `dispatch settings-page`); on a busy build machine a new
  // window's first CLI runs take half a minute, so the clicking starts once that read is in (how long it took: firstRead
  // in timing.json).
  // The parts read from servers and other programs come one after another right after it (Settings' first window:
  // the allowances, the agents, the accounts, the network check): a new Mac's first window shows "Checking" on those
  // until then. The window reads some of them for itself as well, so these are the ones that start after it.
  const after = ["dispatch accounts watch", "dispatch engines detect", "dispatch accounts list", "dispatch net status"];
  let firstRead = null;
  for (let i = 0; i < 240 && firstRead === null; i++) {
    const calls = cliCalls(ui).sort((x, y) => x.start - y.start);
    const read = calls.find((c) => /^dispatch settings-page/.test(c.what));
    let end = read ? read.end : null;
    for (const what of after) {
      if (end === null) break;
      const c = calls.find((x) => x.what.startsWith(what) && x.start >= end - 50);
      end = c ? c.end : null;
    }
    if (end !== null) firstRead = { localMs: read.ms, allMs: end - read.start };
    else await ui.sleep(500);
  }

  const quiet = 2500, max = 30000 * SCALE;
  const runs = [];
  // the click and the watching start in the window; the first picture is taken right away (the page as it shows in its
  // first frames, about a tenth of a second after the click), then the watching is awaited
  const measure = async (pass, page, sel) => {
    await ui.cdp.eval(`window.__dsetMeasure = (${MEASURE})(${JSON.stringify(sel)}, ${quiet}, ${max}); 0`);
    const t = Date.now();
    const shot = await ui.cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(ui.out, `f${pass}-${page}.png`), Buffer.from(shot.data, "base64"));
    const r = await ui.cdp.eval("window.__dsetMeasure");
    runs.push({ pass, page, firstShotMs: Date.now() - t, ...r });
    return r;
  };

  for (const pass of [1, 2]) {
    await measure(pass, "overview", ".sidebar-footer .dset-entry");
    if (pass === 1) await ui.screenshot("p1-overview");
    for (const page of PAGES) {
      await measure(pass, page, `.dispatch-settings-nav .dsn-row[data-page="${page}"]`);
      if (pass === 1) await ui.screenshot(`p1-${page}`);
    }
    // back to the sessions, so the next pass opens Settings again
    await ui.press("Escape");
    await ui.sleep(1500);
    if (await ui.exists({ css: ".dispatch-settings-nav", webview: false })) await ui.press("Escape");
    await ui.sleep(1500);
  }
  await ui.sleep(1000);
  const calls = cliCalls(ui);
  for (const r of runs) {
    if (!r.wall0) continue;
    const until = r.wall0 + (r.doneMs ?? 0) + quiet;
    r.cli = calls.filter((c) => c.end >= r.wall0 && c.start <= until).map((c) => ({ what: c.what, ms: c.ms, startMs: Math.round(c.start - r.wall0), code: c.code }));
  }
  const table = runs.map((r) => ({ pass: r.pass, page: r.page, rafMs: r.rafMs, firstMs: r.firstMs, doneMs: r.doneMs, settled: r.settled, loading: (r.loading || []).join("; "), cli: (r.cli || []).length }));
  fs.writeFileSync(path.join(ui.out, "timing.json"), JSON.stringify({ firstRead, runs, calls }, null, 1));
  console.table(table);

  // a spinner on its own (an embedded page's list) is noted in timing.json, not a failure; placeholders and the words are
  const slow = runs.filter((r) => (r.loading || []).some((l) => !l.startsWith("spinner")));
  if (slow.length) {
    throw new Error(`a loading placeholder showed on: ${slow.map((r) => `${r.page} (pass ${r.pass}: ${r.loading.join(", ")})`).join("; ")}`);
  }
  // the Phone tile does not say "on" for a Mac with no phone (task-90441: "No phone yet / Phone access is on")
  const overview = runs.find((r) => r.page === "overview");
  if (overview && /No phone yet/.test(overview.text) && /Phone access is on/.test(overview.text)) {
    throw new Error("the Overview says No phone yet and Phone access is on");
  }
}
