import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "../api";
import type { Issue } from "../types";
import { AcTally, AcceptanceList } from "./Acceptance";
import { TaskSessions, taskSessionRows } from "./TaskSessions";

const issue = (over: Partial<Issue>): Issue => ({ id: "task-a1", title: "t", status: "in_progress", priority: 2, issue_type: "task", created_at: "2026-09-25T10:00:00Z", updated_at: "2026-09-25T10:00:00Z", labels: [], ...over });
const noop = () => {};
const api = { on: () => new Promise<string>(() => {}), update: async () => {} } as unknown as Api;

describe("agent checklist", () => {
  it("shows reported progress without checker buttons or manual ticking", () => {
    const ac = "- [x] done @codex\n- [ ] fixed later #failed:dispatch-checker\n- [ ] old question #ask:dispatch-checker";
    const html = renderToStaticMarkup(<AcceptanceList issue={issue({ acceptance_criteria: ac })} api={api} host="local" me="me" stamp="" busy={false} onEdit={noop} onChanged={noop} onDone={noop} onError={noop} />);
    expect(html).toContain("Checklist");
    expect(html).toContain("1 / 3");
    for (const old of ["免验", "重新验收", "验收员", 'role="checkbox"', "#failed"]) expect(html).not.toContain(old);
  });
  it("counts every recorded completed item", () => {
    const html = renderToStaticMarkup(<AcTally issue={{ acceptance_criteria: "- [x] a @codex\n- [x] b\n- [ ] c" }} />);
    expect(html.replace(/<[^>]+>/g, "")).toBe("✓2 / 3");
  });
});

describe("task sessions", () => {
  const i = issue({ labels: ["session-origin:aaaaaaaa-1", "session:aaaaaaaa-1", "session:bbbbbbbb-1"] });
  const refs = [
    { agent: "codex", session_id: "cccccccc-1", title: "只提到", last_at: 50, mentions: 4, resume_cmd: "codex resume c" },
    { agent: "claude-code", session_id: "bbbbbbbb-1", title: "接手的", last_at: 100, mentions: 9, resume_cmd: "claude --resume b" },
  ] as never[];
  const live = [{ agent: "claude-code", session_id: "bbbbbbbb-1", alive: true, state: "working", source_app: "Herdr", last_at: 120 }] as never[];
  it("puts the live linked session first as 在做, then 发起, then 提到过", () => {
    const rows = taskSessionRows(i, refs, live, []);
    expect(rows.map((r) => [r.sid, r.role])).toEqual([["bbbbbbbb-1", "doing"], ["aaaaaaaa-1", "origin"], ["cccccccc-1", "mentioned"]]);
  });
  it("without a live one, the latest linked session of an in-progress task is 在做", () => {
    const rows = taskSessionRows(i, refs, [], []);
    expect(rows.find((r) => r.role === "doing")?.sid).toBe("bbbbbbbb-1");
  });
  it("renders a clickable row per session", () => {
    const html = renderToStaticMarkup(<TaskSessions issue={i} refs={refs} live={live} rows={[]} me="me" onOpenSession={noop} onCopyResume={noop} />);
    expect(html).toContain("在做");
    expect(html).toContain("发起");
    expect(html).toContain("提到过");
    expect(html.match(/class="ts-open"/g)?.length).toBe(3);
  });
});
