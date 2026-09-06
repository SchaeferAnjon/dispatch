import { useState } from "react";
import type { AgentPresence } from "../derive";
import { COLUMNS, NO_RESUME, SOURCE_LABEL, actorOf, columnOf, durSince, isReviewed, parseAcceptance, projectOf, relTime } from "../derive";
import type { Column, Issue, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, StatusPill, TYPE_LABEL } from "./ui";

interface Common { issues: Issue[]; selected: string | null; onSelect: (id: string) => void; me: string; rootOf?: (id: string) => Issue | undefined }

export function Card({ issue, selected, onSelect, me, root, draggable, onDragStart, onDragEnd }: { issue: Issue; selected: boolean; onSelect: (id: string) => void; me: string; root?: Issue } & Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd">) {
  const who = actorOf(issue.assignee, me);
  const ac = parseAcceptance(issue.acceptance_criteria);
  const done = ac.filter((a) => a.done).length;
  const blocked = issue.status === "blocked";
  return (
    <div className={`card opens${selected ? " sel" : ""}${blocked ? " blocked" : ""}`} onClick={() => onSelect(issue.id)} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(issue.id)}>
      <div className="t">{issue.title}</div>
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
      {isReviewed(issue) ? (
        <div className="rev-by">✓ 已审核 · {relTime(issue.updated_at)}</div>
      ) : who ? (
        <div className="who"><Avatar actor={who} />{who.name}{issue.status === "closed" ? " 完成" : ""}<span className="ago">{relTime(issue.status === "closed" ? issue.closed_at ?? issue.updated_at : issue.updated_at)}</span></div>
      ) : (
        <div className="who muted">未认领<span className="ago">{relTime(issue.updated_at)}</span></div>
      )}
    </div>
  );
}

export function Board({ issues, selected, onSelect, me, rootOf, onMove, onAdd }: Common & { onMove: (id: string, to: Column) => void; onAdd: (col: Column) => void }) {
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
                <Card key={i.id} issue={i} selected={selected === i.id} onSelect={onSelect} me={me} root={rootOf?.(i.id)} draggable
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

export function AgentsView({ agents, apps, onSelect, onCopyResume, onFocus, refs }: { agents: AgentPresence[]; apps: string[]; onSelect: (id: string) => void; onCopyResume: (agent: string, sessionId: string, cwd: string) => void; onFocus: (sessionId: string) => void; refs: Map<string, SessionRef> }) {
  return (
    <div className="agrid">
      {apps.length > 0 && <div className="apps-bar">正在运行的应用：{apps.join(" · ")}</div>}
      {agents.map((a) => {
        const working = a.sessions.filter((s) => s.state === "working").length;
        const isHuman = a.actor.kind === "human";
        return (
        <div key={a.actor.id} className={`acard${a.online || isHuman ? "" : " off"}`}>
          <div className="hd">
            <Avatar actor={a.actor} online={a.online} size={30} />
            <div><div className="nm">{a.actor.name}</div><div className="sub">{a.actor.id}{a.lastActive ? ` · 最近写入 ${relTime(a.lastActive)}` : ""}</div></div>
            <span className={`st sm state ${a.sessions.length ? (working ? "prog" : "done") : a.online ? "done" : "open"}`}>
              {a.sessions.length ? (working ? `${working} 个在跑` : `${a.sessions.length} 个会话 · 空闲`) : isHuman ? "你" : a.online ? "在线" : "离线"}
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
                <div key={s.session_id} className={`sess ${s.state}`} title={s.cwd || s.session_id}>
                  <span className={`src-ic ${s.source_kind}`}>{SOURCE_ICON[s.source_kind]}</span>
                  <span className="proj-name">{s.herdr?.title || r?.title || s.project || <span className="muted">未知目录</span>}{r?.current_task && <button className="link mono small" style={{ marginLeft: 6, color: "var(--s-prog)" }} onClick={() => onSelect(r.current_task!)}>正在做 {r.current_task}</button>}</span>
                  <span className="muted small">{s.source_app}{s.remote && <span className="host-chip">{s.host_name}</span>}</span>
                  <span className={`st sm ${s.state === "working" ? "prog" : s.state === "idle" ? "done" : "open"}`} title={s.registered ? "" : "钩子安装前启动的会话：只知道进程在，不知道忙不忙"}>{s.state === "working" ? "在跑" : s.state === "idle" ? "等你" : "未登记"}</span>
                  <span className="mono muted small right">{s.started_at ? `开了 ${durSince(s.started_at)}` : `pid ${s.agent_pid ?? "?"}`}{s.prompts ? ` · ${s.prompts} 轮` : ""}</span>
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <button className="copy-btn" onClick={() => onFocus(s.session_id)} title="切到这个会话所在的软件/标签">打开</button>
                    {s.registered && !s.session_id.startsWith("pid-") && !NO_RESUME.has(s.agent) && (
                      <button className="copy-btn" onClick={() => onCopyResume(s.agent, s.session_id, s.cwd)} title="复制恢复命令到剪贴板">恢复</button>
                    )}
                  </span>
                </div>
                );
              })}
            </div>
          )}
          {a.current.length ? a.current.map((i) => (
            <button key={i.id} className="cur" onClick={() => onSelect(i.id)}>
              <div className="lbl">正在做</div>
              <div className="t">{i.title}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{i.id} · 认领于 {relTime(i.started_at ?? i.updated_at)} 前</div>
            </button>
          )) : (
            <div className="cur" style={{ cursor: "default" }}><div className="lbl">正在做</div><div className="t muted">—</div></div>
          )}
          {!isHuman && <div className="kv"><b>身份</b><span className="mono">BEADS_ACTOR={a.actor.id}</span></div>}
        </div>
      );})}
    </div>
  );
}
