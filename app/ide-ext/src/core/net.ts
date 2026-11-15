// Pure helpers for dispatch.net (no vscode import, vitest runs them from app/): the network the engines use
// (app/cli/net.py). `status` is the report the setup wizard, the new-session notice and Settings > Network read;
// `refresh` asks the servers again; `env` is the proxy as variables; `set` saves the proxy or the download source.

const PROXY_WORD = /^(auto|off)$/;
const ADDRESS = /^(https?|socks4a?|socks5h?|file):\/\/[^\s'"`;|&<>]{1,300}$/;
const HOST_PORT = /^[A-Za-z0-9.\-[\]:]{1,200}:\d{1,5}$/;
const MIRROR = /^(auto|official|china)$/;

/** The CLI arguments for a request, or undefined when it is not one Dispatch makes. */
export function netArgs(op: unknown, what?: unknown, value?: unknown): string[] | undefined {
  if (op === undefined || op === "status") return ["net", "status", "--json"];
  if (op === "refresh") return ["net", "status", "--refresh", "--json"];
  if (op === "env") return ["net", "env", "--json"];
  if (op !== "set" || typeof value !== "string") return undefined;
  const v = value.trim();
  if (what === "proxy" && (PROXY_WORD.test(v) || ADDRESS.test(v) || HOST_PORT.test(v))) return ["net", "set", "proxy", v, "--json"];
  if (what === "mirror" && MIRROR.test(v)) return ["net", "set", "mirror", v, "--json"];
  return undefined;
}
