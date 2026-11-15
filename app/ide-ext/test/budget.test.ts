import { describe, expect, it } from "vitest";
import { Budget, localDayIso, money } from "../src/core/budget";

const today = (over: Partial<Parameters<Budget["setToday"]>[0]> = {}) => ({
  date: "2026-09-25", count: 3, usd: 0.1, cap_usd: 0.5, over_cap: false, enabled: true, model: "deepseek-flash", ...over,
});

describe("Tab budget", () => {
  it("holds requests in flight against the cap, so parallel ones cannot all pass", () => {
    const b = new Budget();
    b.setToday(today({ usd: 0.4995, cap_usd: 0.5 }));
    expect(b.reserve(0.0003)).toBe(true);
    expect(b.reserve(0.0003)).toBe(false); // together past the cap: the second never goes out
    expect(b.held()).toBeCloseTo(0.0003);
    b.release(0.0003);
    expect(b.held()).toBe(0);
    expect(b.reserve(0.0003)).toBe(true);
    // no cap: anything goes
    b.setToday(today({ cap_usd: 0, usd: 99 }));
    expect(b.reserve(5)).toBe(true);
  });

  it("adds this window's spend to the ledger and stops at the cap", () => {
    const b = new Budget();
    expect(b.state(true)).toBe("off");
    b.setToday(today());
    expect(b.state(true)).toBe("on");
    expect(b.state(false)).toBe("no_key");
    b.add(0.3);
    expect(b.spent()).toBeCloseTo(0.4);
    expect(b.count()).toBe(4);
    expect(b.overCap()).toBe(false);
    b.add(0.1);
    expect(b.overCap()).toBe(true);
    expect(b.state(true)).toBe("over_cap");
    // a fresh answer from the CLI already includes what was written: the local part starts over
    b.setToday(today({ usd: 0.2 }));
    expect(b.spent()).toBeCloseTo(0.2);
  });

  it("treats a cap of 0 as no cap and a new day as stale", () => {
    const b = new Budget();
    b.setToday(today({ cap_usd: 0, usd: 99 }));
    expect(b.overCap()).toBe(false);
    expect(b.stale("2026-09-25")).toBe(false);
    expect(b.stale("2026-09-26")).toBe(true);
    b.setToday(today({ cap_usd: 0.0001, usd: 0.0001 }));
    expect(b.overCap()).toBe(true);
  });

  it("applies a setting changed here before the CLI answers", () => {
    const b = new Budget();
    b.patch({ cap_usd: 1 });
    expect(b.today).toBeUndefined();
    b.setToday(today({ usd: 0.2 }));
    b.patch({ cap_usd: 0.1 });
    expect(b.state(true)).toBe("over_cap");
    b.patch({ enabled: false });
    expect(b.state(true)).toBe("off");
  });

  it("formats money and days", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.034)).toBe("$0.03");
    expect(money(0.00051)).toBe("$0.0005");
    expect(money(0.0000129)).toBe("<$0.0001");
    expect(localDayIso(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
