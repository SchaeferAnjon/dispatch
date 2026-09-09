import { describe, expect, it } from "vitest";
import { matchCommands, slashQuery, type SlashCommand } from "./SessionReply";

const all: SlashCommand[] = [
  { name: "compact", description: "压缩对话上下文", kind: "builtin" },
  { name: "clear", description: "清空对话", kind: "builtin" },
  { name: "cost", description: "看用量", kind: "builtin" },
  { name: "task-board", description: "操作 Dispatch 任务", kind: "skill" },
  { name: "save-session", description: "保存会话", kind: "command" },
];

describe("reply box slash menu", () => {
  it("only a lone /word opens the menu; an argument or a second line closes it", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/comp")).toBe("comp");
    expect(slashQuery("/compact 保留验收项")).toBeNull();
    expect(slashQuery("/compact\n")).toBeNull();
    expect(slashQuery("看看 /compact")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("prefix matches come first, then substring matches on name or description", () => {
    expect(matchCommands(all, "").map(c => c.name)).toEqual(["compact", "clear", "cost", "task-board", "save-session"]);
    expect(matchCommands(all, "c").map(c => c.name)).toEqual(["compact", "clear", "cost"]); // one letter never searches descriptions
    expect(matchCommands(all, "co").map(c => c.name)).toEqual(["compact", "cost"]);
    expect(matchCommands(all, "board").map(c => c.name)).toEqual(["task-board"]);
    expect(matchCommands(all, "任务").map(c => c.name)).toEqual(["task-board"]);
    expect(matchCommands(all, "zzz")).toEqual([]);
    expect(matchCommands(all, "", 2)).toHaveLength(2);
    expect(matchCommands(all, "")).toHaveLength(all.length); // everything fits under the default cap
  });
});
