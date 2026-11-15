import { describe, expect, it } from "vitest";
import { soulRequest } from "../src/core/soul";

describe("dispatch.soul requests", () => {
  it("reads the Soul in use", () => {
    expect(soulRequest(undefined)).toEqual({ args: ["soul", "show", "--json"] });
    expect(soulRequest("show")).toEqual({ args: ["soul", "show", "--json"] });
  });

  it("saves new text through standard input", () => {
    expect(soulRequest("save", "# Soul\n- one line\n")).toEqual({ args: ["soul", "edit", "--json"], input: "# Soul\n- one line\n" });
  });

  it("resets and switches", () => {
    expect(soulRequest("reset")?.args).toEqual(["soul", "reset", "--json"]);
    expect(soulRequest("on")?.args).toEqual(["soul", "on", "--json"]);
    expect(soulRequest("off")?.args).toEqual(["soul", "off", "--json"]);
  });

  it("refuses empty text and anything else", () => {
    expect(soulRequest("save", "  \n")).toBeUndefined();
    expect(soulRequest("save", 3)).toBeUndefined();
    expect(soulRequest("save", "x".repeat(200_001))).toBeUndefined();
    expect(soulRequest("rm")).toBeUndefined();
  });
});
