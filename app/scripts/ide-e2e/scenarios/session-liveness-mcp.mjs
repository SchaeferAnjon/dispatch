// An MCP server that cannot be reached (dispatch-ide patches/260-session-liveness.patch): the demo project
// gets a remote HTTP server at an address that never answers (http://10.255.255.1:9/mcp, like a school
// VPN hiding mcp.vercel.com), then a Claude Code session is started there. The row says which server
// and how long; after 8 s it says the server is skipped after 20 s and links to Customizations › MCP
// Servers; the session answers once the CLI gave up on it; a line says it went on without it.
// Changes the instance's demo project (a commit adding .mcp.json): run it last, or on a fresh instance.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const meta = { needs: ['claude'],
  title: "MCP 服务器连不上时",
  description: "连不上的 MCP 服务器 20 秒后跳过、会话照常回答；等的时候那行写清是谁、等了几秒，没起来的留一行说明和关掉它的入口。",
};

const tail = (ui, n = 800) => ui.eval(`(document.querySelector('.interactive-list')||document.body).innerText.slice(-${n})`);

export default async function (ui) {
  const demo = ui.demoFolder;
  if (!fs.existsSync(path.join(demo, ".mcp.json"))) fs.writeFileSync(path.join(demo, ".mcp.json"), JSON.stringify({ mcpServers: { "campus-docs": { type: "http", url: "http://10.255.255.1:9/mcp" } } }, null, 2) + "\n");
  execFileSync("git", ["-C", demo, "add", ".mcp.json"]);
  // the person said yes to it, as on Claude Code's first "New MCP server found in .mcp.json" question (a Claude Code
  // folder of its own, a test token's, has not been asked yet); in the project's settings, so a session's own copy has it
  const settings = path.join(demo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const ss = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, "utf8") || "{}") : {};
  ss.enabledMcpjsonServers = [...new Set([...(ss.enabledMcpjsonServers || []), "campus-docs"])];
  fs.writeFileSync(settings, JSON.stringify(ss, null, 2) + "\n");
  execFileSync("git", ["-C", demo, "add", ".claude/settings.json"]);
  try { execFileSync("git", ["-C", demo, "-c", "user.email=e2e@dispatch", "-c", "user.name=e2e", "commit", "-qm", "an MCP server nobody can reach"]); } catch { /* committed by an earlier run */ }
  await ui.openAgents(demo);
  await ui.newSession();
  await ui.pickEngine("Claude Code"); // on Haiku (runner.pickEngine)
  await ui.sleep(3000);
  await ui.click({ css: ".sessions-chat-editor" });
  await ui.type("Reply with exactly: OK");
  await ui.press("Enter", { send: true });

  await ui.sleep(3000);
  await ui.screenshot("05-mcp-sent");
  const t0 = Date.now();
  let sawStarting = false, sawLink = false;
  while (Date.now() - t0 < 90000) {
    const t = await tail(ui);
    if (/Starting MCP server[\s\S]*campus-docs/.test(t) && !sawStarting) {
      sawStarting = true;
      await ui.screenshot("06-mcp-starting");
      // the row goes as soon as the agent answers (Claude Code 2.1.29x no longer waits for its servers before the
      // first message: a few seconds); the screenshot above has it either way
      await ui.mark({ text: "Starting MCP server" }, { what: "哪个 MCP 服务器在拖、已经等了几秒", where: "对话末尾那行", how: "不用猜卡在哪" }).catch(() => undefined);
    }
    if (/Turn it off in MCP Servers/.test(t) && !sawLink) {
      sawLink = true;
      await ui.screenshot("07-mcp-slow");
      await ui.mark({ text: "MCP Servers", exact: true, within: ".chat-mcp-servers-message" }, { what: "20 秒还没起来：写还在启动、等了多久，给关掉它的入口", where: "同一行末尾", how: "点它进 Customizations › MCP Servers" });
    }
    if (/\bOK\b[\s\S]*\d+:\d+/.test(t.split("Reply with exactly: OK").pop() || "")) break;
    await ui.sleep(1000);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.error(`answered after ${elapsed} s; starting row ${sawStarting}, link ${sawLink}`);
  await ui.sleep(2000);
  await ui.screenshot("08-mcp-went-on");
  if (await ui.exists({ text: "did not start" })) {
    await ui.mark({ text: "did not start" }, { what: "超时后留一行：没起来、会话没等它，带关掉它的入口", where: "回答上方", how: "点链接关掉它，下次不再等" });
  }
  // a resumed session knows its servers and shows the Starting row while it waits; a new one only
  // learns them when the agent is up, so there the line after the answer is what tells
  const told = sawStarting || await ui.exists({ text: "did not start" });
  // Claude Code 2.1.29x connects its servers beside the first turn instead of before it, and its thinking shows at once
  // (content, so no Starting row): an answer before the 20 s a dead server is given means nothing waited on it, which
  // is the point (the session is not held up)
  const quick = elapsed < 20;
  fs.writeFileSync(path.join(ui.out, "mcp-facts.json"), JSON.stringify({ elapsed, sawStarting, sawLink, told, quick }, null, 1));
  if (!told && !quick) throw new Error(`neither a Starting MCP servers row nor a did not start line, and the answer took ${elapsed} s`);
  if (elapsed > 45) throw new Error(`the answer took ${elapsed} s (the server should be skipped after 20 s)`);
  if (await ui.exists({ text: "MCP Servers", exact: true, within: ".chat-mcp-servers-message" })) {
    await ui.click({ text: "MCP Servers", exact: true, within: ".chat-mcp-servers-message" });
    await ui.sleep(1500);
    await ui.screenshot("09-mcp-servers-page");
  }
}
