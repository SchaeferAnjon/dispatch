// The Thinking Level menu under a Claude Code new session (task-tpnwq): only its options (no prompt-cache banner), the
// check and the highlight on the same option when it opens, and a level picked earlier reads "Last picked" next to the
// model's "Default". Sends nothing: the menu is opened, read and closed; the level is put back to the default at the end.
export const meta = {
  title: "Thinking Level menu",
  description: "Claude Code new session: open the level menu, pick Medium, open again, put High back",
  needs: ["internet"],
  timeout: 240,
};

const MENU = `(() => {
  const w = [...document.querySelectorAll('.action-widget')].filter(e => e.getBoundingClientRect().height > 0).pop();
  if (!w) return null;
  return {
    text: w.innerText.replace(/\\s+/g, ' '),
    rows: [...w.querySelectorAll('.monaco-list-row.chat-model-picker-config-option')].map(r => ({
      text: r.innerText.replace(/\\s+/g, ' ').trim(),
      checked: !!r.querySelector('.codicon-check'),
      focused: r.classList.contains('focused'),
    })),
  };
})()`;

const CHIP = { css: ".model-picker-split .model-picker-config" };

async function readMenu(ui) {
  await ui.click(CHIP);
  await ui.waitFor({ css: ".action-widget .chat-model-picker-config-option" });
  const menu = await ui.eval(MENU);
  if (!menu) {
    throw new Error("the Thinking Level menu did not open");
  }
  if (/prompt cache|Learn more/.test(menu.text)) {
    throw new Error(`the menu shows a banner above its options: ${menu.text}`);
  }
  const checked = menu.rows.filter(r => r.checked);
  const focused = menu.rows.filter(r => r.focused);
  if (checked.length !== 1 || focused.length !== 1 || checked[0].text !== focused[0].text) {
    throw new Error(`check and highlight differ when the menu opens: ${JSON.stringify(menu.rows)}`);
  }
  return menu;
}

async function pick(ui, label) {
  await ui.click({ text: label, within: ".action-widget" });
  await ui.press("Escape");
}

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);
  await ui.newSession(ui.demoFolder);
  if (await ui.exists({ text: "Download", exact: true })) {
    await ui.click({ text: "Download", exact: true });
  }
  await ui.waitFor(CHIP, { timeoutMs: 180000 });

  const fresh = await readMenu(ui);
  await ui.screenshot("effort-menu-new-session");
  const high = fresh.rows.find(r => r.text.startsWith("High"));
  if (!high || high.text !== "High Default" || !high.checked) {
    throw new Error(`a new session should start on High, the default: ${JSON.stringify(fresh.rows)}`);
  }
  await pick(ui, "Medium");

  const picked = await readMenu(ui);
  await ui.screenshot("effort-menu-last-picked");
  const texts = picked.rows.map(r => r.text);
  if (!texts.includes("Medium Last picked") || !texts.includes("High Default") || !picked.rows.find(r => r.text === "Medium Last picked").checked) {
    throw new Error(`a level picked earlier should say Last picked next to the Default: ${JSON.stringify(picked.rows)}`);
  }
  await pick(ui, "High");

  const back = await readMenu(ui);
  if (back.rows.some(r => r.text.includes("Last picked")) || !back.rows.find(r => r.text === "High Default").checked) {
    throw new Error(`back on the default nothing says Last picked: ${JSON.stringify(back.rows)}`);
  }
  await ui.press("Escape");
}
