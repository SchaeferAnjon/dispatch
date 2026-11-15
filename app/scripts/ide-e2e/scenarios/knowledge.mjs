// Customizations › Knowledge: what every agent knows about the person (direction B of design/knowledge/redesign),
// light and dark. Wants preferences in the instance's store (copy an import's preferences.jsonl into its
// DISPATCH_HOME); KNOWLEDGE_DETAIL=<how its sentence starts> picks the one opened in full (a row shows the
// sentence; default: the first row of the list).
export const meta = {
  title: "Customizations › Knowledge",
  description: "Agents 窗口 › Customizations › Knowledge：最上面 What Dispatch knows about you（最常用的偏好、刚记下的、马上要发生的事），下面五块入口（Preferences、Profile、Facts、Wiki、Engine memory）；Preferences 列表按 New 和四类分组；一条偏好的详情（原话、证据、历史），证据在右栏打开；浅色和深色。页面本身是一个 webview。",
};

// the theme switch is in Settings › Appearance now
async function theme(ui, mode) {
  await ui.setTheme(mode.toLowerCase());
  await ui.sleep(800);
}

async function home(ui) {
  await ui.openCustomizations("Knowledge");
  await ui.waitFor({ text: "What Dispatch knows about you" }, { timeoutMs: 30000 }); // drawn inside the webview
  await ui.waitFor({ text: "Everything agents share" }, { timeoutMs: 30000 });
  // About you and the card counts come a moment later: the page is done when nothing is loading
  await ui.waitFor({ css: ".know .loading" }, { timeoutMs: 60000, gone: true }).catch(() => undefined);
  // the Engine memory count comes last (it reads every engine's memory folder): its badge shows … until then
  await ui.waitFor({ text: "…", exact: true, within: ".card" }, { timeoutMs: 90000, gone: true }).catch(() => undefined);
  await ui.sleep(1500);
}

/** Scroll the page under this element (the webview's own scroll area) by dy pixels. */
async function wheel(ui, spec, dy) {
  const r = await ui.find(spec);
  const b = r.hits[0].box;
  await ui.mouse("mouseWheel", b.x + b.w / 2, b.y + b.h / 2, { deltaX: 0, deltaY: dy });
  await ui.sleep(600);
}

/** A row of the Preferences list: the one whose sentence starts so, or the first. */
const row = (start) => ({ css: start ? `.sec .row[title^=${JSON.stringify(start)}]` : ".sec .row" });

/** Open that row: search for it first, a long list has it below the fold. */
async function openRow(ui, start) {
  if (start) {
    await ui.type(start, { into: "Type to search..." });
    await ui.sleep(500);
  }
  await ui.click(row(start));
}

async function detail(ui, start) {
  await ui.click({ text: "Preferences", exact: true });
  await ui.waitFor({ text: "New Preference", exact: true }, { timeoutMs: 30000 });
  await openRow(ui, start);
  await ui.waitFor({ text: "Kind", exact: true }, { timeoutMs: 30000 });
  await ui.sleep(800); // thumbnails
}

/** A fresh instance has no preferences: record three through the instance's own CLI (no agent involved). */
async function seedPreferences(ui) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const rec = ui.rec;
  const store = path.join(rec.dispatch_home, "preferences.jsonl");
  if (fs.existsSync(store) && fs.readFileSync(store, "utf8").trim()) return false;
  const env = { ...process.env, BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_E2E_INSTANCE: rec.name };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k.startsWith("CODEX_")) delete env[k];
  // evidence: a small picture in the demo project (the detail page shows it and opens it in the right panel)
  const zlib = await import("node:zlib");
  const png = (w, h) => {
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const on = x > w / 4 && x < w * 3 / 4 && y > h / 3 && y < h * 2 / 3; raw[o] = on ? 60 : 240; raw[o + 1] = on ? 56 : 238; raw[o + 2] = on ? 52 : 235; }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const shot = path.join(rec.folder, "design", "toggle-square.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, png(320, 200));
  for (const [text, name, pol, area, quote, ...more] of [
    ["Square toggles, not pills", "square toggles", "--like", "design", "make the switch square", "--evidence", shot],
    ["No dashes in any text; use commas or periods", "no dashes", "--avoid", "writing", "don't use dashes"],
    ["Report with screenshots, not numbers", "screenshots in reports", "--like", "workflow", "show me, don't list numbers"],
  ]) execFileSync("python3", [rec.cli, "prefs", "add", text, pol, "--name", name, "--area", area, "--quote", quote, ...more], { env, cwd: rec.folder, encoding: "utf8", timeout: 60000 });
  return true;
}

