// The parts of the e2e runner that decide without a window: where typing is allowed, when Enter
// would send a message, how a mark's place is put into words.
import { describe, expect, it } from "vitest";
import { focusVerdict, sendsChat } from "./focus.mjs";
import { cheapModel, outOfAllowance, splitNote, whereOnScreen } from "./runner.mjs";
import { windowKind } from "./cdp.mjs";

const editorFile = { tag: "TEXTAREA", classes: ["inputarea"], ancestors: ["view-lines", "monaco-editor", "editor-instance", "editor-group-container"] };
const chatInput = { tag: "TEXTAREA", classes: ["inputarea"], ancestors: ["monaco-editor", "interactive-input-editor", "interactive-input-part"] };

describe("focusVerdict", () => {
  it("refuses an open file, even though Monaco's input is a textarea", () => {
    const v = focusVerdict(editorFile);
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("document");
  });
  it("allows the chat input, the quick pick and plain text boxes", () => {
    expect(focusVerdict(chatInput).ok).toBe(true);
    expect(focusVerdict({ tag: "INPUT", type: "text", ancestors: ["quick-input-widget"] }).ok).toBe(true);
    expect(focusVerdict({ tag: "INPUT", type: "search" }).ok).toBe(true);
    expect(focusVerdict({ tag: "TEXTAREA" }).ok).toBe(true);
  });
  it("refuses no focus, buttons, checkboxes, read-only boxes and frames it cannot see into", () => {
    expect(focusVerdict(null).ok).toBe(false);
    expect(focusVerdict({ tag: "BODY" }).ok).toBe(false);
    expect(focusVerdict({ tag: "BUTTON" }).ok).toBe(false);
    expect(focusVerdict({ tag: "INPUT", type: "checkbox" }).ok).toBe(false);
    expect(focusVerdict({ tag: "INPUT", type: "text", readOnly: true }).ok).toBe(false);
    expect(focusVerdict({ tag: "IFRAME", frame: true }).ok).toBe(false);
  });
  it("find-in-file types a search, not into the file", () => {
    expect(focusVerdict({ tag: "TEXTAREA", ancestors: ["monaco-editor", "find-widget", "editor-instance"] }).ok).toBe(true);
  });
  it("a note on a diff's lines types the note, not into the file", () => {
    const note = { tag: "TEXTAREA", ancestors: ["agent-feedback-input-widget", "overlayWidgets", "overflow-guard", "monaco-editor", "monaco-diff-editor", "editor-instance"] };
    expect(focusVerdict(note).ok).toBe(true);
    expect(sendsChat(note)).toBe(false);
  });
});

describe("Settings › Soul", () => {
  it("its text box takes typing (only its Save button writes the file) and Enter does not send anything", () => {
    const soul = { tag: "DIV", classes: ["native-edit-context"], ancestors: ["overflow-guard", "monaco-editor", "dset-soul-host", "dset-soul-editor"] };
    expect(focusVerdict(soul).ok).toBe(true);
    expect(sendsChat(soul)).toBe(false);
  });
});

describe("EditContext (div.native-edit-context)", () => {
  it("an open file is still refused, the Agents window's chat input is allowed and sends on Enter", () => {
    const file = { tag: "DIV", classes: ["native-edit-context"], ancestors: ["overflow-guard", "monaco-editor", "editor-instance", "editor-group-container"] };
    const chat = { tag: "DIV", classes: ["native-edit-context"], ancestors: ["overflow-guard", "monaco-editor", "sessions-chat-editor", "new-chat-input-area", "chat-input-stack"] };
    expect(focusVerdict(file).ok).toBe(false);
    expect(focusVerdict(chat).ok).toBe(true);
    expect(sendsChat(chat)).toBe(true);
    expect(sendsChat(file)).toBe(false);
  });
});

describe("sendsChat", () => {
  it("is true in a chat input and the Customize Your Agent box, false elsewhere", () => {
    expect(sendsChat(chatInput)).toBe(true);
    expect(sendsChat({ tag: "INPUT", ancestors: ["welcome-prompts-input-row", "welcome-prompts-primary"] })).toBe(true);
    expect(sendsChat({ tag: "INPUT", ancestors: ["dispatch-find-skills-input-row"] })).toBe(false);
    expect(sendsChat(null)).toBe(false);
  });
});

describe("marks", () => {
  it("splits a note into what · where · how", () => {
    expect(splitNote("Tasks 页签 · 右栏顶部 · 点它")).toEqual({ what: "Tasks 页签", where: "右栏顶部", how: "点它" });
    expect(splitNote("只有是什么")).toEqual({ what: "只有是什么", where: "", how: "" });
  });
  it("puts a box's place into words", () => {
    const vp = { w: 1440, h: 900 };
    expect(whereOnScreen({ x: 20, y: 60, w: 100, h: 20 }, vp)).toBe("左侧栏上半");
    expect(whereOnScreen({ x: 1100, y: 44, w: 40, h: 16 }, vp)).toBe("右栏顶部页签");
    expect(whereOnScreen({ x: 600, y: 10, w: 40, h: 16 }, vp)).toBe("标题栏中间");
  });
});

