// The slash menu of the Agents window (dispatch-ide patches/310-slash-menu.patch), with a real session of one
// engine: SLASH_ENGINE=opencode (default: the cheap test model) | claude (Sonnet, real Claude messages) |
// codex (no model requests).
// SLASH_COLD_START=1 keeps the first new-session page instead of clicking New.
// SLASH_MODEL and SLASH_PROVIDER may explicitly select a fallback, e.g. Claude Sonnet 5.5 / Anthropic.
// SLASH_NO_MODEL_REQUESTS=1 checks OpenCode's local commands when provider access is unavailable.
// Use SLASH_EXISTING_SESSION_TITLE or SLASH_USE_CURRENT_SESSION=1 for a materialized test session.
//   new-session page: `/` opens one menu grouped Commands, Skills, MCP, Plugins, Agents, Model, four
//   each, the engine's name on the last line; typing filters across groups; `/skills` shows Skills only;
//   no Copilot built-in skills, no /vscode-pet; a skill goes into the input (Insert).
//   running session: a command runs (Run) and its answer shows; the model changes from the Model group
//   (Switch); a page opens from MCP, Plugins or Commands (Open); a command this engine does not have gets
//   a grey row with why and where; `/clear` draws "Context cleared", keeps the messages above, and the
//   next answer does not know what was said before it.
export const meta = { needs: ['opencode'],
  title: "斜杠命令菜单",
  description: "敲 / 出一个按类分组的菜单：跨组过滤、组名收窄、Run / Insert / Open / Switch、灰行说明、引擎名；/clear 只清上下文。",
};

import { writeFile } from "node:fs/promises";

const ENGINE = process.env.SLASH_ENGINE || "opencode";
const NAME = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" }[ENGINE];
if (!NAME) throw new Error(`unknown SLASH_ENGINE ${ENGINE}`);
const NO_MODEL_REQUESTS = (ENGINE === "codex" && process.env.SLASH_REAL_CODEX !== "1") || process.env.SLASH_NO_MODEL_REQUESTS === "1";
const MESSAGE_MODEL = process.env.SLASH_MODEL || (ENGINE === "claude" ? "Sonnet" : ENGINE === "codex" ? "GPT-6-Astra" : "GLM-5.3 Flash");
const MESSAGE_PROVIDER = process.env.SLASH_PROVIDER || (ENGINE === "opencode" ? "Z.AI Coding Plan" : "");
// a command each engine runs from the menu, the text its answer shows, and a command it does not have
const RUN = { claude: ["context", /Context Usage/i], codex: ["status", /Codex usage|limits/i], opencode: NO_MODEL_REQUESTS ? ["clear", /Context cleared/i] : ["init", /AGENTS\.md/i] }[ENGINE];
const GREY = { claude: "resume", codex: "context", opencode: "undo" }[ENGINE];
const COPILOT_SKILLS = ["commit", "fix-ci", "create-pr", "create-draft-pr", "merge", "merge-changes", "sync", "act-on-feedback", "generate-run-commands", "update-pr", "update-skills", "sync-upstream", "troubleshoot"];

const menu = ".dispatch-slash-menu";
const newInput = ".sessions-chat-editor";
const chatInput = ".interactive-input-part .monaco-editor";

/** The menu as data: its groups (name, count), rows, the selected row, the grey rows, the last line. */
const readMenu = (ui) => ui.eval(`(() => {
  const m = document.querySelector('${menu}');
  if (!m) return null;
  const heads = [...m.querySelectorAll('.dsm-head')].map(h => ({ name: h.querySelector('.dsm-head-name')?.textContent, count: h.querySelector('.dsm-head-count')?.textContent || '', what: h.querySelector('.dsm-head-what')?.textContent }));
  const rows = [...m.querySelectorAll('.dsm-row')].map(r => ({ name: r.querySelector('.dsm-name')?.textContent, desc: r.querySelector('.dsm-desc')?.textContent || '', grey: r.classList.contains('dsm-gray'), more: r.classList.contains('dsm-more'), selected: r.classList.contains('selected'), act: r.querySelector('.dsm-act span')?.textContent || '', current: !!r.querySelector('.dsm-current'), position: [...r.parentElement.children].indexOf(r) + 1 }));
  // each group: how many entries it shows before its Show all row
  const groups = [];
  for (const el of m.querySelectorAll('.dsm-list > *')) {
    if (el.classList.contains('dsm-head')) groups.push({ name: el.querySelector('.dsm-head-name')?.textContent, shown: 0, more: false });
    else if (groups.length && el.classList.contains('dsm-more')) groups[groups.length - 1].more = true;
    else if (groups.length && el.classList.contains('dsm-row')) groups[groups.length - 1].shown++;
  }
  return { heads, rows, groups, engine: m.querySelector('.dsm-engine')?.textContent || '', keys: m.querySelector('.dsm-keys')?.textContent || '', width: Math.round(m.getBoundingClientRect().width) };
})()`);

