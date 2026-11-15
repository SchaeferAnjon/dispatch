import { plainPreview } from "./ListRows";
import { linkedSessions } from "../projectModel";
import { MediaProvider, AttachmentList } from "./Media";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { ago, actorOf, fmtTime, statusLabel, NO_RESUME, glyphStyle, relTime } from "../derive";
import { AcTally } from "./Acceptance";
import { PairDiff, PatchDiff } from "./Diff";
import { canReadReply, isScriptSession, sessionLifecycle, UNGROUPED_PROJECT, tildePath } from "../activity";
import type { Activity, FileChange, Host, Issue, Session, SessionDetail, SessionRef, SessionTail, TimelineMsg } from "../types";
import { SessionThread, ToLatest } from "./SessionThread";
import { blocksOf, mergeTail, visibleTurns } from "../timeline";
import { Avatar } from "./ui";
import { Markdown, Linkified } from "./Markdown";
import { heldOpen, toggleWhere, useHandover, whereOf, WhereItem } from "./SessionActions";
import { ChatPage, chatApiOf, isLiveView, liveKeyOf } from "./ChatPage";
import { chatViewOf, useChatSession } from "../chatStore";
import { ConversationMenuButton, useCloseChat } from "./ConversationActions";
import { SessionReply } from "./SessionReply";
import { t, useT, useLocale } from "../i18n";
import { dirname, isWindows } from "../platform";
import { Dropdown, EmptyView, ListDetail, Meta, Row, Section, Sep, Tabs, Tag, useListKeyboard } from "./primitives";
import { useActionTarget, useShellHeader, type ShellHeader } from "./Shell";
import { Icon } from "./icons";
import { relPath } from "../diff";

interface Props { onBack?: { label: string; go: () => void }; localHostName?: string; archivedProjects: Set<string>; refs: SessionRef[]; scriptCount: number; refsLoaded: boolean; archiveDays: number; outcomes: Issue[]; activities: Activity[]; issues: Issue[]; activityError: boolean; onSeen: (a: Activity, reply: string) => Promise<void>; api: Api; me: string; live: Session[]; onSelectTask: (id: string) => void; onSelected?: (id: string | null) => void; onDone: (m: string) => void; onError: (m: string) => void; initialId?: string | null; hostId?: string; onProject?: (name: string) => void; solo?: boolean; offlineHosts?: { id: string; name: string }[]; hosts?: Host[] }

// Where the conversation was started (the CLI's shared vocabulary: `dispatch list` → entrypoint).
const ENTRY: Record<string, string> = { dispatch: "Dispatch", cli: "终端", desktop: "桌面端", vscode: "VS Code", "vscode-extension": "VS Code", sdk: "SDK", "sdk-cli": "SDK", "sdk-ts": "SDK", exec: "脚本运行", subagent: "子 Agent", cron: "定时任务", gateway: "网关", telegram: "Telegram", weixin: "微信", whatsapp: "WhatsApp", discord: "Discord", slack: "Slack" };

/** Where a conversation runs or was started, for the breadcrumb and the Detail: Claudian (Claude Code in
 *  an Obsidian vault) and Dispatch's own in-app chat both run through the SDK, so neither the process
 *  tree (终端) nor the transcript's entrypoint (SDK) says it; the activity row does. */
export function sourceLabel(entrypoint: string | undefined, o: { live?: { source_app?: string }; activity?: { app?: string; runner?: string; entrypoint?: string }; inApp?: boolean } = {}): string {
  if (o.inApp || entrypoint === "dispatch" || o.activity?.entrypoint === "dispatch" || o.activity?.runner === "dispatch") return "Dispatch";
  if (o.activity?.app === "claudian") return "Obsidian · Claudian";
  if (o.live?.source_app) return o.live.source_app;
  return entrypoint && ENTRY[entrypoint] ? t(ENTRY[entrypoint]) : "";
}
/** A conversation's name: its title (the person's name for it, the short name, the agent's own title),
 *  else the first line of its first message, cut to 40 characters; "" when there is neither. A script's
 *  run (`claude -p`, a discussion seat, cron) has no first line worth showing: its prompt is the program's. */
export function displayTitle(title: string | undefined, firstPrompt?: string, script = false): string {
  if (title?.trim()) return title;
  if (script) return "";
  const line = (firstPrompt ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

// The conversation itself, one block per turn (thinking folded, tool cards, text). Shared by the
// session page and the sub-agent viewer.
export function ChatList({ list, showTools, running, cwd }: { list: TimelineMsg[]; showTools: boolean; running?: boolean; cwd?: string }) {
  const shown = useMemo(() => visibleTurns(list, { brief: false, showTools, showUser: true, showAssistant: true, running: !!running }), [list, showTools, running]);
  return <SessionThread list={shown} running={!!running} cwd={cwd} />;
}

// A sub-agent's own transcript, opened from the parent's 子 Agent tab. The prompt it was
// given is its first "user" turn; its final report is the last assistant text.
export function SubagentDialog({ api, parent, sub, onClose }: { api: Api; parent: SessionRef; sub: SessionRef["subagents"][number]; onClose: () => void }) {
  const t = useT();
  const [d, setD] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState("");
  const [tools, setTools] = useState(false);
  const [tab, setTab] = useState<"chat" | "files">("chat");
  const key = `${parent.agent}:${parent.session_id}/sub/${sub.agent_id}`;
  useEffect(() => { let alive = true; api.sessionDetail(key).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setErr(String(e)); }); return () => { alive = false; }; }, [api, key]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose]);
  const nT = d?.messages.reduce((n, x) => n + x.tools.length, 0) ?? 0;
  const list = d?.messages ?? [];
  return <div className="overlay media-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="media-dialog subagent-dialog" role="dialog" aria-modal="true" aria-label={t("子 Agent 对话")}>
      <header><span className="sub-type">{sub.type || t("子 Agent")}</span><b>{sub.description || sub.agent_id}</b><span className="muted small mono">{(sub.size / 1e3).toFixed(0)} KB · {t("深度 {n}", { n: sub.depth })}</span><span className="spacer" />
        <span className="views xs"><button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>{t("对话")}</button><button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")} disabled={!d?.files.length}>{t("文件")} {d?.files.length ?? 0}</button></span>
        <button className={`chip${tools ? " on" : ""}`} onClick={() => setTools(!tools)} title={t("显示或隐藏工具调用")}>{t("工具调用")} <span className="mono muted">{nT}</span></button>
        <button className="btn sm" autoFocus onClick={onClose} aria-label={t("关闭")}>✕</button></header>
      <MediaProvider api={api} session={{ agent: parent.agent, session_id: `${parent.session_id}/sub/${sub.agent_id}`, host: parent.host }}>
        <div className="media-content subagent-body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="empty small">{t("读子 Agent 的记录中…")}</div>}
          {d && tab === "chat" && <ChatList list={list} showTools={tools} cwd={parent.cwd} />}
          {d && tab === "files" && d.files.map((f) => <details key={f.path} className="fdiff" open={d.files.length <= 3}><summary><span className="mono">{tildePath(f.path)}</span><span className="muted"> · {t("{n} 处", { n: f.changes.length })}</span></summary><FileHunks changes={f.changes} /></details>)}
        </div>
      </MediaProvider>
    </div>
  </div>;
}

// One file's recorded edits, as diffs. Shared by the session files tab and the task detail.
export function FileHunks({ changes }: { changes: FileChange[] }) {
  const t = useT();
  return <>{changes.map((c, i) => {
    const lines = (c.new || "").split("\n").length;
    // One fold per file is enough (the file's own <details>); the hunk itself stays open.
    const head = <div className="hunk-h muted small">{c.kind === "write" ? t("写入整个文件 · {n} 行", { n: lines }) : c.kind === "patch" ? `${c.op ?? t("修改")}${c.add !== undefined ? ` · +${c.add} −${c.del ?? 0}` : ""}` : t("编辑")}{c.ts ? ` · ${fmtTime(c.ts)}` : ""}</div>;
    const body = c.kind === "patch"
      ? (c.new ? <PatchDiff text={c.new} /> : <pre className="diff"><div className="skip">{t("补丁内容没存下来")}</div></pre>)
      : <PairDiff oldText={c.old} newText={c.new} label={c.kind === "write" ? t("行号 = 文件行号") : t("行号相对本段")} />;
    return <div key={i} className="hunk">{head}{body}</div>;
  })}</>;
}

