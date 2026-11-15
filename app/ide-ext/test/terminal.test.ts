import { describe, expect, it } from "vitest";
import { shapeGhostty, terminalArgs } from "../src/core/terminal";

describe("dispatch.terminal arguments", () => {
  it("accepts its requests and nothing else", () => {
    expect(terminalArgs("agents")).toEqual(["terminal", "agents", "--json"]);
    expect(terminalArgs("daemon", undefined, "/A/Contents/Resources/app")).toEqual(["terminal", "daemon", "start", "--json", "--app-root", "/A/Contents/Resources/app"]);
    expect(terminalArgs("daemon", { ifKept: true })).toEqual(["terminal", "daemon", "start", "--json", "--if-kept"]);
    expect(terminalArgs("snippets")).toEqual(["terminal", "snippets", "list", "--json"]);
    expect(terminalArgs("snippets", { op: "add", name: "Tests", text: "Run them; fix -rf" })).toEqual(["terminal", "snippets", "add", "--json", "--name=Tests", "--text=Run them; fix -rf"]);
    expect(terminalArgs("snippets", { op: "rm -rf /" })).toEqual(["terminal", "snippets", "list", "--json"]);
    expect(terminalArgs("snippets", { op: "remove", id: "abc" })).toEqual(["terminal", "snippets", "remove", "--json", "--id=abc"]);
    expect(terminalArgs("ghostty")).toEqual(["terminal", "ghostty", "--json"]);
    expect(terminalArgs("rm -rf")).toBeUndefined();
    expect(terminalArgs(undefined)).toBeUndefined();
  });
});

describe("the Ghostty answer", () => {
  it("passes the four settings and the terminal colors", () => {
    const r = shapeGhostty({
      found: true,
      paths: ["/h/.config/ghostty/config"],
      summary: { font: "JetBrains Mono", size: 14, theme: "Nord", cursor: "bar" },
      settings: { "terminal.integrated.fontFamily": "JetBrains Mono", "terminal.integrated.fontSize": 14, "terminal.integrated.cursorStyle": "line", "terminal.integrated.cursorBlinking": false },
      colors: { "terminal.background": "#101010", "terminal.ansiRed": "#ff0000" },
      colors_by_scheme: null,
      left_out: ["keybind"],
    });
    expect(r.found).toBe(true);
    expect(r.settings).toEqual({ "terminal.integrated.fontFamily": "JetBrains Mono", "terminal.integrated.fontSize": 14, "terminal.integrated.cursorStyle": "line", "terminal.integrated.cursorBlinking": false });
    expect(r.colors).toEqual({ "terminal.background": "#101010", "terminal.ansiRed": "#ff0000" });
    expect(r.colors_by_scheme).toBeNull();
    expect(r.summary?.theme).toBe("Nord");
  });

  it("drops anything that is not one of those, so a setting like the shell cannot ride along", () => {
    const r = shapeGhostty({
      found: true,
      paths: [],
      settings: { "terminal.integrated.shell.osx": "/bin/evil", "terminal.integrated.fontSize": 12, "editor.fontSize": 99 },
      colors: { "terminal.background": "red", "workbench.statusBar.background": "#000000", "terminal.foreground": "#ffffff" },
    });
    expect(r.settings).toEqual({ "terminal.integrated.fontSize": 12 });
    expect(r.colors).toEqual({ "terminal.foreground": "#ffffff" });
  });

  it("keeps a light and a dark set when the theme is a pair", () => {
    const r = shapeGhostty({ found: true, paths: [], colors: {}, colors_by_scheme: { light: { "terminal.background": "#ffffff" }, dark: { "terminal.background": "#000000" } } });
    expect(r.colors_by_scheme).toEqual({ light: { "terminal.background": "#ffffff" }, dark: { "terminal.background": "#000000" } });
  });

  it("says not found for nothing, an error or garbage", () => {
    expect(shapeGhostty({ found: false, paths: [] }).found).toBe(false);
    expect(shapeGhostty(null).found).toBe(false);
    expect(shapeGhostty("x").found).toBe(false);
  });
});
