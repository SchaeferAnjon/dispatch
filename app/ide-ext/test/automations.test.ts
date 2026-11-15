import { describe, expect, it } from "vitest";
import { automationsArgs } from "../src/core/automations";

describe("automations", () => {
  it("reads this Mac and the others", () => {
    expect(automationsArgs(undefined)).toEqual(["automations", "discover", "--json"]);
    expect(automationsArgs("here")).toEqual(["automations", "discover", "--json"]);
    expect(automationsArgs("others")).toEqual(["automations", "discover", "--remote", "--json"]);
    expect(automationsArgs("fresh")).toEqual(["automations", "discover", "--remote", "--fresh", "--json"]);
  });
  it("refuses anything else", () => {
    expect(automationsArgs("delete")).toBeUndefined();
    expect(automationsArgs(1)).toBeUndefined();
  });
});
