// Dispatch's own Settings in the Agents window (kanban task-tjor, design/settings direction B), the way a person
// gets there and uses it: the title bar has the light or dark button and keeps the phone button; the side pane toggle says
// what it does and changes its icon; ⌘, turns the window into Settings (contents in the side bar, the page in the
// middle); Appearance switches light and dark; a plain word ("sleep") finds Keep awake; the phone page and the
// title bar's phone button open the same pairing; Abilities shows what was Customizations; Esc goes back.
// Writes facts.json next to the screenshots. Nothing here starts an agent or changes anything outside the instance.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** `dispatch <args> --json` in this instance (its own board and data folder), as the first-run wizard reads it. */
function cli(ui, args) {
  const env = { ...process.env, DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_HOME: ui.rec.dispatch_home, DISPATCH_DIR: ui.rec.dispatch_dir,
    BEADS_DIR: ui.rec.beads_dir, DISPATCH_FACTS_FILE: path.join(ui.rec.root, "rules/FACTS.md") };
  return JSON.parse(execFileSync("python3", [ui.rec.cli, ...args, "--json"], { env, cwd: ui.demoFolder, encoding: "utf8", timeout: 60000 }));
}

export const meta = { title: "Dispatch 自己的设置页", description: "⌘, 打开设置、切深浅、搜 sleep、手机配对入口、Abilities、右栏开关的新图标和提示、标题栏去掉主题按钮。" };

function assert(ok, message) { if (!ok) throw new Error(message); }

const NAV = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
const PAGE = { css: ".dispatch-settings-page", webview: false };
const TITLE = "document.querySelector('.custom-view-node[data-view-id=\"dispatch.settings\"] .custom-view-header-title')?.textContent || ''";

const toggleState = (ui) => ui.eval(`(() => {
  const el = document.querySelector('.action-label.codicon-agent-secondary-sidebar-toggle-closed, .action-label.codicon-agent-secondary-sidebar-toggle-open');
  if (!el) return null;
  return { open: el.classList.contains('codicon-agent-secondary-sidebar-toggle-open'), label: el.getAttribute('aria-label') || el.title || '',
    square: !!document.querySelector('.codicon-dispatch-side-pane') };
})()`);

async function waitTitle(ui, text) {
  const until = Date.now() + 10000;
  for (;;) {
    const t = await ui.eval(TITLE);
    if (t === text || t.endsWith(`› ${text}`)) return;
    if (Date.now() > until) throw new Error(`Settings shows "${t}", not "${text}"`);
    await ui.sleep(200);
  }
}

async function closeTip(ui) {
  if (await ui.exists({ css: ".dispatch-tour", webview: false })) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => undefined);
    await ui.sleep(500);
  }
}

async function nav(ui, page, title) {
  await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${page}"]`, webview: false });
  await waitTitle(ui, title);
  await ui.sleep(400);
}

