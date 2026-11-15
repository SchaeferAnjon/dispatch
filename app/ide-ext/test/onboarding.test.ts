import { describe, expect, it } from "vitest";
import { draftInput, extensionIds, macToolsReady, onboardingArgs, registerInput, vscodeApplyInput } from "../src/core/onboarding";

describe("onboarding bridge", () => {
  it("only connects supported, explicitly selected agents", () => {
    expect(onboardingArgs("apply-rules", "codex,opencode")).toEqual(["onboard", "apply-rules", "--agents", "codex,opencode", "--json"]);
    expect(onboardingArgs("apply-rules", "gemini")).toBeUndefined();
    expect(onboardingArgs("apply-rules", "--all")).toBeUndefined();
  });
  it("asks which installed agents are not connected yet (the title bar's Set up, task-vgll)", () => {
    expect(onboardingArgs("unconnected")).toEqual(["onboard", "unconnected", "--json"]);
  });
  it("sends project paths as JSON, never shell arguments", () => {
    expect(registerInput([{ dir: "/Users/me/Project with space", name: "one" }])).toBe('{"dirs":[{"dir":"/Users/me/Project with space","name":"one"}]}');
    expect(registerInput([{ dir: "relative" }])).toBeUndefined();
    expect(registerInput([])).toBeUndefined();
  });
  it("requires explicit git removal and validated receipt identifiers for Undo", () => {
    expect(onboardingArgs("undo", "ob-1234abcd")).toEqual(["onboard", "undo", "ob-1234abcd", "--json"]);
    expect(onboardingArgs("undo", "ob-1234abcd", true)).toContain("--also-git");
    expect(onboardingArgs("undo", "--all")).toBeUndefined();
  });
  it("keeps VS Code optional and validates saved selections", () => {
    expect(JSON.parse(vscodeApplyInput({ settings: ["editor.fontSize"], keybindings: false })!)).toEqual({ settings: ["editor.fontSize"], keybindings: false, snippets: false });
    expect(extensionIds(["publisher.name", "--install-extension", "../wrong"])).toEqual(["publisher.name"]);
    expect(draftInput({ range: "last90Days", selected: [] })).toContain("last90Days");
    expect(draftInput(null)).toBeUndefined();
  });
});

describe("Apple's command line tools (a new Mac has none, task-7mmi3)", () => {
  const files = (...have: string[]) => (p: string) => have.includes(p);
  it("are there with the Command Line Tools", () => {
    expect(macToolsReady("darwin", "/Library/Developer/CommandLineTools\n", files("/Library/Developer/CommandLineTools", "/Library/Developer/CommandLineTools/usr/bin/git"))).toBe(true);
  });
  it("are there with Xcode", () => {
    const dev = "/Applications/Xcode.app/Contents/Developer";
    expect(macToolsReady("darwin", dev, files(dev, `${dev}/usr/bin/git`))).toBe(true);
  });
  it("are missing when xcode-select has no folder, or the folder is gone", () => {
    expect(macToolsReady("darwin", "", files())).toBe(false);
    expect(macToolsReady("darwin", "/Library/Developer/CommandLineTools", files())).toBe(false);
  });
  it("are not needed with Homebrew's python3 and git", () => {
    expect(macToolsReady("darwin", "", files("/opt/homebrew/bin/python3", "/opt/homebrew/bin/git"))).toBe(true);
    expect(macToolsReady("darwin", "", files("/opt/homebrew/bin/python3"))).toBe(false);
  });
  it("are not asked for elsewhere", () => {
    expect(macToolsReady("win32", "", files())).toBe(true);
  });
});
