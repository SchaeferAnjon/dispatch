import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { __setPlatformForTests } from "../platform";
import { DEFAULT_SETTINGS } from "../projectFlags";
import { capFromInput, SettingsView, summaryOptionLabel, withSummaryUses, type SummaryProvider } from "./Settings";

const base = { settings: DEFAULT_SETTINGS, onSave: async () => {}, theme: "" as const, onTheme: () => {} };

describe("SettingsView 总结", () => {
  const missing: SummaryProvider = { id: "deepseek:deepseek-chat", provider: "deepseek", label: "deepseek-chat（DeepSeek）", env: "DEEPSEEK_API_KEY", configured: false, model: "deepseek-chat", subscription: false };

  it("reveals the key input when the selected provider has no key yet", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} settings={{ ...DEFAULT_SETTINGS, summary_model: missing.id }} summaryProviders={[missing]} />);
    expect(html).toContain("缺 Key");
    expect(html).toContain('type="password"');
    expect(html).toContain("DEEPSEEK_API_KEY");
    expect(html).toContain("保存 Key");
  });

  it("keeps the key input hidden for configured and subscription providers", () => {
    const configured = { ...missing, id: "zhipu:glm-5.3-flash", provider: "zhipu", label: "glm-5.3-flash（智谱）", configured: true };
    const sub = { ...missing, id: "claude:haiku", provider: "claude", label: "Claude Haiku（订阅）", subscription: true, configured: true };
    expect(summaryOptionLabel(configured)).toContain("已配 Key");
    expect(summaryOptionLabel(sub)).toContain("订阅");
    const html = renderToStaticMarkup(<SettingsView {...base} settings={{ ...DEFAULT_SETTINGS, summary_model: configured.id }} summaryProviders={[configured]} />);
    expect(html).not.toContain('type="password"');
  });

  it("has no acceptance mode or model controls", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    for (const old of ["验收方式", "验收模型", "独立验收", "手动点查", "自动查"]) expect(html).not.toContain(old);
  });

  it("builds the summary_uses patch a toggle saves", () => {
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: { session: 1, project: 1 } }, "project", false).summary_uses).toEqual({ session: 1, project: 0 });
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: { session: 0 } }, "session", true).summary_uses).toEqual({ session: 1 });
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: undefined }, "session", false).summary_uses).toEqual({ session: 0 });
  });
});

describe("SettingsView screen access", () => {
  it("shows the current link and the copy button once it works", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} onScreen={() => {}} screenReady screen={{ url: "https://mac.example.ts.net/vnc.html", up: true, sharing: true, issue: "" }} />);
    expect(html).toContain("屏幕访问");
    expect(html).toContain("https://mac.example.ts.net/vnc.html");
    expect(html).toContain("复制屏幕链接");
  });

  it("names the setup command and the one manual step when nothing is set up", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} onScreen={() => {}} screen={{ url: "", up: false, sharing: false, issue: "这台 Mac 的屏幕共享还没开" }} />);
    expect(html).toContain("dispatch screen setup");
    expect(html).toContain("屏幕共享");
  });
});

describe("SettingsView 机器", () => {
  const hosts = [
    { id: "local", name: "阁楼的 Mac", ip: "100.1.1.1", ssh: "", online: true, local: true, overlay: { kind: "tailscale", ip: "100.1.1.1" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
    { id: "mini", name: "Mac mini", ip: "100.1.1.2", ssh: "user@100.1.1.2", online: true, local: false, overlay: { kind: "tailscale", ip: "100.1.1.2" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
  ];

  it("offers rename for every machine, but delete/redetect only for peers", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} hosts={hosts} onRenameHost={async () => {}} onDeleteHost={async () => {}} onRedetectHost={async () => {}} />);
    expect(html.match(/>改名</g)?.length).toBe(2);
    expect(html).toContain("阁楼的 Mac（本机）");
    expect(html).toContain("Mac mini");
    expect(html.match(/>重新检测</g)?.length).toBe(1);
    expect(html.match(/>删除</g)?.length).toBe(1);
  });

  it("hides the machine actions when no handler is wired", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} hosts={hosts} />);
    expect(html).not.toContain(">改名<");
    expect(html).not.toContain(">删除<");
    expect(html).not.toContain(">重新检测<");
  });
});

describe("SettingsView on Windows", () => {
  const fakeApi = { on: async () => "{}", copy: async () => {} } as unknown as import("../api").Api;
  afterEach(() => __setPlatformForTests(null));
  it("replaces screen access with a one-line note", () => {
    __setPlatformForTests("windows");
    const html = renderToStaticMarkup(<SettingsView {...base} api={fakeApi} onScreen={() => {}} screen={{ url: "https://x/vnc.html", up: true, sharing: true, issue: "" }} />);
    expect(html).toContain("Windows 版暂不支持，Mac 上可用。");
    expect(html).not.toContain("复制屏幕链接");
    expect(html).not.toContain("https://x/vnc.html");
  });
  it("shows shortcuts with Ctrl", () => {
    __setPlatformForTests("windows");
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    expect(html).toContain("Ctrl+K");
    expect(html).not.toContain("⌘K");
  });
  it("keeps ⌘ and the Mac rows on macOS", () => {
    __setPlatformForTests("mac");
    const html = renderToStaticMarkup(<SettingsView {...base} api={fakeApi} onScreen={() => {}} screen={{ url: "", up: false, sharing: false, issue: "" }} />);
    expect(html).toContain("⌘K");
    expect(html).toContain("复制屏幕链接");
    expect(html).not.toContain("Windows 版暂不支持");
  });
});

describe("SettingsView tabs", () => {
  it("has seven tabs with 通用 first and keeps every panel mounted, only the chosen one shown", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    for (const label of ["通用", "会话", "IDE", "手机通知", "环境", "主机", "关于"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('<div class="g" role="tabpanel" aria-label="通用">');
    expect(html).toContain('<div class="g" role="tabpanel" hidden="" aria-label="会话">');
  });

  it("has an IDE tab with Tab completion's cap and the ⌘K model", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    expect(html).toContain('<div class="g" role="tabpanel" hidden="" aria-label="IDE">');
    for (const s of ["Tab 补全", "每天上限", "改写用的模型"]) expect(html).toContain(s);
    for (const s of ["VS Code 服务端", "下载镜像", "自动装语言扩展", "编辑器模式"]) expect(html).not.toContain(s);
    expect(html).toContain('value="0.5"');
  });

  it("offers 外观 as a segmented control; 列表密度 is gone (rows have one height)", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} theme="dark" settings={{ ...DEFAULT_SETTINGS, list_density: "compact" }} />);
    expect(html).toContain('aria-label="外观"');
    expect(html).toContain('<button type="button" role="radio" aria-checked="true" class="on">深色</button>');
    expect(html).not.toContain("列表密度");
  });

  it("puts labels in a right-aligned column, wider outside Chinese", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    expect(html).toContain('<div class="frow"><div class="fk">界面语言</div>');
    expect(html).toContain('class="form"');
  });
});

describe("SettingsView IDE", () => {
  it("never turns the Tab cap off by an empty or half-typed field", () => {
    expect(capFromInput("")).toBeNull();
    expect(capFromInput("  ")).toBeNull();
    expect(capFromInput("abc")).toBeNull();
    expect(capFromInput("0")).toBe(0); // typed on purpose: no cap
    expect(capFromInput("0.75")).toBe(0.75);
    expect(capFromInput("500")).toBe(100);
    expect(capFromInput("-1")).toBe(0);
  });
});
