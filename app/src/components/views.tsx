import { useState } from "react";
import { sessionStatus, sessionEvidence } from "../derive";
import type { AgentPresence } from "../derive";
import { COLUMNS, NO_RESUME, SOURCE_LABEL, actorOf, columnOf, durSince, isReviewed, parseAcceptance, projectOf, relTime } from "../derive";
import type { Column, Host, Issue, SessionRef } from "../types";
import type { AgentStartInput, AgentStartResult } from "../api";
import { Avatar, Pri, ProjectTag, StatusPill, TYPE_LABEL } from "./ui";

interface Common { progress?: Record<string, string>; issues: Issue[]; selected: string | null; onSelect: (id: string) => void; me: string; rootOf?: (id: string) => Issue | undefined }

export function Card({ issue, progress, selected, onSelect, me, root, draggable, onDragStart, onDragEnd }: { issue: Issue; progress?: string; selected: boolean; onSelect: (id: string) => void; me: string; root?: Issue } & Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd">) {
  const who = actorOf(issue.assignee, me);
  const ac = parseAcceptance(issue.acceptance_criteria);
  const done = ac.filter((a) => a.done).length;
  const blocked = issue.status === "blocked";
  return (
    <div className={`card opens${selected ? " sel" : ""}${blocked ? " blocked" : ""}`} onClick={() => onSelect(issue.id)} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(issue.id)}>
      <div className="t" title={issue.title}>{issue.title}</div>
      {root && <button className="root-link" onClick={(e) => { e.stopPropagation(); onSelect(root.id); }} title={`这条线的根任务：${root.title}`}><span className="rl-id">↑ 源自 <span className="mono">{root.id}</span></span><span className="rl-t">{root.title}</span></button>}
      <div className="meta">
        <Pri p={issue.priority} />
        <ProjectTag name={projectOf(issue)} />
        <span className="id">{issue.id}</span>
        {issue.issue_type !== "task" && <span className="muted">{TYPE_LABEL[issue.issue_type] ?? issue.issue_type}</span>}
      </div>
      {blocked && <div className="blk">⊘ 被 {issue.dependency_count ?? ""} 项依赖卡住</div>}
      {!blocked && (issue.dependency_count ?? 0) > 0 && issue.status !== "closed" && <div className="muted" style={{ fontSize: 11.5 }}>↳ 依赖 {issue.dependency_count} 项</div>}
      {ac.length > 0 && issue.status !== "closed" && (
        <div className="chk"><span className="bar"><i style={{ width: `${(done / ac.length) * 100}%` }} /></span>{done}/{ac.length} 验收项</div>
      )}
      {(issue.status === "closed" ? issue.close_reason : progress || issue.notes) && <div className="card-progress"><b>{issue.status === "closed" ? "完成说明" : progress ? "最近进展" : "进展备注"}</b> {issue.status === "closed" ? issue.close_reason : progress || issue.notes}</div>}
      {ac.some((a) => !a.done) && <div className="card-next"><b>{issue.status === "closed" ? "待核对" : "下一验收项"}</b> {ac.find((a) => !a.done)?.text}</div>}
      {isReviewed(issue) ? (
        <div className="rev-by">✓ 已复核 · {relTime(issue.updated_at)}</div>
      ) : who ? (
        <div className="who"><Avatar actor={who} />{who.name}{issue.status === "closed" ? " 完成" : ""}<span className="ago">{relTime(issue.status === "closed" ? issue.closed_at ?? issue.updated_at : issue.updated_at)}</span></div>
      ) : (
        <div className="who muted">未认领<span className="ago">{relTime(issue.updated_at)}</span></div>
      )}
    </div>
  );
}

