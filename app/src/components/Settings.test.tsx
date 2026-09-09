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
