import * as vscode from "vscode";
import { rootFor, runJson } from "./cli";
import { builtinToolsArgs } from "./core/builtinTools";
import { mcpAddArgs } from "./core/mcpAdd";

interface McpServer { name: string; engine: string; scope: string; transport: string; command: string; args: string[]; url: string; env: string[]; headers: string[] }

/** Data and mutations for Dispatch's additions to the native Customizations pages. */
/** An engine's id or session prefix ("claude", "claude-code", "default"): which ones exist is the CLI's business (its engine
 *  registry refuses the rest), so a new engine needs no change here. */
export function isEngine(value: unknown): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value);
}

/** The ops that only read. */
const READS = new Set(["list", "mcp", "plugins", "neat", "builtins", "brief"]);
const reading = new Map<string, Promise<unknown>>();

export function registerCustomizations(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.commands.registerCommand("dispatch.customizations", async (op: unknown, input: unknown) => {
    const data = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    try {
      let args: string[];
      switch (op) {
        case "brief":
          args = ["customizations", "brief", "--json"];
          break;
        case "skill":
        case "adopt":
          if (typeof data.name !== "string" || !data.name || data.name.startsWith("-") || /[\\/\0]/.test(data.name)) throw new Error("Invalid skill.");
          if (op === "adopt") {
            args = ["customizations", "adopt", data.name, "--json"];
          } else {
            if (!isEngine(data.agent) || typeof data.enabled !== "boolean") throw new Error("Invalid skill change.");
            args = ["customizations", data.enabled ? "skill-on" : "skill-off", data.name, "--agent", String(data.agent), "--json"];
          }
          break;
        case "hook":
          if (!["prime", "presence", "plan", "edit-guard"].includes(String(data.group)) || !isEngine(data.agent) || typeof data.enabled !== "boolean") throw new Error("Invalid hook change.");
          args = ["hooks", data.enabled ? "on" : "off", String(data.group), "--agent", String(data.agent), "--json"];
          break;
        case "undo":
          if (typeof data.id !== "string" || !/^[a-z]+-[a-f0-9]{20}$/.test(data.id)) throw new Error("Invalid import.");
          args = ["imports", "undo", data.id, "--json"];
          break;
        case "sync":
          // The stock rules command operates on machine-wide paths. The disposable
          // profile has its own rules command so acceptance never edits real files.
          args = ["customizations", "sync", "--json"];
          break;
        case "mcp":
          args = ["mcp", "list", "--json"];
          break;
        case "mcp-copy": {
          // Copy a server from the agent it is configured in to another, in that agent's own format.
          const name = String(data.name ?? "");
          if (!/^[A-Za-z0-9_-]+$/.test(name) || !isEngine(data.from) || !isEngine(data.to) || data.from === data.to) throw new Error("Invalid MCP server copy.");
          const listed = await runJson<{ servers?: McpServer[] }>(["mcp", "list", "--json"], { timeoutMs: 30000, cwd: rootFor() });
          const server = (listed.servers ?? []).find(s => s.name === name && s.engine === data.from && s.scope === "user");
          if (!server) throw new Error(`${name} is no longer configured there. Refresh the list.`);
          if (server.env.length || server.headers.length) {
            // secret values are copied by the CLI from the source file, never through this window
            args = ["mcp", "add", name, "--from", String(data.from), "--engine", String(data.to), "--json"];
          } else if (server.url) {
            args = ["mcp", "add", name, "--url", server.url, ...(server.transport === "sse" ? ["--transport", "sse"] : []), "--engine", String(data.to), "--json"];
          } else {
            args = ["mcp", "add", name, "--engine", String(data.to), "--json", "--", server.command, ...server.args];
          }
          break;
        }
        case "mcp-add":
          // Settings › MCP servers › Add: a new server, by its address or its command, in the agents picked
          args = mcpAddArgs(data);
          break;
        case "mcp-remove": {
          const name = String(data.name ?? "");
          if (!/^[A-Za-z0-9_-]+$/.test(name) || !isEngine(data.engine)) throw new Error("Invalid MCP server.");
          args = ["mcp", "remove", name, "--engine", String(data.engine), "--json"];
          break;
        }
        case "mcp-builtin":
          // Settings › MCP servers: Dispatch's own tool server on or off in every agent (task-lj06.23)
          args = builtinToolsArgs(data);
          break;
        case "plugins":
          args = ["plugins", "list", "--json"];
          break;
        case "neat":
          // Settings › Agents › Tidy up after work: the mode, the agent it runs with, the last run (cli/neat_auto.py)
          args = ["neat", "status", "--json"];
          break;
        case "neat-set": {
          const mode = data.auto === undefined ? "" : String(data.auto);
          const engine = data.engine === undefined ? undefined : String(data.engine);
          if (mode && !["off", "task", "daily"].includes(mode)) throw new Error("Invalid tidy-up setting.");
          if (engine !== undefined && !isEngine(engine)) throw new Error("Invalid agent.");
          args = ["neat", "auto", ...(mode ? [mode] : []), ...(engine !== undefined ? ["--engine", engine] : []), "--json"];
          break;
        }
        case "builtins":
          // Settings › Soul: what Dispatch puts into every agent (agent_builtins.py)
          args = ["builtins", "--json"];
          break;
        case "builtin-agent":
          // Settings › Soul: one of the helper agents that come with Dispatch on or off (builtin_agents.py)
          if (typeof data.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.name) || typeof data.enabled !== "boolean") throw new Error("Invalid agent change.");
          args = ["builtin-agents", data.enabled ? "on" : "off", data.name, "--json"];
          break;
        case "plugin":
          if (typeof data.name !== "string" || !/^[\w.-]+@[\w.-]+$/.test(data.name) || typeof data.enabled !== "boolean") throw new Error("Invalid plugin change.");
          args = ["plugins", data.enabled ? "on" : "off", data.name, "--json"];
          break;
        case "list":
        case undefined:
          args = ["customizations", "list", "--json"];
          break;
        default:
          throw new Error("Unknown customization action.");
      }
      // a read asked for while the same one runs shares it: a Settings page with several parts asked up to four
      // times at once, a Python each (design/settings-fast)
      if (READS.has(String(op ?? "list"))) {
        const key = args.join("\u0000");
        let p = reading.get(key);
        if (!p) {
          p = runJson(args, { timeoutMs: 30000, cwd: rootFor() }).finally(() => reading.delete(key));
          reading.set(key, p);
        }
        return { ok: true, result: await p };
      }
      const result = await runJson(args, { timeoutMs: 30000, cwd: rootFor() });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: readableError((e as Error).message) };
    }
  }));
}

/** A CLI usage dump reads as its last line ("unrecognized arguments: …"), not the whole command list. */
export function readableError(message: string): string {
  const m = /(?:^|\s)dispatch(?: [\w-]+)*: error: (.+)$/s.exec(message);
  if (!m) return message;
  const reason = m[1].trim();
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}
