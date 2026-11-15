import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import type { Api } from "../api";
import { ConversationActions, useConversationActionItems } from "./ConversationActions";
import { closeChat, heldOpen } from "./SessionActions";
import { ingest, resetChatStore } from "../chatStore";
import type { ChatApi, ChatCommand, ChatEvent } from "../chatProtocol";
import type { ViewMenuItem } from "./ContextMenu";

const act = (over: Partial<Activity> = {}): Activity => ({ key: "claude-code:s1", agent: "claude-code", session_id: "s1", cwd: "/Users/x/Projects/kanban", project: "kanban", title: "会话", last_at: Date.now() / 1000 - 60, state: "idle", activity: "", version: "", events: [], tasks: [], unread: false, stale: false, tracking_since: 0, source: "transcript", ...over } as Activity);
const api = { copy: async () => {} } as unknown as Api;
const noop = async () => {};

function Labels({ a }: { a: Activity }) {
  const items = useConversationActionItems()(a);
  return <ul>{items.map((i, n) => i === "-" ? <li key={n}>-</li> : <li key={i.label} data-danger={i.danger ? "1" : undefined}>{i.label}</li>)}</ul>;
}
const labels = (a: Activity) => renderToStaticMarkup(<ConversationActions api={api} projects={[]} onSaved={() => {}} archiveDays={7} actions={{ onOpen: () => {}, onRead: noop, onResume: () => {} }}><Labels a={a} /></ConversationActions>);

describe("conversation menu", () => {
  it("offers 复制会话 ID and ends with 删除会话… for Claude and Codex, and no app-wide items", () => {
    for (const agent of ["claude-code", "codex"]) {
      const html = labels(act({ agent, key: `${agent}:s1` }));
      expect(html).toContain("复制会话 ID");
      expect(html).toMatch(/<li data-danger="1">删除会话…<\/li><\/ul>$/);
      for (const global of ["新建会话", "新建任务", "刷新", "搜索", "复制手机访问链接", "跟随系统主题"]) expect(html).not.toContain(global);
    }
  });
  it("has no 删除会话 for agents the CLI cannot delete", () => {
    expect(labels(act({ agent: "zcode", key: "zcode:s1" }))).not.toContain("删除会话");
  });
});

// 关掉后台会话: every way the app closes an in-app conversation ends in chatd's `close`.
describe("closing an in-app conversation", () => {
  beforeEach(() => { vi.stubGlobal("window", { setTimeout, clearTimeout }); resetChatStore(); });
  afterEach(() => vi.unstubAllGlobals());

  const held = (over: Partial<Activity> = {}) => act({ runner: "dispatch", chat_lifecycle: "idle", ...over });
  const withItems = (a: Activity, actions: Record<string, unknown>, apiOver: Partial<Api> = {}) => {
    let got: (ViewMenuItem | "-")[] = [];
    function Grab() { got = useConversationActionItems()(a); return null; }
    renderToStaticMarkup(<ConversationActions api={{ ...api, ...apiOver } as Api} projects={[]} onSaved={() => {}} archiveDays={7} actions={{ onOpen: () => {}, onRead: noop, onResume: () => {}, ...actions }}><Grab /></ConversationActions>);
    return got.filter((i): i is ViewMenuItem => i !== "-");
  };

  it("counts a session as open in the background only while chatd holds its process on this Mac", () => {
    expect(heldOpen(held())).toBe(true);
    expect(heldOpen(held({ chat_lifecycle: "running" }))).toBe(true);
    expect(heldOpen(held({ chat_lifecycle: undefined }))).toBe(true);  // an older CLI without the field
    expect(heldOpen(held({ chat_lifecycle: "stopped" }))).toBe(false); // the idle timer already closed it
    expect(heldOpen(act({ runner: "terminal" }))).toBe(false);
    expect(heldOpen(held({ remote: true }))).toBe(false);
  });

  it("the right-click menu offers 关掉后台会话 for a held session and it calls the close action", async () => {
    const closed: Activity[] = [];
    const onCloseChat = async (a: Activity) => { closed.push(a); };
    const a = held();
    const item = withItems(a, { onCloseChat }).find((i) => i.label === "关掉后台会话");
    expect(item).toBeTruthy();
    await item!.onClick();
    expect(closed).toEqual([a]);
    expect(withItems(held({ chat_lifecycle: "stopped" }), { onCloseChat }).some((i) => i.label === "关掉后台会话")).toBe(false);
    expect(withItems(act({ runner: "terminal" }), { onCloseChat }).some((i) => i.label === "关掉后台会话")).toBe(false);
  });

  it("archiving a session chatd holds closes it first", async () => {
    const calls: string[] = [];
    const onCloseChat = async (_a: Activity, quiet?: boolean) => { calls.push(`close${quiet ? " quiet" : ""}`); };
    const on = async (_host: string, args: string[]) => { calls.push(args[0]); return "{}"; };
    await withItems(held(), { onCloseChat }, { on } as Partial<Api>).find((i) => i.label === "归档")!.onClick();
    expect(calls).toEqual(["close quiet", "session-preferences"]);
    calls.length = 0;
    await withItems(act({ runner: "terminal" }), { onCloseChat }, { on } as Partial<Api>).find((i) => i.label === "归档")!.onClick();
    expect(calls).toEqual(["session-preferences"]);
  });

  it("closeChat sends chatd `close` for the session and resolves on its `closed`", async () => {
    const sent: ChatCommand[] = [];
    const chat: ChatApi = { chatAvailable: true, chatCommand: async (c) => { sent.push(c); }, onChatEvent: async () => () => {}, chatRestart: async () => {} };
    const p = closeChat(chat, "claude-code:s1");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([expect.objectContaining({ cmd: "close", session: "claude-code:s1" })]);
    ingest({ ev: "closed", seq: 1, ts: 1, session: "claude-code:s1", reason: "requested", request_id: sent[0].request_id } as ChatEvent);
    await expect(p).resolves.toBeUndefined();
  });
});
