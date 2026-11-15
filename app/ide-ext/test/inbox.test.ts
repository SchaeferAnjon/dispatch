import { describe, expect, it } from "vitest";
import { inboxArgs } from "../src/core/inbox";

describe("inbox", () => {
  it("lists by default and asks who is asleep", () => {
    expect(inboxArgs(undefined)).toEqual(["inbox", "list", "--limit", "40", "--json"]);
    expect(inboxArgs("sleep")).toEqual(["sleep", "--json"]);
    expect(inboxArgs("sleepOn")).toEqual(["sleep", "on", "--json"]);
    expect(inboxArgs("sleepOff")).toEqual(["sleep", "off", "--json"]);
  });

  it("marks events read or unread by id, a session or all", () => {
    expect(inboxArgs("read", ["0123456789ab", "ba9876543210"])).toEqual(["inbox", "read", "0123456789ab", "ba9876543210", "--json"]);
    expect(inboxArgs("unread", "0123456789ab")).toEqual(["inbox", "unread", "0123456789ab", "--json"]);
    expect(inboxArgs("readSession", "claude:/6236a956-274b")).toEqual(["inbox", "read", "--session", "claude:/6236a956-274b", "--by", "you", "--json"]);
    expect(inboxArgs("readSession", "codex:/019a", "working")).toEqual(["inbox", "read", "--session", "codex:/019a", "--by", "working", "--json"]);
    expect(inboxArgs("readAll")).toEqual(["inbox", "read", "--all", "--json"]);
  });

  it("files what a session did with its own status", () => {
    expect(inboxArgs("add", { status: "completed", session: "claude:/abc-123", agent: "claude", title: "Fix the bell\nnow", project: "kanban", text: "-rf looks like a flag" })).toEqual([
      "inbox", "add", "--status", "completed", "--session", "claude:/abc-123", "--source", "ide",
      "--agent=claude", "--title=Fix the bell now", "--project=kanban", "--text=-rf looks like a flag", "--json",
    ]);
  });

  it("passes the window's user data so a finished session's last words can be found", () => {
    expect(inboxArgs("list", undefined, undefined, "/Users/me/Library/Application Support/Dispatch IDE")).toEqual([
      "inbox", "list", "--limit", "40", "--user-data=/Users/me/Library/Application Support/Dispatch IDE", "--json",
    ]);
    expect(inboxArgs("add", { status: "completed", session: "agent-host-claude:/h1" }, undefined, "/tmp/ud")?.slice(-2)).toEqual(["--user-data=/tmp/ud", "--json"]);
    expect(inboxArgs("list", undefined, undefined, "relative/path")).toEqual(["inbox", "list", "--limit", "40", "--json"]);
  });

  it("reads which kinds ring and plays a sound by name", () => {
    expect(inboxArgs("prefs")).toEqual(["inbox", "prefs", "--json"]);
    expect(inboxArgs("sound")).toEqual(["inbox", "sound", "--json"]);
    expect(inboxArgs("sound", "Glass")).toEqual(["inbox", "sound", "Glass", "--json"]);
    expect(inboxArgs("sound", "--all")).toBeUndefined();
    expect(inboxArgs("sound", "a;rm -rf /")).toBeUndefined();
  });

  it("refuses what the bell never sends", () => {
    expect(inboxArgs("read", "../../etc")).toBeUndefined();
    expect(inboxArgs("read", [])).toBeUndefined();
    expect(inboxArgs("unread", "0123456789ab; rm")).toBeUndefined();
    expect(inboxArgs("readSession", "not a uri")).toBeUndefined();
    expect(inboxArgs("add", { status: "finished-ish", session: "claude:/abc" })).toBeUndefined();
    expect(inboxArgs("add", { status: "completed", session: "--all" })).toBeUndefined();
    expect(inboxArgs("clear")).toBeUndefined();
    expect(inboxArgs("rm")).toBeUndefined();
  });
});
