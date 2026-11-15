import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Activity, Issue } from "../types";
import { Board, Card, ListView, TableView } from "./views";
import { HomeView } from "./Home";
import { AssignProjectProvider } from "./AssignProject";
import { InboxView, type InboxItems } from "./Inbox";

const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();
const task = (over: Partial<Issue>): Issue => ({ id: "task-a1", title: "t", status: "open", priority: 2, issue_type: "task", created_at: iso(60), updated_at: iso(60), labels: ["project:kanban"], ...over });
const act = (over: Partial<Activity>): Activity => ({ key: "claude-code:s1", agent: "claude-code", session_id: "s1", cwd: "/Users/x/Projects/kanban", project: "kanban", title: "会话", last_at: now / 1000 - 60, state: "idle", activity: "", version: "", events: [], tasks: [], unread: false, stale: false, tracking_since: 0, source: "hook", ...over } as Activity);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = () => {};
const EMPTY: InboxItems = { unread: [], running: [], read: [], waiting: [], idle: [], review: [], blocked: [] };

describe("ListView (全部任务 · 列表)", () => {
  const issues = [
    task({ id: "task-p1", title: "在做的", status: "in_progress", priority: 1, acceptance_criteria: "- [x] a\n- [ ] b" }),
    task({ id: "task-o1", title: "没开始", status: "open" }),
    task({ id: "task-b1", title: "卡住的", status: "blocked" }),
    task({ id: "task-d1", title: "刚做完", status: "closed", closed_at: iso(30) }),
    task({ id: "task-d2", title: "很久以前做完", status: "closed", closed_at: iso(60 * 24 * 30) }),
  ];
  it("groups rows into 进行中, 待办, 已完成 in that order and hides done work older than a week", () => {
    const html = renderToStaticMarkup(<ListView issues={issues} selected={null} onSelect={noop} me="me" />);
    const s = text(html);
    expect(s.indexOf("进行中")).toBeLessThan(s.indexOf("待办"));
    expect(s.indexOf("待办")).toBeLessThan(s.indexOf("已完成"));
    expect(s).toContain("刚做完");
    expect(s).not.toContain("很久以前做完");
    expect(s).toContain("还有 1 项更早完成的");
    expect(html.match(/role="option"/g)?.length).toBe(4);
    // Blocked shows a red tag; acceptance a meter.
    expect(html).toMatch(/tag red[^>]*>阻塞/);
    expect(html).toContain('class="meter"');
  });
  it("counts every completed checklist item", () => {
    // signed ticks count; an Agent's own tick and a tick written straight into the board do not
    const ac = "- [x] a @dispatch-checker #sig:0a0a0a0a\n- [x] b @claude-code\n- [ ] c #claimed:claude-code\n- [x] d @me #waived #sig:0b0b0b0b\n- [x] e @dispatch-checker";
    const html = renderToStaticMarkup(<ListView issues={[task({ id: "task-m1", title: "验收", status: "in_progress", acceptance_criteria: ac })]} selected={null} onSelect={noop} me="me" />);
    // the row shows the bar only (the numbers are in its tooltip); the card keeps "2/5"
    expect(html).toContain('title="Checklist 4/5');
    expect(html).not.toContain('class="soft"');
    const card = renderToStaticMarkup(<Card issue={task({ id: "task-m1", status: "in_progress", acceptance_criteria: ac })} selected={false} onSelect={noop} me="me" />);
    expect(text(card)).toContain("4/5");
  });
  it("keeps two accessories on a row while a Detail is open", () => {
    const html = renderToStaticMarkup(<ListView issues={[issues[0]]} selected="task-p1" onSelect={noop} me="me" />);
    const row = html.slice(html.indexOf('data-row-id="task-p1"'));
    expect(row.match(/class="acc-i"/g)?.length).toBe(2);
    expect(row).not.toContain('class="meter"');
  });
});

