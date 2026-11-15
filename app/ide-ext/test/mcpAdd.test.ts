import { describe, expect, it } from "vitest";
import { mcpAddArgs } from "../src/core/mcpAdd";

describe("Settings › MCP servers › Add", () => {
  it("a web address is a remote server", () => {
    expect(mcpAddArgs({ name: "docs", target: " https://example.com/mcp ", engines: ["claude-code", "codex"] }))
      .toEqual(["mcp", "add", "docs", "--engine", "claude-code,codex", "--json", "--url", "https://example.com/mcp"]);
  });

  it("anything else is the command that starts a local one", () => {
    expect(mcpAddArgs({ name: "pw", target: "npx -y @playwright/mcp@latest", engines: ["opencode"] }))
      .toEqual(["mcp", "add", "pw", "--engine", "opencode", "--json", "--", "npx", "-y", "@playwright/mcp@latest"]);
  });

  it("asks for what is missing in plain words", () => {
    expect(() => mcpAddArgs({ name: "", target: "https://a.b", engines: ["codex"] })).toThrow(/name/);
    expect(() => mcpAddArgs({ name: "a b", target: "https://a.b", engines: ["codex"] })).toThrow(/name/);
    expect(() => mcpAddArgs({ name: "x", target: "https://a.b", engines: [] })).toThrow(/agent/);
    expect(() => mcpAddArgs({ name: "x", target: "https://a.b", engines: ["../x"] })).toThrow(/agent/);
    expect(() => mcpAddArgs({ name: "x", target: "", engines: ["codex"] })).toThrow(/address/);
    expect(() => mcpAddArgs({ name: "x", target: "--url foo", engines: ["codex"] })).toThrow(/address/);
    expect(() => mcpAddArgs({ name: "x", target: "https:/broken", engines: ["codex"] })).toThrow(/address/);
  });
});
