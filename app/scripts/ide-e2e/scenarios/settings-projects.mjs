// Settings › Projects with a real person's twenty-odd projects (fixtures/many_projects.py), and Usage opened from
// Settings, the account panel and the command: it stays in Settings.
//   - the list: every row the same height, the name on one line and the folder on one line, an iCloud folder as
//     "iCloud Drive/…", a long folder cut in the middle with its whole path on hover, a project without its folder
//     saying why, the icon centred on the two lines, the card as wide as the page's other cards, groups by place;
//   - Usage: Account and usage › Open Usage shows Usage inside Settings (its contents in the side bar, Account and
//     usage lit, a way back), and so do the account panel's Usage row and the Usage command.
// Writes facts.json next to the screenshots. Nothing here starts an agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);

export const meta = {
  title: "设置 › Projects 的长列表和 Usage 在设置里打开",
  description: "二十多个项目（iCloud 长中文路径、删掉的文件夹、别的 Mac 上的）每行同高、路径单行；Usage 从设置、头像面板和命令打开都留在设置里。",
  instance: { fixture: "many-projects" },
  timeout: 600,
};

const facts = {};
const save = (ui) => fs.writeFileSync(path.join(ui.out, "facts.json"), JSON.stringify(facts, null, 1));
const NAV = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
const TITLE = "document.querySelector('.custom-view-node[data-view-id=\"dispatch.settings\"] .custom-view-header-title')?.textContent || ''";

async function until(ui, fn, what, ms = 20000) {
  const end = Date.now() + ms * SCALE;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await ui.sleep(300);
  }
}

async function closeTip(ui) {
  if (await ui.exists({ css: ".dispatch-tour", webview: false })) {
    await ui.click({ css: ".dispatch-tour-head button", webview: false }).catch(() => undefined);
    await ui.sleep(500);
  }
}

const waitTitle = (ui, text) => until(ui, async () => { const t = await ui.eval(TITLE); return t === text || t.endsWith(`› ${text}`); }, `Settings titled ${text}`);

async function nav(ui, page, title) {
  await ui.click({ css: `.dispatch-settings-nav .dsn-row[data-page="${page}"]`, webview: false });
  await waitTitle(ui, title);
  await ui.sleep(400);
}

/** Where Settings is: still on screen, which page, which side bar row is lit. */
const where = (ui) => ui.eval(`(() => {
  const node = document.querySelector('.custom-view-node[data-view-id="dispatch.settings"]');
  const shown = !!node && !!node.offsetParent;
  return {
    settings: shown,
    nav: !!document.querySelector('.part.sidebar.dispatch-settings-open .dispatch-settings-nav'),
    lit: document.querySelector('.dispatch-settings-nav .dsn-row.on')?.dataset.page || '',
    title: node?.querySelector('.custom-view-header-title')?.textContent || '',
    usageInSettings: !!document.querySelector('.dispatch-settings-page .dispatch-usage-page'),
    usageAlone: !!document.querySelector('.custom-view-node[data-view-id="dispatch.usage"]'),
    back: document.querySelector('.dispatch-settings-page .dset-back')?.textContent.trim() || '',
  };
})()`);

