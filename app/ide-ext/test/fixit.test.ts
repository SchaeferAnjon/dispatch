import { describe, expect, it } from "vitest";
import { fixArgs, folderPath, isFixKind, isWriteKind, settledArgs, timeoutFor, writeArgs } from "../src/core/fixit";

describe("fix and write arguments", () => {
  it("only knows the kinds the CLI has", () => {
    expect(isFixKind("commit")).toBe(true);
    expect(isFixKind("status")).toBe(true);
    expect(isFixKind("rm -rf")).toBe(false);
    expect(isWriteKind("pr")).toBe(true);
    expect(isWriteKind("commit")).toBe(false);
  });

  it("takes a path or a file URI, nothing remote", () => {
    expect(folderPath("/Users/a/shop")).toBe("/Users/a/shop");
    expect(folderPath("file:///Users/a/my%20shop")).toBe("/Users/a/my shop");
    expect(folderPath("vscode-agent-host://mini/Users/a")).toBe("");
    expect(folderPath(undefined)).toBe("");
    expect(folderPath("relative/path")).toBe("");
  });

  it("builds the command lines", () => {
    expect(fixArgs("commit", "/p", { message: "Add it" })).toEqual(["fix", "commit", "--folder", "/p", "--json", "--message", "Add it"]);
    expect(fixArgs("push", "/p", { message: "ignored" })).toEqual(["fix", "push", "--folder", "/p", "--json"]);
    expect(fixArgs("conflicts", "/p", { base: "main" })).toEqual(["fix", "conflicts", "--folder", "/p", "--json", "--base", "main"]);
    expect(fixArgs("status", "/p", { fresh: true })).toEqual(["fix", "status", "--folder", "/p", "--json", "--no-cache"]);
    expect(writeArgs("commit-message", "/p")).toEqual(["write", "commit-message", "--json", "--folder", "/p"]);
    expect(writeArgs("branch", "", "add dark mode")).toEqual(["write", "branch", "--json", "--from", "add dark mode"]);
  });

  it("lets the session's own agent write its commit message, with its model (task-dekzn)", () => {
    expect(writeArgs("commit-message", "/p", "", "opencode", "deepseek/deepseek-v4-flash"))
      .toEqual(["write", "commit-message", "--json", "--folder", "/p", "--agent", "opencode", "--model", "deepseek/deepseek-v4-flash"]);
    expect(writeArgs("commit-message", "/p", "", "codex", "")).toEqual(["write", "commit-message", "--json", "--folder", "/p", "--agent", "codex"]);
    // no known agent: the CLI picks as before; a model that looks like an option is not passed
    expect(writeArgs("commit-message", "/p", "", "copilot", "x")).toEqual(["write", "commit-message", "--json", "--folder", "/p"]);
    expect(writeArgs("commit-message", "/p", "", "claude", "--evil")).toEqual(["write", "commit-message", "--json", "--folder", "/p", "--agent", "claude"]);
    expect(writeArgs("branch", "", "x", "claude", "m")).toEqual(["write", "branch", "--json", "--from", "x"]);
  });

  it("asks the session's own agent for the sentences of Walk me through, the stops on stdin (task-fktjx)", () => {
    expect(isWriteKind("walk")).toBe(true);
    expect(writeArgs("walk", "", "", "opencode", "deepseek/deepseek-flash")).toEqual(["write", "walk", "--json", "--agent", "opencode", "--model", "deepseek/deepseek-flash"]);
    expect(writeArgs("walk", "", "", "gemini", "x")).toEqual(["write", "walk", "--json"]);
    expect(timeoutFor(writeArgs("walk", ""))).toBe(150000);
  });

  it("asks whether a failed commit, push or merge is behind us", () => {
    expect(settledArgs("/p", "commit", "a1b2c3d4", "identity")).toEqual(["fix", "settled", "--folder", "/p", "--about", "commit", "--json", "--since", "a1b2c3d4", "--need", "identity"]);
    expect(settledArgs("/p", "push", "", undefined)).toEqual(["fix", "settled", "--folder", "/p", "--about", "push", "--json"]);
    expect(settledArgs("/p", "push", "--exec=x", "rm")).toEqual(["fix", "settled", "--folder", "/p", "--about", "push", "--json"]);
    expect(settledArgs("/p", "checks", "a1b2", "")).toBeUndefined();
  });

  it("gives an agent time to write", () => {
    expect(timeoutFor(writeArgs("commit-message", "/p"))).toBe(150000);
    expect(timeoutFor(writeArgs("branch", "/p"))).toBe(45000);
    expect(timeoutFor(fixArgs("status", "/p"))).toBe(60000);
    expect(timeoutFor(fixArgs("commit", "/p"))).toBe(30000);
  });
});
