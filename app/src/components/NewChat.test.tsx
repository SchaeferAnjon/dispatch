import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api";
import type { ChatApi, ChatCommand, ChatEvent } from "../chatProtocol";
import { ingest, resetChatStore } from "../chatStore";
import { DEFAULT_SETTINGS } from "../projectFlags";
import { UNGROUPED_PROJECT } from "../activity";
import { NewChat, startInDispatch } from "./NewChat";
import { middlePath, placeItems } from "./PlacePicker";

let seq = 0;
// A fixture-style Api whose chatd answers `open` with `opened` and `send` with `turn_started`.
function fakeApi() {
  const sent: ChatCommand[] = [];
  const chat: ChatApi = {
    chatAvailable: true,
    chatCommand: async (c) => {
      sent.push(c);
      const reply = (e: Record<string, unknown>) => queueMicrotask(() => ingest({ seq: ++seq, ts: 1, request_id: c.request_id, ...e } as ChatEvent));
      if (c.cmd === "open") reply({ ev: "opened", session: "claude-code:new-1", agent: c.agent, cwd: c.cwd, resumed: false, model: c.model ?? "", permission_mode: c.permission_mode ?? "default", transcript_path: "", capabilities: ["images_base64"] });
      if (c.cmd === "send") reply({ ev: "turn_started", session: c.session, turn_id: "t1", message_id: c.message_id, text: c.text, images_n: 0 });
    },
    onChatEvent: async () => () => {},
    chatRestart: async () => {},
  };
  const api = { ...chat, on: async () => "{}", show: async () => null, create: async () => ({ id: "task-new1" }) } as unknown as Api;
  return { api, chat, sent };
}
const hosts = [{ id: "mini", name: "小蓝", local: true, online: true }] as never[];
const base = { hosts, issues: [], projects: [{ name: "harbor", dir: "/Users/x/Projects/harbor" }], projectOfDir: () => "harbor", sessions: [], onBack: () => {}, onStarted: () => {}, onOtherFolder: () => {}, onComputer: () => {} };

beforeEach(() => { vi.stubGlobal("window", { setTimeout, clearTimeout }); resetChatStore(); seq = 0; });
afterEach(() => { resetChatStore(); vi.unstubAllGlobals(); });

