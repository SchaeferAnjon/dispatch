import { describe, expect, it } from "vitest";
import { accountsAddArgs, accountsArgs, accountsTimeout } from "../src/core/accounts";

describe("accountsArgs", () => {
  it("asks for usage and the list", () => {
    expect(accountsArgs(undefined)).toEqual(["accounts", "watch", "--json"]);
    expect(accountsArgs("watch")).toEqual(["accounts", "watch", "--json"]);
    expect(accountsArgs("list")).toEqual(["accounts", "list", "--json"]);
  });

  it("switches and removes one account of one engine", () => {
    expect(accountsArgs("use", "claude", "claude-1a2b3c4d")).toEqual(["accounts", "use", "claude", "claude-1a2b3c4d", "--json"]);
    expect(accountsArgs("use", "codex", "me@example.com")).toEqual(["accounts", "use", "codex", "me@example.com", "--json"]);
    expect(accountsArgs("remove", "claude", "Work")).toEqual(["accounts", "remove", "claude", "Work", "--json"]);
    expect(accountsArgs("use", "opencode", "x")).toBeUndefined();
    expect(accountsArgs("use", "claude")).toBeUndefined();
    expect(accountsArgs("use", "claude", "a; rm -rf ~")).toBeUndefined();
  });

  it("continues a session, on a chosen account or the best one", () => {
    expect(accountsArgs("continue", "claude", "f26daa30-d493-47f7-8423-a73cde88ecd8", "claude-1a2b3c4d")).toEqual(
      ["accounts", "continue", "claude", "f26daa30-d493-47f7-8423-a73cde88ecd8", "--to", "claude-1a2b3c4d", "--json"]);
    expect(accountsArgs("continue", "codex", "t-1")).toEqual(["accounts", "continue", "codex", "t-1", "--json"]);
    expect(accountsArgs("continue", "codex", "t-1", "$(x)")).toBeUndefined();
  });

  it("refuses anything else", () => {
    expect(accountsArgs("add", "claude")).toBeUndefined();
    expect(accountsArgs("rename", "claude", "x")).toBeUndefined();
  });
});

describe("accountsAddArgs", () => {
  it("signs in to another account, switching only when asked", () => {
    expect(accountsAddArgs("claude")).toEqual(["accounts", "add", "claude"]);
    expect(accountsAddArgs("codex", true)).toEqual(["accounts", "add", "codex", "--use"]);
    expect(accountsAddArgs("gemini")).toBeUndefined();
  });
});

describe("accountsTimeout", () => {
  it("gives the network calls more time", () => {
    expect(accountsTimeout("list")).toBeGreaterThan(accountsTimeout("watch"));
    expect(accountsTimeout("continue")).toBeGreaterThan(accountsTimeout("use"));
  });
});
