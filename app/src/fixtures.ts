// Browser-preview fallback: an in-memory board so the UI can be exercised without Tauri.
// Everything here is invented (five fictional projects under a made-up user) so the public
// demo and the screenshots never show anyone's real work.
import type { Api, } from "./api";
import type { Comment, HistoryEntry, Issue, Status, SessionRef, TimelineMsg } from "./types";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const sec = (min: number) => now / 1000 - min * 60;
const HOME = "/Users/mia";
const P = (name: string) => `${HOME}/Projects/${name}`;
const HOST: import("./types").Host = { id: "local", name: "MacBook Pro", ip: "", ssh: "", online: true, local: true, overlay: { kind: "", ip: "" }, screen_sharing: false, novnc: "", novnc_up: false, vnc: "", rustdesk: false, rustdesk_id: "", sunshine: false, sunshine_ui: "", uu: false, recommend: "", why: "" };

// ---------------------------------------------------------------- five projects
// lumen-notes  Obsidian 插件（TypeScript）      harbor-api  Rust 后端服务
// sprout       iOS 记账 App（Swift）             atlas-site  公司官网（Astro）
// quill-cli    Python 命令行工具

const S = {
  lumen: "c1a4e8d2-7b3f-4e9a-9c21-0f6d5a8b1e77",
  lumenRelease: "019f2b3c-8d4e-7a10-b5c6-3e7f9a0d1c22",
  harbor: "pi-7f3e2a9c",
  sprout: "d9e1f2a3-b4c5-4d6e-8f70-1a2b3c4d5e6f",
  sproutPerf: "ses_open_8a1c9d",
  atlas: "019f2c4d-1e2f-7b30-a4d5-6c7e8f9a0b11",
  quill: "e4f5a6b7-c8d9-4e0f-a1b2-c3d4e5f6a7b8",
};

