import { describe, expect, it } from "vitest";
import { builtinToolsArgs } from "../src/core/builtinTools";

describe("Dispatch's own tool server switch (task-lj06.23)", () => {
  it("turns it on or off in every agent", () => {
    expect(builtinToolsArgs({ enabled: true })).toEqual(["mcp", "on", "--json"]);
    expect(builtinToolsArgs({ enabled: false })).toEqual(["mcp", "off", "--json"]);
  });

  it("takes nothing but a yes or no", () => {
    expect(() => builtinToolsArgs({ enabled: "off" })).toThrow();
    expect(() => builtinToolsArgs({})).toThrow();
  });
});
