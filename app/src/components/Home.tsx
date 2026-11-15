import { useMemo, useState, type ReactNode } from "react";
import { actorOf } from "../derive";
import { UNGROUPED_PROJECT, activityKey, conversationProject, conversationSummary } from "../activity";
import { acceptanceOf, homeModel, type SessionItem } from "../homeModel";
import type { ProjectFlags } from "../projectFlags";
import type { Activity, Issue, View } from "../types";
import type { InboxItems } from "./Inbox";
import { Avatar } from "./ui";
import { useViewMenuExtras } from "./ContextMenu";
import { t as tr, useLocale, useT } from "../i18n";
import { isWindows } from "../platform";
import { EmptyView, ListDetail, Meter, Row, Section, Tag, useListKeyboard } from "./primitives";
import { useActionTarget, useShellHeader } from "./Shell";
import { Icon } from "./icons";
import { SessionRow, TaskBrief, firstLine, since, useTaskRow, useNarrow, useUnreadDigests } from "./ListRows";
import { HomeDetail, digestOf, stepOf } from "./HomeDetail";


const sessionKey = (s: { host?: string; agent: string; session_id: string }) => `${s.host ?? "local"}:${s.agent}:${s.session_id}`;

function untilText(epoch: number | null): string {
  if (!epoch) return "";
  if (epoch * 1000 < Date.now()) return tr("已过重置时间");
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  if (m < 60) return tr("{m}m 后重置", { m });
  const h = Math.floor(m / 60);
  return h < 48 ? tr("{h}h{m} 后重置", { h, m: String(m % 60).padStart(2, "0") }) : tr("{d}d 后重置", { d: Math.round(h / 24) });
}

export function QuotaBar({ w }: { w: { label: string; used_percent: number | null; resets_at: number | null } }) {
  useLocale();  // untilText() is module-level t(); subscribe so the bar re-renders on a language change
  const p = w.used_percent ?? 0;
  const cls = p >= 90 ? "crit" : p >= 70 ? "warn" : "";
  return (
    <div className={`quota ${cls}`} title={untilText(w.resets_at)}>
      <span className="ql">{w.label}</span>
      <span className="qbar"><i style={{ width: `${Math.min(100, p)}%` }} /></span>
      <span className="qv mono">{w.used_percent === null ? "?" : `${Math.round(p)}%`}</span>
      <span className="qr muted small">{untilText(w.resets_at)}</span>
    </div>
  );
}




interface Props {
  me: string;
  loaded: boolean;
  connectionError: boolean;
  unavailable: string[];
  rows: Activity[];
  issues: Issue[];
  outcomes: Issue[];
  inbox: InboxItems;
  progress: Record<string, string>;
  flags: ProjectFlags;
  archiveDays: number;
  /** Kept for the settings field 工作台默认展开几个项目; the list has nothing to fold any more. */
  expandedDefault?: number;
  onFlag: (name: string, change: { starred?: boolean; archived?: boolean }) => void;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onTask: (id: string | null) => void;
  onProject: (name: string) => void;
  onView: (v: View) => void;
  onNew: (a?: Activity) => void;
  onLocate?: (projectName: string, section: "review" | "sessions") => void;
  onDiscuss?: () => void;
  onScreen?: () => void;
  screenReady?: boolean;
  /** The task open in the app's Detail; while one is, ↑↓ belong to it and this page's own Detail hides. */
  selectedTask?: string | null;
  onDigest?: (a: Activity) => Promise<void>;
}

// 等你 shows about this many rows: every 要确认 / 问你, then plain replies (at least two) until the
// count is reached; the rest fold into one line 「还有 N 条只是没看的回复」.
const WAITING_SHOWN = 6;
// 在跑 shows this many rows; the rest fold into one line 「还有 N 个在跑」.
export const RUNNING_SHOWN = 5;

type Item = { id: string; kind: "session"; x: SessionItem } | { id: string; kind: "task"; i: Issue };

/** The row's name: the short name (title_override, else the agent's own title) the snapshot already folds into `title`. */
export function nameOf(x: SessionItem): string {
  return x.a?.title || x.s?.title || x.s?.cwd.split(/[\\/]/).pop() || x.s?.session_id || "";
}