async function waitMenu(ui, check, what, timeoutMs = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await readMenu(ui);
    if (last && !(await ui.exists({ css: `${menu} .dsm-loading` })) && (!check || check(last))) return last;
    await ui.sleep(300);
  }
  throw new Error(`menu: ${what}; last seen ${JSON.stringify(last)?.slice(0, 600)}`);
}

async function clearInput(ui, input) {
  await ui.click({ css: input });
  await ui.press("End");
  for (let i = 0; i < 200 && (await inputText(ui, input)).length; i++) await ui.press("Backspace");
  if ((await inputText(ui, input)).length) throw new Error("could not clear the draft");
}

const inputText = (ui, input) => ui.eval(`(document.querySelector('${input} .view-lines')?.innerText || '').replace(/\\u00a0/g, ' ').trim()`);
const lastResponse = (ui) => ui.eval(`(() => {
  const rows = [...document.querySelectorAll('.interactive-response')];
  const row = rows.find(r => r.classList.contains('chat-most-recent-response')) || rows.at(-1);
  return row ? { text: row.innerText, index: Number(row.closest('.monaco-list-row')?.getAttribute('data-index') ?? -1), loading: row.classList.contains('chat-response-loading') } : {text:'',index:-1,loading:true};
})()`);

// The rows the chat list shows, in order (data-index), with whether each is a request.
const chatRows = (ui) => ui.eval(`(() => [...document.querySelectorAll('.interactive-list .monaco-list-row')]
  .map(r => ({ index: Number(r.getAttribute('data-index')), request: !!r.querySelector('.interactive-request'),
    // the message itself: a request row also shows hover actions (Start Over) and its time
    text: (r.querySelector('.interactive-request .rendered-markdown')?.innerText || r.innerText).split('\\n').map(l => l.trim()).filter(l => l && l !== 'Start Over' && !/^\\d{1,2}:\\d{2}( [AP]M)?$/.test(l)).join('\\n') }))
  .filter(r => r.text).sort((a, b) => a.index - b.index))()`);

// every row of the conversation: the list draws only the rows in view, so wheel it from the top to the end
async function allChatRows(ui) {
  const box = await ui.eval(`(() => { const r = document.querySelector('.interactive-list')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height } : null; })()`);
  if (!box) return chatRows(ui);
  const byIndex = new Map();
  const take = async () => { for (const r of await chatRows(ui)) byIndex.set(r.index, r); };
  for (let i = 0; i < 40; i++) await ui.mouse("mouseWheel", box.x, box.y, { deltaX: 0, deltaY: -4000 });
  await ui.sleep(400);
  await take();
  // down a screen at a time until the list's last row has been drawn
  const atEnd = () => ui.eval(`[...document.querySelectorAll('.interactive-list .monaco-list-row')].some(r => r.getAttribute('aria-posinset') && r.getAttribute('aria-posinset') === r.getAttribute('aria-setsize'))`);
  for (let i = 0; i < 80 && !(await atEnd()); i++) {
    await ui.mouse("mouseWheel", box.x, box.y, { deltaX: 0, deltaY: Math.max(100, box.h - 120) });
    await ui.sleep(250);
    await take();
  }
  for (let i = 0; i < 10; i++) await ui.mouse("mouseWheel", box.x, box.y, { deltaX: 0, deltaY: 4000 });
  await ui.sleep(300);
  await take();
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

async function waitAnswer(ui, re, timeoutMs, what, afterIndex = -1) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await lastResponse(ui);
    if (/quota|rate.?limit|usage limit|insufficient|额度|余额|使用上限|Internal error|API Error|1308|1113/i.test(last.text)) throw new Error(`model unavailable: ${last.text}`);
    if (last.index > afterIndex && !last.loading && re.test(last.text)) return last.text;
    await ui.sleep(1500);
  }
  throw new Error(`waiting for ${what}: ${last?.text}`);
}

