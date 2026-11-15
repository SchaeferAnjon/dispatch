import { describe, expect, it } from "vitest";
import { tasksArgs, tasksRequestKey } from "../src/core/tasks";

describe("tasks", () => {
  it("coalesces equivalent URI, path and default-window spellings", () => {
    const key = (req: Parameters<typeof tasksArgs>[0]) => tasksRequestKey(tasksArgs(req)!);
    expect(key({ session: "abc12345" })).toBe(key({ session: "agent-host-claude:/abc12345", days: 30 }));
    expect(key({ folder: "/Users/me/my p/" })).toBe(key({ folder: "file:///Users/me/my%20p", days: 30 }));
    expect(key({ project: "Kanban" })).not.toBe(key({ project: "kanban" })); // echoed in the reply
    expect(key({ project: "kanban", days: 0 })).not.toBe(key({ project: "kanban" }));
    expect(key({ project: "kanban", archived: true })).not.toBe(key({ project: "kanban" }));
    expect(key({ session: "opencode:/host1234" })).toBe(key({ session: "agent-host-opencode:/host1234" }));
    expect(key({ session: "opencode:/host1234" })).not.toBe(key({ session: "host1234" }));
  });
  it("lists a session's or a folder's tasks", () => {
    expect(tasksArgs({ op: "list", session: "agent-host-claude:/6236a956-274b" })).toEqual(["task", "list", "--session", "agent-host-claude:/6236a956-274b", "--json"]);
    expect(tasksArgs({ folder: "/Users/me/p" })).toEqual(["task", "list", "--folder", "/Users/me/p", "--json"]);
    expect(tasksArgs({ op: "list", folder: "file:///Users/me/my%20p" })).toEqual(["task", "list", "--folder", "/Users/me/my p", "--json"]);
    expect(tasksArgs({ op: "list", project: "kanban", folder: "/x" })).toEqual(["task", "list", "--project", "kanban", "--json"]);
  });

  it("draws a graph, optionally cut to a session", () => {
    expect(tasksArgs({ op: "graph", folder: "/p", session: "abc12345", days: 14 })).toEqual(["task", "graph", "--folder", "/p", "--session", "abc12345", "--days", "14", "--json"]);
    expect(tasksArgs({ op: "graph", folder: "/p", days: -3 })).toEqual(["task", "graph", "--folder", "/p", "--json"]);
    expect(tasksArgs({ op: "graph", folder: "/p", days: 0 })).toEqual(["task", "graph", "--folder", "/p", "--days", "0", "--json"]);
  });

  it("keeps the worktree folder when the project scope drops the session", () => {
    for (const op of ["list", "graph"]) {
      expect(tasksArgs({ op, folder: "file:///private/tmp/demo.worktrees/feature%20one" })).toEqual([
        "task", op, "--folder", "/private/tmp/demo.worktrees/feature one", "--json",
      ]);
    }
  });

  it("lists a window, or a project's archive", () => {
    expect(tasksArgs({ op: "list", project: "kanban", days: 30 })).toEqual(["task", "list", "--project", "kanban", "--days", "30", "--json"]);
    expect(tasksArgs({ op: "list", project: "kanban", archived: true })).toEqual(["task", "list", "--project", "kanban", "--archived", "--json"]);
    expect(tasksArgs({ op: "list", project: "kanban", archived: "yes" })).toEqual(["task", "list", "--project", "kanban", "--json"]);
    expect(tasksArgs({ op: "graph", project: "kanban", archived: true })).toEqual(["task", "graph", "--project", "kanban", "--json"]);
  });

  it("shows one task", () => {
    expect(tasksArgs({ op: "show", id: "task-2vcx" })).toEqual(["task", "show", "task-2vcx", "--json"]);
    expect(tasksArgs({ op: "show", id: "task-2vcx", brief: true })).toEqual(["task", "show", "task-2vcx", "--brief", "--json"]);
  });

  it("refuses anything else", () => {
    expect(tasksArgs(undefined)).toBeUndefined();
    expect(tasksArgs({ op: "list" })).toBeUndefined();
    expect(tasksArgs({ op: "plan", id: "task-a1" })).toBeUndefined();
    expect(tasksArgs({ op: "show", id: "task-a; rm -rf /" })).toBeUndefined();
    expect(tasksArgs({ op: "list", folder: "relative/path" })).toBeUndefined();
    expect(tasksArgs({ op: "list", session: "--all" })).toBeUndefined();
    expect(tasksArgs({ op: "list", project: "-x" })).toBeUndefined();
  });
});