// 工作台 v2: a conversation per row, sorted by what it needs from you. 等你 (要确认 and 问你 first,
// orange; plain replies blue, the surplus folded into one line), 在跑, 今天做完的, and the P1 tasks
// nobody took. The Detail on the right shows the decision itself: the command and 允许 / 拒绝, or
// the question. A click selects, ↵ or a double click opens; the bottom bar shows that main action.
export function HomeView({ onDiscuss, me, loaded, unavailable, rows, issues, inbox, progress, onOpen, onFocus, onTask, onView, onNew, onScreen, screenReady, selectedTask, onDigest }: Props) {
  const t = useT();
  const taskRow = useTaskRow();
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);
  useUnreadDigests(inbox.unread, onDigest);

  const m = useMemo(() => homeModel({ waiting: inbox.waiting, unread: inbox.unread, running: inbox.running, read: inbox.read, rows, issues }), [inbox, rows, issues]);
  const shownDelivered = expanded ? m.delivered : m.delivered.slice(0, Math.max(2, WAITING_SHOWN - m.urgent.length));
  const hiddenDelivered = m.delivered.length - shownDelivered.length;
  const shownRunning = runExpanded ? m.running : m.running.slice(0, RUNNING_SHOWN);
  const hiddenRunning = m.running.length - shownRunning.length;
  const waitingCount = m.urgent.length + m.delivered.length;

  const S = (x: SessionItem): Item => ({ id: x.id, kind: "session", x });
  const sections: { key: string; title: string; count: number; right?: ReactNode; items: Item[]; after?: ReactNode }[] = [
    { key: "you", title: t("等你"), count: waitingCount, right: m.urgent.length ? t("要确认、问你的排前面") : undefined, items: [...m.urgent, ...shownDelivered].map(S),
      after: hiddenDelivered > 0 ? <button className="lst-more" onClick={() => setExpanded(true)}>{t("还有 {n} 条只是没看的回复", { n: hiddenDelivered })}<Icon name="right" size={12} /></button>
        : expanded && m.delivered.length > Math.max(2, WAITING_SHOWN - m.urgent.length) ? <button className="lst-more" onClick={() => setExpanded(false)}>{t("收起")}<Icon name="down" size={12} /></button> : undefined },
    { key: "run", title: t("在跑"), count: m.running.length, items: shownRunning.map(S),
      after: hiddenRunning > 0 ? <button className="lst-more" onClick={() => setRunExpanded(true)}>{t("还有 {n} 个在跑", { n: hiddenRunning })}<Icon name="right" size={12} /></button>
        : runExpanded && m.running.length > RUNNING_SHOWN ? <button className="lst-more" onClick={() => setRunExpanded(false)}>{t("收起")}<Icon name="down" size={12} /></button> : undefined },
    { key: "today", title: t("今天做完的"), count: m.today.length, right: t("看过了，留着对一眼"), items: m.today.map(S) },
    { key: "task", title: t("没人在做的任务"), count: m.unowned.length + m.unownedP2,
      right: <button className="lsec-link" onClick={() => onView("board")}>{m.unownedP2 ? t("只列 P1 · 还有 {n} 项 P2", { n: m.unownedP2 }) : t("全部任务")}<Icon name="right" size={10} /></button>,
      items: m.unowned.slice(0, 6).map((i): Item => ({ id: `t:${i.id}`, kind: "task", i })) },
  ].filter((s) => s.items.length > 0);
  const items = sections.flatMap((s) => s.items);
  const ids = items.map((x) => x.id);

  useShellHeader({ subtitle: [t("{n} 等你", { n: waitingCount }), t("{n} 在跑", { n: m.running.length }), t("{n} 今天做完", { n: m.today.length })].join(" · ") }, [waitingCount, m.running.length, m.today.length, t]);

  const [picked, setPicked] = useState<string | null>(null);
  // Raycast keeps a row selected: the first one until the person picks another. A task opened in the
  // app's Detail is selected here too, so the list and the Detail agree.
  const sel = selectedTask && ids.includes(`t:${selectedTask}`) ? `t:${selectedTask}` : picked && ids.includes(picked) ? picked : ids[0] ?? null;
  const current = items.find((x) => x.id === sel) ?? null;

  const open = (x: Item | null) => {
    if (!x) return;
    if (x.kind === "task") return onTask(x.i.id);
    const sid = x.x.a?.session_id ?? x.x.s!.session_id;
    return sid.startsWith("pid-") ? onFocus(sid) : onOpen(sid);
  };
  const byId = (id: string) => items.find((x) => x.id === id) ?? null;
  useListKeyboard(ids, sel, setPicked, { onEnter: (id) => open(byId(id)), enabled: !selectedTask });

  useActionTarget(!current ? null
    : current.kind === "task" ? { kind: "task", id: current.i.id, primary: { label: t("打开任务"), run: () => open(current) } }
    : { kind: "session", key: current.x.a ? activityKey(current.x.a) : sessionKey(current.x.s!), primary: { label: current.x.verb === "running" || current.x.verb === "done" ? t("打开会话") : t("查看并回复"), run: () => open(current) } },
    [sel, current?.kind === "session" ? current.x.verb : null]);

  // Right-click on empty space: what the old header buttons and links did.
  useViewMenuExtras([
    ...(onDiscuss ? [{ label: t("讨论一个念头"), icon: "discuss", onClick: onDiscuss }] : []),
    ...(onScreen && !isWindows && screenReady ? [{ label: t("复制屏幕链接"), icon: "eye", onClick: onScreen }] : []),
  ], [onDiscuss, onScreen, screenReady]);

  const click = (x: Item) => () => { if (narrow) return open(x); setPicked(x.id); if (selectedTask && x.kind !== "task") onTask(null); if (x.kind === "task" && selectedTask) onTask(x.i.id); };

  const sessionRow = (item: Item & { kind: "session" }) => {
    const { x } = item;
    const a = x.a;
    const who = actorOf(a?.agent ?? x.s?.agent, me);
    const project = a ? conversationProject(a) : x.s?.project || "";
    let verb = "", line = "", mono = false;
    let tag: ReactNode = null;
    let meter: ReactNode = null;
    if (x.verb === "confirm") {
      verb = t("要确认"); line = stepOf(a?.activity) || t("停在权限框上，等你点头"); mono = !!stepOf(a?.activity);
      tag = <Tag color="orange">{t("要确认")}</Tag>;
    } else if (x.verb === "ask") {
      verb = t("问你"); line = a?.question || stepOf(a?.activity).replace(/^等你回答：?/, "") || firstLine(a?.reply_preview);
      tag = <Tag color="orange">{t("问你")}</Tag>;
    } else if (x.verb === "delivered" || x.verb === "done") {
      verb = t("交了"); line = firstLine(digestOf(a)) || (a ? conversationSummary(a) : "");
      tag = x.verb === "delivered" ? <Tag color="blue">{t("未读")}</Tag> : null;
    } else {
      verb = t("在做"); line = (a?.activity ?? "").replace(/^已执行 · /, "") || t("正在处理");
      const subs = a?.background_agents?.length ?? 0;
      if (subs && !/子 Agent/.test(line)) line += ` · ${t("子 Agent {n} 个在跑", { n: subs })}`;
      const ac = acceptanceOf(a, issues);
      if (ac) meter = <Meter value={ac.done} max={ac.total} />;
      tag = <Tag color="green" dot>{t("在跑")}</Tag>;
    }
    const files = x.verb === "done" ? Object.keys(a?.files ?? {}).length : 0;
    const name = nameOf(x);
    return <SessionRow key={item.id} id={item.id} selected={item.id === sel} quiet={x.verb === "done"} onClick={click(item)} onOpen={() => open(item)}
      data-session={a ? activityKey(a) : sessionKey(x.s!)} icon={<Avatar actor={who} />} name={name} verb={verb} line={line} mono={mono} meter={meter} tooltip={name}
      accessories={[...(project ? [<Tag>{project === UNGROUPED_PROJECT ? t(project) : project}</Tag>] : []), ...(tag ? [tag] : []), ...(files ? [<span>{t("{n} 文件", { n: files })}</span>] : []), <span className="num">{since(x.at) || t("刚刚")}</span>]} />;
  };

  const taskRowEl = (item: Item & { kind: "task" }) => {
    const r = taskRow(item.i, { me });
    return <Row key={item.id} id={item.id} selected={item.id === sel} onClick={click(item)} onOpen={() => open(item)} data-task={item.i.id} {...r} />;
  };

  const detail = narrow || selectedTask || !current ? null
    : current.kind === "task" ? <TaskBrief issue={current.i} me={me} progress={progress} />
    : <HomeDetail item={current.x} name={nameOf(current.x)} me={me} issues={issues} onOpen={() => open(current)} onTask={(id) => onTask(id)} />;

  if (!loaded && items.length === 0) return <EmptyView icon="refresh" title={t("正在读取项目与会话…")} />;
  if (items.length === 0) return <EmptyView icon="check" title={t("现在没有要你处理的事")} description={t("新回复、在跑的会话和没人认领的 P1 任务都会出现在这里。")} actions={<button className="btn" onClick={() => onNew()}>{t("新建会话")}</button>} />;

  return (
    <ListDetail className="lst-page home-v2" detail={detail}>
      {unavailable.length > 0 && <div className="lst-note">{t("{hosts} 暂时连不上", { hosts: unavailable.join(t("、")) })}</div>}
      {sections.map((s) => (
        <Section key={s.key} title={s.title} count={s.count} right={s.right}>
          {s.items.map((x) => (x.kind === "task" ? taskRowEl(x) : sessionRow(x)))}
          {s.after}
        </Section>
      ))}
    </ListDetail>
  );
}