async function modelsMenu(ui, input) {
  await clearInput(ui, input);
  await ui.type("/model");
  return waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "Model group", 30000);
}

async function chooseModel(ui, input, row) {
  // Narrow a long provider list first. A same-named model chip outside the menu must not be scrolled
  // or clicked instead; keyboard selection also scrolls the menu's selected row into view.
  await clearInput(ui, input);
  await ui.type(`/${row.name.replace(/\s+/g, "")}`);
  let choices = await waitMenu(ui, m => m.rows.some(r => r.name === row.name && r.desc === row.desc), row.name);
  for (let n = 0; n < choices.rows.length + 2; n++) {
    if (choices.rows.some(r => r.selected && r.name === row.name && r.desc === row.desc)) break;
    await ui.press("ArrowDown");
    choices = await readMenu(ui);
  }
  if (!choices.rows.some(r => r.selected && r.name === row.name && r.desc === row.desc)) throw new Error(`cannot select ${row.name} / ${row.desc}`);
  await ui.press("Enter", { send: true });
  await ui.sleep(1000);
  await modelsMenu(ui, input);
  // OpenCode confirms the session's configuration asynchronously after the picker label changes.
  await waitMenu(ui, m => m.rows.some(r => r.current && r.name === row.name && r.desc === row.desc),
    `model switched to ${row.name} / ${row.desc}`, 20000);
  await clearInput(ui, input);
  await ui.press("Escape");
}

async function chooseMessageModel(ui, input) {
  const models = await modelsMenu(ui, input);
  // the provider line may carry more than its name ("DeepSeek · …"): a case-insensitive part is enough
  const pick = (name, provider) => models.rows.find(r => r.name === name && (!provider || (r.desc || "").toLowerCase().includes(provider.toLowerCase())));
  // OpenCode's default test model is GLM 5.3 Flash; without the Z.AI Coding Plan, DeepSeek V4.1 Flash (both read images)
  const row = pick(MESSAGE_MODEL, MESSAGE_PROVIDER)
    ?? (ENGINE === "opencode" && !process.env.SLASH_MODEL ? pick("DeepSeek V4.1 Flash", "DeepSeek") : undefined);
  if (!row) throw new Error(`required test model missing: ${MESSAGE_MODEL} / ${MESSAGE_PROVIDER} (listed: ${models.rows.map(r => r.name + " / " + r.desc).slice(0, 30).join("; ")})`);
  await chooseModel(ui, input, row);
  return row;
}

async function send(ui, text) {
  await ui.click({ css: chatInput });
  await ui.type(text);
  await ui.press("Enter", { send: true });
}

