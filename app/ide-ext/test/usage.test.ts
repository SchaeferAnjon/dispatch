import { describe, expect, it } from "vitest";
import { usageArgs } from "../src/core/usage";

describe("usage", () => {
  it("reads the page and records a reading", () => {
    expect(usageArgs(undefined)).toEqual(["usage", "--json"]);
    expect(usageArgs("page", 90)).toEqual(["usage", "--days", "90", "--json"]);
    expect(usageArgs("record")).toEqual(["usage", "--record", "--json"]);
  });
  it("refuses anything else", () => {
    expect(usageArgs("page", "90")).toBeUndefined();
    expect(usageArgs("page", 3)).toBeUndefined();
    expect(usageArgs("page", 1.5)).toBeUndefined();
    expect(usageArgs("delete")).toBeUndefined();
  });
});

