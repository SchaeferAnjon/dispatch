import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api";
import type { ChatApi, ChatCommand, ChatEvent, LiveTurn } from "../chatProtocol";
import { chatViewOf, ingest, outboxAdd, outboxFail, outboxOf, resetChatStore } from "../chatStore";
import { ChatPage, chatActions, historyBefore, isLiveView, liveKeyOf, liveStatus, resumable, runKey, sendOrResume } from "./ChatPage";
import { ComposerSend, composerKey, planSend } from "./ChatComposer";
import { PermissionBody } from "./PermissionCard";
import { chipSummary, groupTools, headLines } from "./ChatToolChip";
import type { TimelineMsg } from "../types";
import { SessionThread, UserActionContext, stepOf } from "./SessionThread";
import { moveToTerminal } from "./SessionActions";

// A fixture-style Api with the chat half switched on: every command chatd would get is recorded.
// chatStore.request writes once the event listener is attached, one microtask later.
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeApi() {
  const sent: ChatCommand[] = [];
  const chat: ChatApi = { chatAvailable: true, chatCommand: async (c) => { sent.push(c); }, onChatEvent: async () => () => {}, chatRestart: async () => {} };
  const api = { ...chat, on: async () => "{}", copy: async () => {}, openPath: async () => {}, show: async () => null } as unknown as Api;
  return { api, chat, sent };
}
let seq = 0;
const ev = (e: Record<string, unknown>) => ingest({ seq: ++seq, ts: 1000 + seq, ...e } as ChatEvent);
const KEY = "claude-code:0f5c2b1e-aaaa-4bbb-8ccc-123456789abc";
const hosts = [{ id: "mini", name: "小蓝", local: true }] as never[];

// The element tree of a component without hooks, to press one of its buttons the way a click would.
function findButton(node: ReactNode, text: string): ReactElement<{ onClick?: () => void; children?: ReactNode }> | null {
  if (Array.isArray(node)) { for (const n of node) { const f = findButton(n, text); if (f) return f; } return null; }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  const label = (n: ReactNode): string => Array.isArray(n) ? n.map(label).join("") : typeof n === "string" ? n : isValidElement(n) ? label((n.props as { children?: ReactNode }).children) : "";
  if (el.type === "button" && label(el.props.children).includes(text)) return el;
  return findButton(el.props.children, text);
}

function streamTurn() {
  ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/Users/x/Projects/harbor", resumed: false, model: "haiku", permission_mode: "default", transcript_path: "", capabilities: ["allow_session", "set_model", "set_permission_mode", "images_base64", "queue", "commands"] });
  ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "装到手机上", images_n: 0 });
  ev({ ev: "text_delta", session: KEY, turn_id: "t1", text: "找到 15 Pro Max，" });
  ev({ ev: "text_delta", session: KEY, turn_id: "t1", text: "已配对。" });
  ev({ ev: "text_done", session: KEY, turn_id: "t1", text: "找到 15 Pro Max，已配对。" });
  ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "tu1", name: "Bash", kind: "shell", input: { command: "xcrun devicectl list devices" }, summary: "xcrun devicectl list devices" });
  ev({ ev: "permission_request", session: KEY, turn_id: "t1", permission_id: "p1", kind: "command", tool_name: "Bash", input: { command: "xcrun devicectl device install app build/Harbor.ipa" }, summary: "把刚打好的 Release 包装到 15 Pro Max 上", reason: "会往手机上装东西", options: ["allow", "allow_session", "deny"] });
}

// Markdown sanitises through the DOM, which the node test run does not have: text stays text here.
vi.mock("./Markdown", () => ({ Markdown: ({ src, className }: { src: string; className?: string }) => <div className={`md ${className ?? ""}`}>{src}</div>, Linkified: ({ text }: { text: string }) => <>{text}</> }));

beforeEach(() => { vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval }); resetChatStore(); seq = 0; });
afterEach(() => { resetChatStore(); vi.unstubAllGlobals(); });

