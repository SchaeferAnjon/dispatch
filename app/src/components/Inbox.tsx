import { useMemo, useState, type ReactNode } from "react";
import { activityKey, conversationProject } from "../activity";
import { acceptanceProgress, actorOf, issueAcceptance, relTime, sessionStatus } from "../derive";
import type { Activity, Issue, Session } from "../types";
import { Avatar } from "./ui";
import { useT } from "../i18n";
import { EmptyView, ListDetail, Meter, Row, Section, Tabs, Tag, useListKeyboard } from "./primitives";
import { useActionTarget } from "./Shell";
import { ActivityBrief, SessionBrief, TaskBrief, since, useNarrow, useTaskRow, useUnreadDigests } from "./ListRows";

export interface InboxItems { unread: Activity[]; running: Activity[]; read: Activity[]; waiting: Session[]; idle: Session[]; review: Issue[]; blocked: Issue[] }

interface Props { onSummarize?: (a: Activity) => Promise<void>; onDigest?: (a: Activity) => Promise<void>; onRead: (a: Activity) => Promise<void>; onOpen: (id: string) => void; initialTab?: keyof InboxItems | null; items: InboxItems; me: string; onSelect: (id: string) => void; onFocus: (sessionId: string) => void; selectedTask?: string | null; taskTitle?: (id: string) => string | undefined }

type Tab = keyof InboxItems;
type Item = { id: string; kind: "activity"; a: Activity } | { id: string; kind: "session"; s: Session } | { id: string; kind: "task"; i: Issue };
const sessionKey = (s: Session) => `${s.host ?? "local"}:${s.agent}:${s.session_id}`;

