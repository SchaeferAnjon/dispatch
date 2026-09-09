import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../projectFlags";
import { SettingsView } from "./Settings";

const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1z"/></svg>';
const base = { settings: DEFAULT_SETTINGS, onSave: async () => {}, theme: "" as const, onTheme: () => {} };

describe("SettingsView phone access", () => {
  it("shows the CLI QR next to the copy link", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} onPhone={() => {}} phoneQr={QR} />);
    expect(html).toContain("手机访问");
    expect(html).toContain('class="settings-qr"');
    expect(html).toContain("<svg");
    expect(html).toContain("复制链接");
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
    { id: "local", name: "大哥", ip: "100.1.1.1", ssh: "", online: true, local: true, overlay: { kind: "tailscale", ip: "100.1.1.1" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
    { id: "mini", name: "Mac mini", ip: "100.1.1.2", ssh: "user@100.1.1.2", online: true, local: false, overlay: { kind: "tailscale", ip: "100.1.1.2" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "" as const, why: "" },
  ];

  it("offers rename for every machine, but delete/redetect only for peers", () => {
    const html = renderToStaticMarkup(<SettingsView {...base} hosts={hosts} onRenameHost={async () => {}} onDeleteHost={async () => {}} onRedetectHost={async () => {}} />);
    expect(html.match(/>改名</g)?.length).toBe(2);
    expect(html).toContain("大哥（本机）");
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
