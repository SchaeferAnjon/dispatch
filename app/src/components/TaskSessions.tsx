import { useState } from "react";
import { actorOf, ago, type Actor } from "../derive";
import { linkedSessions, originSession } from "../projectModel";
import type { Activity, Issue, Session, SessionRef } from "../types";
import { Avatar } from "./ui";
import { useT } from "../i18n";

export type SessionRole = "doing" | "origin" | "did" | "mentioned";
export interface TaskSessionRow { sid: string; role: SessionRole; agent: string; title: string; last_at: number; alive: boolean; working: boolean; source: string; mentions: number; resume: string }

/** Who worked on a task, from its labels (session: / session-origin:), the live sessions and the
 *  transcripts that mention it. 在做 = a linked session that is alive (else the latest linked one
 *  while the task is in progress), 发起 = session-origin, 做过 = the other linked ones, 提到过 = only
 *  mentioned in a transcript. */
export function taskSessionRows(issue: Issue, refs: SessionRef[], live: Session[], rows: Activity[]): TaskSessionRow[] {
  const linked = linkedSessions(issue);
  const origin = originSession(issue);
  const info = (sid: string): Omit<TaskSessionRow, "role"> => {
    const r = refs.find((x) => x.session_id === sid);
    const a = rows.find((x) => x.session_id === sid);
    const l = live.find((x) => x.session_id === sid && x.alive);
    return {
      sid,
      agent: l?.agent || a?.agent || r?.agent || "",
      title: a?.title_override || a?.title || r?.title_override || r?.title || r?.first_prompt || "",
      last_at: Math.max(l?.last_at ?? 0, a?.last_at ?? 0, r?.last_at ?? 0),
      alive: !!l,
      working: l?.state === "working",
      source: l?.source_app || "",
      mentions: (r as { mentions?: number } | undefined)?.mentions ?? 0,
      resume: r?.resume_cmd ?? "",
    };
  };
  const linkedRows = linked.map(info);
  let doing = linkedRows.filter((r) => r.alive).map((r) => r.sid);
  if (!doing.length && issue.status === "in_progress" && linkedRows.length) doing = [[...linkedRows].sort((a, b) => b.last_at - a.last_at)[0].sid];
  const out: TaskSessionRow[] = [];
  for (const r of [...linkedRows].sort((a, b) => b.last_at - a.last_at)) {
    out.push({ ...r, role: doing.includes(r.sid) ? "doing" : r.sid === origin ? "origin" : "did" });
  }
  const order: Record<SessionRole, number> = { doing: 0, origin: 1, did: 2, mentioned: 3 };
  out.sort((a, b) => order[a.role] - order[b.role] || b.last_at - a.last_at);
  for (const r of [...refs].sort((a, b) => b.last_at - a.last_at)) {
    if (!linked.includes(r.session_id)) out.push({ ...info(r.session_id), role: "mentioned" });
  }
  return out;
}

const ROLE_LABEL: Record<SessionRole, string> = { doing: "在做", origin: "发起", did: "做过", mentioned: "提到过" };

/** The 会话 section at the top of a task: click a row to open that conversation. */
export function TaskSessions({ issue, refs, live, rows, me, onOpenSession, onCopyResume }: { issue: Issue; refs: SessionRef[]; live: Session[]; rows: Activity[]; me: string; onOpenSession: (id: string) => void; onCopyResume: (cmd: string) => void }) {
  const t = useT();
  const [more, setMore] = useState(false);
  const all = taskSessionRows(issue, refs, live, rows);
  const main = all.filter((r) => r.role !== "mentioned");
  const mentioned = all.filter((r) => r.role === "mentioned");
  const shownMentioned = more ? mentioned : mentioned.slice(0, 3);
  const Row = ({ r }: { r: TaskSessionRow }) => {
    const a: Actor | null = actorOf(r.agent === "claude-code" ? "claude-code" : r.agent, me);
    return (
      <div className={`ts-row ${r.role}${r.alive ? " live" : ""}`}>
        <button type="button" className="ts-open" onClick={() => onOpenSession(r.sid)} title={t("打开这个会话")}>
          <span className={`ts-role ${r.role}`}>{r.alive && <span className="ts-dot" />}{t(ROLE_LABEL[r.role])}</span>
          <Avatar actor={a} />
          <span className="ts-title">{r.title || r.sid.slice(0, 8)}</span>
          <span className="muted small ts-meta">{[r.source, r.working ? t("在跑") : r.alive ? t("开着") : "", r.role === "mentioned" && r.mentions ? t("提到 {n} 次", { n: r.mentions }) : "", r.last_at ? ago(r.last_at) : ""].filter(Boolean).join(" · ")}</span>
        </button>
        {r.resume && !r.alive && <button className="btn ghost sm ts-resume" onClick={() => onCopyResume(r.resume)} title={r.resume}>{t("复制恢复命令")}</button>}
      </div>
    );
  };
  return (
    <section className="sec task-sessions" aria-label={t("会话")}>
      <h4>{t("会话")} <span className="muted">{main.length ? t("{n} 个在做或做过", { n: main.length }) : t("还没有会话连上这个任务")}{mentioned.length ? ` · ${t("{n} 个提到过", { n: mentioned.length })}` : ""}</span></h4>
      {main.length === 0 && <p className="empty-p small">{t("Agent 认领、记进展、声称验收项或完成时会自动连上；只提到过任务编号的会话列在下面，仅供参考。")}</p>}
      <div className="ts-list">
        {main.map((r) => <Row key={r.sid} r={r} />)}
        {shownMentioned.map((r) => <Row key={r.sid} r={r} />)}
      </div>
      {mentioned.length > 3 && <button className="link sm" onClick={() => setMore(!more)}>{more ? t("收起") : t("还有 {n} 个提到过的会话", { n: mentioned.length - 3 })}</button>}
    </section>
  );
}
