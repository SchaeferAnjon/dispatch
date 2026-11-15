// Browser-preview data for 脉络 (`dispatch thread`), in the shape cli/thread.py prints. Same invented
// projects and task ids as fixtures.ts; two lines are written out in full, the rest are short.
import type { OpenTask, ProjectTimelineData, ThreadBeat, ThreadChapter, ThreadData, ThreadList, ThreadProject, ThreadProjectRow, ThreadProjects, ThreadRow, TimelineDay, TimelineEvent } from "./api";
import { getLocale } from "./i18n";

const L = (zh: string, en: string, de: string): string => ({ zh, en, de })[getLocale()];
const now = Date.now() / 1000;
const sec = (min: number) => Math.round(now - min * 60);

const S_SPROUT = "d9e1f2a3-b4c5-4d6e-8f70-1a2b3c4d5e6f";

const ROWS: ThreadRow[] = [
  { root: "task-ds01", title: L("sprout 要不要做「共享账本」：两个人一起记账", "Should sprout get a shared ledger: two people keeping one book", "Soll sprout ein gemeinsames Kassenbuch bekommen: zwei Personen, ein Buch"), short: L("共享账本：两个人一起记账", "Shared ledger for two", "Gemeinsames Kassenbuch für zwei"), project: "sprout", state: "run", open_count: 2, task_count: 4, closed_count: 2, last_at: sec(1), single: false },
  { root: "task-sp21", title: L("记账快捷指令：Siri 一句话记一笔", "Shortcut for logging: one sentence to Siri adds an entry", "Kurzbefehl zum Erfassen: ein Satz an Siri legt einen Eintrag an"), short: L("记账快捷指令", "Siri logging shortcut", "Siri-Kurzbefehl"), project: "sprout", state: "wait", open_count: 2, task_count: 3, closed_count: 1, last_at: sec(38), single: false },
  { root: "task-ln08", title: L("首版打包并提交社区插件市场", "Package the first release and submit to the community plugin store", "Erste Version paketieren und im Community-Plugin-Store einreichen"), short: L("首版上架插件市场", "First release in the plugin store", "Erste Version im Plugin-Store"), project: "lumen-notes", state: "open", open_count: 2, task_count: 3, closed_count: 1, last_at: sec(3), single: false },
  { root: "task-at11", title: L("图片改 WebP、懒加载：LCP 从 3.1s 降到 1.4s", "WebP images + lazy loading: LCP down from 3.1s to 1.4s", "Bilder als WebP + Lazy Loading: LCP von 3,1 s auf 1,4 s"), short: L("图片改 WebP、懒加载", "WebP images + lazy loading", "Bilder als WebP + Lazy Loading"), project: "atlas-site", state: "open", open_count: 1, task_count: 2, closed_count: 1, last_at: sec(240), single: false },
  { root: "task-qc09", title: L("批量转换支持断点续跑", "Batch conversion can resume", "Batch-Konvertierung fortsetzbar"), short: L("批量转换支持断点续跑", "Batch conversion can resume", "Batch-Konvertierung fortsetzbar"), project: "quill-cli", state: "run", open_count: 1, task_count: 1, closed_count: 0, last_at: sec(400), single: true },
  { root: "task-hb19", title: L("健康检查与 readiness 探针", "Health check and readiness probe", "Health-Check und Readiness-Probe"), short: L("健康检查与 readiness 探针", "Health check and readiness probe", "Health-Check und Readiness-Probe"), project: "harbor-api", state: "done", open_count: 0, task_count: 2, closed_count: 2, last_at: sec(2500), single: false },
];
const SINGLES: ThreadRow[] = [
  { root: "task-sp40", title: L("iCloud 同步冲突：同一条记录两端都改过", "iCloud sync conflict: same record edited on both devices", "iCloud-Sync-Konflikt: derselbe Eintrag auf beiden Geräten geändert"), short: L("iCloud 同步冲突", "iCloud sync conflict", "iCloud-Sync-Konflikt"), project: "sprout", state: "open", open_count: 1, task_count: 1, closed_count: 0, last_at: sec(1100), single: true },
  { root: "task-sp33", title: L("图表页滚动掉帧：饼图改成离屏渲染", "Charts screen drops frames while scrolling", "Diagrammseite ruckelt beim Scrollen"), short: L("图表页滚动掉帧", "Charts screen drops frames", "Diagrammseite ruckelt"), project: "sprout", state: "done", open_count: 0, task_count: 1, closed_count: 1, last_at: sec(1700), single: true },
  { root: "task-qc07", title: L("表格识别时保留列对齐", "Keep column alignment when detecting tables", "Spaltenausrichtung bei der Tabellenerkennung beibehalten"), short: L("表格识别时保留列对齐", "Keep column alignment in tables", "Spaltenausrichtung in Tabellen"), project: "quill-cli", state: "done", open_count: 0, task_count: 1, closed_count: 1, last_at: sec(2600), single: true },
];
// Which line each task is on.
const ROOT: Record<string, string> = { "task-sp50": "task-ds01", "task-sp51": "task-ds01", "task-sp52": "task-ds01", "task-sp44": "task-sp21", "task-sp39": "task-sp21", "task-ln12": "task-ln08", "task-ln20": "task-ln08", "task-at15": "task-at11", "task-hb20": "task-hb19" };

