import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS, matchModel, modelGroups, modelKind, modelName, modelNameOf } from "./models";

describe("model picker", () => {
  const claude = [{ id: "", label: "默认" }, { id: "claude-opus-5-5", label: "Opus 5.5", family: "opus", latest: true }, { id: "claude-opus-5", label: "Opus 5", family: "opus", latest: false }];

  it("puts the default and newest first, older releases in their own group", () => {
    const g = modelGroups(claude);
    expect(g.latest.map((o) => o.id)).toEqual(["", "claude-opus-5-5"]);
    expect(g.older.map((o) => o.id)).toEqual(["claude-opus-5"]);
  });

  it("keeps a saved choice the list no longer offers", () => {
    expect(modelGroups(claude, "claude-opus-4-8").latest.map((o) => o.id)).toContain("claude-opus-4-8");
  });

  it("falls back to the agent default for kinds without a list", () => {
    expect(modelGroups(undefined).latest).toEqual([{ id: "", label: "默认" }]);
    expect(FALLBACK_MODELS[modelKind("claude-code")].map((o) => o.id)).toEqual(["", "fable", "opus", "sonnet", "haiku"]);
  });

  it("names the full dated id the agent reports after it starts by the catalog entry", () => {
    const list = [...claude, { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", family: "haiku", latest: true }, { id: "claude-fable-5-1[1m]", label: "Fable 5.1 · 1M", family: "fable", latest: true }];
    expect(modelName(list, "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(matchModel(list, "claude-haiku-4-5")?.id).toBe("claude-haiku-4-5-20251001");
    expect(matchModel(list, "opus")?.id).toBe("claude-opus-5-5");
    expect(modelName(list, "claude-fable-5-1[1m]")).toBe("Fable 5.1 · 1M");
    // the picker does not grow a raw id entry for a model it already lists
    expect(modelGroups(list, "claude-haiku-4-5-20251001").latest.filter((o) => o.id.includes("haiku")).length).toBe(1);
  });

  it("makes a readable name from the id alone when the catalog does not have it", () => {
    expect(modelNameOf("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelNameOf("claude-opus-5-5[1m]")).toBe("Opus 5.5 · 1M");
    expect(modelNameOf("claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelNameOf("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelNameOf("haiku")).toBe("Haiku");
    expect(modelNameOf("gpt-6-astra")).toBe("gpt-6-astra");
    expect(modelNameOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(modelNameOf("claude-sonnet-4-5@20250929")).toBe("Sonnet 4.5");
    expect(modelNameOf("claude-3-7-sonnet-latest")).toBe("Sonnet 3.7");
    expect(modelNameOf("claude-haiku")).toBe("Haiku");
    expect(modelNameOf("")).toBe("");
    // a turn header asks the catalog first: Codex's own labels, and a 1M id the list has without [1m]
    expect(modelName([{ id: "gpt-6-sol", label: "GPT-6-Sol" }], "gpt-6-sol")).toBe("GPT-6-Sol");
    expect(modelName([{ id: "claude-opus-5-5", label: "Opus 5.5", family: "opus" }], "claude-opus-5-5[1m]")).toBe("Opus 5.5 · 1M");
    expect(modelName(FALLBACK_MODELS.claude, "claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelGroups(FALLBACK_MODELS.claude, "claude-haiku-4-5-20251001").latest.find((o) => o.id === "claude-haiku-4-5-20251001")?.label).toBe("Haiku 4.5");
  });
});

import { initialOf } from "./models";
describe("initialOf", () => {
  it("gives the model's first letter, the default's model for 默认", () => {
    expect(initialOf("Opus 5.5", [])).toBe("O");
    expect(initialOf("默认（GPT-6-Astra）", [])).toBe("G");
    expect(initialOf("", [{ id: "", label: "默认", default: "Sonnet 5" }])).toBe("S");
  });
});
