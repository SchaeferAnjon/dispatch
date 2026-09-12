import { describe, expect, it } from "vitest";
import { nodeSize } from "./Graph";

describe("脉络图节点尺寸", () => {
  it("names are shown whole: height grows with the text, width stays per kind", () => {
    const one = nodeSize("task", "短标题");
    const two = nodeSize("task", "Dispatch：复审并重构两个 DeepSeek agent 的交付，装机后逐项点过");
    expect(one.lines).toBe(1);
    expect(two.lines).toBe(2);
    expect(two.w).toBe(one.w);
    expect(two.h).toBeGreaterThan(one.h);
  });
  it("caps the line count per kind (the panel shows the rest)", () => {
    expect(nodeSize("step", "很长的一句进展".repeat(20)).lines).toBe(3);
    expect(nodeSize("session", "会话标题".repeat(30)).lines).toBe(2);
    expect(nodeSize("task", "").lines).toBe(1);
  });
});