async function waitIdle(ui, timeoutMs = 240000) {
  const t0 = Date.now();
  await ui.sleep(1500);
  while (Date.now() - t0 < timeoutMs) {
    const busy = await ui.eval(`!!document.querySelector('.interactive-input-part .codicon-stop-circle, .interactive-input-part [aria-label^="Stop"], .interactive-input-part [aria-label^="Cancel"]')`);
    if (!busy) return;
    await ui.sleep(1500);
  }
  throw new Error("the turn did not finish");
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  if (await ui.exists({ aria: "Close Modal Editor" })) await ui.click({ aria: "Close Modal Editor" });
  if (process.env.SLASH_EXISTING_SESSION_TITLE || process.env.SLASH_USE_CURRENT_SESSION === "1") {
    if (process.env.SLASH_EXISTING_SESSION_TITLE) await ui.openSession(process.env.SLASH_EXISTING_SESSION_TITLE);
    await ui.waitFor({ css: chatInput }, { timeoutMs: 30000 });
    const engine = await ui.eval(`document.querySelector('.interactive-input-part')?.innerText || ''`);
    if (!engine.includes(NAME)) throw new Error(`existing test session is not ${NAME}`);
    await clearInput(ui, chatInput);
  } else {
    if (ENGINE === "opencode" && NO_MODEL_REQUESTS) throw new Error("OpenCode local checks need SLASH_EXISTING_SESSION_TITLE");
    if (process.env.SLASH_COLD_START !== "1") await ui.newSession();
    const picker = ".sessions-chat-session-type-picker";
    const engineNow = () => ui.eval(`document.querySelector('${picker}')?.innerText.trim()`);
    // an old draft (`/` from an earlier run) would open the menu over the pickers
    await clearInput(ui, newInput);
    await ui.press("Escape");
    await ui.closeOverlays();
    if ((await engineNow()) !== NAME) {
      // as fixes-opencode-skills.mjs does; a new session keeps the engine picked last, so picking it once
      // in the window (or by hand) before the run also works
      await ui.pickEngine(NAME); // waits while OpenCode's models are still loading (disabled row)
      for (let i = 0; i < 40 && (await engineNow()) !== NAME; i++) await ui.sleep(250);
      if ((await engineNow()) !== NAME) throw new Error(`the engine picker still says ${await engineNow()}: pick ${NAME} for a new session in the window, then run again`);
    }
    // no worktree: its branch is named after the first message, which would tell the model the word below
    if (await ui.eval(`document.querySelector('.sessions-chat-isolation-checkbox .monaco-checkbox')?.getAttribute('aria-checked') === 'true'`)) {
      await ui.click({ css: ".sessions-chat-isolation-checkbox .monaco-checkbox" });
    }
    await ui.sleep(1500);

    // 1. `/` on the new-session page: six groups (those the engine has), four each, the engine at the bottom
    await ui.click({ css: newInput });
    await ui.type("/");
    const first = await waitMenu(ui, m => m.heads.some(h => h.name === "Skills") && (ENGINE !== "claude" || m.heads.some(h => h.name === "MCP")), "groups after /", 45000);
    await writeFile(`${ui.out}/menu.json`, JSON.stringify(first, null, 2));
    await ui.screenshot(`01-${ENGINE}-menu`);
    await ui.mark({ css: menu }, { what: "敲 / 弹出的菜单：按类分组，每组先露 4 条，多的收在 Show all", where: "输入框正上方，和输入框同宽", how: "输入框第一个字打 /" });
    await ui.mark({ css: `${menu} .dsm-foot` }, { what: `最后一行写当前引擎（${NAME}）和键位`, where: "菜单最底下", how: "一直在" });
    const groups = first.heads.map(h => h.name);
    for (const g of groups) if (!["Commands", "Skills", "MCP", "Plugins", "Agents", "Model"].includes(g)) throw new Error(`unexpected group ${g}`);
    const order = ["Commands", "Skills", "MCP", "Plugins", "Agents", "Model"].filter(g => groups.includes(g));
    if (order.join() !== groups.join()) throw new Error(`groups out of order: ${groups}`);
    if (!first.engine.includes(NAME)) throw new Error(`footer says "${first.engine}", not ${NAME}`);
    // four entries per group before its Show all
    for (const g of first.groups) {
      if (g.more && g.shown !== 4) throw new Error(`${g.name} shows ${g.shown} entries before Show all, not 4`);
      if (!g.more && g.name !== "Model" && g.shown > 4) throw new Error(`${g.name} shows ${g.shown} entries without Show all`);
    }
    const names = first.rows.map(r => r.name);
    if (names.some(n => n === "/vscode-pet")) throw new Error("/vscode-pet is in the menu");

    // 2. typing filters across groups
    await ui.type("co");
    const filtered = await waitMenu(ui, m => m.rows.length > 0, "rows after /co");
    // the menu matches by name, then by description, then fuzzily (dispatchSlashMenuModel scoreEntry): "co" fits
    // "Claude Opus" and "skill-creator" by their letters in order, as in VS Code's quick open
    if (filtered.rows.some(r => !r.grey && !r.more && !/co/i.test(`${r.name} ${r.desc}`) && !/c.*o/i.test(r.name))) throw new Error(`a row without "co": ${JSON.stringify(filtered.rows)}`);
    await ui.screenshot(`02-${ENGINE}-filter`);

    // 3. a whole group name: that group only
    await ui.press("Backspace"); await ui.press("Backspace");
    await ui.type("skills");
    const skills = await waitMenu(ui, m => m.heads.length === 1, "Skills only after /skills");
    if (skills.heads[0].name !== "Skills") throw new Error(`/skills shows ${skills.heads[0].name}`);
    for (const bad of COPILOT_SKILLS) if (skills.rows.some(r => r.name === `/${bad}`)) throw new Error(`Copilot's built-in skill /${bad} is in the menu`);
    await ui.screenshot(`03-${ENGINE}-skills`);
    await ui.mark({ css: `${menu} .dsm-head` }, { what: "敲满组名只看这一组（这里是 /skills）", where: "菜单里", how: "打 /skills、/mcp、/model" });

    // 4. Insert: the first skill goes into the input
    const skillName = skills.rows.find(r => !r.more)?.name;
    if (!skillName) throw new Error("no skill to insert");
    await ui.press("Enter", { send: true });
    await ui.sleep(600);
    const inserted = await inputText(ui, newInput);
    if (!inserted.startsWith(skillName)) throw new Error(`Insert put "${inserted}", not ${skillName}`);
    if (await ui.exists({ css: menu })) throw new Error("the menu is still open after Insert");
    await ui.screenshot(`04-${ENGINE}-insert`);
    await ui.mark({ css: newInput }, { what: `选中技能后是 Insert：${skillName} 填进输入框，接着写这一句`, where: "输入框", how: "选中技能按 ↵ 或 Tab" });

    if (ENGINE === "codex") {
      await clearInput(ui, newInput);
      await ui.type("/review");
      const review = await waitMenu(ui, m => m.rows.some(r => r.name === "/review"), "/review");
      if (review.rows.find(r => r.name === "/review")?.act !== "Insert") throw new Error("/review must insert arguments");
      await ui.screenshot("04b-codex-review-menu");
      await ui.press("Enter", { send: true });
      if (!(await inputText(ui, newInput)).startsWith("/review")) throw new Error("/review was not inserted");
      await ui.screenshot("04c-codex-review-inserted");
    }

    // Pin an allowed test model before sending; Codex only executes local /status.
    await clearInput(ui, newInput);
    if (!NO_MODEL_REQUESTS) {
      const model = await chooseMessageModel(ui, newInput);
      await writeFile(`${ui.out}/message-model.json`, JSON.stringify(model, null, 2));
      await ui.screenshot(`04d-${ENGINE}-message-model`);
    }
    await ui.type(NO_MODEL_REQUESTS ? `/${RUN[0]}` : "Remember the word PELICAN. Reply with just OK. Do not use tools or write files.");
    if (NO_MODEL_REQUESTS) await waitMenu(ui, m => m.rows.some(r => r.name === `/${RUN[0]}` && r.selected), `/${RUN[0]}`);
    await ui.press("Enter", { send: true });
    await waitAnswer(ui, NO_MODEL_REQUESTS ? RUN[1] : /\bOK\b/, 180000, "the first answer");
    await waitIdle(ui);
  }

  // 5. Run: a command the engine runs, its answer in the reply
  await ui.click({ css: chatInput });
  await ui.type(`/${RUN[0]}`);
  const run = await waitMenu(ui, m => m.rows.some(r => r.name === `/${RUN[0]}`), `/${RUN[0]} in the menu`);
  const runRow = run.rows.find(r => r.name === `/${RUN[0]}`);
  if (!runRow.selected || runRow.act !== "Run") throw new Error(`/${RUN[0]} is not the selected Run row: ${JSON.stringify(runRow)}`);
  await ui.screenshot(`05-${ENGINE}-run-menu`);
  await ui.mark({ css: `${menu} .dsm-row.selected` }, { what: `选中的那行右边写这一步做什么：Run`, where: "菜单里选中的行", how: "↵ 直接执行" });
  const beforeRun = (await lastResponse(ui)).index;
  await ui.press("Enter", { send: true });
  await waitAnswer(ui, RUN[1], 300000, `the answer of /${RUN[0]}`, beforeRun);
  await waitIdle(ui, 400000);
  await ui.screenshot(`06-${ENGINE}-run-result`);

  // 6. Switch: another model from the Model group
  const modelLabel = () => ui.eval(`(document.querySelector('.interactive-input-part .model-picker-item, .interactive-input-part .chat-model-picker-item, .interactive-input-part [class*="model-picker"]')?.innerText || '').trim()`);
  const before = await modelLabel();
  await ui.click({ css: chatInput });
  await ui.type("/model");
  const models = await waitMenu(ui, m => m.heads.length === 1 && m.heads[0].name === "Model", "the Model group");
  const target = models.rows.find(r => !r.more && !r.current && !r.grey && r.name !== "All models and effort");
  if (!target) throw new Error(`no other model to switch to: ${JSON.stringify(models.rows)}`);
  await ui.screenshot(`07-${ENGINE}-model`);
  await chooseModel(ui, chatInput, target);
  const after = await modelLabel();
  if (after === before) throw new Error(`the model stayed "${before}" after switching to ${target.name}`);
  await ui.screenshot(`08-${ENGINE}-switched`);
  await ui.mark({ css: ".interactive-input-part [class*='model-picker']" }, { what: `Model 组里点一个模型就是 Switch：换成 ${target.name}`, where: "输入框里的模型名", how: "/model 选一行" });
  // The Switch check sends nothing. Restore the allowed model for the later answer.
  if (!NO_MODEL_REQUESTS) await chooseMessageModel(ui, chatInput);

  // 7. Open: an MCP server, a plugin, or Hooks
  await ui.click({ css: chatInput });
  await ui.type(ENGINE === "opencode" ? "/hooks" : "/mcp");
  let open = await waitMenu(ui, m => m.heads.length >= 1 || m.rows.length === 0, "the MCP group");
  let section = ENGINE === "opencode" ? "Hooks" : "MCP Servers";
  if (!open.rows.some(r => !r.grey && !r.more)) {
    await clearInput(ui, chatInput);
    await ui.type("/hooks");
    open = await waitMenu(ui, m => m.rows.some(r => r.name === "/hooks"), "/hooks");
    section = "Hooks";
  }
  await ui.screenshot(`09-${ENGINE}-open-menu`);
  // what Settings does from here, for a failure's message: each time it opens or closes, and the page it is on
  await ui.eval(`(() => { const t0 = performance.now(); const sb = document.querySelector('.part.sidebar'); window.__settingsFlips = []; new MutationObserver(() => window.__settingsFlips.push(Math.round(performance.now() - t0) + (sb.classList.contains('dispatch-settings-open') ? ' open' : ' closed'))).observe(sb, { attributes: true, attributeFilter: ['class'] }); })()`).catch(() => undefined);
  await ui.press("Enter", { send: true });
  await ui.waitFor({ text: section }, { timeoutMs: 15000 });
  await ui.sleep(1500);
  // what was the Customizations dialog is a page of Settings now (MCP servers, Hooks): either closes the same way a person does
  const settingsNav = { css: ".part.sidebar.dispatch-settings-open .dispatch-settings-nav", webview: false };
  const dialog = { css: ".management-sidebar", webview: false };
  for (const end = Date.now() + 15000; !(await ui.exists(settingsNav)) && !(await ui.exists(dialog)) && Date.now() < end; ) await ui.sleep(300);
  const inSettings = await ui.exists(settingsNav);
  if (!inSettings) await ui.waitFor(dialog, { timeoutMs: 1000 });
  await ui.screenshot(`10-${ENGINE}-open-page`);
  await ui.mark(inSettings ? { css: ".part.sidebar.dispatch-settings-open", webview: false } : { css: ".management-sidebar" }, { what: `Open：打开设置里的 ${section} 页`, where: inSettings ? "设置" : "弹出的 Customizations", how: `/mcp 或 /hooks 选一行 ↵` });
  if (inSettings) {
    // Settings' own way back to the sessions (the back row at the top of its list)
    // Settings' back row ("Sessions", Esc); a page opened from the slash menu may hold the keyboard: Escape too
    await ui.click({ css: ".dispatch-settings-nav .dsn-back", webview: false });
    for (let i = 0; i < 6 && await ui.exists(settingsNav); i++) {
      await ui.sleep(1000);
      if (i >= 2) await ui.press("Escape");
    }
    await ui.waitFor(settingsNav, { timeoutMs: 10000, gone: true }).catch(async (e) => {
      throw new Error(`${e.message}; Settings: ${JSON.stringify(await ui.eval('window.__settingsFlips').catch(() => null))}`);
    });
  } else {
    // the dialog's own close button (Escape goes to its search box first)
    await ui.click({ aria: "Close Modal Editor" });
    await ui.waitFor(dialog, { timeoutMs: 10000, gone: true });
  }

  // 8. a command this engine does not have: a grey row with why and where
  await ui.click({ css: chatInput });
  await clearInput(ui, chatInput);
  await ui.type(`/${GREY}`);
  const grey = await waitMenu(ui, m => m.rows.some(r => r.grey), `a grey row for /${GREY}`);
  const greyRow = grey.rows.find(r => r.grey);
  if (!greyRow.desc) throw new Error("the grey row does not say why");
  await ui.screenshot(`11-${ENGINE}-grey`);
  await ui.mark({ css: `${menu} .dsm-gray` }, { what: `这个引擎没有的命令出灰行：${greyRow.desc}`, where: "菜单里 Not in … 一组", how: `打 /${GREY}` });
  await ui.press("Escape");
  await clearInput(ui, chatInput);

  // 9. /clear: the line, the messages above stay, the model forgot
  await ui.type("/clear");
  await waitMenu(ui, m => m.rows.some(r => r.name === "/clear" && r.selected), "/clear");
  const beforeClear = (await lastResponse(ui)).index;
  const kept = (await allChatRows(ui)).filter(r => r.request && r.text !== "/clear").map(r => r.text);
  if (!kept.length) throw new Error("no message above /clear to check");
  await ui.press("Enter", { send: true });
  await waitAnswer(ui, /Context cleared/, 60000, "the new clear boundary", beforeClear);
  await waitIdle(ui);
  // The messages above the line stay on screen: every request shown before /clear is still there, above it.
  const rowsAfter = await allChatRows(ui);
  const line = rowsAfter.filter(r => /Context cleared/.test(r.text)).at(-1);
  if (!line) throw new Error("the Context cleared line is not in the chat list");
  const missing = kept.filter(text => !rowsAfter.some(r => r.request && r.index < line.index && r.text === text));
  if (missing.length) throw new Error(`the messages above /clear are gone: ${JSON.stringify(missing)}`);
  await writeFile(`${ui.out}/kept-above-clear.json`, JSON.stringify({ kept, line: line.index }, null, 2));
  await ui.screenshot(`12-${ENGINE}-cleared`);
  await ui.mark({ text: "Context cleared" }, { what: "/clear 只清发给模型的上下文：这条线以上的消息原样留着", where: "对话里 /clear 那一处", how: "/clear ↵" });
  if (NO_MODEL_REQUESTS) {
    const skipped = ENGINE === "codex"
      ? { reason: "Codex quota resets on October 3; no model request sent", checks: ["model answer after clear", "thread/start sessionStartSource=clear after a real model turn"] }
      : { reason: "SLASH_NO_MODEL_REQUESTS=1; local commands only", checks: ["/init or /compact model output", "model answer after clear"] };
    await writeFile(`${ui.out}/not-tested.json`, JSON.stringify(skipped, null, 2));
    return;
  }
  await send(ui, "What word did I ask you to remember? If I did not ask you to remember a word, reply with exactly: NONE. Do not use tools or read files.");
  const answer = await waitAnswer(ui, /\bNONE\b|PELICAN/, 180000, "the answer after /clear");
  await waitIdle(ui);
  await ui.screenshot(`13-${ENGINE}-after-clear`);
  await writeFile(`${ui.out}/after-clear-answer.txt`, answer);
  if (!/\bNONE\b/.test(answer) || /PELICAN/.test(answer)) throw new Error(`after /clear the model still knew: ${answer.slice(0, 300)}`);
}