describe("ChatPage", () => {
  it("draws the streamed text, the tool chip and the permission card from chatd's events", () => {
    streamTurn();
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).not.toContain('class="runin');
    // the reply box's status line: only the state (orange dot while it waits on you); Agent, model, Mac and folder on hover
    expect(html).toMatch(/class="cstat" title="Claude Code · [^"]* · 小蓝 · [^"]*harbor · 在 Dispatch 里跑"><span class="dotc wait"><\/span><span class="cs-now">等你确认<\/span><\/span>/);
    expect(html).toContain("装到手机上");
    expect(html).toContain("找到 15 Pro Max，已配对。");
    expect(html).toContain("xcrun devicectl list devices");
    expect(html).toContain('class="call run"');
    expect(html).toContain("要跑一条命令，等你点头");
    expect(html).toContain("会往手机上装东西");
    expect(html).toContain("允许一次");
    expect(html).toContain("本会话都允许");
    expect(html).toContain("拒绝");
    // Copilot's layout: + , the Agent (plain text, fixed) and the model inside the box; the permission mode and the state on the line under it
    expect(html).toMatch(/class="tools">.*aria-label="添加图片".*<span class="dd txt fixed"[^>]*>.*Claude Code<\/span>.*<select aria-label="模型"/);
    expect(html).toMatch(/class="cstat-row"><span class="cs-l">.*<select aria-label="权限模式".*class="cstat"/);
    // in a running turn with an empty box the send key is the stop key; no second 停止 esc, no 排队发送 on its own row
    expect(html).toMatch(/<button type="button" class="send stop"[^>]*aria-label="停止"/);
    expect(html.match(/aria-label="停止"/g)?.length).toBe(1);
    expect(html).not.toContain("btn ghost stop");
    expect(html).not.toContain("排队发送");
    expect(html).not.toContain("esc 打断");
  });

  it("the send key is a stop key while a turn runs and the box is empty; pressing it sends interrupt", async () => {
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    const onStop = () => void act.interrupt().catch(() => {});
    const onSend = vi.fn();
    const stop = ComposerSend({ running: true, hasText: false, canSend: true, canStop: true, onSend, onStop });
    expect(stop.props.stop).toBe(true);
    expect(stop.props.label).toBe("停止");
    stop.props.onClick();
    await tick();
    expect(sent.map((c) => [c.cmd, "session" in c ? c.session : ""])).toEqual([["interrupt", KEY]]);
    expect(onSend).not.toHaveBeenCalled();
    // typed while it runs: the same key queues the message (the words are in the tooltip), it does not stop
    const queue = ComposerSend({ running: true, hasText: true, canSend: true, canStop: true, onSend, onStop });
    expect(queue.props.stop).toBeFalsy();
    expect(queue.props.label).toBe("排队发送");
    expect(queue.props.title).toContain("排队发送");
    queue.props.onClick();
    expect(onSend).toHaveBeenCalledTimes(1);
    // idle: an arrow that sends, off while the box is empty
    const idle = ComposerSend({ running: false, hasText: false, canSend: true, canStop: true, onSend, onStop });
    expect(idle.props.stop).toBeFalsy();
    expect(idle.props.disabled).toBe(true);
    expect(renderToStaticMarkup(idle)).toMatch(/class="send"[^>]*disabled=""[^>]*aria-label="发送"/);
  });

  it("offers 回到这一轮之前 on a user bubble with a checkpoint, off while that turn runs", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "改 a.py", images_n: 0, checkpoint: "cp-1" });
    const { api } = fakeApi();
    const render = () => renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(render()).toMatch(/<button[^>]*class="lk cp-restore"[^>]*disabled=""[^>]*>.*回到这一轮之前/);
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "success", duration_ms: 5, num_tools: 0 });
    ev({ ev: "turn_started", session: KEY, turn_id: "t2", message_id: "m2", text: "没有快照的一轮", images_n: 0 });
    ev({ ev: "turn_done", session: KEY, turn_id: "t2", status: "success", duration_ms: 5, num_tools: 0 });
    const html = render();
    expect(html.match(/cp-restore/g)?.length).toBe(1);
    expect(html).not.toMatch(/cp-restore"[^>]*disabled/);
    // a later turn runs: the earlier turn's button is off too (the files would change under the agent)
    ev({ ev: "turn_started", session: KEY, turn_id: "t3", message_id: "m3", text: "再改", images_n: 0, checkpoint: "cp-3" });
    const busy = render();
    expect(busy.match(/cp-restore/g)?.length).toBe(2);
    expect(busy.match(/class="lk cp-restore"[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("transcript user messages get the page's action from their text and time", () => {
    const list: TimelineMsg[] = [{ ts: "2026-09-25T10:00:00Z", role: "user", text: "改 a.py", tools: [] }, { ts: "2026-09-25T10:00:05Z", role: "assistant", text: "好", tools: [] }];
    const seen: [string, string][] = [];
    const html = renderToStaticMarkup(<UserActionContext.Provider value={(text, ts) => { seen.push([text, ts]); return <button className="lk cp-restore">回到这一轮之前</button>; }}><SessionThread list={list} /></UserActionContext.Provider>);
    expect(seen).toEqual([["改 a.py", "2026-09-25T10:00:00Z"]]);
    expect(html.match(/cp-restore/g)?.length).toBe(1);
  });

  it("send passes display only when it differs from the text", async () => {
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    void act.send("q\n\n[codebase] a.py:1-2\nx", [], undefined, "@codebase q").catch(() => {});
    void act.send("same", [], undefined, "same").catch(() => {});
    void act.note("用户把项目文件回到了这一轮之前").catch(() => {});
    await tick();
    expect(sent.map((c) => [c.cmd, "display" in c ? c.display : undefined])).toEqual([["send", "@codebase q"], ["send", undefined], ["note", undefined]]);
  });

  it("streams text without a caret; the line at the end says it is writing", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "hi", images_n: 0 });
    ev({ ev: "text_delta", session: KEY, turn_id: "t1", text: "正在写" });
    const { api } = fakeApi();
    const live = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(live).not.toContain("▍");
    expect(live).not.toContain("fin cur");
    // the working line comes after the text, as the last thing in the conversation
    expect(live).toMatch(/正在写.*class="working live".*在写/);
    ev({ ev: "text_done", session: KEY, turn_id: "t1", text: "正在写完了" });
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "success", duration_ms: 1200, num_tools: 0 });
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).not.toContain("fin cur");
    expect(html).toContain("正在写完了");
    expect(html).toContain("发送");
  });

  it("pressing 拒绝 sends a deny for that permission", async () => {
    streamTurn();
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    const card = chatViewOf(KEY)!.permissions.p1;
    const tree = PermissionBody({ card, answers: {}, onPickAnswer: () => {}, onDecide: (d) => void act.permission(card.permission_id, d).catch(() => {}), onAnswer: () => {} });
    findButton(tree, "拒绝")!.props.onClick!();
    await tick();
    expect(sent[sent.length - 1]).toMatchObject({ cmd: "permission", session: KEY, permission_id: "p1", decision: "deny" });
    expect(findButton(tree, "本会话都允许")).not.toBeNull();
    // Codex's command approval without a session-wide option: no middle button.
    expect(findButton(PermissionBody({ card: { ...card, options: ["allow", "deny"] }, answers: {}, onPickAnswer: () => {}, onDecide: () => {}, onAnswer: () => {} }), "本会话都允许")).toBeNull();
  });

  it("a denied card turns into one grey line", () => {
    streamTurn();
    ev({ ev: "permission_resolved", session: KEY, permission_id: "p1", decision: "deny", by: "dispatch" });
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).toContain("你拒绝了这条命令，Agent 在等你的下一句");
    expect(html).not.toContain("允许一次");
  });

  it("esc answers a waiting card first, then stops the turn", async () => {
    streamTurn();
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    const esc = { key: "Escape" };
    const k1 = composerKey(esc, { busy: true, hasText: false, pending: true });
    expect(k1).toBe("deny");
    void runKey(act, k1, chatViewOf(KEY)!).catch(() => {});
    await tick();
    expect(sent[sent.length - 1]).toMatchObject({ cmd: "permission", permission_id: "p1", decision: "deny" });
    ev({ ev: "permission_resolved", session: KEY, permission_id: "p1", decision: "deny", by: "dispatch" });
    const k2 = composerKey(esc, { busy: true, hasText: false, pending: false });
    expect(k2).toBe("interrupt");
    void runKey(act, k2, chatViewOf(KEY)!).catch(() => {});
    await tick();
    expect(sent[sent.length - 1]).toMatchObject({ cmd: "interrupt", session: KEY });
    expect(composerKey(esc, { busy: false, hasText: false, pending: false })).toBeNull();
  });

  it("⌘↵ while the agent runs queues the message; idle it starts a turn", async () => {
    streamTurn();
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    const k = composerKey({ key: "Enter", metaKey: true }, { busy: true, hasText: true, pending: true });
    expect(k).toBe("send");
    void runKey(act, k, chatViewOf(KEY)!, "装完把启动日志也发我一份").catch(() => {});
    await tick();
    expect(sent[sent.length - 1]).toMatchObject({ cmd: "send", session: KEY, text: "装完把启动日志也发我一份", mode: "queue" });
    expect(planSend("好", { lifecycle: "idle" })).toEqual({ kind: "send", text: "好", mode: undefined });
    expect(composerKey({ key: "Enter", shiftKey: true }, { busy: false, hasText: true, pending: false })).toBeNull();
    expect(composerKey({ key: "Enter" }, { busy: true, hasText: false, pending: true })).toBe("allow");
    expect(composerKey({ key: "Enter", shiftKey: true }, { busy: true, hasText: false, pending: true })).toBe("allow_session");
  });

  it("in the text box ⇧↵ stays a new line even with a card waiting, and a question card never takes ↵", async () => {
    const box = { busy: true, hasText: false, pending: true, inBox: true };
    expect(composerKey({ key: "Enter", shiftKey: true }, box)).toBeNull();
    expect(composerKey({ key: "Enter" }, box)).toBe("allow");
    expect(composerKey({ key: "Enter" }, { ...box, question: true })).toBeNull();
    expect(composerKey({ key: "Enter", shiftKey: true }, { busy: true, hasText: false, pending: true, question: true })).toBeNull();
    expect(composerKey({ key: "Escape" }, { ...box, question: true })).toBe("deny");
    // runKey (the page's keys) refuses a plain allow on a question even when asked directly
    streamTurn();
    ev({ ev: "permission_request", session: KEY, turn_id: "t1", permission_id: "q1", kind: "question", tool_name: "AskUserQuestion", input: {}, summary: "Which color?", reason: "", options: ["allow", "deny"], questions: [{ id: "Which color?", text: "Which color?", options: ["red", "blue"] }] });
    ev({ ev: "permission_resolved", session: KEY, permission_id: "p1", decision: "deny", by: "dispatch" });
    const { chat, sent } = fakeApi();
    const act = chatActions(chat, KEY);
    const before = sent.length;
    await runKey(act, "allow", chatViewOf(KEY)!);
    await runKey(act, "allow_session", chatViewOf(KEY)!);
    expect(sent.length).toBe(before);
  });

  it("runs /plan and /model here and passes other commands through", () => {
    expect(planSend("/plan", null)).toEqual({ kind: "mode", mode: "plan" });
    expect(planSend("/model haiku", null)).toEqual({ kind: "model", model: "haiku" });
    expect(planSend("/compact", { lifecycle: "idle" })).toMatchObject({ kind: "send", text: "/compact" });
    expect(planSend("  ", null)).toEqual({ kind: "none" });
  });

  it("shows the queue above the box, at most three", () => {
    streamTurn();
    const queue = [1, 2, 3, 4].map((n) => ({ message_id: `q${n}`, text: `排队的第 ${n} 句`, images_n: 0, at: 1 }));
    ev({ ev: "queue", session: KEY, queue });
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).toContain("排队的第 3 句");
    expect(html).not.toContain("排队的第 4 句");
    expect(html).toContain("还有 1 条在排队");
    expect(html).toContain("改成现在插话");
  });

  it("folds finished calls of one kind in a row into one line; the running one stays its own row", () => {
    const c = (id: string, kind: "shell" | "read" | "edit", status: "done" | "running" = "done") => ({ tool_id: id, name: kind === "shell" ? "Bash" : kind === "read" ? "Read" : "Edit", kind, input: {}, summary: id, status, output: "", truncated: false, started: 0 });
    const ids = (g: ReturnType<typeof groupTools>) => g.map((x) => (Array.isArray(x) ? x.map((y) => y.tool_id) : x.tool_id));
    expect(ids(groupTools([c("r1", "read"), c("r2", "read"), c("r3", "read"), c("g", "edit"), c("b1", "shell"), c("b2", "shell", "running")]))).toEqual([["r1", "r2", "r3"], "g", "b1", "b2"]);
    expect(ids(groupTools([c("r1", "read"), c("e", "edit"), c("r2", "read")]))).toEqual(["r1", "e", "r2"]);
    streamTurn();
    ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: "tu1", ok: true, output: "", truncated: false, exit_code: 0, duration_ms: 10 });
    for (const n of [1, 2, 3]) {
      ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: `r${n}`, name: "Read", kind: "read", input: { file_path: `/Users/x/Projects/harbor/src/f${n}.ts` }, summary: "" });
      ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: `r${n}`, ok: true, output: "x", truncated: false, duration_ms: 10 });
    }
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).toMatch(/class="call grp".*<b>Read<\/b><span class="arg count">3 个文件<\/span>.*<code class="path">f1.ts, f2.ts, f3.ts<\/code>/);
  });

  it("cuts the transcript where the live turns begin and treats a failed replay as not live", () => {
    streamTurn();
    const started = chatViewOf(KEY)!.turns[0].started;
    const msgs = [{ ts: new Date((started - 60) * 1000).toISOString(), role: "user", text: "早先的", tools: [] }, { ts: new Date((started + 2) * 1000).toISOString(), role: "user", text: "装到手机上", tools: [] }] as TimelineMsg[];
    expect(historyBefore(msgs, chatViewOf(KEY)!).map((m) => m.text)).toEqual(["早先的"]);
    expect(liveKeyOf("0f5c2b1e-aaaa-4bbb-8ccc-123456789abc")).toBe(KEY);
    ev({ ev: "error", session: "codex:thread-1", code: "no_such_session", message: "chatd does not hold it", fatal: false });
    expect(isLiveView(chatViewOf("codex:thread-1"))).toBe(false);
    expect(liveKeyOf("thread-1")).toBeNull();
  });

  it("says why when chatd lost the process", () => {
    streamTurn();
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "error", error: "process exited", duration_ms: 10, num_tools: 1 });
    ev({ ev: "error", session: KEY, code: "process_exited", message: "claude 进程退出了（exit 1）", fatal: true });
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).toContain("claude 进程退出了（exit 1）");
    expect(html).not.toContain("在终端里跑");
  });

  it("after chatd went away the page offers to continue here", () => {
    streamTurn();
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "success", duration_ms: 10, num_tools: 1 });
    ingest({ ev: "chatd", state: "down", reason: "app quit", seq: 0, ts: 2000 } as ChatEvent);
    ingest({ ev: "chatd", state: "up", seq: 0, ts: 2001 } as ChatEvent);
    expect(resumable(chatViewOf(KEY) ?? null)).toBe(true);
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html).toContain("在 Dispatch 里接着聊");
    expect(html).not.toContain("Agent 进程退出了");
    expect(html).not.toContain("这段会话现在收不了消息");
    // one only idle-stopped is not offered this way: the next message resumes it by itself
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: true, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "closed", session: KEY, reason: "idle" });
    expect(resumable(chatViewOf(KEY) ?? null)).toBe(false);
  });

  it("a message to a session chatd no longer runs opens it with resume, then sends", async () => {
    streamTurn();
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "success", duration_ms: 10, num_tools: 1 });
    ev({ ev: "closed", session: KEY, reason: "shutdown" });
    const sent: ChatCommand[] = [];
    // chatd answers open with opened, send with turn_started (both carry the request_id)
    const chat: ChatApi = { chatAvailable: true, onChatEvent: async () => () => {}, chatRestart: async () => {}, chatCommand: async (c) => {
      sent.push(c);
      const rid = (c as { request_id?: string }).request_id;
      if (c.cmd === "open") setTimeout(() => ev({ ev: "opened", request_id: rid, session: KEY, agent: "claude-code", cwd: c.cwd, resumed: true, model: "claude-haiku-4-5-20251001", permission_mode: "default", transcript_path: "", capabilities: [] }), 0);
      if (c.cmd === "send") setTimeout(() => ev({ ev: "turn_started", request_id: rid, session: KEY, turn_id: "t2", message_id: c.message_id, text: c.text, images_n: 0 }), 0);
    } };
    await sendOrResume(chat, chatActions(chat, KEY), KEY, "/Users/x/Projects/harbor", "接着来");
    expect(sent.map((c) => c.cmd)).toEqual(["open", "send"]);
    expect(sent[0]).toMatchObject({ cmd: "open", agent: "claude-code", cwd: "/Users/x/Projects/harbor", resume: "0f5c2b1e-aaaa-4bbb-8ccc-123456789abc", model: "haiku", permission_mode: "default" });
    expect(sent[1]).toMatchObject({ cmd: "send", session: KEY, text: "接着来" });
    expect(chatViewOf(KEY)?.lifecycle).toBe("running");
  });

  it("an idle-stopped session a restarted chatd forgot is opened again on no_such_session", async () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "closed", session: KEY, reason: "idle" });
    const sent: string[] = [];
    let first = true;
    const chat: ChatApi = { chatAvailable: true, onChatEvent: async () => () => {}, chatRestart: async () => {}, chatCommand: async (c) => {
      sent.push(c.cmd);
      const rid = (c as { request_id?: string }).request_id;
      if (c.cmd === "send" && first) { first = false; setTimeout(() => ev({ ev: "error", request_id: rid, session: KEY, code: "no_such_session", message: "Dispatch 里没有开着这个会话", fatal: false }), 0); return; }
      if (c.cmd === "open") setTimeout(() => ev({ ev: "opened", request_id: rid, session: KEY, agent: "claude-code", cwd: "/p", resumed: true, model: "", permission_mode: "default", transcript_path: "", capabilities: [] }), 0);
      if (c.cmd === "send") setTimeout(() => ev({ ev: "turn_started", request_id: rid, session: KEY, turn_id: "t9", message_id: c.message_id, text: c.text, images_n: 0 }), 0);
    } };
    await sendOrResume(chat, chatActions(chat, KEY), KEY, "/p", "hi");
    expect(sent).toEqual(["send", "open", "send"]);
  });

  it("the status line no longer carries the desktop switch (it is in the header ⋯); 放回终端 closes the chat and copies the resume command", async () => {
    streamTurn();
    const { api } = fakeApi();
    const html = () => renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    expect(html()).not.toContain("dd where");
    ev({ ev: "turn_done", session: KEY, turn_id: "t1", status: "success", duration_ms: 10, num_tools: 1 });
    expect(html()).not.toMatch(/>desktop</);
    const sent: ChatCommand[] = [];
    const copied: string[] = [];
    const chat: ChatApi = { chatAvailable: true, onChatEvent: async () => () => {}, chatRestart: async () => {}, chatCommand: async (c) => {
      sent.push(c);
      if (c.cmd === "close") setTimeout(() => ev({ ev: "closed", request_id: (c as { request_id?: string }).request_id, session: c.session, reason: "requested" }), 0);
    } };
    const full = { ...chat, copy: async (x: string) => { copied.push(x); }, resumeCmd: async (agent: string, sid: string, cwd: string) => `cd '${cwd}' && ${agent === "codex" ? "codex resume" : "claude --resume"} ${sid}` } as unknown as Api;
    const note = await moveToTerminal(full, chat, { agent: "claude-code", session_id: "0f5c2b1e-aaaa-4bbb-8ccc-123456789abc", cwd: "/Users/x/Projects/harbor" });
    expect(sent).toMatchObject([{ cmd: "close", session: KEY }]);
    expect(copied).toEqual(["cd '/Users/x/Projects/harbor' && claude --resume 0f5c2b1e-aaaa-4bbb-8ccc-123456789abc"]);
    expect(note).toBe("恢复命令已复制，去终端粘贴回车");
    expect(chatViewOf(KEY)?.closed?.reason).toBe("requested");
    expect(html()).not.toContain("desktop</button>");  // no longer Dispatch's
  });

  it("a message is on screen the moment it is sent: 在想 under it, then chatd's turn takes its place", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    const { api } = fakeApi();
    const render = () => renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    outboxAdd({ session: KEY, message_id: "m7", text: "把测试跑一遍", pictures: ["data:image/png;base64,AAAA"], at: 1000, state: "sending", payload: { text: "把测试跑一遍", images: [] } });
    let html = render();
    expect(html).toMatch(/class="msg-pics"><img src="data:image\/png;base64,AAAA".*把测试跑一遍.*class="working live".*在想/);
    // chatd started the turn: the bubble is drawn once, by the turn, with the picture it carried
    ev({ ev: "turn_started", session: KEY, turn_id: "t7", message_id: "m7", text: "把测试跑一遍", images_n: 1 });
    expect(outboxOf(KEY)).toEqual([]);
    html = render();
    expect(html.match(/把测试跑一遍/g)?.length).toBe(1);
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("an agent that is not up yet says 正在启动 Agent; a send that failed says so under the message with 重发", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/p", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "closed", session: KEY, reason: "idle" });
    const { api } = fakeApi();
    const render = () => renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    outboxAdd({ session: KEY, message_id: "m8", text: "接着来", pictures: [], at: 1000, state: "sending", payload: { text: "接着来", images: [] } });
    expect(render()).toMatch(/接着来.*class="working live".*正在启动 Agent/);
    outboxFail(KEY, "m8", "claude 进程退出了（exit 1）");
    const html = render();
    expect(html).toMatch(/class="turn you failed".*接着来.*没发出去：claude 进程退出了（exit 1）.*重发/);
    expect(html).not.toContain("正在启动 Agent");
  });

  it("the send carries the id the page showed the message under", async () => {
    const { chat, sent } = fakeApi();
    void sendOrResume(chat, chatActions(chat, KEY), KEY, "/p", "hi", [], undefined, undefined, undefined, "m-shown").catch(() => {});
    await tick();
    expect(sent[0]).toMatchObject({ cmd: "send", message_id: "m-shown", text: "hi" });
  });

  it("says in a few words what the agent is doing now", () => {
    const chip = (status: "running" | "done", kind: "shell" | "read" = "shell") => ({ tool_id: "a", name: kind === "shell" ? "commandExecution" : "Read", kind, input: kind === "shell" ? { command: "npm test" } : { file_path: "/p/src/a.ts" }, summary: "", status, output: "", truncated: false, started: 0 });
    const turn = (steps: LiveTurn["steps"], tools: LiveTurn["tools"] = {}): LiveTurn => ({ turn_id: "t", message_id: "m", user_text: "", images_n: 0, started: 0, steps, tools, files: [] });
    expect(liveStatus(turn([]), false).label).toBe("在想");
    expect(liveStatus(turn([{ kind: "tool", tool_id: "a" }], { a: chip("running") }), false).label).toBe("第 1 步 · 正在跑 npm test");
    expect(liveStatus(turn([{ kind: "tool", tool_id: "a" }], { a: chip("running", "read") }), false, "/p").label).toBe("第 1 步 · 正在读 src/a.ts");
    expect(liveStatus(turn([{ kind: "tool", tool_id: "a" }, { kind: "text", text: "好", done: false }], { a: chip("done") }), false).label).toBe("在写");
    expect(liveStatus(turn([{ kind: "tool", tool_id: "a" }], { a: chip("running") }), true).label).toBe("等你确认 · 第 1 步");
  });

  it("tool chips say what the call does and cut long output", () => {
    expect(chipSummary({ name: "Read", kind: "read", input: { file_path: "/p/src/a.ts" }, summary: "" }, "/p")).toBe("src/a.ts");
    expect(chipSummary({ name: "Bash", kind: "shell", input: { command: "ls -la" }, summary: "" })).toBe("ls -la");
    const out = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(headLines(out)).toEqual({ shown: Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n"), more: 12 });
  });
});

