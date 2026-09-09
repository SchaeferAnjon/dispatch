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
