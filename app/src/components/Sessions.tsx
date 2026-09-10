import { linkedSessions } from "../projectModel";
import { MediaProvider, AttachmentList } from "./Media";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api";
import { ago, actorOf, fmtTime, statusLabel, NO_RESUME, projectColor, relTime } from "../derive";
import { PairDiff, PatchDiff } from "./Diff";
import { canReadReply, activityLabel, isScriptSession, sessionLifecycle , activityLine } from "../activity";
import type { Activity, FileChange, Issue, Session, SessionDetail, SessionRef, SessionTail, TimelineMsg } from "../types";
import { SessionThread } from "./SessionThread";
import { blocksOf, currentStep, mergeTail, visibleTurns } from "../timeline";
import { Avatar } from "./ui";
import { Markdown, Linkified } from "./Markdown";
import { OpenSessionButton, AdoptButton } from "./SessionActions";
import { ConversationMenuButton } from "./ConversationActions";
import { SessionReply } from "./SessionReply";
import { SessionQuestion, pendingQuestion } from "./SessionQuestion";

interface Props { archivedProjects: Set<string>; refs: SessionRef[]; scriptCount: number; refsLoaded: boolean; archiveDays: number; outcomes: Issue[]; activities: Activity[]; issues: Issue[]; activityError: boolean; onSeen: (a: Activity, reply: string) => Promise<void>; api: Api; me: string; live: Session[]; onSelectTask: (id: string) => void; onSelected?: (id: string | null) => void; onDone: (m: string) => void; onError: (m: string) => void; initialId?: string | null; hostId?: string }

const ENTRY: Record<string, string> = { cli: "终端", desktop: "桌面端", sdk: "SDK", "vscode-extension": "VS Code" };

// The conversation itself, one block per turn (thinking folded, tool cards, text). Shared by the
// session page and the sub-agent viewer.
export function ChatList({ list, name, showTools, running }: { list: TimelineMsg[]; name: string; showTools: boolean; running?: boolean }) {
  const shown = useMemo(() => visibleTurns(list, { brief: false, showTools, showUser: true, showAssistant: true, running: !!running }), [list, showTools, running]);
  return <SessionThread list={shown} name={name} running={!!running} />;
}

// A sub-agent's own transcript, opened from the parent's 子 Agent tab. The prompt it was
// given is its first "user" turn; its final report is the last assistant text.
export function SubagentDialog({ api, parent, sub, onClose }: { api: Api; parent: SessionRef; sub: SessionRef["subagents"][number]; onClose: () => void }) {
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
    <div className="media-dialog subagent-dialog" role="dialog" aria-modal="true" aria-label="子 Agent 对话">
      <header><span className="sub-type">{sub.type || "子 Agent"}</span><b>{sub.description || sub.agent_id}</b><span className="muted small mono">{(sub.size / 1e3).toFixed(0)} KB · 深度 {sub.depth}</span><span className="spacer" />
        <span className="views xs"><button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>对话</button><button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")} disabled={!d?.files.length}>文件 {d?.files.length ?? 0}</button></span>
        <button className={`chip${tools ? " on" : ""}`} onClick={() => setTools(!tools)} title="显示或隐藏工具调用">工具调用 <span className="mono muted">{nT}</span></button>
        <button className="btn sm" autoFocus onClick={onClose} aria-label="关闭">✕</button></header>
      <MediaProvider api={api} session={{ agent: parent.agent, session_id: `${parent.session_id}/sub/${sub.agent_id}`, host: parent.host }}>
        <div className="media-content subagent-body">
          {err && <p className="err">{err}</p>}
          {!d && !err && <div className="empty small">读子 Agent 的记录中…</div>}
          {d && tab === "chat" && <ChatList list={list} name={sub.type || "子 Agent"} showTools={tools} />}
          {d && tab === "files" && d.files.map((f) => <details key={f.path} className="fdiff" open={d.files.length <= 3}><summary><span className="mono">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span><span className="muted"> · {f.changes.length} 处</span></summary><FileHunks changes={f.changes} /></details>)}
        </div>
      </MediaProvider>
    </div>
  </div>;
}

