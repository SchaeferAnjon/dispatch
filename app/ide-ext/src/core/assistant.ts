// dispatch.assistant: the pure part. The first suggestions on a new chat's page (Dispatch IDE dispatchFirstPrompts.ts;
// the Mac's Assistant row and page went 2026-11-11, task-0v1o9) ask the bridge for `dispatch assistant`; only this
// argument shape reaches the CLI.

/** `dispatch assistant`: the first-page suggestions and whether the Assistant was ever talked to (`fresh`). The
 *  window's question leaves out the Agents window's catalog (`--quick`): a busy Mac took 20 s over it, and nothing
 *  the window shows comes from it. */
export function assistantArgs(op: unknown, _arg?: unknown): string[] | undefined {
  if (op === undefined || op === "status") return ["assistant", "--json", "--quick"];
  return undefined;
}

export interface IAnswerCache {
  /** The cache's freshness window (ms): inside it the last answer is the answer. */
  readonly freshMs: number;
  /** How long an older answer waits for its refresh before the older one is given (ms). */
  readonly waitMs: number;
  readonly now?: () => number;
}

/**
 * Stale while revalidate, for a question a busy Mac answers slowly: the last good answer inside `freshMs` is given as it
 * is; an older one is given after at most `waitMs` while a fresh one is asked for in the background (one question at a
 * time); with no answer yet the caller waits for the first one, and a failure reaches it. A failed refresh keeps the
 * older answer for the next call.
 */
export function answerCache<T>(ask: () => Promise<T>, o: IAnswerCache): () => Promise<T> {
  const now = o.now ?? Date.now;
  let last: { value: T; at: number } | undefined;
  let running: Promise<T> | undefined;
  const refresh = (): Promise<T> => {
    running ??= ask().then(
      (value) => { last = { value, at: now() }; running = undefined; return value; },
      (error) => { running = undefined; throw error; },
    );
    return running;
  };
  return () => {
    if (last && now() - last.at < o.freshMs) return Promise.resolve(last.value);
    const p = refresh();
    if (!last) return p;
    const old = last.value;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(old), o.waitMs);
      p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(old); });
    });
  };
}

/** Run `ask`; when it timed out (the CLI was killed at its limit), once more: the second run finds the CLI's files in the Mac's cache. */
export async function retryTimeout<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (e) {
    if ((e as { code?: unknown } | undefined)?.code !== "timeout") throw e;
    return ask();
  }
}
