// Point and talk without a Soniox key, walked the way the person did it (task-5wvgj: "Open Keys" opened Settings › Keys,
// where the only way to add a key was a row under dozens of keys). The instance has a HOME of its own with an empty key
// store (fixtures/soniox_home.py), so this Mac's keys are never read or written; every value typed here is made up.
//   1. a session on OpenCode's cheap model; the camera brings the key card (no SONIOX_API_KEY in the store);
//   2. Open Keys: Settings › Keys with the form open, Name SONIOX_API_KEY, the purpose filled in, the cursor in Value;
//   3. a made-up value pasted, Save key: the key is in the store, the card goes by itself;
//   4. the camera again: no key card, on to the permissions and the recording (Discard);
//   5. forty keys: Add key stands next to Search keys without scrolling, and stays in sight scrolled to the end;
//      it opens the form at the top of the list, the cursor in Name;
//   6. the card again with the key there: Open Keys opens that key's Edit, scrolled to, the cursor in Value;
//   7. the made-up value is nowhere in the window's text or the instance's logs.
// Light and dark screenshots; every check in qa.json, the run fails at the end when one did not hold.
export const meta = {
  instance: { fixture: "soniox-home", motion: true },
  needs: ["opencode"],
  exclusive: true,
  timeout: 900,
  title: "Point and talk 没 Key：Open Keys 直接展开添加表单，存好卡片自己消失",
  description: "新 HOME 没有任何 Key：点摄像机出 Soniox 卡；Open Keys 打开设置 › Keys 并展开添加表单（名字 SONIOX_API_KEY、用途已填、光标在值上）；填假值存好，卡片自己消失，再点摄像机往下走到录制；四十个 Key 时搜索框旁的 Add key 不用滚动就看得见、滚到底也在；Key 已在时 Open Keys 打开它的 Edit。",
};

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const T = "window.__dispatchPointTalkTest";
const INPUT = ".session-view .interactive-input-part";
const CAMERA = { css: `${INPUT} .chat-execute-toolbar .action-label.codicon-device-camera-video` };
const LAST = `(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`;
const RUNNING = `!!document.querySelector('${INPUT} .chat-execute-toolbar .codicon-stop-circle')`;
const PAGE = ".dispatch-settings-page";
const KEY = "SONIOX_API_KEY";
const NOTE = "Point and talk speech recognition (Soniox)";
const VALUE = "fake-e2e-soniox-5wvgj-0001";
const MANY = 40;

