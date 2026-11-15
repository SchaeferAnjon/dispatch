// dispatch.switchAgent: the pure parts (design/copilot-app §8.5 D). The Agents window's harness chip
// hands over the session resource and the harness picked; `dispatch agent switch` wants a session key
// (`claude-code:<id>`, `codex:<id>`, `opencode:<id>`) and `--to claude|codex|opencode`.

const AGENT_OF_PROVIDER: Record<string, string> = { claude: "claude-code", codex: "codex", opencode: "opencode" };

/** `claude:/abc`, `agent-host-claude:/abc`, `vscode-agent-host-claude://x/abc` → `claude-code:abc`;
 *  undefined for a harness `dispatch agent switch` does not know. */
export function sessionKey(resource: string): string | undefined {
  const m = /^([a-z][\w+.-]*):\/*(.*)$/i.exec(resource.trim());
  if (!m) return undefined;
  const provider = m[1].toLowerCase().replace(/^(vscode-)?agent-host-/, "");
  const agent = AGENT_OF_PROVIDER[provider];
  const id = decodeURIComponent(m[2].split(/[?#]/)[0]).split("/").filter(Boolean).pop();
  return agent && id ? `${agent}:${id}` : undefined;
}

/** The session type id the harness chip picked (`claude`, `codex`, `agent-host-opencode`) → `--to`. */
export function switchTarget(sessionTypeId: string): "claude" | "codex" | "opencode" | undefined {
  const t = sessionTypeId.toLowerCase().replace(/^agent-host-/, "");
  return t === "claude" || t === "claude-code" ? "claude" : t === "codex" ? "codex" : t === "opencode" ? "opencode" : undefined;
}

export interface SwitchAnswer {
  first_message: string;
  cwd: string;
  agent: string;
  from: string;
}

/** The folder the new session opens on: the CLI's cwd (the old session's working directory, its
 *  worktree when it had one, so the new Agent sees the uncommitted changes), else the window's. */
export function switchFolder(ans: Pick<SwitchAnswer, "cwd">, windowFolder: string | undefined): string | undefined {
  return ans.cwd || windowFolder || undefined;
}
