import { describe, expect, it } from "vitest";
import { captureArgs } from "../src/core/capture";

describe("capture", () => {
  it("sends a message on stdin with its session and folder", () => {
    expect(captureArgs("note", { text: "Make the export button bigger", session: "agent-host-claude:/x/abc-123", cwd: "/Users/a/shop", title: "Shop" })).toEqual({
      args: ["capture", "note", "--text", "-", "--json", "--session", "agent-host-claude:/x/abc-123", "--cwd", "/Users/a/shop", "--title", "Shop"],
      input: "Make the export button bigger",
    });
    expect(captureArgs("note", { text: "  " })).toBeUndefined();
    expect(captureArgs("note", { text: "x", session: "../../etc" })).toBeUndefined();
    expect(captureArgs("note", { text: "x", cwd: "relative/dir" })?.args).not.toContain("--cwd");
    // a session without a project folder (Chats): the window says so (task-p0za2); only a real true counts
    expect(captureArgs("note", { text: "x", chat: true })?.args).toContain("--chat");
    expect(captureArgs("note", { text: "x", chat: "yes" })?.args).not.toContain("--chat");
  });

  it("only takes task ids and receipt ids for the panel's buttons", () => {
    expect(captureArgs("front", { task: "task-ab12" })?.args).toEqual(["capture", "front", "task-ab12", "--json"]);
    expect(captureArgs("drop", { task: "-rf" })).toBeUndefined();
    expect(captureArgs("edit", { task: "task-1", title: "Bigger button" })?.args).toEqual(["capture", "edit", "task-1", "Bigger button", "--json"]);
    expect(captureArgs("merge", { task: "task-1", into: "task-1" })).toBeUndefined();
    expect(captureArgs("merge", { task: "task-1", into: "task-2" })?.args).toEqual(["capture", "merge", "task-1", "task-2", "--json"]);
    expect(captureArgs("keep", { receipt: "n1a2b3c4d5e6f7", index: 0 })?.args).toEqual(["capture", "keep", "n1a2b3c4d5e6f7", "0", "--json"]);
    expect(captureArgs("keep", { receipt: "rm -rf", index: 0 })).toBeUndefined();
    expect(captureArgs("pause")?.args).toEqual(["nextup", "pause", "--json"]);
    expect(captureArgs("retry")?.args).toEqual(["nextup", "retry", "--json"]);
    expect(captureArgs("list")?.args).toEqual(["capture", "list", "--json"]);
    expect(captureArgs("tick")).toBeUndefined();
  });

  it("puts in-progress tasks nobody works on back in Next up, one or all", () => {
    expect(captureArgs("requeue", { task: "task-8hrg" })?.args).toEqual(["capture", "requeue", "task-8hrg", "--json"]);
    expect(captureArgs("requeue", { task: "--all" })).toBeUndefined();
    expect(captureArgs("requeueAll")?.args).toEqual(["nextup", "requeue", "--json"]);
  });

  it("reads and writes the line's settings: how many at once and which agent starts them", () => {
    expect(captureArgs("settings")?.args).toEqual(["nextup", "settings", "--json"]);
    expect(captureArgs("limit", { limit: 3 })?.args).toEqual(["nextup", "limit", "3", "--json"]);
    expect(captureArgs("limit", { limit: 0 })).toBeUndefined();
    expect(captureArgs("limit", { limit: "3; rm" })).toBeUndefined();
    expect(captureArgs("limit", { limit: 2.5 })).toBeUndefined();
    expect(captureArgs("engine", { engine: "codex" })?.args).toEqual(["nextup", "engine", "codex", "--json"]);
    expect(captureArgs("engine", { engine: "" })?.args).toEqual(["nextup", "engine", "default", "--json"]);
    expect(captureArgs("engine", { engine: "--model" })).toBeUndefined();
  });
});
