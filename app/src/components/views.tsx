import { useState } from "react";
import { basename, isWindows } from "../platform";
import { ago, sessionStatus, sessionEvidence } from "../derive";
import type { AgentPresence } from "../derive";
import { COLUMNS, SOURCE_LABEL, projectColor, actorOf, acceptanceProgress, columnOf, delegatedBy, delegatedTo, issueAcceptance, projectOf, relTime } from "../derive";
import { acTitle } from "./ListRows";
import type { Column, Host, Issue, Session, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, StatusPill } from "./ui";
import { linkedSessions } from "../projectModel";
import { conflictingFiles, recentEdits } from "../activity";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { useLocale, useT } from "../i18n";
import { EmptyView, ListDetail, Meta, Meter, Row, Section, Sep, Tag, useListKeyboard } from "./primitives";
import { TaskIcon, taskStateTag, useTaskRow } from "./ListRows";

interface Common { progress?: Record<string, string>; issues: Issue[]; selected: string | null; onSelect: (id: string) => void; me: string; rootOf?: (id: string) => Issue | undefined }

// A board card is two lines, like a list row folded in half: who and what, then priority, project,
// acceptance and time. Everything else (root, delegation, notes) is in the Detail and in ⌘K.
export function Card({ issue, selected, onSelect, me, draggable, onDragStart, onDragEnd }: { issue: Issue; progress?: string; selected: boolean; onSelect: (id: string) => void; me: string; root?: Issue } & Pick<React.HTMLAttributes<HTMLElement>, "draggable" | "onDragStart" | "onDragEnd">) {
  const t = useT();
  const ac = issueAcceptance(issue);
  const prog = acceptanceProgress(ac);
  const done = prog.done;
  const state = taskStateTag(issue, t);
  return (
    <div data-task={issue.id} className={`card${selected ? " sel" : ""}`} onClick={() => onSelect(issue.id)} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} role="button" tabIndex={0} aria-pressed={selected} onKeyDown={(e) => e.key === "Enter" && onSelect(issue.id)} title={issue.title}>
      <div className="card-l1"><TaskIcon issue={issue} me={me} /><span className="t">{issue.title}</span></div>
      <div className="card-l2">
        {state}
        {issue.status !== "closed" && <Pri p={issue.priority} />}
        <span className="mono">{issue.id}</span>
        {ac.length > 0 && issue.status !== "closed" && <Meter value={done} max={ac.length} title={acTitle(prog, t)} />}
        <span className="num card-ago">{relTime(issue.status === "closed" ? issue.closed_at ?? issue.updated_at : issue.updated_at)}</span>
      </div>
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
  const t = useT();
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
        for (const i of sorted) { const k = projectOf(i) || t("未分项目"); groups.set(k, [...(groups.get(k) ?? []), i]); }
        const latest = (items: Issue[]) => Math.max(...items.map((i) => Date.parse(i.closed_at ?? i.updated_at)));
        const ordered = [...groups.entries()].sort(([a, ia], [b, ib]) => Number(starred.has(b)) - Number(starred.has(a)) || (sort === "priority" && c.key !== "done" ? Math.min(...ia.map((i) => i.priority)) - Math.min(...ib.map((i) => i.priority)) : 0) || latest(ib) - latest(ia));
        return (
          <div key={c.key} className={`col${over === c.key ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (over !== c.key) setOver(c.key); }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) onMove(dragId, c.key); setDragId(null); }}>
            <div className="col-h">
              <span className={`st ${c.cls}`}><i />{t(c.label)}</span>
              <span className="cnt">{full.length}</span>
              {ordered.length > 1 && (() => { const keys = ordered.map(([name]) => `${c.key}:${name}`); const allOpen = keys.every((k) => openGroups[k] ?? (c.key !== "done")); return <button className="link small col-fold" onClick={() => setGroups(Object.fromEntries(keys.map((k) => [k, !allOpen])))}>{allOpen ? t("全部收起") : t("全部展开")}</button>; })()}
              {c.key === "todo" && <button className="add" onClick={() => onAdd(c.key)} title={t("新任务")}>＋</button>}
            </div>
            <div className="cards">
              {ordered.map(([name, items]) => {
                const key = `${c.key}:${name}`;
                // Done groups start folded; the others start open. A group holding the selected task is always open.
                const open = items.some((i) => i.id === selected) || (openGroups[key] ?? (c.key !== "done"));
                return <details key={key} className="done-group" open={open} onClick={(e) => { if ((e.target as HTMLElement).closest("summary")) { e.preventDefault(); toggleGroup(key, !open); } }}>
                  <summary className="done-group-h"><span className="proj" style={{ background: projectColor(name) }} />{starred.has(name) && <span className="star on small">★</span>}{name}<span className="muted mono small">{items.length}</span><span className="muted small fold-hint">{open ? t("收起") : t("展开")}</span></summary>
                  {open && items.map((i) => (
                    <Card key={i.id} progress={progress?.[i.id]} issue={i} selected={selected === i.id} onSelect={onSelect} me={me} root={rootOf?.(i.id)} draggable={c.key !== "done"}
                      onDragStart={(e) => { setDragId(i.id); e.dataTransfer.effectAllowed = "move"; (e.currentTarget as HTMLElement).classList.add("dragging"); }}
                      onDragEnd={(e) => { (e.currentTarget as HTMLElement).classList.remove("dragging"); setDragId(null); setOver(null); }} />
                  ))}
                </details>;
              })}
              {c.key === "done" && (hidden > 0 || allDone) && full.length > 0 && <button className="link col-more" onClick={() => setAllDone(!allDone)}>{allDone ? t("只看最近 7 天") : t("还有 {n} 项更早完成的 ›", { n: hidden })}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 全部任务 · 列表 (the default task view): one 32px row per task in three sections, 进行中, 待办 and
// 已完成 (the last week; older ones a click away). Selecting a row opens the task's Detail; ↑↓ move.
export function ListView({ issues, selected, onSelect, me, sort = "priority", starred = new Set<string>() }: Common & { sort?: BoardSort; starred?: Set<string> }) {
  const t = useT();
  const taskRow = useTaskRow();
  const [allDone, setAllDone] = useState(false);
  const recent = (i: Issue) => Date.now() - Date.parse(i.closed_at ?? i.updated_at) < WEEK;
  const order: Column[] = ["prog", "todo", "done"];
  const groups = order.map((key) => {
    const c = COLUMNS.find((x) => x.key === key)!;
    const full = issues.filter((i) => columnOf(i) === key);
    const shown = key === "done" && !allDone ? full.filter((i) => recent(i) || i.id === selected) : full;
    const cmp = cmpBy(sort, key);
    const sorted = [...shown].sort((x, y) => (key === "done" ? 0 : Number(starred.has(projectOf(y))) - Number(starred.has(projectOf(x)))) || cmp(x, y));
    return { key, label: t(c.label), full, sorted, hidden: full.length - shown.length };
  });
  const ids = groups.flatMap((g) => g.sorted.map((i) => i.id));
  useListKeyboard(ids, selected, onSelect);
  if (issues.length === 0) return <EmptyView icon="tasks" title={t("没有符合条件的任务")} description={t("清除筛选，或按 {mod}T 手动建一条。")} />;
  const compact = !!selected;
  return (
    <div className="ld-list lst-tasks" role="listbox">
      {groups.filter((g) => g.full.length > 0).map((g) => {
        const urgent = g.key === "todo" ? g.full.filter((i) => i.priority <= 1).length : 0;
        return (
          <Section key={g.key} title={g.label} count={g.full.length} right={g.key === "todo" && urgent ? t("P0 到 P1 的 {n} 条", { n: urgent }) : g.key === "done" && !allDone ? t("最近 7 天") : undefined}>
            {g.sorted.map((i) => <Row key={i.id} id={i.id} data-task={i.id} selected={i.id === selected} onClick={() => onSelect(i.id)} onOpen={() => onSelect(i.id)} {...taskRow(i, { me, compact })} />)}
            {g.key === "done" && (g.hidden > 0 || allDone) && <button className="lst-more" onClick={() => setAllDone(!allDone)}>{allDone ? t("只看最近 7 天") : t("还有 {n} 项更早完成的", { n: g.hidden })}</button>}
          </Section>
        );
      })}
    </div>
  );
}

type SortKey = "id" | "title" | "status" | "assignee" | "priority" | "project" | "updated";
const STATUS_ORDER: Record<string, number> = { in_progress: 0, blocked: 1, open: 2, deferred: 3, closed: 4 };
export function TableView({ issues, selected, onSelect, me, rootOf, starred = new Set<string>() }: Common & { starred?: Set<string> }) {
  const t = useT();
  // Click a header to sort by it; click again to flip. Starred projects float up only in the default order.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  if (issues.length === 0) return <EmptyView icon="tasks" title={t("没有符合条件的任务")} />;
  const val = (i: Issue, k: SortKey): string | number => k === "id" ? i.id : k === "title" ? i.title : k === "status" ? (STATUS_ORDER[i.status] ?? 9) : k === "assignee" ? (actorOf(i.assignee, me)?.name ?? i.assignee ?? "") : k === "priority" ? i.priority : k === "project" ? projectOf(i) : i.updated_at;
  const rows = [...issues].sort((a, b) => {
    if (!sort) return Number(starred.has(projectOf(b))) - Number(starred.has(projectOf(a)));
    const x = val(a, sort.key), y = val(b, sort.key);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh")) * sort.dir;
  });
  const th = (k: SortKey, label: string) => <th className={`sortable${sort?.key === k ? " on" : ""}`} onClick={() => setSort(sort?.key === k ? (sort.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 })} title={t("点击排序，再点反向，第三次恢复默认")}>{label}{sort?.key === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}</th>;
  return (
    <div className="tw lst-table">
      <table>
        <thead><tr>{th("id", "ID")}{th("title", t("任务"))}<th>{t("源自")}</th>{th("status", t("状态"))}{th("assignee", t("负责"))}{th("priority", t("优先"))}{th("project", t("项目"))}<th>{t("依赖")}</th>{th("updated", t("更新"))}</tr></thead>
        <tbody>
          {rows.map((i) => {
            const who = actorOf(i.assignee, me);
            const root = rootOf?.(i.id);
            return (
              <tr data-task={i.id} key={i.id} className={selected === i.id ? "sel" : ""} onClick={() => onSelect(i.id)}>
                <td className="mono" title={t("任务编号：Beads 自动生成，前缀是板的名字（task），后面三位是随机编码，没有含义，只用来唯一标识")}>{i.id}</td>
                <td className="t" title={i.title}>{i.title}</td>
                <td>{root && <button className="root-link" onClick={(e) => { e.stopPropagation(); onSelect(root.id); }} title={root.title}><span className="mono">{root.id}</span></button>}</td>
                <td><StatusPill issue={i} sm /></td>
                <td>{who ? <span className="who-i"><Avatar actor={who} />{who.name}</span> : <span className="muted">{t("未认领")}</span>}</td>
                <td><Pri p={i.priority} /></td>
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

// ---- Agent 状态 (agents-knowledge package): list rows + Detail. Imports kept here so edits stay local.
import type { ReactNode } from "react";
import { Icon } from "./icons";
import { useActionTarget } from "./Shell";
import { DetailHead, DetailSection, revealDetail } from "./PageParts";
import { tildePath } from "../activity";

const SOURCE_ICON: Record<string, string> = { terminal: "⌘", desktop: "▣", editor: "◧", chat: "✉", cron: "⏱", unknown: "?" };
const OVERLAY: Record<string, string> = { tailscale: "Tailscale", netbird: "Netbird", zerotier: "ZeroTier" };
const sessionKey = (s: Session) => `${s.host ?? "local"}:${s.agent}:${s.session_id}`;
// Recent enough to list first: running, or alive and active in the last hour.
const isActiveSession = (s: Session) => s.state === "working" || (s.alive && Date.now() / 1000 - s.last_at < 3600);
type AgentSel = `host:${string}` | `agent:${string}` | `sched:${string}`;

// Agent 状态: one list (hosts, agents, delegations, scheduled sessions) and a Detail for the selected
// row. Hosts and agents used to be cards with every button on them; the buttons now live in the Detail,
// the bottom bar (↵ opens the agent's latest session) and ⌘K.
export function AgentsView({ agents, scheduled, apps, issues, me, onSelect, onFocus, refs, hosts, onOpenUrl, onCopyText, onDelegate }: { agents: AgentPresence[]; scheduled: Session[]; apps: string[]; issues: Issue[]; me: string; onSelect: (id: string) => void; onFocus: (sessionId: string) => void; refs: Map<string, SessionRef>; hosts: Host[]; onOpenUrl: (url: string) => void; onCopyText: (text: string, what: string) => void; onDelegate: (host: Host) => void }) {
  const t = useT();
  const locale = useLocale();
  useItemMenu("host", (id) => {
    const h = hosts.find((x) => x.id === id);
    if (!h) return null;
    return { title: h.name, items: [
      ...(h.online ? [{ label: t("派活：在这台起一个 Agent"), onClick: () => onDelegate(h) }] : []),
      { label: t("复制 ssh 地址"), onClick: () => onCopyText(h.ssh, t("ssh 地址")) },
      { label: t("复制 IP"), onClick: () => onCopyText(h.ip, "IP") },
      ...(h.screen_sharing && !h.local && !isWindows ? [{ label: t("看它的屏幕并操作"), onClick: () => onOpenUrl(h.vnc) }] : []),
      ...(h.novnc_up && h.novnc.startsWith("https://") && !isWindows ? [{ label: t("复制手机看屏幕链接（手机用）"), onClick: () => onCopyText(h.novnc, t("手机看屏幕的链接")) }] : []),
    ] };
  }, [hosts, onDelegate, onCopyText, onOpenUrl, locale]);
  useViewMenuExtras(hosts.filter((h) => h.online).map((h) => ({ label: t("在 {host} 派活", { host: h.name }), onClick: () => onDelegate(h) })), [hosts, locale]);
  // Files two live sessions both touched recently: rendered in red under each of them.
  const conflicts = conflictingFiles(agents.flatMap((a) => a.sessions));
  const shown = agents.filter((a) => a.online || a.current.length > 0);
  const quiet = agents.filter((a) => !a.online && !a.current.length);

  // 派活关系: tasks an agent handed out, and tasks handed to it, still open.
  const open = issues.filter((i) => i.status !== "closed");
  // A task an agent handed to another instance of itself is neither sent nor received; it shows once.
  const self = (i: Issue) => actorOf(delegatedBy(i), me)?.id === actorOf(delegatedTo(i), me)?.id;
  const relations = shown.map((a) => ({
    a,
    out: open.filter((i) => actorOf(delegatedBy(i), me)?.id === a.actor.id && !self(i)),
    got: open.filter((i) => actorOf(delegatedTo(i), me)?.id === a.actor.id && !self(i)),
    own: open.filter((i) => actorOf(delegatedTo(i), me)?.id === a.actor.id && self(i)),
  })).filter((r) => r.out.length || r.got.length || r.own.length);
  const nameOf = (who: string) => actorOf(who, me)?.name ?? who;

  const ids: AgentSel[] = [...hosts.map((h) => `host:${h.id}` as const), ...shown.map((a) => `agent:${a.actor.id}` as const), ...scheduled.map((s) => `sched:${s.session_id}` as const)];
  // Until a row is picked, the agent that is doing something is selected, so the Detail has the live
  // sessions in it (data arrives after the first render, so this is worked out every time).
  const [picked, setPicked] = useState<AgentSel | null>(null);
  const busy = shown.find((a) => a.sessions.some((s) => s.state === "working")) ?? shown.find((a) => a.sessions.length) ?? shown[0];
  const fallback: AgentSel | null = busy ? `agent:${busy.actor.id}` : ids[0] ?? null;
  const sel = picked && ids.includes(picked) ? picked : fallback;
  const selHost = sel?.startsWith("host:") ? hosts.find((h) => `host:${h.id}` === sel) : undefined;
  const selAgent = sel?.startsWith("agent:") ? shown.find((a) => `agent:${a.actor.id}` === sel) : undefined;
  const selSched = sel?.startsWith("sched:") ? scheduled.find((s) => `sched:${s.session_id}` === sel) : undefined;
  // The session ↵ opens: the agent's most recent one, or the scheduled session itself.
  const mainSession = selSched ?? (selAgent ? [...selAgent.sessions].sort((x, y) => Number(y.state === "working") - Number(x.state === "working") || y.last_at - x.last_at)[0] : undefined);
  const enter = (id: string) => {
    if (id.startsWith("host:")) { const h = hosts.find((x) => `host:${x.id}` === id); if (h?.online) onDelegate(h); return; }
    if (mainSession) onFocus(mainSession.session_id);
  };
  useListKeyboard(ids, sel, (id) => setPicked(id as AgentSel), { onEnter: enter });
  useActionTarget(mainSession ? { kind: "session", key: sessionKey(mainSession), primary: { label: t("打开会话"), run: () => onFocus(mainSession.session_id) } } : null, [mainSession?.session_id, mainSession?.host, locale]);
  const pick = (id: AgentSel) => { setPicked(id); revealDetail(); };

  const stateTag = (a: AgentPresence) => {
    const working = a.sessions.filter((s) => s.state === "working").length;
    if (a.actor.kind === "human") return <Tag>{t("你")}</Tag>;
    if (working) return <Tag color="green">{t("{n} 个在跑", { n: working })}</Tag>;
    if (a.sessions.length) {
      const idle = a.sessions.filter((s) => s.state === "idle" && s.registered).length, unk = a.sessions.length - idle;
      return <Tag title={unk ? t("{n} 个只见进程、看不到会话", { n: unk }) : undefined}>{idle ? t("{n} 空闲", { n: idle }) : t("{n} 个只见进程、看不到会话", { n: unk })}</Tag>;
    }
    return <Tag>{a.online ? t("在线") : t("离线")}</Tag>;
  };

  const sessionItem = (s: Session, withAgent = false) => {
    const r = refs.get(s.session_id);
    const ed = recentEdits(s);
    const ordered = [...ed].sort((x, y) => Number(conflicts.has(y.path)) - Number(conflicts.has(x.path)) || y.at - x.at);
    const own = selAgent?.current.find((i) => linkedSessions(i).includes(s.session_id));
    return (
      <div key={s.session_id} data-session={sessionKey(s)} className={`ak-sess ${s.state}`} title={t("{what} · {evidence} · 右键更多操作", { what: s.cwd || s.session_id, evidence: sessionEvidence(s) })}>
        <div className="ak-sess-l1">
          <span className={`src-ic ${s.source_kind}`} aria-hidden>{SOURCE_ICON[s.source_kind]}</span>
          <span className="ak-sess-t">{r?.title || s.title || s.project || t("未关联会话记录")}</span>
          <Tag color={s.state === "working" ? "green" : undefined}>{sessionStatus(s)}</Tag>
        </div>
        <div className="ak-sess-meta">
          {withAgent && <span>{actorOf(s.agent, "")?.name}</span>}
          <span>{s.state_source === "transcript" ? t("实际会话记录") : s.source_kind === "unknown" ? t("来源未识别") : s.source_app}</span>
          {s.remote && <span>{s.host_name}</span>}
          <span>{s.last_at ? t("{ago}活动", { ago: ago(s.last_at) }) : t("尚无活动上报")}</span>
        </div>
        {ordered.length > 0 && <div className="sess-edits ak-sess-edits" title={ordered.map((e) => e.path).join("\n")}>{t("正在改：")}{ordered.slice(0, 5).map((e, i) => <span key={e.path} className={conflicts.has(e.path) ? "conflict" : ""} title={`${e.path}${conflicts.has(e.path) ? t(" · 多个会话在改") : ""}`}>{i > 0 ? t("、") : ""}{basename(e.path)}</span>)}{ordered.length > 5 ? t(" 等 {n} 个", { n: ordered.length }) : ""}</div>}
        {own && <button className="link small linked-task" onClick={() => onSelect(own.id)}><span className="mono">{own.id}</span> {own.title}</button>}
        <div className="ak-sess-acts"><button className="btn sm" onClick={() => onFocus(s.session_id)} title={t("打开这段会话")}>{t("打开")}</button></div>
      </div>
    );
  };

  const hostDetail = (h: Host) => {
    const ways: { key: string; label: string; act: () => void; hint: string }[] = [];
    // From this Mac the natural thing is to open the other Mac's screen and drive it
    // (system Screen Sharing). The noVNC page is for the phone: a link to copy, never
    // to open here (opening your own screen inside itself just mirrors forever).
    // Screen sharing and the phone service are macOS-only for now.
    const macOnly = !isWindows;
    if (macOnly && h.screen_sharing && !h.local) ways.push({ key: "vnc", label: t("看它的屏幕并操作"), act: () => onOpenUrl(h.vnc), hint: t("用系统「屏幕共享」打开，能直接操作那台 Mac") });
    if (macOnly && h.novnc_up && h.novnc.startsWith("https://") && !h.local) ways.push({ key: "novnc", label: t("复制手机看屏幕链接 ⧉"), act: () => onCopyText(h.novnc, t("手机看屏幕的链接")), hint: t("发到手机上打开（手机需连着 Tailscale），用这台 Mac 的用户名和登录密码") });
    if (macOnly && h.local && h.novnc_up && h.novnc.startsWith("https://")) ways.push({ key: "novnc", label: t("看屏幕 ⧉"), act: () => onCopyText(h.novnc, t("屏幕链接已复制。在手机或另一台电脑上打开（在这台上打开自己会套娃）；对方先连上 Tailscale。")), hint: t("复制这台电脑的屏幕链接，给手机或另一台电脑用；在本机打开会套娃") });
    if (h.rustdesk) ways.push({ key: "rustdesk", label: h.rustdesk_id ? `RustDesk ${h.rustdesk_id} ⧉` : "RustDesk", act: () => (h.rustdesk_id ? onCopyText(h.rustdesk_id, "RustDesk ID") : onOpenUrl("rustdesk://")), hint: t("不用虚拟网：手机 RustDesk 输这个 ID") });
    if (h.sunshine) ways.push({ key: "moonlight", label: t("Moonlight 配对"), act: () => onOpenUrl(h.sunshine_ui), hint: t("打开 Sunshine 配对页；手机装 Moonlight，画质最高") });
    if (h.uu) ways.push({ key: "uu", label: t("UU远程"), act: () => onOpenUrl("/Applications"), hint: t("已装网易UU远程；它没有接口，去它里面连") });
    const here = shown.flatMap((a) => a.sessions).filter((s) => (h.local ? !s.remote : s.host === h.id || s.host_name === h.name));
    return (
      <div className="ak-detail" data-menu="host" data-id={h.id}>
        <DetailHead crumb={[t("主机"), h.local ? t("本机") : ""]} title={h.name} tag={<Tag color={h.online ? "green" : undefined}>{h.online ? t("在线") : t("离线")}</Tag>}
          actions={<>
            {h.online && <button className="btn sm" onClick={() => onDelegate(h)} title={t("在这台机器的 Dispatch 里起一个 Agent，可以把任务派给它")}>{t("派活")}</button>}
            {ways.map((w) => <button key={w.key} className="btn sm" onClick={w.act} title={w.hint}>{w.label}</button>)}
          </>} />
        <Meta rows={[
          ...(h.ip ? [["IP", <span className="mono sel-text">{h.ip}</span>] as [ReactNode, ReactNode]] : []),
          ...(h.ssh ? [["ssh", <button className="link mono" onClick={() => onCopyText(h.ssh, t("ssh 地址"))} title={t("复制 ssh 地址")}>{h.ssh}</button>] as [ReactNode, ReactNode]] : []),
          ...(h.overlay?.kind ? [[t("虚拟网"), OVERLAY[h.overlay.kind] ?? h.overlay.kind] as [ReactNode, ReactNode]] : []),
          [t("会话"), t("{n} 个", { n: here.length })],
        ]} />
        {(h.novnc_issue || (ways.length === 0 && h.why)) && <><Sep /><p className="akd-note">{h.novnc_issue || h.why}</p></>}
        {h.local && apps.length > 0 && <><Sep /><DetailSection title={t("正在运行的应用")} count={apps.length}><p className="akd-note">{apps.join(" · ")}</p></DetailSection></>}
      </div>
    );
  };

  const agentDetail = (a: AgentPresence) => {
    const activeList = a.sessions.filter(isActiveSession);
    const older = a.sessions.filter((s) => !isActiveSession(s));
    const rel = relations.find((r) => r.a.actor.id === a.actor.id);
    const noneWhy = a.actor.kind === "zcode" ? t("（ZCode 没开，或 30 分钟内没有会话活动）") : a.actor.kind === "opencode" ? t("（没有在跑的 opencode 进程，或 30 分钟内没有会话活动）") : a.actor.kind === "hermes" ? t("（这台电脑上没有在跑的 Hermes，或 30 分钟内没有未结束的会话）") : a.actor.kind === "gemini" ? t("（没有在跑的 gemini 进程）") : "";
    return (
      <div className="ak-detail">
        <DetailHead crumb={[t("Agent")]} icon={<Avatar actor={a.actor} online={a.online} />} title={a.actor.name} tag={stateTag(a)} />
        <Meta rows={[
          ["ID", <span className="mono">{a.actor.id}</span>],
          ...(a.lastActive ? [[t("最近写入"), relTime(a.lastActive)] as [ReactNode, ReactNode]] : []),
          ...(a.bySource.length ? [[t("来源"), <span className="ak-src">{a.bySource.map((b) => <span key={b.label + b.kind} title={t(SOURCE_LABEL[b.kind])}>{t(SOURCE_LABEL[b.kind])}{b.label && b.label !== SOURCE_LABEL[b.kind] ? ` · ${b.label}` : ""} <b>{b.count}</b>{b.working ? <span className="pulse" title={t("在跑")} /> : null}</span>)}</span>] as [ReactNode, ReactNode]] : []),
          ...(a.daemon ? [[t("常驻"), a.daemon] as [ReactNode, ReactNode]] : []),
        ]} />
        {a.actor.kind !== "human" && <>
          <Sep />
          <DetailSection title={t("会话")} count={a.sessions.length}>
            {a.sessions.length === 0 && <p className="akd-note">{t("没有检测到会话")}{noneWhy}</p>}
            {activeList.map((s) => sessionItem(s))}
            {activeList.length === 0 && older.length > 0 && <p className="akd-note">{t("现在没有活跃会话")}</p>}
            {older.length > 0 && <details className="older-sessions ak-fold"><summary>{t("更早的会话 · {n}", { n: older.length })}<span className="muted small">{t(" · 一小时内没动静；完整历史在会话页")}</span></summary>{older.map((s) => sessionItem(s))}</details>}
          </DetailSection>
        </>}
        {a.current.length > 0 && <><Sep /><DetailSection title={t("关联进行中任务")} count={a.current.length}>
          {a.current.map((i) => <button key={i.id} className="ak-task" onClick={() => onSelect(i.id)}><span className="t">{i.title}</span><span className="mono s">{i.id}{delegatedBy(i) ? t(" · ← {who} 派的", { who: nameOf(delegatedBy(i)) }) : ""}</span></button>)}
        </DetailSection></>}
        {rel && <><Sep /><DetailSection title={t("派活")}>
          {[...rel.out.map((i) => ({ i, text: `→ ${nameOf(delegatedTo(i))}` })), ...rel.own.map((i) => ({ i, text: "↻" })), ...rel.got.map((i) => ({ i, text: `← ${nameOf(delegatedBy(i))}` }))].map(({ i, text }) => (
            <button key={i.id + text} className="ak-task" onClick={() => onSelect(i.id)}><span className="t">{text} · {i.title}</span><span className="mono s">{i.id}</span></button>
          ))}
        </DetailSection></>}
      </div>
    );
  };

  const schedDetail = (s: Session) => (
    <div className="ak-detail">
      <DetailHead crumb={[t("定时会话")]} title={s.title || s.project || s.cwd} tag={<Tag color="purple">{t("定时")}</Tag>} actions={<button className="btn sm" onClick={() => onFocus(s.session_id)}>{t("打开")}</button>} />
      <Meta rows={[
        ["Agent", actorOf(s.agent, "")?.name ?? s.agent],
        ...(s.remote ? [[t("主机"), s.host_name ?? ""] as [ReactNode, ReactNode]] : []),
        [t("状态"), sessionStatus(s)],
        ...(s.last_at ? [[t("最近活动"), ago(s.last_at)] as [ReactNode, ReactNode]] : []),
        ...(s.cwd ? [[t("目录"), <span className="mono">{tildePath(s.cwd)}</span>] as [ReactNode, ReactNode]] : []),
      ]} />
      <Sep />
      <p className="akd-note">{t("不计入在跑、未读和通知")}</p>
    </div>
  );

  const detail = selHost ? hostDetail(selHost) : selAgent ? agentDetail(selAgent) : selSched ? schedDetail(selSched) : null;
  return (
    <ListDetail className="ak-page ak-agents" detail={detail}>
      {hosts.length === 0 && shown.length === 0 && <EmptyView icon="agent" title={t("没有检测到 Agent")} description={t("Agent 开始工作后会出现在这里。")} />}
      {hosts.length > 0 && (
        <Section title={t("主机")} count={hosts.length}>
          {hosts.map((h) => (
            <Row key={h.id} id={`host:${h.id}`} data-menu="host" data-id={h.id} selected={sel === `host:${h.id}`} onClick={() => pick(`host:${h.id}`)} onOpen={() => enter(`host:${h.id}`)} tooltip={h.why || undefined}
              icon={<span className="ak-host-ic"><Icon name="screen" /><i className={h.online ? "on" : ""} /></span>}
              title={h.name}
              accessories={[...(h.local ? [<Tag>{t("本机")}</Tag>] : []), <Tag color={h.online ? "green" : undefined}>{h.online ? t("在线") : t("离线")}</Tag>]} />
          ))}
        </Section>
      )}
      {shown.length > 0 && (
        <Section title="Agent" count={shown.length}>
          {shown.map((a) => (
            <Row key={a.actor.id} id={`agent:${a.actor.id}`} className={a.online || a.actor.kind === "human" ? "" : "ak-off"} selected={sel === `agent:${a.actor.id}`} onClick={() => pick(`agent:${a.actor.id}`)} onOpen={() => enter(`agent:${a.actor.id}`)}
              icon={<Avatar actor={a.actor} online={a.online} />} title={a.actor.name}
              accessories={[stateTag(a), ...(a.lastActive ? [relTime(a.lastActive)] : [])]} />
          ))}
        </Section>
      )}
      {relations.length > 0 && (
        <div className="agent-delegations">
          <Section title={t("派活关系")} count={relations.length}>
            {relations.map(({ a, out, got, own }) => (
              <Row key={a.actor.id} selected={false} onClick={() => pick(`agent:${a.actor.id}`)} icon={<Avatar actor={a.actor} />} title={`${a.actor.name}　${[
                  out.length ? `${t("派出 {n}", { n: out.length })} ${out.map((i) => `→ ${nameOf(delegatedTo(i))} · ${i.title.slice(0, 28)}`).join(t("，"))}` : "",
                  own.length ? `${t("自派 {n}", { n: own.length })} ${own.map((i) => `↻ ${i.title.slice(0, 28)}`).join(t("，"))}` : "",
                  got.length ? `${t("接到 {n}", { n: got.length })} ${got.map((i) => `← ${nameOf(delegatedBy(i))} · ${i.title.slice(0, 28)}`).join(t("，"))}` : "",
                ].filter(Boolean).join(t("；"))}`} />
            ))}
          </Section>
        </div>
      )}
      {scheduled.length > 0 && (
        <Section title={t("定时会话")} count={scheduled.length} right={t("不计入在跑、未读和通知")}>
          {scheduled.map((s) => (
            <Row key={s.session_id} id={`sched:${s.session_id}`} data-session={sessionKey(s)} selected={sel === `sched:${s.session_id}`} onClick={() => pick(`sched:${s.session_id}`)} onOpen={() => onFocus(s.session_id)}
              icon={<Icon name="cal" />} title={s.title || s.project || s.cwd}
              accessories={[<Tag color={s.state === "working" ? "green" : undefined}>{sessionStatus(s)}</Tag>, ...(s.last_at ? [ago(s.last_at)] : [])]} />
          ))}
        </Section>
      )}
      {quiet.length > 0 && (
        <Section title={t("未检测到活动的 Agent")} count={quiet.length}>
          <Row className="ak-off" icon={<Icon name="agent" />} title={quiet.map((a) => a.actor.name).join(" · ")} />
        </Section>
      )}
    </ListDetail>
  );
}
