import { describe, expect, it } from "vitest";
import { editorCall, editorPatch, viaSubscription } from "../src/core/editorSettings";
import { EDITOR_SETTINGS_QUERY, settingsRequest, takeSettingsRequest } from "../src/core/editorSettings";

describe("editor settings", () => {
  it("reads through dispatch ide editor-settings", () => {
    expect(editorCall("get")).toEqual({ args: ["ide", "editor-settings", "--json"] });
  });

  it("saves only the four editor settings, checked", () => {
    const c = editorCall("save", { ide_tab_completion: false, ide_tab_model: " claude:haiku ", ide_tab_daily_cap_usd: 0.255, ide_edit_model: "codex:gpt-6-astra" });
    expect(c.args).toEqual(["settings", "--save", "--json"]);
    expect(JSON.parse(c.input!)).toEqual({ ide_tab_completion: 0, ide_tab_model: "claude:haiku", ide_tab_daily_cap_usd: 0.26, ide_edit_model: "codex:gpt-6-astra" });
    expect(editorPatch({ ide_tab_daily_cap_usd: 0 })).toEqual({ ide_tab_daily_cap_usd: 0 });
    expect(() => editorPatch({ check_mode: "self" })).toThrow();
    expect(() => editorPatch({ ide_tab_daily_cap_usd: -1 })).toThrow();
    expect(() => editorPatch({ ide_edit_model: "claude:sonnet; rm -rf" })).toThrow();
    expect(() => editorPatch({})).toThrow("nothing to save");
    expect(() => editorCall("rm")).toThrow();
  });

  it("knows which Tab models run on the subscription", () => {
    expect(viaSubscription("claude:haiku")).toBe(true);
    expect(viaSubscription("codex:gpt-6-astra")).toBe(true);
    expect(viaSubscription("deepseek-flash")).toBe(false);
  });

  it("hands the Agents window's request to one editor window, while it is fresh (task-9rj7k)", () => {
    const files = new Map<string, string>();
    const fs = {
      renameSync(a: string, b: string) {
        const v = files.get(a);
        if (v === undefined) throw new Error("ENOENT");
        files.delete(a);
        files.set(b, v);
      },
      readFileSync: (p: string) => files.get(p) ?? "",
      rmSync: (p: string) => void files.delete(p),
    };
    files.set("/r", JSON.stringify(settingsRequest(100)));
    expect(takeSettingsRequest("/r", 1, 110, fs)).toEqual({ query: EDITOR_SETTINGS_QUERY, at: 100 });
    expect(takeSettingsRequest("/r", 2, 110, fs)).toBeUndefined(); // the first window took it
    expect(files.size).toBe(0);
    files.set("/r", JSON.stringify(settingsRequest(100)));
    expect(takeSettingsRequest("/r", 1, 200, fs)).toBeUndefined(); // stale
    files.set("/r", JSON.stringify({ query: "@ext:evil", at: 100 }));
    expect(takeSettingsRequest("/r", 1, 101, fs)?.query).toBe(EDITOR_SETTINGS_QUERY);
  });
});
