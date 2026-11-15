import { describe, expect, it } from "vitest";
import { landingOptions, validLanding, serverStartFailure } from "../src/core/machineConnection";

describe("remote machine handoff", () => {
  it("accepts only a fresh, bounded one-shot Waiting request", () => {
    const request = { id: "a".repeat(32), land: "waiting", at: 100 };
    expect(validLanding(request, 101)).toBe(true);
    for (const bad of [null, [], { ...request, at: 401 }, { ...request, at: -500 }, { ...request, land: "command:delete" }, { ...request, id: "../../x" }]) {
      expect(validLanding(bad, 101)).toBe(false);
    }
  });
  it("preserves folder opening while adding the peer Waiting landing", () => {
    expect(landingOptions("/Users/apple/project")).toEqual({ dir: "/Users/apple/project" });
    expect(landingOptions({ land: "waiting" })).toEqual({ land: "waiting" });
    expect(landingOptions({ land: "../x", dir: 8 })).toEqual({});
  });
  it("does not report a timed-out server start as ready", () => {
    expect(serverStartFailure(0, "started\n", "")).toBeUndefined();
    expect(serverStartFailure(0, "nogui\n", "")).toBeUndefined();
    expect(serverStartFailure(0, "timeout\n", "")).toBe("timeout");
    expect(serverStartFailure(255, "", "Connection refused\n")).toBe("Connection refused");
  });
});
