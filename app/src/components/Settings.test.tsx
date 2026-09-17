import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../projectFlags";
import { SettingsView, summaryOptionLabel, withSummaryUses, type SummaryProvider } from "./Settings";

const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1z"/></svg>';
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

  it("builds the summary_uses patch a toggle saves", () => {
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: { session: 1, project: 1 } }, "project", false).summary_uses).toEqual({ session: 1, project: 0 });
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: { session: 0 } }, "session", true).summary_uses).toEqual({ session: 1 });
    expect(withSummaryUses({ ...DEFAULT_SETTINGS, summary_uses: undefined }, "session", false).summary_uses).toEqual({ session: 0 });
  });
});

describe("SettingsView phone access", () => {
  // The QR and the copy-link button now come from PhoneAccess, after it has asked `serve status`
  // (a QR for an address nothing answers on only gives the phone 「无法连接」).
  const fakeApi = { on: async () => "{}", copy: async () => {} } as unknown as import("../api").Api;
  it("asks the service for its state before offering a QR", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} api={fakeApi} onPhone={() => {}} phoneQr={QR} />);
    expect(html).toContain("手机访问");
    expect(html).toContain("正在检查手机访问");
    expect(html).not.toContain('class="settings-qr"');
  });

  it("lets the user pick which Mac the phone version runs on", () => {
    const phoneHost = { phone_host: "living-room-mini", hosts: [{ id: "local", name: "书房的 Mac", local: true }, { id: "living-room-mini", name: "客厅的 Mac mini", local: false }] };
    const html = renderToStaticMarkup(<SettingsView {...base} api={fakeApi} onPhone={() => {}} phoneQr={QR} phoneHost={phoneHost} onPhoneHost={() => {}} />);
    expect(html).toContain("手机版跑在");
    expect(html).toContain("本机（书房的 Mac）");
    expect(html).toContain('<option value="living-room-mini" selected="">客厅的 Mac mini</option>');
  });

  it("hides the machine picker when this Mac is the only one", () => {
    const phoneHost = { phone_host: "local", hosts: [{ id: "local", name: "书房的 Mac", local: true }] };
    const html = renderToStaticMarkup(<SettingsView {...base} onPhone={() => {}} phoneQr={QR} phoneHost={phoneHost} onPhoneHost={() => {}} />);
    expect(html).not.toContain("手机版跑在");
  });

  it("keeps the row hidden when there is neither a QR nor a copy link", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} />);
    expect(html).not.toContain("手机访问");
    expect(html).not.toContain("settings-qr");
  });
});

describe("SettingsView screen access", () => {
  it("shows the current link and a re-configure button once it works", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} onScreen={() => {}} screenReady screen={{ url: "https://mac.example.ts.net/vnc.html", up: true, sharing: true, issue: "" }} onScreenSetup={async () => null} />);
    expect(html).toContain("屏幕访问");
    expect(html).toContain("https://mac.example.ts.net/vnc.html");
    expect(html).toContain("重新配置");
    expect(html).toContain("复制屏幕链接");
  });

  it("offers 配置 and names the one manual step when nothing is set up", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} onScreen={() => {}} screen={{ url: "", up: false, sharing: false, issue: "这台 Mac 的屏幕共享还没开" }} onScreenSetup={async () => null} />);
    expect(html).toContain(">配置<");
    expect(html).toContain("屏幕共享");
  });
});

describe("SettingsView 机器", () => {
  const hosts = [
    { id: "local", name: "书房的 Mac", ip: "100.1.1.1", ssh: "", online: true, local: true, overlay: { kind: "tailscale", ip: "100.1.1.1" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
    { id: "mini", name: "Mac mini", ip: "100.1.1.2", ssh: "user@100.1.1.2", online: true, local: false, overlay: { kind: "tailscale", ip: "100.1.1.2" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
  ];

  it("offers rename for every machine, but delete/redetect only for peers", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} hosts={hosts} onRenameHost={async () => {}} onDeleteHost={async () => {}} onRedetectHost={async () => {}} />);
    expect(html.match(/>改名</g)?.length).toBe(2);
    expect(html).toContain("书房的 Mac（本机）");
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