// One file's recorded edits, as diffs. Shared by the session files tab and the task detail.
export function FileHunks({ changes }: { changes: FileChange[] }) {
  return <>{changes.map((c, i) => {
    const lines = (c.new || "").split("\n").length;
    // One fold per file is enough (the file's own <details>); the hunk itself stays open.
    const head = <div className="hunk-h muted small">{c.kind === "write" ? `写入整个文件 · ${lines} 行` : c.kind === "patch" ? `${c.op ?? "修改"}${c.add !== undefined ? ` · +${c.add} −${c.del ?? 0}` : ""}` : "编辑"}{c.ts ? ` · ${fmtTime(c.ts)}` : ""}</div>;
    const body = c.kind === "patch"
      ? (c.new ? <PatchDiff text={c.new} /> : <pre className="diff"><div className="skip">补丁内容没存下来</div></pre>)
      : <PairDiff oldText={c.old} newText={c.new} label={c.kind === "write" ? "行号 = 文件行号" : "行号相对本段"} />;
    return <div key={i} className="hunk">{head}{body}</div>;
  })}</>;
}

export function SessionsView({ archivedProjects, refs, scriptCount, refsLoaded: loaded, archiveDays, activities, issues, outcomes, activityError, onSeen, api, me, live, onSelectTask, onSelected, onDone, onError, initialId, hostId }: Props) {
  const showScripts = false; // script-launched sessions live under 定时或脚本
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [mode, setMode] = useState<"active" | "starred" | "archived" | "scheduled">("active");
  const host = hostId ?? "";
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  useEffect(() => { onSelected?.(sel); }, [sel]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<"timeline" | "files" | "tasks" | "attachments" | "subagents">("timeline");
  const [subView, setSubView] = useState<SessionRef["subagents"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Which kinds of turns to show. Tools off by default: the conversation is the point.
  const [kinds, setKinds] = useState<Record<"user" | "assistant" | "tool", boolean>>(() => { try { return { user: true, assistant: true, tool: false, ...JSON.parse(localStorage.getItem("dispatch-tl-kinds") || "{}") }; } catch { return { user: true, assistant: true, tool: false }; } });
  const flip = (k: "user" | "assistant" | "tool") => { const v = { ...kinds, [k]: !kinds[k] }; setKinds(v); try { localStorage.setItem("dispatch-tl-kinds", JSON.stringify(v)); } catch { /* ignore */ } };
  // 只看结论: your messages plus the last reply of each turn, nothing in between.
  const [brief, setBrief] = useState<boolean>(() => { try { return localStorage.getItem("dispatch-tl-brief") === "1"; } catch { return false; } });
  const toggleBrief = () => { setBrief((b) => { try { localStorage.setItem("dispatch-tl-brief", b ? "0" : "1"); } catch { /* ignore */ } return !b; }); };
  // 实时活动: the tracker's event log docked above the conversation. Off by default — the folded
  // "跑了 N 条命令" lines in the thread already say what happened; the chip turns the strip on.
  const [liveLog, setLiveLog] = useState<boolean>(() => { try { return localStorage.getItem("dispatch-tl-live") === "1"; } catch { return false; } });
  // On a phone the summary and the activity strip start folded to one line: the conversation gets the screen.
  const phone = typeof window !== "undefined" && window.innerWidth <= 760;
  const [summaryOpen, setSummaryOpen] = useState(!phone);
  const [dockOpen, setDockOpen] = useState(!phone);
  const toggleLiveLog = () => { setLiveLog((b) => { try { localStorage.setItem("dispatch-tl-live", b ? "0" : "1"); } catch { /* ignore */ } return !b; }); };

  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const timelineScroll = useRef(0);
  const [atLatest, setAtLatest] = useState(true);
  const [isVisible, setIsVisible] = useState(document.visibilityState === 'visible');
  const current = activities.find(a => a.session_id === sel);
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
    let alive = true; let timer = 0;
    setBusy(true); setDetail(null); setLoadError(false); follow.current = true; setAtLatest(true);
    const refresh = async () => {
      if (document.visibilityState === 'visible') {
        try { const d = await api.sessionDetail(sel); if (alive) { setDetail(d); setLoadError(false); } }
        catch { if (alive) setLoadError(true); }
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
          if (alive && t.partial) setDetail((prev) => (prev ? mergeTail(prev, t) : prev));
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

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const all = new Map(refs.map(r => [r.session_id, r]));
    for (const a of activities) {
      const old = all.get(a.session_id);
      all.set(a.session_id, old ? { ...old, last_at: a.last_at, scheduled: old.scheduled || a.scheduled, starred: old.starred || a.starred, archived: old.archived || a.archived } : { ...a, first_ts: '', last_ts: '', entrypoint: '', branch: '', user_msgs: 0, assistant_msgs: 0, tools: {}, tasks: Object.fromEntries(a.tasks.map(t => [t, 1])), mentions: 0, current_task: null, resume_cmd: '', path: '', size: 0, subagents: [] });
    }
    const inMode = (r: SessionRef) => { if (mode === "scheduled") return !!r.scheduled || isScriptSession(r); if (!showScripts && isScriptSession(r)) return false; if (r.scheduled) return false; const life = archivedProjects.has(r.project_override || r.project) ? "archived" : sessionLifecycle(r, archiveDays); return mode === "archived" ? life === "archived" : mode === "starred" ? life === "starred" : life !== "archived"; };
    return [...all.values()].sort((a,b) => Number(!!b.starred) - Number(!!a.starred) || b.last_at - a.last_at).filter((r) => inMode(r) && (!agent || r.agent === agent) && (!host || (r.host ?? "local") === host) && (!qq || (r.title || "").toLowerCase().includes(qq) || r.cwd.toLowerCase().includes(qq) || r.session_id.startsWith(qq) || Object.keys(r.tasks).some((t) => t.includes(qq))));
  }, [refs, showScripts, activities, q, agent, host, mode, archiveDays, archivedProjects]);
  // The menu wants the conversation shape; a catalog row becomes one with the same identity.
  const asActivity = (r: SessionRef): Activity => activities.find((a) => a.session_id === r.session_id && (a.host ?? "local") === (r.host ?? "local")) ?? ({ ...r, key: `${r.agent}:${r.session_id}`, tasks: Object.keys(r.tasks || {}), state: "unknown", stale: true, unread: false, activity: "", version: "", events: [], tracking_since: 0, source: "catalog" } as Activity);
  const counts = useMemo(() => { const seen = new Map<string, SessionRef | Activity>(); for (const r of [...refs, ...activities]) if (!seen.has(r.session_id)) seen.set(r.session_id, r); const all = [...seen.values()]; const life = (r: SessionRef | Activity) => archivedProjects.has(r.project_override || r.project) ? "archived" : sessionLifecycle(r, archiveDays); return { scheduled: all.filter((r) => r.scheduled).length, starred: all.filter((r) => !r.scheduled && life(r) === "starred").length, archived: all.filter((r) => !r.scheduled && life(r) === "archived").length }; }, [refs, activities, archiveDays, archivedProjects]);

  const liveOf = (id: string) => live.find((s) => s.session_id === id);
  const copy = async (cmd: string) => { try { await api.copy(cmd); onDone("恢复命令已复制，去终端粘贴回车"); } catch (e) { onError(String(e)); } };
  useItemMenu("file", (rel) => {
    const root = detail?.workspace?.root;
    if (!root) return null;
    const full = `${root.replace(/\/$/, "")}/${rel}`;
    return { title: rel, items: [
      { label: "打开文件", onClick: () => api.openPath(full).catch((e) => onError(String(e))) },
      { label: "在访达中打开", onClick: () => api.openPath(full.replace(/\/[^/]+$/, "")).catch((e) => onError(String(e))) },
      { label: "复制路径", onClick: () => api.copy(full).then(() => onDone("路径已复制")) },
      { label: "复制相对路径", onClick: () => api.copy(rel).then(() => onDone("已复制")) },
    ] };
  }, [detail?.workspace?.root, api]);
  useViewMenuExtras(detail ? [
    { label: "复制恢复命令", onClick: () => void copy(detail.meta.resume_cmd) },
    { label: "复制会话 ID", onClick: () => api.copy(detail.meta.session_id).then(() => onDone("已复制")) },
  ] : [], [detail?.meta.session_id]);

  return (
    <MediaProvider api={api} session={detail?.meta}><div className={`sess-wrap${sel ? " has-selection" : ""}`}>
      <div className="sess-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="标题、目录、任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views session-modes" style={{ marginTop: 6 }}>
            <button className={mode === "active" ? "on" : ""} onClick={() => setMode("active")}>最近</button>
            <button className={mode === "starred" ? "on" : ""} onClick={() => setMode("starred")} title="收藏的会话：长期追踪，不会自动归档">★ 追踪中 {counts.starred}</button>
            <button className={mode === "archived" ? "on" : ""} onClick={() => setMode("archived")} title={`手动归档，或超过 ${archiveDays} 天没有活动`}>已归档 {counts.archived}</button>
            {(counts.scheduled > 0 || scriptCount > 0) && <button className={mode === "scheduled" ? "on" : ""} onClick={() => setMode("scheduled")} title="不是你在终端里开的：定时任务、脚本或别的 Agent 通过程序接口启动的会话">定时或脚本 {Math.max(counts.scheduled, scriptCount)}</button>}
          </div>
          <div className="sess-filter-row">
            <select className="sess-agent" aria-label="按 Agent 筛选" value={agent} onChange={(e) => setAgent(e.target.value)} title="按 Agent 筛选">{[["", "全部 Agent"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["pi", "pi"], ["zcode", "ZCode"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <span className="muted small" title="当前筛选下的会话数">{items.length} 条</span>
          </div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">索引中…（首次要读完全部历史）</div>}
          {loaded && items.length === 0 && <div className="empty">{mode === "archived" ? `没有归档的会话（${archiveDays} 天没有活动的会自动归到这里）` : mode === "starred" ? "还没有收藏的会话。右键一条会话，选「收藏：长期追踪」。" : "没有匹配的会话"}</div>}
          {(() => { const isBlank = (r: SessionRef) => !r.title && r.user_msgs <= 1 && !r.starred && !activities.some((a) => a.session_id === r.session_id && (a.unread || (a.state === "working" && !a.stale))); const named = items.filter((r) => !isBlank(r)); const blank = items.filter(isBlank); const item = (r: SessionRef) => {
            const a = actorOf(r.agent, me);
            const l = liveOf(r.session_id);
            const active = activities.find(a => a.session_id === r.session_id);
            return (
              <div key={r.session_id} data-session={`${r.host ?? "local"}:${r.agent}:${r.session_id}`} className={`sess-item${sel === r.session_id ? " sel" : ""}`}><button className="sess-item-main" onClick={() => { setSel(r.session_id); setTab("timeline"); }}>
                <div className="l1"><Avatar actor={a} />{r.starred && <span className="star on" title="追踪中">★</span>}<span className="t">{r.title || "（无标题）"}</span>{active?.unread && <span className="unread-dot" title="未读回复" />}{l && !active && <span className={`st sm ${l.state === "working" ? "prog" : "done"}`}>{l.state === "working" ? "在跑" : "开着"}</span>}</div>
                <div className="l2"><span className="proj" style={{ background: projectColor(r.project) }} />{r.project || "?"}{r.remote && <span className="host-chip">{r.host_name}</span>}<span className="muted">{(ENTRY[r.entrypoint] ?? r.entrypoint) ? `· ${ENTRY[r.entrypoint] ?? r.entrypoint} ` : ""}· {r.user_msgs} 轮{r.subagents.length ? ` · ${r.subagents.length} 子` : ""}</span><span className="ago mono">{relTime(new Date(r.last_at * 1000).toISOString())}</span></div>
                {active && activityLine(active) && <div className="l3 activity-text">{activityLine(active)}</div>}
                {(() => { const own = issues.filter(i => linkedSessions(i).includes(r.session_id) && i.status !== "closed"); return own.length ? <div className="l3 linked-tasks"><span className="mono">{own[0].id}</span> {own[0].title}{own.length > 1 ? ` · 还有 ${own.length - 1} 项` : ""}</div> : null; })()}
              </button><div className="sess-item-actions touch-only"><ConversationMenuButton a={asActivity(r)} /></div></div>
            );
          }; return <>{named.map(item)}{blank.length > 0 && <details className="sess-blank"><summary className="muted small">零散会话 · {blank.length}<span> · 没有标题、最多一句话</span></summary>{blank.map(item)}</details>}</>; })()}
        </div>
      </div>

      <div className="sess-main">
        {!sel && <div className="empty">选一个会话。这里能看到它做了什么、改了哪些文件、派了哪些子 Agent，以及怎么恢复它。</div>}
        {sel && !detail && <div className="empty">{busy ? "读取对话记录…" : loadError ? "暂时读不到会话，正在重试。" : ""}<button className="link" onClick={() => setSel(null)}>返回会话列表</button></div>}
        {detail && (() => {
          const m = detail.meta; const a = actorOf(m.agent, me); const l = liveOf(m.session_id);
          const linked = issues.filter(i => linkedSessions(i).includes(m.session_id));
          const related = linked;
          const results = outcomes.filter(i=>linkedSessions(i).includes(m.session_id));
          const mentioned = Object.entries(m.tasks).filter(([id]) => !related.some(i => i.id === id));
          return (
            <>
              <div className="sess-head">
                <button className="btn sm session-back" onClick={() => setSel(null)}>‹ 会话</button>
                <Avatar actor={a} size={28} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ttl">{m.title || "（无标题）"}</div>
                  <div className="sub mono">{m.cwd}{m.branch ? ` · ${m.branch}` : ""} · {m.session_id}</div>
                </div>
                {l && <AdoptButton session={l} compact />}
                <OpenSessionButton session={m} />
                {!NO_RESUME.has(m.agent) && <button className="btn sm desktop-session-action" onClick={() => copy(m.resume_cmd)} title={m.resume_cmd}>复制恢复命令</button>}
                <details className="session-actions-menu"><summary aria-label="会话操作">⋯</summary><div>
                  {!NO_RESUME.has(m.agent) && <button className="btn sm" onClick={() => copy(m.resume_cmd)}>复制恢复命令</button>}
                </div></details>
              </div>
              {current?.summary && <div className={`session-summary${summaryOpen ? "" : " folded"}`} title={summaryOpen ? "模型写的总结：目标、做了什么、还差什么" : "点开看完整总结"} onClick={() => setSummaryOpen((o) => !o)}><span className="conversation-caption">总结</span><span className="t"><Linkified text={current.summary} /></span></div>}
              {(current || activityError || loadError) && <div className={`session-live${activityError || loadError ? ' interrupted' : ''}`}><span className={`live-dot${current?.state === 'working' && !current.stale ? ' running' : ''}`} /><div><strong>{activityError || loadError ? '更新中断，保留上次记录' : current ? activityLabel(current) : '历史记录'}</strong><span>{current?.activity}</span>{running && (() => { const st = currentStep(detail.messages); return st.kind === 'idle' ? null : <span className="live-step small">{st.kind === 'tool' ? `正在调用 ${st.name}…` : st.kind === 'text' ? '正在回复…' : '思考中…'}</span>; })()}</div><span className="muted small">{current ? (ago(current.last_at)) : ''}</span></div>}
              <details className="session-context" key={m.session_id}>
                <summary>{m.user_msgs} 轮对话 · {m.subagents.length} 个子 Agent<span>会话信息</span></summary>
                <div className="sess-meta kv">
                <b>开始</b><span className="mono">{m.first_ts ? fmtTime(m.first_ts) : "?"}</span>
                <b>最近</b><span className="mono">{m.last_ts ? `${fmtTime(m.last_ts)}（${ago(m.last_at)}）` : "?"}</span>
                <b>来源</b><span>{ENTRY[m.entrypoint] ?? m.entrypoint ?? "?"}{l ? ` · ${l.source_app}` : ""}{m.remote && <span className="host-chip">{m.host_name}</span>}</span>
                <b>对话</b><span>{m.user_msgs} 轮 · {m.assistant_msgs} 次回复 · {(m.size / 1e6).toFixed(1)} MB</span>
                <b>工具</b><span className="mono small">{Object.entries(detail.tool_counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</span>
                {m.subagents.length > 0 && (<><b>子 Agent</b><span className="subs">{m.subagents.map((s) => <span key={s.agent_id} className="sub-chip" title={s.path}>↳ <b>{s.type}</b> {s.description}<span className="muted mono"> · {(s.size / 1e3).toFixed(0)} KB</span></span>)}</span></>)}
                </div>
              </details>
              <div className="views session-tabs">
                <button className={tab === "timeline" ? "on" : ""} onClick={() => setTab("timeline")}>对话</button>
                <button className={tab === "attachments" ? "on" : ""} onClick={() => setTab("attachments")}>图片与产物 {detail.attachments?.length || 0}</button>
                <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")} title="这段会话改过的文件；目录里其他改动折在下面">文件 {detail.files.length}</button>
                <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>任务与成果 {related.length + results.length}</button>
                {m.subagents.length > 0 && <button className={tab === "subagents" ? "on" : ""} onClick={() => setTab("subagents")}>子 Agent {m.subagents.length}</button>}
                {tab === "timeline" && (() => {
                  const nT = detail.messages.reduce((s, x) => s + x.tools.length, 0);
                  return (
                    <span className="kinds" title="怎么看这段对话">
                      <button className={`chip${brief ? " on" : ""}`} onClick={toggleBrief} title="只显示你的问题和每一轮最后的回复，不看思考和工具调用">只看结论</button>
                      <button className={`chip${kinds.tool ? " on" : ""}`} disabled={brief} onClick={() => flip("tool")} title="显示或隐藏工具调用卡片（正在运行的总会显示）">工具调用 <span className="mono muted">{nT}</span></button>
                      {current && <button className={`chip${liveLog ? " on" : ""}`} onClick={toggleLiveLog} title="在对话上方显示 Agent 正在做的事：工具调用、回复、报错，最新在前">实时活动 <span className="mono muted">{current.events.filter((e) => e.kind !== "result").length}</span></button>}
                    </span>
                  );
                })()}
              </div>
              {tab === 'timeline' && current && liveLog && (() => {
                const ev = current.events.filter((e) => e.kind !== 'result').slice(-40).reverse();
                const label = (k: string) => k === 'error' ? '执行失败' : k === 'user' ? '你的消息' : k === 'reply' ? 'Agent 回复' : '进展';
                return <div className={`activity-dock${dockOpen ? "" : " folded"}`} aria-label="实时活动" onClick={() => setDockOpen((o) => !o)}>{ev.length === 0 ? <div className="muted small">还没有记录到活动</div> : ev.map((e) => <div key={e.id} className={`activity-event ${e.kind}`} title={e.text}><span className="muted mono small">{new Date(e.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</span><b>{e.kind === 'tool' ? e.tool : label(e.kind)}</b><span className="t">{e.text}</span></div>)}</div>;
              })()}
              {tab === 'timeline' && !atLatest && <button className="follow-latest" onClick={latest}>回到最新 ↓{current?.unread ? ' · 有未读回复' : ''}</button>}
              <div className="sess-body" tabIndex={0} aria-label="会话内容" ref={scroller} onScroll={e => { if (tab !== 'timeline') return; const el = e.currentTarget; timelineScroll.current = el.scrollTop; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24; follow.current = bottom; setAtLatest(bottom); }}>
                {tab === "timeline" && <SessionThread list={shownTurns} name={a?.name ?? m.agent} running={running} />}
                {tab === "subagents" && (() => {
                  // Who this conversation handed work to: sub-agents from the transcript, plus the
                  // Agent/Task tool calls that dispatched them, in order.
                  const calls = detail.messages.flatMap((x) => blocksOf(x).filter((b) => b.type === "tool_call" && /^(Agent|Task|agent|task)$/.test(b.name)).map((b) => ({ ts: x.ts, summary: b.type === "tool_call" ? b.summary : "" })));
                  return <div className="subagent-view">
                    <p className="muted small">这段会话派出的子 Agent。每个子 Agent 是一段独立的对话，只把结果交回来。</p>
                    {m.subagents.map((s) => <button key={s.agent_id} className="subagent-row opens" onClick={() => setSubView(s)} title="点开看这个子 Agent 的完整对话"><span className="sub-type">{s.type}</span><div><div className="t">{s.description || "（无描述）"}</div><div className="muted small mono">{s.last_at ? fmtTime(new Date(s.last_at * 1000).toISOString()) : ""} · {(s.size / 1e3).toFixed(0)} KB · 深度 {s.depth}</div></div><span className="muted">›</span></button>)}
                    {calls.length > 0 && <details><summary>派发调用 · {calls.length}</summary>{calls.map((c, i) => <div key={i} className="subagent-call"><span className="mono muted small">{c.ts ? fmtTime(c.ts) : ""}</span><span>{c.summary}</span></div>)}</details>}
                  </div>;
                })()}
                {tab === "attachments" && <AttachmentList items={detail.attachments || []} />}
                {tab === "files" && <h3 className="recorded-files-title">这段会话改过的文件 <span className="muted">{detail.files.length}</span></h3>}
                {tab === "files" && detail.files.length === 0 && <p className="muted">没有记录到编辑类工具调用；用终端命令改的文件看下方「目录里现在的 git 改动」。</p>}
                {tab === "files" && detail.files.map((f) => (
                  <details key={f.path} className="fdiff" open={detail.files.length <= 3}>
                    <summary><span className="mono">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span><span className="muted"> · {f.changes.length} 处</span></summary>
                    <FileHunks changes={f.changes} />
                  </details>
                ))}
                {tab === "files" && detail.workspace && <details className="workspace-diff sec context-fold"><summary>目录里现在的 git 改动 <span className="muted">{detail.workspace.files.length} 个文件 · 同目录所有会话（不只这一段）</span></summary><p className="muted small">{detail.workspace.root} · 包含暂存和未暂存内容。</p>{detail.workspace.unavailable ? <p className="muted">当前目录无法读取 Git 改动</p> : detail.workspace.files.length === 0 ? <p className="muted">工作区没有未提交改动</p> : (() => {
                  // One unified diff for the whole workspace, split per file so each path opens its own hunk.
                  const byFile = new Map<string, string>();
                  for (const chunk of detail.workspace.patch.split(/^(?=diff --git )/m)) { const m = /^diff --git a\/(.+?) b\//.exec(chunk); if (m) byFile.set(m[1], chunk); }
                  const stat = (t: string) => { let add = 0, del = 0; for (const ln of t.split('\n')) { if (ln.startsWith('+') && !ln.startsWith('+++')) add++; else if (ln.startsWith('-') && !ln.startsWith('---')) del++; } return { add, del }; };
                  return <><div className="changed-files">{detail.workspace!.files.map(f => { const t = byFile.get(f.path); const s = t ? stat(t) : null; return <details key={f.path} data-menu="file" data-id={f.path} className="fdiff file"><summary><span className={`st sm ${f.untracked ? 'rev' : 'prog'}`}>{f.untracked ? '新增' : '修改'}</span><code>{f.path}</code>{s && <span className="mono small diffstat"><span className="add">+{s.add}</span> <span className="del">−{s.del}</span></span>}</summary>{t ? <PatchDiff text={t} /> : <p className="muted small">{f.untracked ? '新文件，git 还没有它的差异；打开文件查看。' : '这个文件的差异不在当前补丁里。'}</p>}</details>; })}</div>{detail.workspace!.truncated && <p className="muted">差异过长，仅展示前 100 KB</p>}</>;
                })()}</details>}
                {tab === "tasks" && <>
                  <h3 className="recorded-files-title">这个会话关联的任务</h3>
                  {related.length === 0 && <p className="muted">没有明确关联的任务，可在项目的“待归属任务”中指定</p>}
                  <div className="task-links">{related.map(i => <button key={i.id} className="chip" onClick={() => onSelectTask(i.id)}><span>{i.title}</span><span className="st sm">{statusLabel(i).text}</span></button>)}</div>
                  {results.map(r=><article className="outcome-card" key={r.id}><h3>成果 · {r.title}</h3><Markdown src={r.description||""}/></article>)}
                  {mentioned.length > 0 && <details className="mentioned-tasks"><summary>对话中还提及过 {mentioned.length} 个任务</summary><p className="muted small">提及过的任务不代表由这个会话负责。</p><div className="task-links">{mentioned.sort((x,y) => y[1]-x[1]).map(([id,n]) => <button key={id} className="chip" onClick={() => onSelectTask(id)}><span>{issues.find(i => i.id === id)?.title ?? id}</span><span className="muted">{n} 次提及</span></button>)}</div></details>}
                </>}
              </div>
              {tab === 'timeline' && (() => { const pq = pendingQuestion(detail.messages); return pq ? <SessionQuestion key={pq.id} api={api} session={m} pending={pq} onAnswered={() => { onDone('答案已提交'); latest(); }} onError={(e) => onError(e)} /> : null; })()}
              <SessionReply key={`${m.host || 'local'}:${m.agent}:${m.session_id}`} api={api} session={m} messages={detail.messages} onSent={() => { setTab('timeline'); latest(); }} />
            </>
          );
        })()}
      </div>
    </div>{subView && detail && <SubagentDialog api={api} parent={detail.meta} sub={subView} onClose={() => setSubView(null)} />}</MediaProvider>
  );
}