describe("Board card and table", () => {
  it("renders a card in two lines without the old progress, root and owner blocks", () => {
    const html = renderToStaticMarkup(<Card issue={task({ id: "task-c1", title: "卡片", notes: "进展备注" })} selected={false} onSelect={noop} me="me" />);
    expect(html).toContain("card-l1");
    expect(html).toContain("card-l2");
    expect(html).not.toContain("card-progress");
    expect(html).not.toContain("root-link");
    expect(html).not.toContain("进展备注");
  });
  it("still renders the three columns", () => {
    const html = renderToStaticMarkup(<Board issues={[task({})]} selected={null} onSelect={noop} me="me" onMove={noop} onAdd={noop} />);
    expect(html.match(/class="col-h"/g)?.length).toBe(3);
  });
  it("drops the action column and the dash for an empty 源自", () => {
    const html = renderToStaticMarkup(<TableView issues={[task({})]} selected={null} onSelect={noop} me="me" />);
    expect(text(html)).not.toContain("操作");
    expect(html).not.toMatch(/[—–]/);
    expect(html).toContain("lst-table");
  });
});

describe("工作台", () => {
  const props = { me: "me", loaded: true, connectionError: false, unavailable: [] as string[], outcomes: [] as Issue[], progress: {}, flags: {}, archiveDays: 30, onFlag: noop, onOpen: noop, onFocus: noop, onTask: noop, onProject: noop, onView: noop, onNew: noop };
  it("lists 等你, 在跑, 今天做完的, 没人在做的任务 with one leading verb per session row", () => {
    const ask = act({ key: "claude-code:q1", session_id: "q1", title: "欧洲史", unread: true, reply_id: "r0", waiting: "question", question: "环境音要不要全章重生成？", last_at: now / 1000 - 30 });
    const unread = act({ key: "claude-code:u1", session_id: "u1", title: "有新回复", unread: true, reply_id: "r1", unread_summary: "登录状态显示问题已修复", unread_summary_reply: "r1" });
    const running = act({ key: "codex:r1", agent: "codex", session_id: "r1", title: "视频编辑", state: "working", activity: "Bash · git commit", tasks: ["task-w1"] });
    const read = act({ key: "codex:d1", agent: "codex", session_id: "d1", title: "会议图标", reply_id: "r2", reply_preview: "图标已生成", last_at: now / 1000 - 90, files: { "/a": 1 } });
    const doing = task({ id: "task-w1", title: "做到一半", status: "in_progress", acceptance_criteria: "- [x] a\n- [ ] b" });
    const p1 = task({ id: "task-p1", title: "没人认领的 P1", priority: 1 });
    const p2 = task({ id: "task-p2", title: "没人认领的 P2", priority: 2 });
    const html = renderToStaticMarkup(<HomeView {...props} rows={[ask, unread, running, read]} issues={[doing, p1, p2]} inbox={{ ...EMPTY, unread: [ask, unread], running: [running], read: [read] }} />);
    const s = text(html);
    const at = (w: string) => s.indexOf(w);
    expect(at("等你")).toBeGreaterThanOrEqual(0);
    expect(at("等你")).toBeLessThan(at("在跑"));
    expect(at("在跑")).toBeLessThan(at("今天做完的"));
    expect(at("今天做完的")).toBeLessThan(at("没人在做的任务"));
    // 问你 sorts ahead of the plain reply, and each row says what it is in one word.
    expect(at("问你 环境音要不要全章重生成？")).toBeGreaterThanOrEqual(0);
    expect(at("问你 环境音")).toBeLessThan(at("交了 登录状态显示问题已修复"));
    expect(s).toContain("在做 Bash · git commit");
    expect(html).toContain("1/2");  // the running row's acceptance meter
    expect(s).toContain("交了 图标已生成");
    expect(s).toContain("没人认领的 P1");
    expect(s).not.toContain("没人认领的 P2");
    expect(s).toContain("只列 P1 · 还有 1 项 P2");
    expect(s).not.toContain("洞察");
    expect(s).not.toContain("进行中的任务");
    // The first row is selected and its Detail shows the question.
    expect(html).toContain('class="ld split');
    expect(html).toMatch(/data-row-id="a:local:claude-code:q1"[^>]*lrow sr sel/);
    expect(html).toContain("home-ask");
    expect(html).not.toMatch(/[\u2014\u2013]/);
  });
  it("folds plain unread replies beyond the first few into one line", () => {
    const rows = Array.from({ length: 9 }, (_, n) => act({ key: `claude-code:u${n}`, session_id: `u${n}`, title: `回复 ${n}`, unread: true, reply_id: `r${n}`, last_at: now / 1000 - 60 * (n + 1) }));
    const s = text(renderToStaticMarkup(<HomeView {...props} rows={rows} issues={[]} inbox={{ ...EMPTY, unread: rows }} />));
    expect(s).toContain("还有 3 条只是没看的回复");
    expect(s).toContain("回复 5");
    expect(s).not.toContain("回复 6");
  });
  it("folds running conversations beyond the first five into one line", () => {
    const rows = Array.from({ length: 8 }, (_, n) => act({ key: `claude-code:r${n}`, session_id: `r${n}`, title: `在跑的 ${n}`, state: "working", activity: `Bash · step ${n}`, last_at: now / 1000 - 10 * (n + 1) }));
    const s = text(renderToStaticMarkup(<HomeView {...props} rows={rows} issues={[]} inbox={{ ...EMPTY, running: rows }} />));
    expect(s).toContain("在跑 8");
    expect(s).toContain("在跑的 4");
    expect(s).not.toContain("在跑的 5");
    expect(s).toContain("还有 3 个在跑");
  });
  it("a session stopped on a dialog is 要确认 and leads 等你", () => {
    const unread = act({ key: "claude-code:u1", session_id: "u1", title: "有新回复", unread: true, reply_id: "r1", last_at: now / 1000 - 5 });
    const dlg = act({ key: "claude-code:w1", session_id: "w1", title: "开发者账号", activity: "Bash · xcrun devicectl device install app" });
    const waiting = { agent: "claude-code", session_id: "w1", cwd: "/Users/x/Projects/harbor", project: "harbor", agent_pid: 1, source_kind: "terminal" as const, source_app: "Herdr", entrypoint: "cli", started_at: 0, last_at: now / 1000 - 60, state: "idle" as const, prompts: 3, alive: true, registered: true, attention: "input" as const };
    const html = renderToStaticMarkup(<HomeView {...props} rows={[unread, dlg]} issues={[]} inbox={{ ...EMPTY, unread: [unread], waiting: [waiting] }} />);
    const s = text(html);
    expect(s.indexOf("要确认 xcrun devicectl")).toBeGreaterThanOrEqual(0);
    expect(s.indexOf("要确认 xcrun")).toBeLessThan(s.indexOf("有新回复"));
    expect(s).toContain("它停在权限框上，等你点头");
  });
  it("keeps 分配到项目 in the Detail of a conversation that belongs to no project", () => {
    const loose = act({ key: "claude-code:l1", session_id: "l1", cwd: "/Users/x", project: "", title: "零散的", unread: true, reply_id: "r1" });
    const html = renderToStaticMarkup(<AssignProjectProvider value={{ projects: ["kanban"], task: async () => {}, conversation: async () => {} }}>
      <HomeView {...props} rows={[loose]} issues={[]} inbox={{ ...EMPTY, unread: [loose] }} />
    </AssignProjectProvider>);
    expect(text(html)).toContain("分配到项目");
  });
  it("shows an empty state when nothing needs you", () => {
    const html = renderToStaticMarkup(<HomeView {...props} rows={[]} issues={[]} inbox={EMPTY} />);
    expect(text(html)).toContain("现在没有要你处理的事");
  });
});

describe("等我", () => {
  it("shows tabs with counts and rows without the old per-row buttons", () => {
    const unread = act({ key: "claude-code:u1", session_id: "u1", title: "有新回复", unread: true, reply_id: "r1" });
    const html = renderToStaticMarkup(<InboxView items={{ ...EMPTY, unread: [unread] }} me="me" onRead={async () => {}} onOpen={noop} onSelect={noop} onFocus={noop} />);
    expect(html).toContain('role="tablist"');
    expect(text(html)).toContain("未读回复 1");
    expect(text(html)).toContain("有新回复");
    expect(text(html)).not.toContain("查看并回复");
    expect(html).not.toContain("conversation-actions");
  });
  it("uses the empty view when nothing waits", () => {
    const html = renderToStaticMarkup(<InboxView items={EMPTY} me="me" onRead={async () => {}} onOpen={noop} onSelect={noop} onFocus={noop} />);
    expect(text(html)).toContain("暂时没有等我的事项");
  });
});
