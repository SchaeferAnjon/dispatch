/*
 * Rows and Detail panes shared by the list pages (工作台, 等我, 全部任务 · 列表). Built on
 * primitives.tsx: every page shows a task, a conversation or a project the same way.
 *
 *   taskRowProps(issue, { me, compact })            icon, title, accessories for <Row>
 *   <TaskIcon issue me />                             assignee avatar, else the project glyph
 *   <ProjectGlyph name />                             20px coloured square with the first letter
 *   <ActivityBrief a me /> <SessionBrief s me /> <TaskBrief issue me progress /> <ProjectBrief …/>
 *                                                     Detail pane bodies (380px column)
 *   useUnreadDigests(rows, onDigest)                  asks once per reply for the "this turn" digest
 */
import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { acceptanceProgress, actorOf, ago, issueAcceptance, projectOf, relTime, sessionStatus, statusLabel } from "../derive";
import { conversationProject, conversationSummary, UNGROUPED_PROJECT } from "../activity";
import { glyphStyle } from "../derive";
import type { Activity, Issue, Session } from "../types";
import { useT } from "../i18n";
import { Avatar, Pri, STATUS_TONE } from "./ui";
import { Meta, Meter, Sep, Tag } from "./primitives";
import { Markdown } from "./Markdown";
import { AssignProjectButton } from "./AssignProject";

/** Compact age for accessories: "3m", "2h", "1d" (relTime on an epoch in seconds). */
export const since = (epochSec: number | undefined) => (epochSec ? relTime(new Date(epochSec * 1000).toISOString()) : "");
/** For Detail metadata: "26 分钟前 · 18:02". */
export const when = (epochSec: number | undefined) => {
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  return `${ago(epochSec)} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** The short part of a task id for tight rows: task-nv3 → nv3. */
export const shortId = (id: string) => id.replace(/^[a-z]+-/, "");
/** A reply preview as plain prose for the Detail: no code blocks, no markdown marks, at most `max` characters. */
export function plainPreview(text: string, max = 600): string {
  const s = (text || "").replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#+|>|[-*]|\d+\.)[ \t]+/gm, "").replace(/[*_`]/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