import { splitStream } from "./ChatPage";
describe("streaming Markdown", () => {
  it("cuts at blank lines outside code fences and keeps the blocks it already cut", () => {
    const src = "# Title\n\npara one\nstill one\n\n```\ncode\n\nmore code\n```\n\nlast";
    const s = splitStream(src);
    expect(s.blocks).toEqual(["# Title\n\n", "para one\nstill one\n\n", "```\ncode\n\nmore code\n```\n\n"]);
    expect(s.blocks.join("") + src.slice(s.start)).toBe(src);
    // growing the same text continues the scan; an edit from the start rescans
    let st = splitStream("");
    for (const ch of src) st = splitStream(st.src + ch, st);
    expect(st.blocks).toEqual(s.blocks);
    expect(splitStream("other\n\ntext", st).blocks).toEqual(["other\n\n"]);
  });

  it("a long streamed reply parses each part about once, not once per delta", () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8) + "\n\n";
    const full = para.repeat(300);  // about 140 KB
    const deltas = Math.ceil(full.length / 53);
    let st = splitStream("");
    let parsed = 0, blocksSeen = 0;
    for (let i = 1; i <= deltas; i++) {
      st = splitStream(full.slice(0, i * 53), st);
      parsed += st.src.length - st.start;                // the tail is parsed again
      for (; blocksSeen < st.blocks.length; blocksSeen++) parsed += st.blocks[blocksSeen].length;  // a new block once
    }
    expect(parsed).toBeLessThan(full.length * 10);  // whole-text re-parsing was about deltas/2 = 1300 x
  });
});

