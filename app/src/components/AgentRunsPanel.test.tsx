import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatApi, ChatEvent } from "../chatProtocol";
import { ingest, resetChatStore } from "../chatStore";

// xterm needs a real DOM; the panel only writes the agent's output into read-only ones.
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; open() {} loadAddon() {} write() {} dispose() {} reset() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));

const { AgentRunsPanel } = await import("./AgentRunsPanel");

describe("AgentRunsPanel", () => {
  const KEY = "claude-code:0f5c2b1e-aaaa-4bbb-8ccc-123456789abc";
  let seq = 0;
  const ev = (e: Record<string, unknown>) => ingest({ seq: ++seq, ts: Math.floor(Date.now() / 1000), ...e } as ChatEvent);
  const chat: ChatApi = { chatAvailable: true, chatCommand: async () => {}, onChatEvent: async () => () => {}, chatRestart: async () => {} };
  beforeEach(() => { vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval }); resetChatStore(); seq = 0; });
  afterEach(() => { resetChatStore(); vi.unstubAllGlobals(); });
  const base = { collapsed: false, onToggle: () => {} };

  it("opens no terminal: without a session it says what it shows", () => {
    const html = renderToStaticMarkup(<AgentRunsPanel {...base} session={null} chat={null} />);
    expect(html).toContain("命令");
    expect(html).toContain("输出");
    expect(html).toContain("这段会话现在不在 Dispatch 里跑");
    expect(html).not.toContain("新终端");
    expect(html).not.toContain('class="xt"');
  });

  it("lists the agent's shell commands as read-only rows, running green and finished grey", () => {
    ev({ ev: "opened", session: KEY, agent: "claude-code", cwd: "/Users/x/proj", resumed: false, model: "", permission_mode: "default", transcript_path: "", capabilities: [] });
    ev({ ev: "turn_started", session: KEY, turn_id: "t1", message_id: "m1", text: "go", images_n: 0 });
    ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "b1", name: "Bash", kind: "shell", input: { command: "npm test" }, summary: "npm test" });
    ev({ ev: "tool_end", session: KEY, turn_id: "t1", tool_id: "b1", ok: true, output: "ok\n", truncated: false, exit_code: 0, duration_ms: 1200 });
    ev({ ev: "tool_start", session: KEY, turn_id: "t1", tool_id: "b2", name: "Bash", kind: "shell", input: { command: "xcodebuild -scheme A" }, summary: "xcodebuild" });
    const html = renderToStaticMarkup(<AgentRunsPanel {...base} session={KEY} chat={chat} />);
    expect(html).toMatch(/Agent · npm test<\/span><span class="dotc gray"/);
    expect(html).toMatch(/Agent · xcodebuild<\/span><span class="dotc"/);
    expect(html).toContain('class="xt ro"');
    // the collapsed strip still says what the agent is running
    const strip = renderToStaticMarkup(<AgentRunsPanel {...base} collapsed session={KEY} chat={chat} />);
    expect(strip).toContain("panel tpanel min");
    expect(strip).toContain("Agent · xcodebuild 在跑");
  });
});
