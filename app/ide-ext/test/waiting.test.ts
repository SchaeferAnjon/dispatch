import { describe, expect, it } from "vitest";
import { waitingArgs } from "../src/core/waiting";

describe("waiting", () => {
  it("lists by default", () => {
    expect(waitingArgs(undefined)).toEqual(["waiting", "--json"]);
    expect(waitingArgs("list")).toEqual(["waiting", "--json"]);
  });

  it("acts on a session row", () => {
    expect(waitingArgs("allow", "ide:claude:/6236a956-274b")).toEqual(["waiting", "allow", "ide:claude:/6236a956-274b", "--json"]);
    expect(waitingArgs("deny", "chat:claude-code:abc")).toEqual(["waiting", "deny", "chat:claude-code:abc", "--json"]);
    expect(waitingArgs("read", "ide:codex:/019a")).toEqual(["waiting", "read", "ide:codex:/019a", "--json"]);
    expect(waitingArgs("readAll")).toEqual(["waiting", "read", "--all", "--json"]);
    expect(waitingArgs("doneAll")).toEqual(["waiting", "done", "--all", "--json"]);
  });

  it("answers a question with one of its options", () => {
    expect(waitingArgs("pick", "ide:claude:/6236a956", "Draft B")).toEqual(["waiting", "pick", "ide:claude:/6236a956", "Draft B", "--json"]);
    expect(waitingArgs("pick", "ide:claude:/6236a956", "2")).toEqual(["waiting", "pick", "ide:claude:/6236a956", "2", "--json"]);
    // the page sends { option } for both kinds of Decide; a session's answer has no reason
    expect(waitingArgs("pick", "ide:claude:/6236a956", { option: "Stripe", reason: "ignored" })).toEqual(["waiting", "pick", "ide:claude:/6236a956", "Stripe", "--json"]);
    expect(waitingArgs("pick", "ide:claude:/6236a956")).toBeUndefined();
    expect(waitingArgs("pick", "ide:claude:/6236a956", "--all")).toBeUndefined();
    expect(waitingArgs("pick", "chat:claude-code:abc", "1")).toBeUndefined();
  });

  it("closes, hides and replies to Only you tasks, and undoes", () => {
    expect(waitingArgs("done", "task-gqn9")).toEqual(["done", "task-gqn9", "--reason", "Done in Waiting for you", "--json"]);
    expect(waitingArgs("done", "task-gqn9,task-ab12")).toEqual(["waiting", "done", "task-gqn9,task-ab12", "--json"]);
    expect(waitingArgs("reopen", "task-gqn9")).toEqual(["waiting", "reopen", "task-gqn9", "--json"]);
    expect(waitingArgs("snooze", "task-gqn9,task-ab12")).toEqual(["waiting", "snooze", "task-gqn9,task-ab12", "--json"]);
    expect(waitingArgs("snooze", "task-gqn9", "next-week")).toEqual(["waiting", "snooze", "task-gqn9", "--until", "next-week", "--json"]);
    expect(waitingArgs("unsnooze", "task-gqn9")).toEqual(["waiting", "unsnooze", "task-gqn9", "--json"]);
    expect(waitingArgs("unread", "ide:claude:/6236a956")).toEqual(["waiting", "unread", "ide:claude:/6236a956", "--json"]);
    expect(waitingArgs("reply", "task-gqn9")).toEqual(["waiting", "reply", "task-gqn9", "--json"]);
    expect(waitingArgs("seen")).toEqual(["waiting", "seen", "--json"]);
  });

  it("refuses anything else", () => {
    expect(waitingArgs("allow", "task:task-a")).toBeUndefined();
    expect(waitingArgs("allow", "--all")).toBeUndefined();
    expect(waitingArgs("done", "task-a; rm -rf /")).toBeUndefined();
    expect(waitingArgs("done", "--reason")).toBeUndefined();
    expect(waitingArgs("snooze", "task-a", "forever")).toBeUndefined();
    expect(waitingArgs("unread", "chat:claude-code:abc")).toBeUndefined();
    expect(waitingArgs("reply", "task-a,task-b")).toBeUndefined();
    expect(waitingArgs("delete", "ide:x:/y")).toBeUndefined();
  });
});

describe("waiting pick", () => {
  it("picks a direction on a Decide row", () => {
    expect(waitingArgs("pick", "task:task-t26s", { option: "a" })).toEqual(["waiting", "pick", "task:task-t26s", "A", "--json"]);
    expect(waitingArgs("pick", "task:task-t26s", { option: "B", reason: "-cleaner\nlist" })).toEqual(["waiting", "pick", "task:task-t26s", "B", "--reason=-cleaner list", "--json"]);
  });

  it("refuses a bad pick", () => {
    expect(waitingArgs("pick", "task-t26s", { option: "A" })).toBeUndefined();
    expect(waitingArgs("pick", "task:task-t26s", { option: "--all" })).toBeUndefined();
    expect(waitingArgs("pick", "task:task-t26s")).toBeUndefined();
  });
});