// The one screen that answers "what needs me right now", as the workbench's rows: sessions that
// stopped and wait for input, unread replies, finished work awaiting review, blocked tasks. The
// old per-row buttons live in the bottom bar (查看并回复 ↵) and in ⌘K (标记已读, 总结, …).
export function InboxView({ onDigest, onRead, onOpen, initialTab, items, me, onSelect, onFocus, selectedTask, taskTitle }: Props) {
  const t = useT();
  const taskRow = useTaskRow();
  const narrow = useNarrow();
  const [tab, setTab] = useState<Tab>(() => initialTab ?? "unread");
  const [readingAll, setReadingAll] = useState(false);
  const readAll = async () => { setReadingAll(true); try { for (const a of items.unread) if (a.reply_id) await onRead(a); } finally { setReadingAll(false); } };
  useUnreadDigests(tab === "unread" ? items.unread : [], onDigest);

  const TABS: [Tab, string, string?][] = [["unread", t("未读回复")], ["running", t("在跑")], ["read", t("已读")], ["waiting", t("等待确认")], ["blocked", t("被卡住")], ["review", t("Agent 复核"), t("仅包含明确发起的复核请求，不计入你的待处理数量")], ["idle", t("空闲会话"), t("不计入待处理数量，也不会触发通知")]];

  // Sections of the current tab. Unread replies group by project; the rest is one section.
  const sections = useMemo<{ key: string; title: ReactNode; right?: ReactNode; items: Item[] }[]>(() => {
    const act = (a: Activity): Item => ({ id: `a:${activityKey(a)}`, kind: "activity", a });
    if (tab === "unread") {
      const projects = [...new Set(items.unread.map(conversationProject))];
      return projects.map((p) => ({ key: p, title: p, items: items.unread.filter((a) => conversationProject(a) === p).map(act) }));
    }
    if (tab === "running" || tab === "read") return [{ key: tab, title: tab === "read" ? t("最近七天读过的回复") : t("在跑"), items: items[tab].map(act) }];
    if (tab === "waiting" || tab === "idle") return [{ key: tab, title: tab === "idle" ? t("空闲会话") : t("需要处理"), right: tab === "idle" ? t("不计入待处理数量，也不会触发通知") : t("只有接入事件上报的会话会出现在这里"), items: items[tab].map((s): Item => ({ id: `s:${sessionKey(s)}`, kind: "session", s })) }];
    return [{ key: tab, title: tab === "review" ? t("Agent 复核") : t("被卡住"), right: tab === "review" ? t("不计入你的待处理数量") : t("等依赖完成会自动解开"), items: items[tab].map((i): Item => ({ id: `t:${i.id}`, kind: "task", i })) }];
  }, [tab, items, t]);
  const list = sections.flatMap((s) => s.items);
  const ids = list.map((x) => x.id);
  const [picked, setPicked] = useState<string | null>(null);
  const sel = selectedTask && ids.includes(`t:${selectedTask}`) ? `t:${selectedTask}` : picked && ids.includes(picked) ? picked : ids[0] ?? null;
  const current = list.find((x) => x.id === sel) ?? null;

  const open = (x: Item | null) => {
    if (!x) return;
    if (x.kind === "activity") return onOpen(x.a.session_id);
    if (x.kind === "session") return x.s.session_id.startsWith("pid-") ? onFocus(x.s.session_id) : onOpen(x.s.session_id);
    onSelect(x.i.id);
  };
  useListKeyboard(ids, sel, setPicked, { onEnter: (id) => open(list.find((x) => x.id === id) ?? null), enabled: !selectedTask });
  useActionTarget(!current ? null
    : current.kind === "activity" ? { kind: "session", key: activityKey(current.a), primary: { label: t("查看并回复"), run: () => open(current) } }
    : current.kind === "session" ? { kind: "session", key: sessionKey(current.s), primary: { label: t("查看并回复"), run: () => open(current) } }
    : { kind: "task", id: current.i.id, primary: { label: tab === "review" ? t("查看验收") : t("打开任务"), run: () => open(current) } }, [sel, tab]);

  const rowProps = (x: Item): Parameters<typeof Row>[0] => {
    const base = { id: x.id, selected: x.id === sel, onClick: () => (narrow ? open(x) : setPicked(x.id)), onOpen: () => open(x) };
    if (x.kind === "activity") {
      const a = x.a;
      const live = a.state === "working" && !a.stale;
      // Unread is a 6px blue dot before a 500 title, not a tag on every row; only 在跑 keeps one.
      return { ...base, className: a.unread ? undefined : "read", "data-session": activityKey(a), icon: <Avatar actor={actorOf(a.agent, me)} />, title: a.unread ? <><span className="udot" aria-label={t("未读")} />{a.title}</> : a.title, accessories: [...(tab !== "unread" ? [<span>{conversationProject(a)}</span>] : []), ...(live ? [<Tag color="green" dot>{t("在跑")}</Tag>] : []), <span className="num tm">{since(a.last_at)}</span>] } as Parameters<typeof Row>[0];
    }
    if (x.kind === "session") {
      const s = x.s;
      const who = actorOf(s.agent, me);
      return { ...base, "data-session": sessionKey(s), icon: <Avatar actor={who} />, title: s.title || s.project || s.cwd || s.session_id, accessories: [<Tag color={tab === "waiting" ? "orange" : undefined}>{sessionStatus(s)}</Tag>, <span className="num tm">{since(s.last_at)}</span>] } as Parameters<typeof Row>[0];
    }
    const i = x.i;
    const r = taskRow(i, { me, compact: true });
    if (tab === "review") {
      const prog = acceptanceProgress(issueAcceptance(i));
      // How far the acceptance got is the one thing this tab is about: a meter, or a tag when there is none.
      const ac = prog.total ? <Meter value={prog.done} max={prog.total} /> : <Tag>{t("未填写验收标准")}</Tag>;
      return { ...base, "data-task": i.id, ...r, accessories: [ac, <span className="num tm">{relTime(i.closed_at ?? i.updated_at)}</span>] } as Parameters<typeof Row>[0];
    }
    return { ...base, "data-task": i.id, ...r } as Parameters<typeof Row>[0];
  };

  const total = items.unread.length + items.waiting.length + items.blocked.length;
  const detail = narrow || selectedTask || !current ? null
    : current.kind === "activity" ? <ActivityBrief a={current.a} me={me} taskTitle={taskTitle} onTask={onSelect} />
    : current.kind === "session" ? <SessionBrief s={current.s} me={me} />
    : <TaskBrief issue={current.i} me={me} />;
  const empty = total === 0 && (tab === "unread" || tab === "waiting" || tab === "blocked")
    ? <EmptyView icon="check" title={t("暂时没有等我的事项")} description={t("新回复会出现在这里；读到最新后自动移出。")} />
    : <EmptyView icon="inbox" title={tab === "read" ? t("最近七天没有读过的回复") : tab === "running" ? t("现在没有在跑的会话") : t("这个分类没有待处理事项")} />;

  return (
    <ListDetail className="lst-page" detail={list.length ? detail : null}
      tabs={<Tabs items={TABS.map(([key, label, title]) => ({ key, label, count: items[key].length, title }))} value={tab} onChange={(k) => { setTab(k); setPicked(null); }}
        right={tab === "unread" && items.unread.length > 1 ? <button className="dd" disabled={readingAll} onClick={() => void readAll()}>{readingAll ? t("标记中…") : t("全部标记已读")}</button> : undefined} />}>
      {list.length === 0 ? empty : sections.map((s) => (
        <Section key={s.key} title={s.title} count={s.items.length} right={s.right}>
          {s.items.map((x) => <Row key={x.id} {...rowProps(x)} />)}
        </Section>
      ))}
    </ListDetail>
  );
}
