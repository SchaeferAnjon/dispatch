import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatApi, ChatCommand, ChatEvent } from "./chatProtocol";
import { chatdStatus, chatViewOf, ingest, request, resetChatStore, subscribeChat } from "./chatStore";
import { chatUnavailable } from "./api";
import { fixtureApi } from "./fixtures";

// A ChatApi that records commands and lets the test answer them.
function fakeApi() {
  const sent: ChatCommand[] = [];
  const api: ChatApi = { chatAvailable: true, chatCommand: async (c) => { sent.push(c); }, onChatEvent: async () => () => {}, chatRestart: async () => {} };
  return { api, sent };
}
let seq = 0;
const ev = (e: Record<string, unknown>) => ingest({ seq: ++seq, ts: 1, ...e } as ChatEvent);

beforeEach(() => { vi.stubGlobal("window", { setTimeout, clearTimeout }); resetChatStore(); seq = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("chat store", () => {
  it("resolves a request with the event carrying its request_id, rejects on error", async () => {
    const { api, sent } = fakeApi();
    const p = request(api, { cmd: "open", request_id: "r1", agent: "claude-code", cwd: "/p" });
    await new Promise((r) => setTimeout(r, 0)); // the line goes out once the listener is known to be attached
    expect(sent[0]).toMatchObject({ cmd: "open", request_id: "r1" });
    ev({ ev: "opened", request_id: "r1", session: "claude-code:new", agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "", transcript_path: "", capabilities: [] });
    expect((await p).ev).toBe("opened");
    expect(chatViewOf("claude-code:new")?.lifecycle).toBe("idle");
    const bad = request(api, { cmd: "send", request_id: "r2", session: "claude-code:new", message_id: "m", text: "x" });
    ev({ ev: "error", request_id: "r2", session: "claude-code:new", code: "session_busy", message: "later", fatal: false });
    await expect(bad).rejects.toBe("later");
    expect(chatViewOf("claude-code:new")?.error?.code).toBe("session_busy");
  });

  it("keeps one view per session and folds a `sessions` listing into them", () => {
    ev({ ev: "turn_started", session: "codex:a", turn_id: "t", message_id: "m", text: "hi", images_n: 0 });
    ev({ ev: "text_delta", session: "codex:a", turn_id: "t", text: "yo" });
    ev({ ev: "sessions", sessions: [{ session: "codex:a", lifecycle: "running", model: "gpt", permission_mode: "", queue: [], pending: [], since: 1 }, { session: "claude-code:b", lifecycle: "idle", model: "haiku", permission_mode: "default", queue: [], pending: [], since: 2 }] });
    expect(chatViewOf("codex:a")).toMatchObject({ lifecycle: "running", model: "gpt" });
    expect(chatViewOf("codex:a")?.turns[0].steps[0]).toMatchObject({ kind: "text", text: "yo" });
    expect(chatViewOf("claude-code:b")).toMatchObject({ lifecycle: "idle", model: "haiku" });
  });

  it("a chatd down notice fails every pending request", async () => {
    const { api } = fakeApi();
    const p = request(api, { cmd: "list", request_id: "r3" });
    ev({ ev: "chatd", state: "down", reason: "exited" });
    await expect(p).rejects.toBe("exited");
  });
});

describe("chat store and the sidecar's life", () => {
  it("a chatd that dies ends the open turns, and the next chatd's seq 1 is not taken for a replay", () => {
    ev({ ev: "opened", session: "claude-code:s", agent: "claude-code", cwd: "/p", resumed: false, model: "haiku", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "turn_started", session: "claude-code:s", turn_id: "t1", message_id: "m", text: "hi", images_n: 0 });
    ev({ ev: "text_delta", session: "claude-code:s", turn_id: "t1", text: "po" });
    expect(chatdStatus()).toBe("up");
    ingest({ ev: "chatd", state: "down", reason: "exited", seq: 0, ts: 2 } as ChatEvent);
    const v = chatViewOf("claude-code:s")!;
    expect(chatdStatus()).toBe("down");
    expect(v.lifecycle).toBe("stopped");
    expect(v.turns[0]).toMatchObject({ status: "error", error: "chatd exited" });
    expect(v.turns[0].steps[0]).toMatchObject({ kind: "text", done: true });
    expect(v.seq).toBe(0);
    // The restarted sidecar counts from 1 again.
    ingest({ ev: "chatd", state: "restarting", seq: 0, ts: 3 } as ChatEvent);
    ingest({ ev: "chatd", state: "up", seq: 1, ts: 4 } as ChatEvent);
    expect(chatdStatus()).toBe("up");
    ingest({ ev: "opened", seq: 2, ts: 5, session: "claude-code:s", agent: "claude-code", cwd: "/p", resumed: true, model: "haiku", permission_mode: "default", transcript_path: "", capabilities: [] } as ChatEvent);
    ingest({ ev: "turn_started", seq: 3, ts: 5, session: "claude-code:s", turn_id: "t2", message_id: "m2", text: "again", images_n: 0 } as ChatEvent);
    expect(chatViewOf("claude-code:s")?.lifecycle).toBe("running");
    expect(chatViewOf("claude-code:s")?.turns.map((t) => t.turn_id)).toEqual(["t1", "t2"]);
  });

  it("does not write a command before the listener is attached, so the reply cannot be missed", async () => {
    const sent: ChatCommand[] = [];
    let attach: (off: () => void) => void = () => {};
    let handler: ((e: ChatEvent) => void) | null = null;
    const api: ChatApi = {
      chatAvailable: true,
      chatCommand: async (c) => { sent.push(c); },
      onChatEvent: (cb) => { handler = cb; return new Promise((r) => { attach = r; }); },
      chatRestart: async () => {},
    };
    const release = subscribeChat(api);
    const p = request(api, { cmd: "hello", request_id: "h1" });
    await Promise.resolve();
    expect(sent).toEqual([]);
    attach(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]).toMatchObject({ cmd: "hello", request_id: "h1" });
    handler!({ ev: "hello", seq: 1, ts: 1, request_id: "h1", protocol: 1, chatd_version: "0.1", platform: "darwin", agents: {} } as ChatEvent);
    expect((await p).ev).toBe("hello");
    release();
  });

  it("a host that cannot write the line rejects the request with its message", async () => {
    const api: ChatApi = { chatAvailable: true, chatCommand: async () => { throw new Error("chatd is not running"); }, onChatEvent: async () => () => {}, chatRestart: async () => {} };
    await expect(request(api, { cmd: "list" })).rejects.toBe("chatd is not running");
  });

  it("outside the desktop app chat says it is unavailable instead of throwing", async () => {
    for (const api of [chatUnavailable(), fixtureApi()]) {
      expect(api.chatAvailable).toBe(false);
      await expect(api.chatCommand({ cmd: "hello" })).rejects.toThrow();
      await expect(api.onChatEvent(() => {})).rejects.toThrow();
      await expect(api.chatRestart()).rejects.toThrow();
      expect(subscribeChat(api)).toBeTypeOf("function");
    }
  });
});