const dayOf = (ts: number) => { const d = new Date(ts * 1000); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const weekday = (ts: number) => (new Date(ts * 1000).getDay() + 6) % 7;
function days(beats: ThreadBeat[]) {
  const out: ThreadData["days"] = [];
  const today = dayOf(now);
  for (const b of beats) {
    const d = dayOf(b.ts);
    if (b.kind === "gap" && out.length) { out[out.length - 1].beats.push(b); continue; }
    if (!out.length || out[out.length - 1].date !== d) out.push({ date: d, weekday: weekday(b.ts), today: d === today, beats: [] });
    out[out.length - 1].beats.push(b);
  }
  return out;
}

function ds01(): ThreadData {
  const ask = L("室友或伴侣想一起记账。要不要做、先做到什么程度？", "Flatmates or partners want to keep one book. Should we build it, and how far in the first version?", "Mitbewohner oder Paare wollen gemeinsam Buch führen. Sollen wir das bauen, und wie weit in der ersten Version?");
  const beats: ThreadBeat[] = [
    { kind: "ask", ts: sec(30), task: "task-ds01", text: ask, full: ask, opening: true, discussion: true, host: "user" },
    { kind: "discuss", ts: sec(27), task: "task-ds01", members: [
      { ts: sec(27), who: "codex", model: "GPT-6", text: L("先别碰实时同步，用 iCloud 共享数据库（CKShare）。", "Leave real-time sync alone and use an iCloud shared database (CKShare).", "Echtzeit-Sync lassen und eine geteilte iCloud-Datenbank (CKShare) nehmen."), full: L("先别碰实时同步。iCloud 共享数据库（CKShare）能把一个账本分享给另一个 Apple ID，冲突按记录合并。", "Leave real-time sync alone. An iCloud shared database (CKShare) can share one ledger with another Apple ID and merges conflicts per record.", "Echtzeit-Sync erst einmal nicht anfassen. Eine geteilte iCloud-Datenbank (CKShare) teilt ein Kassenbuch mit einer zweiten Apple-ID und führt Konflikte pro Datensatz zusammen.") },
      { ts: sec(25), who: "pi", model: "glm-5.3-flash", text: L("最小版本：只限两个人，不做分摊。", "Smallest version: two people only, no bill splitting.", "Kleinste Version: nur zwei Personen, keine Kostenaufteilung."), full: L("最小版本：一个账本只能两个人，谁记的显示头像，不做分摊计算。", "Smallest version: a ledger has exactly two people, each entry shows who made it, no bill splitting.", "Kleinste Version: Ein Kassenbuch hat genau zwei Personen, jeder Eintrag zeigt, wer ihn gemacht hat, keine Kostenaufteilung.") },
      { ts: sec(22), who: "claude", model: "Fable 5.1", text: L("两位的方案能合起来：CKShare + 只限两人。", "The two proposals fit together: CKShare, limited to two people.", "Beide Vorschläge passen zusammen: CKShare, begrenzt auf zwei Personen."), full: L("两位的方案能合起来：CKShare + 只限两人。验收先定三条。", "The two proposals fit together: CKShare, limited to two people. Three acceptance checks first.", "Beide Vorschläge passen zusammen: CKShare, begrenzt auf zwei Personen. Zuerst drei Abnahmekriterien.") },
    ] },
    { kind: "decide", ts: sec(20), task: "task-ds01", who: "dispatch", tag: "结论", text: L("做 CKShare 共享，只限两人；先验证邀请、同时改、退出三件事。", "Build CKShare sharing for two people; first prove invite, concurrent edits and leaving.", "CKShare-Teilen für zwei bauen; zuerst Einladung, gleichzeitiges Bearbeiten und Verlassen nachweisen.") },
    { kind: "claim", ts: sec(18), task: "task-ds01", who: "claude-code", routed: true, routed_by: "claude-code", text: L("计划：先搭 CKShare 邀请，再测两端同时改，最后做退出。", "Plan: CKShare invite first, then edits on both sides, then leaving.", "Plan: zuerst CKShare-Einladung, dann Bearbeiten auf beiden Seiten, dann Verlassen.") },
    { kind: "did", ts: sec(15), task: "task-ds01", who: "claude-code", fold: true, count: 3, from_ts: sec(15), to_ts: sec(8), summary: [L("邀请链接 2 台真机通过", "invite link works on 2 devices", "Einladungslink auf 2 Geräten ok"), "412 → 0 " + L("条丢失", "lost", "verloren"), L("退出后各留一份", "each keeps a copy", "jeder behält eine Kopie")], beats: [
      { kind: "did", ts: sec(15), task: "task-ds01", text: L("① 邀请链接在两台真机上都能加入。", "① The invite link joins on two real devices.", "① Der Einladungslink funktioniert auf zwei echten Geräten.") },
      { kind: "did", ts: sec(12), task: "task-ds01", text: L("② 两端同时改同一条：412 条里丢 0 条。", "② Editing the same entry on both sides: 0 of 412 lost.", "② Gleichzeitiges Bearbeiten: 0 von 412 verloren.") },
      { kind: "did", ts: sec(8), task: "task-ds01", text: L("③ 退出共享后两边各保留一份。", "③ After leaving the share both sides keep a copy.", "③ Nach dem Verlassen behalten beide eine Kopie.") },
    ] },
    { kind: "fork", ts: sec(7), task: "task-sp50", title: L("CKShare 邀请与接受流程", "CKShare invite and accept flow", "CKShare-Einladung und Annahme"), status: "closed", state: "done", closed_at: sec(4), commits: ["a41c9e2"], open_after: 0, tasks: 1, beats: [
      { kind: "done", ts: sec(4), task: "task-sp50", who: "claude-code", text: L("系统分享面板发邀请，userDidAcceptCloudKitShare 接住。", "Invites go through the system share sheet; userDidAcceptCloudKitShare picks them up.", "Einladungen über das Teilen-Menü; userDidAcceptCloudKitShare nimmt sie an."), commits: ["a41c9e2"], verified: true },
    ] },
    { kind: "fork", ts: sec(6), task: "task-sp51", title: L("记录上显示是谁记的", "Show who logged each entry", "Anzeigen, wer einen Eintrag erfasst hat"), status: "in_progress", state: "run", closed_at: 0, commits: [], open_after: 1, tasks: 2, beats: [
      { kind: "claim", ts: sec(5), task: "task-sp51", who: "codex", text: L("头像放在金额左边，先做列表页。", "Avatar left of the amount, list screen first.", "Avatar links vom Betrag, zuerst die Liste.") },
      { kind: "open", ts: sec(3), task: "task-sp52", title: L("分摊计算（有人要再做）", "Bill splitting (only when someone asks)", "Kostenaufteilung (erst auf Nachfrage)"), state: "open", status: "open", assignee: "", from: "task-sp51", from_title: L("记录上显示是谁记的", "Show who logged each entry", "Anzeigen, wer einen Eintrag erfasst hat") },
      { kind: "open", ts: sec(1), task: "task-sp51", title: L("记录上显示是谁记的", "Show who logged each entry", "Anzeigen, wer einen Eintrag erfasst hat"), state: "run", status: "in_progress", assignee: "codex", from: "task-ds01", from_title: L("共享账本", "Shared ledger", "Gemeinsames Kassenbuch") },
    ] },
  ];
  const tail: ThreadBeat[] = [
    { kind: "open", ts: sec(1), task: "task-sp51", title: L("记录上显示是谁记的", "Show who logged each entry", "Anzeigen, wer einen Eintrag erfasst hat"), state: "run", status: "in_progress", assignee: "codex", from: "task-ds01", from_title: L("共享账本", "Shared ledger", "Gemeinsames Kassenbuch") },
    { kind: "open", ts: sec(3), task: "task-sp52", title: L("分摊计算（有人要再做）", "Bill splitting (only when someone asks)", "Kostenaufteilung (erst auf Nachfrage)"), state: "open", status: "open", assignee: "", from: "task-sp51", from_title: L("记录上显示是谁记的", "Show who logged each entry", "Anzeigen, wer einen Eintrag erfasst hat") },
  ];
  return {
    root: "task-ds01", selected: "task-ds01", project: "sprout", title: ROWS[0].title, short: ROWS[0].short, state: "run", task_count: 4, closed_count: 2, open_count: 2, session_count: 2, last_at: sec(1),
    ask: { text: ask, at: sec(30), source: "description", session_id: "" },
    now: { main: null, latest: { at: sec(4), text: L("系统分享面板发邀请，userDidAcceptCloudKitShare 接住。", "Invites go through the system share sheet; userDidAcceptCloudKitShare picks them up.", "Einladungen über das Teilen-Menü; userDidAcceptCloudKitShare nimmt sie an."), kind: "done", task: "task-sp50" }, branches: { total: 3, closed: 1 }, last_at: sec(1) },
    left: tail.map((b) => ({ id: b.task!, title: b.title!, state: b.state!, status: b.status!, assignee: b.assignee!, from: b.from!, from_title: b.from_title! })),
    line: { tasks: 4, closed: 2, decisions: 1, commits: 3, agents: ["claude-code", "codex", "pi"] },
    days: days(beats), tail,
  };
}

function sp21(): ThreadData {
  const ask = L("想对 Siri 说一句「午饭 32 块」就记一笔，不用打开 App。", "I want to tell Siri “lunch 32” and have it logged without opening the app.", "Ich möchte Siri „Mittagessen 32“ sagen und es wird erfasst, ohne die App zu öffnen.");
  const beats: ThreadBeat[] = [
    { kind: "ask", ts: sec(5200), task: "task-sp21", text: ask, full: ask, opening: true },
    { kind: "done", ts: sec(4600), task: "task-sp21", who: "claude-code", text: L("App Intents 接上，一句话记账 1.2 秒。", "App Intents wired up, one sentence logs in 1.2 s.", "App Intents angebunden, ein Satz erfasst in 1,2 s."), commits: ["5be07d1", "c2f18a0"], verified: true },
    { kind: "gap", ts: sec(4600), days: 2 },
    { kind: "fork", ts: sec(700), task: "task-sp44", title: L("本月预算超支时推送提醒（按分类）", "Push a notification when this month's budget is exceeded (per category)", "Push-Benachrichtigung bei Überschreitung des Monatsbudgets (pro Kategorie)"), status: "in_progress", state: "run", closed_at: 0, commits: [], open_after: 1, tasks: 2, beats: [
      { kind: "ask", ts: sec(690), task: "task-sp44", who: "user", text: L("餐饮、交通等分类各自设预算。", "Each category gets its own budget.", "Jede Kategorie bekommt ein eigenes Budget.") },
      { kind: "decide", ts: sec(600), task: "task-sp44", who: "claude-code", tag: "决定", text: L("90% 提醒一次、100% 再提醒一次，同一档一天只提醒一次。", "Notify at 90% and again at 100%, each threshold at most once a day.", "Bei 90 % und erneut bei 100 % benachrichtigen, jede Stufe höchstens einmal täglich.") },
      { kind: "did", ts: sec(38), task: "task-sp44", who: "claude-code", text: L("两档提醒都过了模拟器测试；真机等你把通知权限拒一次再验。", "Both thresholds pass in the simulator; the real device needs you to deny notifications once.", "Beide Stufen bestehen im Simulator; das echte Gerät braucht einmal eine verweigerte Berechtigung.") },
      { kind: "open", ts: sec(300), task: "task-sp39", title: L("给 Apple 开发者账号续费", "Renew the Apple Developer membership", "Apple-Developer-Mitgliedschaft verlängern"), state: "wait", status: "open", assignee: "", from: "task-sp44", from_title: L("预算超支提醒", "Budget alerts", "Budget-Hinweise") },
    ] },
  ];
  const tail: ThreadBeat[] = [
    { kind: "open", ts: sec(38), task: "task-sp44", title: L("本月预算超支时推送提醒（按分类）", "Push a notification when this month's budget is exceeded (per category)", "Push-Benachrichtigung bei Überschreitung des Monatsbudgets (pro Kategorie)"), state: "open", status: "in_progress", assignee: "claude-code", from: "task-sp21", from_title: L("记账快捷指令", "Siri logging shortcut", "Siri-Kurzbefehl") },
    { kind: "open", ts: sec(300), task: "task-sp39", title: L("给 Apple 开发者账号续费", "Renew the Apple Developer membership", "Apple-Developer-Mitgliedschaft verlängern"), state: "wait", status: "open", assignee: "", from: "task-sp44", from_title: L("预算超支提醒", "Budget alerts", "Budget-Hinweise") },
  ];
  return {
    root: "task-sp21", selected: "task-sp21", project: "sprout", title: ROWS[1].title, short: ROWS[1].short, state: "wait", task_count: 3, closed_count: 1, open_count: 2, session_count: 1, last_at: sec(38),
    ask: { text: ask, at: sec(5200), source: "session", session_id: S_SPROUT },
    now: { main: { closed_at: sec(4600), text: L("App Intents 接上，一句话记账 1.2 秒。", "App Intents wired up, one sentence logs in 1.2 s.", "App Intents angebunden, ein Satz erfasst in 1,2 s.") }, latest: null, branches: { total: 2, closed: 0 }, last_at: sec(38) },
    left: tail.map((b) => ({ id: b.task!, title: b.title!, state: b.state!, status: b.status!, assignee: b.assignee!, from: b.from!, from_title: b.from_title! })),
    line: { tasks: 3, closed: 1, decisions: 1, commits: 2, agents: ["claude-code"] },
    days: days(beats), tail,
  };
}

/** A short line for the rows that are not written out: its opening, then where it stands. */
function brief(r: ThreadRow): ThreadData {
  const beats: ThreadBeat[] = [{ kind: "created", ts: r.last_at - 3600, task: r.root, who: "user", text: r.title, opening: true }];
  if (r.state === "done") beats.push({ kind: "done", ts: r.last_at, task: r.root, who: "pi", text: L("已上线。", "Shipped.", "Ausgeliefert."), commits: ["9d3e0b7"], verified: true });
  const tail: ThreadBeat[] = r.state === "done" ? [] : [{ kind: "open", ts: r.last_at, task: r.root, title: r.title, state: r.state, status: r.state === "run" ? "in_progress" : "open", assignee: r.state === "run" ? "claude-code" : "", from: "", from_title: "" }];
  return {
    root: r.root, selected: r.root, project: r.project, title: r.title, short: r.short, state: r.state, task_count: r.task_count, closed_count: r.closed_count, open_count: r.open_count, session_count: 1, last_at: r.last_at,
    ask: null, now: { main: r.state === "done" ? { closed_at: r.last_at, text: L("已上线。", "Shipped.", "Ausgeliefert.") } : null, latest: null, branches: { total: r.task_count - 1, closed: Math.max(0, r.closed_count - 1) }, last_at: r.last_at },
    left: tail.map((b) => ({ id: b.task!, title: b.title!, state: b.state!, status: b.status!, assignee: b.assignee!, from: "", from_title: "" })),
    line: { tasks: r.task_count, closed: r.closed_count, decisions: 0, commits: r.state === "done" ? 1 : 0, agents: ["claude-code"] },
    days: days(beats), tail,
  };
}

const lineOf = (root: string): ThreadData => root === "task-ds01" ? ds01() : root === "task-sp21" ? sp21() : brief([...ROWS, ...SINGLES].find((r) => r.root === root) ?? { ...ROWS[3], root });

/** A project's 脉络 in the shape of `dispatch thread <project> --json`: every line a chapter, the
 *  moving lines with more than one task opened. */
function projectThread(name: string, focus: string): ThreadProject {
  const rows = [...ROWS, ...SINGLES].filter((r) => r.project === name).sort((a, b) => a.last_at - b.last_at);
  const focusRoot = focus ? ROOT[focus] ?? focus : "";
  const newest = [...rows].sort((a, b) => b.last_at - a.last_at);
  const rank = [...newest.filter((r) => r.state === "run"), ...newest.filter((r) => r.state !== "run" && r.state !== "done" && !r.single)];
  const expand = [...new Set(rank.map((r) => r.root))].slice(0, 3);
  if (!expand.length && newest[0]) expand.push(newest[0].root);
  if (focusRoot && !expand.includes(focusRoot)) expand.push(focusRoot);
  const lines = rows.map((r) => lineOf(r.root));
  const chapters: ThreadChapter[] = rows.map((r, i) => {
    const d = lines[i];
    const done = d.now.main ?? (d.now.latest ? { closed_at: d.now.latest.at, text: d.now.latest.text } : null);
    return { ...r, first_at: d.ask?.at ?? r.last_at - 3600, gist: done ? { kind: "done", text: done.text, task: r.root, at: done.closed_at } : null, shown: true, expanded: expand.includes(r.root), ...(expand.includes(r.root) ? { days: d.days } : {}) };
  });
  const tail = lines.flatMap((d) => d.tail.map((b) => ({ ...b, root: d.root, root_title: b.task === d.root ? "" : d.short })));
  const order = (b: ThreadBeat) => b.state === "run" ? 0 : b.state === "wait" ? 1 : 2;
  tail.sort((a, b) => order(a) - order(b) || b.ts - a.ts);
  const closes = lines.filter((d) => d.now.main || d.now.latest?.kind === "done").map((d) => ({ task: d.now.main ? d.root : d.now.latest!.task, title: d.short, root: d.root, text: d.now.main?.text ?? d.now.latest!.text, at: d.now.main?.closed_at ?? d.now.latest!.at })).sort((a, b) => b.at - a.at).slice(0, 3);
  const agents = [...new Set(lines.flatMap((d) => d.line.agents))];
  const tasks = lines.reduce((n, d) => n + d.task_count, 0), closed = lines.reduce((n, d) => n + d.closed_count, 0);
  const moving = rows.filter((r) => r.state !== "done").length;
  const states = tail.map((b) => b.state);
  return {
    kind: "project", project: name, focus, focus_root: focusRoot, state: states.includes("run") ? "run" : states.includes("wait") ? "wait" : states.length ? "open" : "done",
    last_at: Math.max(0, ...rows.map((r) => r.last_at)), task_count: tasks, closed_count: closed, open_count: tasks - closed, session_count: lines.reduce((n, d) => n + d.session_count, 0),
    now: { closes, latest: null, last_at: Math.max(0, ...rows.map((r) => r.last_at)), lines: { total: rows.length, moving, closed: rows.length - moving } },
    left: tail.map((b) => ({ id: b.task!, title: b.title!, state: b.state!, status: b.status!, assignee: b.assignee!, from: b.from!, from_title: b.from_title!, root: b.root, root_title: b.root_title })),
    stats: { lines: rows.length, tasks, closed, decisions: lines.reduce((n, d) => n + d.line.decisions, 0), commits: lines.reduce((n, d) => n + d.line.commits, 0), agents },
    chapters, hidden: 0, tail,
  };
}

function projectRows(): ThreadProjects {
  const by = new Map<string, ThreadProjectRow>();
  for (const r of [...ROWS, ...SINGLES]) {
    const e = by.get(r.project) ?? { name: r.project, state: "done", lines: 0, moving: 0, tasks: 0, closed: 0, open: 0, run: 0, wait: 0, last_at: 0 };
    e.lines += 1; e.tasks += r.task_count; e.closed += r.closed_count; e.open += r.open_count; e.last_at = Math.max(e.last_at, r.last_at);
    if (r.state !== "done") e.moving += 1;
    if (r.state === "run") e.run += 1;
    if (r.state === "wait") e.wait += 1;
    by.set(r.project, e);
  }
  const projects = [...by.values()].sort((a, b) => b.last_at - a.last_at);
  for (const e of projects) e.state = e.run ? "run" : e.wait ? "wait" : e.open ? "open" : "done";
  const today = new Date().toDateString();
  // One project that has been quiet for a month, so the list shows its 更早 group too.
  projects.push({ name: "inkwell", state: "done", lines: 3, moving: 0, tasks: 5, closed: 5, open: 0, run: 0, wait: 0, last_at: sec(60 * 24 * 40) });
  return { projects, counts: { moving: projects.filter((e) => e.state !== "done").length, today: projects.filter((e) => new Date(e.last_at * 1000).toDateString() === today).length, recent_days: 14 } };
}

export function threadFixture(args: string[]): string {
  // A check script can hand in real `dispatch thread … --json` output to see it drawn in the preview.
  const real = (globalThis as { __threadFixture?: (a: string[]) => string | undefined }).__threadFixture?.(args);
  if (real) return real;
  if (args.includes("--projects")) return JSON.stringify(projectRows());
  if (args.includes("--timeline")) return JSON.stringify(timelineOf(args[1] ?? "", args));
  const rest: string[] = [];
  for (let i = 1; i < args.length; i++) { if (args[i] === "--task") { i++; continue; } if (!args[i].startsWith("--")) rest.push(args[i]); }
  const target = rest[0] ?? "";
  const task = ROOT[target] ?? target;
  if (!/^task-/.test(task) && target && !args.includes("--lines") && !args.includes("--all")) {
    const ti = args.indexOf("--task");
    return JSON.stringify(projectThread(target, ti >= 0 ? args[ti + 1] ?? "" : ""));
  }
  if (/^task-/.test(task)) {
    const d = lineOf(task);
    return JSON.stringify({ ...d, selected: target || d.root });
  }
  const everywhere = args.includes("--all-projects");
  const mine = (r: ThreadRow) => everywhere || r.project === target;
  const threads = ROWS.filter(mine);
  const singles = SINGLES.filter(mine);
  const today = new Date().toDateString();
  const list: ThreadList = { project: everywhere ? "" : target, everywhere, threads, singles, counts: { moving: threads.filter((r) => r.state !== "done").length, done: threads.filter((r) => r.state === "done").length, today: threads.filter((r) => new Date(r.last_at * 1000).toDateString() === today).length, singles: singles.length, recent_days: 14 } };
  return JSON.stringify(list);
}

/** 项目页 v3 in the shape of `dispatch thread <project> --timeline --json`: the lines' records turned
 *  into what was done, newest first, with a checker run and the open work. */
function timelineOf(name: string, args: string[]): ProjectTimelineData {
  const rows = [...ROWS, ...SINGLES].filter((r) => r.project === name);
  const lines = rows.map((r) => lineOf(r.root));
  const titles = new Map<string, string>();
  for (const r of rows) titles.set(r.root, r.short);
  const events: TimelineEvent[] = [];
  const walk = (bs: ThreadBeat[], root: string) => {
    for (const b of bs) {
      if (b.kind === "fork") { titles.set(b.task!, b.title!); walk(b.beats ?? [], root); continue; }
      const base = { id: `${b.kind}:${b.task}:${b.ts}`, ts: b.ts, who: b.who, task: b.task, task_title: titles.get(b.task ?? "") ?? "", root };
      if (b.kind === "done") events.push({ ...base, kind: "done", text: b.text ?? "", commits: b.commits, verified: b.verified ?? null, ...(b.task === "task-sp50" ? { before: { steps: 2, commits: 1, events: [{ id: "c1", kind: "commit", ts: b.ts - 300, text: L("feat: CKShare 邀请", "feat: CKShare invite", "feat: CKShare-Einladung"), commits: ["a41c9e2"] }, { id: "d1", kind: "did", ts: b.ts - 600, text: L("邀请链接能打开", "Invite link opens", "Einladungslink öffnet sich") }, { id: "d2", kind: "did", ts: b.ts - 900, text: L("接住 userDidAccept", "userDidAccept wired", "userDidAccept angebunden") }] } } : {}) });
      else if (b.kind === "decide") events.push({ ...base, kind: "decide", text: b.text ?? "", tag: b.tag });
      else if (b.kind === "did" && b.fold) events.push({ ...base, kind: "did", ts: b.to_ts ?? b.ts, text: "", fold: { count: b.count ?? 0, from_ts: b.from_ts ?? b.ts, to_ts: b.to_ts ?? b.ts, summary: b.summary ?? [], events: (b.beats ?? []).map((x): TimelineEvent => ({ id: `did:${x.ts}`, kind: "did", ts: x.ts, text: x.text ?? "" })).reverse() } });
      else if (b.kind === "did") events.push({ ...base, kind: "did", text: b.text ?? "" });
    }
  };
  for (const d of lines) for (const day of d.days) walk(day.beats, d.root);
  if (name === "sprout") {
    events.push({ id: "verify:sp", kind: "verify", ts: sec(2), who: "dispatch-checker", task: "task-sp51", task_title: titles.get("task-sp51") ?? "", text: "", verify: { ok: 3, ask: 1, fail: 0, model: "claude:sonnet", secs: 96, items: [
      { n: 1, state: "ok", text: L("列表页金额左边有头像，截图对得上。", "The list shows an avatar left of the amount; the screenshot matches.", "Die Liste zeigt links vom Betrag einen Avatar; der Screenshot passt."), task: "task-sp51", title: titles.get("task-sp51") },
      { n: 2, state: "ok", text: L("单测 41 个全过。", "All 41 unit tests pass.", "Alle 41 Unit-Tests bestehen."), task: "task-sp51", title: titles.get("task-sp51") },
      { n: 3, state: "ok", text: L("两台设备记的都显示各自头像。", "Entries from both devices show their own avatar.", "Einträge beider Geräte zeigen ihren eigenen Avatar."), task: "task-sp50", title: titles.get("task-sp50") },
      { n: 4, state: "ask", text: L("只能你在真机上确认室友那台的头像。", "Only you can confirm the flatmate's avatar on a real device.", "Nur Sie können den Avatar der Mitbewohnerin auf einem echten Gerät bestätigen."), task: "task-sp51", title: titles.get("task-sp51") },
    ] }, fold: { count: 2, from_ts: sec(3), to_ts: sec(2), summary: [], events: [] }, tasks: 2 });
    events.push({ id: "commit:sp", kind: "commit", ts: sec(9), text: L("feat: 记录列表显示记账人头像 (task-sp51)", "feat: show who logged each entry in the list (task-sp51)", "feat: Erfasser in der Liste anzeigen (task-sp51)"), task: "task-sp51", task_title: titles.get("task-sp51") ?? "", commits: ["e7a2c91", "3b8d0f4"], merges: 0, fold: { count: 2, from_ts: sec(11), to_ts: sec(9), summary: [], events: [] } });
    events.push({ id: "reply:sp", kind: "reply", ts: sec(6), who: "codex", text: L("头像放进列表页并加了单测，等你在第二台手机上看一眼", "Put the avatar in the list and added unit tests; waiting for you to look on the second phone", "Avatar in die Liste eingebaut und Unit-Tests ergänzt; wartet darauf, dass Sie auf dem zweiten Telefon nachsehen"), task: "task-sp51", task_title: titles.get("task-sp51") ?? "", session_id: S_SPROUT, session_title: L("共享账本", "Shared ledger", "Gemeinsames Kassenbuch"), needs_you: L("在室友手机上接受一次邀请", "Accept the invite once on the flatmate's phone", "Die Einladung einmal auf dem Telefon der Mitbewohnerin annehmen") });
  }
  const onlyDone = args.includes("--only");
  const di = args.indexOf("--days");
  const rawBack = di >= 0 ? Number(args[di + 1]) : 7;
  const back = Number.isFinite(rawBack) && rawBack >= 0 ? rawBack : 7;
  const ki = args.indexOf("--task");
  const focus = ki >= 0 ? args[ki + 1] ?? "" : "";
  const bi = args.indexOf("--before");
  const until = bi >= 0 ? Number(args[bi + 1]) : now + 86400;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const since = bi >= 0 ? until - (back || 14) * 86400 : back === 0 ? 0 : start.getTime() / 1000 - (back - 1) * 86400;
  const all = events.filter((e) => !onlyDone || ["done", "void", "decide", "verify"].includes(e.kind)).filter((e) => !focus || e.task === focus || e.root === focus).sort((a, b) => b.ts - a.ts);
  const shown = all.filter((e) => e.ts >= since && e.ts < until);
  const older = all.filter((e) => e.ts < since);
  const today = dayOf(now), yesterday = dayOf(now - 86400);
  const byDay: TimelineDay[] = [];
  for (const e of shown) {
    const d = dayOf(e.ts);
    if (!byDay.length || byDay[byDay.length - 1].date !== d) byDay.push({ date: d, weekday: weekday(e.ts), today: d === today, yesterday: d === yesterday, count: 0, events: [] });
    byDay[byDay.length - 1].events.push(e); byDay[byDay.length - 1].count += 1;
  }
  const open: OpenTask[] = lines.flatMap((d) => d.tail.map((b) => ({ id: b.task!, title: b.title!, status: b.status!, assignee: b.assignee!, priority: b.task === "task-sp52" ? 1 : 2, acceptance_done: b.state === "run" ? 2 : 0, acceptance_total: 3, last_at: b.ts, created_at: b.ts - 3600, from: b.from!, from_title: b.from_title!, root: d.root, state: b.state!, session_id: b.state === "run" ? S_SPROUT : "", session_state: b.state === "run" ? "working" : "" })));
  const wait = open.filter((x) => x.state === "wait");
  const doing = open.filter((x) => x.state !== "wait" && (x.status === "in_progress" || x.assignee));
  const unassigned = open.filter((x) => x.state !== "wait" && !(x.status === "in_progress" || x.assignee));
  const asks = name === "sprout" ? [{ task: "task-sp51", title: titles.get("task-sp51") ?? "", n: 4, item: L("室友手机上也显示头像", "The flatmate's phone shows the avatar too", "Das Telefon der Mitbewohnerin zeigt den Avatar auch"), text: L("只能你在真机上确认室友那台的头像。", "Only you can confirm the flatmate's avatar on a real device.", "Nur Sie können den Avatar der Mitbewohnerin auf einem echten Gerät bestätigen."), ts: sec(2) }] : [];
  const tasks = lines.reduce((n, d) => n + d.task_count, 0), closed = lines.reduce((n, d) => n + d.closed_count, 0);
  const folded = { steps: shown.reduce((n, e) => n + (e.kind === "did" && e.fold ? e.fold.count : 0) + (e.before?.steps ?? 0), 0), commits: shown.reduce((n, e) => n + (e.kind === "commit" && e.fold ? e.fold.count : 0) + (e.before?.commits ?? 0), 0) };
  return {
    kind: "timeline", project: name, since, before: bi >= 0 ? until : null, days_back: back, all: back === 0 && bi < 0, task: focus, only: onlyDone ? "done" : "",
    stats: { lines: rows.length, moving: rows.filter((r) => r.state !== "done").length, tasks, closed, open: tasks - closed, decisions: lines.reduce((n, d) => n + d.line.decisions, 0), commits: lines.reduce((n, d) => n + d.line.commits, 0), agents: [...new Set(lines.flatMap((d) => d.line.agents))], last_at: Math.max(0, ...rows.map((r) => r.last_at)) },
    last_at: Math.max(0, ...rows.map((r) => r.last_at)), days: byDay, gaps: [], count: shown.length, folded, older: older.length, next_before: older.length ? Math.min(since, older[0].ts + 1) : null,
    open: args.includes("--no-open") ? undefined : { asks, waiting_sessions: [], wait, doing, unassigned, sessions: [], test_cmd: "", counts: { wait: asks.length + wait.length, doing: doing.length, unassigned: unassigned.length } },
  };
}
