import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { actorOf, durSince, fmtTime, relTime } from "../derive";
import type { Folder, Issue, SessionRef } from "../types";
import { Avatar } from "./ui";

interface Props { api: Api; me: string; issues: Issue[]; onOpenSession: (id: string) => void; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

const AGENT_ORDER = ["claude-code", "codex", "zcode"];
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace("/Library/Mobile Documents/com~apple~CloudDocs", "/iCloud").replace("/Library/Mobile Documents/iCloud~md~obsidian/Documents", "/Obsidian");

// Projects are folders. For a folder: which agents came, and what each conversation was about.
export function FoldersView({ api, me, issues, onOpenSession, onSelectTask, onDone, onError }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [all, setAll] = useState<SessionRef[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.folders(), api.sessionList()]).then(([f, s]) => { if (alive) { setFolders(f); setAll(s); setLoaded(true); if (!sel && f[0]) setSel(f[0].cwd); } }).catch((e) => onError(String(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  useEffect(() => { setSessions(sel ? all.filter((s) => (s.cwd || "").replace(/\/$/, "") === sel).sort((a, b) => b.last_at - a.last_at) : []); }, [sel, all]);

  const items = useMemo(() => { const qq = q.trim().toLowerCase(); return folders.filter((f) => !qq || f.cwd.toLowerCase().includes(qq)); }, [folders, q]);
  const cur = folders.find((f) => f.cwd === sel) ?? null;
  const byAgent = useMemo(() => {
    const m = new Map<string, SessionRef[]>();
    for (const s of sessions) (m.get(s.agent) ?? m.set(s.agent, []).get(s.agent)!).push(s);
    return [...m.entries()].sort((a, b) => AGENT_ORDER.indexOf(a[0]) - AGENT_ORDER.indexOf(b[0]));
  }, [sessions]);
  const relatedTasks = useMemo(() => {
    if (!cur) return [];
    const ids = new Set(cur.tasks);
    const byLabel = issues.filter((i) => (i.labels ?? []).includes(`project:${cur.name}`));
    const byMention = issues.filter((i) => ids.has(i.id));
    return [...new Map([...byLabel, ...byMention].map((i) => [i.id, i])).values()];
  }, [cur, issues]);

  return (
    <div className="fold-wrap">
      <div className="sess-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="目录路径…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="muted small" style={{ marginTop: 6 }}>{folders.length} 个目录 · 按最近活动排序</div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">读取索引…</div>}
          {items.map((f) => (
            <button key={f.cwd} className={`fold-item${sel === f.cwd ? " sel" : ""}${f.exists ? "" : " gone"}`} onClick={() => setSel(f.cwd)} title={f.cwd}>
              <div className="l1"><span className="t">{f.name}</span><span className="ago mono">{relTime(new Date(f.last_at * 1000).toISOString())}</span></div>
              <div className="l2 mono">{short(f.cwd)}</div>
              <div className="l3">
                {AGENT_ORDER.filter((a) => f.agents[a]).map((a) => { const ac = actorOf(a, me)!; return <span key={a} className="ag"><span className={`av ${ac.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{ac.glyph}</span>{f.agents[a]}</span>; })}
                <span className="muted">{f.sessions} 会话 · {f.turns} 轮{f.tasks.length ? ` · ${f.tasks.length} 任务` : ""}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="sess-main">
        {!cur && <div className="empty">左边选一个目录。</div>}
        {cur && (
          <>
            <div className="sess-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ttl">{cur.name}</div>
                <div className="sub mono" title={cur.cwd}>{short(cur.cwd)}{cur.exists ? "" : " · 目录已不存在"}</div>
              </div>
              {cur.exists && <button className="btn sm" onClick={() => api.openPath(cur.cwd).catch((e) => onError(String(e)))}>在 Finder 打开</button>}
              <button className="btn sm" onClick={() => navigator.clipboard.writeText(`cd '${cur.cwd}'`).then(() => onDone("已复制 cd 命令"))}>复制 cd</button>
            </div>
            <div className="sess-meta kv">
              <b>来过的 Agent</b><span>{AGENT_ORDER.filter((a) => cur.agents[a]).map((a) => `${actorOf(a, me)!.name} ${cur.agents[a]} 次`).join(" · ") || "—"}</span>
              <b>时间跨度</b><span className="mono">{cur.first_at ? `${fmtTime(cur.first_at)} → ${fmtTime(new Date(cur.last_at * 1000).toISOString())}` : fmtTime(new Date(cur.last_at * 1000).toISOString())}</span>
              {relatedTasks.length > 0 && (<><b>相关任务</b><span className="task-links">{relatedTasks.map((t) => <button key={t.id} className="chip" onClick={() => onSelectTask(t.id)}><span className="mono">{t.id}</span>{t.title.slice(0, 24)}</button>)}</span></>)}
            </div>
            <div className="sess-body">
              {byAgent.map(([agent, list]) => {
                const a = actorOf(agent, me)!;
                return (
                  <section key={agent} className="fold-agent">
                    <h4><Avatar actor={a} /> {a.name} <span className="muted">{list.length} 次对话</span></h4>
                    {list.map((s) => (
                      <div key={s.session_id} className="conv" onClick={() => onOpenSession(s.session_id)} role="button" tabIndex={0}>
                        <div className="l1">
                          <span className="t">{s.title || "（无标题）"}</span>
                          <span className="mono muted small">{s.first_ts ? fmtTime(s.first_ts) : ""} · {s.user_msgs} 轮{s.subagents.length ? ` · ${s.subagents.length} 子 Agent` : ""}</span>
                        </div>
                        {s.first_prompt && <div className="fp"><span className="lbl">你说</span><span className="sel-text">{s.first_prompt}</span></div>}
                        <div className="l3 muted small">{s.last_at ? `最近 ${durSince(s.last_at)}前` : ""}{Object.keys(s.tasks).length ? ` · 提到 ${Object.keys(s.tasks).join(", ")}` : ""}<span className="spacer" /><span className="link">查看对话 →</span></div>
                      </div>
                    ))}
                  </section>
                );
              })}
              {sessions.length === 0 && <div className="empty">这个目录下没有索引到会话</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
