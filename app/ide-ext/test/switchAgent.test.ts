import { describe, expect, it } from "vitest";
import { sessionKey, switchFolder, switchTarget } from "../src/core/switchAgent";

describe("switchAgent", () => {
  it("turns the Agents window's session resource into a dispatch session key", () => {
    expect(sessionKey("claude:/0b1c2d")).toBe("claude-code:0b1c2d");
    expect(sessionKey("agent-host-claude:/0b1c2d")).toBe("claude-code:0b1c2d");
    expect(sessionKey("agent-host-codex:/019a-ff")).toBe("codex:019a-ff");
    expect(sessionKey("vscode-agent-host-codex://local/019a-ff")).toBe("codex:019a-ff");
    expect(sessionKey("agent-host-opencode:/5e0f7a2c-1111")).toBe("opencode:5e0f7a2c-1111");
    expect(sessionKey("copilotcli:/x")).toBeUndefined();
    expect(sessionKey("")).toBeUndefined();
  });

  it("maps the picked session type to --to", () => {
    expect(switchTarget("codex")).toBe("codex");
    expect(switchTarget("agent-host-claude")).toBe("claude");
    expect(switchTarget("opencode")).toBe("opencode");
    expect(switchTarget("agent-host-opencode")).toBe("opencode");
    expect(switchTarget("copilotcli")).toBeUndefined();
  });

  it("opens the new session where the old one worked", () => {
    expect(switchFolder({ cwd: "/r/.worktrees/a" }, "/r")).toBe("/r/.worktrees/a");
    expect(switchFolder({ cwd: "" }, "/r")).toBe("/r");
    expect(switchFolder({ cwd: "" }, undefined)).toBeUndefined();
  });
});
