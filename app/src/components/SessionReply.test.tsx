import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "../api";
import { ConvStatus, WhereItem, toggleWhere, whereOf } from "./SessionActions";
import { matchCommands, slashQuery, withImages, type SlashCommand } from "./SessionReply";

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

describe("reply box pictures", () => {
  it("appends the saved paths on one line so the TUI gets a single submit; pictures alone still say something", () => {
    expect(withImages("  看这个  ", [])).toBe("看这个");
    expect(withImages("这是什么", ["/a/1.jpg", "/a/2.png"])).toBe("这是什么 附图（用 Read 看）：/a/1.jpg /a/2.png");
    expect(withImages("", ["/a/1.jpg"])).toBe("看一下这几张图 附图（用 Read 看）：/a/1.jpg");
    expect(withImages("   ", [])).toBe("");
  });
});

describe("reply box where-it-runs toggle", () => {
  const desk = { chatAvailable: true } as unknown as Api;
  const phone = { chatAvailable: false } as unknown as Api;
  it("shows for a Claude or Codex conversation on this Mac in the desktop app, only when it runs somewhere", () => {
    expect(toggleWhere(desk, { agent: "claude-code", host: "local" }, "terminal")).toBe("terminal");
    expect(toggleWhere(desk, { agent: "codex" }, "desktop")).toBe("desktop");
    expect(toggleWhere(desk, { agent: "claude-code" }, "")).toBeNull();  // nowhere: sending resumes it in Dispatch
    expect(toggleWhere(desk, { agent: "claude-code" }, undefined)).toBeNull();
    expect(toggleWhere(phone, { agent: "claude-code" }, "terminal")).toBeNull();  // the phone page has no chat
    expect(toggleWhere(desk, { agent: "claude-code", host: "mini", remote: true }, "terminal")).toBeNull();
    expect(toggleWhere(desk, { agent: "pi" }, "terminal")).toBeNull();
  });
  it("is a row of the header's ⋯ menu, named after where it goes", () => {
    const s = { agent: "claude-code", session_id: "abc", cwd: "/p" };
    expect(renderToStaticMarkup(<WhereItem api={desk} where="terminal" session={s} />)).toMatch(/^<button type="button" role="menuitem" title="[^"]+">接管到 Dispatch<\/button>$/);
    expect(renderToStaticMarkup(<WhereItem api={desk} where="desktop" session={s} />)).toContain(">放回终端<");
    expect(renderToStaticMarkup(<WhereItem api={desk} where="desktop" session={s} busy />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<WhereItem api={phone} where="terminal" session={s} />)).toBe("");
    expect(renderToStaticMarkup(<WhereItem api={desk} where={null} session={s} />)).toBe("");
    expect(whereOf({ runner: "dispatch" })).toBe("desktop");
    expect(whereOf({ runner: "terminal" })).toBe("terminal");
  });
});

describe("the reply box's status line", () => {
  it("shows only the state; agent, model, Mac and folder on hover; 在终端里跑 when a terminal holds it", () => {
    const html = renderToStaticMarkup(<ConvStatus agent="claude-code" model="claude-opus-5-5" host="小蓝" cwd="/Users/x/Projects/redraft" state="空闲" tone="idle" />);
    expect(html.replace(/<[^>]+>/g, "")).toBe("空闲");
    expect(html).toContain('title="Claude Code · Opus 5.5 · 小蓝 · /Users/x/Projects/redraft"');
    expect(html).not.toContain("dotc");  // idle: no dot
    expect(renderToStaticMarkup(<ConvStatus agent="codex" host="mini" state="等你确认" tone="wait" />)).toContain('class="dotc wait"');
    const term = renderToStaticMarkup(<ConvStatus agent="claude-code" state="在跑" tone="run" terminal />);
    expect(term.replace(/<[^>]+>/g, "")).toBe("在跑·在终端里跑");
  });
});