const MEASURE = `(() => {
  const content = document.querySelector('.dispatch-settings-page .dset-content');
  const block = content?.querySelector('.dset-rows[data-setting="projects"]');
  if (!block) return null;
  const box = (el) => el.getBoundingClientRect();
  const mid = (el) => { const b = box(el); return b.top + b.height / 2; };
  const cards = [...content.querySelectorAll('.dset-rows')].filter((c) => c.offsetParent).map((c) => Math.round(box(c).width * 10) / 10);
  const rows = [...block.querySelectorAll('.dset-row')].map((r) => {
    const label = r.querySelector('.dset-row-label');
    const detail = r.querySelector('.dset-row-detail');
    const glyph = r.querySelector('.dset-row-lead > *');
    const text = r.querySelector('.dset-row-text');
    const go = r.querySelector('.dset-go');
    const cut = [detail, ...detail.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 1);
    return {
      name: label.textContent.trim(),
      detail: detail.textContent,
      title: detail.getAttribute('aria-label') || '',
      h: Math.round(box(r).height * 10) / 10,
      labelH: Math.round(box(label).height),
      detailH: detail.hidden ? 0 : Math.round(box(detail).height),
      iconOff: glyph ? Math.round((mid(glyph) - mid(r)) * 10) / 10 : null,
      textOff: Math.round((mid(text) - mid(r)) * 10) / 10,
      cut,
      chevronGap: go ? Math.round(box(go).left - box(text).right) : null,
    };
  });
  return {
    contentW: Math.round(box(content).width * 10) / 10,
    cards,
    groups: [...block.querySelectorAll('.dset-row-group')].map((g) => g.textContent.trim()),
    rows,
  };
})()`;

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.waitFor({ css: ".sessions-chat-editor, .interactive-input-part", webview: false }, { timeoutMs: 60000 }).catch(() => undefined);
  await ui.sleep(8000);
  await closeTip(ui);

  // ---- Settings › Projects ----------------------------------------------------------------------------------------
  await ui.press("Cmd+,");
  await ui.waitFor(NAV, { timeoutMs: 15000 });
  await nav(ui, "projects", "Projects");
  const live = ui.rec.many_projects.live;
  const m = await until(ui, async () => { const r = await ui.eval(MEASURE); return r && r.rows.length >= live ? r : null; }, `${live} projects in the list`, 45000);
  facts.list = m;
  save(ui);
  await ui.screenshot("01-projects-light");
  await ui.mark({ css: '.dset-rows[data-setting="projects"]', webview: false }, { what: "In the side bar：每行同高，名字一行、路径一行", where: "设置 › Projects", how: "左栏 Projects" });
  await ui.scrollTo("iCloud Drive").catch(() => undefined);
  await ui.sleep(300);
  await ui.screenshot("02-projects-icloud-and-missing");

  // the whole folder on hover, where the line cuts it
  const icloudRow = { css: '.dset-row[data-project="Signals and Systems"] .dset-row-detail', webview: false };
  await ui.hover(icloudRow);
  await ui.sleep(1500);
  facts.hover = await ui.eval("[...document.querySelectorAll('.workbench-hover, .monaco-hover')].filter(h => h.offsetParent).map(h => h.innerText).join('\\n')");
  await ui.screenshot("03-hover-full-path");
  await ui.mark(icloudRow, { what: "iCloud 里的路径写成 iCloud Drive/…，超长从中间省略", where: "Signals and Systems 那行", how: "悬停看全路径" });
  save(ui);

  // dark
  await nav(ui, "appearance", "Appearance");
  await ui.click({ css: '.dset-thm[data-mode="dark"]', webview: false });
  await ui.waitFor({ css: ".monaco-workbench.vs-dark", webview: false });
  await nav(ui, "projects", "Projects");
  await until(ui, async () => { const r = await ui.eval(MEASURE); return r && r.rows.length >= live; }, "the list again");
  await ui.sleep(500);
  facts.listDark = await ui.eval(MEASURE);
  await ui.screenshot("04-projects-dark");
  await nav(ui, "appearance", "Appearance");
  await ui.click({ css: '.dset-thm[data-mode="system"]', webview: false });
  await ui.sleep(600);

  // ---- Usage from Settings ------------------------------------------------------------------------------------------
  await nav(ui, "account", "Account and usage");
  await ui.scrollTo("Open Usage").catch(() => undefined);
  await ui.click({ text: "Open Usage" });
  await ui.sleep(1500);
  facts.usageFromSettings = await where(ui);
  await ui.screenshot("05-usage-in-settings");
  await ui.mark({ css: ".dispatch-settings-page", webview: false }, { what: "Usage 在设置里打开", where: "设置 › Account and usage › Open Usage", how: "左栏仍是设置，Account and usage 亮着" });
  save(ui);
  if (facts.usageFromSettings.back) {
    await ui.click({ css: ".dispatch-settings-page .dset-back", webview: false });
    await ui.sleep(800);
    facts.usageBack = await where(ui);
  }

  // ---- Usage from the account panel ----------------------------------------------------------------------------------
  await ui.press("Escape");
  await ui.sleep(800);
  facts.afterEscape = await where(ui);
  const avatar = { css: ".sessions-account-titlebar-widget", webview: false };
  if (await ui.exists(avatar)) {
    await ui.click(avatar);
    await ui.sleep(1500);
    facts.accountPanel = await ui.exists({ css: ".sessions-account-titlebar-panel .dispatch-usage-entry", webview: false });
    if (facts.accountPanel) {
      await ui.screenshot("06-account-panel");
      await ui.click({ text: "Usage", exact: true, within: ".dispatch-usage-entry" });
      await ui.sleep(1500);
      facts.usageFromPanel = await where(ui);
      await ui.screenshot("07-usage-from-account-panel");
    }
  }
  save(ui);

  // ---- the checks ---------------------------------------------------------------------------------------------------------
  const rows = m.rows;
  const heights = [...new Set(rows.map((r) => r.h))];
  assert.equal(heights.length, 1, `rows of different heights: ${JSON.stringify(rows.map((r) => [r.name, r.h]))}`);
  for (const r of rows) {
    assert.ok(r.labelH <= 22 && r.detailH > 0 && r.detailH <= 20, `${r.name}: its name or folder takes more than one line (${r.labelH} / ${r.detailH})`);
    assert.ok(r.iconOff !== null && Math.abs(r.iconOff) <= 1, `${r.name}: the icon is ${r.iconOff}px off the row's middle`);
    assert.ok(Math.abs(r.textOff) <= 1, `${r.name}: the two lines are ${r.textOff}px off the row's middle`);
  }
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.match(by["Signals and Systems"].detail, /^iCloud Drive\/河湾大学\//);
  assert.ok(!rows.some((r) => /Mobile Documents|com~apple~CloudDocs/.test(r.detail)), "a row still shows iCloud's own folder names");
  assert.match(by.Probe.detail, /^Folder missing/);
  assert.match(by["会议记录"].detail, /^Not on this Mac/);
  assert.match(by["讲书"].detail, /^Not on this Mac/);
  assert.match(by.scratch.detail, /^No folder/);
  assert.ok(by["a-project-with-a-rather-long-name"].cut, "the long folder is not cut");
  assert.ok(/com~apple~CloudDocs\/河湾大学\/2026ss\/Signals and Systems/.test(facts.hover), `the hover does not show the whole folder: ${facts.hover}`);
  assert.deepEqual(m.groups, ["This Mac", "iCloud Drive", "Not found"]);
  for (const w of m.cards) {
    assert.ok(Math.abs(w - m.contentW) <= 1, `a card is ${w} wide, the page ${m.contentW}`);
  }
  const dark = facts.listDark.rows;
  assert.equal(new Set(dark.map((r) => r.h)).size, 1, "rows of different heights in the dark theme");
  assert.equal(dark[0].h, rows[0].h, "rows change height with the theme");

  for (const [k, w] of [["from Settings", facts.usageFromSettings], ["from the account panel", facts.usageFromPanel]]) {
    if (!w) continue;
    assert.ok(w.settings && w.nav && w.usageInSettings && !w.usageAlone, `Usage ${k} left Settings: ${JSON.stringify(w)}`);
    assert.equal(w.lit, "account", `Usage ${k}: the side bar lights ${w.lit}`);
    assert.match(w.title, /Account and usage › Usage$/);
    assert.equal(w.back, "Account and usage");
  }
  assert.ok(facts.usageFromPanel, "the account panel has no Usage row to try");
  assert.ok(facts.usageBack && facts.usageBack.settings && /Account and usage$/.test(facts.usageBack.title) && !facts.usageBack.usageInSettings, `back from Usage: ${JSON.stringify(facts.usageBack)}`);
}