// Which Mac's copy a row is: this Mac's keeps the bare id, another Mac's is id@host.
const rowKey = (r: { session_id: string; host?: string; remote?: boolean }) => (r.remote && r.host ? `${r.session_id}@${r.host}` : r.session_id);
// After `dispatch move` the same id is on two Macs: say which copy this is. Running on both, or the
// original going on after the move, is a warning (two endings get written); otherwise the copy that
// took over says where it came from.
/** Publishes the open conversation to the window header while it is mounted; `deps` say when to publish again
 *  (the actions are new elements on every render, so they cannot be the trigger). */
function ShellHead({ header, deps }: { header: ShellHeader; deps: unknown[] }) {
  useShellHeader(header, deps);
  return null;
}

export const MovedChip =({ r }: { r: { moved_to_name?: string; moved_from_name?: string; twin_live?: string[]; forked?: string[] } }) => {
  const t = useT();
  const twin = r.twin_live?.length ? <span className="host-chip moved warn" title={t("{hosts} 上也开着这个会话，两边各写各的结尾。留一个，关掉另一个。", { hosts: r.twin_live.join(", ") })}>{t("两台都开着同一个会话")}</span> : null;
  const forked = !twin && r.forked?.length ? <span className="host-chip moved warn" title={t("迁移之后，这份和 {hosts} 上那份都接着写了，两份各有结尾。留一个接着做。", { hosts: r.forked.join(", ") })}>{t("迁移后两边都接着写了")}</span> : null;
  const where = r.moved_to_name ? (forked ? null : <span className="host-chip moved" title={t("dispatch move 迁出前的这份记录；接着做的那份在 {name} 上", { name: r.moved_to_name })}>{t("迁移前的副本 · 已迁到 {name}", { name: r.moved_to_name })}</span>)
  : r.moved_from_name ? <span className="host-chip moved" title={t("dispatch move 迁过来接手的会话")}>{t("迁移自 {name}", { name: r.moved_from_name })}</span> : null;
  return twin || forked || where ? <>{twin}{forked}{where}</> : null;
};

type Mode = "active" | "running" | "unread" | "starred" | "scheduled" | "archived";
// Which list section a conversation sits in: running first, then the ones you track, then by day.
export type SessionGroup = "running" | "starred" | "today" | "yesterday" | "week" | "older";
export const SESSION_GROUPS: SessionGroup[] = ["running", "starred", "today", "yesterday", "week", "older"];
export function sessionGroup(lastAt: number, running: boolean, starred: boolean, now: Date = new Date()): SessionGroup {
  if (running) return "running";
  if (starred) return "starred";
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const today = d.getTime() / 1000;
  if (lastAt >= today) return "today";
  d.setDate(d.getDate() - 1);
  if (lastAt >= d.getTime() / 1000) return "yesterday";
  d.setDate(d.getDate() - 5);
  return lastAt >= d.getTime() / 1000 ? "week" : "older";
}
const GROUP_TITLE: Record<SessionGroup, string> = { running: "在跑", starred: "追踪中", today: "今天", yesterday: "昨天", week: "7 天内", older: "更早" };
export { plainPreview } from "./ListRows";

// Conversations already read this run: reopening one shows it at once (then refreshes in the
// background), instead of a blank 「读取对话记录…」 and a full re-parse — over ssh from the other Mac
// that was two or three seconds every time.
const detailCache = new Map<string, SessionDetail>();
// A long transcript is megabytes of parsed messages: keep the few conversations the person is
// moving between, not every one opened since launch.
const DETAIL_CACHE_MAX = 8;
function cacheDetail(key: string, d: SessionDetail) {
  detailCache.delete(key); detailCache.set(key, d);
  while (detailCache.size > DETAIL_CACHE_MAX) { const oldest = detailCache.keys().next().value; if (oldest === undefined) break; detailCache.delete(oldest); }
}

// The Detail beside the list: where it runs, then four fixed parts (未读这轮 or 总结, 最新回复,
// 正在改, Metadata). Everything comes from the index and the activity snapshot: no transcript is
// read until the conversation is opened.
function SessionPreview({ r, a, l, me, localHostName, issues, onTask, onCopy, onOpen }: { r: SessionRef; a?: Activity; l?: Session; me: string; localHostName?: string; issues: Issue[]; onTask: (id: string) => void; onCopy: (cmd: string) => void; onOpen: () => void }) {
  const t = useT();
  const proj = r.project_override || r.project || UNGROUPED_PROJECT;
  const running = !!a && a.state === "working" && !a.stale;
  const actor = actorOf(r.agent, me);
  const hostName = r.remote ? r.host_name || r.host || "" : localHostName || t("本机");
  const where = sourceLabel(r.entrypoint, { live: l, activity: a });
  const fresh = !!(a?.unread && a.unread_summary && a.unread_summary_reply === a.reply_id);
  const summary = a?.summary || r.summary || "";
  const files = Object.entries(a?.files ?? {}).sort((x, y) => y[1] - x[1]).map(([p]) => relPath(p, r.cwd));
  const tasks = issues.filter((i) => linkedSessions(i).includes(r.session_id) && i.status !== "closed");
  const subsRunning = r.subagents.filter((s) => s.running).length;
  const resume = NO_RESUME.has(r.agent) ? "" : r.resume_cmd;
  const status = running ? <Tag color="green" dot>{t("在跑")}</Tag> : a?.unread ? <Tag color="blue">{t("未读")}</Tag> : r.scheduled ? <Tag color="purple">{t("定时")}</Tag> : null;
  const rows: [ReactNode, ReactNode][] = [
    [t("Agent"), <><Avatar actor={actor} />{actor?.name ?? r.agent}</>],
    [t("主机"), <><span className={`dotc${r.remote ? " off" : ""}`} />{hostName}<MovedChip r={r} /></>],
  ];
  if (where) rows.push([t("终端"), where]);
  if (a?.runner) rows.push([t("运行在"), a.runner === "dispatch" ? <><span className="dotc" />Dispatch</> : <><span className="dotc off" />{t("终端")}</>]);
  if (r.cwd) rows.push([t("目录"), <span className="mono small" title={r.cwd}>{tildePath(r.cwd)}{r.branch ? ` · ${r.branch}` : ""}</span>]);
  if (r.user_msgs) rows.push([t("对话"), `${t("{n} 轮", { n: r.user_msgs })} · ${t("{n} 次回复", { n: r.assistant_msgs })}`]);
  if (files.length) rows.push([t("改动"), t("{n} 个文件", { n: files.length })]);
  if (r.subagents.length) rows.push([t("子 Agent"), subsRunning ? t("{n} 个，{m} 个在跑", { n: r.subagents.length, m: subsRunning }) : t("{n} 个，都已完成", { n: r.subagents.length })]);
  if (tasks.length) rows.push([t("任务"), <span className="sess-tasks">{tasks.map((x) => <span key={x.id} className="sess-task"><button className="dlink" onClick={() => onTask(x.id)} title={x.title}><span className="mono">{x.id}</span> {x.title}</button><AcTally issue={x} /></span>)}</span>]);
  if (r.first_ts) rows.push([t("开始"), fmtTime(r.first_ts)]);
  rows.push([t("最近"), ago(r.last_at) || "?"]);
  if (resume) rows.push([t("恢复"), <button className="dlink mono small" onClick={() => onCopy(resume)} title={t("复制恢复命令")}>{resume.replace(/^cd .*?&&\s*/, "")}</button>]);
  return (
    <div className="d sess-preview" onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button,a,pre")) onOpen(); }}>
      <div className="d-crumb"><span className="pj sm" style={glyphStyle(proj)}>{(proj === UNGROUPED_PROJECT ? t(proj) : proj).slice(0, 1).toUpperCase()}</span><span>{proj === UNGROUPED_PROJECT ? t(proj) : proj}</span><span className="d-sep">›</span><span>{hostName}</span>{where && <><span className="d-sep">›</span><span>{where}</span></>}{status}</div>
      <h2 className="d-title">{displayTitle(r.title, r.first_prompt || a?.first_prompt, isScriptSession({ ...r, app: a?.app, runner: a?.runner })) || t("（无标题）")}</h2>
      <div className="d-md">
        {fresh ? <><h4>{t("未读这轮")}</h4><p><Linkified text={a!.unread_summary!} /></p></> : summary ? <><h4>{t("总结")}</h4><p><Linkified text={summary} /></p></> : null}
        {running && a?.activity && <><h4>{t("正在做")}</h4><p>{a.activity}</p></>}
        {a?.reply_preview && <><h4>{t("最新回复")}</h4><p className="d-clamp"><Linkified text={plainPreview(a.reply_preview)} /></p></>}
        {files.length > 0 && <><h4>{running ? t("正在改") : t("改过的文件")}</h4><pre>{files.slice(0, 8).join("\n")}{files.length > 8 ? `\n${t("还有 {n} 个", { n: files.length - 8 })}` : ""}</pre></>}
        {!fresh && !summary && !a?.reply_preview && !files.length && !running && <p className="muted">{r.first_prompt ? <Linkified text={plainPreview(r.first_prompt, 300)} /> : t("还没有摘要。打开会话看完整记录。")}</p>}
      </div>
      <Sep />
      <Meta rows={rows} />
    </div>
  );
}

