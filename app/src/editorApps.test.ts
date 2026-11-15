import { beforeEach, describe, expect, it } from "vitest";
import { externalApps, projectFolder, resetAppsCache, sessionFolder } from "./editorApps";

describe("externalApps", () => {
  beforeEach(() => resetAppsCache());
  it("asks the CLI once per root and caches the answer", async () => {
    const calls: string[][] = [];
    const api = { on: async (_h: string, args: string[]) => { calls.push(args); return JSON.stringify({ ok: true, apps: [{ id: "code", label: "VS Code", installed: true }, { id: "cursor", label: "Cursor", installed: false }] }); } };
    expect(await externalApps(api, "/p")).toEqual({ code: true, cursor: false });
    expect(await externalApps(api, "/p")).toEqual({ code: true, cursor: false });
    expect(calls).toEqual([["editor", "apps", "--root", "/p", "--json"]]);
  });
  it("treats a failed probe as unknown", async () => {
    const api = { on: async () => JSON.stringify({ ok: false, error: "io", message: "boom" }) };
    expect(await externalApps(api, "/q")).toEqual({});
  });
});

describe("the folder an editor opens", () => {
  it("is a session's folder without the trailing slash", () => {
    expect(sessionFolder({ cwd: "/Users/x/Projects/harbor/" })).toBe("/Users/x/Projects/harbor");
  });
  it("refuses another Mac's session, no folder, or the home folder", () => {
    expect(sessionFolder({ cwd: "/Users/x/Projects/harbor", remote: true })).toBeNull();
    expect(sessionFolder({ cwd: "" })).toBeNull();
    expect(sessionFolder({ cwd: "/Users/x" })).toBeNull();
    expect(sessionFolder({ cwd: "C:\\Users\\x" })).toBeNull();
  });
  it("is a project's folder with forward slashes, null without one", () => {
    expect(projectFolder("/Users/x/Projects/harbor")).toBe("/Users/x/Projects/harbor");
    expect(projectFolder("C:\\p\\harbor\\")).toBe("C:/p/harbor");
    expect(projectFolder(undefined)).toBeNull();
    expect(projectFolder("~")).toBeNull();
  });
});
