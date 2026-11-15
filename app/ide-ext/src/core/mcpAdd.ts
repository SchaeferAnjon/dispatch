/** Settings › MCP servers › Add: the `dispatch mcp add` arguments for a name, a URL or a command, and the agents to add it to. */

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENGINE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * `target` is a web address (a remote server) or a command line (a local one, split on spaces; nothing runs
 * through a shell). The CLI writes each agent's own file and keeps the old one as a backup.
 */
export function mcpAddArgs(data: Record<string, unknown>): string[] {
  const name = String(data.name ?? "").trim();
  if (!NAME.test(name)) throw new Error("Give it a name: letters, digits, - and _.");
  const engines = Array.isArray(data.engines) ? data.engines.filter((e): e is string => typeof e === "string") : [];
  if (!engines.length || !engines.every(e => ENGINE.test(e))) throw new Error("Pick at least one agent to add it to.");
  const target = String(data.target ?? "").trim();
  const head = ["mcp", "add", name, "--engine", engines.join(","), "--json"];
  if (/^https?:\/\/\S+$/i.test(target)) return [...head, "--url", target];
  const words = target.split(/\s+/).filter(Boolean);
  if (!words.length || /^https?:/i.test(words[0]) || words[0].startsWith("-")) throw new Error("Paste the server's web address (https://…) or the command that starts it.");
  return [...head, "--", ...words];
}
