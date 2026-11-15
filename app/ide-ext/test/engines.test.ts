import { describe, expect, it } from "vitest";
import { enginesArgs } from "../src/core/engines";

describe("dispatch.engines arguments", () => {
  it("lists all engines or one", () => {
    expect(enginesArgs(undefined, undefined)).toEqual(["engines", "list", "--json"]);
    expect(enginesArgs("list", "codex")).toEqual(["engines", "list", "codex", "--json"]);
    expect(enginesArgs("refresh", "claude")).toEqual(["engines", "list", "claude", "--refresh", "--json"]);
  });

  it("checks installed versions without asking npm", () => {
    expect(enginesArgs("check", "opencode")).toEqual(["engines", "list", "opencode", "--offline", "--json"]);
    expect(enginesArgs("check", "nope")).toEqual(["engines", "list", "--offline", "--json"]);
  });

  it("upgrades only a known engine", () => {
    expect(enginesArgs("upgrade", "opencode")).toEqual(["engines", "upgrade", "opencode", "--json"]);
    expect(enginesArgs("upgrade", "rm -rf")).toBeUndefined();
    expect(enginesArgs("upgrade", undefined)).toBeUndefined();
    expect(enginesArgs("install", "codex")).toBeUndefined();
  });

  it("drops an unknown engine from a list request", () => {
    expect(enginesArgs("list", "../x")).toEqual(["engines", "list", "--json"]);
  });

  it("opens the sign-in page for Claude Code and Codex only", () => {
    expect(enginesArgs("login", "claude")).toEqual(["engines", "login", "claude", "--json"]);
    expect(enginesArgs("login", "codex")).toEqual(["engines", "login", "codex", "--json"]);
    expect(enginesArgs("login", "opencode")).toBeUndefined();
    expect(enginesArgs("login", "x; rm")).toBeUndefined();
  });

  it("detects, reads and saves the choice of agents", () => {
    expect(enginesArgs("detect", undefined)).toEqual(["engines", "detect", "--json"]);
    expect(enginesArgs("enabled", undefined)).toEqual(["engines", "enabled", "--json"]);
    expect(enginesArgs("use", undefined, { off: ["codex"], on: ["gemini", "pi"] })).toEqual(["engines", "use", "--off", "codex", "--on", "gemini,pi", "--json"]);
    expect(enginesArgs("use", undefined, { on: [] })).toEqual(["engines", "use", "--on", "", "--json"]);
    expect(enginesArgs("use", undefined, { reset: true })).toEqual(["engines", "use", "--reset", "--json"]);
    expect(enginesArgs("use", undefined, { default: "codex" })).toEqual(["engines", "use", "--default", "codex", "--json"]);
    expect(enginesArgs("use", undefined, { off: ["codex"], default: "" })).toEqual(["engines", "use", "--off", "codex", "--default", "", "--json"]);
  });

  it("refuses a choice that is not a list of agent ids", () => {
    expect(enginesArgs("use", undefined, {})).toBeUndefined();
    expect(enginesArgs("use", undefined, { off: "codex" })).toBeUndefined();
    expect(enginesArgs("use", undefined, { off: ["codex; rm -rf /"] })).toBeUndefined();
    expect(enginesArgs("use", undefined, { on: ["../x"] })).toBeUndefined();
    expect(enginesArgs("use", undefined, { default: "a b" })).toBeUndefined();
    expect(enginesArgs("use", undefined, { default: 3 })).toBeUndefined();
    expect(enginesArgs("use", undefined, undefined)).toBeUndefined();
  });
});
