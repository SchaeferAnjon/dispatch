import { describe, expect, it } from "vitest";
import { continueAnswer, continueRequest, folderPath, historyArgs, openWindowRequest, takesRequest, userDataOf } from "../src/core/history";

describe("history args", () => {
  it("asks the whole Mac by default", () => {
    expect(historyArgs({})).toEqual(["sessions", "history", "--json", "--scope", "all", "--sort", "updated"]);
  });

  it("passes scope, folder, words, agents, sort, limit, empties, machine and the window's user data", () => {
    expect(historyArgs({ scope: "project", folder: "file:///Users/a/My%20Shop", query: " cart\ntotal ", agents: ["claude-code", "codex"], sort: "created", limit: 160, showEmpty: true, machine: "mini" }, "/Users/a/Library/Application Support/Dispatch IDE"))
      .toEqual(["sessions", "history", "--json", "--scope", "project", "--folder", "/Users/a/My Shop", "--query", "cart total", "--agents", "claude-code,codex", "--sort", "created", "--limit", "160", "--show-empty", "--machine", "mini", "--user-data", "/Users/a/Library/Application Support/Dispatch IDE"]);
  });

  it("refuses what the window never sends", () => {
    expect(historyArgs(undefined)).toBeUndefined();
    expect(historyArgs({ scope: "everything" })).toBeUndefined();
    expect(historyArgs({ folder: "relative/path" })).toBeUndefined();
    expect(historyArgs({ agents: ["; rm -rf /"] })).toBeUndefined();
    expect(historyArgs({ sort: "random" })).toBeUndefined();
    expect(historyArgs({ limit: 0 })).toBeUndefined();
    expect(historyArgs({ machine: "../x" })).toBeUndefined();
    expect(historyArgs({ machine: "local" })).toEqual(["sessions", "history", "--json", "--scope", "all", "--sort", "updated"]);
  });

  it("finds the user data folder", () => {
    expect(userDataOf("/tmp/ud/User/globalStorage/dispatch.dispatch-bridge")).toBe("/tmp/ud");
    expect(userDataOf("/somewhere/else")).toBe("");
    expect(folderPath("/a/b")).toBe("/a/b");
  });
});

describe("open in a new window", () => {
  it("keeps a clean request", () => {
    expect(openWindowRequest({ cwd: "/Users/a/shop", command: "/bin/claude --resume 1", name: "Claude Code" }, 5)).toEqual({ root: "/Users/a/shop", command: "/bin/claude --resume 1", name: "Claude Code", at: 5 });
    expect(openWindowRequest({ cwd: "/Users/a/shop", command: "a\nb" }, 5)).toBeUndefined();
    expect(openWindowRequest({ cwd: "shop", command: "x" }, 5)).toBeUndefined();
  });

  it("is taken only by the new window on that folder, within two minutes", () => {
    const rec = { root: "/Users/a/shop", command: "x", name: "n", at: 100 };
    const same = (a: string, b: string) => a === b;
    expect(takesRequest(rec, "/Users/a/shop", 130, same)?.command).toBe("x");
    expect(takesRequest(rec, "/Users/a/other", 130, same)).toBeUndefined();
    expect(takesRequest(rec, "/Users/a/shop", 200, same)?.command).toBe("x");
    expect(takesRequest(rec, "/Users/a/shop", 260, same)).toBeUndefined();
  });
});

describe("continue in the chat", () => {
  it("asks for the agent's own conversation by its Agent Host provider", () => {
    expect(continueRequest({ agent: "claude-code", id: "6b2c9a1e-1111-4111-8111-111111111111" })).toEqual({ provider: "claude", id: "6b2c9a1e-1111-4111-8111-111111111111" });
    expect(continueRequest({ agent: "codex", id: "019a0000-0000-7000-8000-000000000001" })?.provider).toBe("codex");
    expect(continueRequest({ agent: "opencode", id: "ses_abc123" })?.provider).toBe("opencode");
  });

  it("refuses agents the chat cannot take and ids that are not ids", () => {
    expect(continueRequest({ agent: "zcode", id: "abcd1234" })).toBeUndefined();
    expect(continueRequest({ agent: "claude-code", id: "../../etc/passwd" })).toBeUndefined();
    expect(continueRequest({ agent: "claude-code" })).toBeUndefined();
    expect(continueRequest("claude")).toBeUndefined();
  });

  it("reads the Agent Host's answer", () => {
    expect(continueAnswer('{"ok":true,"session":"claude:/abc"}')).toEqual({ ok: true, session: "claude:/abc" });
    expect(continueAnswer('{"ok":false,"error":"The agent does not list this conversation."}')).toEqual({ ok: false, error: "The agent does not list this conversation." });
    expect(continueAnswer("not json")).toBeUndefined();
    expect(continueAnswer('{"session":"x"}')).toBeUndefined();
  });
});
