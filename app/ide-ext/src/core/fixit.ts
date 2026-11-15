// The arguments of `dispatch fix …` and `dispatch write …` for the Agents window's Changes card
// (Dispatch IDE patches/dispatch-fixit.patch), kept pure so they are tested without VS Code.

export type FixKind = "commit" | "push" | "conflicts" | "checks" | "comments" | "status";
export type WriteKind = "commit-message" | "pr" | "branch" | "walk";

const FIX_KINDS: readonly FixKind[] = ["commit", "push", "conflicts", "checks", "comments", "status"];
const WRITE_KINDS: readonly WriteKind[] = ["commit-message", "pr", "branch", "walk"];

export function isFixKind(v: unknown): v is FixKind {
  return typeof v === "string" && (FIX_KINDS as readonly string[]).includes(v);
}

export function isWriteKind(v: unknown): v is WriteKind {
  return typeof v === "string" && (WRITE_KINDS as readonly string[]).includes(v);
}

/** A local folder from a path or a file: URI string; "" for anything else (a remote session's folder). */
export function folderPath(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  if (v.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(v).pathname);
    } catch {
      return "";
    }
  }
  return v.startsWith("/") ? v : "";
}

export function fixArgs(kind: FixKind, folder: string, opts: { message?: string; base?: string; fresh?: boolean } = {}): string[] {
  const args = ["fix", kind, "--folder", folder, "--json"];
  if (kind === "commit" && opts.message) args.push("--message", opts.message);
  if (kind === "conflicts" && opts.base) args.push("--base", opts.base);
  if (kind === "status" && opts.fresh) args.push("--no-cache");
  return args;
}

/** `fix settled`: whether the failed commit, push or merge the card told about is behind us (task-mrdg). */
export function settledArgs(folder: string, about: unknown, since: unknown, need: unknown): string[] | undefined {
  if (about !== "commit" && about !== "push" && about !== "conflicts") return undefined;
  const args = ["fix", "settled", "--folder", folder, "--about", about, "--json"];
  if (typeof since === "string" && /^[0-9a-f]{4,64}$/.test(since)) args.push("--since", since);
  if (need === "identity") args.push("--need", need);
  return args;
}

/** The agents a commit message can come from as the session's own (`dispatch write --agent`). */
const SESSION_WRITERS = /^(claude|codex|opencode)$/;

export function writeArgs(kind: WriteKind, folder: string, about = "", agent = "", model = ""): string[] {
  const args = ["write", kind, "--json"];
  if (folder) args.push("--folder", folder);
  if (kind === "branch" && about) args.push("--from", about);
  // the session's agent writes its commit message (task-dekzn) and the sentences of Walk me through (task-fktjx),
  // with the session's model, on its own allowance
  if ((kind === "commit-message" || kind === "walk") && SESSION_WRITERS.test(agent)) {
    args.push("--agent", agent);
    if (model && !model.startsWith("-") && model.length < 200) args.push("--model", model);
  }
  return args;
}

/** How long a call may take: writing waits on an agent (a cold start is slow), the rest is git and gh. */
export function timeoutFor(args: string[]): number {
  if (args[0] === "write") return args[1] === "branch" ? 45000 : 150000;
  return args[1] === "status" || args[1] === "checks" || args[1] === "comments" ? 60000 : 30000;
}
