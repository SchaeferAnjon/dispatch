import { afterEach, describe, expect, it } from "vitest";
import { t } from "./i18n";
import { __setPlatformForTests } from "./platform";

describe("shortcut labels", () => {
  afterEach(() => __setPlatformForTests(null));
  it("fill {mod} with ⌘ on a Mac and Ctrl+ on Windows", () => {
    __setPlatformForTests("mac");
    expect(t("保存 {mod}⏎")).toBe("保存 ⌘⏎");
    expect(t("新建会话（{mod}N）")).toBe("新建会话（⌘N）");
    __setPlatformForTests("windows");
    expect(t("保存 {mod}⏎")).toBe("保存 Ctrl+⏎");
    expect(t("{mod}K 搜项目、会话、任务；{mod}N 新建会话；{mod}T 新任务；{mod}R 刷新。")).toBe("Ctrl+K 搜项目、会话、任务；Ctrl+N 新建会话；Ctrl+T 新任务；Ctrl+R 刷新。");
  });
  it("leaves an explicit {mod} param alone", () => {
    expect(t("保存 {mod}⏎", { mod: "X-" })).toBe("保存 X-⏎");
  });
});

describe("German strings", () => {
  it("address the person as Sie everywhere, never du / dich / dein", async () => {
    const de = (await import("./locales/de")).default;
    const texts = Object.values(de).map((v) => (typeof v === "function" ? v({ n: 2, open: 1, name: "x", dir: "", host: "h" }) : v));
    const informal = texts.filter((s) => /\b(du|dich|dir|dein\w*)\b/i.test(String(s).replace(/\{dir\}/g, "")));
    expect(informal).toEqual([]);
  });
});
