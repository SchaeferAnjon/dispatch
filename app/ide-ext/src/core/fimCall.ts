// One Tab completion request with its cost booked against the day cap (PLAN.md §3.2). Kept apart
// from the VS Code provider so the booking can be tested: the estimate is held while the request
// is out (parallel requests cannot all pass the cap), a request stopped after it went out is
// booked at the estimate (DeepSeek bills it all the same), a full answer at its real usage.
import { Budget } from "./budget";
import { costUsd, estimateUsage, FimRequest, FimUsage, parseFimResponse } from "./fim";

export type FimCallResult =
  | { kind: "ok"; text: string; usage: FimUsage; usd: number }
  | { kind: "over_cap" }
  | { kind: "cancelled" }
  | { kind: "http"; status: number; body: string }
  | { kind: "error"; message: string };

export interface FimCallOptions {
  url: string;
  key: string;
  body: FimRequest["body"];
  budget: Budget;
  /** true once the editor no longer wants this completion */
  cancelled: () => boolean;
  /** subscribe to the cancellation; returns the unsubscribe */
  onCancel: (fn: () => void) => () => void;
  timeoutMs: number;
  /** one ledger line (tab-usage.jsonl) and the budget's own count */
  record: (rec: FimUsage & { usd: number; estimated?: boolean }) => void;
  fetchImpl?: typeof fetch;
}

export async function fimCall(o: FimCallOptions): Promise<FimCallResult> {
  const est = estimateUsage(o.body);
  const estUsd = costUsd(est, o.budget.prices());
  if (!o.budget.reserve(estUsd)) return { kind: "over_cap" };
  const ac = new AbortController();
  const off = o.onCancel(() => ac.abort());
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  let gotBody = false;
  let booked = false;
  try {
    if (o.cancelled()) return { kind: "cancelled" }; // never went out
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.key}` },
      body: JSON.stringify(o.body),
      signal: ac.signal,
    });
    const text = await res.text();
    gotBody = true;
    if (!res.ok) return { kind: "http", status: res.status, body: text };
    const { text: raw, usage } = parseFimResponse(JSON.parse(text));
    const usd = costUsd(usage, o.budget.prices());
    o.record({ ...usage, usd });
    booked = true;
    return { kind: "ok", text: raw, usage, usd };
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    if (!booked && (aborted || gotBody)) o.record({ ...est, usd: estUsd, estimated: true });
    return aborted ? { kind: "cancelled" } : { kind: "error", message: (e as Error).message };
  } finally {
    o.budget.release(estUsd);
    clearTimeout(timer);
    off();
  }
}
