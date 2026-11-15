import { describe, expect, it } from "vitest";
import { busyArgs } from "../src/core/busy";

describe("dispatch.busy", () => {
  it("asks the CLI whether the Mac is busy, or puts idle agents to sleep", () => {
    expect(busyArgs(undefined)).toEqual(["busy", "--json"]);
    expect(busyArgs("status")).toEqual(["busy", "--json"]);
    expect(busyArgs("sleep")).toEqual(["sleep", "now", "--json"]);
  });
  it("refuses anything else", () => {
    expect(busyArgs("rm")).toBeUndefined();
    expect(busyArgs(["busy"])).toBeUndefined();
  });
});