let issues: Issue[] = [
  // lumen-notes
  { id: "task-ln12", title: "反向链接面板：按来源分组、点击跳到原句", description: "右侧栏新增面板，列出指向当前笔记的所有链接，按来源笔记分组；点击定位到原句并高亮。", status: "in_progress", priority: 1, issue_type: "feature", assignee: "claude-code", created_by: "user", created_at: ago(180), updated_at: ago(3), started_at: ago(160), labels: ["project:lumen-notes", `session-origin:${S.lumen}`, `session:${S.lumen}`], acceptance_criteria: "- [x] 面板能列出全部反向链接\n- [x] 按来源分组，组内按段落顺序\n- [ ] 点击定位并高亮原句\n- [ ] 1 万篇笔记的库打开面板 < 200ms", comment_count: 2 },
  { id: "task-ln20", title: "Canvas 节点与笔记双向同步", status: "open", priority: 2, issue_type: "feature", created_by: "user", created_at: ago(900), updated_at: ago(900), labels: ["project:lumen-notes"] },
  { id: "task-ln08", title: "首版打包并提交社区插件市场", status: "closed", priority: 1, issue_type: "task", assignee: "codex", created_by: "user", created_at: ago(2600), updated_at: ago(1500), closed_at: ago(1500), close_reason: "v0.3.0 已通过审核上架；发布脚本 npm run release 一键出包、打 tag、写 CHANGELOG。", labels: ["project:lumen-notes", `session:${S.lumenRelease}`, "reviewed"] },
  { id: "task-ln05", title: "ESLint + vitest 接入，CI 跑测试", status: "closed", priority: 3, issue_type: "chore", assignee: "claude-code", created_by: "claude-code", created_at: ago(3900), updated_at: ago(3300), closed_at: ago(3300), close_reason: "23 个用例，CI 2 分钟内跑完。", labels: ["project:lumen-notes"] },
  // harbor-api
  { id: "task-hb31", title: "多租户限流：按租户的 token bucket，超限返回 429 + Retry-After", description: "每个租户独立配额，默认 600 req/min；管理端可临时放宽。", status: "in_progress", priority: 1, issue_type: "feature", assignee: "pi", created_by: "user", created_at: ago(420), updated_at: ago(26), started_at: ago(400), labels: ["project:harbor-api", `session-origin:${S.harbor}`, `session:${S.harbor}`], acceptance_criteria: "- [x] 中间件按租户计数\n- [x] 429 带 Retry-After\n- [ ] 压测 2000 rps 无误判\n- [ ] 指标接进 Prometheus" },
  { id: "task-hb27", title: "迁移到 Postgres 16（等运维开维护窗口）", status: "blocked", priority: 2, issue_type: "task", created_by: "user", created_at: ago(1300), updated_at: ago(600), labels: ["project:harbor-api"], dependency_count: 1 },
  { id: "task-hb26", title: "运维确认周四晚维护窗口", status: "open", priority: 2, issue_type: "task", created_by: "user", created_at: ago(1300), updated_at: ago(1300), labels: ["project:harbor-api", "dispatch:needs-you"], description: "只有你能做：找运维确认周四 22:00 到 23:00 的窗口，确认后把 task-hb27 解除阻塞。" },
  { id: "task-hb19", title: "健康检查与 readiness 探针", status: "closed", priority: 2, issue_type: "task", assignee: "pi", created_by: "pi", created_at: ago(2900), updated_at: ago(2500), closed_at: ago(2500), close_reason: "/healthz 与 /readyz 分开；k8s 滚动更新不再打到未就绪实例。", labels: ["project:harbor-api", "reviewed"] },
  // sprout
  { id: "task-sp44", title: "本月预算超支时推送提醒（按分类）", description: "餐饮、交通等分类各自设预算，超过 90% 提醒一次、超过 100% 再提醒一次。", status: "in_progress", priority: 1, issue_type: "feature", assignee: "claude-code", created_by: "user", created_at: ago(700), updated_at: ago(38), started_at: ago(650), labels: ["project:sprout", `session-origin:${S.sprout}`, `session:${S.sprout}`], acceptance_criteria: "- [x] 分类预算设置页\n- [x] 90% / 100% 两档提醒\n- [x] 同一档一天只提醒一次\n- [ ] 真机验证通知权限被拒时的引导", comment_count: 1 },
  { id: "task-sp40", title: "iCloud 同步冲突：同一条记录两端都改过", status: "open", priority: 2, issue_type: "bug", created_by: "user", created_at: ago(1100), updated_at: ago(1100), labels: ["project:sprout"] },
  { id: "task-sp39", title: "给 Apple 开发者账号续费", status: "open", priority: 1, issue_type: "task", created_by: "claude-code", created_at: ago(300), updated_at: ago(300), labels: ["project:sprout", "dispatch:needs-you"], description: "只有你能做：会员 9 月 30 日到期，TestFlight 构建会失效。" },
  { id: "task-sp33", title: "图表页滚动掉帧：饼图改成离屏渲染", status: "closed", priority: 2, issue_type: "bug", assignee: "opencode", created_by: "user", created_at: ago(2000), updated_at: ago(1700), closed_at: ago(1700), close_reason: "60fps 稳定；Instruments 里主线程占用从 78% 降到 22%。", labels: ["project:sprout", `session:${S.sproutPerf}`, "reviewed"] },
  { id: "task-sp21", title: "记账快捷指令：Siri 一句话记一笔", status: "closed", priority: 3, issue_type: "feature", assignee: "claude-code", created_by: "user", created_at: ago(5200), updated_at: ago(4600), closed_at: ago(4600), labels: ["project:sprout"] },
  // atlas-site
  { id: "task-at15", title: "定价页三档对比表 + 年付切换", status: "open", priority: 2, issue_type: "feature", assignee: "codex", created_by: "user", created_at: ago(240), updated_at: ago(240), labels: ["project:atlas-site", `session:${S.atlas}`] },
  { id: "task-at11", title: "图片改 WebP、懒加载：LCP 从 3.1s 降到 1.4s", status: "closed", priority: 1, issue_type: "task", assignee: "codex", created_by: "user", created_at: ago(1900), updated_at: ago(1600), closed_at: ago(1600), close_reason: "Lighthouse 性能 71 → 96。", labels: ["project:atlas-site", `session-origin:${S.atlas}`, `session:${S.atlas}`, "reviewed"] },
  // quill-cli
  { id: "task-qc09", title: "批量转换支持断点续跑，中断后从上次的文件继续", status: "in_progress", priority: 2, issue_type: "feature", assignee: "claude-code", created_by: "user", created_at: ago(1500), updated_at: ago(400), started_at: ago(1400), labels: ["project:quill-cli", `session-origin:${S.quill}`, `session:${S.quill}`], acceptance_criteria: "- [x] 进度写进 .quill/state.json\n- [x] --resume 从上次继续\n- [ ] 文档里补一段" },
  { id: "task-qc07", title: "表格识别时保留列对齐", status: "closed", priority: 2, issue_type: "bug", assignee: "claude-code", created_by: "user", created_at: ago(3000), updated_at: ago(2600), closed_at: ago(2600), close_reason: "用列边界聚类替代空格切分，30 份样本全对齐。", labels: ["project:quill-cli", "reviewed"] },
  // 成果：Agent 在 `dispatch done` 时登记的、值得对外说一句的结果
  { id: "task-ln09", title: "lumen-notes v0.3.0 上架 Obsidian 社区插件市场", description: "首版通过审核上架；一条命令出包、打 tag、写 CHANGELOG。", status: "closed", priority: 2, issue_type: "task", created_by: "codex", created_at: ago(1500), updated_at: ago(1500), closed_at: ago(1500), labels: ["project:lumen-notes", "dispatch:outcome", "outcome-task:task-ln08"] },
  { id: "task-hb20", title: "harbor-api 滚动更新零失误：readiness 探针上线", description: "k8s 不再把流量打到未就绪实例。", status: "closed", priority: 2, issue_type: "task", created_by: "pi", created_at: ago(2500), updated_at: ago(2500), closed_at: ago(2500), labels: ["project:harbor-api", "dispatch:outcome", "outcome-task:task-hb19"] },
  { id: "task-sp34", title: "sprout 图表页 60fps：主线程占用 78% → 22%", description: "饼图离屏渲染。", status: "closed", priority: 2, issue_type: "task", created_by: "opencode", created_at: ago(1700), updated_at: ago(1700), closed_at: ago(1700), labels: ["project:sprout", "dispatch:outcome", "outcome-task:task-sp33"] },
  { id: "task-at12", title: "atlas-site 首页 LCP 1.4s，Lighthouse 96", description: "图片改 WebP + 懒加载。", status: "closed", priority: 2, issue_type: "task", created_by: "codex", created_at: ago(1600), updated_at: ago(1600), closed_at: ago(1600), labels: ["project:atlas-site", "dispatch:outcome", "outcome-task:task-at11"] },
  { id: "task-qc08", title: "quill-cli 表格识别 30 份样本全部列对齐", description: "按列边界聚类切分。", status: "closed", priority: 2, issue_type: "task", created_by: "claude-code", created_at: ago(2600), updated_at: ago(2600), closed_at: ago(2600), labels: ["project:quill-cli", "dispatch:outcome", "outcome-task:task-qc07"] },
];
let comments: Comment[] = [
  { id: "c1", issue_id: "task-ln12", author: "claude-code", text: "分组已按来源笔记做好；点击定位要拿到段落 id，正在改索引结构。", created_at: ago(3) },
  { id: "c2", issue_id: "task-ln12", author: "user", text: "分组内按段落顺序排，别按时间。", created_at: ago(120) },
  { id: "c3", issue_id: "task-sp44", author: "claude-code", text: "两档提醒都过了模拟器测试；真机等你把通知权限拒一次再验。", created_at: ago(38) },
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

const sessionRefs: SessionRef[] = [
  { agent: "claude-code", session_id: S.lumen, cwd: P("lumen-notes"), project: "lumen-notes", title: "反向链接面板与搜索索引", last_at: sec(0.2), first_ts: ago(160), last_ts: ago(0.2), entrypoint: "cli", branch: "feat/backlinks", user_msgs: 41, assistant_msgs: 58, tools: { Bash: 52, Edit: 31, Read: 40 }, tasks: { "task-ln12": 37 }, mentions: 37, current_task: "task-ln12", resume_cmd: `cd '${P("lumen-notes")}' && claude --resume ${S.lumen}`, path: "", size: 1_800_000, subagents: [{ agent_id: "b71c0d2e", type: "Explore", description: "找出所有读取 metadataCache 的调用点", tool_use_id: "toolu_1", depth: 1, size: 60000, last_at: sec(90), path: "" }], summary: "用户要一个反向链接面板。Agent 先把链接索引改成按段落存，做完分组列表，正在做点击定位与高亮；性能目标是万篇笔记 200ms 内。" },
  { agent: "codex", session_id: S.lumenRelease, cwd: P("lumen-notes"), project: "lumen-notes", title: "发布脚本与 CHANGELOG", last_at: sec(1500), first_ts: ago(1600), last_ts: ago(1500), entrypoint: "", branch: "main", user_msgs: 12, assistant_msgs: 17, tools: { Bash: 20, Edit: 6 }, tasks: { "task-ln08": 9 }, mentions: 9, current_task: "task-ln08", resume_cmd: `cd '${P("lumen-notes")}' && codex resume ${S.lumenRelease}`, path: "", size: 320_000, subagents: [], summary: "把打包、打 tag、写 CHANGELOG 收成 npm run release 一条命令，v0.3.0 提交社区市场并通过审核。" },
  { agent: "pi", session_id: S.harbor, cwd: P("harbor-api"), project: "harbor-api", title: "限流中间件与 429 重试", last_at: sec(26), first_ts: ago(400), last_ts: ago(26), entrypoint: "cli", branch: "feat/rate-limit", user_msgs: 23, assistant_msgs: 30, tools: { Bash: 44, Edit: 18 }, tasks: { "task-hb31": 21 }, mentions: 21, current_task: "task-hb31", resume_cmd: `cd '${P("harbor-api")}' && pi --session ${S.harbor}`, path: "", size: 640_000, subagents: [], summary: "按租户 token bucket 的限流中间件已能返回 429 + Retry-After；接下来压测和接 Prometheus 指标。" },
  { agent: "claude-code", session_id: S.sprout, cwd: P("sprout"), project: "sprout", title: "预算超支推送提醒", last_at: sec(38), first_ts: ago(650), last_ts: ago(38), entrypoint: "cli", branch: "main", user_msgs: 30, assistant_msgs: 44, tools: { Bash: 27, Edit: 25, Read: 33 }, tasks: { "task-sp44": 28 }, mentions: 28, current_task: "task-sp44", resume_cmd: `cd '${P("sprout")}' && claude --resume ${S.sprout}`, path: "", size: 1_100_000, subagents: [], summary: "分类预算设置页和 90%/100% 两档提醒做完，模拟器通过；等用户真机验证通知权限被拒的引导。" },
  { agent: "opencode", session_id: S.sproutPerf, cwd: P("sprout"), project: "sprout", title: "图表页滚动掉帧", last_at: sec(1700), first_ts: ago(1900), last_ts: ago(1700), entrypoint: "", branch: "main", user_msgs: 8, assistant_msgs: 11, tools: { Bash: 9, Edit: 5 }, tasks: { "task-sp33": 6 }, mentions: 6, current_task: "task-sp33", resume_cmd: `cd '${P("sprout")}' && opencode --session ${S.sproutPerf}`, path: "", size: 210_000, subagents: [], summary: "饼图改离屏渲染后 60fps 稳定，主线程占用从 78% 降到 22%。" },
  { agent: "codex", session_id: S.atlas, cwd: P("atlas-site"), project: "atlas-site", title: "定价页与首页性能", last_at: sec(240), first_ts: ago(1900), last_ts: ago(240), entrypoint: "", branch: "main", user_msgs: 19, assistant_msgs: 26, tools: { Bash: 30, Edit: 14 }, tasks: { "task-at11": 12, "task-at15": 5 }, mentions: 17, current_task: "task-at15", resume_cmd: `cd '${P("atlas-site")}' && codex resume ${S.atlas}`, path: "", size: 480_000, subagents: [], summary: "首页图片改 WebP 并懒加载，LCP 从 3.1s 降到 1.4s；接着做定价页三档对比表和年付切换。" },
  { agent: "claude-code", session_id: S.quill, cwd: P("quill-cli"), project: "quill-cli", title: "PDF 批量转 Markdown 的断点续跑", last_at: sec(400), first_ts: ago(1400), last_ts: ago(400), entrypoint: "cli", branch: "main", user_msgs: 16, assistant_msgs: 22, tools: { Bash: 24, Edit: 12, Read: 18 }, tasks: { "task-qc09": 15 }, mentions: 15, current_task: "task-qc09", resume_cmd: `cd '${P("quill-cli")}' && claude --resume ${S.quill}`, path: "", size: 560_000, subagents: [], summary: "进度写进 .quill/state.json，--resume 能从上次中断的文件继续；文档还差一段。" },
];

const refOf = (id: string) => sessionRefs.find((r) => r.session_id === id)!;
const act = (id: string, state: "working" | "idle", extra: Partial<import("./types").Activity> = {}) => {
  const r = refOf(id);
  return { key: `${r.agent}:${r.session_id}`, agent: r.agent, session_id: r.session_id, cwd: r.cwd, project: r.project, title: r.title, last_at: r.last_at, state, activity: state === "working" ? "正在处理" : "本轮结束", version: "1", events: [], tasks: Object.keys(r.tasks), unread: false, stale: false, tracking_since: sec(600), source: "transcript", host: "local", host_name: HOST.name, summary: r.summary, ...extra };
};
const activities = () => [
  act(S.lumen, "working", { activity: "已执行 · vitest run backlinks（正在做点击定位）" }),
  act(S.sprout, "idle", { unread: true, reply_id: `${sec(38)}:r1`, reply_at: sec(38), reply_preview: "两档提醒都过了模拟器测试；真机等你把通知权限拒一次再验，我把引导页也加上了。" }),
  act(S.harbor, "idle", { unread: true, reply_id: `${sec(26)}:r2`, reply_at: sec(26), reply_preview: "限流中间件已带 Retry-After；压测脚本写好了，跑之前想确认一下目标 rps。" }),
  act(S.atlas, "idle"),
  act(S.quill, "idle"),
  act(S.lumenRelease, "idle"),
  act(S.sproutPerf, "idle"),
];

// ---------------------------------------------------------------- transcripts
const T = (min: number) => new Date(now - min * 60_000).toISOString();
const msg = (ts: string, role: TimelineMsg["role"], text: string, extra: Partial<TimelineMsg> = {}): TimelineMsg => ({ ts, role, text, tools: [], blocks: text ? [{ type: "text", text }] : [], ...extra } as TimelineMsg);
const bash = (id: string, cmd: string, result: string, status: "done" | "running" = "done") => ({ type: "tool_call", id, name: "Bash", summary: cmd, input: { command: cmd, description: cmd }, status, result: status === "done" ? result : undefined });
const edit = (id: string, path: string, oldS: string, newS: string) => ({ type: "tool_call", id, name: "Edit", summary: path, input: { file_path: path, old_string: oldS, new_string: newS }, status: "done", result: "已修改" });

const transcripts: Record<string, () => TimelineMsg[]> = {
  [S.lumen]: () => [
    msg(T(160), "user", "做一个反向链接面板：右侧栏列出指向当前笔记的所有链接，按来源分组，点了能跳到原句。"),
    msg(T(158), "assistant", "先看现有的链接索引是按什么存的，再决定要不要改结构。", { mid: "m1", tools: [{ name: "Read", summary: "src/index/links.ts", id: "t1" }], blocks: [{ type: "thinking", text: "现在索引只记到笔记级，做不到跳到原句；要改成按段落存。" }, { type: "text", text: "先看现有的链接索引是按什么存的，再决定要不要改结构。" }, { type: "tool_call", id: "t1", name: "Read", summary: "src/index/links.ts", input: { file_path: `${P("lumen-notes")}/src/index/links.ts` }, status: "done", result: "export class LinkIndex { … byTarget: Map<string, string[]> … }" }] } as Partial<TimelineMsg>),
    msg(T(120), "user", "分组内按段落顺序排，别按时间。"),
    msg(T(118), "assistant", "改成按段落存索引，面板按来源笔记分组、组内按段落顺序。", { mid: "m2", tools: [{ name: "Edit", summary: "src/index/links.ts", id: "t2" }, { name: "Edit", summary: "src/ui/BacklinksPane.tsx", id: "t3" }], blocks: [{ type: "text", text: "改成按段落存索引，面板按来源笔记分组、组内按段落顺序。" }, edit("t2", `${P("lumen-notes")}/src/index/links.ts`, "byTarget: Map<string, string[]>", "byTarget: Map<string, { source: string; block: string; line: number }[]>"), edit("t3", `${P("lumen-notes")}/src/ui/BacklinksPane.tsx`, "items.sort((a, b) => b.mtime - a.mtime)", "items.sort((a, b) => a.line - b.line)")] } as Partial<TimelineMsg>),
    msg(T(6), "assistant", "分组列表做完了，1 万篇的测试库打开面板 140ms。现在做点击定位。", { mid: "m3" }),
    msg(T(1), "assistant", "", { mid: "m4", tools: [{ name: "Bash", summary: "npx vitest run backlinks", id: "t4" }], blocks: [{ type: "thinking", text: "先把定位用的段落 id 加进索引，再跑一遍测试。" }, bash("t4", "npx vitest run backlinks", "", "running")] } as Partial<TimelineMsg>),
  ],
  [S.sprout]: () => [
    msg(T(650), "user", "本月分类预算超过 90% 提醒一次，超过 100% 再提醒一次，一天同一档只提醒一次。"),
    msg(T(640), "assistant", "先加分类预算的设置页，再做提醒的判定和去重。", { mid: "m1", tools: [{ name: "Edit", summary: "Sprout/Budget/BudgetSettingsView.swift", id: "t1" }], blocks: [{ type: "text", text: "先加分类预算的设置页，再做提醒的判定和去重。" }, edit("t1", `${P("sprout")}/Sprout/Budget/BudgetSettingsView.swift`, "// TODO budget per category", "ForEach(categories) { c in BudgetRow(category: c) }")] } as Partial<TimelineMsg>),
    msg(T(60), "assistant", "", { mid: "m2", tools: [{ name: "Bash", summary: "xcodebuild test -scheme Sprout -destination 'platform=iOS Simulator,name=iPhone 16'", id: "t2" }], blocks: [bash("t2", "xcodebuild test -scheme Sprout -destination 'platform=iOS Simulator,name=iPhone 16'", "Test Suite 'BudgetAlertTests' passed (12 tests)")] } as Partial<TimelineMsg>),
    msg(T(38), "assistant", "两档提醒都过了模拟器测试；真机等你把通知权限拒一次再验，我把引导页也加上了。", { mid: "m3" }),
  ],
  [S.harbor]: () => [
    msg(T(400), "user", "加多租户限流：每个租户独立 token bucket，超限 429 带 Retry-After。"),
    msg(T(390), "assistant", "用 tower 中间件做，桶放在 DashMap 里按租户 id 取。", { mid: "m1", tools: [{ name: "Edit", summary: "src/middleware/rate_limit.rs", id: "t1" }], blocks: [{ type: "text", text: "用 tower 中间件做，桶放在 DashMap 里按租户 id 取。" }, edit("t1", `${P("harbor-api")}/src/middleware/rate_limit.rs`, "", "pub struct TenantLimiter { buckets: DashMap<TenantId, Bucket> }")] } as Partial<TimelineMsg>),
    msg(T(40), "assistant", "", { mid: "m2", tools: [{ name: "Bash", summary: "cargo test rate_limit", id: "t2" }], blocks: [bash("t2", "cargo test rate_limit", "test result: ok. 9 passed; 0 failed")] } as Partial<TimelineMsg>),
    msg(T(26), "assistant", "限流中间件已带 Retry-After；压测脚本写好了，跑之前想确认一下目标 rps：按 2000 来？", { mid: "m3" }),
  ],
  [S.atlas]: () => [
    msg(T(1900), "user", "首页 LCP 3.1 秒，太慢。"),
    msg(T(1880), "assistant", "图片是主因：改 WebP、加 loading=lazy、首屏图预加载。", { mid: "m1", tools: [{ name: "Bash", summary: "npx @squoosh/cli --webp auto public/img/*.png", id: "t1" }], blocks: [{ type: "text", text: "图片是主因：改 WebP、加 loading=lazy、首屏图预加载。" }, bash("t1", "npx @squoosh/cli --webp auto public/img/*.png", "24 files → webp, 8.1 MB → 1.3 MB")] } as Partial<TimelineMsg>),
    msg(T(1600), "assistant", "LCP 1.4s，Lighthouse 性能 96。", { mid: "m2" }),
    msg(T(250), "user", "定价页做三档对比表，加年付/月付切换。"),
    msg(T(240), "assistant", "好，先出结构：三列对比 + 顶部切换，年付显示折后价。", { mid: "m3" }),
  ],
  [S.quill]: () => [
    msg(T(1400), "user", "批量转换几百个 PDF 时中断了要能接着跑。"),
    msg(T(1390), "assistant", "把进度写到 .quill/state.json，加 --resume。", { mid: "m1", tools: [{ name: "Edit", summary: "quill/batch.py", id: "t1" }], blocks: [{ type: "text", text: "把进度写到 .quill/state.json，加 --resume。" }, edit("t1", `${P("quill-cli")}/quill/batch.py`, "for pdf in pdfs:", "for pdf in remaining(pdfs, state):")] } as Partial<TimelineMsg>),
    msg(T(400), "assistant", "--resume 从上次的文件继续了；README 里还差一段说明。", { mid: "m2" }),
  ],
  [S.lumenRelease]: () => [
    msg(T(1600), "user", "把打包、打 tag、写 CHANGELOG 收成一条命令。"),
    msg(T(1590), "assistant", "npm run release：build → 校验 manifest → git tag → 生成 CHANGELOG → 提交社区市场 PR。", { mid: "m1" }),
    msg(T(1500), "assistant", "v0.3.0 已上架。", { mid: "m2" }),
  ],
  [S.sproutPerf]: () => [
    msg(T(1900), "user", "图表页往下滑会掉帧。"),
    msg(T(1700), "assistant", "饼图每帧重画是主因，改成离屏渲染后 60fps 稳定，主线程占用 78% → 22%。", { mid: "m1" }),
  ],
};

const detailFor = (ref: SessionRef) => {
  const messages = (transcripts[ref.session_id] ?? (() => []))();
  const files = ref.session_id === S.lumen ? [
    { path: `${P("lumen-notes")}/src/index/links.ts`, changes: [{ kind: "edit" as const, old: "byTarget: Map<string, string[]>", new: "byTarget: Map<string, { source: string; block: string; line: number }[]>", ts: T(118) }] },
    { path: `${P("lumen-notes")}/src/ui/BacklinksPane.tsx`, changes: [{ kind: "edit" as const, old: "items.sort((a, b) => b.mtime - a.mtime)", new: "items.sort((a, b) => a.line - b.line)", ts: T(118) }] },
  ] : [];
  return { meta: ref, messages, files, tool_counts: ref.tools, offset: 1000 };
};

// ---------------------------------------------------------------- project page material
const wiki = [
  { key: "pit-obsidian-metadatacache", kind: "pit", project: "lumen-notes", task: "task-ln12", text: "Obsidian 的 metadataCache 在启动后几秒才填满，插件 onload 里直接读会拿到空索引。", fields: { "【解法】": "监听 metadataCache 的 resolved 事件后再建索引；之前的调用点统一走一个 ready() Promise。" } },
  { key: "win-release-one-command", kind: "win", project: "lumen-notes", task: "task-ln08", text: "发布收成一条命令后再没漏过 CHANGELOG。", fields: { "【为什么】": "步骤一多就会漏；脚本里每一步不通过就停，出包前先校验 manifest 版本号。" } },
  { key: "pit-tower-layer-order", kind: "pit", project: "harbor-api", task: "task-hb31", text: "限流层放在认证层前面时拿不到租户 id，全部落到匿名桶。", fields: { "【解法】": "ServiceBuilder 里 layer 的顺序是外到内，认证要在限流之前注册。" } },
  { key: "retro-task-hb19", kind: "retro", project: "harbor-api", task: "task-hb19", text: "健康检查与 readiness 探针。", fields: { "【做对】": "liveness 与 readiness 分开，滚动更新不再打到未就绪实例。", "【做错】": "一开始把数据库 ping 放进 liveness，数据库抖一下 pod 就被重启。" } },
  { key: "pit-usernotification-simulator", kind: "pit", project: "sprout", task: "task-sp44", text: "模拟器里通知权限永远是「已允许」，被拒的分支测不到。", fields: { "【解法】": "真机上设置里手动关一次通知，把引导页走一遍；用例里用协议注入权限状态。" } },
  { key: "win-offscreen-render", kind: "win", project: "sprout", task: "task-sp33", text: "掉帧先用 Instruments 看主线程，再决定改哪里，不猜。", fields: { "【为什么】": "猜是布局问题改了半天没用，Instruments 一看是饼图每帧重画。" } },
  { key: "pit-astro-image-remote", kind: "pit", project: "atlas-site", task: "task-at11", text: "Astro 的 <Image> 对远程图片不做优化，LCP 一直下不来。", fields: { "【解法】": "把首屏图放进仓库走本地优化，其余用 loading=lazy。" } },
  { key: "pit-pdf-table-spaces", kind: "pit", project: "quill-cli", task: "task-qc07", text: "按空格切表格列，遇到单元格里有空格的就错位。", fields: { "【解法】": "按字符 x 坐标聚类出列边界，再按边界切。" } },
];
const docs: Record<string, { id: string; title: string; kind: string; path: string; ext?: string; mtime?: number; size?: number }[]> = {
  "lumen-notes": [{ id: "d1", title: "反向链接面板设计", kind: "设计", path: "design/backlinks-pane.md", ext: "md", mtime: sec(150), size: 4200 }, { id: "d2", title: "v0.3 发布检查单", kind: "复审", path: "docs/release-checklist.md", ext: "md", mtime: sec(1500), size: 1800 }],
  "harbor-api": [{ id: "d3", title: "限流方案对比：固定窗口 / 滑动窗口 / token bucket", kind: "调研", path: "docs/rate-limit-options.md", ext: "md", mtime: sec(410), size: 6100 }],
  "sprout": [{ id: "d4", title: "预算提醒交互稿", kind: "设计", path: "design/budget-alerts.md", ext: "md", mtime: sec(640), size: 3300 }],
  "atlas-site": [{ id: "d5", title: "首页性能复审", kind: "复审", path: "docs/perf-review.md", ext: "md", mtime: sec(1600), size: 2700 }],
  "quill-cli": [],
};
const docText: Record<string, string> = {
  d1: "# 反向链接面板设计\n\n右侧栏面板，列出指向当前笔记的链接。\n\n- 按来源笔记分组，组内按段落顺序\n- 点击定位到原句并高亮 2 秒\n- 万篇笔记打开面板 < 200ms（索引按段落存）\n",
  d2: "# v0.3 发布检查单\n\n- [x] manifest 版本号与 package.json 一致\n- [x] CHANGELOG 生成\n- [x] 社区市场 PR\n",
  d3: "# 限流方案对比\n\n| 方案 | 突发 | 内存 | 实现 |\n|---|---|---|---|\n| 固定窗口 | 边界翻倍 | 小 | 简单 |\n| 滑动窗口 | 平滑 | 中 | 中 |\n| token bucket | 允许突发 | 小 | 中 |\n\n选 token bucket：允许短时突发，Retry-After 好算。\n",
  d4: "# 预算提醒交互\n\n90% 一档、100% 一档，同一档一天一次；通知被拒时进设置页引导。\n",
  d5: "# 首页性能复审\n\nLCP 3.1s → 1.4s，Lighthouse 71 → 96。主因是 8 MB 的 PNG 首屏图。\n",
};
const summaries: Record<string, string> = {
  "lumen-notes": "lumen-notes 是一个 Obsidian 插件，做双链的反向索引和搜索面板。v0.3.0 已上架社区市场；现在在做反向链接面板，分组列表已完成，正在做点击定位与高亮。接下来是 Canvas 节点同步。",
  "harbor-api": "harbor-api 是一个多租户的 Rust 后端服务。健康检查与 readiness 探针已上线；限流中间件已能按租户返回 429 + Retry-After，还差压测和 Prometheus 指标。Postgres 16 迁移在等运维的维护窗口。",
  "sprout": "sprout 是一个 iOS 记账 App。快捷指令记账和图表页性能问题已解决；分类预算的超支提醒做完了模拟器测试，等真机验证通知权限被拒的引导。iCloud 同步冲突还没开始。开发者账号 9 月 30 日到期。",
  "atlas-site": "atlas-site 是公司官网（Astro）。首页 LCP 从 3.1s 降到 1.4s；定价页三档对比表刚开始做。",
  "quill-cli": "quill-cli 是把 PDF 批量转成 Markdown 的命令行工具。表格列对齐已修好；断点续跑能用了，文档还差一段。",
};
const dayOf = (ts: number) => { const d = new Date(ts * 1000); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const commits: Record<string, [number, string, string][]> = {
  "lumen-notes": [[sec(118), "9c1f2a3", "feat: 链接索引按段落存，反向链接面板分组列表 (task-ln12)"], [sec(1500), "4e7b8d1", "chore: release v0.3.0"], [sec(3300), "b02c4f9", "chore: eslint + vitest，CI 跑测试 (task-ln05)"]],
  "harbor-api": [[sec(40), "7d3e9a0", "feat: 按租户的 token bucket 限流中间件 (task-hb31)"], [sec(2500), "a91c0b4", "feat: /healthz 与 /readyz 分开 (task-hb19)"]],
  "sprout": [[sec(60), "2f8e1c7", "feat: 分类预算与两档超支提醒 (task-sp44)"], [sec(1700), "c4d0a9e", "perf: 饼图离屏渲染 (task-sp33)"]],
  "atlas-site": [[sec(1600), "e5a7b21", "perf: 图片 WebP + 懒加载，LCP 1.4s (task-at11)"]],
  "quill-cli": [[sec(400), "6b9d3e8", "feat: 批量转换断点续跑 --resume (task-qc09)"], [sec(2600), "1a2c5f0", "fix: 表格按列边界聚类切分 (task-qc07)"]],
};
const iso = (s: string) => Date.parse(s) / 1000;
function reviewOf(name: string) {
  const items = issues.filter((i) => (i.labels ?? []).includes(`project:${name}`) && !(i.labels ?? []).includes("dispatch:outcome"));
  const refs = sessionRefs.filter((r) => r.project === name);
  const entries: { ts: number; kind: string; ref?: string; text: string; task?: string; task_title?: string; tasks?: { id: string; title: string }[]; host?: string }[] = [];
  for (const i of items) {
    for (const c of comments.filter((c) => c.issue_id === i.id && c.author !== "user")) entries.push({ ts: iso(c.created_at), kind: "task", ref: i.id, task: i.id, task_title: i.title, text: `${i.title}：${c.text}` });
    if (i.status === "closed" && i.closed_at) entries.push({ ts: iso(i.closed_at), kind: "done", ref: i.id, task: i.id, task_title: i.title, text: `完成「${i.title}」${i.close_reason ? `：${i.close_reason}` : ""}` });
  }
  for (const [ts, sha, subject] of commits[name] ?? []) { const m = /\(task-([a-z0-9]+)\)/.exec(subject); const t = m ? items.find((i) => i.id === `task-${m[1]}`) : undefined; entries.push({ ts, kind: "commit", ref: sha, task: t?.id, task_title: t?.title, text: subject }); }
  for (const r of refs) { const linked = items.filter((i) => (i.labels ?? []).some((l) => l === `session:${r.session_id}` || l === `session-origin:${r.session_id}`)); entries.push({ ts: r.last_at, kind: "session", ref: r.session_id, task: linked[0]?.id, task_title: linked[0]?.title, tasks: linked.map((i) => ({ id: i.id, title: i.title })), text: `会话「${r.title}」：${r.summary ?? ""}` }); }
  entries.sort((a, b) => b.ts - a.ts);
  const days = new Map<string, typeof entries>();
  for (const e of entries) { const d = dayOf(e.ts); if (!days.has(d)) days.set(d, []); days.get(d)!.push(e); }
  const weekday = (d: string) => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(d).getDay()];
  const open_tasks = items.filter((i) => i.status !== "closed").map((i) => { const ac = i.acceptance_criteria ?? ""; const done = (ac.match(/- \[x\]/gi) ?? []).length; const total = done + (ac.match(/- \[ \]/g) ?? []).length; const last = comments.filter((c) => c.issue_id === i.id).slice(-1)[0]; return { id: i.id, title: i.title, status: i.status, assignee: i.assignee ?? "", acceptance_done: done, acceptance_total: total, last_at: iso(i.updated_at), last_note: last?.text ?? "" }; });
  const live = activities().filter((a) => a.project === name && a.state === "working");
  const sessions = live.map((a) => { const r = refOf(a.session_id); const tasks = items.filter((i) => (i.labels ?? []).some((l) => l === `session:${r.session_id}`)).map((i) => ({ id: i.id, title: i.title, status: i.status })); return { agent: r.agent, session_id: r.session_id, title: r.title, cwd: r.cwd, source_app: "Herdr", summary: r.summary ?? "", state: a.state, last_at: a.last_at, tasks, tasks_all_done: tasks.every((t) => t.status === "closed"), files_count: 2, verdict: "别关", reason: "正在做 " + (tasks[0]?.title ?? "") }; });
  return { project: name, detected: true, cwd: P(name), timeline_days: 14, summary: { text: summaries[name] ?? "", at: sec(20), by: "zhipu:glm-5.3-flash", cached: true }, timeline: [...days.entries()].map(([day, es]) => ({ day, weekday: weekday(day), entries: es })), open_tasks, sessions, stale_hosts: [] };
}
function lineageOf(name: string) {
  const items = issues.filter((i) => (i.labels ?? []).includes(`project:${name}`) && !(i.labels ?? []).includes("dispatch:needs-you") && !(i.labels ?? []).includes("dispatch:outcome"));
  const acts = activities();
  const sessOf = (i: Issue) => sessionRefs.filter((r) => (i.labels ?? []).some((l) => l === `session:${r.session_id}` || l === `session-origin:${r.session_id}`)).map((r) => { const a = acts.find((x) => x.session_id === r.session_id); return { session_id: r.session_id, agent: r.agent, title: r.title, summary: r.summary, state: a?.state ?? "idle", live: a?.state === "working", relation: (i.labels ?? []).includes(`session-origin:${r.session_id}`) ? "origin" : "worked", verdict: i.status === "closed" ? "可关" : "别关", reason: i.status === "closed" ? "任务已完成" : `正在做 ${i.title}`, last_at: r.last_at }; });
  const tasks = items.map((i) => { const ac = i.acceptance_criteria ?? ""; const done = (ac.match(/- \[x\]/gi) ?? []).length; const total = done + (ac.match(/- \[ \]/g) ?? []).length; const events = [{ ts: iso(i.created_at), kind: "created", ref: i.id, text: "建任务", by: i.created_by }, ...comments.filter((c) => c.issue_id === i.id).map((c) => ({ ts: iso(c.created_at), kind: "comment", ref: c.id, text: c.text, by: c.author })), ...(i.closed_at ? [{ ts: iso(i.closed_at), kind: "done", ref: i.id, text: i.close_reason ?? "完成", by: i.assignee ?? "" }] : [])]; return { id: i.id, title: i.title, status: i.status, assignee: i.assignee ?? "", acceptance_done: done, acceptance_total: total, last_at: iso(i.updated_at), deps: i.id === "task-hb27" ? [{ type: "blocks", label: "运维确认周四晚维护窗口", id: "task-hb26" }] : [], mentions_count: comments.filter((c) => c.issue_id === i.id).length, sessions: sessOf(i), events }; });
  const linked = new Set(tasks.flatMap((t) => t.sessions.map((s) => s.session_id)));
  const unassigned = sessionRefs.filter((r) => r.project === name && !linked.has(r.session_id)).map((r) => ({ session_id: r.session_id, agent: r.agent, title: r.title, summary: r.summary, state: "idle", live: false, last_at: r.last_at }));
  return { project: name, days: 14, cwd: P(name), counts: { tasks: tasks.length, live_sessions: acts.filter((a) => a.project === name && a.state === "working").length, unassigned_sessions: unassigned.length }, tasks, unassigned_sessions: unassigned, unassigned_events: [] };
}
const folders = (path: string) => { const p = path || `${HOME}/Projects`; const children = p === `${HOME}/Projects` ? ["lumen-notes", "harbor-api", "sprout", "atlas-site", "quill-cli"].map((n) => ({ name: n, path: P(n) })) : [{ name: "src", path: `${p}/src` }, { name: "docs", path: `${p}/docs` }]; return { path: p, parent: p.split("/").slice(0, -1).join("/") || "/", children, recent: [P("lumen-notes"), P("sprout")], truncated: false }; };

export function fixtureApi(): Api {
  return {
    info: async () => ({ bd_bin: "示例数据", beads_dir: "~/tasks/.beads", actor: "user", version: "preview" }),
    list: async () => issues.map((i) => ({ ...i })),
    show: async (id) => {
      const i = find(id);
      const deps = id === "task-hb27" ? [{ ...find("task-hb26"), dependency_type: "blocks" }] : [];
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
      const i: Issue = { id: "task-" + Math.random().toString(36).slice(2, 5), title: input.title, description: input.description, status: "open", priority: input.priority ?? 2, issue_type: input.issue_type ?? "task", created_by: "user", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), labels: input.labels ?? [] };
      issues = [i, ...issues]; notify(); return i;
    },
    presence: async () => ({
      apps: [],
      sessions: sessionRefs.map((r, n) => ({ agent: r.agent, session_id: r.session_id, cwd: r.cwd, project: r.project, agent_pid: 1000 + n, source_kind: "terminal", source_app: "Herdr", entrypoint: r.entrypoint || "", started_at: iso(r.first_ts || ago(600)), last_at: r.last_at, state: r.session_id === S.lumen ? ("working" as const) : ("idle" as const), prompts: r.user_msgs, alive: true, registered: true, host: "local", host_name: HOST.name })),
    }),
    taskSessions: async (id) => sessionRefs.filter((r) => r.tasks[id]),
    sessionActivity: async () => ({ sessions: activities(), updated_at: Date.now() / 1000, unavailable_hosts: [] }),
    sessionSeen: async () => {},
    sessionList: async () => sessionRefs,
    sessionDetail: async (id) => detailFor(sessionRefs.find((r) => r.session_id.startsWith(id.split("@")[0])) ?? sessionRefs[0]),
    focusSession: async () => "浏览器预览里没有 Herdr",
    resumeCmd: async (agent, sid, cwd) => `cd '${cwd}' && ${agent === "codex" ? "codex resume" : agent === "pi" ? "pi --session" : "claude --resume"} ${sid}`,
    skills: async () => skills.map((s) => ({ ...s, agents: { ...s.agents } })),
    skillToggle: async (name, agent, on) => { const s = skills.find((x) => x.name === name)!; (agent === "all" ? ["claude", "codex"] : [agent]).forEach((a) => (s.agents[a] = on)); return on ? "已挂载" : "已卸载"; },
    skillRead: async (name) => `---\nname: ${name}\ndescription: ${skills.find((x) => x.name === name)?.description ?? ""}\n---\n\n# ${name}\n\n（示例内容）\n`,
    skillWrite: async (name) => `/pool/${name}/SKILL.md`,
    skillOpen: async () => {},
    skillImprove: async () => ({ prompt: "示例提示词", command: "claude \"…\"", top: [] }),
    envList: async () => [{ name: "ZHIPU_API_KEY", note: "智谱 GLM（会话总结）", masked: "b1e…9f2", length: 32 }, { name: "OPENAI_API_KEY", note: "知识库 embedding", masked: "sk-…7Qa", length: 51 }],
    insights: async () => ({ days: 14, total_sessions: 7, per_agent: { "claude-code": { sessions: 3, user_turns: 87, approve: 4, continue: 6, correction: 2, asktail: 9, ends_on_question: 2, long: 1, overflow: 0, tool_errors: 3, no_board: 0 }, codex: { sessions: 2, user_turns: 31, approve: 2, continue: 3, correction: 1, asktail: 4, ends_on_question: 1, long: 0, overflow: 0, tool_errors: 1, no_board: 0 }, pi: { sessions: 1, user_turns: 23, approve: 1, continue: 2, correction: 0, asktail: 3, ends_on_question: 1, long: 0, overflow: 0, tool_errors: 0, no_board: 0 } }, sessions: [], samples: { asktail: [], correction: [], overflow: [] }, findings: ["示例：Claude Code 的会话里有 2 次纠正，都和排序规则有关；可以把「组内按段落顺序」写进项目规则。"], rules: [{ key: "asktail", name: "问句/选项收尾", how: "回复末尾是问句或选项列表" }, { key: "correction", name: "被纠正", how: "用户下一句以「不是」「别」开头" }], alerts: [], prompt: "示例提示词", command: "claude \"示例\"" }),
    insightAlerts: async () => [],
    insightsAck: async () => {},
    insightReports: async () => ({ running: null, schedule: { every_days: 14 }, reports: [] }),
    insightReport: async () => null,
    insightGenerate: async () => {},
    insightSchedule: async () => {},
    insightDue: async () => {},
    profileDue: async () => {},
    rulesSyncDue: async () => {},
    envGet: async () => "b1e0f2a3c4d5e6f7a8b9c0d1e2f3a4b5",
    envSet: async () => {},
    envUnset: async () => {},
    openPath: async () => {},
    hosts: async () => [HOST],
    on: async (_h, args) => {
      const [cmd, sub] = args;
      const pOf = () => { const i = args.indexOf("-P"); return i >= 0 ? String(args[i + 1]) : ""; };
      if (cmd === "wiki" && sub === "list") { const p = pOf(); return JSON.stringify(wiki.filter((w) => !p || w.project === p)); }
      if (cmd === "wiki") return "[]";
      if (cmd === "here") return JSON.stringify(reviewOf(String(sub)));
      if (cmd === "project-summary") return JSON.stringify({ summary: summaries[String(sub)] ?? "", at: sec(20), by: "zhipu:glm-5.3-flash", cached: true });
      if (cmd === "project-moves") return "[]";
      if (cmd === "docs" && sub === "read") { const id = String(args[3]); return JSON.stringify({ text: docText[id] ?? "", dir: P(String(args[2])) }); }
      if (cmd === "docs") return JSON.stringify({ docs: (docs[String(sub)] ?? []).map((d) => ({ ...d, host: "local", host_name: HOST.name })) });
      if (cmd === "facts" && sub === "show") return JSON.stringify({ path: `${P(pOf())}/FACTS.md`, content: `## 通用\n- 部署：staging 在 fly.io，生产在 Hetzner\n\n## ${pOf()}\n- 本地开发端口 5173\n`, exists: true });
      if (cmd === "facts" && sub === "docs") return JSON.stringify([{ key: "通用", name: "通用（所有项目）", path: `${HOME}/.agents/rules/FACTS.md`, dir: "", exists: true, hint: "每个会话都注入（dispatch prime）" }, ...["lumen-notes", "harbor-api", "sprout", "atlas-site", "quill-cli"].map((n) => ({ key: n, name: n, path: `${P(n)}/FACTS.md`, dir: P(n), exists: n === "lumen-notes" || n === "harbor-api", hint: `只属于这个项目，按需读：dispatch facts show -P ${n}` }))]);
      if (cmd === "facts" && sub === "vaults") return "[]";
      if (cmd === "rules" && sub === "inspect") return JSON.stringify({ documents: [
        { path: `${HOME}/.agents/rules/GLOBAL.md`, real_path: `${HOME}/.agents/rules/GLOBAL.md`, name: "GLOBAL.md", agents: ["claude", "codex", "pi"], active: true, exists: true, content: rulesText, hash: "abc123", lines: rulesText.split("\n").length, bytes: rulesText.length, references: [], referenced_by: [`${HOME}/.claude/CLAUDE.md`, `${HOME}/.codex/AGENTS.md`], managed: true, writable: true },
        { path: `${HOME}/.claude/CLAUDE.md`, real_path: `${HOME}/.claude/CLAUDE.md`, name: "CLAUDE.md", agents: ["claude"], active: true, exists: true, content: "# Claude Code\n\n- 页面测试用隔离浏览器。\n\n@~/.agents/rules/GLOBAL.md\n", hash: "def456", lines: 5, bytes: 80, references: [`${HOME}/.agents/rules/GLOBAL.md`], referenced_by: [], managed: false, writable: true },
        { path: `${P("lumen-notes")}/CLAUDE.md`, real_path: `${P("lumen-notes")}/CLAUDE.md`, name: "CLAUDE.md", agents: ["claude"], active: true, exists: true, content: "# lumen-notes\n\n- 改完跑 npm test；发布用 npm run release。\n- 索引按段落存，别退回笔记级。\n", hash: "789abc", lines: 4, bytes: 90, references: [], referenced_by: [], managed: false, writable: true },
      ], models: [{ agent: "claude", model: "Opus 5", source: "settings" }, { agent: "codex", model: "gpt-5.3-codex", source: "config" }], sources: {}, findings: [{ kind: "duplicate", path: `${P("lumen-notes")}/CLAUDE.md`, line: 3, message: "「改完跑 npm test」在 GLOBAL.md 的验证段已有更通用的表述", suggestion: "项目指令只留项目特有的构建/测试命令" }], notes: [], model: "zhipu:glm-5.3-flash", profile: "balanced" });
      if (cmd === "rules" && sub === "status") return JSON.stringify({ hash: "abc123", source: `${HOME}/.agents/rules/GLOBAL.md`, targets: [{ agent: "claude", path: `${HOME}/.claude/CLAUDE.md`, state: "synced", mode: "import" }, { agent: "codex", path: `${HOME}/.codex/AGENTS.md`, state: "synced", mode: "inline" }, { agent: "pi", path: `${HOME}/.pi/AGENTS.md`, state: "stale", mode: "inline" }] });
      if (cmd === "rules") return JSON.stringify({ ok: true });
      if (cmd === "facts") return JSON.stringify({ ok: true });
      if (cmd === "env" && sub === "get") return "";
      if (cmd === "env") return "[]";
      if (cmd === "session" && args[2] === "--since") {
        // The live tail, scripted: the running test finishes, the agent thinks, then answers.
        const since = Number(args[3]); const t = (ts: number) => new Date(now + ts * 1000).toISOString();
        const steps: Record<number, unknown> = {
          1000: { partial: true, since: 1000, offset: 1001, messages: [], resolved: [{ id: "t4", status: "done", result: "Test Files  4 passed (4)\n     Tests  23 passed (23)", result_ts: t(1) }], files: [], tool_counts: {} },
          1001: { partial: true, since: 1001, offset: 1002, messages: [{ ts: t(2), role: "assistant", mid: "m5", text: "", tools: [], blocks: [{ type: "thinking", text: "全过了；定位用的段落 id 已进索引，跟用户说一声。" }] }], resolved: [], files: [], tool_counts: {} },
          1002: { partial: true, since: 1002, offset: 1003, messages: [{ ts: t(3), role: "assistant", mid: "m5", text: "点击定位做好了，测试 23 个全过。剩下高亮原句和万篇笔记的性能验证。", tools: [], blocks: [{ type: "text", text: "点击定位做好了，测试 23 个全过。剩下高亮原句和万篇笔记的性能验证。" }] }], resolved: [], files: [], tool_counts: {} },
        };
        return JSON.stringify(steps[since] ?? { partial: true, since, offset: since, messages: [], resolved: [], files: [], tool_counts: {} });
      }
      if (cmd === "session") return JSON.stringify(detailFor(sessionRefs.find((r) => String(sub).includes(r.session_id)) ?? sessionRefs[0]));
      if (cmd === "reply") {
        const sid = String(args[2] ?? "");
        const working = sid.includes(S.lumen);
        if (sub === "status") return JSON.stringify({ available: true, label: working ? "Agent 正在执行：可以排队（本轮结束就看到）或打断" : "回复到电脑上的原会话", working, receipts: [], model: "Opus 5", mode: "acceptEdits" });
        if (sub === "send") return JSON.stringify({ id: args[args.indexOf("--request") + 1] ?? "r", text: "", state: "accepted", note: working ? "已排队，本轮结束后 Agent 就会看到" : "已送达原终端会话", created: Date.now() / 1000 });
        if (sub === "commands") return JSON.stringify([{ name: "compact", description: "压缩对话上下文", kind: "builtin" }, { name: "review", description: "审查当前改动", kind: "builtin" }]);
        return JSON.stringify({ state: "accepted", note: "已切换" });
      }
      if (cmd === "session-control") {
        const input = (() => { try { return JSON.parse(String(args[2] ?? "{}")); } catch { return {}; } })();
        if (sub === "browse") return JSON.stringify(folders(String(input.path ?? "")));
        if (sub === "start") return JSON.stringify({ request_id: input.request_id ?? "r", state: "ready", session_id: S.lumen, agent: input.agent ?? "claude-code", cwd: input.cwd ?? "", message: "会话已创建（示例）" });
        return JSON.stringify({ request_id: input.request_id ?? "r", state: "ready", message: "已就绪（示例）" });
      }
      if (cmd === "save-image" || cmd === "save-file") return JSON.stringify({ path: `${HOME}/tasks/.dispatch/images/demo.png`, size: 1 });
      if (cmd === "task") { const i = find(String(args[2])); const labels = i.labels ?? [];
        if (sub === "trash" && !labels.includes("dispatch:trashed")) { i.labels = [...labels, "dispatch:trashed", `dispatch:previous:${i.status}`]; i.status = "deferred"; }
        else if (sub === "restore") { i.status = (labels.find((l) => l.startsWith("dispatch:previous:"))?.split(":")[2] || "open") as Status; i.labels = labels.filter((l) => !l.startsWith("dispatch:")); }
        touch(i); notify(); return JSON.stringify(i);
      }
      if (cmd === "session-summary") return JSON.stringify({ summary: sessionRefs.find((r) => String(sub).includes(r.session_id))?.summary ?? "", cached: true, unread_summary: "两档提醒过了测试，等你真机验证通知被拒的引导。" });
      if (cmd === "update") return JSON.stringify({ current: "preview", latest: "preview", newer: false, url: "https://github.com/SchaeferAnjon/dispatch/releases" });
      if (cmd === "serve") return sub === "url" ? "http://100.64.0.2:7799/?token=demo" : JSON.stringify({});
      if (cmd === "settings") return JSON.stringify({ session_archive_days: 30, task_archive_days: 0, home_expanded: 2, summary_auto: 1, summary_model: "zhipu:glm-5.3-flash", workspace_roots: ["~/Projects"] });
      if (cmd === "profile") { const content = "# 关于我\n\n## 我是谁\n- 独立开发者，主要写 TypeScript 和 Swift；白天 lumen-notes，晚上 sprout。\n\n## 设备与账号\n- MacBook Pro（主力）· Mac mini（家里常开）\n- Claude Max、Codex Plus，pi 走 API Key\n\n## 将来\n- 2026-09-30 · Apple 开发者账号到期，续费\n- 2026-10 · lumen-notes v0.4：Canvas 同步\n\n## 已发生\n- 2026-09-10 · sprout 1.2 上架 TestFlight\n"; return sub === "show" ? JSON.stringify({ path: `${HOME}/.agents/rules/PROFILE.md`, exists: true, content, sections: [], inventory_at: ago(60) }) : JSON.stringify({ ok: true }); }
      if (cmd === "skills" && sub === "list") return JSON.stringify(skills);
      if (cmd === "skills" && sub === "show") return args.includes("--json") ? JSON.stringify({ files: ["SKILL.md", "README.md"] }) : `---\nname: ${args[2]}\ndescription: ${skills.find((x) => x.name === args[2])?.description ?? ""}\n---\n\n# ${args[2]}\n\n（示例内容）\n`;
      if (cmd === "skills") return JSON.stringify({ ok: true });
      if (cmd === "memories" && sub === "list") return JSON.stringify([
        { id: "m1", agent: "claude-code", project: "lumen-notes", project_dir: P("lumen-notes"), expired: false, path: "~/.claude/projects/-Users-mia-Projects-lumen-notes/memory/obsidian-cache-ready.md", name: "obsidian-cache-ready", description: "metadataCache 要等 resolved 事件后再读", type: "project", index: true, size: 420, mtime: sec(150), body: "Obsidian 启动后 metadataCache 几秒才填满，插件 onload 里先等 resolved。" },
        { id: "m2", agent: "codex", project: "atlas-site", project_dir: P("atlas-site"), expired: false, path: "~/.codex/memories/atlas-site.md", name: "atlas-site", description: "首屏图走本地优化，其余 lazy", type: "project", index: true, size: 210, mtime: sec(1600), body: "Astro 的 <Image> 不优化远程图片。" },
        { id: "m3", agent: "claude-code", project: "通用", project_dir: "", expired: false, path: "~/.claude/CLAUDE.md", name: "user-prefs", description: "简体中文、一个任务一个 commit", type: "user", index: true, size: 180, mtime: sec(9000), body: "日常沟通用简体中文；提交信息 <type>: <desc>。" },
      ]);
      if (cmd === "summarize" && sub === "providers") return JSON.stringify({ providers: [{ id: "zhipu:glm-5.3-flash", provider: "zhipu", label: "智谱 GLM 5.3 flash", env: "ZHIPU_API_KEY", configured: true, model: "glm-5.3-flash", subscription: true }, { id: "openai:gpt-5-mini", provider: "openai", label: "OpenAI GPT-5 mini", env: "OPENAI_API_KEY", configured: true, model: "gpt-5-mini", subscription: false }] });
      if (cmd === "summarize") return JSON.stringify({});
      if (cmd === "init" && sub === "status") return JSON.stringify({ done: true, steps: [] });
      if (cmd === "init") return JSON.stringify(sub === "peers" ? [] : { ok: true });
      if (cmd === "profile" && sub === "inventory") return JSON.stringify({ targets: [] });
      if (cmd === "session-summary") return JSON.stringify({ summary: "", cached: true });
      if (cmd === "task-archive") return JSON.stringify({ archived: [] });
      if (cmd === "lineage") return JSON.stringify(lineageOf(String(sub)));
      if (cmd === "commits") { const id = String(sub); const proj = issues.find((i) => i.id === id)?.labels?.find((l) => l.startsWith("project:"))?.slice(8) ?? ""; const rows = (commits[proj] ?? []).filter(([, , subject]) => subject.includes(`(${id})`)); return JSON.stringify({ root: P(proj), remote: `https://github.com/mia/${proj}`, commits: rows.map(([ts, sha, subject]) => ({ hash: sha + "0".repeat(33), short: sha, date: new Date(ts * 1000).toISOString(), author: "mia", subject, files: ["src/index.ts"], file_count: 1, add: 12, del: 3 })) }); }
      if (cmd === "attachment" || cmd === "memories" || cmd === "docs-list") return "[]";
      if (cmd === "stats") return JSON.stringify({ days: 14, sessions: 7, tokens: 1_240_000 });
      if (cmd === "notify") return JSON.stringify({ ok: true, via: "system" });
      if (cmd === "screen" || cmd === "hosts" || cmd === "agent" || cmd === "discuss" || cmd === "discuss-live" || cmd === "discuss-doc" || cmd === "split" || cmd === "log" || cmd === "image") return JSON.stringify({ ok: true });
      return "{}";
    },
    copy: async (text) => { await navigator.clipboard.writeText(text); },
    notify: async (title, body) => { console.log("[notify]", title, body); },
    openWindow: async (hash) => { window.open(location.pathname + hash, "_blank"); },
    tray: async () => {},
    onChange: async (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    rulesRead: async () => rulesText,
    rulesWrite: async (c) => { rulesText = c; },
    rulesStatus: async () => ({ hash: "abc123", source: "~/.agents/rules/GLOBAL.md", targets: [
      { agent: "claude", path: `${HOME}/.claude/CLAUDE.md`, state: "synced", mode: "import" },
      { agent: "codex", path: `${HOME}/.codex/AGENTS.md`, state: "synced", mode: "inline" },
      { agent: "pi", path: `${HOME}/.pi/AGENTS.md`, state: "stale", mode: "inline" },
    ] }),
    rulesSync: async () => {},
    memories: async () => memories.map((m) => ({ ...m })),
    remember: async (key, value) => { const i = memories.findIndex((m) => m.key === key); if (i >= 0) memories[i] = { key, value }; else memories.push({ key, value }); notify(); },
    forget: async (key) => { memories = memories.filter((m) => m.key !== key); notify(); },
    agentStart: async () => null,
    graph: async () => ({ nodes: issues.map((i) => ({ ...i })), edges: [
      { from: "task-hb26", to: "task-hb27", type: "blocks" }, { from: "task-ln08", to: "task-ln12", type: "discovered-from" },
      { from: "task-ln12", to: "task-ln20", type: "discovered-from" }, { from: "task-sp21", to: "task-sp44", type: "discovered-from" },
      { from: "task-sp44", to: "task-sp39", type: "discovered-from" }, { from: "task-at11", to: "task-at15", type: "discovered-from" },
    ] }),
    stats: async () => null,
    quota: async () => [
      { agent: "claude-code", plan: "Max", host: "local", host_name: HOST.name, windows: [{ label: "5 小时", used_percent: 23, resets_at: now / 1000 + 9900 }, { label: "每周", used_percent: 41, resets_at: now / 1000 + 4 * 86400 }, { label: "每周 · Opus", used_percent: 12, resets_at: now / 1000 + 4 * 86400 }], updated_at: now / 1000 - 120, source: "oauth", note: "" },
      { agent: "codex", plan: "Plus", host: "local", host_name: HOST.name, windows: [{ label: "5 小时", used_percent: 8, resets_at: now / 1000 + 4000 }, { label: "每周", used_percent: 37, resets_at: now / 1000 + 3 * 86400 }], updated_at: now / 1000 - 300, source: "rollout", note: "" },
      { agent: "pi", plan: "", host: "local", host_name: HOST.name, windows: [], updated_at: null, source: "", note: "pi 走 API Key，按用量计费，没有额度窗口" },
    ],
  };
}

const skills: import("./types").Skill[] = [
  { name: "task-board", path: "/pool/task-board", in_pool: true, description: "全局任务板（Beads / bd CLI）。所有 Agent 共用同一块板。", agents: { claude: true, codex: true } },
  { name: "herdr", path: "/pool/herdr", in_pool: true, description: "Control Herdr, a terminal multiplexer for coding agents.", agents: { claude: true, codex: true } },
  { name: "frontend-design", path: "/pool/frontend-design", in_pool: true, description: "Guidance for distinctive, intentional visual design.", agents: { claude: true, codex: false } },
  { name: "swift-testing", path: "/pool/swift-testing", in_pool: true, description: "Write and run Swift Testing suites for iOS targets.", agents: { claude: true, codex: false } },
  { name: "release-notes", path: "/pool/release-notes", in_pool: true, description: "Turn a range of commits into a CHANGELOG entry.", agents: { claude: false, codex: true } },
];

let rulesText = "# 这台电脑上所有 Agent 的共同规则\n\n## 授权与交付\n\n- 目标明确就推进到完成；不可逆操作和对外发送先停下来问。\n- 一个任务一个 commit；提交信息 `<type>: <desc>`。\n\n## 记录\n\n- 开工 `dispatch begin`，进展 `dispatch log`，完成 `dispatch done`。\n- 踩坑 `dispatch wiki add --kind pit`，做对 `--kind win`。\n";

let memories: { key: string; value: string }[] = [
  { key: "dispatch-projects", value: JSON.stringify({ "lumen-notes": { starred: true }, "sprout": { starred: true } }) },
  ...wiki.map((w) => ({ key: w.key, value: `【${w.kind === "pit" ? "坑" : w.kind === "win" ? "做对" : w.kind === "retro" ? "复盘" : "做法"}】${w.text}${Object.entries(w.fields).map(([k, v]) => `${k}${v}`).join("")} #project:${w.project}${w.task ? ` #task:${w.task}` : ""}` })),
];
