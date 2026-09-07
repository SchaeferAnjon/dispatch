import { linkedSessions } from "../projectModel";
import { MediaProvider, AttachmentList } from "./Media";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api";
import { actorOf, durSince, fmtTime, statusLabel, NO_RESUME, projectColor, relTime } from "../derive";
import { lineDiff, withContext } from "../diff";
import { canReadReply, activityLabel, sessionLifecycle } from "../activity";
import type { Activity, Issue, Session, SessionDetail, SessionRef } from "../types";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { OpenSessionButton } from "./SessionActions";
import { SessionReply } from "./SessionReply";

interface Props { archiveDays: number; outcomes: Issue[]; activities: Activity[]; issues: Issue[]; activityError: boolean; onSeen: (a: Activity, reply: string) => Promise<void>; api: Api; me: string; live: Session[]; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void; initialId?: string | null; hostId?: string }

const ENTRY: Record<string, string> = { cli: "终端", desktop: "桌面端", sdk: "SDK", "vscode-extension": "VS Code" };

export function SessionsView({ archiveDays, activities, issues, outcomes, activityError, onSeen, api, me, live, onSelectTask, onDone, onError, initialId, hostId }: Props) {
  const [refs, setRefs] = useState<SessionRef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [mode, setMode] = useState<"active" | "starred" | "archived" | "scheduled">("active");
  const host = hostId ?? "";
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<"timeline" | "activity" | "files" | "tasks" | "attachments">("timeline");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Which kinds of turns to show. Tools off by default: the conversation is the point.
  const [kinds, setKinds] = useState<Record<"user" | "assistant" | "tool", boolean>>(() => { try { return { user: true, assistant: true, tool: false, ...JSON.parse(localStorage.getItem("dispatch-tl-kinds") || "{}") }; } catch { return { user: true, assistant: true, tool: false }; } });
  const flip = (k: "user" | "assistant" | "tool") => { const v = { ...kinds, [k]: !kinds[k] }; setKinds(v); try { localStorage.setItem("dispatch-tl-kinds", JSON.stringify(v)); } catch { /* ignore */ } };

  const load = async () => { try { setRefs(await api.sessionList()); setLoaded(true); } catch (e) { onError(String(e)); } };
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => window.clearInterval(t); }, [api]);
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
      if (alive) timer = window.setTimeout(refresh, 3000);
    };
    refresh();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [sel, api]);
  useLayoutEffect(() => {
    if (tab === 'timeline' && follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [detail, tab, kinds]);
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

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const all = new Map(refs.map(r => [r.session_id, r]));
    for (const a of activities) {
      const old = all.get(a.session_id);
      all.set(a.session_id, old ? { ...old, last_at: a.last_at, scheduled: old.scheduled || a.scheduled, starred: old.starred || a.starred, archived: old.archived || a.archived } : { ...a, first_ts: '', last_ts: '', entrypoint: '', branch: '', user_msgs: 0, assistant_msgs: 0, tools: {}, tasks: Object.fromEntries(a.tasks.map(t => [t, 1])), mentions: 0, current_task: null, resume_cmd: '', path: '', size: 0, subagents: [] });
    }
    const inMode = (r: SessionRef) => { if (mode === "scheduled") return !!r.scheduled; if (r.scheduled) return false; const life = sessionLifecycle(r, archiveDays); return mode === "archived" ? life === "archived" : mode === "starred" ? life === "starred" : life !== "archived"; };
    return [...all.values()].sort((a,b) => Number(!!b.starred) - Number(!!a.starred) || b.last_at - a.last_at).filter((r) => inMode(r) && (!agent || r.agent === agent) && (!host || (r.host ?? "local") === host) && (!qq || (r.title || "").toLowerCase().includes(qq) || r.cwd.toLowerCase().includes(qq) || r.session_id.startsWith(qq) || Object.keys(r.tasks).some((t) => t.includes(qq))));
  }, [refs, activities, q, agent, host, mode, archiveDays]);
  const counts = useMemo(() => { const seen = new Map<string, SessionRef | Activity>(); for (const r of [...refs, ...activities]) if (!seen.has(r.session_id)) seen.set(r.session_id, r); const all = [...seen.values()]; return { scheduled: all.filter((r) => r.scheduled).length, starred: all.filter((r) => !r.scheduled && sessionLifecycle(r, archiveDays) === "starred").length, archived: all.filter((r) => !r.scheduled && sessionLifecycle(r, archiveDays) === "archived").length }; }, [refs, activities, archiveDays]);

  const liveOf = (id: string) => live.find((s) => s.session_id === id);
  const copy = async (cmd: string) => { try { await api.copy(cmd); onDone("恢复命令已复制，去终端粘贴回车"); } catch (e) { onError(String(e)); } };

  return (
    <MediaProvider api={api} session={detail?.meta}><div className={`sess-wrap${sel ? " has-selection" : ""}`}>
      <div className="sess-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="标题、目录、任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views session-modes" style={{ marginTop: 6 }}>
            <button className={mode === "active" ? "on" : ""} onClick={() => setMode("active")}>最近</button>
            <button className={mode === "starred" ? "on" : ""} onClick={() => setMode("starred")} title="收藏的会话：长期追踪，不会自动归档">★ 追踪中 {counts.starred}</button>
            <button className={mode === "archived" ? "on" : ""} onClick={() => setMode("archived")} title={`手动归档，或超过 ${archiveDays} 天没有活动`}>已归档 {counts.archived}</button>
            {counts.scheduled > 0 && <button className={mode === "scheduled" ? "on" : ""} onClick={() => setMode("scheduled")} title="定时任务产生的会话">定时 {counts.scheduled}</button>}
          </div>
          <div className="views" style={{ marginTop: 6 }}>
            {[["", "全部"], ["claude-code", "Claude"], ["codex", "Codex"], ["pi", "pi"], ["zcode", "ZCode"]].map(([v, l]) => <button key={v} className={agent === v ? "on" : ""} onClick={() => setAgent(v)}>{l}</button>)}
            <span className="spacer" /><span className="muted mono small">{items.length}</span>
          </div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">索引中…（首次要读完全部历史）</div>}
          {loaded && items.length === 0 && <div className="empty">{mode === "archived" ? `没有归档的会话（${archiveDays} 天没有活动的会自动归到这里）` : mode === "starred" ? "还没有收藏的会话。右键一条会话，选「收藏：长期追踪」。" : "没有匹配的会话"}</div>}
          {items.map((r) => {
            const a = actorOf(r.agent, me);
            const l = liveOf(r.session_id);
            const active = activities.find(a => a.session_id === r.session_id);
            return (
              <div key={r.session_id} className={`sess-item${sel === r.session_id ? " sel" : ""}`}><button className="sess-item-main" onClick={() => { setSel(r.session_id); setTab("timeline"); }}>
                <div className="l1"><Avatar actor={a} />{r.starred && <span className="star on" title="追踪中">★</span>}<span className="t">{r.title || "（无标题）"}</span>{active?.unread && <span className="unread-dot" title="未读回复" />}{l && !active && <span className={`st sm ${l.state === "working" ? "prog" : "done"}`}>{l.state === "working" ? "在跑" : "开着"}</span>}</div>
                <div className="l2"><span className="proj" style={{ background: projectColor(r.project) }} />{r.project || "?"}{r.remote && <span className="host-chip">{r.host_name}</span>}<span className="muted">· {ENTRY[r.entrypoint] ?? r.entrypoint ?? ""} · {r.user_msgs} 轮{r.subagents.length ? ` · ${r.subagents.length} 子` : ""}</span><span className="ago mono">{relTime(new Date(r.last_at * 1000).toISOString())}</span></div>
                {active && <div className="l3 activity-text">{activityLabel(active)} · {active.activity}</div>}
                {(() => { const own = issues.filter(i => linkedSessions(i).includes(r.session_id) && i.status !== "closed"); return own.length ? <div className="l3 linked-tasks"><span className="mono">{own[0].id}</span> {own[0].title}{own.length > 1 ? ` · 还有 ${own.length - 1} 项` : ""}</div> : null; })()}
              </button><OpenSessionButton session={r} compact /></div>
            );
          })}
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
                <OpenSessionButton session={m} />
                {!NO_RESUME.has(m.agent) && <button className="btn sm desktop-session-action" onClick={() => copy(m.resume_cmd)} title={m.resume_cmd}>复制恢复命令</button>}
                <details className="session-actions-menu"><summary aria-label="会话操作">⋯</summary><div>
                  {!NO_RESUME.has(m.agent) && <button className="btn sm" onClick={() => copy(m.resume_cmd)}>复制恢复命令</button>}
                </div></details>
              </div>
              {(current || activityError || loadError) && <div className={`session-live${activityError || loadError ? ' interrupted' : ''}`}><span className={`live-dot${current?.state === 'working' && !current.stale ? ' running' : ''}`} /><div><strong>{activityError || loadError ? '更新中断，保留上次记录' : current ? activityLabel(current) : '历史记录'}</strong><span>{current?.activity}</span></div><span className="muted small">{current ? (durSince(current.last_at) === "刚刚" ? "刚刚" : `${durSince(current.last_at)}前`) : ''}</span></div>}
              <details className="session-context" key={m.session_id}>
                <summary>{m.user_msgs} 轮对话 · {m.subagents.length} 个子 Agent<span>会话信息</span></summary>
                <div className="sess-meta kv">
                <b>开始</b><span className="mono">{m.first_ts ? fmtTime(m.first_ts) : "?"}</span>
                <b>最近</b><span className="mono">{m.last_ts ? `${fmtTime(m.last_ts)}（${durSince(m.last_at)}前）` : "?"}</span>
                <b>来源</b><span>{ENTRY[m.entrypoint] ?? m.entrypoint ?? "?"}{l ? ` · ${l.source_app}` : ""}{m.remote && <span className="host-chip">{m.host_name}</span>}</span>
                <b>对话</b><span>{m.user_msgs} 轮 · {m.assistant_msgs} 次回复 · {(m.size / 1e6).toFixed(1)} MB</span>
                <b>工具</b><span className="mono small">{Object.entries(detail.tool_counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</span>
                {m.subagents.length > 0 && (<><b>子 Agent</b><span className="subs">{m.subagents.map((s) => <span key={s.agent_id} className="sub-chip" title={s.path}>↳ <b>{s.type}</b> {s.description}<span className="muted mono"> · {(s.size / 1e3).toFixed(0)} KB</span></span>)}</span></>)}
                </div>
              </details>
              <div className="views session-tabs">
                <button className={tab === "timeline" ? "on" : ""} onClick={() => setTab("timeline")}>对话</button>
                {current && <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>实时活动</button>}
                <button className={tab === "attachments" ? "on" : ""} onClick={() => setTab("attachments")}>图片与产物 {detail.attachments?.length || 0}</button>
                <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>文件 {detail.workspace?.files.length ?? detail.files.length}</button>
                <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>任务与成果 {related.length + results.length}</button>
                {tab === "timeline" && (() => {
                  const nU = detail.messages.filter((x) => x.role === "user").length;
                  const nA = detail.messages.filter((x) => x.role === "assistant" && x.text.trim()).length;
                  const nT = detail.messages.reduce((s, x) => s + x.tools.length, 0);
                  return (
                    <details className="kind-options"><summary>显示内容</summary><span className="kinds" title="点一下切换显示哪类内容">
                      <button className={`chip${kinds.user ? " on" : ""}`} onClick={() => flip("user")}>你 <span className="mono muted">{nU}</span></button>
                      <button className={`chip${kinds.assistant ? " on" : ""}`} onClick={() => flip("assistant")}>{a?.name ?? "Agent"} <span className="mono muted">{nA}</span></button>
                      <button className={`chip${kinds.tool ? " on" : ""}`} onClick={() => flip("tool")}>工具调用 <span className="mono muted">{nT}</span></button>
                    </span></details>
                  );
                })()}
              </div>
              {tab === 'timeline' && !atLatest && <button className="follow-latest" onClick={latest}>回到最新 ↓{current?.unread ? ' · 有未读回复' : ''}</button>}
              <div className="sess-body" tabIndex={0} aria-label="会话内容" ref={scroller} onScroll={e => { if (tab !== 'timeline') return; const el = e.currentTarget; timelineScroll.current = el.scrollTop; const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24; follow.current = bottom; setAtLatest(bottom); }}>
                {tab === "timeline" && (() => {
                  const showTools = kinds.tool;
                  const list = detail.messages.filter((x) => x.role === "gap" || (x.role === "user" && kinds.user) || (x.role === "assistant" && (x.text.trim() ? kinds.assistant : kinds.tool)) || (x.role === "tool" && kinds.tool));
                  return list.map((x, i) => (
                    <div key={i} className={`tl ${x.role}`}>
                      {x.role === "gap" ? <div className="muted">{x.text}</div> : (
                        <>
                          <div className="tl-h"><b>{x.role === "user" ? "你" : x.role === "tool" ? "工具" : a?.name}</b><span className="mono muted small">{x.ts ? fmtTime(x.ts) : ""}</span></div>
                          {x.text && (x.role === "assistant" ? <div className="tl-t"><Markdown src={x.text} className="compact" /></div> : <div className="tl-t sel-text">{x.text}</div>)}
                          {showTools && x.tools.length > 0 && <div className="tl-tools">{x.tools.map((t, j) => <span key={j} className="tool-chip" title={t.summary}><b>{t.name}</b>{t.summary ? ` ${t.summary.slice(0, 80)}` : ""}</span>)}</div>}
                        </>
                      )}
                    </div>
                  ));
                })()}
                {tab === "attachments" && <AttachmentList items={detail.attachments || []} />}
                {tab === "activity" && <div className="activity-log">{[...(current?.events ?? [])].filter(e => e.kind !== 'result').reverse().slice(0,40).map(e => <div key={e.id} className={`activity-event ${e.kind}`}><span className="muted mono small">{new Date(e.ts*1000).toLocaleTimeString('zh-CN',{hour12:false})}</span><div><b>{e.kind === 'tool' ? e.tool : e.kind === 'result' ? '工具返回' : e.kind === 'error' ? '执行失败' : e.kind === 'user' ? '你的消息' : e.kind === 'reply' ? 'Agent 回复' : '进展'}</b><p>{e.text}</p></div></div>)}</div>}
                {tab === "files" && detail.workspace && <section className="workspace-diff"><h3>工作区当前改动 <span className="muted">{detail.workspace.files.length}</span></h3><p className="muted small">{detail.workspace.root} · 包含暂存和未暂存内容；同目录其他会话的修改也会显示。</p>{detail.workspace.unavailable ? <p className="muted">当前目录无法读取 Git 改动</p> : detail.workspace.files.length === 0 ? <p className="muted">工作区没有未提交改动</p> : <><div className="changed-paths">{detail.workspace.files.map(f => <div key={f.path}><span>{f.untracked ? '新增' : '修改'}</span><code>{f.path}</code></div>)}</div><details className="fdiff"><summary>展开当前差异</summary><pre className="diff">{detail.workspace.patch.split('\n').map((ln,k) => <div key={k} className={`ln ${ln.startsWith('+') ? 'add' : ln.startsWith('-') ? 'del' : 'same'}`}>{ln}</div>)}</pre>{detail.workspace.truncated && <p className="muted">差异过长，仅展示前 100 KB</p>}</details></>}</section>}
                {tab === "files" && <h3 className="recorded-files-title">会话中的文件操作 <span className="muted">{detail.files.length}</span></h3>}
                {tab === "files" && detail.files.length === 0 && <p className="muted">未记录到直接编辑工具调用；通过终端修改的文件可在上方工作区查看。</p>}
                {tab === "files" && detail.files.map((f) => (
                  <details key={f.path} className="fdiff" open={detail.files.length <= 3}>
                    <summary><span className="mono">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span><span className="muted"> · {f.changes.length} 处</span></summary>
                    {f.changes.map((c, i) => (
                      <div key={i} className="hunk">
                        <div className="hunk-h muted small">{c.kind === "write" ? "写入整个文件" : c.kind === "patch" ? `${c.op ?? "修改"}${c.add !== undefined ? ` · +${c.add} −${c.del ?? 0}` : ""}` : "编辑"}{c.ts ? ` · ${fmtTime(c.ts)}` : ""}</div>
                        {c.kind === "patch"
                          ? <pre className="diff">{c.new ? c.new.split("\n").map((ln, k) => <div key={k} className={`ln ${ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : "same"}`}>{ln}</div>) : <div className="skip">补丁内容没存下来</div>}</pre>
                          : <pre className="diff">{withContext(lineDiff(c.old, c.new)).map((ln, k) => ln.kind === "skip" ? <div key={k} className="skip">… {ln.count} 行未变 …</div> : <div key={k} className={`ln ${ln.kind}`}>{ln.kind === "add" ? "+" : ln.kind === "del" ? "-" : " "} {ln.text}</div>)}</pre>}
                      </div>
                    ))}
                  </details>
                ))}
                {tab === "tasks" && <>
                  <h3 className="recorded-files-title">这个会话关联的任务</h3>
                  {related.length === 0 && <p className="muted">没有明确关联的任务，可在项目的“待归属任务”中指定</p>}
                  <div className="task-links">{related.map(i => <button key={i.id} className="chip" onClick={() => onSelectTask(i.id)}><span>{i.title}</span><span className="st sm">{statusLabel(i).text}</span></button>)}</div>
                  {results.map(r=><article className="outcome-card" key={r.id}><h3>成果 · {r.title}</h3><Markdown src={r.description||""}/></article>)}
                  {mentioned.length > 0 && <details className="mentioned-tasks"><summary>对话中还提及过 {mentioned.length} 个任务</summary><p className="muted small">提及过的任务不代表由这个会话负责。</p><div className="task-links">{mentioned.sort((x,y) => y[1]-x[1]).map(([id,n]) => <button key={id} className="chip" onClick={() => onSelectTask(id)}><span>{issues.find(i => i.id === id)?.title ?? id}</span><span className="muted">{n} 次提及</span></button>)}</div></details>}
                </>}
              </div>
              <SessionReply key={`${m.host || 'local'}:${m.agent}:${m.session_id}`} api={api} session={m} messages={detail.messages} onSent={() => { setTab('timeline'); latest(); }} />
            </>
          );
        })()}
      </div>
    </div></MediaProvider>
  );
}