/** First-run tips (the Getting started tour) can sit over the page: close them before a picture, like a person would. */
function closeTipsBeforePictures(ui) {
  const shoot = ui.screenshot.bind(ui);
  ui.screenshot = async (...args) => {
    for (let i = 0; i < 4 && (await ui.exists({ css: ".dispatch-tour-close" })); i++) { await ui.click({ css: ".dispatch-tour-close" }); await ui.sleep(400); }
    return shoot(...args);
  };
}

export default async function (ui) {
  closeTipsBeforePictures(ui);
  const seeded = await seedPreferences(ui);
  const start = process.env.KNOWLEDGE_DETAIL || (seeded ? "Square toggles" : ""); // the seeded one with a picture
  await ui.openAgents(ui.demoFolder);
  await theme(ui, "Light");

  await home(ui);
  await ui.screenshot("knowledge");
  await ui.mark({ text: "Knowledge", exact: true, within: ".dispatch-settings-nav" }, { what: "Knowledge 入口", where: "Settings 左栏 Abilities 下最后一行", how: "⌘, 打开 Settings，点 Knowledge" });
  await ui.mark({ text: "What Dispatch knows about you" }, { what: "系统记住了你什么", where: "Knowledge 页最上面的框", how: "打开 Knowledge 就在：常用的偏好、刚记下的、马上要发生的事" });
  await ui.mark({ text: "Preferences", exact: true }, { what: "Preferences 卡片", where: "下面五张卡的第一张", how: "点开看全部偏好：按 New、Design、Workflow、Writing、Tools 分组" });
  if (await ui.exists({ text: "Show", exact: true, within: ".knew" })) {
    await ui.click({ text: "Show", exact: true, within: ".knew" });
    await ui.sleep(400);
    await ui.screenshot("knowledge-new");
    await ui.mark({ text: "Hide", exact: true, within: ".knew" }, { what: "刚记下的", where: "框里「N new」那一行", how: "点 Show 展开，每条能 Edit、Forget" });
  }

  await ui.click({ text: "Preferences", exact: true });
  await ui.waitFor({ text: "New Preference", exact: true }, { timeoutMs: 30000 });
  await ui.sleep(600);
  await ui.screenshot("preferences");
  await ui.mark({ text: "New Preference", exact: true }, { what: "自己加一条", where: "Preferences 列表右上", how: "Knowledge › Preferences" });

  await openRow(ui, start);
  await ui.waitFor({ text: "Kind", exact: true }, { timeoutMs: 30000 });
  await ui.sleep(800);
  await ui.screenshot("preference");
  await ui.mark({ text: "Your words", exact: true }, { what: "你的原话", where: "详情页上半", how: "Knowledge › Preferences › 点一行" });
  await wheel(ui, { text: "Your words", exact: true }, 500);
  await ui.screenshot("preference-lower");
  await ui.mark({ css: ".evs" }, { what: "证据", where: "详情页中间", how: "点一张缩略图，在右栏打开那个文件" });

  // evidence opens in the right panel (Settings steps aside)
  await ui.click({ css: ".evs .ev" });
  await ui.waitFor({ css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false }, { timeoutMs: 20000, gone: true });
  await ui.sleep(1500);
  await ui.screenshot("evidence-open");

  // the neighbour the lists are drawn after: Skills in the same dialog
  await ui.openCustomizations("Skills");
  await ui.sleep(1200);
  await ui.screenshot("neighbour-skills");

  // dark
  await theme(ui, "Dark");
  await home(ui);
  await ui.screenshot("knowledge-dark");
  await detail(ui, start);
  await ui.screenshot("preference-dark");
  await theme(ui, "System");
}