describe("new chat v3", () => {
  it("starting in Dispatch sends open, then the first message to the new session", async () => {
    const { chat, sent } = fakeApi();
    const key = await startInDispatch(chat, { agent: "claude-code", cwd: "/Users/x/Projects/harbor", model: "haiku", permission_mode: "default", task: "task-new1" }, "Reply with exactly: pong");
    expect(key).toBe("claude-code:new-1");
    expect(sent.map((c) => c.cmd)).toEqual(["open", "send"]);
    expect(sent[0]).toMatchObject({ cmd: "open", agent: "claude-code", cwd: "/Users/x/Projects/harbor", model: "haiku", task: "task-new1" });
    expect(sent[1]).toMatchObject({ cmd: "send", session: "claude-code:new-1", text: "Reply with exactly: pong" });
    expect((sent[1] as { images?: unknown }).images).toBeUndefined();
  });

  it("an empty model or task is left out of open", async () => {
    const { chat, sent } = fakeApi();
    await startInDispatch(chat, { agent: "claude-code", cwd: "/p", model: "", task: "" }, "hi");
    expect(sent[0]).not.toHaveProperty("model", "");
    expect((sent[0] as { task?: string }).task).toBeUndefined();
  });

  it("the page offers 发送并启动 and no terminal", () => {
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<NewChat {...base} api={api} />);
    expect(html).toContain("发送并启动");
    expect(html).not.toContain("在终端里");
    // Copilot's new session: no greeting, no quick cards, no recent folders
    for (const gone of ['class="hero"', "qcard", 'class="recent"', "项目对话"]) expect(html).not.toContain(gone);
    // two chips over the box (folder, Agent), the model inside next to +, the round send key
    expect(html).toMatch(/class="ns-chips"><span class="pp"><button[^>]*aria-label="项目或文件夹".*<select aria-label="Agent"/);
    expect(html).toMatch(/class="tools">.*aria-label="添加图片".*<select aria-label="模型".*<button type="button" class="send"[^>]*aria-label="发送并启动"/);
    // one gray line under the box: 权限 and 顺手建任务 on the left, 新工作树 on the right; one Mac, so no host picker
    expect(html).toMatch(/class="cstat-row"><span class="cs-l">.*aria-label="权限模式".*顺手建任务.*<span class="cs-r"><label class="cs-wt"[^>]*><input type="checkbox"\/>新工作树/);
    expect(html).not.toContain('aria-label="主机"');
    expect(renderToStaticMarkup(<NewChat {...base} api={api} worktree />)).toContain('<input type="checkbox" checked=""/>新工作树');
    const two = [...hosts, { id: "mbp", name: "MacBook", local: false, online: true }] as never[];
    expect(renderToStaticMarkup(<NewChat {...base} hosts={two} api={api} />)).toContain('aria-label="主机"');
  });

  it("this Mac has no in-app chat on the web page and says so", () => {
    const { api } = fakeApi();
    const html = renderToStaticMarkup(<NewChat {...base} api={api} />);
    expect(html).not.toContain("在终端里");
    expect(html).toContain("应用内聊天只在电脑上的 Dispatch 里可用");
  });

  it("one chip for the place: the project of a folder inside it, the folder's name outside any, no project list", () => {
    const { api } = fakeApi();
    const chip = (cwd: string, projectOfDir: (d: string) => string) => {
      const html = renderToStaticMarkup(<NewChat {...base} projectOfDir={projectOfDir} api={api} initial={{ cwd }} />);
      expect(html).not.toContain('aria-label="项目"');
      expect(html).not.toContain("<optgroup");
      expect(html).not.toContain('value="p:harbor"');
      const m = html.match(/<button[^>]*aria-label="项目或文件夹"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<span class="v">([^<]*)</);
      expect(m?.[1]).toBe(cwd);
      return m?.[2];
    };
    expect(chip("/Users/x/Projects/harbor/app", () => "harbor")).toBe("harbor");
    expect(chip("/Users/x/Downloads/scratch", () => UNGROUPED_PROJECT)).toBe("scratch");
  });

  it("the popover lists projects, then folders no project owns, and the search filters by name and path", () => {
    const projects = [{ name: "harbor", dir: "/Users/x/Projects/harbor" }, { name: "kanban", dir: "/Users/x/Projects/kanban" }];
    const folders = ["/Users/x/Projects/kanban", "/Users/x/Downloads/scratch", "", "/Users/x/Downloads/scratch"];
    expect(placeItems(projects, folders, "").map((i) => `${i.kind}:${i.name}`)).toEqual(["project:harbor", "project:kanban", "folder:scratch"]);
    expect(placeItems(projects, folders, "KAN").map((i) => i.name)).toEqual(["kanban"]);
    expect(placeItems(projects, folders, "downloads").map((i) => i.name)).toEqual(["scratch"]);
    expect(placeItems(projects, folders, "nope")).toEqual([]);
    // folders Agents only pass through stay out, unless one is where this page already is
    const probe = { name: "permprobe", dir: "/private/tmp/claude-501/x/scratchpad/permprobe" };
    expect(placeItems([...projects, probe], ["/Users/x/Projects/kanban", "/tmp/y"], "").map((i) => i.name)).toEqual(["harbor", "kanban"]);
    expect(placeItems(projects, ["/tmp/y"], "").map((i) => i.name)).toEqual(["harbor", "kanban", "y"]);
    const long = middlePath("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/河湾大学/Study Project", 40);
    expect(long.length).toBe(40);
    expect(long).toMatch(/^~\/Library.*….*Study Project$/);
  });
});