export function SessionsView({ onBack, onProject, solo = false, offlineHosts = [], hosts = [], localHostName, archivedProjects, refs, scriptCount, refsLoaded: loaded, archiveDays, activities, issues, outcomes, activityError, onSeen, api, me, live, onSelectTask, onSelected, onDone, onError, initialId, hostId }: Props) {
  const t = useT();
  const locale = useLocale();   // the view-menu extras below are built once per change: rebuild them on a switch
  const showScripts = false; // script-launched sessions live under 定时或脚本
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [mode, setMode] = useState<Mode>("active");
  const [projectF, setProjectF] = useState("");
  const host = hostId ?? "";
  // `sel` is the open conversation (transcript, reply box, in the URL); `focus` is the row the list
  // has selected while you browse, shown in the Detail on the right.
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  const [focus, setFocus] = useState<string | null>(initialId ?? null);
  // 收起列表: the conversation takes the whole width; remembered per device.
  const [listHidden, setListHidden] = useState<boolean>(() => { try { return localStorage.getItem("dispatch-sess-list-hidden") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("dispatch-sess-list-hidden", listHidden ? "1" : "0"); } catch { /* private mode */ } }, [listHidden]);
  // 分屏: two or four conversations side by side, each a solo copy of this page (same origin, ?solo=1),
  // so every pane has its own transcript, reply box and polling. Clicking the list fills the focused pane.
  const [split, setSplit] = useState<{ layout: 2 | 4; panes: (string | null)[]; focus: number } | null>(null);
  const soloUrl = (id: string) => { const q = new URLSearchParams(location.search); q.set("solo", "1"); return `${location.pathname}?${q.toString()}#/sessions/${encodeURIComponent(id)}`; };
  const titleOf = (id: string) => refs.find((r) => r.session_id === id)?.title || id.slice(0, 8);
  const startSplit = (layout: 2 | 4) => setSplit((cur) => { const panes: (string | null)[] = Array.from({ length: layout }, (_, i) => cur?.panes[i] ?? (i === 0 ? (sel ? sel.split("@")[0] : null) : null)); return { layout, panes, focus: panes.findIndex((p) => !p) === -1 ? 0 : panes.findIndex((p) => !p) }; });
  const placeInPane = (id: string) => setSplit((cur) => { if (!cur) return cur; const panes = [...cur.panes]; const empty = panes.findIndex((p) => !p); const at = empty === -1 ? cur.focus : empty; panes[at] = id; const nextEmpty = panes.findIndex((p) => !p); return { ...cur, panes, focus: nextEmpty === -1 ? at : nextEmpty }; });
  useEffect(() => { onSelected?.(sel); }, [sel]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const detailAgent = useRef<{ id: string; agent: string } | null>(null);
  if (detail && sel) detailAgent.current = { id: sel, agent: detail.meta.agent };
  const [tab, setTab] = useState<"timeline" | "files" | "tasks" | "attachments" | "subagents">("timeline");
  const [subView, setSubView] = useState<SessionRef["subagents"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Which kinds of turns to show. Tools off by default: the conversation is the point.
  const [kindsSaved, setKinds] = useState<Record<"user" | "assistant" | "tool", boolean>>(() => { try { return { user: true, assistant: true, tool: false, ...JSON.parse(localStorage.getItem("dispatch-tl-kinds") || "{}") }; } catch { return { user: true, assistant: true, tool: false }; } });
  const kinds = kindsSaved;
  const flip = (k: "user" | "assistant" | "tool") => { const v = { ...kinds, [k]: !kinds[k] }; setKinds(v); try { localStorage.setItem("dispatch-tl-kinds", JSON.stringify(v)); } catch { /* ignore */ } };
  // 只看结论: your messages plus the last reply of each turn, nothing in between.
  const [briefSaved, setBrief] = useState<boolean>(() => { try { return localStorage.getItem("dispatch-tl-brief") === "1"; } catch { return false; } });
  const brief = briefSaved;
  const toggleBrief = () => { setBrief((b) => { try { localStorage.setItem("dispatch-tl-brief", b ? "0" : "1"); } catch { /* ignore */ } return !b; }); };
  // Live activity uses the transcript tail below: progress, calls and results belong to the
  // same conversation, with results updating their original cards by call id.
  const phone = typeof window !== "undefined" && window.innerWidth <= 640;

  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const timelineScroll = useRef(0);
  const [atLatest, setAtLatest] = useState(true);
  const [isVisible, setIsVisible] = useState(document.visibilityState === 'visible');
  // A row is a session on one Mac: after `dispatch move` the same id runs on two, so another Mac's copy is selected as id@host.
  const selSid = sel ? sel.split("@")[0] : null; const selHost = sel && sel.includes("@") ? sel.slice(sel.indexOf("@") + 1) : null;
  const refsRef = useRef(refs); refsRef.current = refs;
  // The row that stands for what is open: its exact key, or — when the list carries only the other
  // Mac's copy of the same conversation (after `dispatch move`) — the row with the same id.
  const exactSelRow = sel ? refs.some((x) => rowKey(x) === sel) : false;
  const isSel = (r: { session_id: string; host?: string; remote?: boolean }) => !!sel && (rowKey(r) === sel || (!exactSelRow && r.session_id === selSid));
  // The folded row that stands for the open conversation. When the open copy is one it folded away
  // (the original left behind by `dispatch move`), that copy is read-only: replies go to the live one.
  const selRef = sel ? refs.find((x) => rowKey(x) === sel) ?? refs.find((x) => x.session_id === selSid) : undefined;
  const foldedCopy = selRef?.copies?.find((c) => c.host === (selHost ?? "local"));
  const liveRowKey = selRef ? rowKey(selRef) : null;
  // What the chips say about the open copy: the folded row knows more than the transcript's own meta
  // (a moved_to from an earlier move that a later move back superseded, twins, forks).
  const chipOf = (m: { moved_to_name?: string; moved_from_name?: string }) => foldedCopy ? { moved_to_name: foldedCopy.moved_to_name ?? selRef?.host_name ?? m.moved_to_name }
    : selRef && rowKey(selRef) === sel ? selRef : { ...m, twin_live: selRef?.twin_live, forked: selRef?.forked, moved_from_name: m.moved_from_name ?? selRef?.moved_from_name };
  const closeChat = useCloseChat();
  const current = activities.find(a => a.session_id === selSid && (selHost ? a.host === selHost : !a.remote)) ?? (selHost ? undefined : activities.find(a => a.session_id === selSid));
  // In-app chat: the open conversation runs inside Dispatch (activity says so, or chatd streamed it this
  // run). Only this computer's sessions; another Mac's go through its terminal path.
  const chat = chatApiOf(api);
  const selAgent = (sel && (detailAgent.current?.id === sel ? detailAgent.current.agent : undefined)) ?? current?.agent ?? refs.find((r) => r.session_id === selSid)?.agent;
  const liveKey = selSid && !selHost ? (selAgent === "claude-code" || selAgent === "codex" ? `${selAgent}:${selSid}` : liveKeyOf(selSid)) : null;
  const chatHandle = useChatSession(chat, liveKey);
  const liveView = liveKey ? chatHandle.view ?? chatViewOf(liveKey) ?? null : null;
  // Closed on request (the `desktop` toggle moved it to a terminal): the transcript view with its reply box again.
  const showChat = !!liveKey && liveView?.closed?.reason !== "requested" && (isLiveView(liveView) || current?.runner === "dispatch");
  const handover = useHandover();
  const [handing, setHanding] = useState(false);
  const [handoverErr, setHandoverErr] = useState("");
  useEffect(() => { setHandoverErr(""); }, [sel]);
  const takeOver = async (m: { agent: string; session_id: string; cwd: string }) => {
    if (!chat || handing) return;
    setHanding(true); setHandoverErr("");
    try { await handover(chat, m); } catch (e) { setHandoverErr(e instanceof Error ? e.message : String(e)); } finally { setHanding(false); }
  };
  // The open conversation names the window header (title + project chip). A split pane (solo) has no
  // window header and the phone keeps its own line.
  const inShell = !solo && !phone;
  const listToggle = !solo && <button className="hd-icon list-toggle" onClick={() => setListHidden((v) => !v)} title={listHidden ? t("展开会话列表") : t("收起会话列表，对话占满整页")} aria-label={listHidden ? t("展开会话列表") : t("收起会话列表")}><Icon name="sidebar" /></button>;
  useEffect(() => {
    const changed = () => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  // Is the agent working in this conversation right now? Then the transcript is tailed (below)
  // and the full re-read only resyncs every so often.
  const running = !!current && current.state === 'working' && !current.stale;
  const runningRef = useRef(running); runningRef.current = running;
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let alive = true; let timer = 0; let lastFull = 0;
    setLoadError(false); follow.current = true; setAtLatest(true);
    const cached = detailCache.get(sel);
    if (cached) { setDetail(cached); setBusy(false); } else { setBusy(true); setDetail(null); }
    // The whole transcript, parsed on its Mac: on open (unless cached) and as a resync every 90 s.
    const fetchFull = async () => {
      let d: SessionDetail;
      if (selHost) {
        const raw = await api.on(selHost, ["session", selSid!, "--json"]);
        d = JSON.parse(raw.slice(raw.indexOf("{"))) as SessionDetail;
        const r = refsRef.current.find((x) => x.session_id === selSid && x.host === selHost);
        // A copy folded under the live row (after `dispatch move`) is not a row of its own.
        const c = r ? undefined : refsRef.current.find((x) => x.session_id === selSid)?.copies?.find((k) => k.host === selHost);
        d = { ...d, meta: { ...d.meta, host: selHost, remote: true, host_name: r?.host_name ?? c?.host_name ?? selHost, moved_to: r?.moved_to, moved_to_name: r?.moved_to_name ?? c?.moved_to_name, moved_from: r?.moved_from, moved_from_name: r?.moved_from_name } };
      } else d = await api.sessionDetail(sel);
      lastFull = Date.now();
      if (alive) { cacheDetail(sel, d); setDetail(d); setLoadError(false); }
    };
    // Between resyncs only what was appended since the last read travels (`--since <offset>`),
    // for an idle conversation as well as a running one.
    const fetchTail = async () => {
      const d = detailRef.current;
      if (!d || d.offset === undefined) return fetchFull();
      const raw = await api.on(selHost ?? d.meta.host ?? "local", ["session", `${d.meta.agent}:${d.meta.session_id}`, "--since", String(d.offset), "--json"]);
      const t = JSON.parse(raw.slice(Math.max(0, raw.indexOf("{")))) as SessionTail;
      if (alive && t.partial) setDetail((prev) => { if (!prev) return prev; const next = mergeTail(prev, t); cacheDetail(sel, next); return next; });
    };
    const refresh = async () => {
      if (document.visibilityState === 'visible') {
        try {
          if (!detailRef.current || Date.now() - lastFull > 90000) await fetchFull();
          else if (!runningRef.current) await fetchTail();   // running: the live tail below already polls every 1.5 s
        }
        catch { if (alive && !detailRef.current) setLoadError(true); }
        finally { if (alive) setBusy(false); }
      }
      if (alive) timer = window.setTimeout(refresh, runningRef.current ? 12000 : 3000);
    };
    refresh();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [sel, api]);
  // Live: every 1.5 s ask `dispatch session --since <offset>` for what was appended and fold it
  // in — a new thinking step, a tool card turning from running to done, the next paragraph.
  const detailRef = useRef(detail); detailRef.current = detail;
  useEffect(() => {
    if (!sel || !running || !detail || detail.offset === undefined) return;
    let alive = true; let timer = 0; let inflight = false;
    const key = `${detail.meta.agent}:${detail.meta.session_id}`; const host = detail.meta.host ?? 'local';
    const tick = async () => {
      const d = detailRef.current;
      if (!inflight && document.visibilityState === 'visible' && d && d.offset !== undefined) {
        inflight = true;
        try {
          const raw = await api.on(host, ['session', key, '--since', String(d.offset), '--json']);
          const t = JSON.parse(raw.slice(Math.max(0, raw.indexOf('{')))) as SessionTail;
          if (alive && t.partial) setDetail((prev) => { if (!prev) return prev; const next = mergeTail(prev, t); cacheDetail(sel, next); return next; });
        } catch { /* the next full read catches up */ }
        inflight = false;
      }
      if (alive) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [sel, running, api, detail?.meta.session_id, detail?.meta.agent, detail?.meta.host, detail?.offset === undefined]);  // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (tab === 'timeline' && follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail, tab, kinds]);
  // While the session runs the text streams in after the detail changed (useSmooth): keep the
  // bottom in view as the thread grows, as long as the person has not scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!running || tab !== 'timeline' || !el) return;
    const ob = new MutationObserver(() => { if (follow.current) el.scrollTop = el.scrollHeight; });
    ob.observe(el, { childList: true, subtree: true, characterData: true });
    return () => ob.disconnect();
  }, [running, tab, detail?.meta.session_id]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = tab === 'timeline' ? (follow.current ? scroller.current.scrollHeight : timelineScroll.current) : 0;
  }, [tab]);
  useEffect(() => {
    if (canReadReply(current, detail?.reply_id, atLatest, isVisible, tab === 'timeline' && kinds.assistant)) {
      // Brief dwell avoids clearing messages passed over during rapid navigation.
      const t = window.setTimeout(() => { if (current && detail?.reply_id) void onSeen(current, detail.reply_id); }, 800);
      return () => window.clearTimeout(t);
    }
  }, [current, detail?.reply_id, atLatest, isVisible, tab, kinds.assistant, onSeen]);
  const latest = () => { follow.current = true; setAtLatest(true); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; };
  // The turns the timeline draws (memoized: the thread re-renders every poll while a session runs).
  const shownTurns = useMemo(() => detail ? visibleTurns(detail.messages, { brief, showTools: kinds.tool && !brief, showUser: kinds.user, showAssistant: kinds.assistant, running }) : [], [detail?.messages, brief, kinds, running]);  // eslint-disable-line react-hooks/exhaustive-deps

  // The conversation state of a catalog row, by host and id (activities carry state, unread and files).
  const actMap = useMemo(() => new Map(activities.map((a) => [`${a.host ?? "local"}:${a.session_id}`, a])), [activities]);
  const actOf = (r: { session_id: string; host?: string }) => actMap.get(`${r.host ?? "local"}:${r.session_id}`);
  const isRunning = (a?: Activity) => !!a && a.state === "working" && !a.stale;
  const projOf = (r: { project: string; project_override?: string }) => r.project_override || r.project || "";
  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const all = new Map(refs.map(r => [rowKey(r), r]));
    for (const a of activities) {
      const old = all.get(rowKey(a));
      all.set(rowKey(a), old ? { ...old, last_at: a.last_at, scheduled: old.scheduled || a.scheduled, starred: old.starred || a.starred, archived: old.archived || a.archived } : { ...a, first_ts: '', last_ts: '', entrypoint: '', branch: '', user_msgs: 0, assistant_msgs: 0, tools: {}, tasks: Object.fromEntries(a.tasks.map(t => [t, 1])), mentions: 0, current_task: null, resume_cmd: '', path: '', size: 0, subagents: [] });
    }
    const inMode = (r: SessionRef) => {
      if (mode === "scheduled") return !!r.scheduled || isScriptSession(r);
      if (!showScripts && isScriptSession(r)) return false;
      if (r.scheduled) return false;
      const life = archivedProjects.has(r.project_override || r.project) ? "archived" : sessionLifecycle(r, archiveDays);
      if (mode === "archived") return life === "archived";
      if (mode === "starred") return life === "starred";
      if (life === "archived") return false;
      const a = actOf(r);
      return mode === "running" ? isRunning(a) : mode === "unread" ? !!a?.unread && !isRunning(a) : true;
    };
    return [...all.values()].sort((a,b) => Number(!!b.starred) - Number(!!a.starred) || b.last_at - a.last_at).filter((r) => inMode(r) && (!agent || r.agent === agent) && (!host || (r.host ?? "local") === host) && (!projectF || projOf(r) === projectF) && (!qq || (r.title || "").toLowerCase().includes(qq) || r.cwd.toLowerCase().includes(qq) || r.session_id.startsWith(qq) || Object.keys(r.tasks).some((t) => t.includes(qq))));
  }, [refs, showScripts, activities, q, agent, host, mode, archiveDays, archivedProjects, projectF, actMap]);  // eslint-disable-line react-hooks/exhaustive-deps
  // @ in the chat box: the most recent conversations, as a summary and a resume command.
  const mentionSessions = useMemo(() => [...refs].sort((a, b) => b.last_at - a.last_at).slice(0, 30).map((r) => ({ key: `${r.agent}:${r.session_id}`, title: r.title || r.session_id.slice(0, 8), summary: r.summary, resume: NO_RESUME.has(r.agent) ? "" : r.resume_cmd })), [refs]);
  // The menu wants the conversation shape; a catalog row becomes one with the same identity.
  const asActivity = (r: SessionRef): Activity => actOf(r) ?? ({ ...r, key: `${r.agent}:${r.session_id}`, tasks: Object.keys(r.tasks || {}), state: "unknown", stale: true, unread: false, activity: "", version: "", events: [], tracking_since: 0, source: "catalog" } as Activity);
  const counts = useMemo(() => {
    const seen = new Map<string, SessionRef | Activity>(); for (const r of [...refs, ...activities]) if (!seen.has(rowKey(r))) seen.set(rowKey(r), r);
    const all = [...seen.values()].filter((r) => !host || (r.host ?? "local") === host);
    const life = (r: SessionRef | Activity) => archivedProjects.has(r.project_override || r.project) ? "archived" : sessionLifecycle(r, archiveDays);
    const open = all.filter((r) => !r.scheduled && !isScriptSession(r) && life(r) !== "archived");
    return { active: open.length, running: open.filter((r) => isRunning(actOf(r))).length, unread: open.filter((r) => { const a = actOf(r); return !!a?.unread && !isRunning(a); }).length,
      scheduled: all.filter((r) => r.scheduled).length, starred: all.filter((r) => !r.scheduled && life(r) === "starred").length, archived: all.filter((r) => !r.scheduled && life(r) === "archived").length };
  }, [refs, activities, archiveDays, archivedProjects, host, actMap]);  // eslint-disable-line react-hooks/exhaustive-deps
  // The 项目 dropdown: every project with a conversation, busiest first.
  const projectOptions = useMemo(() => { const n = new Map<string, number>(); for (const r of refs) { const p = projOf(r); if (p) n.set(p, (n.get(p) ?? 0) + 1); } return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p); }, [refs]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Sections in display order; conversations with no title and at most one message fold into 零散会话 at the end.
  const isBlank = (r: SessionRef) => !r.title && r.user_msgs <= 1 && !r.starred && !(actOf(r)?.unread || isRunning(actOf(r)));
  const sections = useMemo(() => {
    const now = new Date();
    const by = new Map<SessionGroup, SessionRef[]>();
    for (const r of items) { if (isBlank(r)) continue; const g = sessionGroup(r.last_at, isRunning(actOf(r)), !!r.starred, now); by.set(g, [...(by.get(g) ?? []), r]); }
    return SESSION_GROUPS.filter((g) => by.has(g)).map((g) => ({ group: g, rows: g === "starred" ? by.get(g)! : [...by.get(g)!].sort((a, b) => b.last_at - a.last_at) }));
  }, [items, actMap]);  // eslint-disable-line react-hooks/exhaustive-deps
  const blank = useMemo(() => items.filter(isBlank), [items, actMap]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [blankOpen, setBlankOpen] = useState(false);
  const orderedIds = useMemo(() => [...sections.flatMap((s) => s.rows.map(rowKey)), ...(blankOpen ? blank.map(rowKey) : [])], [sections, blank, blankOpen]);
  // The list always has a selection while you browse (Raycast): the first row until you pick one.
  useEffect(() => { if (!sel && orderedIds.length && (!focus || !orderedIds.includes(focus))) setFocus(orderedIds[0]); }, [orderedIds, sel]);  // eslint-disable-line react-hooks/exhaustive-deps
  const focusRow = useMemo(() => (focus ? items.find((r) => rowKey(r) === focus) : undefined), [items, focus]);
  const openRow = (key: string) => { if (split) { placeInPane(key.split("@")[0]); return; } setSel(key); setFocus(key); setTab("timeline"); };
  useListKeyboard(orderedIds, focus, setFocus, { onEnter: openRow, enabled: !sel && !split });

  const liveOf = (id: string, host?: string) => live.find((s) => s.session_id === id && (host === undefined || (s.host ?? "local") === host));
  const copy = async (cmd: string) => { try { await api.copy(cmd); onDone(t("恢复命令已复制，去终端粘贴回车")); } catch (e) { onError(String(e)); } };
  useItemMenu("file", (rel) => {
    const root = detail?.workspace?.root;
    if (!root) return null;
    const full = `${root.replace(/\/$/, "")}/${rel}`;
    return { title: rel, items: [
      { label: t("打开文件"), onClick: () => api.openPath(full).catch((e) => onError(String(e))) },
      { label: (isWindows ? t("在资源管理器中显示") : t("在访达中打开")), onClick: () => api.openPath(dirname(full)).catch((e) => onError(String(e))) },
      { label: t("复制路径"), onClick: () => api.copy(full).then(() => onDone(t("路径已复制"))) },
      { label: t("复制相对路径"), onClick: () => api.copy(rel).then(() => onDone(t("已复制"))) },
    ] };
  }, [detail?.workspace?.root, api]);
  useViewMenuExtras(detail ? [
    { label: t("复制恢复命令"), onClick: () => void copy(detail.meta.resume_cmd) },
    { label: t("复制会话 ID"), onClick: () => api.copy(detail.meta.session_id).then(() => onDone(t("已复制"))) },
  ] : [], [detail?.meta.session_id, locale]);

  // What the bottom bar and ⌘K act on: the row you are on while browsing, the open conversation otherwise.
  const focusReply = () => (document.querySelector(".session-reply textarea, .chat-composer textarea") as HTMLTextAreaElement | null)?.focus();
  const targetRow = sel ? items.find((r) => isSel(r)) : focusRow;
  useActionTarget(targetRow && !split ? { kind: "session", key: `${targetRow.host ?? "local"}:${targetRow.agent}:${targetRow.session_id}`, primary: sel ? { label: t("回复"), run: focusReply } : { label: t("查看并回复"), run: () => openRow(rowKey(targetRow)) } } : null, [targetRow ? rowKey(targetRow) : "", !!sel, !!split, locale]);
  // In an open conversation: esc goes back to the list, ↵ puts the cursor in the reply box.
  useEffect(() => {
    if (!sel || solo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "Escape" && e.key !== "Enter")) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input,textarea,select,button,a,summary,[contenteditable="true"]')) return;
      if (document.querySelector(".overlay,.task-menu-shade,.ap,.dialog,.detail,footer.bar.has-toast")) return;
      e.preventDefault();
      if (e.key === "Escape") setSel(null); else focusReply();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, solo]);

  const rowEl = (r: SessionRef) => {
    const key = rowKey(r); const a = actOf(r); const running = isRunning(a); const l = liveOf(r.session_id, r.host ?? "local");
    const twin = r.twin_live?.length ? <Tag color="orange" title={t("{hosts} 上也开着这个会话，两边各写各的结尾。留一个，关掉另一个。", { hosts: r.twin_live.join(", ") })}>{t("两台都开着")}</Tag>
      : r.forked?.length ? <Tag color="orange" title={t("迁移之后，这份和 {hosts} 上那份都接着写了，两份各有结尾。留一个接着做。", { hosts: r.forked.join(", ") })}>{t("两边都接着写了")}</Tag> : null;
    // Agents window (Dispatch IDE / VS Code): the Agent Host's title and needs-input state win (ide_sessions.py)
    const ide = l?.source === "ide" ? l : undefined;
    const ideTag = ide ? <Tag title={t("在 {app} 的 Agents 窗口里开的会话", { app: ide.ide_app || "Dispatch IDE" })}>IDE</Tag> : null;
    const tag = a?.waiting === "dialog" || ide?.attention === "input" ? <Tag color="orange" dot>{t("等你确认")}</Tag> : running ? <Tag color="green" dot>{t("在跑")}</Tag> : a?.unread ? <Tag color="blue">{t("未读")}</Tag> : heldOpen(a) ? <Tag title={t("Dispatch 里开着、没在干活；右键选「关掉后台会话」")}>{t("后台空闲")}</Tag> : (r.scheduled || isScriptSession(r)) ? <Tag color="purple">{t("定时")}</Tag> : l && !a ? <Tag>{t("开着")}</Tag> : null;
    return <Row key={key} id={key} data-session={`${r.host ?? "local"}:${r.agent}:${r.session_id}`} selected={sel || split ? isSel(r) : key === focus}
      onClick={() => { if (split || sel || phone) openRow(key); else setFocus(key); }} onOpen={() => openRow(key)} tooltip={r.title || undefined}
      icon={<Avatar actor={actorOf(r.agent, me)} />} title={<>{r.starred && <span className="star on" title={t("追踪中")}>★ </span>}{displayTitle(ide?.title || r.title, r.first_prompt, isScriptSession(r)) || t("（无标题）")}</>}
      accessories={[twin, ideTag, tag, <span className="num">{relTime(new Date(r.last_at * 1000).toISOString())}</span>, <span className="touch-only"><ConversationMenuButton a={asActivity(r)} /></span>].filter(Boolean)} />;
  };
  const filtered = !!(q.trim() || agent || projectF);
  const empty = mode === "archived" ? { icon: "archive", title: t("没有归档的会话"), description: t("{days} 天没有活动的会话会自动归到这里", { days: archiveDays }) }
    : mode === "starred" ? { icon: "star", title: t("还没有收藏的会话"), description: t("右键一条会话，选「收藏：长期追踪」。") }
    : filtered ? { icon: "search", title: t("没有匹配的会话"), description: t("换个筛选条件，或清空搜索。") }
    : mode === "running" ? { icon: "chat", title: t("没有在跑的会话"), description: "" }
    : mode === "unread" ? { icon: "inbox", title: t("没有未读回复"), description: "" }
    : mode === "scheduled" ? { icon: "cal", title: t("没有定时或脚本会话"), description: "" }
    : { icon: "chat", title: t("还没有会话"), description: t("在终端里开一个 Agent，或点「＋ 会话」。") };
  const listBody = !loaded ? <EmptyView icon="refresh" title={t("索引中…")} description={t("首次要读完全部历史")} />
    : items.length === 0 ? <EmptyView icon={empty.icon} title={empty.title} description={empty.description || undefined} />
    : <>
      {sections.map((s) => <Section key={s.group} title={t(GROUP_TITLE[s.group])} count={s.rows.length}>{s.rows.map(rowEl)}</Section>)}
      {blank.length > 0 && <Section title={<button className="lsec-fold" onClick={() => setBlankOpen((o) => !o)} aria-expanded={blankOpen}><Icon name={blankOpen ? "down" : "right"} size={12} />{t("零散会话")}</button>} count={blank.length} right={t("没有标题、最多一句话")}>{blankOpen && blank.map(rowEl)}</Section>}
    </>;
  const tabs = <Tabs<Mode> value={mode} onChange={(m) => { setMode(m); setBlankOpen(false); }} items={[
    { key: "active", label: t("全部") },
    { key: "running", label: t("在跑"), count: counts.running },
    { key: "unread", label: t("未读"), count: counts.unread },
    ...(counts.starred > 0 || mode === "starred" ? [{ key: "starred" as Mode, label: t("追踪中"), count: counts.starred, title: t("收藏的会话：长期追踪，不会自动归档") }] : []),
    ...(counts.scheduled > 0 || scriptCount > 0 || mode === "scheduled" ? [{ key: "scheduled" as Mode, label: t("定时"), title: t("不是你在终端里开的：定时任务、脚本或别的 Agent 通过程序接口启动的会话") }] : []),
    { key: "archived", label: t("已归档"), title: t("手动归档，或超过 {days} 天没有活动", { days: archiveDays }) },
  ]} right={<>
    <label className="sess-q" title={t("标题、目录、任务 ID…")}><Icon name="search" size={13} /><input placeholder={t("筛选")} aria-label={t("标题、目录、任务 ID…")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }} /></label>
    <Dropdown value={agent} onChange={setAgent} label={t("按 Agent 筛选")} options={[{ value: "", label: t("所有 Agent") }, ...[["claude-code", "Claude Code"], ["codex", "Codex"], ["pi", "pi"], ["zcode", "ZCode"], ["opencode", "OpenCode"], ["hermes", "Hermes"], ["gemini", "Gemini CLI"]].map(([value, label]) => ({ value, label }))]} />
    <Dropdown value={projectF} onChange={setProjectF} label={t("按项目筛选")} options={[{ value: "", label: t("所有项目") }, ...projectOptions.map((p) => ({ value: p, label: p === UNGROUPED_PROJECT ? t(p) : p }))]} />
  </>} />;
  const preview = !sel && !split && !phone && focusRow ? <SessionPreview r={focusRow} a={actOf(focusRow)} l={liveOf(focusRow.session_id, focusRow.host ?? "local")} me={me} localHostName={localHostName} issues={issues} onTask={onSelectTask} onCopy={copy} onOpen={() => openRow(rowKey(focusRow))} /> : undefined;
  const listPane = <ListDetail className={`sess-ld${sel || split ? " narrow" : ""}`} tabs={tabs} detail={preview}>{listBody}</ListDetail>;
  if (!sel && !split) return <MediaProvider api={api} session={undefined}>{listPane}</MediaProvider>;

  return (
    <MediaProvider api={api} session={detail?.meta}><div className={`sess-wrap has-selection${listHidden || solo ? " list-hidden" : ""}${split ? " is-split" : ""}`}>
      {!(listHidden || solo) && listPane}

      <div className="sess-main">
        {split && <div className={`sess-split cols-${split.layout === 2 ? 2 : 2}`}>
          <div className="sess-split-bar">
            <button className="btn sm" onClick={() => setListHidden((v) => !v)} title={listHidden ? t("展开会话列表") : t("收起会话列表")}>{listHidden ? t("⇥ 列表") : t("⇤ 收起列表")}</button>
            <span className="muted small">{t("分屏：点左边列表把会话放进高亮的格子")}</span><span className="spacer" />
            <button className={`btn sm${split.layout === 2 ? " on" : ""}`} onClick={() => startSplit(2)}>{t("2 格")}</button>
            <button className={`btn sm${split.layout === 4 ? " on" : ""}`} onClick={() => startSplit(4)}>{t("4 格")}</button>
            <button className="btn sm" onClick={() => setSplit(null)}>{t("退出分屏")}</button>
          </div>
          <div className={`sess-panes n${split.layout}`}>
            {split.panes.map((id, i) => <div key={i} className={`sess-pane${split.focus === i ? " focus" : ""}`} onMouseDown={() => setSplit((c) => c ? { ...c, focus: i } : c)}>
              <div className="sess-pane-head"><span className="t">{id ? titleOf(id) : t("第 {n} 格 · 点左边列表选一段会话", { n: i + 1 })}</span>{id && <button className="btn sm" onClick={() => setSplit((c) => { if (!c) return c; const panes = [...c.panes]; panes[i] = null; return { ...c, panes, focus: i }; })} aria-label={t("关闭这一格")}>✕</button>}</div>
              {id ? <iframe title={titleOf(id)} src={soloUrl(id)} /> : <div className="empty">{t("空")}</div>}
            </div>)}
          </div>
        </div>}
        {!split && sel && !detail && showChat && liveKey && <>
          {inShell ? <ShellHead header={{ title: t("新会话"), actions: <>{listToggle}</> }} deps={[liveKey, listHidden, locale]} />
            : <div className="sess-head">
            {listToggle}
            <h2 className="ttl">{t("新会话")}</h2><span className="sp" />
          </div>}
          <ChatPage key={liveKey} api={api} session={liveKey} detail={null} activity={current} hosts={hosts} issues={issues} sessions={mentionSessions}
            onHandover={() => void takeOver({ agent: liveKey.split(":")[0], session_id: selSid!, cwd: chatViewOf(liveKey)?.cwd ?? "" })} onError={onError} />
        </>}
        {!split && sel && !detail && !showChat && (() => {
          // The transcript lives on another Mac: when that Mac is off the tailnet the read cannot
          // succeed, and the message should say so instead of promising a retry.
          const away = selHost ? offlineHosts.find((h) => h.id === selHost || h.name === selHost) : undefined;
          return <EmptyView icon="chat" title={busy ? t("读取对话记录…") : t("暂时读不到这段会话")} description={busy ? undefined : away ? t("这段会话在 {host} 上，现在连不上那台电脑（它的 Tailscale 离线或在睡眠）；等它上线后会自动读到。", { host: away.name }) : loadError ? t("暂时读不到会话，正在重试。") : undefined} actions={<button className="btn sm" onClick={() => setSel(null)}>{t("返回会话列表")}</button>} />;
        })()}
        {!split && detail && (() => {
          const m = detail.meta; const l = liveOf(m.session_id, m.host ?? "local");
          const linked = issues.filter(i => linkedSessions(i).includes(m.session_id));
          const related = linked;
          const results = outcomes.filter(i=>linkedSessions(i).includes(m.session_id));
          const mentioned = Object.entries(m.tasks).filter(([id]) => !related.some(i => i.id === id));
          const src = sourceLabel(m.entrypoint, { live: l, activity: current, inApp: showChat });
          // A chat started in Dispatch gets its short name a few seconds in (chatd asks the summary model): the activity row has it first.
          const title = displayTitle(current?.title_override || m.title, m.first_prompt || current?.first_prompt, !showChat && isScriptSession({ ...m, app: current?.app, runner: current?.runner })) || t("（无标题）");
          const proj = m.project_override || m.project || UNGROUPED_PROJECT;
          const errs = <>{handoverErr && <span className="sh-err" role="alert">{handoverErr}</span>}{(activityError || loadError) && <span className="sh-err" role="status">{t("更新中断，保留上次记录")}</span>}</>;
          const more = (
              <details className="sess-more" key={m.session_id}>
                <summary className="hd-icon" title={t("会话操作和信息")} aria-label={t("会话操作和信息")}><Icon name="more" /></summary>
                <div className="sess-more-pop">
                  <div className="acts">
                    {!solo && <button className="btn sm" onClick={() => startSplit(2)} title={t("分屏：这段会话放左边，再从列表选一段放右边，一起看")}><Icon name="grid" size={14} />{t("分屏")}</button>}
                    {!NO_RESUME.has(m.agent) && <button className="btn sm" onClick={() => copy(m.resume_cmd)} title={m.resume_cmd}><Icon name="copy" size={14} />{t("复制恢复命令")}</button>}
                    <button className="btn sm" onClick={() => api.copy(m.session_id).then(() => onDone(t("已复制")))}><Icon name="copy" size={14} />{t("复制会话 ID")}</button>
                    {closeChat && current && heldOpen(current) && <button className="btn sm" onClick={() => void closeChat(current)} title={t("结束 Dispatch 里这个会话的进程，后台不再留着；记录还在，再打开能续上")}><Icon name="x" size={14} />{t("关掉后台会话")}</button>}
                    {current && <WhereItem api={api} where={toggleWhere(api, current, whereOf(current))} session={{ agent: m.agent, session_id: m.session_id, cwd: m.cwd }} busy={running} className="btn sm" />}
                  </div>
                  {current?.summary && <div className="sum"><b>{t("总结")}</b><Linkified text={current.summary} /></div>}
                  <div className="sess-meta kv">
                  <b>{t("目录")}</b><span className="mono">{tildePath(m.cwd)}{m.branch ? ` · ${m.branch}` : ""}</span>
                  <b>{t("会话 ID")}</b><span className="mono">{m.session_id}</span>
                  <b>{t("开始")}</b><span className="mono">{m.first_ts ? fmtTime(m.first_ts) : "?"}</span>
                  <b>{t("最近")}</b><span className="mono">{m.last_ts ? `${fmtTime(m.last_ts)}（${ago(m.last_at)}）` : "?"}</span>
                  <b>{t("来源")}</b><span>{src || m.entrypoint || "?"}{l && l.source_app !== src ? ` · ${l.source_app}` : ""}<span className={`host-chip${m.remote ? "" : " local"}`}>{m.remote ? m.host_name : (localHostName || t("本机"))}</span></span>
                  <b>{t("对话")}</b><span>{t("{n} 轮", { n: m.user_msgs })} · {t("{n} 次回复", { n: m.assistant_msgs })} · {(m.size / 1e6).toFixed(1)} MB</span>
                  <b>{t("工具")}</b><span className="mono small">{Object.entries(detail.tool_counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ") || t("无")}</span>
                  {m.subagents.length > 0 && (<><b>{t("子 Agent")}</b><span className="subs">{m.subagents.map((s) => <span key={s.agent_id} className="sub-chip" title={s.path}>↳ <b>{s.type}</b> {s.description}<span className="muted mono"> · {(s.size / 1e3).toFixed(0)} KB</span></span>)}</span></>)}
                  </div>
                </div>
              </details>
          );
          return (
            <>
              {/* The window header carries the title and the project chip, as on the Agent page; the page keeps its own line only in a split pane or on the phone. */}
              {inShell ? <ShellHead header={{ title, chips: proj !== UNGROUPED_PROJECT ? [proj] : [], actions: <>{errs}<MovedChip r={chipOf(m)} />{more}{listToggle}</> }}
                deps={[m.session_id, title, proj, listHidden, handoverErr, !!(activityError || loadError), current?.summary, !!(closeChat && current && heldOpen(current)), current?.runner, running, locale]} /> : <>
              {/* One line, the way design/conversation-cursor has it: project / title, the state, and the rest behind ⋯. */}
              <div className="sess-head">
                {listToggle}
                {!solo && phone && onBack && <button className="dlink sess-back" onClick={onBack.go} title={t("回到{where}", { where: onBack.label })}>‹ {onBack.label}</button>}
                {(() => { const proj = m.project_override || m.project || UNGROUPED_PROJECT; const name = proj === UNGROUPED_PROJECT ? t(proj) : proj; return <>
                  {onProject && proj !== UNGROUPED_PROJECT ? <button className="dlink sh-proj" onClick={() => onProject(proj)} title={t("回到项目 {name}：回顾、任务、文档都在那里", { name: proj })}>{name}</button> : <span className="sh-proj">{name}</span>}
                </>; })()}
                <span className="d-sep">/</span>
                <h2 className="ttl" title={title}>{title}</h2>
                {(() => {
                  // Where it runs, for the state pill's tooltip: which Mac, started from where.
                  const where = [m.remote ? m.host_name : (localHostName || t("本机")), src].filter(Boolean).join(" · ");
                  return current?.waiting === "dialog" ? <Tag color="orange" dot title={where}>{t("等你确认")}</Tag> : running ? <Tag color="green" dot title={where}>{t("在跑")}</Tag> : current?.unread ? <Tag color="blue" title={where}>{t("未读")}</Tag> : m.remote ? <Tag title={where}>{m.host_name}</Tag> : null;
                })()}
                <MovedChip r={chipOf(m)} />
                <span className="sp" />
                <span className="sh-stats">{t("{n} 轮", { n: m.user_msgs })} · {t("{n} 次调用", { n: detail.messages.reduce((s, x) => s + x.tools.length, 0) })}</span>
                {errs}
                {more}
              </div>
              </>}
              <Tabs<typeof tab> value={tab} onChange={setTab} items={[
                { key: "timeline", label: t("对话") },
                { key: "attachments", label: t("图片与产物"), count: detail.attachments?.length || 0 },
                { key: "files", label: t("文件"), count: detail.files.length, title: t("这段会话改过的文件；目录里其他改动折在下面") },
                { key: "tasks", label: t("任务与成果"), count: related.length + results.length },
                ...(m.subagents.length > 0 ? [{ key: "subagents" as const, label: t("子 Agent"), count: m.subagents.length }] : []),
              ]} right={tab === "timeline" ? (() => {
                const nT = detail.messages.reduce((s, x) => s + x.tools.length, 0);
                return (
                  <span className="kinds" title={t("怎么看这段对话")}>
                    <button className={brief ? "on" : ""} aria-pressed={brief} onClick={toggleBrief} title={t("只显示你的问题和每一轮最后的回复，不看思考和工具调用")}>{t("只看结论")}</button>
                    <button className={kinds.tool ? "on" : ""} aria-pressed={kinds.tool} disabled={brief} onClick={() => flip("tool")} title={t("显示或隐藏工具调用卡片（正在运行的总会显示）")}>{t("工具调用")}<span className="n">{nT}</span></button>
                  </span>
                );
              })() : undefined} />
              {tab === 'timeline' && showChat && liveKey ? <ChatPage key={liveKey} api={api} session={liveKey} detail={detail} activity={current} hosts={hosts} issues={issues} sessions={mentionSessions}
                onHandover={() => void takeOver({ agent: m.agent, session_id: m.session_id, cwd: m.cwd })} onError={onError} /> : <>
              <div className="sess-body" tabIndex={0} aria-label={t("会话内容")} ref={scroller} onScroll={e => { if (tab !== 'timeline') return; const el = e.currentTarget; timelineScroll.current = el.scrollTop; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24; follow.current = bottom; setAtLatest(bottom); }}>
                {tab === "timeline" && <SessionThread list={shownTurns} running={running} cwd={m.cwd} />}
                {tab === "timeline" && <ToLatest show={!atLatest} unread={!!current?.unread} onClick={latest} />}
                {tab === "subagents" && (() => {
                  // Who this conversation handed work to: sub-agents from the transcript, plus the
                  // Agent/Task tool calls that dispatched them, in order.
                  const calls = detail.messages.flatMap((x) => blocksOf(x).filter((b) => b.type === "tool_call" && /^(Agent|Task|agent|task)$/.test(b.name)).map((b) => ({ ts: x.ts, summary: b.type === "tool_call" ? b.summary : "" })));
                  return <div className="subagent-view">
                    <p className="muted small">{t("这段会话派出的子 Agent。每个子 Agent 是一段独立的对话，只把结果交回来。")}</p>
                    {[...m.subagents].sort((x, y) => Number(!!y.running) - Number(!!x.running) || y.last_at - x.last_at).map((s) => <button key={s.agent_id} className={`subagent-row opens${s.running ? " running" : ""}`} onClick={() => setSubView(s)} title={s.running ? t("还在跑：两分钟内还在写记录；点开看它做到哪了") : t("点开看这个子 Agent 的完整对话")}><span className="sub-type">{s.type}</span><div><div className="t">{s.running && <span className="st sm prog"><span className="pulse" />{t("在跑")}</span>}{s.description || t("（无描述）")}</div><div className="muted small mono">{s.last_at ? fmtTime(new Date(s.last_at * 1000).toISOString()) : ""} · {(s.size / 1e3).toFixed(0)} KB · {t("深度 {n}", { n: s.depth })}</div></div><span className="muted">›</span></button>)}
                    {calls.length > 0 && <details><summary>{t("派发调用")} · {calls.length}</summary>{calls.map((c, i) => <div key={i} className="subagent-call"><span className="mono muted small">{c.ts ? fmtTime(c.ts) : ""}</span><span>{c.summary}</span></div>)}</details>}
                  </div>;
                })()}
                {tab === "attachments" && <AttachmentList items={detail.attachments || []} />}
                {tab === "files" && <h3 className="recorded-files-title">{t("这段会话改过的文件")} <span className="muted">{detail.files.length}</span></h3>}
                {tab === "files" && detail.files.length === 0 && <p className="muted">{t("没有记录到编辑类工具调用；用终端命令改的文件看下方「目录里现在的 git 改动」。")}</p>}
                {tab === "files" && detail.files.map((f) => (
                  <details key={f.path} className="fdiff" open={detail.files.length <= 3}>
                    <summary><span className="mono">{tildePath(f.path)}</span><span className="muted"> · {t("{n} 处", { n: f.changes.length })}</span></summary>
                    <FileHunks changes={f.changes} />
                  </details>
                ))}
                {tab === "files" && detail.workspace && <details className="workspace-diff sec context-fold"><summary>{t("目录里现在的 git 改动")} <span className="muted">{t("{n} 个文件 · 同目录所有会话（不只这一段）", { n: detail.workspace.total ?? detail.workspace.files.length })}</span></summary><p className="muted small">{detail.workspace.root} · {t("包含暂存和未暂存内容。")}</p>{detail.workspace.unavailable ? <p className="muted">{t("当前目录无法读取 Git 改动")}</p> : detail.workspace.files.length === 0 ? <p className="muted">{t("工作区没有未提交改动")}</p> : (() => {
                  // One unified diff for the whole workspace, split per file so each path opens its own hunk.
                  const byFile = new Map<string, string>();
                  for (const chunk of detail.workspace.patch.split(/^(?=diff --git )/m)) { const m = /^diff --git a\/(.+?) b\//.exec(chunk); if (m) byFile.set(m[1], chunk); }
                  const stat = (t: string) => { let add = 0, del = 0; for (const ln of t.split('\n')) { if (ln.startsWith('+') && !ln.startsWith('+++')) add++; else if (ln.startsWith('-') && !ln.startsWith('---')) del++; } return { add, del }; };
                  return <><div className="changed-files">{detail.workspace!.files.map(f => { const patch = byFile.get(f.path); const s = patch ? stat(patch) : null; return <details key={f.path} data-menu="file" data-id={f.path} className="fdiff file"><summary><span className={`st sm ${f.untracked ? 'rev' : 'prog'}`}>{f.untracked ? t('新增') : t('修改')}</span><code>{f.path}</code>{s && <span className="mono small diffstat"><span className="add">+{s.add}</span> <span className="del">−{s.del}</span></span>}</summary>{patch ? <PatchDiff text={patch} /> : <p className="muted small">{f.untracked ? t('新文件，git 还没有它的差异；打开文件查看。') : t('这个文件的差异不在当前补丁里。')}</p>}</details>; })}</div>{detail.workspace!.truncated && <p className="muted">{t('差异过长，仅展示前 100 KB')}</p>}</>;
                })()}</details>}
                {tab === "tasks" && <>
                  <h3 className="recorded-files-title">{t("这个会话关联的任务")}</h3>
                  {related.length === 0 && <p className="muted">{t("没有明确关联的任务，可在项目的“待归属任务”中指定")}</p>}
                  <div className="task-links">{related.map(i => <button key={i.id} className="chip" onClick={() => onSelectTask(i.id)}><span>{i.title}</span><span className="st sm">{statusLabel(i).text}</span><AcTally issue={i} /></button>)}</div>
                  {results.map(r=><article className="outcome-card" key={r.id}><h3>{t("成果")} · {r.title}</h3><Markdown src={r.description||""}/></article>)}
                  {mentioned.length > 0 && <details className="mentioned-tasks"><summary>{t("对话中还提及过 {n} 个任务", { n: mentioned.length })}</summary><p className="muted small">{t("提及过的任务不代表由这个会话负责。")}</p><div className="task-links">{mentioned.sort((x,y) => y[1]-x[1]).map(([id,n]) => <button key={id} className="chip" onClick={() => onSelectTask(id)}><span>{issues.find(i => i.id === id)?.title ?? id}</span><span className="muted">{t("{n} 次提及", { n })}</span></button>)}</div></details>}
                </>}
              </div>
              {!foldedCopy && selRef?.copies?.map((c) => <div key={c.host} className="moved-copy-note"><button className="dlink" onClick={() => setSel(c.host === "local" ? selSid! : `${selSid}@${c.host}`)}>{t("迁移前的副本 · 已迁到 {name}", { name: c.moved_to_name ?? selRef.host_name ?? localHostName ?? "" })}</button><span className="muted">{t("{host} 上还留着，最后 {time}，只读", { host: c.host_name ?? c.host, time: relTime(new Date(c.last_at * 1000).toISOString()) })}</span></div>)}
              {(() => {
                // The original of a moved conversation is read-only: folded under the copy that went on, or
                // alone (the other Mac offline) while neither running nor gone on after the move.
                const c: { moved_to_name?: string; twin_live?: string[]; forked?: string[] } = chipOf(m);
                const movedTo = foldedCopy ? c.moved_to_name ?? "" : !running && !c.twin_live?.length && !c.forked?.length ? c.moved_to_name ?? "" : "";
                return movedTo || foldedCopy
                  ? <div className="moved-copy-note">{t("迁移前的副本 · 已迁到 {name}。这里只能看记录，接着做请到 {name} 上的那份。", { name: movedTo })}{foldedCopy && liveRowKey && <button className="dlink" onClick={() => setSel(liveRowKey)}>{t("打开接着做的那份")}</button>}</div>
                  : <SessionReply key={`${m.host || 'local'}:${m.agent}:${m.session_id}`} api={api} session={m} messages={detail.messages} hostName={localHostName} working={running} onSent={() => { setTab('timeline'); latest(); }} />;
              })()}
              </>}
            </>
          );
        })()}
      </div>
    </div>{subView && detail && <SubagentDialog api={api} parent={detail.meta} sub={subView} onClose={() => setSubView(null)} />}</MediaProvider>
  );
}
