import { describe, expect, it } from "vitest";
import { firstRunArgs } from "../src/core/firstRun";

describe("dispatch.firstRun arguments", () => {
  it("reads and sets how much agents may do on their own", () => {
    expect(firstRunArgs("autonomy")).toEqual(["autonomy", "--json"]);
    expect(firstRunArgs("autonomy-set", { level: "ask-risky" })).toEqual(["autonomy", "set", "ask-risky", "--json"]);
    expect(firstRunArgs("autonomy-set", { level: "yolo" })).toBeUndefined();
    expect(firstRunArgs("autonomy-set", { level: "auto; rm" })).toBeUndefined();
    expect(firstRunArgs("autonomy-set")).toBeUndefined();
  });

  it("switches keeping the Mac awake and notifications on or off", () => {
    expect(firstRunArgs("awake")).toEqual(["awake", "--json"]);
    expect(firstRunArgs("awake-set", { on: false })).toEqual(["settings", "keep_awake", "0", "--json"]);
    expect(firstRunArgs("notify-set", { on: true })).toEqual(["settings", "notify_desktop", "1", "--json"]);
    expect(firstRunArgs("notify-set", { on: "yes" })).toBeUndefined();
    expect(firstRunArgs("awake-set", {})).toBeUndefined();
  });

  it("sends a test banner and opens System Settings", () => {
    expect(firstRunArgs("notify-test")).toEqual(["first-run", "notify-test", "--json"]);
    expect(firstRunArgs("notify-open")).toEqual(["first-run", "notify-settings", "--json"]);
    expect(firstRunArgs("state")).toEqual(["settings", "--json"]);
  });

  it("reads and saves the name and email on commits (task-pog4t)", () => {
    expect(firstRunArgs("git-identity")).toEqual(["git-identity", "show", "--json"]);
    expect(firstRunArgs("git-identity-set", { name: " Ada Lovelace ", email: "ada@lovelace.dev" }))
      .toEqual(["git-identity", "set", "--name", "Ada Lovelace", "--email", "ada@lovelace.dev", "--json"]);
    expect(firstRunArgs("git-identity-set", { name: "Ada", email: "no-at-sign" })).toBeUndefined();
    expect(firstRunArgs("git-identity-set", { name: "--global", email: "a@b.co" })).toBeUndefined();
    expect(firstRunArgs("git-identity-set", { name: "Ada <x>", email: "a@b.co" })).toBeUndefined();
    expect(firstRunArgs("git-identity-set", { name: "", email: "a@b.co" })).toBeUndefined();
  });

  it("refuses anything else", () => {
    expect(firstRunArgs("rm")).toBeUndefined();
    expect(firstRunArgs(undefined)).toBeUndefined();
  });
});
