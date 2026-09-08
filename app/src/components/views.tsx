import { TaskMenuButton } from "./TaskActions";
import { useState } from "react";
import { sessionStatus, sessionEvidence } from "../derive";
import type { AgentPresence } from "../derive";
import { COLUMNS, SOURCE_LABEL, projectColor, actorOf, columnOf, delegatedBy, delegatedTo, durSince, isReviewed, parseAcceptance, projectOf, relTime } from "../derive";
import type { Column, Host, Issue, Session, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, StatusPill, TYPE_LABEL } from "./ui";
import { linkedSessions } from "../projectModel";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";

interface Common { progress?: Record<string, string>; issues: Issue[]; selected: string | null; onSelect: (id: string) => void; me: string; rootOf?: (id: string) => Issue | undefined }

export function Card({ issue, progress, selected, onSelect, me, root, draggable, onDragStart, onDragEnd }: { issue: Issue; progress?: string; selected: boolean; onSelect: (id: string) => void; me: string; root?: Issue } & Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd">) {
  const who = actorOf(issue.assignee, me);
  const ac = parseAcceptance(issue.acceptance_criteria);
  const done = ac.filter((a) => a.done).length;
  const blocked = issue.status === "blocked";
  return (
    <div data-task={issue.id} className={`card opens${selected ? " sel" : ""}${blocked ? " blocked" : ""}`} onClick={() => onSelect(issue.id)} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(issue.id)}>
      <div className="card-heading"><div className="t" title={issue.title}>{issue.title}</div><TaskMenuButton issue={issue}/></div>
      {root && <button className="root-link" onClick={(e) => { e.stopPropagation(); onSelect(root.id); }} title={`这条线的根任务：${root.title}`}><span className="rl-id">↑ 源自 <span className="mono">{root.id}</span></span><span className="rl-t">{root.title}</span></button>}
      <div className="meta">
        <Pri p={issue.priority} />
        <ProjectTag name={projectOf(issue)} />
        <span className="id" title={"任务编号：Beads 自动生成，前缀是板的名字（task），后面三位是随机编码，没有含义，只用来唯一标识"}>{issue.id}</span>
        {issue.issue_type !== "task" && <span className="muted">{TYPE_LABEL[issue.issue_type] ?? issue.issue_type}</span>}
      </div>
      {delegatedBy(issue) && issue.status !== "closed" && <div className="muted" style={{ fontSize: 11.5 }}>↪ {actorOf(delegatedBy(issue), me)?.name ?? delegatedBy(issue)} 派给 {actorOf(delegatedTo(issue), me)?.name ?? delegatedTo(issue)}</div>}
      {blocked && <div className="blk">⊘ 被 {issue.dependency_count ?? ""} 项依赖卡住</div>}
      {issue.status === "deferred" && <div className="blk deferred">⏸ 搁置 · 暂不安排</div>}
      {!blocked && (issue.dependency_count ?? 0) > 0 && issue.status !== "closed" && <div className="muted" style={{ fontSize: 11.5 }}>↳ 依赖 {issue.dependency_count} 项</div>}
      {ac.length > 0 && issue.status !== "closed" && (
        <div className="chk"><span className="bar"><i style={{ width: `${(done / ac.length) * 100}%` }} /></span>{done}/{ac.length} 验收项</div>
      )}
      {(() => { const note = issue.status === "closed" ? issue.close_reason : progress || issue.notes; const next = ac.find((a) => !a.done)?.text; return note ? <div className="card-progress" title={next ? `下一验收项：${next}` : undefined}><b>{issue.status === "closed" ? "完成说明" : progress ? "最近进展" : "进展备注"}</b> {note}</div> : next ? <div className="card-next"><b>{issue.status === "closed" ? "待核对" : "下一验收项"}</b> {next}</div> : null; })()}
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

const WEEK = 7 * 86_400_000;
export type BoardSort = "priority" | "updated" | "created";
export const BOARD_SORTS: { key: BoardSort; label: string }[] = [{ key: "priority", label: "按优先级" }, { key: "updated", label: "按最近更新" }, { key: "created", label: "按创建时间" }];
const cmpBy = (sort: BoardSort, col: Column) => (x: Issue, y: Issue) => {
  if (col === "done") return (y.closed_at ?? y.updated_at).localeCompare(x.closed_at ?? x.updated_at);
  if (sort === "updated") return y.updated_at.localeCompare(x.updated_at);
  if (sort === "created") return y.created_at.localeCompare(x.created_at);
  return x.priority - y.priority || y.updated_at.localeCompare(x.updated_at);
};

// Every column is grouped by project. Starred projects come first (the same order the
// workbench uses), then the project with the most recent change. Groups fold, and the
// fold state is remembered per column+project.
export function Board({ issues, progress, selected, onSelect, me, rootOf, onMove, onAdd, sort = "priority", starred = new Set<string>() }: Common & { onMove: (id: string, to: Column) => void; onAdd: (col: Column) => void; sort?: BoardSort; starred?: Set<string> }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  // The done column only shows the last week by default; the rest is a click away.
  const [allDone, setAllDone] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem("dispatch-board-groups-v2") || "{}"); } catch { return {}; } });
  const setGroups = (patch: Record<string, boolean>) => setOpenGroups((g) => { const next = { ...g, ...patch }; try { localStorage.setItem("dispatch-board-groups-v2", JSON.stringify(next)); } catch { /* ignore */ } return next; });
  const toggleGroup = (key: string, open: boolean) => setGroups({ [key]: open });
  const recent = (i: Issue) => Date.now() - Date.parse(i.closed_at ?? i.updated_at) < WEEK;
  return (
    <div className="board">
      {COLUMNS.map((c) => {
        const full = issues.filter((i) => columnOf(i) === c.key);
        const list = c.key === "done" && !allDone ? full.filter((i) => recent(i) || i.id === selected) : full;
        const hidden = full.length - list.length;
        const sorted = [...list].sort(cmpBy(sort, c.key));
        const groups = new Map<string, Issue[]>();
        for (const i of sorted) { const k = projectOf(i) || "未分项目"; groups.set(k, [...(groups.get(k) ?? []), i]); }
        const latest = (items: Issue[]) => Math.max(...items.map((i) => Date.parse(i.closed_at ?? i.updated_at)));
        const ordered = [...groups.entries()].sort(([a, ia], [b, ib]) => Number(starred.has(b)) - Number(starred.has(a)) || (sort === "priority" && c.key !== "done" ? Math.min(...ia.map((i) => i.priority)) - Math.min(...ib.map((i) => i.priority)) : 0) || latest(ib) - latest(ia));
        return (
          <div key={c.key} className={`col${over === c.key ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (over !== c.key) setOver(c.key); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) onMove(dragId, c.key); setDragId(null); }}>
            <div className="col-h">
              <span className={`st ${c.cls}`}><i />{c.label}</span>
              <span className="cnt">{full.length}</span>
              {ordered.length > 1 && (() => { const keys = ordered.map(([name]) => `${c.key}:${name}`); const allOpen = keys.every((k) => openGroups[k] ?? (c.key !== "done")); return <button className="link small col-fold" onClick={() => setGroups(Object.fromEntries(keys.map((k) => [k, !allOpen])))}>{allOpen ? "全部收起" : "全部展开"}</button>; })()}
              {c.key === "todo" && <button className="add" onClick={() => onAdd(c.key)} title="新任务">＋</button>}
            </div>
            <div className="cards">
              {ordered.map(([name, items]) => {
                const key = `${c.key}:${name}`;
                // Done groups start folded; the others start open. A group holding the selected task is always open.
                const open = items.some((i) => i.id === selected) || (openGroups[key] ?? (c.key !== "done"));
                return <details key={key} className="done-group" open={open} onClick={(e) => { if ((e.target as HTMLElement).closest("summary")) { e.preventDefault(); toggleGroup(key, !open); } }}>
                  <summary className="done-group-h"><span className="proj" style={{ background: projectColor(name) }} />{starred.has(name) && <span className="star on small">★</span>}{name}<span className="muted mono small">{items.length}</span><span className="muted small fold-hint">{open ? "收起" : "展开"}</span></summary>
                  {open && items.map((i) => (
                    <Card key={i.id} progress={progress?.[i.id]} issue={i} selected={selected === i.id} onSelect={onSelect} me={me} root={rootOf?.(i.id)} draggable={c.key !== "done"}
                      onDragStart={(e) => { setDragId(i.id); e.dataTransfer.effectAllowed = "move"; (e.currentTarget as HTMLElement).classList.add("dragging"); }}
                      onDragEnd={(e) => { (e.currentTarget as HTMLElement).classList.remove("dragging"); setDragId(null); setOver(null); }} />
                  ))}
                </details>;
              })}
              {c.key === "done" && (hidden > 0 || allDone) && full.length > 0 && <button className="link col-more" onClick={() => setAllDone(!allDone)}>{allDone ? "只看最近 7 天" : `还有 ${hidden} 项更早完成的 ›`}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TableView({ issues, selected, onSelect, me, rootOf, starred = new Set<string>() }: Common & { starred?: Set<string> }) {
  if (issues.length === 0) return <div className="empty">没有符合条件的任务</div>;
  const rows = [...issues].sort((a, b) => Number(starred.has(projectOf(b))) - Number(starred.has(projectOf(a))));
  return (
    <div className="tw">
      <table>
        <thead><tr><th>ID</th><th>任务</th><th>源自</th><th>状态</th><th>负责</th><th>优先</th><th>项目</th><th>依赖</th><th>更新</th><th>操作</th></tr></thead>
        <tbody>
          {rows.map((i) => {
            const who = actorOf(i.assignee, me);
            const root = rootOf?.(i.id);
            return (
              <tr data-task={i.id} key={i.id} className={selected === i.id ? "sel" : ""} onClick={() => onSelect(i.id)}>
                <td className="mono" title={"任务编号：Beads 自动生成，前缀是板的名字（task），后面三位是随机编码，没有含义，只用来唯一标识"}>{i.id}</td>
                <td className="t">{i.title}</td>
                <td>{root ? <button className="root-link" onClick={(e) => { e.stopPropagation(); onSelect(root.id); }} title={root.title}><span className="mono">{root.id}</span></button> : <span className="muted">—</span>}</td>
                <td><StatusPill issue={i} sm /></td>
                <td>{who ? <span className="who-i"><Avatar actor={who} />{who.name}</span> : <span className="muted">未认领</span>}</td>
                <td className="mono">P{i.priority}</td>
                <td><ProjectTag name={projectOf(i)} /></td>
                <td className="mono muted">{(i.dependency_count ?? 0) > 0 ? `← ${i.dependency_count}` : ""}{(i.dependent_count ?? 0) > 0 ? ` → ${i.dependent_count}` : ""}</td>
                <td className="mono muted">{relTime(i.updated_at)}</td><td><TaskMenuButton issue={i}/></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SOURCE_ICON: Record<string, string> = { terminal: "⌘", desktop: "▣", editor: "◧", unknown: "?" };

export function AgentsView({ agents, scheduled, apps, issues, me, onSelect, onFocus, refs, hosts, onOpenUrl, onCopyText, onDelegate , onPhoneLink }: { agents: AgentPresence[]; scheduled: Session[]; apps: string[]; issues: Issue[]; me: string; onSelect: (id: string) => void; onFocus: (sessionId: string) => void; refs: Map<string, SessionRef>; hosts: Host[]; onOpenUrl: (url: string) => void; onCopyText: (text: string, what: string) => void; onDelegate: (host: Host) => void ; onPhoneLink?: () => void }) {
  useItemMenu("host", (id) => {
    const h = hosts.find((x) => x.id === id);
    if (!h) return null;
    return { title: h.name, items: [
      ...(h.online ? [{ label: "派活：在这台起一个 Agent", onClick: () => onDelegate(h) }] : []),
      { label: "复制 ssh 地址", onClick: () => onCopyText(h.ssh, "ssh 地址") },
      { label: "复制 IP", onClick: () => onCopyText(h.ip, "IP") },
      ...(h.screen_sharing && !h.local ? [{ label: "看它的屏幕并操作", onClick: () => onOpenUrl(h.vnc) }] : []),
      ...(h.novnc_up && h.novnc.startsWith("https://") ? [{ label: "复制手机看屏幕链接（手机用）", onClick: () => onCopyText(h.novnc, "手机看屏幕的链接") }] : []),
    ] };
  }, [hosts, onDelegate, onCopyText, onOpenUrl]);
  useViewMenuExtras(hosts.filter((h) => h.online).map((h) => ({ label: `在 ${h.name} 派活`, onClick: () => onDelegate(h) })), [hosts]);
  return (
    <div className="agrid">
      {hosts.length > 0 && (
        <div className="hosts-bar">
          {hosts.map((h) => {
            const OVERLAY: Record<string, string> = { tailscale: "Tailscale", netbird: "Netbird", zerotier: "ZeroTier" };
            const ways: { key: string; label: string; act: () => void; hint: string }[] = [];
            // From this Mac the natural thing is to open the other Mac's screen and drive it
            // (system Screen Sharing). The noVNC page is for the phone: a link to copy, never
            // to open here (opening your own screen inside itself just mirrors forever).
            if (h.screen_sharing && !h.local) ways.push({ key: "vnc", label: "看它的屏幕并操作", act: () => onOpenUrl(h.vnc), hint: "用系统「屏幕共享」打开，能直接操作那台 Mac" });
            if (h.novnc_up && h.novnc.startsWith("https://") && !h.local) ways.push({ key: "novnc", label: "复制手机看屏幕链接 ⧉", act: () => onCopyText(h.novnc, "手机看屏幕的链接"), hint: "发到手机上打开（手机需连着 Tailscale），用这台 Mac 的用户名和登录密码" });
            if (h.local && onPhoneLink) ways.push({ key: "phone", label: "手机访问 ⧉", act: onPhoneLink, hint: "复制 Dispatch 网页版链接；手机连上 Tailscale 后用浏览器打开，可添加到主屏幕" });
            if (h.local && h.novnc_up && h.novnc.startsWith("https://")) ways.push({ key: "novnc", label: "看屏幕 ⧉", act: () => onCopyText(h.novnc, "链接已复制。另一个电脑使用当前电脑会无限套娃，在看屏幕之前请打开 Tailscale。"), hint: "另一个电脑使用当前电脑会无限套娃，在看屏幕之前请打开 Tailscale。" });
            if (h.rustdesk) ways.push({ key: "rustdesk", label: h.rustdesk_id ? `RustDesk ${h.rustdesk_id} ⧉` : "RustDesk", act: () => (h.rustdesk_id ? onCopyText(h.rustdesk_id, "RustDesk ID") : onOpenUrl("rustdesk://")), hint: "不用虚拟网：手机 RustDesk 输这个 ID" });
            if (h.sunshine) ways.push({ key: "moonlight", label: "Moonlight 配对", act: () => onOpenUrl(h.sunshine_ui), hint: "打开 Sunshine 配对页；手机装 Moonlight，画质最高" });
            if (h.uu) ways.push({ key: "uu", label: "UU远程", act: () => onOpenUrl("/Applications"), hint: "已装网易UU远程；它没有接口，去它里面连" });
            return (
              <div key={h.id} data-menu="host" data-id={h.id} className={`host${h.online ? "" : " off"}`} title={h.why}>
                <span className={`dot ${h.online ? "on" : ""}`} />
                <b>{h.name}</b><span className="mono muted small">{h.ip}</span>
                {h.overlay?.kind && <span className="host-chip">{OVERLAY[h.overlay.kind] ?? h.overlay.kind}</span>}
                {h.online && <button className="btn sm" onClick={() => onDelegate(h)} title="在这台机器的 Herdr 里起一个 Agent，可以把任务派给它">派活</button>}
                {ways.map((w) => <button key={w.key} className={`btn sm${w.key === h.recommend || (h.recommend === "vnc" && w.key === "novnc") ? "" : " ghost"}`} onClick={w.act} title={w.hint}>{w.label}</button>)}
                {h.novnc_issue && <span className="host-connection-note">{h.novnc_issue}</span>}
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
              {(() => { const now = Date.now() / 1000; const isActive = (s: Session) => s.state === "working" || (s.alive && now - s.last_at < 3600); const activeList = a.sessions.filter(isActive); const older = a.sessions.filter((s) => !isActive(s)); const row = (s: Session) => {
                const r = refs.get(s.session_id);
                return (
                <div key={s.session_id} data-session={`${s.host ?? "local"}:${s.agent}:${s.session_id}`} className={`sess ${s.state}`} title={`${s.cwd || s.session_id} · ${sessionEvidence(s)} · 右键更多操作`}>
                  <span className={`src-ic ${s.source_kind}`}>{SOURCE_ICON[s.source_kind]}</span>
                  <div className="agent-session-main">
                    <div className="agent-session-title"><span className="proj-name">{s.herdr?.title || r?.title || s.project || "未关联会话记录"}</span><span className={`st sm ${s.state === "working" ? "prog" : s.state === "idle" ? "done" : "open"}`}>{sessionStatus(s)}</span></div>
                    <div className="agent-session-meta"><span>{s.state_source === "transcript" ? "实际会话记录" : s.source_kind === "unknown" ? "来源未识别" : s.source_app}</span>{s.remote && <span>{s.host_name}</span>}<span>{s.last_at ? `${durSince(s.last_at)}前活动` : "尚无活动上报"}</span></div>
                    {(() => { const own = a.current.find(i => linkedSessions(i).includes(s.session_id)); return own ? <button className="link small linked-task" onClick={() => onSelect(own.id)}><span className="mono">{own.id}</span> {own.title}</button> : null; })()}
                  </div>
                  <div className="agent-session-actions"><button className="copy-btn" onClick={() => onFocus(s.session_id)} title="切到会话所在的软件">打开</button></div>
                </div>
                );
              }; return <>{activeList.map(row)}{activeList.length === 0 && older.length > 0 && <div className="muted small" style={{ padding: "4px 2px" }}>现在没有活跃会话</div>}{older.length > 0 && <details className="older-sessions"><summary>更早的会话 · {older.length}<span className="muted small"> · 一小时内没动静；完整历史在会话页</span></summary>{older.map(row)}</details>}</>; })()}
            </div>
          )}
          {a.current.length > 0 && <details className="agent-task-context"><summary>关联进行中任务 · {a.current.length}</summary>{a.current.map(i => <button key={i.id} className="cur" onClick={() => onSelect(i.id)}><div className="t">{i.title}</div><div className="mono muted small">{i.id}{delegatedBy(i) ? ` · ← ${actorOf(delegatedBy(i), me)?.name ?? delegatedBy(i)} 派的` : ""}</div></button>)}</details>}
          {(() => {
            // 派活关系: tasks this agent handed out, and tasks handed to it, still open.
            const open = issues.filter((i) => i.status !== "closed");
            const out = open.filter((i) => actorOf(delegatedBy(i), me)?.id === a.actor.id);
            const got = open.filter((i) => actorOf(delegatedTo(i), me)?.id === a.actor.id);
            if (!out.length && !got.length) return null;
            return <div className="agent-delegations">
              {out.length > 0 && <div><span className="lbl">派出 {out.length}</span>{out.map((i) => <button key={i.id} className="chip" onClick={() => onSelect(i.id)}>→ {actorOf(delegatedTo(i), me)?.name ?? delegatedTo(i)} · {i.title.slice(0, 28)}</button>)}</div>}
              {got.length > 0 && <div><span className="lbl">接到 {got.length}</span>{got.map((i) => <button key={i.id} className="chip" onClick={() => onSelect(i.id)}>← {actorOf(delegatedBy(i), me)?.name ?? delegatedBy(i)} · {i.title.slice(0, 28)}</button>)}</div>}
            </div>;
          })()}

        </div>
      );})}
      {scheduled.length > 0 && <details className="offline-agents"><summary>定时会话 · {scheduled.length}<span className="muted small"> · 不计入在跑、未读和通知</span></summary><div className="sessions">{scheduled.map((s) => <div key={s.session_id} data-session={`${s.host ?? "local"}:${s.agent}:${s.session_id}`} className={`sess ${s.state}`}><span className={`src-ic ${s.source_kind}`}>{SOURCE_ICON[s.source_kind]}</span><div className="agent-session-main"><div className="agent-session-title"><span className="proj-name">{s.herdr?.title || s.title || s.project || s.cwd}</span><span className={`st sm ${s.state === "working" ? "prog" : "open"}`}>{sessionStatus(s)}</span></div><div className="agent-session-meta"><span>{actorOf(s.agent, "")?.name}</span>{s.remote && <span>{s.host_name}</span>}<span>{s.last_at ? `${durSince(s.last_at)}前活动` : ""}</span></div></div><div className="agent-session-actions"><button className="copy-btn" onClick={() => onFocus(s.session_id)}>打开</button></div></div>)}</div></details>}
      <details className="offline-agents"><summary>未检测到活动的 Agent · {agents.filter(a => !a.online && !a.current.length).length}</summary><div>{agents.filter(a => !a.online && !a.current.length).map(a => <span key={a.actor.id}>{a.actor.name}</span>)}</div></details>
    </div>
  );
}
