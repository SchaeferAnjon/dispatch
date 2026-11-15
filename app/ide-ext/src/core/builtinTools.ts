/** Settings › MCP servers: Dispatch's own tool server (the board's tools for every agent) on or off. */

/** `dispatch mcp on|off`: in every agent, or in none and kept out (task-lj06.23). */
export function builtinToolsArgs(data: Record<string, unknown>): string[] {
  if (typeof data.enabled !== "boolean") throw new Error("Invalid change.");
  return ["mcp", data.enabled ? "on" : "off", "--json"];
}
