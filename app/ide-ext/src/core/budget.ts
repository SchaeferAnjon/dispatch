// The Tab completion day budget: what `dispatch ide usage today` said plus what this window spent since.
import { DEFAULT_PRICES, TabPrices } from "./fim";

export interface UsageToday {
  date: string;
  count: number;
  usd: number;
  cap_usd: number;
  over_cap: boolean;
  enabled: boolean;
  model: string;
  prices?: TabPrices;
}

export type TabState = "off" | "no_key" | "over_cap" | "on";

export class Budget {
  private base: UsageToday | undefined;
  private local = 0;
  private localCount = 0;
  /** estimates of the requests out right now (see estimateUsage) */
  private reserved = 0;

  /** A fresh `usage today` answer; it already counts every line written to tab-usage.jsonl. */
  setToday(t: UsageToday) {
    this.base = t;
    this.local = 0;
    this.localCount = 0;
  }

  /** A setting just changed here: use it now, before the CLI (which can take seconds to save) answers. */
  patch(p: Partial<Pick<UsageToday, "enabled" | "cap_usd">>) {
    if (this.base) this.base = { ...this.base, ...p };
  }

  get today(): UsageToday | undefined {
    return this.base;
  }

  /** One request's cost, recorded by this window after the last `setToday`. */
  add(usd: number) {
    this.local += usd;
    this.localCount += 1;
  }

  /** Stale when the calendar day moved on since the answer (the cap starts over at midnight). */
  stale(todayIso: string): boolean {
    return !this.base || this.base.date !== todayIso;
  }

  spent(): number {
    return (this.base?.usd || 0) + this.local;
  }

  /** Hold `usd` against the cap while a request is out; false (nothing held) when it would go past
   *  the cap together with what is spent and already held. Undo with release(usd). */
  reserve(usd: number): boolean {
    const cap = this.cap();
    if (cap > 0 && this.spent() + this.reserved + usd > cap) return false;
    this.reserved += usd;
    return true;
  }

  release(usd: number) {
    this.reserved = Math.max(0, this.reserved - usd);
  }

  held(): number {
    return this.reserved;
  }

  count(): number {
    return (this.base?.count || 0) + this.localCount;
  }

  cap(): number {
    return this.base?.cap_usd ?? 0.5;
  }

  overCap(): boolean {
    const cap = this.cap();
    return cap > 0 && this.spent() >= cap;
  }

  prices(): TabPrices {
    return this.base?.prices || DEFAULT_PRICES;
  }

  model(): string {
    return this.base?.model || "deepseek-flash";
  }

  state(hasKey: boolean): TabState {
    if (!this.base?.enabled) return "off";
    if (!hasKey) return "no_key";
    if (this.overCap()) return "over_cap";
    return "on";
  }
}

/** "$0.03", "$0.0004", "<$0.0001": two decimals once it is a cent or more, otherwise enough to see it move. */
export function money(usd: number): string {
  if (usd >= 0.01 || usd <= 0) return "$" + Math.max(0, usd).toFixed(2);
  if (usd < 0.0001) return "<$0.0001";
  return "$" + usd.toFixed(4);
}

export function localDayIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