describe("windowKind", () => {
  it("tells the Agents window from the editor", () => {
    expect(windowKind("vscode-file://vscode-app/x/out/vs/sessions/electron-browser/sessions.html")).toBe("agents");
    expect(windowKind("vscode-file://vscode-app/x/out/vs/code/electron-browser/workbench/workbench.html")).toBe("editor");
    // a development build runs from source: its pages are the -dev ones
    expect(windowKind("vscode-file://vscode-app/x/ide/vscode/out/vs/sessions/electron-browser/sessions-dev.html")).toBe("agents");
    expect(windowKind("vscode-file://vscode-app/x/ide/vscode/out/vs/code/electron-browser/workbench/workbench-dev.html")).toBe("editor");
    expect(windowKind("vscode-webview://abc/index.html")).toBe("other");
  });
});

describe("cheapModel", () => {
  const menu = [
    { name: "GLM 5.2", desc: "tokenhub" }, { name: "Claude Haiku 4.5", desc: "Anthropic" },
    { name: "Ling 3.0 Flash Fin Free", desc: "OpenCode Zen" }, { name: "MiMo-V2.6-Flash Free", desc: "OpenCode Zen" },
  ];
  it("takes a free MiMo Flash before another free one, never a paid or Claude model", () => {
    expect(cheapModel(menu, "").name).toBe("MiMo-V2.6-Flash Free");
    expect(cheapModel(menu.slice(0, 2), "")).toBeUndefined();
  });
  it("prefers GLM 5.3 Flash on the Coding Plan, then DeepSeek Flash", () => {
    const more = [...menu, { name: "DeepSeek V4.1 Flash", desc: "DeepSeek" }];
    expect(cheapModel(more).name).toBe("DeepSeek V4.1 Flash");
    expect(cheapModel([...more, { name: "GLM-5.3 Flash", desc: "Z.AI Coding Plan" }]).name).toBe("GLM-5.3 Flash");
    expect(cheapModel([...more, { name: "GLM-5.3-Flash", desc: "tokenhub" }]).name).toBe("DeepSeek V4.1 Flash");
  });
  it("works on plain names too", () => {
    expect(cheapModel(["GLM 5.2", "Nemotron 3.5 Lightning Free", "Ling 3.1 Flash Free"], "")).toBe("Nemotron 3.5 Lightning Free");
  });
  it("takes the free model the suite found answering, by its OpenCode id", () => {
    const more = [...menu, { name: "Nemotron 3.5 Lightning Free", desc: "OpenCode Zen" }];
    expect(cheapModel(more, "opencode/nemotron-3.5-lightning-free").name).toBe("Nemotron 3.5 Lightning Free");
    expect(cheapModel(more, "opencode/mimo-v2.6-flash-free").name).toBe("MiMo-V2.6-Flash Free");
    expect(cheapModel(more, "opencode/not-in-the-menu").name).toBe("MiMo-V2.6-Flash Free");
  });
  it("takes DeepSeek Flash when this Mac's tests run on it, though GLM 5.3 Flash is listed too", () => {
    const mac = [...menu, { name: "GLM-5.3 Flash", desc: "Z.AI Coding Plan" }, { name: "DeepSeek V4.1 Flash", desc: "DeepSeek" }];
    expect(cheapModel(mac, "deepseek/deepseek-flash").name).toBe("DeepSeek V4.1 Flash");
    expect(cheapModel(mac, "").name).toBe("GLM-5.3 Flash");
    expect(cheapModel(["GLM-5.3 Flash", "DeepSeek V4.1 Flash"], "deepseek/deepseek-flash")).toBe("DeepSeek V4.1 Flash");
  });
});

describe("outOfAllowance", () => {
  it("finds the account's own words when an agent ran out of allowance", () => {
    expect(outOfAllowance("Error: (CodexError) You've hit your usage limit. Upgrade to Pro")).toMatch(/^You've hit your usage limit/);
    expect(outOfAllowance("Warning: Codex stopped: this account used up its allowance until 01:29.")).toMatch(/^used up its allowance/);
    expect(outOfAllowance("Claude: You've hit your weekly limit · resets Fri")).toMatch(/weekly limit/);
  });
  it("says nothing about a window without such a notice", () => {
    expect(outOfAllowance("99% used · Fri 08:00 Codex · resets Sat 11:20")).toBe("");
    expect(outOfAllowance("")).toBe("");
  });
});
