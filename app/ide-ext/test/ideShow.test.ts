import { describe, expect, it } from "vitest";
import { parseBrowserRequest, parseShowRequest, requestFiles } from "../src/core/ideShow";

const now = 1_790_000_000;
const req = (o: Record<string, unknown>) => JSON.stringify({ id: "a1b2c3d4e5f6", target: "/Users/me/design/x/index.html", session: "", at: now, ...o });

describe("ide show requests", () => {
  it("takes a file path or a URL", () => {
    expect(parseShowRequest(req({}), now)).toEqual({ id: "a1b2c3d4e5f6", target: "/Users/me/design/x/index.html", session: "", task: "", at: now });
    expect(parseShowRequest(req({ task: "task-w6em" }), now)?.task).toBe("task-w6em");
    expect(parseShowRequest(req({ task: "$(touch x)" }), now)?.task).toBe("");
    expect(parseShowRequest(req({ target: "https://example.com/a" }), now)?.target).toBe("https://example.com/a");
    expect(parseShowRequest(req({ session: "claude:/6236a956-274b" }), now)?.session).toBe("claude:/6236a956-274b");
  });

  it("refuses what it should not open", () => {
    expect(parseShowRequest("not json", now)).toBeUndefined();
    expect(parseShowRequest(req({ target: "relative/x.md" }), now)).toBeUndefined();
    expect(parseShowRequest(req({ target: "javascript:alert(1)" }), now)).toBeUndefined();
    expect(parseShowRequest(req({ target: "/a\n/b" }), now)).toBeUndefined();
    expect(parseShowRequest(req({ id: "../../etc" }), now)).toBeUndefined();
    expect(parseShowRequest(req({ session: "rm -rf /" }), now)).toBeUndefined();
  });

  it("ignores a stale request", () => {
    expect(parseShowRequest(req({ at: now - 120 }), now)).toBeUndefined();
    expect(parseShowRequest(req({ at: now - 5 }), now)).toBeDefined();
  });

  it("lists only request files, in order", () => {
    expect(requestFiles(["b2.json", "a1b2c3d4e5f6.json", "ffffff00.json.taking-12", "0a0a0a0a.done", "0a0a0a0a0a.json"])).toEqual(["0a0a0a0a0a.json", "a1b2c3d4e5f6.json"]);
  });
});

const breq = (args: Record<string, unknown>, o: Record<string, unknown> = {}) => JSON.stringify({ id: "b1b2c3d4e5f6", kind: "browser", args, at: now, ...o });

describe("dispatch browser --ide requests", () => {
  it("takes the actions the terminal sends", () => {
    expect(parseBrowserRequest(breq({ action: "open", url: "https://example.com", engine: "claude" }), now)).toEqual({ id: "b1b2c3d4e5f6", args: { action: "open", url: "https://example.com", engine: "claude" }, at: now });
    expect(parseBrowserRequest(breq({ action: "type", selector: "text=Email >> nth=0", text: "me@example.com", submit: true }), now)?.args).toEqual({ action: "type", selector: "text=Email >> nth=0", text: "me@example.com", submit: true });
    expect(parseBrowserRequest(breq({ action: "click", ref: "e12", element: "Sign in" }), now)?.args.ref).toBe("e12");
    expect(parseBrowserRequest(breq({ action: "status" }), now)?.args).toEqual({ action: "status" });
  });

  it("refuses what is not one", () => {
    expect(parseBrowserRequest(breq({ action: "eval" }), now)).toBeUndefined();
    expect(parseBrowserRequest(breq({ action: "open", url: "javascript:alert(1)" }), now)).toBeUndefined();
    expect(parseBrowserRequest(breq({ action: "go" }), now)).toBeUndefined();
    expect(parseBrowserRequest(breq({ action: "read" }, { at: now - 120 }), now)).toBeUndefined();
    expect(parseBrowserRequest(breq({ action: "read" }, { id: "../x" }), now)).toBeUndefined();
    expect(parseBrowserRequest(JSON.stringify({ id: "b1b2c3d4e5f6", args: { action: "read" }, at: now }), now)).toBeUndefined();
    // a show request is not a browser request, and the other way round
    expect(parseBrowserRequest(req({}), now)).toBeUndefined();
    expect(parseShowRequest(breq({ action: "read" }), now)).toBeUndefined();
  });

  it("takes a page size, or none to go back to the panel's own", () => {
    expect(parseBrowserRequest(breq({ action: "size", width: 1440, height: 900 }), now)?.args).toEqual({ action: "size", width: 1440, height: 900 });
    expect(parseBrowserRequest(breq({ action: "size" }), now)?.args).toEqual({ action: "size" });
    expect(parseBrowserRequest(breq({ action: "size", width: 99999, height: 900 }), now)).toBeUndefined();
    expect(parseBrowserRequest(breq({ action: "size", width: "1440", height: 900 }), now)).toBeUndefined();
  });

  it("takes the login identity actions", () => {
    expect(parseBrowserRequest(breq({ action: "open", url: "https://mail.example.com", profile: "Work" }), now)?.args).toEqual({ action: "open", url: "https://mail.example.com", profile: "Work" });
    expect(parseBrowserRequest(breq({ action: "profiles" }), now)?.args).toEqual({ action: "profiles" });
    expect(parseBrowserRequest(breq({ action: "profile-add", name: "Test user" }), now)?.args).toEqual({ action: "profile-add", name: "Test user" });
    expect(parseBrowserRequest(breq({ action: "profile-add" }), now)).toBeUndefined();
  });

  it("drops arguments of the wrong type", () => {
    expect(parseBrowserRequest(breq({ action: "read", page: 42, submit: "yes", text: "" }), now)?.args).toEqual({ action: "read" });
  });
});
