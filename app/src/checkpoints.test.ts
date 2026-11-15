import { describe, expect, it } from "vitest";
import { checkpointApi, checkpointForMessage, planRows, restoreNote, type Checkpoint } from "./checkpoints";
import { dialogButtons } from "./components/CheckpointRestore";
import { CODEBASE_BUDGET, mentionItems, searchCode, withCodebase } from "./components/MentionPopover";
import { initialChatView, reduceChatEvent, type ChatEvent } from "./chatProtocol";

const cp = (o: Partial<Checkpoint>): Checkpoint => ({ turn_id: "cp-1", kind: "turn", sid: "claude-code:abc", message_id: "m1", text: "改一下 a.py", ts: 1000, before_tree: "t0", after_tree: "t1", files_changed: [], ...o });

describe("checkpoints", () => {
  it("calls dispatch checkpoint with the root, the session and the restore mode", async () => {
    const calls: string[][] = [];
    const answers = [
      JSON.stringify({ ok: true, turns: [cp({})] }),
      JSON.stringify({ ok: true, dry_run: true, turn_id: "cp-1", files: [{ path: "a.py", action: "restore" }], conflicts: ["a.py"] }),
      JSON.stringify({ ok: false, error: "conflict", message: "x", files: ["a.py"] }),
      JSON.stringify({ ok: true, turn_id: "cp-1", restored: ["a.py"], deleted: [], skipped: [], files: ["a.py"], rollback_from: "cp-2", note: "n", sid: "claude-code:abc" }),
    ];
    const api = { on: async (_h: string, args: string[]) => { calls.push(args); return answers.shift()!; } };
    const c = checkpointApi(api, "/p");
    expect((await c.list("claude-code:abc"))[0].turn_id).toBe("cp-1");
    expect((await c.plan("cp-1")).conflicts).toEqual(["a.py"]);
    expect((await c.restore("cp-1", { sid: "claude-code:abc", note: false })).ok).toBe(false);
    expect((await c.restore("cp-1", { onlyClean: true })).ok).toBe(true);
    expect(calls).toEqual([
      ["checkpoint", "list", "--sid", "claude-code:abc", "--root", "/p", "--json"],
      ["checkpoint", "restore", "--turn", "cp-1", "--dry-run", "--root", "/p", "--json"],
      ["checkpoint", "restore", "--turn", "cp-1", "--sid", "claude-code:abc", "--no-note", "--root", "/p", "--json"],
      ["checkpoint", "restore", "--turn", "cp-1", "--only-clean", "--root", "/p", "--json"],
    ]);
  });

  it("a failed list or dry run throws the CLI's message", async () => {
    const api = { on: async () => JSON.stringify({ ok: false, error: "root_too_broad", message: "不给家目录打快照" }) };
    await expect(checkpointApi(api, "~").list()).rejects.toThrow("不给家目录打快照");
    await expect(checkpointApi(api, "~").plan("x")).rejects.toThrow("不给家目录打快照");
  });

  it("finds the checkpoint of a transcript message by text and time", () => {
    const list = [cp({ turn_id: "a", text: "改一下 a.py", ts: 1000 }), cp({ turn_id: "b", text: "改一下 a.py", ts: 5000 }), cp({ turn_id: "r", kind: "restore", text: "改一下 a.py", ts: 1001 })];
    expect(checkpointForMessage(list, "改一下 a.py", 1003)?.turn_id).toBe("a");
    expect(checkpointForMessage(list, "改一下 a.py", 4990)?.turn_id).toBe("b");
    // notes in front and @codebase results after, as the transcript has them
    expect(checkpointForMessage(list, "[system] 你撤销了 b.py 第 1 处\n\n改一下  a.py\n\n[codebase] …", 1002)?.turn_id).toBe("a");
    expect(checkpointForMessage(list, "别的话", 1000)).toBeNull();
    expect(checkpointForMessage(list, "改一下 a.py", 3000)).toBeNull();
  });

  it("lists conflicts first and writes the note for the agent", () => {
    expect(planRows({ turn_id: "x", files: [{ path: "a", action: "restore" }, { path: "z", action: "delete" }], conflicts: ["z"] }).map((r) => [r.path, r.conflict])).toEqual([["z", true], ["a", false]]);
    const n = restoreNote({ restored: ["a.py"], deleted: ["new.py"], skipped: ["b.py"] }, "改一下 a.py\n第二行");
    expect(n).toContain("「改一下 a.py」");
    expect(n).toContain("恢复了 a.py");
    expect(n).toContain("删掉了这之后新建的 new.py");
    expect(n).toContain("b.py 在这之后又被改过");
    expect(n).not.toMatch(/[\u2014\u2013]/);
  });

  it("marks the files no agent edit tool wrote, and Enter never starts on the danger button", () => {
    const plan = { turn_id: "x", files: [{ path: "agent2.txt", action: "delete" as const }, { path: "user_notes.md", action: "delete" as const }], conflicts: ["user_notes.md"], unsure: ["user_notes.md"] };
    expect(planRows(plan).map((r) => [r.path, r.conflict, r.unsure])).toEqual([["user_notes.md", true, true], ["agent2.txt", false, false]]);
    expect(dialogButtons(plan, false)).toMatchObject({ focusCancel: true, focusGo: false, goDisabled: false, clean: 1 });
    expect(dialogButtons({ ...plan, conflicts: [], unsure: [] }, false)).toMatchObject({ focusCancel: false, focusGo: true });
    // while an agent works in the project (this page's session, or chatd says so) nothing restores
    expect(dialogButtons({ ...plan, conflicts: [] }, true)).toMatchObject({ goDisabled: true, focusGo: false, focusCancel: true });
    expect(dialogButtons({ ...plan, conflicts: [], running: ["claude-code:x"] }, false).goDisabled).toBe(true);
    expect(dialogButtons(null, false)).toMatchObject({ focusCancel: true, focusGo: false });
  });

  it("the dry run passes unsure and running through", async () => {
    const api = { on: async () => JSON.stringify({ ok: true, dry_run: true, turn_id: "cp-1", files: [], conflicts: ["n.md"], unsure: ["n.md"], running: ["claude-code:x"] }) };
    const p = await checkpointApi(api, "/p").plan("cp-1");
    expect([p.unsure, p.running]).toEqual([["n.md"], ["claude-code:x"]]);
  });

  it("turn_started's checkpoint lands on the live turn", () => {
    const e = { ev: "turn_started", seq: 1, ts: 1, session: "claude-code:abc", turn_id: "t1", message_id: "m1", text: "hi", images_n: 0, checkpoint: "cp-9" } as ChatEvent;
    expect(reduceChatEvent(initialChatView("claude-code:abc"), e).turns[0].checkpoint).toBe("cp-9");
  });
});

