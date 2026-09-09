import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentsFrom, delegatedBy, delegatedTo } from "../derive";
import type { Host, Issue, Session } from "../types";
import { AgentsView } from "./views";

const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();
const base: Issue = { id: "task-1", title: "t", status: "open", priority: 2, issue_type: "task", created_at: iso(10), updated_at: iso(10) };
const session = (over: Partial<Session>): Session => ({ agent: "claude-code", session_id: "s1", cwd: "/tmp", project: "kanban", agent_pid: null, source_kind: "terminal", source_app: "iTerm", entrypoint: "", started_at: 0, last_at: now / 1000, state: "working", prompts: 0, alive: true, registered: true, ...over });
const host: Host = { id: "local", name: "本机", ip: "127.0.0.1", ssh: "", online: true, local: true, overlay: { kind: "", ip: "" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "", why: "" };

function render(issues: Issue[], sessions: Session[] = []) {
  const agents = agentsFrom(issues, "schaefer", sessions);
  return renderToStaticMarkup(
    <AgentsView agents={agents} scheduled={[]} apps={[]} issues={issues} me="schaefer" onSelect={() => {}} onFocus={() => {}} refs={new Map()} hosts={[host]} onOpenUrl={() => {}} onCopyText={() => {}} onDelegate={() => {}} />
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("delegation labels", () => {
  it("reads delegated-by / delegated-to, empty when absent", () => {
    const i = { ...base, labels: ["project:kanban", "delegated-by:claude-code", "delegated-to:pi"] };
    expect(delegatedBy(i)).toBe("claude-code");
    expect(delegatedTo(i)).toBe("pi");
    expect(delegatedBy(base)).toBe("");
    expect(delegatedTo(base)).toBe("");
  });
});

describe("AgentsView 派活关系", () => {
  it("shows 派出 on the delegator and 接到 on the receiver", () => {
    // `dispatch agent start pi --task …` claims the task for pi and writes both labels.
    const handed: Issue = { ...base, id: "task-pi", title: "做点事", status: "in_progress", assignee: "pi", labels: ["delegated-by:claude-code", "delegated-to:pi"] };
    const html = render([handed], [session({})]);
    expect(text(html)).toContain("派出 1 → pi · 做点事");
    expect(text(html)).toContain("接到 1 ← Claude Code · 做点事");
  });

  it("shows 自派 when an agent handed a task to another instance of itself", () => {
    const self: Issue = { ...base, id: "task-self", title: "自己的活", status: "in_progress", assignee: "claude-code", labels: ["delegated-by:claude-code", "delegated-to:claude-code"] };
    const html = render([self], [session({})]);
    expect(text(html)).toContain("自派 1");
    expect(text(html)).not.toContain("派出 1");
    expect(text(html)).not.toContain("接到 1");
  });

  it("renders no delegation block without the labels", () => {
    const plain: Issue = { ...base, id: "task-plain", title: "普通的活", status: "in_progress", assignee: "pi" };
    expect(render([plain], [session({})])).not.toContain("agent-delegations");
  });

  it("keeps closed delegations out of the open relations", () => {
    const closed: Issue = { ...base, id: "task-done", title: "派完的活", status: "closed", assignee: "pi", labels: ["delegated-by:claude-code", "delegated-to:pi"] };
    const html = render([closed], [session({})]);
    expect(html).not.toContain("agent-delegations");
  });
});