/** First non-empty line, markdown marks stripped. */
export const firstLine = (s?: string | null) => (s ?? "").split(/\n|\\n/).map((l) => l.replace(/[#*`>_]/g, "").trim()).find(Boolean) ?? "";


/** 20px (or 16px `small`) project square: the project's hue at tag strength, the letter in the full hue. */
export function ProjectGlyph({ name, small, title }: { name: string; small?: boolean; title?: string }) {
  const label = name && name !== UNGROUPED_PROJECT ? name : "·";
  return <span className={`pj${small ? " sm" : ""}`} style={glyphStyle(name && name !== UNGROUPED_PROJECT ? name : "")} title={title} aria-hidden={title ? undefined : true}>{[...label][0]?.toLowerCase()}</span>;
}

export function TaskIcon({ issue, me }: { issue: Issue; me: string }) {
  const who = actorOf(issue.assignee, me);
  return who ? <Avatar actor={who} /> : <ProjectGlyph name={projectOf(issue)} />;
}

/** The status tag a task row shows: only states that mean something get one. */
export function taskStateTag(i: Issue, t: (s: string) => string): ReactNode {
  if (i.status === "blocked") return <Tag color="red">{t("阻塞")}</Tag>;
  if (i.status === "deferred") return <Tag>{t("搁置")}</Tag>;
  if (i.status === "closed") { const s = statusLabel(i); return <Tag color={STATUS_TONE[s.cls] ?? "green"}>{s.cls === "done" ? t("完成") : s.text}</Tag>; }
  return null;
}

/** Tooltip for an acceptance meter: what counted and what did not. */
export function acTitle(p: ReturnType<typeof acceptanceProgress>, _t: (k: string, p?: Record<string, string | number>) => string): string {
  return `Checklist ${p.done}/${p.total}`;
}

/**
 * What a task row says. `compact` (a Detail is open next to the list) keeps two accessories:
 * the tag that matters (state, else priority) and the time.
 */
export function useTaskRow() {
  const t = useT();
  return (i: Issue, { me, compact, withProject = true }: { me: string; compact?: boolean; withProject?: boolean }) => {
    const ac = issueAcceptance(i);
    const prog = acceptanceProgress(ac);
    const done = prog.done;
    const project = projectOf(i);
    const who = actorOf(i.assignee, me);
    // The project is a 16px glyph before the title; with no assignee the row's icon already is that glyph.
    const title = withProject && who && project ? <><ProjectGlyph name={project} small title={project} />{i.title}</> : i.title;
    const state = taskStateTag(i, t);
    const when = relTime(i.status === "closed" ? i.closed_at ?? i.updated_at : i.updated_at);
    // P2 and P3 are the default: only P0 and P1 get a tag. The id lives in the Detail (search still finds it).
    const pri = i.status !== "closed" && i.priority <= 1 ? <Pri p={i.priority} /> : null;
    const time = <span className="num tm">{when}</span>;
    const accessories: ReactNode[] = compact
      ? [...(state ?? pri ? [state ?? pri] : []), time]
      : [
          ...(state ? [state] : []),
          ...(pri ? [pri] : []),
          ...(ac.length > 0 && i.status !== "closed" ? [<Meter value={done} max={ac.length} title={acTitle(prog, t)} label="" />] : []),
          time,
        ];
    return { icon: <TaskIcon issue={i} me={me} />, title, accessories, tooltip: i.title };
  };
}

/** Phone width: no Detail column, so a tap opens the row instead of selecting it. */
export const NARROW = "(max-width: 760px)";
export function useNarrow(): boolean {
  const q = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
  const [narrow, setNarrow] = useState(q);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/** Unread rows ask for their one-paragraph digest of the latest turn (the handler dedupes per reply). */
export function useUnreadDigests(rows: Activity[], onDigest?: (a: Activity) => Promise<void>) {
  useEffect(() => {
    if (!onDigest) return;
    for (const a of rows) if (a.unread && a.reply_id && a.unread_summary_reply !== a.reply_id) void onDigest(a);
  }, [rows, onDigest]);
}

function Crumb({ project, children }: { project: string; children?: ReactNode }) {
  return <div className="lst-crumb"><ProjectGlyph name={project} small />{project}{children}</div>;
}

/** A conversation in the Detail pane: this turn, the latest reply, what it is doing, then metadata. */
export function ActivityBrief({ a, me, taskTitle, onTask }: { a: Activity; me: string; taskTitle?: (id: string) => string | undefined; onTask?: (id: string) => void }) {
  const t = useT();
  const who = actorOf(a.agent, me);
  const live = a.state === "working" && !a.stale;
  const digest = a.unread_summary && a.unread_summary_reply === a.reply_id ? a.unread_summary : "";
  const files = Object.keys(a.files ?? {}).length;
  return (
    <div className="lst-brief">
      <Crumb project={conversationProject(a)}><span className="sepc">›</span>{t("会话")}{live && <Tag color="green" dot>{t("在跑")}</Tag>}{a.unread && <span className="udot" aria-label={t("未读")} />}{conversationProject(a) === UNGROUPED_PROJECT && <AssignProjectButton activity={a} />}</Crumb>
      <h2>{a.title}</h2>
      <div className="lst-md">
        {a.unread && <><h4>{t("未读这轮")}</h4><p>{digest || firstLine(a.reply_preview) || t("正在写这一轮的摘要…")}</p></>}
        {live && a.activity && <><h4>{t("正在做")}</h4><pre>{a.activity}</pre></>}
        {!a.unread && a.summary && <><h4>{t("总结")}</h4><p>{a.summary}</p></>}
        {a.reply_preview && <><h4>{t("最新回复")}</h4><p className="clamp">{plainPreview(a.reply_preview, 900)}</p></>}
        {!a.reply_preview && !a.summary && !live && <p className="muted">{conversationSummary(a) || t("暂无足够的对话内容可整理")}</p>}
      </div>
      <Sep />
      <Meta rows={[
        ["Agent", <><Avatar actor={who} />{who?.name ?? a.agent}</>],
        [t("主机"), <>{!a.stale && <span className="dotc" />}{a.host_name || t("本机")}</>],
        [t("所属项目"), conversationProject(a)],
        [t("最后活动"), when(a.last_at)],
        ...(files ? [[t("改动"), t("{n} 个文件", { n: files })] as [ReactNode, ReactNode]] : []),
        // Tasks by title (clickable); an id only shows when the board does not know the task.
        ...(a.tasks.length ? [[t("任务"), <span className="d-links">{a.tasks.slice(0, 3).map((id) => <button key={id} type="button" className="dlink" title={id} onClick={() => onTask?.(id)}>{taskTitle?.(id) || id}</button>)}</span>] as [ReactNode, ReactNode]] : []),
      ]} />
    </div>
  );
}

/** A live session that reported it needs you (the 等待确认 hook), before it has an Activity row. */
export function SessionBrief({ s, me }: { s: Session; me: string }) {
  const t = useT();
  const who = actorOf(s.agent, me);
  const project = s.project || conversationProject({ cwd: s.cwd, project: s.project } as Activity);
  return (
    <div className="lst-brief">
      <Crumb project={project}><span className="sepc">›</span>{t("会话")}<Tag color="orange">{sessionStatus(s)}</Tag></Crumb>
      <h2>{s.title || s.cwd || s.session_id}</h2>
      <div className="lst-md"><p className="muted">{t("会话停下来等你确认；打开会话看它在问什么。")}</p></div>
      <Sep />
      <Meta rows={[
        ["Agent", <><Avatar actor={who} />{who?.name ?? s.agent}</>],
        [t("主机"), <>{s.alive && <span className="dotc" />}{s.host_name || t("本机")}</>],
        [t("来源"), s.source_app || "?"],
        [t("最后活动"), when(s.last_at)],
        ...(s.prompts ? [[t("轮数"), String(s.prompts)] as [ReactNode, ReactNode]] : []),
      ]} />
    </div>
  );
}

export function TaskBrief({ issue: i, me, progress }: { issue: Issue; me: string; progress?: Record<string, string> }) {
  const t = useT();
  const who = actorOf(i.assignee, me);
  const ac = issueAcceptance(i);
  const done = acceptanceProgress(ac).done;
  const note = i.status === "closed" ? i.close_reason : progress?.[i.id] || i.notes;
  const s = statusLabel(i);
  return (
    <div className="lst-brief">
      <Crumb project={projectOf(i) || t("未分项目")}><span className="sepc">›</span><span className="mono">{i.id}</span><Pri p={i.priority} />{!projectOf(i) && <AssignProjectButton issue={i} />}</Crumb>
      <h2>{i.title}</h2>
      <div className="lst-md">
        {i.description && <Markdown className="clamp" src={i.description.slice(0, 1200)} />}
        {ac.length > 0 && <><h4>{t("验收 {done} / {total}", { done, total: ac.length })}</h4><ul className="lst-ac">{ac.slice(0, 8).map((a, k) => <li key={k} className={`${a.done ? "done" : ""} ac-${a.state}`}>{a.done ? "✓ " : ""}{a.text}</li>)}</ul></>}
        {note && <><h4>{i.status === "closed" ? t("完成说明") : t("最新进展")}</h4><p className="clamp">{note}</p></>}
      </div>
      <Sep />
      <Meta rows={[
        [t("状态"), <Tag color={STATUS_TONE[s.cls]}>{s.text}</Tag>],
        [t("负责"), who ? <><Avatar actor={who} />{who.name}</> : t("未认领")],
        ...((i.dependency_count ?? 0) > 0 ? [[t("依赖"), t("{n} 项", { n: i.dependency_count ?? 0 })] as [ReactNode, ReactNode]] : []),
        [t("创建"), relTime(i.created_at)],
        [t("更新"), relTime(i.updated_at)],
      ]} />
    </div>
  );
}

export interface ProjectDigest { name: string; waiting: number; running: number; open: number; blocked: number; sessions: number; lastActive: number; latest?: Activity; result?: Issue }

export function ProjectBrief({ p, onTask }: { p: ProjectDigest; onTask: (id: string) => void }) {
  const t = useT();
  return (
    <div className="lst-brief">
      <div className="lst-crumb">{t("项目")}</div>
      <h2><ProjectGlyph name={p.name} />{p.name}</h2>
      <div className="lst-md">
        {p.latest && <><h4>{t("最近一次会话")}</h4><p>{p.latest.title}{conversationSummary(p.latest) ? ` · ${conversationSummary(p.latest).slice(0, 300)}` : ""}</p></>}
        {p.result && <><h4>{t("最新成果")}</h4><p><button className="lst-link" onClick={() => onTask(p.result!.id)}>{p.result.title}</button></p></>}
      </div>
      <Sep />
      <Meta rows={[
        [t("会话"), String(p.sessions)],
        [t("等你"), String(p.waiting)],
        [t("在跑"), String(p.running)],
        [t("未完成"), t("{n} 项", { n: p.open })],
        ...(p.blocked ? [[t("被卡住"), t("{n} 项", { n: p.blocked })] as [ReactNode, ReactNode]] : []),
        [t("最后活动"), when(p.lastActive)],
      ]} />
    </div>
  );
}

/**
 * 工作台 v2 row (mockup .row.sr): avatar, a fixed 108px short-name column, one leading verb
 * (要确认 / 问你 / 交了 / 在做) and one line of what the conversation does now, then accessories.
 * `quiet` greys the line for rows already read (今天做完的). Same selection model as <Row>.
 */
export function SessionRow({ id, icon, name, verb, line, mono, meter, accessories, selected, quiet, onOpen, tooltip, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  id: string; icon: ReactNode; name: ReactNode; verb: ReactNode; line: ReactNode; mono?: boolean; meter?: ReactNode; accessories: ReactNode[];
  selected?: boolean; quiet?: boolean; onOpen?: () => void; tooltip?: string;
}) {
  return (
    <div role="option" aria-selected={!!selected} data-row-id={id} title={tooltip} className={`lrow sr${selected ? " sel" : ""}${quiet ? " quiet" : ""}`} onDoubleClick={onOpen} {...rest}>
      <span className="lrow-ic">{icon}</span>
      <span className="nm">{name}</span>
      <div className="ln"><span className="kd">{verb}</span><span className={`tx${mono ? " mono" : ""}`}>{line}</span>{meter}</div>
      <div className="acc">{accessories.map((a, i) => <span key={i} className="acc-i">{a}</span>)}</div>
    </div>
  );
}
