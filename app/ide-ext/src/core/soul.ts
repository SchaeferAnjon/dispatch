// Pure helpers for dispatch.soul (no vscode import, vitest runs them from app/): Settings › Soul reads and changes
// how every agent talks and works (app/cli/soul.py). Every change ends with `dispatch rules sync` in the CLI.

/** What `dispatch soul … --json` answers. */
export interface SoulState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly path: string;
  readonly on: boolean;
  readonly content: string;
  readonly default: string;
  readonly customized: boolean;
  readonly changed?: boolean;
}

export type SoulRequest = { args: string[]; input?: string };

/** The CLI call for a request, or undefined when it is not one Settings makes. */
export function soulRequest(op: unknown, text?: unknown): SoulRequest | undefined {
  if (op === undefined || op === "show") return { args: ["soul", "show", "--json"] };
  if (op === "reset" || op === "on" || op === "off") return { args: ["soul", op, "--json"] };
  if (op === "save" && typeof text === "string" && text.trim() && text.length <= 200_000) return { args: ["soul", "edit", "--json"], input: text };
  return undefined;
}
