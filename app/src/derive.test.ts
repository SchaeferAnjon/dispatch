import { describe, expect, it } from "vitest";
import { needsReview, needsAttention, sessionStatus, actorOf, agentsFrom, columnOf, composePitfall, composeWiki, eventsFrom, parseAcceptance, parsePitfall, projectOf, serializeAcceptance, statusLabel } from "./derive";
import { lineDiff, withContext } from "./diff";
import type { HistoryEntry, Issue, Session } from "./types";

const base: Issue = { id: "task-1", title: "t", status: "open", priority: 2, issue_type: "task", created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z" };

describe("status mapping (the user's four states)", () => {
  it("open → 待办 column", () => expect(columnOf(base)).toBe("todo"));
  it("blocked stays in 待办", () => expect(columnOf({ ...base, status: "blocked" })).toBe("todo"));
  it("in_progress → 进行中", () => expect(columnOf({ ...base, status: "in_progress" })).toBe("prog"));
  it("closed without label → 已完成·待审", () => expect(columnOf({ ...base, status: "closed" })).toBe("done"));
  it("closed + reviewed label → 已审核", () => {
    const i = { ...base, status: "closed" as const, labels: ["project:kanban", "reviewed"] };
    expect(columnOf(i)).toBe("done");
    expect(statusLabel(i).text).toBe("已复核");
  });
});

describe("project label convention", () => {
  it("reads project:<name>", () => expect(projectOf({ ...base, labels: ["reviewed", "project:poker-trainer"] })).toBe("poker-trainer"));
  it("empty when absent", () => expect(projectOf(base)).toBe(""));
});

describe("actors", () => {
  it("known agents", () => {
    expect(actorOf("claude-code", "schaefer")?.name).toBe("Claude Code");
    expect(actorOf("codex", "schaefer")?.kind).toBe("codex");
    expect(actorOf("zcode", "schaefer")?.glyph).toBe("Z");
  });
  it("human aliases collapse into me", () => {
    expect(actorOf("SchaeferAnjon", "schaefer")?.id).toBe("schaefer");
    expect(actorOf("schaefer", "schaefer")?.name).toBe("你");
  });
  it("unknown names stay themselves", () => expect(actorOf("bob", "schaefer")?.name).toBe("bob"));
});

describe("acceptance checklist", () => {
  it("parses - [ ] / - [x] and bare bullets", () => {
    expect(parseAcceptance("- [x] a\n- [ ] b\n- c")).toEqual([{ done: true, text: "a" }, { done: false, text: "b" }, { done: false, text: "c" }]);
  });
  it("round-trips", () => {
    const s = "- [x] a\n- [ ] b";
    expect(serializeAcceptance(parseAcceptance(s))).toBe(s);
  });
});

describe("pitfalls", () => {
  it("parses 【坑】【解法】 and tags", () => {
    const p = parsePitfall({ key: "pit-x", value: "【坑】A 【解法】B #project:kanban #task:task-9lo" });
    expect(p).toMatchObject({ trap: "A", fix: "B", project: "kanban", task: "task-9lo", isPit: true });
  });
  it("compose is the inverse of parse", () => {
    const v = composePitfall("坑内容", "解法内容", "dotfiles", "task-1");
    const p = parsePitfall({ key: "pit-y", value: v });
    expect(p.trap).toBe("坑内容"); expect(p.fix).toBe("解法内容"); expect(p.project).toBe("dotfiles"); expect(p.task).toBe("task-1");
  });
  it("plain memories are not pits", () => expect(parsePitfall({ key: "auth-jwt", value: "uses JWT" }).isPit).toBe(false));
  it("parses wins and retros into kind + fields", () => {
    const w = parsePitfall({ key: "win-draft", value: "【做对】邮件写好停在发送前 【为什么】对外发送要用户确认 #project:HIWI" });
    expect(w).toMatchObject({ kind: "win", text: "邮件写好停在发送前", project: "HIWI", isPit: false });
    expect(w.fields["【为什么】"]).toBe("对外发送要用户确认");
    const r = parsePitfall({ key: "retro-task-1", value: "【复盘】做了 X 【技术】python 【做对】先验证 【做错】没记板 #task:task-1" });
    expect(r.kind).toBe("retro"); expect(r.text).toBe("做了 X"); expect(r.fields["【做错】"]).toBe("没记板"); expect(r.task).toBe("task-1");
  });
  it("composeWiki round-trips", () => {
    const v = composeWiki("retro", "做了 X", { tech: "py", good: "a", bad: "b" }, "kanban", "task-2");
    const p = parsePitfall({ key: "retro-task-2", value: v });
    expect(p.fields).toEqual({ "【技术】": "py", "【做对】": "a", "【做错】": "b" }); expect(p.project).toBe("kanban");
  });
});

describe("activity from history + audit", () => {
  const h = (ts: string, patch: Partial<Issue>): HistoryEntry => ({ CommitHash: ts, Committer: "root", CommitDate: ts, Issue: { ...base, ...patch } });
  it("infers created, claimed, closed, reviewed in order", () => {
    const ev = eventsFrom([
      h("2026-09-02T10:00:00Z", { created_by: "schaefer" }),
      h("2026-09-02T10:05:00Z", { status: "in_progress", assignee: "claude-code" }),
      h("2026-09-02T10:10:00Z", { status: "closed", assignee: "claude-code", close_reason: "done" }),
      h("2026-09-02T10:15:00Z", { status: "closed", assignee: "claude-code", labels: ["reviewed"] }),
    ], []);
    expect(ev.map((e) => e.kind)).toEqual(["reviewed", "closed", "claimed", "created"]);
    expect(ev.find((e) => e.kind === "claimed")?.actor).toBe("claude-code");
  });
  it("audit log supplies the actor for status changes", () => {
    const ev = eventsFrom([
      h("2026-09-02T10:00:00Z", {}),
      h("2026-09-02T10:05:00Z", { status: "closed" }),
    ], [], [{ id: "i", kind: "field_change", created_at: "2026-09-02T10:05:01Z", actor: "codex", issue_id: "task-1", extra: { field: "status" } }]);
    expect(ev.find((e) => e.kind === "closed")?.actor).toBe("codex");
  });
});

describe("agent presence", () => {
  const s = (over: Partial<Session>): Session => ({ agent: "claude-code", session_id: "s", cwd: "/x", project: "x", agent_pid: 1, source_kind: "terminal", source_app: "Herdr", entrypoint: "cli", started_at: 0, last_at: 0, state: "idle", prompts: 0, alive: true, registered: true, ...over });
  it("old presence records cannot restore retired integrations", () => {
    const a = agentsFrom([], "schaefer", [s({agent: "qoder"}), s({agent: "qoder-ide"}), s({agent: "codex"})]);
    expect(a.map(x => x.actor.id).sort()).toEqual(["claude-code", "codex", "pi", "zcode"]);
    expect(a.find(x => x.actor.id === "codex")?.online).toBe(true);
  });
  it("groups live sessions by source and marks the agent online", () => {
    const a = agentsFrom([], "schaefer", [s({ session_id: "1", state: "working" }), s({ session_id: "2", source_kind: "desktop", source_app: "Claude 桌面端" })]);
    const cc = a.find((x) => x.actor.id === "claude-code")!;
    expect(cc.online).toBe(true);
    expect(cc.sessions).toHaveLength(2);
    expect(cc.bySource.map((b) => b.label).sort()).toEqual(["Claude 桌面端", "Herdr"]);
  });
  it("dead sessions are ignored and default agents still appear offline", () => {
    const a = agentsFrom([], "schaefer", [s({ alive: false })]);
    expect(a.find((x) => x.actor.id === "claude-code")?.online).toBe(false);
    expect(a.some((x) => x.actor.id === "zcode")).toBe(true);
  });
});

describe("line diff", () => {
  it("marks adds and deletes", () => {
    const d = lineDiff("a\nb\nc", "a\nx\nc");
    expect(d.map((l) => l.kind + ":" + l.text)).toEqual(["same:a", "del:b", "add:x", "same:c"]);
  });
  it("collapses unchanged runs with context", () => {
    const d = lineDiff("1\n2\n3\n4\n5\n6\n7\n8", "1\n2\n3\n4\n5\n6\n7\n9");
    const out = withContext(d, 1);
    expect(out[0].kind).toBe("skip");
    expect(out.filter((l) => l.kind === "add")).toHaveLength(1);
  });
});

describe("attention signals", () => {
  const s = { alive: true, registered: true, state: "idle" } as Session;
  it("idle never triggers attention", () => expect(needsAttention(s)).toBe(false));
  it("only explicit input requires attention", () => {
    expect(needsAttention({ ...s, attention: "input" })).toBe(true);
    expect(needsAttention({ ...s, attention: "failure" })).toBe(false);
  });
  it("dead or unregistered sessions cannot raise attention", () => {
    expect(needsAttention({ ...s, alive: false, attention: "input" })).toBe(false);
    expect(needsAttention({ ...s, registered: false, attention: "input" })).toBe(false);
  });
  it("process presence is not proof of idle", () => {
    expect(sessionStatus({ ...s, registered: false })).toBe("状态未知");
    expect(sessionStatus({ ...s, state: "unknown" })).toBe("状态未知");
  });
});

describe("completion is independent of peer review", () => {
  it("completed tasks do not automatically need review", () => expect(needsReview({ ...base, status: "closed" })).toBe(false));
  it("only explicit requests enter the peer-review queue", () => {
    expect(needsReview({ ...base, status: "closed", labels: ["review-requested"] })).toBe(true);
    expect(needsReview({ ...base, status: "closed", labels: ["review-requested", "reviewed"] })).toBe(false);
    expect(needsReview({ ...base, status: "open", labels: ["review-requested"] })).toBe(false);
  });
});
