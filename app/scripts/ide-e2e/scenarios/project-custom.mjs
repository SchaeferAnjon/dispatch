// A project's Customize page: its own icon and colour (task-7gtm), the tools its agents can use (task-gsmh),
// the agent settings it already has (task-6yrk) and how its copies get ready (task-am1t).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const meta = {
  title: "项目的自定义页",
  description: "项目页右上角 Customize（或左栏项目行右键 Customize Project...）：图标和颜色、这个项目里 Agent 能用的外部工具、项目自己的 Agent 设置、副本怎么准备。",
};

const PNG_LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4nGO4udDqPzK2qr6KggnJMwwDA0jVgC4/HAwY+FgYeAMGPhYG3AAAlsCeHwTFr4kAAAAASUVORK5CYII=",
  "base64",
);

async function previewIcon(ui) {
  return ui.eval(`(() => {
    const el = document.querySelector('.dispatch-pc-page .dispatch-pc-preview-icon');
    if (!el) return null;
    return { cls: el.className, text: el.textContent, color: el.style.getPropertyValue('--dispatch-project-color'), img: !!el.querySelector('img') };
  })()`);
}

async function waitPreview(ui, test, what) {
  const until = Date.now() + 15000;
  let last;
  while (Date.now() < until) {
    last = await previewIcon(ui);
    if (last && test(last)) return last;
    await ui.sleep(300);
  }
  throw new Error(`the preview never showed ${what}: ${JSON.stringify(last)}`);
}

async function sidebarIcon(ui) {
  return ui.eval(`(() => {
    const row = [...document.querySelectorAll('.session-section')].find(r => r.querySelector('.session-section-label')?.textContent === 'demo');
    const el = row?.querySelector('.session-section-icon');
    return el ? { cls: el.className, text: el.textContent, color: el.style.getPropertyValue('--dispatch-project-color') } : null;
  })()`);
}

// A real session in demo, so the sidebar has demo's row and the agent host makes and readies the session's own copy
// (task-am1t) the way it does for a person. It sends one message to OpenCode with GLM-5.3-Flash or DeepSeek's Flash (the
// cheap ones, it needs that login), so it runs only where asked: PROJECT_CUSTOM_LIVE=1.
const LIVE = process.env.PROJECT_CUSTOM_LIVE === "1";

