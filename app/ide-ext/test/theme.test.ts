// Dispatch Light / Dark: generated from styles.css by app/scripts/gen-ide-theme.mjs (5A.2).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without types
import { generate, generateInitialColors, INITIAL, oklchToRgb, parseColor, readTokens, TABLE, toHex } from "../../scripts/gen-ide-theme.mjs";

const ext = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.resolve(ext, "../src/styles.css"), "utf8");
const files = generate(css) as Record<string, string>;
const light = JSON.parse(files["dispatch-light.json"]);
const dark = JSON.parse(files["dispatch-dark.json"]);
const tokens = readTokens(css) as { light: Record<string, string>; dark: Record<string, string> };
const hexOf = (kind: "light" | "dark", name: string) => { const c = parseColor(tokens[kind][name], tokens[kind]); return toHex(c.rgb, c.alpha); };

describe("gen-ide-theme", () => {
  it("covers every key of the 5A.2 table in both themes, all as #rrggbb[aa]", () => {
    for (const theme of [light, dark]) {
      for (const k of Object.keys(TABLE)) expect(theme.colors[k], k).toBeDefined();
      for (const [k, v] of Object.entries(theme.colors)) expect(v, k).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
      for (const t of theme.tokenColors) expect(t.settings.foreground).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect([light.name, light.type, dark.name, dark.type]).toEqual(["Dispatch Light", "light", "Dispatch Dark", "dark"]);
  });

  it("maps the faces to the tokens: editor --bg, shell --bg-2, selection --sel, text two greys, no borders", () => {
    expect(light.colors["editor.background"]).toBe("#ffffff");
    expect(dark.colors["editor.background"]).toBe("#0c0a09");
    for (const k of ["sideBar.background", "activityBar.background", "titleBar.activeBackground", "statusBar.background", "panel.background"]) {
      expect(light.colors[k], k).toBe("#fafaf9");
      expect(dark.colors[k], k).toBe("#1c1917");
    }
    expect(dark.colors["list.activeSelectionBackground"]).toBe("#292524");
    expect(dark.colors["list.hoverBackground"]).toBe("#29252499"); // --sel at 60%
    expect([light.colors["descriptionForeground"], dark.colors["descriptionForeground"]]).toEqual(["#79716b", "#a6a09b"]);
    for (const k of ["sideBar.border", "panel.border", "widget.border", "editorGroup.border", "titleBar.border", "statusBar.border", "activityBar.border"]) {
      expect(dark.colors[k], k).toBe("#00000000");
    }
    expect(dark.colors["input.background"]).toBe("#ffffff0b"); // --chip-2: white 4.5%
    expect([light.colors["button.background"], dark.colors["button.background"]]).toEqual(["#252525", "#fafaf9"]);
  });

  it("converts oklch and color-mix like the browser does (within a step)", () => {
    // Tailwind green-700 oklch(0.527 0.154 150.069) is #008236
    expect(toHex(oklchToRgb(0.527, 0.154, 150))).toMatch(/^#0082(35|36)$/);
    expect(light.colors["gitDecoration.addedResourceForeground"]).toBe(hexOf("light", "green"));
    expect(dark.colors["diffEditor.insertedTextBackground"]).toBe(hexOf("dark", "green") + "1f"); // 12%
    expect(dark.colors["focusBorder"]).toBe("#fafaf94d"); // --ring: --fill 30%, dark --fill
  });

  it("keeps the terminal a black command block in both themes", () => {
    expect(light.colors["terminal.background"]).toBe(hexOf("light", "term-bg"));
    expect(light.colors["terminal.foreground"]).toBe("#fafaf9");
    expect(light.colors["terminal.ansiRed"]).toBe(dark.colors["terminal.ansiRed"]);
  });

  it("writes the IDE defaults with --mono and the 5A.2 keys", () => {
    const d = JSON.parse(files["ide-defaults.json"]);
    expect(d.settings["editor.fontFamily"]).toBe(tokens.light.mono);
    expect(d.settings).toMatchObject({ "editor.fontSize": 13, "editor.lineHeight": 20, "workbench.iconTheme": "vs-minimal", "window.titleBarStyle": "custom", "workbench.activityBar.location": "default", "window.commandCenter": true });
    expect(d.replaces).toEqual({ "window.commandCenter": false, "sessions.developerJoy.enabled": false });
    expect(d.agents["sessions.developerJoy.enabled"]).toBe(true);
    expect(d.theme).toMatchObject({ "window.autoDetectColorScheme": true, "workbench.preferredLightColorTheme": "Dispatch Light", "workbench.preferredDarkColorTheme": "Dispatch Dark" });
  });

  it("the committed files are what styles.css generates now (run node app/scripts/gen-ide-theme.mjs)", () => {
    for (const [name, text] of Object.entries(files)) expect(fs.readFileSync(path.join(ext, "themes", name), "utf8"), name).toBe(text);
  });

  it("the IDE paints a window's first frame in these colours: its copy is what styles.css generates now", () => {
    const text = generateInitialColors(css) as string;
    expect(fs.readFileSync(INITIAL, "utf8")).toBe(text);
    for (const theme of [light, dark]) expect(text).toContain(`'${theme.name}': {\n\t\ttype: '${theme.type}',`);
    expect(text).toContain(`'statusBar.background': '${dark.colors["statusBar.background"]}',`);
    expect(text).toContain("export function dispatchFallbackTheme(scheme: string): string");
  });

  it("leaves none of VS Code's own blues where a key falls back to its default", () => {
    const vscodeBlues = ["#007acc", "#0078d4", "#007fd4", "#75beff", "#3399cc", "#0e639c", "#1b81a8", "#2677cb", "#40a6ff", "#179fff", "#0431fa", "#0b216f", "#236b8e"];
    const keys = ["focusBorder", "statusBar.background", "statusBar.noFolderBackground", "statusBar.debuggingBackground", "statusBarItem.remoteBackground",
      "button.background", "progressBar.background", "textLink.foreground", "inputOption.activeBorder", "chat.workingProgressStableIconForeground",
      "tab.activeModifiedBorder", "symbolIcon.variableForeground", "debugIcon.continueForeground", "terminalCommandDecoration.successBackground",
      "editorGroup.dropBackground", "sideBar.dropBackground", "merge.incomingContentBackground", "editorLightBulbAutoFix.foreground",
      "editorBracketHighlight.foreground3", "chart.line"];
    for (const theme of [light, dark]) {
      for (const k of keys) expect(theme.colors[k], `${theme.name} ${k}`).toBeDefined();
      for (const [k, v] of Object.entries(theme.colors as Record<string, string>)) expect(vscodeBlues, `${theme.name} ${k}`).not.toContain(v.slice(0, 7));
    }
  });

  it("the manifest registers both themes at those paths", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));
    const themes = pkg.contributes.themes as { label: string; uiTheme: string; path: string }[];
    expect(themes.map((t) => [t.label, t.uiTheme])).toEqual([["Dispatch Light", "vs"], ["Dispatch Dark", "vs-dark"]]);
    for (const t of themes) expect(fs.existsSync(path.join(ext, t.path)), t.path).toBe(true);
  });
});
