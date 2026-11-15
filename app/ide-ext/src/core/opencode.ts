// OpenCode, the third engine: the pure parts of dispatch.opencodeStatus / opencodeAddProvider /
// opencodeInstallPlugin (no vscode import, vitest runs them from app/).

/** `dispatch engines status opencode`: providers, where their keys come from, allowance, the plugin. */
export function opencodeStatusArgs(refresh: unknown): string[] {
  return ["engines", "status", "opencode", "--json", ...(refresh === true ? ["--refresh"] : [])];
}

/** `dispatch engines install-plugin opencode`: Dispatch's plugin into OpenCode's plugins folder. */
export const OPENCODE_INSTALL_PLUGIN_ARGS = ["engines", "install-plugin", "opencode", "--json"];

/** The terminal for `opencode auth login` on macOS and Linux: a shell, so that giving up (Ctrl+C) closes
 *  it quietly instead of VS Code's "terminated with exit code" alert, and a failed login waits for Enter
 *  so its error can be read. On Windows the binary itself. */
export function authLoginTerminal(bin: string, platform: string): { shellPath: string; shellArgs: string[] } {
  if (platform === "win32") return { shellPath: bin, shellArgs: ["auth", "login"] };
  const quoted = `'${bin.replace(/'/g, `'\\''`)}'`;
  return {
    shellPath: "/bin/sh",
    shellArgs: ["-c", `trap 'exit 0' INT; ${quoted} auth login || { printf '\\nPress Enter to close. '; read -r _; }`],
  };
}

/** The binary a terminal runs `auth login` with: the one the CLI found, else OpenCode's usual places. */
export function opencodeBinary(statusPath: unknown, home: string, exists: (p: string) => boolean): string {
  if (typeof statusPath === "string" && statusPath && exists(statusPath)) return statusPath;
  for (const p of [`${home}/.opencode/bin/opencode`, `${home}/.bun/bin/opencode`, "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", `${home}/.local/bin/opencode`]) {
    if (exists(p)) return p;
  }
  return "opencode";
}
