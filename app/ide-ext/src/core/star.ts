// dispatch-bridge's GitHub star question, the pure part (src/star.ts asks; kanban app/cli/star.py decides when).

export const STAR_TEXT = {
  message: "Has Dispatch been useful? A star on GitHub helps other people find it. This is the only time we ask.",
  star: "Star on GitHub",
  later: "Not now",
} as const;

export interface StarState {
  readonly due: boolean;
  readonly url: string;
}

const REPO_URL = "https://github.com/SchaeferAnjon/dispatch";

/** `dispatch star check --json`: due only when the CLI says so, and only ever for the project's own page. */
export function starState(r: unknown): StarState {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const url = typeof o.url === "string" && o.url.startsWith(REPO_URL) ? o.url : REPO_URL;
  return { due: o.due === true, url };
}

/** What the person did with the notification: its button, or it was closed (counts as later). */
export function starAction(picked: string | undefined): "open" | "later" {
  return picked === STAR_TEXT.star ? "open" : "later";
}
