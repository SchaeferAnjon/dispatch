// Browser-preview fallback: an in-memory board so the UI can be exercised without Tauri.
import type { Api, } from "./api";
import type { Comment, HistoryEntry, Issue, Status } from "./types";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

let issues: Issue[] = [
  { id: "task-9lo", title: "调度台桌面应用 UI 稿（方案 A）", description: "先出一版可点的高保真稿，Notion 式三栏。", status: "in_progress", priority: 1, issue_type: "task", assignee: "claude-code", created_by: "user", created_at: ago(70), updated_at: ago(12), started_at: ago(60), labels: ["project:kanban"], acceptance_criteria: "- [x] 四种状态一眼能分\n- [x] 每张卡能看出谁认领了\n- [ ] Agents 视图显示实时命令", comment_count: 2 },
  { id: "task-4mk", title: "导出页面：支持 CSV 和 JSON 两种格式", status: "in_progress", priority: 1, issue_type: "feature", assignee: "codex", created_by: "user", created_at: ago(300), updated_at: ago(41), labels: ["project:demo-app", "delegated-by:claude-code", "delegated-to:codex"], comment_count: 0 },
  { id: "task-e1q", title: "Herdr 开局脚本偶发端口占用，加重试", status: "in_progress", priority: 2, issue_type: "bug", assignee: "user", created_by: "user", created_at: ago(400), updated_at: ago(120), labels: ["project:demo-app"] },
  { id: "task-ss0", title: "给全局板配跨机器同步（Mac mini）", description: "用 Dolt remote 把 ~/tasks 同步到 Mac mini。", status: "blocked", priority: 3, issue_type: "task", created_by: "claude-code", created_at: ago(90), updated_at: ago(90), labels: ["project:kanban"], dependency_count: 1 },
  { id: "task-bzz", title: "Mac mini 上安装 Dolt 并验证 bd dolt pull", status: "open", priority: 3, issue_type: "task", created_by: "claude-code", created_at: ago(80), updated_at: ago(80), labels: ["project:kanban"], acceptance_criteria: "- brew install 成功\n- bd dolt pull 通过" },
  { id: "task-c2e", title: "示例 PDF 批量转换为 Markdown 笔记", status: "open", priority: 1, issue_type: "task", created_by: "user", created_at: ago(1500), updated_at: ago(1500), labels: ["project:示例笔记"] },
  { id: "task-p8a", title: "settings.json 的 PATH 改成脚本生成", status: "open", priority: 4, issue_type: "chore", created_by: "user", created_at: ago(4000), updated_at: ago(4000), labels: ["project:dotfiles"] },
  { id: "task-a1c", title: "全局板初始化 + 三处 BEADS_DIR + Claude/Codex 钩子", status: "closed", priority: 2, issue_type: "task", assignee: "claude-code", created_by: "claude-code", created_at: ago(150), updated_at: ago(60), closed_at: ago(60), close_reason: "冒烟通过", labels: ["project:kanban"] },
  { id: "task-m3r", title: "demo-start.sh 改成 launchd 常驻", status: "closed", priority: 2, issue_type: "task", assignee: "codex", created_by: "user", created_at: ago(500), updated_at: ago(180), closed_at: ago(180), labels: ["project:demo-app"] },
  { id: "task-k5v", title: "技能池软链误删事故：循环删除前强制回显清单", status: "closed", priority: 2, issue_type: "bug", assignee: "user", created_by: "user", created_at: ago(3000), updated_at: ago(1400), closed_at: ago(1400), labels: ["project:dotfiles", "reviewed"] },
  { id: "task-x9b", title: "示例课程 第 1–2 讲笔记入库", status: "closed", priority: 2, issue_type: "task", assignee: "claude-code", created_by: "user", created_at: ago(4000), updated_at: ago(2900), closed_at: ago(2900), labels: ["project:示例笔记", "reviewed"] },
];
let comments: Comment[] = [
  { id: "c1", issue_id: "task-9lo", author: "claude-code", text: "设计方案定稿：Plex Sans + Mono，调度蓝只用在选中。", created_at: ago(12) },
  { id: "c2", issue_id: "task-9lo", author: "user", text: "我比较看重效果。", created_at: ago(65) },
];
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const touch = (i: Issue) => { i.updated_at = new Date().toISOString(); };
const find = (id: string) => {
  const i = issues.find((x) => x.id === id);
  if (!i) throw new Error(`没有这个任务：${id}`);
  return i;
};