describe("conversation page, Cursor style (design/conversation-cursor)", () => {
  const at = (s: number) => `2026-09-25T10:00:${String(s).padStart(2, "0")}Z`;
  const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ type: "tool_call" as const, id, name, summary: String(extra.summary ?? ""), input: {}, status: "done" as const, result: "", ts: at(1), ...extra });

  it("draws your message as a bubble with no name line, and the agent's turn with no name line either", () => {
    const list: TimelineMsg[] = [
      { ts: at(0), role: "user", text: "读一下 README", tools: [] },
      { ts: at(2), role: "assistant", text: "好", tools: [], blocks: [{ type: "text", text: "好" }] },
    ];
    const html = renderToStaticMarkup(<SessionThread list={list} />);
    expect(html).toMatch(/<div class="tl user"[^>]*><div class="bubble-row">.*读一下 README/);
    expect(html).not.toContain("tl-h");
    expect(html).not.toContain("Claude Code");
  });

  it("folds thinking into one gray line with its first sentence, and drops a signature-only thought", () => {
    const list: TimelineMsg[] = [
      { ts: at(0), role: "user", text: "q", tools: [] },
      { ts: at(1), role: "assistant", text: "", tools: [], blocks: [{ type: "thinking", text: "" }, { type: "thinking", text: "先看目录。\n再读 README。" }, { type: "text", text: "答" }] },
    ];
    const html = renderToStaticMarkup(<SessionThread list={list} />);
    expect(html.match(/class="think"/g)?.length).toBe(1);
    expect(html).toContain('<span class="peek">先看目录。</span>');
    expect(html).not.toContain("内容未记录");
  });

  it("reads a tool call as one line: tool, argument, measure", () => {
    const list: TimelineMsg[] = [
      { ts: at(0), role: "user", text: "q", tools: [] },
      { ts: at(1), role: "assistant", text: "", tools: [], blocks: [tool("r1", "Read", { summary: "README.md", result: "a\nb\nc\n" }), tool("b1", "Bash", { summary: "npm test", status: "error", result: "boom" })] },
    ];
    const html = renderToStaticMarkup(<SessionThread list={list} running={false} />);
    expect(html).toMatch(/<b>Read<\/b><code class="arg">README.md<\/code><span class="sp"><\/span><span class="meta"><span>3 行<\/span>.*class="ic ok"/);
    expect(html).toMatch(/<b class="bad">Bash<\/b><code class="arg">npm test<\/code>.*class="st"><svg class="ic bad"/);
    expect(html).not.toContain("完成");
  });

  it("shows an Esc as a quiet line, not as something you said", () => {
    const html = renderToStaticMarkup(<SessionThread list={[{ ts: at(0), role: "user", text: "[Request interrupted by user]", tools: [] }]} />);
    expect(html).toContain("你打断了这一轮");
    expect(html).not.toContain("bubble-row");
  });

  it("ends a running transcript with 在干活 and the step it is on", () => {
    const list: TimelineMsg[] = [
      { ts: at(0), role: "user", text: "q", tools: [] },
      { ts: at(1), role: "assistant", text: "", tools: [], blocks: [tool("a", "Bash"), { type: "tool_fold", tools: [tool("b", "Read"), tool("c", "Read")] }] },
    ];
    expect(stepOf(list)).toBe(4);
    expect(stepOf([...list, { ts: at(3), role: "user", text: "again", tools: [] }])).toBe(1);
    const html = renderToStaticMarkup(<SessionThread list={list} running />);
    expect(html).toMatch(/class="working".*在干活.*第 4 步/);
    expect(renderToStaticMarkup(<SessionThread list={list} />)).not.toContain('class="working"');
  });

  it("streams thinking open under 思考中, then folds it to 思考了 and its time; the working line counts steps", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/Users/x/Projects/kanban", resumed: false, model: "haiku", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "读 README", images_n: 0 });
    ev({ ev: "thinking_delta", session: KEY, turn_id: "t1", text: "先看目录" });
    const { api } = fakeApi();
    const render = () => renderToStaticMarkup(<ChatPage api={api} session={KEY} hosts={hosts} onHandover={() => {}} />);
    let html = render();
    expect(html).toMatch(/<details class="think live" open="">.*思考中….*先看目录/);
    expect(html).toMatch(/class="working live".*在想/);
    ev({ ev: "thinking_done", session: KEY, turn_id: "t1", text: "先看目录", duration_ms: 1400 });
    ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "a", name: "Bash", kind: "shell", input: { command: "ls" }, summary: "ls" });
    html = render();
    expect(html).toMatch(/<details class="think"><summary>.*思考了 1.4s/);
    expect(html).toMatch(/class="call run".*<b>Bash<\/b><code class="arg shimmer">ls<\/code>.*<span class="st"><span class="spin"><\/span>/);
    expect(html).toMatch(/class="working live".*第 1 步 · 正在跑 ls/);
    expect(html).not.toContain('class="who"');
  });
});