async function liveSession(ui) {
  // the project's own page: Projects › demo › New Session, so the session works on demo's folder
  await openProjects(ui);
  await ui.click({ text: "demo", exact: true, within: ".dispatch-projects-page" });
  await ui.waitFor({ text: "Customize", exact: true }, { timeoutMs: 20000 });
  await ui.eval(`(() => { const c = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Customize' && e.offsetParent); let bar = c; for (let i = 0; i < 6 && bar && !/New Session/.test(bar.textContent); i++) bar = bar.parentElement; bar?.setAttribute('data-e2e', 'project-actions'); })()`);
  await ui.click({ text: "New Session", exact: true, within: '[data-e2e="project-actions"]' });
  await ui.waitFor({ css: ".sessions-workspace-picker-trigger" }, { timeoutMs: 20000 });
  const where = await ui.eval(`document.querySelector('.sessions-workspace-picker-trigger')?.innerText.trim()`);
  if (where !== "demo") throw new Error("the new session is on " + where + ", not demo");
  await ui.pickEngine("OpenCode", 180000);
  // the cheap test model (GLM-5.3-Flash when its login has it, DeepSeek's Flash, else a free OpenCode Zen one: ui.cheapModel)
  const picked = () => ui.eval(`document.querySelector('.model-picker-split')?.innerText.trim() || ''`);
  for (let i = 0; i < 6 && !ui.cheapModel([await picked()]); i++) {
    await ui.click({ css: ".model-picker-split" });
    await ui.sleep(800);
    const names = await ui.eval(`[...document.querySelectorAll('.context-view *')].filter(e => !e.children.length && e.offsetParent).map(e => (e.textContent || '').trim()).filter(Boolean)`);
    const want = ui.cheapModel(names);
    if (want) {
      await ui.click({ text: want, exact: true, within: ".context-view" });
      await ui.sleep(800);
    } else {
      await ui.press("Escape");
      await ui.sleep(3000);
    }
  }
  const sel = await ui.eval(`({ engine: document.querySelector('.sessions-chat-session-type-picker')?.innerText.trim(), model: document.querySelector('.model-picker-split')?.innerText.trim() })`);
  if (sel.engine !== "OpenCode" || !ui.cheapModel([sel.model || ""])) throw new Error("not a cheap OpenCode model, refusing to send: " + JSON.stringify(sel));
  ui.liveCopy = (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox [role="checkbox"]')?.getAttribute('aria-checked') ?? ''`)) === "true";
  await ui.click({ css: ".sessions-chat-editor .monaco-editor .view-lines" });
  await ui.type("Reply READY only. Do not use tools.");
  await ui.press("Enter", { send: true });
  const until = Date.now() + 240000;
  for (;;) {
    const reply = await ui.eval(`(() => { const e = [...document.querySelectorAll('.interactive-response')].at(-1); return e && !e.classList.contains('chat-response-loading') ? e.innerText : ''; })()`);
    if (/READY/.test(reply)) break;
    if (/quota|usage limit|rate.?limit|1113|1308|Authentication is required/i.test(reply)) throw new Error("OpenCode is not available: " + reply.slice(0, 200));
    if (Date.now() > until) throw new Error("no READY from the session: " + reply.slice(0, 200));
    await ui.sleep(2000);
  }
  await ui.screenshot("00-live-session");
}

/** What's new and the first-run tips sit over the sidebar on a new window; a person closes them first. The tips
 * come a few seconds after the window opens and one can follow another, so this waits a moment after each. */
let tipsSeen = false;
async function clearOverlays(ui) {
  for (let i = 0; i < 3 && await ui.exists("Welcome to Dispatch"); i++) { await ui.press("Escape"); await ui.sleep(500); }
  for (let i = 0; i < 8; i++) {
    const wait = tipsSeen ? 1500 : 15000;
    tipsSeen = true;
    if (!(await ui.waitFor({ css: ".dispatch-tour-close" }, { timeoutMs: wait }).then(() => true, () => false))) return;
    await ui.click({ css: ".dispatch-tour-close" });
    await ui.sleep(600);
  }
}

/** The Projects page from the sidebar's Projects row. */
async function openProjects(ui) {
  for (let i = 0; i < 4; i++) {
    await clearOverlays(ui);
    await ui.click({ text: "Projects", exact: true });
    if (await ui.waitFor({ text: "demo", exact: true, within: ".dispatch-projects-page" }, { timeoutMs: 8000 }).then(() => true, () => false)) return;
  }
  throw new Error("the Projects page did not open from the sidebar");
}

async function openCustomize(ui) {
  await openProjects(ui);
  await ui.click({ text: "demo", exact: true, within: ".dispatch-projects-page" });
  await ui.waitFor({ text: "Customize", exact: true }, { timeoutMs: 20000 });
  await ui.click({ text: "Customize", exact: true });
  await ui.waitFor({ text: "In the sidebar" }, { timeoutMs: 20000 });
}

export default async function (ui) {
  // a logo in the project's folder: the Picture choices offer it
  fs.mkdirSync(path.join(ui.demoFolder, "assets"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, "assets", "logo.png"), PNG_LOGO);
  // tools: one in the project's own .mcp.json (Claude Code asks about it the first time), one only Cursor reads
  fs.writeFileSync(path.join(ui.demoFolder, ".mcp.json"), JSON.stringify({ mcpServers: { "notes-db": { command: "notes-db-mcp", args: ["--read-only"] } } }, null, 2));
  // its own instructions and a hook of its own (task-6yrk)
  fs.writeFileSync(path.join(ui.demoFolder, "CLAUDE.md"), "# Demo\n\nUse plain words in the UI.\n");
  fs.mkdirSync(path.join(ui.demoFolder, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2));
  fs.mkdirSync(path.join(ui.demoFolder, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "https://figma.example/mcp" } } }, null, 2));

  // copies (task-am1t): a project with a .env git leaves out and installed packages
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=Dispatch e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: ui.demoFolder, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  fs.writeFileSync(path.join(ui.demoFolder, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\n");
  fs.writeFileSync(path.join(ui.demoFolder, "package.json"), JSON.stringify({ name: "demo", private: true }));
  fs.writeFileSync(path.join(ui.demoFolder, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, packages: {} }));
  fs.writeFileSync(path.join(ui.demoFolder, ".env"), "DEMO_KEY=local-only\n");
  fs.mkdirSync(path.join(ui.demoFolder, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(ui.demoFolder, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
  git("add", ".gitignore", "package.json", "package-lock.json");
  git("commit", "-qm", "chore: packages");

  await ui.openAgents(ui.demoFolder);
  if (LIVE) await liveSession(ui);
  await openCustomize(ui);
  const plain = await waitPreview(ui, p => /codicon-folder\b/.test(p.cls), "the plain folder");
  if (plain.color) throw new Error("a new project must not have a colour: " + JSON.stringify(plain));
  await ui.screenshot("01-customize-default");
  await ui.mark({ text: "In the sidebar" }, { what: "左栏里的样子", where: "Customize 页 Icon 一节", how: "项目页右上角 Customize" });

  // Symbol: the first one at once, then rocket
  await ui.click({ text: "Symbol", exact: true, within: ".dispatch-pc-page" });
  await waitPreview(ui, p => /codicon-code\b/.test(p.cls), "the first symbol");
  await ui.click({ aria: "rocket", within: ".dispatch-pc-page" });
  await waitPreview(ui, p => /codicon-rocket\b/.test(p.cls), "the rocket");
  // a colour on the icon only
  await ui.click({ aria: "Teal", within: ".dispatch-pc-page" });
  await waitPreview(ui, p => /codicon-rocket\b/.test(p.cls) && p.color === "#3aa39a", "a teal rocket");
  await ui.screenshot("02-symbol-teal");
  await ui.mark({ aria: "rocket", within: ".dispatch-pc-page" }, { what: "符号", where: "Icon 一节的格子", how: "点 Symbol 再点一个" });
  await ui.mark({ aria: "Teal", within: ".dispatch-pc-page" }, { what: "颜色只上在图标上", where: "Color 一节", how: "点一个色点" });

  // saved: leave and come back, the page reads it from the CLI again
  await reopenCustomize(ui);
  await waitPreview(ui, p => /codicon-rocket\b/.test(p.cls) && p.color === "#3aa39a", "the saved teal rocket");

  // the sidebar's project row (when the list has one for demo)
  let side = null;
  for (let i = 0; i < 20 && !(side && /codicon-rocket\b/.test(side.cls)); i++) {
    side = await sidebarIcon(ui);
    await ui.sleep(1000);
  }
  if (LIVE && !side) throw new Error("demo has a session but no row in the sidebar");
  if (side && !/codicon-rocket\b/.test(side.cls)) throw new Error("the sidebar row did not take the icon: " + JSON.stringify(side));
  if (side) {
    const worktrees = await ui.eval(`(() => { const r = [...document.querySelectorAll('.session-section')].find(r => r.querySelector('.session-section-label')?.textContent === 'Worktrees'); return r ? r.querySelector('.session-section-icon')?.className || '' : null; })()`);
    if (worktrees && /dispatch-project-look/.test(worktrees)) throw new Error("the Worktrees row under demo took demo's icon: " + worktrees);
    await ui.screenshot("02b-sidebar-icon");
    await ui.mark({ css: ".session-section .dispatch-project-look" }, { what: "左栏项目行的图标", where: "左栏 demo 一行", how: "改完立刻变" });
  }

  // Emoji (the Icon section back in the middle of the page first: a person looks at what they click)
  await ui.scrollTo("In the sidebar");
  await ui.click({ text: "Emoji", exact: true, within: ".dispatch-pc-page" });
  await ui.click({ aria: "🎨", within: ".dispatch-pc-page" });
  await waitPreview(ui, p => p.text === "🎨", "the emoji");
  await ui.screenshot("03-emoji");

  // Picture: the logo in the folder is the first pick
  await ui.click({ text: "Picture", exact: true, within: ".dispatch-pc-page" });
  await waitPreview(ui, p => p.img, "the picture");
  await ui.waitFor({ text: "Choose…", within: ".dispatch-pc-page" });
  await ui.screenshot("04-picture");
  await ui.mark({ text: "Choose…", within: ".dispatch-pc-page" }, { what: "选任意图片", where: "Picture 的格子后面", how: "点它选一张" });

  // back to the plain folder, no colour
  await ui.click({ text: "Folder", exact: true, within: ".dispatch-pc-page" });
  await ui.click({ aria: "No color", within: ".dispatch-pc-page" });
  await waitPreview(ui, p => /codicon-folder\b/.test(p.cls) && !p.color, "the plain folder again");
  // the sidebar follows the last pick, not one of the quick ones before it
  if (side) {
    let now = null;
    for (let i = 0; i < 15 && !(now && /codicon-folder\b/.test(now.cls) && !now.text && !now.color); i++) {
      now = await sidebarIcon(ui);
      await ui.sleep(1000);
    }
    if (!(now && /codicon-folder\b/.test(now.cls) && !now.text && !now.color)) throw new Error("the sidebar row kept an earlier pick: " + JSON.stringify(now));
  }
  await ui.screenshot("05-back-to-folder");

  // the same page from the sidebar: right-click the project's row
  if (side) {
    const hit = (await ui.find({ text: "demo", exact: true, within: ".session-section" })).hits[0];
    const x = hit.box.x + hit.box.w / 2, y = hit.box.y + hit.box.h / 2;
    await ui.mouse("mouseMoved", x, y);
    await ui.mouse("mousePressed", x, y, { button: "right", clickCount: 1 });
    await ui.mouse("mouseReleased", x, y, { button: "right", clickCount: 1 });
    await ui.waitFor({ text: "Customize Project..." }, { timeoutMs: 5000 });
    await ui.screenshot("06-sidebar-menu");
    await ui.mark({ text: "Customize Project..." }, { what: "左栏入口", where: "左栏项目行右键菜单", how: "右键项目名" });
    await ui.click({ text: "Customize Project..." });
    await ui.waitFor({ text: "In the sidebar" }, { timeoutMs: 10000 });
  }

  await toolsSteps(ui);
  await copiesSteps(ui, git);
  await agentFilesSteps(ui);
  await settingsSteps(ui);
}

// Settings (⌘,) › Projects: the project's icon on its row and Customize on hover
async function settingsSteps(ui) {
  await clearOverlays(ui);
  for (const type of ["keyDown", "keyUp"]) {
    await ui.cdp.send("Input.dispatchKeyEvent", { type, key: ",", code: "Comma", modifiers: 4, windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188 });
  }
  await ui.waitFor({ css: ".dispatch-settings-page" }, { timeoutMs: 10000 });
  // Projects in the settings' own list on the left (it slides in over the sessions list, which has a Projects row
  // of its own)
  await ui.waitFor({ text: "Projects", exact: true, within: ".dispatch-settings-nav" }, { timeoutMs: 10000 });
  await ui.sleep(600);
  await ui.click({ text: "Projects", exact: true, within: ".dispatch-settings-nav" });
  await ui.waitFor({ css: '.dispatch-settings-page .dset-row[data-project="demo"]' }, { timeoutMs: 15000 });
  await ui.hover({ css: '.dispatch-settings-page .dset-row[data-project="demo"]' });
  await ui.screenshot("13-settings-projects");
  await ui.mark({ text: "Customize", exact: true, within: '.dset-row[data-project="demo"]' }, { what: "设置页里的入口", where: "设置 › Projects 每行悬停", how: "⌘, 打开设置，点 Projects" });
  await ui.click({ text: "Customize", exact: true, within: '.dset-row[data-project="demo"]' });
  await ui.waitFor({ text: "In the sidebar" }, { timeoutMs: 10000 });
}

// back to the project's page and into Customize again, the way a person does it: scroll up to the
// "demo ›" link at the top of the page first (a click on a link scrolled out of sight lands on nothing)
async function reopenCustomize(ui) {
  await ui.eval(`document.querySelector('.dispatch-pc-page .dispatch-projects-crumb')?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await ui.click({ css: ".dispatch-pc-page .dispatch-projects-crumb" });
  await ui.waitFor({ css: ".dispatch-pc-page" }, { gone: true, timeoutMs: 20000 });
  await ui.waitFor({ text: "Customize", exact: true }, { timeoutMs: 20000 });
  await ui.click({ text: "Customize", exact: true });
  await ui.waitFor({ css: ".dispatch-pc-page" }, { timeoutMs: 20000 });
}

function cliEnv(rec) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDE_CODE_|DISPATCH_|BEADS_|CODEX_THREAD|CODEX_SESSION)/.test(key) && key !== "CLAUDECODE") env[key] = value;
  }
  return Object.assign(env, { BEADS_DIR: rec.beads_dir, DISPATCH_DIR: rec.dispatch_dir, DISPATCH_HOME: rec.dispatch_home, DISPATCH_BIN: rec.cli,
    DISPATCH_E2E_INSTANCE: rec.name, PATH: `${path.join(rec.app, "Contents/Resources/app/tools")}:${process.env.PATH}` });
}

async function copiesSteps(ui, git) {
  await ui.scrollTo("Copies for parallel work");
  await ui.waitFor({ text: "Get copies ready on their own" }, { timeoutMs: 15000 });
  const steps = await ui.eval(`(() => { const s = document.querySelector('.dispatch-pc-page .dispatch-pc-steps'); return s ? { copy: s.dataset.copy, link: s.dataset.link, text: s.textContent } : null; })()`);
  if (!steps || !steps.copy.split(",").includes(".env") || steps.link !== "node_modules") throw new Error("the copies plan is not what the folder needs: " + JSON.stringify(steps));
  await ui.screenshot("10-copies");
  await ui.mark({ text: "Get copies ready on their own" }, { what: "副本自动准备的开关（默认开）", where: "Customize 页 Copies 一节", how: "点一下关掉或打开" });

  // the live session's own copy (when it worked in one): the agent host got it ready on its own
  if (LIVE && ui.liveCopy) {
    const st = JSON.parse(spawnSync("python3", [ui.rec.cli, "worktree", "status", ui.demoFolder, "--json"], { env: cliEnv(ui.rec), encoding: "utf8" }).stdout || "{}");
    const last = st.last;
    if (!last || !last.copy || last.copy === fs.realpathSync(ui.demoFolder)) throw new Error("the session's copy was not got ready: " + JSON.stringify(st));
    if (!fs.existsSync(path.join(last.copy, ".env"))) throw new Error("the session's copy has no .env: " + last.copy);
    if (fs.realpathSync(path.join(last.copy, "node_modules")) !== fs.realpathSync(path.join(ui.demoFolder, "node_modules"))) throw new Error("the session's copy does not share node_modules: " + last.copy);
    await ui.waitFor({ text: "Last copy: " + path.basename(last.copy) }, { timeoutMs: 15000 });
    await ui.screenshot("10b-session-copy");
  }

  // what the agent host does right after it makes a session's copy: git makes it, dispatch gets it ready
  const copy = path.join(path.dirname(ui.demoFolder), "demo.worktrees", "try-colors");
  fs.rmSync(copy, { recursive: true, force: true });
  git("worktree", "add", "-q", copy, "-b", `try-colors-${Date.now()}`);
  const r = spawnSync("python3", [ui.rec.cli, "worktree", "prepare", copy, "--from", ui.demoFolder, "--json"], { env: cliEnv(ui.rec), cwd: copy, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error("dispatch worktree prepare: " + (r.stderr || r.stdout));
  if (fs.readFileSync(path.join(copy, ".env"), "utf8") !== "DEMO_KEY=local-only\n") throw new Error("the copy did not get .env");
  if (fs.realpathSync(path.join(copy, "node_modules")) !== fs.realpathSync(path.join(ui.demoFolder, "node_modules"))) throw new Error("the copy does not share node_modules");
  const status = spawnSync("git", ["-C", copy, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
  if (status) throw new Error("the copy shows changes git would commit: " + status);

  // the page says how the last copy went
  await reopenCustomize(ui);
  await ui.scrollTo("Copies for parallel work");
  await ui.waitFor({ text: "Last copy: try-colors" }, { timeoutMs: 15000 });
  await ui.screenshot("11-last-copy");
  await ui.mark({ text: "Last copy: try-colors" }, { what: "上一个副本准备好了", where: "Copies 一节最后一行", how: "开一个独立副本的会话后自动出现" });

  // off, and it stays off
  await ui.click({ text: "Get copies ready on their own" });
  await ui.waitFor({ text: "Off: a copy has only what git keeps. The agent installs and sets up what it needs itself." }, { timeoutMs: 10000 });
  await reopenCustomize(ui);
  await ui.scrollTo("Copies for parallel work");
  await ui.waitFor({ text: "Off: a copy has only what git keeps. The agent installs and sets up what it needs itself." }, { timeoutMs: 15000 });
  const checked = await ui.eval(`document.querySelector('.dispatch-pc-page .dispatch-pc-switch-row')?.getAttribute('aria-checked')`);
  if (checked !== "false") throw new Error("the switch did not stay off: " + checked);
  await ui.screenshot("12-copies-off");
  await ui.click({ text: "Get copies ready on their own" });
  await ui.waitFor({ text: "Last copy: try-colors" }, { timeoutMs: 10000 });
}

async function agentFilesSteps(ui) {
  await ui.scrollTo("Its own instructions and hooks");
  await ui.waitFor({ text: "Dispatch adds to these and never replaces them." }, { timeoutMs: 15000 });
  const rows = await ui.eval(`[...document.querySelectorAll('.dispatch-pc-page [data-section="agent-files"] .dispatch-pc-file')].map(r => r.textContent)`);
  if (!rows.some(r => r.startsWith("CLAUDE.md") && /Claude Code/.test(r))) throw new Error("CLAUDE.md is not listed: " + JSON.stringify(rows));
  if (!rows.some(r => r.startsWith(".claude/settings.json") && /1 hook/.test(r))) throw new Error("the project's hook is not listed: " + JSON.stringify(rows));
  await ui.screenshot("09-agent-files");
  await ui.mark({ text: "Its own instructions and hooks" }, { what: "项目自己的规矩和钩子，Dispatch 只加不替换", where: "Customize 页最下面", how: "项目页 Customize 往下滚" });
}

async function pill(ui, tool, engine) {
  return ui.eval(`(() => {
    const b = document.querySelector('.dispatch-pc-page .dispatch-pc-tool[data-tool="${tool}"] .dispatch-pc-engine[data-engine="${engine}"]');
    return b ? { pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title } : null;
  })()`);
}

async function toolsSteps(ui) {
  // Tools agents can use here (task-gsmh)
  await ui.scrollTo("Tools agents can use here");
  await ui.waitFor({ css: '.dispatch-pc-tool[data-tool="notes-db"]' }, { timeoutMs: 15000 });
  const ask = await pill(ui, "notes-db", "claude-code");
  if (!ask || ask.pressed !== "false" || !/allowed/.test(ask.title)) throw new Error("notes-db should wait for Claude Code's first-time question: " + JSON.stringify(ask));
  const codex = await pill(ui, "notes-db", "codex");
  if (!codex?.disabled) throw new Error("notes-db is not set up for Codex, its pill must be off: " + JSON.stringify(codex));
  const cursor = await pill(ui, "figma", "claude-code");
  if (!cursor?.disabled || !/Cursor/.test(cursor.title)) throw new Error("figma is Cursor's only: " + JSON.stringify(cursor));
  await ui.screenshot("07-tools");
  await ui.mark({ text: "Tools agents can use here" }, { what: "这个项目里 Agent 能用的外部工具", where: "Customize 页下半", how: "项目页 Customize 往下滚" });
  await ui.click({ css: '.dispatch-pc-tool[data-tool="notes-db"] .dispatch-pc-engine[data-engine="claude-code"]' });
  const until = Date.now() + 15000;
  let now;
  while (Date.now() < until) {
    now = await pill(ui, "notes-db", "claude-code");
    if (now?.pressed === "true") break;
    await ui.sleep(300);
  }
  if (now?.pressed !== "true") throw new Error("the Claude Code pill did not turn on: " + JSON.stringify(now));
  // saved in Claude Code's own per-project list: leave, come back, still on
  await reopenCustomize(ui);
  await ui.scrollTo("Tools agents can use here");
  await ui.waitFor({ css: '.dispatch-pc-tool[data-tool="notes-db"] .dispatch-pc-engine.on[data-engine="claude-code"]' }, { timeoutMs: 15000 });
  await ui.screenshot("08-tool-on");
  await ui.mark({ css: '.dispatch-pc-tool[data-tool="notes-db"] .dispatch-pc-engine[data-engine="claude-code"]' }, { what: "只在这个项目里给 Claude Code 开", where: "工具行右边的胶囊", how: "点一下开关" });
}