export function fixtureApi(): Api {
  return {
    info: async () => ({ bd_bin: "(浏览器预览：示例数据)", beads_dir: "~/tasks/.beads", actor: "user", version: "preview" }),
    list: async () => issues.map((i) => ({ ...i })),
    show: async (id) => {
      const i = find(id);
      const deps = id === "task-ss0" ? [{ ...find("task-bzz"), dependency_type: "blocks" }] : [];
      return { ...i, dependencies: deps };
    },
    comments: async (id) => comments.filter((c) => c.issue_id === id),
    history: async (id): Promise<HistoryEntry[]> => {
      const i = find(id);
      return [
        { CommitHash: "h2", Committer: "root", CommitDate: i.updated_at, Issue: { ...i } },
        { CommitHash: "h1", Committer: "root", CommitDate: i.created_at, Issue: { ...i, status: "open", assignee: undefined, labels: (i.labels ?? []).filter((l) => l !== "reviewed") } },
      ];
    },
    interactions: async () => [],
    claim: async (id) => { const i = find(id); i.assignee = "user"; i.status = "in_progress"; i.started_at = new Date().toISOString(); touch(i); notify(); },
    setStatus: async (id, status) => { const i = find(id); i.status = status as Status; touch(i); notify(); },
    close: async (id, reason) => { const i = find(id); i.status = "closed"; i.close_reason = reason; i.closed_at = new Date().toISOString(); touch(i); notify(); },
    reopen: async (id) => { const i = find(id); i.status = "open"; i.closed_at = undefined; i.labels = (i.labels ?? []).filter((l) => l !== "reviewed"); touch(i); notify(); },
    comment: async (id, text) => { comments = [...comments, { id: "c" + ++seq, issue_id: id, author: "user", text, created_at: new Date().toISOString() }]; const i = find(id); i.comment_count = (i.comment_count ?? 0) + 1; touch(i); notify(); },
    labels: async (id, add, remove) => { const i = find(id); const s = new Set(i.labels ?? []); add.forEach((l) => s.add(l)); remove.forEach((l) => s.delete(l)); i.labels = [...s]; touch(i); notify(); },
    update: async (id, f) => { const i = find(id); if (f.title !== undefined) i.title = f.title; if (f.description !== undefined) i.description = f.description; if (f.priority !== undefined) i.priority = f.priority; if (f.assignee !== undefined) i.assignee = f.assignee; if (f.acceptance !== undefined) i.acceptance_criteria = f.acceptance; touch(i); notify(); },
    create: async (input) => {
      const i: Issue = { id: "task-" + Math.random().toString(36).slice(2, 5), title: input.title, description: input.description, status: "open", priority: input.priority ?? 2, issue_type: input.issue_type ?? "task", created_by: "user", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), labels: input.labels ?? [], acceptance_criteria: input.acceptance };
      issues = [i, ...issues]; notify(); return i;
    },
    presence: async () => ({
      apps: ["Claude 桌面端"],
      sessions: [
        { agent: "claude-code", session_id: "s1", cwd: "/Users/x/Projects/kanban", project: "kanban", agent_pid: 1, source_kind: "terminal", source_app: "Herdr", entrypoint: "cli", started_at: now / 1000 - 3600, last_at: now / 1000 - 30, state: "working", prompts: 14, alive: true, registered: true, editing: [{ path: "/Users/x/Projects/kanban/app/src/App.tsx", ts: now / 1000 - 40 }, { path: "/Users/x/Projects/kanban/app/src/components/views.tsx", ts: now / 1000 - 120 }] },
        { agent: "claude-code", session_id: "s2", cwd: "/Users/x/Projects/demo-app", project: "demo-app", agent_pid: 2, source_kind: "terminal", source_app: "Warp", entrypoint: "cli", started_at: now / 1000 - 7200, last_at: now / 1000 - 900, state: "idle", prompts: 6, alive: true, registered: true },
        { agent: "claude-code", session_id: "s3", cwd: "/Users/x/dotfiles", project: "dotfiles", agent_pid: 3, source_kind: "desktop", source_app: "Claude 桌面端", entrypoint: "", started_at: now / 1000 - 600, last_at: now / 1000 - 60, state: "idle", prompts: 2, alive: true, registered: true },
        { agent: "codex", session_id: "s4", cwd: "/Users/x/Projects/demo-app", project: "demo-app", agent_pid: 4, source_kind: "terminal", source_app: "Terminal", entrypoint: "", started_at: now / 1000 - 2400, last_at: now / 1000 - 120, state: "working", prompts: 9, alive: true, registered: true, editing: [{ path: "/Users/x/Projects/kanban/app/src/App.tsx", ts: now / 1000 - 60 }, { path: "/Users/x/Projects/demo-app/src/main.tsx", ts: now / 1000 - 200 }] },
      ],
    }),
    taskSessions: async (id) => sessionRefs.filter((r) => r.tasks[id]),
    // The first catalog session is "working": the session page tails it (below, `session … --since`) and shows the live steps.
    sessionActivity: async () => ({ sessions: [{ key: "claude-code:a8cd3bf0-b764-4282-9acb-cf5d16f7f2e8", agent: "claude-code", session_id: "a8cd3bf0-b764-4282-9acb-cf5d16f7f2e8", cwd: "/Users/x/Projects/kanban", project: "kanban", title: "任务集中营软件", last_at: Date.now() / 1000 - 5, state: "working", activity: "正在处理", version: "1", events: [], tasks: ["task-9lo"], unread: false, stale: false, tracking_since: now / 1000 - 3600, source: "transcript" }], updated_at: Date.now()/1000, unavailable_hosts: [] }),
    sessionSeen: async () => {},
    sessionList: async () => sessionRefs,
    sessionDetail: async (id) => {
      const meta = sessionRefs.find((r) => r.session_id.startsWith(id)) ?? sessionRefs[0];
      return {
        meta,
        messages: [
          { ts: new Date(now - 3600e3).toISOString(), role: "user", text: "我想做一个软件，相当于一个任务集中营，所有的任务都在这里。", tools: [], blocks: [{ type: "text", text: "我想做一个软件，相当于一个任务集中营，所有的任务都在这里。" }] },
          { ts: new Date(now - 3500e3).toISOString(), role: "assistant", mid: "m1", text: "先按研究复用流程做一轮调研。", tools: [{ name: "Bash", summary: "gh search repos \"kanban agents\"", id: "t1" }], blocks: [
            { type: "thinking", text: "用户要的是一个任务集中营。先搜现成实现，80% 能复用就不重写；再看本机有没有 bd。" },
            { type: "text", text: "先按研究复用流程做一轮调研。" },
            { type: "tool_call", id: "t1", name: "Bash", summary: "gh search repos \"kanban agents\"", input: { command: "gh search repos \"kanban agents\" --limit 5", description: "Search GitHub" }, status: "done", ts: new Date(now - 3500e3).toISOString(), result: "beads-ui/beads  A kanban for agents\nacme/task-board  Minimal board", result_ts: new Date(now - 3499e3).toISOString() },
          ] },
          { ts: new Date(now - 3000e3).toISOString(), role: "assistant", mid: "m2", text: "", tools: [{ name: "Edit", summary: "/Users/x/Projects/kanban/app/src/App.tsx", id: "t2" }, { name: "Agent", summary: "Verify Claude Code hook fields", id: "t3" }], blocks: [
            { type: "thinking", text: "", note: "内容未记录（模型只留签名）" },
            { type: "tool_call", id: "t2", name: "Edit", summary: "/Users/x/Projects/kanban/app/src/App.tsx", input: { file_path: "/Users/x/Projects/kanban/app/src/App.tsx", old_string: "const b = 2;", new_string: "const b = 3;" }, status: "error", result: "String to replace not found in file.", result_ts: "" },
            { type: "tool_call", id: "t3", name: "Agent", summary: "Verify Claude Code hook fields", input: { description: "Verify Claude Code hook fields", prompt: "Read the hooks docs and list the fields…" }, status: "done", result: "Hook payload has session_id, transcript_path, cwd, hook_event_name.", result_ts: "" },
          ] },
          { ts: new Date(now - 120e3).toISOString(), role: "assistant", mid: "m3", text: "Done — the new build is installed.", tools: [], blocks: [{ type: "text", text: "Done — the new build is installed." }] },
          { ts: new Date(now - 20e3).toISOString(), role: "user", text: "再跑一遍测试", tools: [], blocks: [{ type: "text", text: "再跑一遍测试" }] },
          { ts: new Date(now - 10e3).toISOString(), role: "assistant", mid: "m4", text: "", tools: [{ name: "Bash", summary: "npm test", id: "t4" }], blocks: [{ type: "thinking", text: "跑 vitest 就够了。" }, { type: "tool_call", id: "t4", name: "Bash", summary: "npm test", input: { command: "cd app && npm test" }, status: "running", ts: new Date(now - 10e3).toISOString() }] },
        ],
        offset: 1000,
        files: [
          { path: "/Users/x/Projects/kanban/app/src/App.tsx", changes: [{ kind: "edit", old: "const a = 1;\nconst b = 2;\nreturn a + b;", new: "const a = 1;\nconst b = 3;\nconst c = 4;\nreturn a + b + c;", ts: "" }] },
          { path: "/Users/x/Projects/kanban/app/scripts/install.sh", changes: [{ kind: "write", old: "", new: "#!/bin/bash\nset -euo pipefail\nnpm run tauri build", ts: "" }] },
        ],
        tool_counts: { Bash: 136, Edit: 71, Write: 29, Read: 14, Agent: 1 },
      };
    },
    focusSession: async () => "浏览器预览里没有 Herdr",
    resumeCmd: async (agent, sid, cwd) => `cd '${cwd}' && ${agent === "codex" ? "codex resume" : "claude --resume"} ${sid}`,
    skills: async () => skills.map((s) => ({ ...s, agents: { ...s.agents } })),
    skillToggle: async (name, agent, on) => { const s = skills.find((x) => x.name === name)!; (agent === "all" ? ["claude", "codex"] : [agent]).forEach((a) => (s.agents[a] = on)); return on ? "已挂载" : "已卸载"; },
    skillRead: async (name) => `---\nname: ${name}\ndescription: ${skills.find((x) => x.name === name)?.description ?? ""}\n---\n\n# ${name}\n\n（浏览器预览：示例内容）\n`,
    skillWrite: async (name) => `/pool/${name}/SKILL.md`,
    skillOpen: async () => {},
    skillImprove: async () => ({ prompt: "示例提示词", command: "claude \"…\"", top: [] }),
    envList: async () => [{ name: "ZHIPU_API_KEY", note: "智谱 GLM", masked: "abc…456", length: 12 }],
    insights: async () => ({ days: 14, total_sessions: 3, per_agent: { "claude-code": { sessions: 3, user_turns: 40, approve: 0, continue: 2, correction: 1, asktail: 5, ends_on_question: 1, long: 0, overflow: 0, tool_errors: 2, no_board: 1 } }, sessions: [], samples: { asktail: [], correction: [], overflow: [] }, findings: ["示例：助手以问句收尾 5 次"], rules: [{ key: "asktail", name: "问句/选项收尾", how: "示例规则" }], alerts: [{ id: "demo", kind: "no_board", session_id: "demo", agent: "claude-code", ts: "", text: "示例：一个 20 轮的会话没有上板", seen: false }], prompt: "示例", command: "claude \"示例\"" }),
    insightAlerts: async () => [],
    insightsAck: async () => {},
    insightReports: async () => ({ running: null, schedule: { every_days: 14 }, reports: [] }),
    insightReport: async () => null,
    insightGenerate: async () => {},
    insightSchedule: async () => {},
    insightDue: async () => {},
    envGet: async () => "abc123def456",
    envSet: async () => {},
    envUnset: async () => {},
    openPath: async () => {},
    hosts: async () => [],
    on: async (_h, args) => {
      if (args[0] === 'session' && args[2] === '--since') {
        // The live tail, scripted: the running test finishes, the agent thinks, then answers.
        const since = Number(args[3]); const t = (ts: number) => new Date(now + ts * 1000).toISOString();
        const steps: Record<number, unknown> = {
          1000: { partial: true, since: 1000, offset: 1001, messages: [], resolved: [{ id: "t4", status: "done", result: "Test Files  6 passed (6)\n     Tests  61 passed (61)", result_ts: t(1) }], files: [], tool_counts: {} },
          1001: { partial: true, since: 1001, offset: 1002, messages: [{ ts: t(2), role: "assistant", mid: "m5", text: "", tools: [], blocks: [{ type: "thinking", text: "全过了，跟用户说一声。" }] }], resolved: [], files: [], tool_counts: {} },
          1002: { partial: true, since: 1002, offset: 1003, messages: [{ ts: t(3), role: "assistant", mid: "m5", text: "测试全部通过：6 个文件、61 个用例。", tools: [], blocks: [{ type: "text", text: "测试全部通过：6 个文件、61 个用例。" }] }], resolved: [], files: [], tool_counts: {} },
        };
        return JSON.stringify(steps[since] ?? { partial: true, since, offset: since, messages: [], resolved: [], files: [], tool_counts: {} });
      }
      if(args[0]==='task') { const i=find(args[2]); const labels=i.labels??[];
        if(args[1]==='trash'&&!labels.includes('dispatch:trashed')) {i.labels=[...labels,'dispatch:trashed',`dispatch:previous:${i.status}`];i.status='deferred';}
        else if(args[1]==='restore'){i.status=(labels.find(l=>l.startsWith('dispatch:previous:'))?.split(':')[2]||'open') as Status;i.labels=labels.filter(l=>!l.startsWith('dispatch:'));}
        touch(i);notify();return JSON.stringify(i);
      }
      throw new Error('这是示例预览，请在桌面版或已连接的网页端使用此功能');
    },
    agentStart: async () => null,
    graph: async () => ({ nodes: issues.map((i) => ({ ...i })), edges: [
      { from: "task-9lo", to: "task-4mk", type: "discovered-from" }, { from: "task-9lo", to: "task-e1q", type: "discovered-from" },
      { from: "task-4mk", to: "task-m3r", type: "discovered-from" }, { from: "task-e1q", to: "task-m3r", type: "discovered-from" },
      { from: "task-bzz", to: "task-ss0", type: "blocks" }, { from: "task-a1c", to: "task-9lo", type: "discovered-from" },
    ] }),
    stats: async () => null,
    quota: async () => [
      { agent: "claude-code", plan: "Max", windows: [{ label: "5 小时", used_percent: 9, resets_at: now / 1000 + 9900 }, { label: "每周", used_percent: 5, resets_at: now / 1000 + 46500 }], updated_at: now / 1000 - 60, source: "statusline", note: "" },
      { agent: "codex", plan: "plus", windows: [{ label: "5 小时", used_percent: 0, resets_at: now / 1000 + 4000 }, { label: "每周", used_percent: 21, resets_at: now / 1000 + 400000 }], updated_at: now / 1000 - 3600, source: "rollout", note: "" },
      { agent: "zcode", plan: "GLM Coding", windows: [], updated_at: null, source: "", note: "ZCode 的凭证是加密的，额度只能在 ZCode 里看" },
    ],
    rulesRead: async () => rulesText,
    rulesWrite: async (c) => { rulesText = c; },
    rulesStatus: async () => ({ hash: "abc123", source: "~/Projects/kanban/agent/rules/GLOBAL.md", targets: [
      { agent: "claude", path: "/Users/x/.claude/CLAUDE.md", state: "synced", mode: "import" },
      { agent: "codex", path: "/Users/x/.codex/AGENTS.md", state: "stale", mode: "inline" },
      { agent: "zcode", path: "/Users/x/.zcode/AGENTS.md", state: "missing", mode: "inline" },
    ] }),
    rulesSync: async () => {},
    memories: async () => memories.map((m) => ({ ...m })),
    remember: async (key, value) => { const i = memories.findIndex((m) => m.key === key); if (i >= 0) memories[i] = { key, value }; else memories.push({ key, value }); notify(); },
    forget: async (key) => { memories = memories.filter((m) => m.key !== key); notify(); },
    copy: async (text) => { await navigator.clipboard.writeText(text); },
    notify: async (title, body) => { console.log("[notify]", title, body); },
    tray: async () => {},
    onChange: async (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

const sessionRefs: import("./types").SessionRef[] = [
  { agent: "claude-code", session_id: "a8cd3bf0-b764-4282-9acb-cf5d16f7f2e8", cwd: "/Users/x/Projects/kanban", project: "kanban", title: "任务集中营软件", last_at: now / 1000 - 120, first_ts: new Date(now - 4 * 3600e3).toISOString(), last_ts: new Date(now - 120e3).toISOString(), entrypoint: "cli", branch: "main", user_msgs: 299, assistant_msgs: 392, tools: { Bash: 136, Edit: 71 }, tasks: { "task-9lo": 124 }, mentions: 124, current_task: "task-9lo", resume_cmd: "cd '/Users/x/Projects/kanban' && claude --resume a8cd3bf0-b764-4282-9acb-cf5d16f7f2e8", path: "", size: 2_400_000, subagents: [{ agent_id: "a5bf41fb", type: "claude-code-guide", description: "Verify Claude Code hook fields", tool_use_id: "toolu_1", depth: 1, size: 40000, last_at: now / 1000 - 3000, path: "" }] },
  { agent: "claude-code", session_id: "5d5bd874-5e65-4a4d-aab6-f2cb7985ca69", cwd: "/Users/x/Projects/bookmark", project: "bookmark", title: "Bookmark Chrome extension", last_at: now / 1000 - 7 * 3600, first_ts: "", last_ts: "", entrypoint: "cli", branch: "main", user_msgs: 133, assistant_msgs: 200, tools: {}, tasks: {}, mentions: 0, current_task: null, resume_cmd: "cd '/Users/x/Projects/bookmark' && claude --resume 5d5bd874-5e65-4a4d-aab6-f2cb7985ca69", path: "", size: 900_000, subagents: [] },
  { agent: "codex", session_id: "019deafa-bcc4-7100-8cdb-0193b715e090", cwd: "/Users/x/Projects/demo-app", project: "demo-app", title: "河牌下注逻辑", last_at: now / 1000 - 5000, first_ts: "", last_ts: "", entrypoint: "", branch: "", user_msgs: 9, assistant_msgs: 12, tools: {}, tasks: { "task-4mk": 3 }, mentions: 3, current_task: "task-4mk", resume_cmd: "cd '/Users/x/Projects/demo-app' && codex resume 019deafa-bcc4-7100-8cdb-0193b715e090", path: "", size: 120_000, subagents: [] },
];

const skills: import("./types").Skill[] = [
  { name: "task-board", path: "/pool/task-board", in_pool: true, description: "全局任务板（Beads / bd CLI）。所有 Agent 共用同一块板。", agents: { claude: true, codex: false } },
  { name: "herdr", path: "/pool/herdr", in_pool: true, description: "Control Herdr, a terminal multiplexer for coding agents.", agents: { claude: true, codex: true } },
  { name: "frontend-design", path: "/pool/frontend-design", in_pool: true, description: "Guidance for distinctive, intentional visual design.", agents: { claude: true, codex: false } },
  { name: "academic-plotting", path: "/pool/academic-plotting", in_pool: true, description: "Publication-quality matplotlib figures.", agents: { claude: false, codex: true } },
  { name: "beads", path: "/Users/x/.agents/skills/beads", in_pool: false, description: "Use when working in a repository that uses bd or Beads.", agents: { claude: false, codex: true } },
];

let rulesText = "# 这台电脑上所有 Agent 的共同规则\n\n## 0. Shell 环境\n\n- 默认 shell 是 **fish**。\n\n## 4. 过程记录\n\n- 开工前板上不会有任务……\n";

let memories: { key: string; value: string }[] = [
  { key: "pit-launchctl-beads-actor", value: "【坑】launchctl setenv BEADS_ACTOR cursor 会让所有从 Dock 启动的 GUI（包括 Dispatch）以 Cursor 身份写库。【解法】GUI 应用各自用专属变量（Dispatch 用 DISPATCH_ACTOR）。#project:kanban #task:task-9lo" },
  { key: "pit-eza-symlink-rm", value: "【坑】for s in $(ls ~/.claude/skills) 里 ls 是 eza 别名，软链渲染成箭头，rm -rf 打到技能池本体，误删 25 个技能。【解法】要解析输出一律 command ls -1；批量删除先导出清单并核对条数。#project:dotfiles" },
  { key: "pit-tauri-sync-command", value: "【坑】Tauri 命令写成同步 fn 会在主线程跑，每次 bd 调用 300ms 直接冻住 UI。【解法】全部 async fn + spawn_blocking。#project:kanban #task:task-9lo" },
  { key: "auth-jwt", value: "auth module uses JWT not sessions" },
];
