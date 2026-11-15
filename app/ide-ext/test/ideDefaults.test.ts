import { describe, expect, it } from "vitest";
import { defaultsToWrite, type IdeDefaults } from "../src/core/ideDefaults";

const d: IdeDefaults = {
  version: 1,
  theme: { "window.autoDetectColorScheme": true, "workbench.colorTheme": "Dispatch Dark" },
  settings: { "editor.fontSize": 13, "workbench.iconTheme": "vs-minimal" },
};

describe("defaultsToWrite", () => {
  it("writes every key on a fresh IDE", () => {
    expect(defaultsToWrite(d, () => undefined, 0)).toEqual([
      ["window.autoDetectColorScheme", true], ["workbench.colorTheme", "Dispatch Dark"],
      ["editor.fontSize", 13], ["workbench.iconTheme", "vs-minimal"],
    ]);
  });
  it("leaves keys the user set alone, and the whole theme group when any theme key is set", () => {
    const user: Record<string, unknown> = { "workbench.colorTheme": "Monokai", "editor.fontSize": 15 };
    expect(defaultsToWrite(d, (k) => user[k], 0)).toEqual([["workbench.iconTheme", "vs-minimal"]]);
  });
  it("adds the agents settings only in the Agents window", () => {
    const withAgents = { ...d, agents: { "chat.disableAIFeatures": false } };
    expect(defaultsToWrite(withAgents, () => undefined, 0)).toHaveLength(4);
    expect(defaultsToWrite(withAgents, () => undefined, 0, true)).toContainEqual(["chat.disableAIFeatures", false]);
  });
  it("replaces an earlier default the user still has, and nothing the user changed", () => {
    const v2 = { ...d, version: 2, settings: { ...d.settings, "window.commandCenter": true }, replaces: { "window.commandCenter": false } };
    const had: Record<string, unknown> = { "window.commandCenter": false, "editor.fontSize": 13, "workbench.iconTheme": "x", "workbench.colorTheme": "y" };
    expect(defaultsToWrite(v2, (k) => had[k], 1)).toEqual([["window.commandCenter", true]]);
    const changed: Record<string, unknown> = { "window.commandCenter": true };
    expect(defaultsToWrite(v2, (k) => changed[k], 1).map(([k]) => k)).not.toContain("window.commandCenter");
  });
  it("runs once per version", () => {
    expect(defaultsToWrite(d, () => undefined, 1)).toEqual([]);
    expect(defaultsToWrite({ ...d, version: 2 }, () => undefined, 1)).toHaveLength(4);
  });
});