export default async function (ui) {
  const rec = ui.rec;
  if (!rec.keys_home) {
    throw new Error("Start this instance with --fixture soniox-home (meta.instance), so it has a HOME of its own");
  }
  const store = path.join(rec.keys_home, ".config", "dispatch", "env");
  const qa = { checks: [], failed: [], facts: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  /** The store as the CLI keeps it: {NAME: {value, note}}. */
  const keys = () => {
    const out = {};
    let n = "";
    for (const line of (fs.existsSync(store) ? fs.readFileSync(store, "utf8") : "").split("\n")) {
      if (!line.trim()) { n = ""; continue; }
      if (line.startsWith("#")) { const c = line.replace(/^#\s*/, ""); if (!/^project:/.test(c)) n = c; continue; }
      const i = line.indexOf("=");
      if (i > 0) { out[line.slice(0, i)] = { value: line.slice(i + 1).replace(/^'(.*)'$/, "$1"), note: n }; n = ""; }
    }
    return out;
  };
  /** The instance's own CLI in the instance's environment (its HOME, board and DISPATCH_HOME). */
  const cli = (args, input) => {
    const bootstrap = "import os,sys,json; r=json.loads(sys.argv[1]); sys.path.insert(0,os.path.dirname(r['cli'])); import ide_e2e as E; env=dict(E.instance_env(r)); os.execve(sys.executable,[sys.executable,r['cli'],*sys.argv[2:]],env)";
    return execFileSync("python3", ["-c", bootstrap, JSON.stringify(rec), ...args], { input, env: process.env, timeout: 60000, encoding: "utf8" });
  };
  const state = () => ui.eval(`${T}.state()`);
  const events = () => ui.eval(`${T}.events()`);
  const shots = async (name) => {
    await closeTips(ui);
    await ui.setTheme("light");
    await ui.sleep(700);
    await ui.screenshot(`${name}-light`);
    await ui.setTheme("dark");
    await ui.sleep(700);
    await ui.screenshot(`${name}-dark`);
    await ui.setTheme("light");
    await ui.sleep(400);
  };
  /** Settings › Keys in light and dark: the theme is switched on Settings › Appearance, so the list is opened again
   *  after each switch (a form open on the page would be gone: those are shot in the theme they were opened in). */
  const keysShots = async (name) => {
    await ui.screenshot(`${name}-light`);
    for (const mode of ["dark", "light"]) {
      await ui.setTheme(mode);
      if (!(await ui.exists({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' }))) await ui.press("Cmd+,");
      await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' });
      await until(ui, async () => { const b = await addButton(); return b && b.rows >= MANY + 2 ? b : null; }, 15000, "the keys again", 300);
      await ui.sleep(600);
      if (mode === "dark") {
        await ui.screenshot(`${name}-dark`);
        const d = await addButton();
        check("the line's colour is the page's (dark)", d.barBg === d.pageBg, { bar: d.barBg, page: d.pageBg });
      }
    }
  };
  /** The form as the page has it: which one, what is filled in, where the cursor is (no value is read). */
  const form = () => ui.eval(`(() => {
    const f = document.querySelector('${PAGE} .dset-keys-form');
    if (!f) return null;
    const name = f.querySelector('input[data-keys="name"]'), value = f.querySelector('input[data-keys="value"]'), note = f.querySelector('input[data-keys="note"]');
    const a = document.activeElement;
    const r = f.getBoundingClientRect();
    return { kind: f.dataset.keys, name: name ? name.value : (f.querySelector('.dset-keys-fixed')?.textContent || ''), note: note ? note.value : '', valueType: value?.type,
      focus: a === value ? 'value' : a === name ? 'name' : a === note ? 'note' : (a ? a.tagName + '.' + a.className : ''),
      inView: r.top >= 0 && r.bottom <= window.innerHeight, atTop: !!f.closest('.dset-keys-top'), underRow: !!f.closest('.dset-keys-editwrap') };
  })()`);
  /** Add key: where it is, whether it is the thing under its own middle (not covered, not scrolled away). */
  const addButton = () => ui.eval(`(() => {
    const b = document.querySelector('${PAGE} [data-keys="add"]');
    const s = document.querySelector('${PAGE} .dset-keys-search');
    if (!b) return null;
    const r = b.getBoundingClientRect(), q = s ? s.getBoundingClientRect() : null;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    let sc = b.parentElement; while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement;
    const cs = getComputedStyle(b);
    const bar = b.closest('.dset-keys-bar'), node = b.closest('.custom-view-node');
    return { text: b.innerText.trim(), top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), shown: !!hit && b.contains(hit),
      barHidden: !!bar && bar.hidden, barBg: bar ? getComputedStyle(bar).backgroundColor : '', pageBg: node ? getComputedStyle(node).backgroundColor : '',
      searchH: q ? Math.round(q.height) : 0, searchRadius: s ? getComputedStyle(s).borderTopLeftRadius : '',
      searchShown: !!s && !s.hidden, sameLine: !!q && Math.abs((q.top + q.height / 2) - (r.top + r.height / 2)) < 2, rightOfSearch: !!q && r.left >= q.right,
      radius: cs.borderTopLeftRadius, wrap: b.scrollHeight > b.clientHeight + 1, ws: cs.whiteSpace,
      scroller: sc ? { top: Math.round(sc.scrollTop), max: sc.scrollHeight - sc.clientHeight } : null,
      rows: document.querySelectorAll('${PAGE} .dset-key-row').length,
      lastRowBelow: (() => { const rows = document.querySelectorAll('${PAGE} .dset-key-row'); const l = rows[rows.length - 1]; return !!l && l.getBoundingClientRect().top > window.innerHeight; })() };
  })()`);
  const closeSettings = async () => {
    for (let i = 0; i < 3 && await ui.exists({ css: `${PAGE}` }); i++) {
      await ui.eval(`document.activeElement?.blur()`);
      await ui.press("Escape");
      await ui.sleep(800);
    }
    check("Settings closes back to the session", !(await ui.exists({ css: `${PAGE}` })));
  };

  // a session on OpenCode's cheap model, the way a person starts one
  await offscreen(ui);
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await offscreen(ui);
  await ui.eval("window.resizeTo(1440, 900)");
  await closeTips(ui);
  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  qa.facts.model = await chooseCheapModel(ui, ".sessions-chat-editor");
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type("Reply with one short English sentence: ready.");
  await ui.press("Enter", { send: true });
  await until(ui, async () => (await ui.eval(LAST)).length > 0 && !(await ui.eval(RUNNING)), 180000, "the first answer");
  await ui.waitFor(CAMERA, { timeoutMs: 20000 });
  check("the store starts with no key at all", Object.keys(keys()).length === 0, Object.keys(keys()));

  // 0. Settings › Keys with no key: the empty card, no search line (Settings drawn once here, as a person who looked
  //    before: Open Keys below then reuses the page, the case where the form was once never drawn)
  await ui.press("Cmd+,");
  await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' }, { timeoutMs: 20000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' });
  await ui.waitFor({ text: "No keys yet" }, { timeoutMs: 20000 });
  const none = await addButton();
  check("no keys: the empty card with its own Add a key, the search line hidden", none && none.barHidden && await ui.exists({ css: `${PAGE} [data-keys="add-first"]` }), none);
  await ui.screenshot("00-no-keys-light");
  await closeSettings();

  // 1. no key: the card
  await ui.eval(`${T}.configure({})`);
  await ui.click(CAMERA);
  await ui.waitFor({ css: ".dispatch-pt-card" }, { timeoutMs: 20000 });
  const card = await ui.eval(`(() => { const c = document.querySelector('.dispatch-pt-card'); const b = [...c.querySelectorAll('button')].map(e => ({ t: e.innerText.trim(), r: getComputedStyle(e).borderTopLeftRadius, ws: getComputedStyle(e).whiteSpace })); return { text: c.innerText, buttons: b }; })()`);
  qa.facts.card = card;
  check("no key: the card says to press Open Keys, paste the Soniox key and save it", /Press Open Keys, paste your Soniox key and save it\. Then press the camera to record\./.test(card.text) && /SONIOX_API_KEY/.test(card.text), card.text);
  check("the card's buttons: Open Keys and Not now, one line, corners 4", card.buttons.some(b => b.t === "Open Keys") && card.buttons.some(b => b.t === "Not now") && card.buttons.every(b => b.ws === "nowrap"), card.buttons);
  await shots("01-key-card");
  await ui.mark({ text: "Open Keys", exact: true, within: ".dispatch-pt-card" }, { what: "没 Soniox Key 的卡：Open Keys", where: "会话输入框上方", how: "点它打开设置 › Keys，添加表单已展开" });

  // 2. Open Keys: the form, filled in, the cursor in Value
  await ui.click({ text: "Open Keys", exact: true, within: ".dispatch-pt-card" });
  await ui.waitFor({ css: `${PAGE} .dset-keys-form[data-keys="add-form"]` }, { timeoutMs: 20000 });
  const f1 = await until(ui, async () => { const f = await form(); return f && f.focus === "value" ? f : null; }, 8000, "the cursor in Value", 200).catch(async () => form());
  qa.facts.addForm = f1;
  check("Open Keys opens Settings › Keys with the add form open at the top of the list", f1 && f1.kind === "add-form" && f1.atTop && f1.inView, f1);
  check("the form's Name is SONIOX_API_KEY and its purpose is filled in", f1 && f1.name === KEY && f1.note === NOTE, f1);
  check("the cursor is in Value, a password box", f1 && f1.focus === "value" && f1.valueType === "password", f1);
  check("Open Keys left the card where it was (it goes once the key is saved)", (await events()).includes("open-keys") && !!(await ui.eval(`document.querySelector('.dispatch-pt-card') ? 1 : 0`)));
  const empty = await addButton();
  qa.facts.addButtonEmpty = empty;
  check("no keys yet: the line with Search keys and Add key stays hidden, the form is right under the head", empty && empty.barHidden && !empty.shown, empty);
  await ui.screenshot("02-keys-form-light");
  await ui.mark({ css: `${PAGE} .dset-keys-form` }, { what: "添加表单：名字 SONIOX_API_KEY、用途已填，光标在值上", where: "设置 › Keys 列表最上面", how: "粘贴 Key，按 Save key 或 Enter" });

  // 3. paste a made-up value (straight into the focused box: no value in steps.json), Save key
  await ui.cdp.send("Input.insertText", { text: VALUE });
  await ui.sleep(200);
  await ui.click({ css: `${PAGE} [data-keys="save"]` });
  const saved = await until(ui, async () => keys()[KEY], 15000, "SONIOX_API_KEY in the store", 200);
  check("Save key puts SONIOX_API_KEY in the store with its purpose", saved.value === VALUE && saved.note === NOTE, { note: saved.note, length: saved.value.length });
  const toast = await until(ui, () => ui.eval(`(() => { const t = [...document.querySelectorAll('.dispatch-keys-toast')].find(e => e.getClientRects().length); return t ? t.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`), 15000, "the Key saved toast", 200);
  qa.facts.toast = toast;
  check("the toast says Key saved with the name and purpose, no value", toast.includes(`Key saved: ${KEY} — ${NOTE}`) && !toast.includes(VALUE), toast);
  const gone = await until(ui, async () => (await events()).includes("key-saved") && !(await ui.exists({ css: ".dispatch-pt-card" })), 15000, "the card to go", 300).catch(() => false);
  check("the key card goes by itself once the key is saved", !!gone, await events());
  await ui.screenshot("03-saved");
  await closeSettings();
  check("back in the session the card is gone", !(await ui.exists({ css: ".dispatch-pt-card" })));
  await shots("04-session-after");

  // 4. the camera again: past the key, to the permissions, and on to the recording
  await ui.eval(`${T}.configure(${JSON.stringify({ access: { microphone: "not-determined", screen: "granted" } })})`);
  await ui.click(CAMERA);
  await ui.waitFor({ text: "Point and talk needs two permissions" }, { timeoutMs: 15000 });
  const ev4 = await events();
  check("the camera with the key there goes on to the permissions, no key card", !ev4.includes("no-key") && ev4.includes("card permissions") && !ev4.includes("card key"), ev4);
  await ui.eval(`${T}.set({ access: { microphone: 'granted', screen: 'granted', relaunch: false } })`);
  const rec4 = await until(ui, async () => { const s = await state(); return s && s.recording ? s : null; }, 20000, "the recording", 250).catch(() => null);
  check("everything there: the recording starts", !!rec4, rec4 || await state());
  if (rec4) {
    await ui.sleep(1500);
    await ui.screenshot("05-recording");
    await ui.click({ text: "Discard", exact: true, within: `${INPUT} .dispatch-pt-slot` });
    await until(ui, async () => { const s = await state(); return s && !s.recording && !s.review ? s : null; }, 15000, "the recording discarded", 300).catch(() => null);
    if (await ui.exists({ text: "Discard", exact: true, within: `${INPUT} .dispatch-pt-slot` })) {
      await ui.click({ text: "Discard", exact: true, within: `${INPUT} .dispatch-pt-slot` });
    }
  }

  // 5. forty keys: Add key in sight without scrolling, and still at the end of them
  const seed = Array.from({ length: MANY }, (_, i) => `# Made-up key ${i + 1} for the e2e test\nFAKE_MANY_${String(i + 1).padStart(2, "0")}=fake-e2e-many-${String(i + 1).padStart(4, "0")}\n`).join("\n");
  fs.appendFileSync(store, "\n" + seed);
  // one more through the CLI, so the window hears the store changed (as a terminal or an agent would make it)
  cli(["env", "set", "FAKE_MANY_ZZ", "--stdin", "--note", "Made-up key from the CLI"], "fake-e2e-many-cli\n");
  await ui.press("Cmd+,");
  await ui.waitFor({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' }, { timeoutMs: 20000 });
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="keys"]' });
  const many = await until(ui, async () => { const b = await addButton(); return b && b.rows >= MANY + 2 ? b : null; }, 30000, "the forty keys listed", 300);
  qa.facts.addButtonMany = many;
  check(`${MANY + 2} keys: Add key is next to Search keys, on the same line, in sight without scrolling`, many.shown && many.searchShown && many.sameLine && many.rightOfSearch && many.scroller && many.scroller.top === 0 && many.lastRowBelow, many);
  check("Add key reads Add key, one line, 32 high like the search box, both corners 4", many.text === "Add key" && !many.wrap && many.ws === "nowrap" && many.radius === "4px" && many.h === 32 && many.searchH === 32 && many.searchRadius === "4px", many);
  check("the line's colour is the page's (light)", many.barBg === many.pageBg, { bar: many.barBg, page: many.pageBg });
  await keysShots("06-many-keys");
  await ui.hover({ css: `${PAGE} [data-keys="add"]` });
  await ui.sleep(400);
  await ui.screenshot("06b-add-hover-light");
  await ui.mark({ css: `${PAGE} [data-keys="add"]` }, { what: "Add key：和搜索框同一行", where: "设置 › Keys 列表上方，搜索框右边", how: "点它在列表最上面展开添加表单" });
  await ui.eval(`(() => { const b = document.querySelector('${PAGE} [data-keys="add"]'); let sc = b.parentElement; while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement; if (sc) sc.scrollTop = sc.scrollHeight; })()`);
  await ui.sleep(500);
  const bottom = await addButton();
  qa.facts.addButtonScrolled = bottom;
  check("scrolled to the last key, Add key is still in sight at the top of the page", bottom.shown && bottom.scroller && bottom.scroller.top > 0 && bottom.top >= 0, bottom);
  await ui.screenshot("07-many-scrolled");
  await ui.click({ css: `${PAGE} [data-keys="add"]` });
  const f5 = await until(ui, async () => { const f = await form(); return f && f.focus === "name" ? f : null; }, 8000, "the add form", 200).catch(async () => form());
  qa.facts.addFromBar = f5;
  check("Add key opens an empty form at the top of the list, in sight, the cursor in Name", f5 && f5.kind === "add-form" && f5.atTop && f5.inView && f5.name === "" && f5.focus === "name", f5);
  await ui.screenshot("08-add-from-bar-light");
  await ui.press("Escape");
  await ui.sleep(500);
  check("Escape closes the form", !(await ui.exists({ css: `${PAGE} .dset-keys-form` })));
  await closeSettings();

  // 6. the card again with the key there (the take says it is missing): Open Keys opens its Edit
  await ui.setTheme("dark");
  await closeSettings();
  await ui.eval(`${T}.configure({ key: false })`);
  await ui.click(CAMERA);
  await ui.waitFor({ css: ".dispatch-pt-card" }, { timeoutMs: 15000 });
  await ui.click({ text: "Open Keys", exact: true, within: ".dispatch-pt-card" });
  await ui.waitFor({ css: `${PAGE} .dset-keys-form[data-keys="edit-form"]` }, { timeoutMs: 20000 });
  const f6 = await until(ui, async () => { const f = await form(); return f && f.focus === "value" && f.inView ? f : null; }, 8000, "the edit form in sight", 200).catch(async () => form());
  qa.facts.editForm = f6;
  check("the key there already: Open Keys opens its Edit under its row, scrolled into sight, the cursor in Value", f6 && f6.kind === "edit-form" && f6.name === KEY && f6.underRow && f6.inView && f6.focus === "value", f6);
  check("its purpose is kept", f6 && f6.note === NOTE, f6);
  await ui.screenshot("09-edit-existing-dark");
  await ui.press("Escape");
  await closeSettings();
  await ui.click({ text: "Not now", exact: true, within: ".dispatch-pt-card" });
  await ui.eval(`${T}.configure({})`);
  await ui.setTheme("light");
  await closeSettings();

  // 7. the made-up value: in the store only
  const text = await ui.eval("document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label]')].map(e => (e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '')).join(' ')");
  check("the value is nowhere in the window's text, titles or labels", !text.includes(VALUE));
  const leaks = [];
  const allowed = [store, store + ".sh", path.join(rec.keys_home, ".config", "dispatch", "env.sh"), path.join(rec.keys_home, ".config", "dispatch", "env.fish")].map(f => path.resolve(f));
  const scan = d => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const q = path.join(d, n);
      let st;
      try { st = fs.lstatSync(q); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!/backups$/.test(q)) scan(q); }
      else if (st.isFile() && st.size < 20 * 1024 * 1024 && !allowed.includes(path.resolve(q)) && !q.startsWith(ui.out)) {
        let t = "";
        try { t = fs.readFileSync(q, "latin1"); } catch { continue; }
        if (t.includes(VALUE)) leaks.push(path.relative(rec.root, q));
      }
    }
  };
  scan(rec.root);
  qa.facts.leaks = leaks;
  check("the value is in no log, setting or state file of the instance", !leaks.length, leaks);
  note();
  if (qa.failed.length) {
    throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join(" | ")}`);
  }
}