export default async function (ui) {
  const facts = {};
  await ui.openAgents();
  // a new window settles first: the agents connect and the new session page takes the middle (that navigation
  // closes any page shown there), and the first-run tip comes up; then we start, with the tip out of the way
  await ui.waitFor({ css: ".sessions-chat-editor, .interactive-input-part", webview: false }, { timeoutMs: 60000 }).catch(() => undefined);
  await ui.sleep(30000);
  await closeTip(ui);

  // ---- the title bar: the light or dark button (user 2026-10-21, preference「标题栏切换深浅」), the phone button stays,
  // the side pane toggle in words
  facts.themeButton = await ui.exists({ aria: "Switch light or dark", webview: false });
  assert(facts.themeButton, "the title bar has no light or dark button");
  facts.phoneButton = await ui.exists({ css: ".dispatch-mobile-button-label", webview: false });
  assert(facts.phoneButton, "the phone button is gone from the title bar");
  facts.customizationsPane = await ui.exists({ css: ".agent-sessions-customizations-section", webview: false });
  assert(!facts.customizationsPane, "Customizations is still at the bottom of the side bar");
  await ui.waitFor({ css: ".sidebar-footer .dset-entry", webview: false });
  facts.entry = await ui.eval("document.querySelector('.sidebar-footer .dset-entry')?.innerText.replace(/\\s+/g, ' ').trim()");
  await ui.screenshot("01-agents-window");
  await ui.mark({ css: ".sidebar-footer .dset-entry", webview: false }, { what: "Settings 入口", where: "左栏最下面", how: "点它或按 ⌘," });
  await ui.mark({ css: ".dispatch-mobile-button-label", webview: false }, { what: "手机配对按钮", where: "标题栏右上角，照旧露着", how: "点它出二维码" });

  const t0 = await toggleState(ui);
  assert(t0, "no side pane toggle in the title bar");
  facts.toggleBefore = t0;
  assert(!t0.square, "the side pane toggle still uses Dispatch's square icon");
  await ui.mark({ css: ".action-label.codicon-agent-secondary-sidebar-toggle-closed, .action-label.codicon-agent-secondary-sidebar-toggle-open", webview: false },
    { what: t0.open ? "右栏开关（开着）" : "右栏开关（关着）", where: "标题栏右边", how: `悬停写「${t0.label.replace(/ \(.*\)$/, "")}」` });
  await ui.click({ css: ".action-label.codicon-agent-secondary-sidebar-toggle-closed, .action-label.codicon-agent-secondary-sidebar-toggle-open", webview: false });
  let t1 = await toggleState(ui);
  for (let i = 0; i < 20 && !(t1 && t1.open !== t0.open); i++) { await ui.sleep(300); t1 = await toggleState(ui); } // a busy Mac takes a moment
  facts.toggleAfterClick = t1;
  assert(t1 && t1.open !== t0.open, "the side pane toggle did not change its icon");
  assert(/hide side panel/i.test(t1.open ? t1.label : t0.label) && /show side panel/i.test(t1.open ? t0.label : t1.label), `the toggle's words are wrong: ${t0.label} / ${t1.label}`);
  await ui.screenshot(t1.open ? "02-side-panel-open" : "02-side-panel-closed");
  await ui.click({ css: ".action-label.codicon-agent-secondary-sidebar-toggle-closed, .action-label.codicon-agent-secondary-sidebar-toggle-open", webview: false });
  let t2 = await toggleState(ui);
  for (let i = 0; i < 20 && !(t2 && t2.open === t0.open); i++) { await ui.sleep(300); t2 = await toggleState(ui); }
  facts.toggleBack = t2;
  assert(t2 && t2.open === t0.open, "the side pane did not come back to how it was");
  await ui.screenshot(t2.open ? "03-side-panel-open" : "03-side-panel-closed");

  // ---- ⌘, : the window becomes Settings -------------------------------------------------------------------------
  await closeTip(ui);
  await ui.press("Cmd+,");
  await ui.waitFor(NAV, { timeoutMs: 15000 });
  await ui.waitFor(PAGE);
  await waitTitle(ui, "Settings");
  await ui.waitFor({ css: ".dset-tiles .dset-tile", webview: false });
  await ui.sleep(2500); // the tiles fill in as the CLI answers
  facts.overview = await ui.eval("[...document.querySelectorAll('.dset-tile')].map(t => t.innerText.replace(/\\s+/g, ' ').trim())");
  facts.navRows = await ui.eval("[...document.querySelectorAll('.dispatch-settings-nav .dsn-row')].map(r => r.innerText.trim())");
  assert(facts.navRows.includes("Keep awake") && facts.navRows.includes("Skills") && facts.navRows.includes("Abilities"), `the contents miss pages: ${facts.navRows.join(", ")}`);
  await ui.screenshot("04-settings-overview");
  await ui.mark({ css: ".dispatch-settings-nav .dsn-back", webview: false }, { what: "‹ Sessions", where: "左栏顶上，后面是等你的条数", how: "点它或按 Esc 回到会话" });
  await ui.mark({ css: ".dispatch-settings-nav .dsn-search", webview: false }, { what: "搜索", where: "左栏", how: "打大白话，回车打开第一条" });
  await ui.mark({ css: '.dispatch-settings-nav .dsn-row[data-page="abilities"]', webview: false }, { what: "Abilities（原 Customizations）", where: "Advanced 下面，七项展开", how: "点哪项进哪项" });
  await ui.mark({ css: ".dset-tiles", webview: false }, { what: "现状一览", where: "Overview", how: "点一块进那一页" });

  // ---- Appearance: light, dark, back to the Mac's -------------------------------------------------------------------
  await nav(ui, "appearance", "Appearance");
  await ui.click({ css: '.dset-thm[data-mode="dark"]', webview: false });
  await ui.waitFor({ css: ".monaco-workbench.vs-dark", webview: false });
  facts.dark = true;
  await ui.screenshot("05-appearance-dark");
  await ui.mark({ css: ".dset-themes", webview: false }, { what: "System / Light / Dark", where: "设置 › Appearance（标题栏的 ◑ 搬到这里）", how: "点一个，马上换" });
  await ui.click({ css: '.dset-thm[data-mode="light"]', webview: false });
  await ui.waitFor({ css: ".monaco-workbench.vs-dark", webview: false }, { gone: true });
  facts.light = true;
  await ui.screenshot("06-appearance-light");
  await ui.click({ css: '.dset-thm[data-mode="system"]', webview: false });
  await ui.sleep(600);
  facts.systemChecked = await ui.eval("document.querySelector('.dset-thm[data-mode=\"system\"]')?.getAttribute('aria-checked')");
  assert(facts.systemChecked === "true", "System is not the chosen mode");

  // ---- Agents ----------------------------------------------------------------------------------------------------------
  await nav(ui, "agents", "Agents");
  await ui.waitFor({ css: ".dset-row[data-agent]", webview: false }, { timeoutMs: 60000 });
  facts.agents = await ui.eval("[...document.querySelectorAll('.dset-row[data-agent]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())");
  await ui.screenshot("07-agents");
  // What agents may do on their own: the first-run question again, three rows, one picked; a change sticks
  await ui.waitFor({ css: '.dset-choice[data-autonomy="ask-risky"]', webview: false }, { timeoutMs: 30000 });
  const picked = () => ui.eval("document.querySelector('.dset-choice[data-autonomy][aria-checked=\"true\"]')?.dataset.autonomy || ''");
  facts.autonomyRows = await ui.eval("[...document.querySelectorAll('.dset-choice[data-autonomy]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())");
  facts.autonomyBefore = await picked();
  assert(facts.autonomyRows.length === 3, `the Agents page shows ${facts.autonomyRows.length} autonomy rows`);
  const other = facts.autonomyBefore === "ask-risky" ? "ask-every" : "ask-risky";
  await ui.click({ css: `.dset-choice[data-autonomy="${other}"]`, webview: false });
  await ui.sleep(1500);
  facts.autonomyAfter = await picked();
  assert(facts.autonomyAfter === other, `picked ${other}, the page shows ${facts.autonomyAfter}`);
  // the same value first run reads and writes: `dispatch autonomy` (what the wizard's step asks) has it now
  facts.autonomyCli = cli(ui, ["autonomy"]).level;
  assert(facts.autonomyCli === other, `picked ${other} on the page, dispatch autonomy says ${facts.autonomyCli}`);
  // and new sessions in this window start with it: the window's approvals setting follows
  // (the Agents window keeps its settings with the editor window's: user-data, or agents-user-data when it has its own)
  const read = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, "User", "settings.json"), "utf8") || "{}"); } catch { return {}; } };
  const want = { "ask-every": "manual", "ask-risky": "assisted", auto: "allowAll" }[other];
  await ui.sleep(1000);
  facts.approvals = [ui.rec.user_data_dir, ui.rec.agents_user_data_dir].filter(Boolean).map(d => read(d)["chat.defaultConfiguration"]?.approvals).find(Boolean);
  assert(facts.approvals === want, `picked ${other}, new sessions start with approvals ${facts.approvals}, not ${want}`);
  await ui.screenshot("07b-agents-autonomy");
  await nav(ui, "awake", "Keep awake");
  await nav(ui, "agents", "Agents");
  await ui.waitFor({ css: '.dset-choice[data-autonomy][aria-checked="true"]', webview: false }, { timeoutMs: 30000 });
  facts.autonomyReread = await picked();
  assert(facts.autonomyReread === other, `after coming back the page shows ${facts.autonomyReread}, not ${other}`);
  await ui.click({ css: `.dset-choice[data-autonomy="${facts.autonomyBefore || "auto"}"]`, webview: false });
  await ui.sleep(1500);

  // ---- search: "sleep" finds Keep awake -----------------------------------------------------------------------------
  await ui.click({ css: ".dispatch-settings-nav .dsn-search input", webview: false });
  await ui.type("sleep");
  await waitTitle(ui, "Search");
  facts.searchHits = await ui.eval("[...document.querySelectorAll('.dset-results .dset-row-label')].map(r => r.textContent)");
  facts.searchDim = await ui.eval("[...document.querySelectorAll('.dispatch-settings-nav .dsn-row.dim')].length");
  assert(facts.searchHits[0] === "Keep this Mac awake", `"sleep" found ${facts.searchHits.join(", ")}`);
  await ui.screenshot("08-search-sleep");
  await ui.press("Enter");
  await waitTitle(ui, "Keep awake");
  await ui.sleep(900);
  facts.awake = await ui.eval("document.querySelector('.dset-hero')?.innerText.replace(/\\s+/g, ' ').trim()");
  await ui.screenshot("09-keep-awake");
  await ui.click({ css: '.dset-choice[data-awake="off"]', webview: false });
  await ui.sleep(1200);
  facts.awakeOff = await ui.eval("document.querySelector('.dset-hero-h')?.textContent");
  assert(/sleeps as usual/.test(facts.awakeOff || ""), `Keep awake off shows "${facts.awakeOff}"`);
  await ui.click({ css: '.dset-choice[data-awake="system"]', webview: false });
  await ui.sleep(2000);
  facts.awakeOn = await ui.eval("document.querySelector('.dset-hero')?.innerText.replace(/\\s+/g, ' ').trim()");
  assert(/stays awake while agents work/.test(facts.awakeOn || ""), `Keep awake on shows "${facts.awakeOn}"`);
  // the hero says why it holds the Mac now, or that nothing is working (vggq: only while an agent works or a phone is connected)
  assert(/Awake right now|Nothing is working right now|background service is not running/.test(facts.awakeOn || ""), `Keep awake does not say what it holds: "${facts.awakeOn}"`);
  facts.awakeGroup = await ui.eval("[...document.querySelectorAll('.dispatch-settings-page .dset-group-h, .dispatch-settings-page h3, .dispatch-settings-page [class*=group]')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 4)");

  // ---- Phone: the page, and the same pairing from the title bar ------------------------------------------------------
  await nav(ui, "phone", "Phone");
  await ui.waitFor({ css: '[data-setting="phones"] .dset-row, [data-setting="phones"] .dset-empty', webview: false }, { timeoutMs: 30000 });
  facts.phonePage = await ui.eval("document.querySelector('.dispatch-settings-page .dset-content')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)");
  await ui.screenshot("10-phone");
  const pairButton = (await ui.exists({ text: "Pair a phone", webview: false })) ? "Pair a phone" : "Pair another phone";
  await ui.click({ text: pairButton, exact: true, webview: false });
  await ui.waitFor({ css: ".dispatch-mobile-panel", webview: false }, { timeoutMs: 15000 });
  await ui.sleep(1500);
  facts.pairFromSettings = await ui.eval("document.querySelector('.dispatch-mobile-panel')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)");
  await ui.screenshot("11-pair-from-settings");
  await ui.press("Escape");
  await ui.waitFor({ css: ".dispatch-mobile-panel", webview: false }, { gone: true });

  // ---- Abilities: what was Customizations, in place ------------------------------------------------------------------
  await nav(ui, "abilities", "Abilities");
  await ui.waitFor({ css: '.dset-row[data-ability="skills"]', webview: false }, { timeoutMs: 15000 });
  await ui.sleep(800);
  facts.abilities = await ui.eval("[...document.querySelectorAll('.dset-row[data-ability]')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())");
  await ui.screenshot("12-abilities");
  await nav(ui, "skills", "Skills");
  await ui.waitFor({ css: ".dispatch-settings-page .dset-embed:not([hidden]) .ai-customization-management-editor", webview: false }, { timeoutMs: 15000 });
  await ui.sleep(1500);
  facts.abilitiesHasOwnList = await ui.eval("(() => { const s = document.querySelector('.dset-embed .management-sidebar'); return !!s && s.getBoundingClientRect().width > 0; })()");
  assert(!facts.abilitiesHasOwnList, "the customizations editor still shows its own list of sections");
  facts.skills = await ui.eval("document.querySelector('.dset-embed')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300)");
  await ui.screenshot("13-skills");

  // the command that used to open the Customizations editor lands here too
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="overview"]', webview: false });
  await waitTitle(ui, "Settings");
  await ui.press("Escape");
  await ui.waitFor(NAV, { gone: true, timeoutMs: 10000 });
  await ui.press("F1");
  await ui.type("Open Customizations");
  await ui.sleep(800);
  facts.paletteRow = await ui.eval("document.querySelector('.quick-input-list .monaco-list-row.focused')?.innerText.replace(/\\s+/g, ' ').trim() || ''");
  if (/Customizations/.test(facts.paletteRow)) {
    await ui.press("Enter");
    await ui.waitFor(NAV, { timeoutMs: 15000 });
    await ui.sleep(800);
    facts.customizationsCommandLandsOn = await ui.eval(TITLE);
  } else {
    await ui.press("Escape");
    await ui.press("Cmd+,");
    await ui.waitFor(NAV, { timeoutMs: 15000 });
  }
  facts.modalCustomizations = await ui.exists({ css: ".monaco-modal-editor-block .ai-customization-management-editor", webview: false });
  assert(!facts.modalCustomizations, "the Customizations modal is still there");

  // ---- Esc: back to the sessions ------------------------------------------------------------------------------------
  await ui.click({ css: '.dispatch-settings-nav .dsn-row[data-page="overview"]', webview: false });
  await waitTitle(ui, "Settings");
  await ui.press("Escape");
  await ui.waitFor(NAV, { gone: true, timeoutMs: 10000 });
  facts.backToSessions = !(await ui.exists(PAGE));
  await ui.screenshot("14-back-to-sessions");

  // ---- the phone button in the title bar opens the same pairing -------------------------------------------------------
  await ui.click({ css: ".dispatch-mobile-button-label", webview: false });
  await ui.waitFor({ css: ".dispatch-mobile-panel", webview: false }, { timeoutMs: 15000 });
  await ui.sleep(1200);
  facts.pairFromTitleBar = await ui.eval("document.querySelector('.dispatch-mobile-panel')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200)");
  await ui.screenshot("15-pair-from-title-bar");
  await ui.press("Escape");

  // ---- the account menu has Settings… -----------------------------------------------------------------------------------
  if (await ui.exists({ css: ".sessions-account-titlebar-widget", webview: false })) {
    await ui.click({ css: ".sessions-account-titlebar-widget", webview: false });
    await ui.sleep(800);
    facts.accountMenuSettings = await ui.exists({ text: "Settings…", webview: false });
    await ui.screenshot("16-account-menu");
    if (facts.accountMenuSettings) {
      await ui.click({ text: "Settings…", exact: true, webview: false });
      await ui.waitFor(NAV, { timeoutMs: 10000 });
      await ui.press("Escape");
    } else {
      await ui.press("Escape");
    }
  }

  writeFileSync(`${ui.out}/facts.json`, JSON.stringify(facts, null, 2));
}