export function Board({ issues, progress, selected, onSelect, me, rootOf, onMove, onAdd }: Common & { onMove: (id: string, to: Column) => void; onAdd: (col: Column) => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  return (
    <div className="board">
      {COLUMNS.map((c) => {
        const list = issues.filter((i) => columnOf(i) === c.key);
        return (
          <div key={c.key} className={`col${over === c.key ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (over !== c.key) setOver(c.key); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) onMove(dragId, c.key); setDragId(null); }}>
            <div className="col-h">
              <span className={`st ${c.cls}`}><i />{c.label}</span>
              <span className="cnt">{list.length}</span>
              {c.key === "todo" && <button className="add" onClick={() => onAdd(c.key)} title="新任务">＋</button>}
            </div>
            <div className="cards">
              {list.map((i) => (
                <Card key={i.id} progress={progress?.[i.id]} issue={i} selected={selected === i.id} onSelect={onSelect} me={me} root={rootOf?.(i.id)} draggable
                  onDragStart={(e) => { setDragId(i.id); e.dataTransfer.effectAllowed = "move"; (e.currentTarget as HTMLElement).classList.add("dragging"); }}
                  onDragEnd={(e) => { (e.currentTarget as HTMLElement).classList.remove("dragging"); setDragId(null); setOver(null); }} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TableView({ issues, selected, onSelect, me, rootOf }: Common) {
  if (issues.length === 0) return <div className="empty">没有符合条件的任务</div>;
  return (
    <div className="tw">
      <table>
        <thead><tr><th>ID</th><th>任务</th><th>源自</th><th>状态</th><th>负责</th><th>优先</th><th>项目</th><th>依赖</th><th>更新</th></tr></thead>
        <tbody>
          {issues.map((i) => {
            const who = actorOf(i.assignee, me);
            const root = rootOf?.(i.id);
            return (
              <tr key={i.id} className={selected === i.id ? "sel" : ""} onClick={() => onSelect(i.id)}>
                <td className="mono">{i.id}</td>
                <td className="t">{i.title}</td>
                <td>{root ? <button className="root-link" onClick={(e) => { e.stopPropagation(); onSelect(root.id); }} title={root.title}><span className="mono">{root.id}</span></button> : <span className="muted">—</span>}</td>
                <td><StatusPill issue={i} sm /></td>
                <td>{who ? <span className="who-i"><Avatar actor={who} />{who.name}</span> : <span className="muted">未认领</span>}</td>
                <td className="mono">P{i.priority}</td>
                <td><ProjectTag name={projectOf(i)} /></td>
                <td className="mono muted">{(i.dependency_count ?? 0) > 0 ? `← ${i.dependency_count}` : ""}{(i.dependent_count ?? 0) > 0 ? ` → ${i.dependent_count}` : ""}</td>
                <td className="mono muted">{relTime(i.updated_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SOURCE_ICON: Record<string, string> = { terminal: "⌘", desktop: "▣", editor: "◧", unknown: "?" };

// "派活": start an agent on a machine through Herdr and send it a first prompt.
const KINDS: [string, string][] = [["claude", "Claude Code"], ["codex", "Codex"], ["qodercli", "Qoder CLI"], ["gemini", "Gemini CLI"], ["opencode", "OpenCode"]];
function Delegate({ host, onClose, onStart }: { host: Host; onClose: () => void; onStart: (input: AgentStartInput) => Promise<AgentStartResult | null> }) {
  const [kind, setKind] = useState("claude");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentStartResult | null>(null);
  const [err, setErr] = useState("");
  const go = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setErr("");
    try { setRes(await onStart({ kind, host: host.local ? "" : host.id, cwd: cwd.trim() || undefined, prompt: prompt.trim(), label: prompt.trim().slice(0, 24) })); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="派活">
        <h3>在 {host.name} 上派活</h3>
        <div className="views">{KINDS.map(([k, l]) => <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>)}</div>
        <input placeholder={host.local ? "目录（默认当前目录）" : "目录（默认那台机器的家目录）"} value={cwd} onChange={(e) => setCwd(e.target.value)} />
        <textarea rows={4} placeholder="第一句话：要它做什么" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        {err && <div className="err">{err}</div>}
        {res && (
          <div className="sel-text small">
            <div><b>{res.status}</b> · Herdr {res.pane_id} · {res.actor}{res.warning ? ` · ${res.warning}` : ""}</div>
            {res.output && <pre className="diff" style={{ maxHeight: 220, overflow: "auto" }}>{res.output.split("\n").filter((l) => l.trim()).slice(-25).join("\n")}</pre>}
          </div>
        )}
        <div className="foot">
          <button className="btn ghost" onClick={onClose}>{res ? "关闭" : "取消"}</button>
          <button className="btn primary" disabled={busy || !prompt.trim()} onClick={go}>{busy ? "起中，等它回话…" : res ? "再派一个" : "起 Agent 并发送"}</button>
        </div>
      </div>
    </div>
  );
}

export function AgentsView({ agents, apps, onSelect, onCopyResume, onFocus, refs, hosts, onOpenUrl, onCopyText, onStart }: { agents: AgentPresence[]; apps: string[]; onSelect: (id: string) => void; onCopyResume: (agent: string, sessionId: string, cwd: string) => void; onFocus: (sessionId: string) => void; refs: Map<string, SessionRef>; hosts: Host[]; onOpenUrl: (url: string) => void; onCopyText: (text: string, what: string) => void; onStart: (input: AgentStartInput) => Promise<AgentStartResult | null> }) {
  const [delegate, setDelegate] = useState<Host | null>(null);
  return (
    <div className="agrid">
      {delegate && <Delegate host={delegate} onClose={() => setDelegate(null)} onStart={onStart} />}
      {hosts.length > 0 && (
        <div className="hosts-bar">
          {hosts.map((h) => {
            const OVERLAY: Record<string, string> = { tailscale: "Tailscale", netbird: "Netbird", zerotier: "ZeroTier" };
            const ways: { key: string; label: string; act: () => void; hint: string }[] = [];
            if (h.novnc_up) ways.push({ key: "novnc", label: "手机看屏幕 ⧉", act: () => onCopyText(h.novnc, "手机看屏幕的链接"), hint: "复制网页远程桌面链接；手机在同一个网里用浏览器打开，密码是这台 Mac 的登录密码" });
            if (h.screen_sharing && !h.local) ways.push({ key: "vnc", label: "看它的屏幕", act: () => onOpenUrl(h.vnc), hint: "用系统「屏幕共享」打开" });
            if (h.rustdesk) ways.push({ key: "rustdesk", label: h.rustdesk_id ? `RustDesk ${h.rustdesk_id} ⧉` : "RustDesk", act: () => (h.rustdesk_id ? onCopyText(h.rustdesk_id, "RustDesk ID") : onOpenUrl("rustdesk://")), hint: "不用虚拟网：手机 RustDesk 输这个 ID" });
            if (h.sunshine) ways.push({ key: "moonlight", label: "Moonlight 配对", act: () => onOpenUrl(h.sunshine_ui), hint: "打开 Sunshine 配对页；手机装 Moonlight，画质最高" });
            if (h.uu) ways.push({ key: "uu", label: "UU远程", act: () => onOpenUrl("/Applications"), hint: "已装网易UU远程；它没有接口，去它里面连" });
            return (
              <div key={h.id} className={`host${h.online ? "" : " off"}`} title={h.why}>
                <span className={`dot ${h.online ? "on" : ""}`} />
                <b>{h.name}</b><span className="mono muted small">{h.ip}</span>
                {h.overlay?.kind && <span className="host-chip">{OVERLAY[h.overlay.kind] ?? h.overlay.kind}</span>}
                {h.online && <button className="btn sm" onClick={() => setDelegate(h)} title="在这台机器的 Herdr 里起一个 Agent 并发第一句话">派活</button>}
                {ways.map((w) => <button key={w.key} className={`btn sm${w.key === h.recommend || (h.recommend === "vnc" && w.key === "novnc") ? "" : " ghost"}`} onClick={w.act} title={w.hint}>{w.label}</button>)}
                {ways.length === 0 && <span className="muted small">{h.why}</span>}
              </div>
            );
          })}
        </div>
      )}
      {apps.length > 0 && <div className="apps-bar">正在运行的应用：{apps.join(" · ")}</div>}
      {agents.filter(a => a.online || a.current.length > 0).map((a) => {
        const working = a.sessions.filter((s) => s.state === "working").length;
        const isHuman = a.actor.kind === "human";
        return (
        <div key={a.actor.id} className={`acard${a.online || isHuman ? "" : " off"}`}>
          <div className="hd">
            <Avatar actor={a.actor} online={a.online} size={30} />
            <div><div className="nm">{a.actor.name}</div><div className="sub">{a.actor.id}{a.lastActive ? ` · 最近写入 ${relTime(a.lastActive)}` : ""}</div></div>
            <span className={`st sm state ${a.sessions.length ? (working ? "prog" : "done") : a.online ? "done" : "open"}`}>
              {a.sessions.length ? (working ? `${working} 个在跑` : `${a.sessions.filter((s) => s.state === "idle" && s.registered).length} 空闲 · ${a.sessions.filter((s) => s.state === "unknown" || !s.registered).length} 状态未知`) : isHuman ? "你" : a.online ? "在线" : "离线"}
            </span>
          </div>
          {!isHuman && (
            <div className="sessions">
              <div className="src-row">
                {a.bySource.length === 0 && <span className="muted">没有检测到会话{a.actor.kind === "zcode" ? "（ZCode 没开，或 30 分钟内没有会话活动）" : ""}</span>}
                {a.bySource.map((b) => (
                  <span key={b.label} className={`chip src ${b.kind}`} title={SOURCE_LABEL[b.kind]}>
                    <span className="ic">{SOURCE_ICON[b.kind]}</span>{SOURCE_LABEL[b.kind]}{b.label && b.label !== SOURCE_LABEL[b.kind] ? ` · ${b.label}` : ""} <b>{b.count}</b>{b.working ? <span className="pulse" title="在跑" /> : null}
                  </span>
                ))}
              </div>
              {a.sessions.map((s) => {
                const r = refs.get(s.session_id);
                return (
                <div key={s.session_id} className={`sess ${s.state}`} title={`${s.cwd || s.session_id} · ${sessionEvidence(s)}`}>
                  <span className={`src-ic ${s.source_kind}`}>{SOURCE_ICON[s.source_kind]}</span>
                  <div className="agent-session-main">
                    <div className="agent-session-title"><span className="proj-name">{s.herdr?.title || r?.title || s.project || "未关联会话记录"}</span><span className={`st sm ${s.state === "working" ? "prog" : s.state === "idle" ? "done" : "open"}`}>{sessionStatus(s)}</span></div>
                    <div className="agent-session-meta"><span>{s.state_source === "transcript" ? "实际会话记录" : s.source_kind === "unknown" ? "来源未识别" : s.source_app}</span>{s.remote && <span>{s.host_name}</span>}<span>{s.last_at ? `${durSince(s.last_at)}前活动` : "尚无活动上报"}</span></div>
                    {r?.current_task && a.current.some(i => i.id === r.current_task) && <button className="link mono small" onClick={() => onSelect(r.current_task!)}>{r.current_task}</button>}
                  </div>
                  <div className="agent-session-actions"><button className="copy-btn" onClick={() => onFocus(s.session_id)} title="切到会话所在的软件">打开</button>{s.registered && !s.session_id.startsWith("pid-") && !NO_RESUME.has(s.agent) && <button className="copy-btn" onClick={() => onCopyResume(s.agent, s.session_id, s.cwd)}>恢复</button>}</div>
                </div>
                );
              })}
            </div>
          )}
          {a.current.length > 0 && <details className="agent-task-context"><summary>关联进行中任务 · {a.current.length}</summary>{a.current.map(i => <button key={i.id} className="cur" onClick={() => onSelect(i.id)}><div className="t">{i.title}</div><div className="mono muted small">{i.id}</div></button>)}</details>}

        </div>
      );})}
      <details className="offline-agents"><summary>未检测到活动的 Agent · {agents.filter(a => !a.online && !a.current.length).length}</summary><div>{agents.filter(a => !a.online && !a.current.length).map(a => <span key={a.actor.id}>{a.actor.name}</span>)}</div></details>
    </div>
  );
}