describe("@codebase", () => {
  it("is offered first when typed toward, last on a bare @, and not at all without a folder", () => {
    const src = { tasks: [], sessions: [{ key: "claude-code:x", title: "code review" }], files: [], codebase: true };
    expect(mentionItems("cod", src)[0].token).toBe("@codebase");
    expect(mentionItems("", src).map((i) => i.kind)).toEqual(["session", "codebase"]);
    expect(mentionItems("cod", { ...src, codebase: false }).some((i) => i.kind === "codebase")).toBe(false);
  });

  it("appends the search results for the agent and keeps what was typed for the bubble", async () => {
    const queries: string[] = [];
    const hit = (i: number) => ({ path: `app/f${i}.py`, start: i, end: i + 9, text: `def f${i}():\n    pass\n` });
    const r = await withCodebase("@codebase 在哪给 Agent 前置 note？", "@codebase 在哪给 Agent 前置 note？", async (q) => { queries.push(q); return [hit(1), hit(2)]; });
    expect(queries).toEqual(["在哪给 Agent 前置 note？"]);
    expect(r.display).toBe("@codebase 在哪给 Agent 前置 note？");
    expect(r.text.startsWith("在哪给 Agent 前置 note？\n\n[codebase] ")).toBe(true);
    expect(r.text).toContain("[codebase] app/f1.py:1-10\ndef f1():\n    pass");
    expect(r.text).toContain("[codebase] app/f2.py:2-11");
    // no token: untouched, no display
    expect(await withCodebase("plain", "plain", async () => { throw new Error("not called"); })).toEqual({ text: "plain" });
    // an e-mail address is not the token
    expect((await withCodebase("mail a@codebase.io", "x", async () => [])).display).toBeUndefined();
  });

  it("stays under chatd's message limit and says so when nothing was found", async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, start: 1, end: 2, text: "x".repeat(1400) }));
    const r = await withCodebase("q @codebase", "q @codebase", async () => big);
    expect(r.text.length).toBeLessThanOrEqual(CODEBASE_BUDGET + 200);
    expect((await withCodebase("q @codebase", "q", async () => [])).text).toContain("[codebase] 在项目里没搜到相关代码");
  });

  it("runs dispatch code-search on the folder and turns a refusal into a message", async () => {
    const calls: string[][] = [];
    const ok = { on: async (_h: string, a: string[]) => { calls.push(a); return JSON.stringify({ ok: true, mode: "keyword", results: [{ path: "a.py", start: 1, end: 3, text: "x" }] }); } };
    expect((await searchCode(ok, "local", "/p", "-n trick"))[0].path).toBe("a.py");
    expect(calls[0]).toEqual(["code-search", "--root", "/p", "-n", "10", "--json", "--", "-n trick"]);
    await expect(searchCode({ on: async () => { throw ""; } }, "local", "/p", "q")).rejects.toThrow("代码搜索没成");
    await expect(searchCode({ on: async () => JSON.stringify({ ok: false, message: "不索引家目录" }) }, "local", "/p", "q")).rejects.toThrow("不索引家目录");
  });
});
