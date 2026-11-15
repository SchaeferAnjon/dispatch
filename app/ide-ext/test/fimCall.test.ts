import { describe, expect, it } from "vitest";
import { Budget } from "../src/core/budget";
import { buildFimRequest } from "../src/core/fim";
import { fimCall, FimCallOptions } from "../src/core/fimCall";

const today = (usd = 0, cap = 0.5) => ({ date: "2026-09-26", count: 0, usd, cap_usd: cap, over_cap: false, enabled: true, model: "deepseek-flash" });
const body = buildFimRequest({ relPath: "a.py", languageId: "python", text: "def f(x):\n    return x\n".repeat(100), offset: 900 }, "deepseek-flash").body;
const answer = JSON.stringify({ choices: [{ text: "x + 1" }], usage: { prompt_tokens: 300, completion_tokens: 5, prompt_cache_hit_tokens: 0 } });

/** A cancellation the test fires by hand, like VS Code's token on the next keystroke. */
function token() {
  let cancelled = false;
  const subs: (() => void)[] = [];
  return {
    cancel: () => {
      cancelled = true;
      subs.splice(0).forEach((f) => f());
    },
    cancelled: () => cancelled,
    onCancel: (f: () => void) => {
      subs.push(f);
      return () => void 0;
    },
  };
}

/** A fetch that waits for `release()` (or the abort) before answering. */
function slowFetch() {
  let release: () => void = () => {};
  const sent: string[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      sent.push(String(init.body));
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      release = () => resolve(new Response(answer, { status: 200 }));
    })) as unknown as typeof fetch;
  return { fetchImpl, sent, release: () => release() };
}

function call(b: Budget, t: ReturnType<typeof token>, fetchImpl: typeof fetch, records: unknown[]): Promise<Awaited<ReturnType<typeof fimCall>>> {
  const o: FimCallOptions = { url: "http://x", key: "k", body, budget: b, cancelled: t.cancelled, onCancel: t.onCancel, timeoutMs: 5000, record: (r) => (records.push(r), b.add(r.usd)), fetchImpl };
  return fimCall(o);
}

describe("fimCall", () => {
  it("books a request aborted after it went out at the estimate", async () => {
    const b = new Budget();
    b.setToday(today());
    const t = token();
    const f = slowFetch();
    const records: { usd: number; estimated?: boolean }[] = [];
    const p = call(b, t, f.fetchImpl, records);
    await Promise.resolve();
    expect(f.sent.length).toBe(1);
    t.cancel(); // the next keystroke
    expect((await p).kind).toBe("cancelled");
    expect(records.length).toBe(1);
    expect(records[0].estimated).toBe(true);
    expect(records[0].usd).toBeGreaterThan(0);
    expect(b.spent()).toBeCloseTo(records[0].usd);
    expect(b.held()).toBe(0);
  });

  it("books a full answer at its real usage", async () => {
    const b = new Budget();
    b.setToday(today());
    const f = slowFetch();
    const records: { usd: number; estimated?: boolean }[] = [];
    const p = call(b, token(), f.fetchImpl, records);
    await Promise.resolve();
    f.release();
    const r = await p;
    expect(r.kind).toBe("ok");
    expect(records.length).toBe(1);
    expect(records[0].estimated).toBeUndefined();
    expect(b.held()).toBe(0);
  });

  it("does not let requests in flight together pass the cap", async () => {
    const b = new Budget();
    b.setToday(today(0.4995, 0.5));
    const f = slowFetch();
    const records: unknown[] = [];
    const first = call(b, token(), f.fetchImpl, records);
    const second = await call(b, token(), f.fetchImpl, records);
    expect(second.kind).toBe("over_cap");
    expect(f.sent.length).toBe(1);
    f.release();
    expect((await first).kind).toBe("ok");
  });

  it("books nothing for a request that never went out or was refused", async () => {
    const b = new Budget();
    b.setToday(today());
    const t = token();
    t.cancel();
    const records: unknown[] = [];
    const f = slowFetch();
    expect((await call(b, t, f.fetchImpl, records)).kind).toBe("cancelled");
    const refused = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    expect((await call(b, token(), refused, records)).kind).toBe("http");
    expect(records).toEqual([]);
    expect(f.sent.length).toBe(0);
  });
});
