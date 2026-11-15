import { describe, expect, it } from "vitest";
import { displayTitle, plainPreview, sessionGroup, sourceLabel } from "./Sessions";

describe("session list sections", () => {
  const now = new Date(2026, 8, 25, 10, 0, 0);
  const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0).getTime() / 1000;
  it("running wins, then starred, then by calendar day", () => {
    expect(sessionGroup(at(1, 9), true, true, now)).toBe("running");
    expect(sessionGroup(at(1, 9), false, true, now)).toBe("starred");
    expect(sessionGroup(at(25, 0), false, false, now)).toBe("today");
    expect(sessionGroup(at(24, 23), false, false, now)).toBe("yesterday");
    expect(sessionGroup(at(24, 0), false, false, now)).toBe("yesterday");
    expect(sessionGroup(at(23, 23), false, false, now)).toBe("week");
    expect(sessionGroup(at(19, 0), false, false, now)).toBe("week");
    expect(sessionGroup(at(18, 23), false, false, now)).toBe("older");
  });
});

describe("reply preview in the Detail", () => {
  it("drops code blocks and markdown marks, keeps paragraphs", () => {
    expect(plainPreview("## Done\n\n**Fixed** the `bug`.\n\n```ts\nconst a = 1;\n```\n- see [docs](https://x.y)")).toBe("Done\n\nFixed the bug.\n\nsee docs");
  });
  it("cuts long text with an ellipsis", () => {
    const s = plainPreview("a".repeat(700), 600);
    expect(s).toHaveLength(600);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("session source and title", () => {
  it("names Dispatch's own chats and Claudian by what they are, not by the SDK they run through", () => {
    expect(sourceLabel("sdk-cli", { live: { source_app: "终端" }, activity: { app: "claudian", entrypoint: "sdk-cli" } })).toBe("Obsidian · Claudian");
    expect(sourceLabel("sdk-cli", { activity: { runner: "dispatch" } })).toBe("Dispatch");
    expect(sourceLabel("sdk-cli", { inApp: true, live: { source_app: "终端" } })).toBe("Dispatch");
    expect(sourceLabel("dispatch")).toBe("Dispatch");
    expect(sourceLabel("sdk-cli")).toBe("SDK");  // a script's run stays SDK
    expect(sourceLabel("cli", { live: { source_app: "Ghostty" } })).toBe("Ghostty");
    expect(sourceLabel(undefined)).toBe("");
    // an in-app chat whose folder is a vault is still Dispatch's
    expect(sourceLabel("dispatch", { activity: { app: "claudian", entrypoint: "dispatch", runner: "dispatch" } })).toBe("Dispatch");
  });

  it("falls back to the first message when a conversation has no title yet", () => {
    expect(displayTitle("跨设备迁移", "long first message")).toBe("跨设备迁移");
    expect(displayTitle("", "\n  帮我看一下 tmp 目录里有什么文件\n第二行")).toBe("帮我看一下 tmp 目录里有什么文件");
    expect(displayTitle(undefined, "x".repeat(60))).toBe(`${"x".repeat(40)}…`);
    expect(displayTitle("", "")).toBe("");
    // a script's prompt is the program's, not a name
    expect(displayTitle("", "你是讨论的记录员，整理下面的发言", true)).toBe("");
    expect(displayTitle("短名", "x", true)).toBe("短名");
  });
});
