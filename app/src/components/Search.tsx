import { useMemo } from "react";
import { conversationProject, conversationSummary, sessionLifecycle } from "../activity";
import { ago, actorOf, glyphStyle, projectOf, relTime, statusLabel } from "../derive";
import type { Activity, Issue } from "../types";
import { Avatar, STATUS_TONE } from "./ui";
import { Tag } from "./primitives";
import { Icon } from "./icons";
import { useT } from "../i18n";

export type Hit = { kind: "project"; key: string; name: string } | { kind: "session"; key: string; a: Activity } | { kind: "task"; key: string; i: Issue };

// The whole-app search behind ⌘K: projects, conversations and tasks in one list, so the user never
// has to know which view a thing lives in first. Every word must match (in any order).
export function useSearchHits(q: string, projects: string[], rows: Activity[], issues: Issue[]): Hit[] {
  return useMemo<Hit[]>(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [];
    const words = qq.split(/\s+/).filter(Boolean);
    const has = (s: string) => { const t = s.toLowerCase(); return words.every((w) => t.includes(w)); };
    const ps = projects.filter((p) => has(p)).slice(0, 5).map((name) => ({ kind: "project", key: `p:${name}`, name }) as Hit);
    const ss = rows.filter((a) => has(`${a.title} ${a.cwd} ${conversationProject(a)} ${a.overview ?? ""}`)).slice(0, 8).map((a) => ({ kind: "session", key: `s:${a.host ?? "local"}:${a.session_id}`, a }) as Hit);
    const ts = issues.filter((i) => has(`${i.title} ${i.id} ${i.assignee ?? ""} ${projectOf(i)} ${i.description ?? ""}`)).sort((a, b) => Number(b.status !== "closed") - Number(a.status !== "closed") || b.updated_at.localeCompare(a.updated_at)).slice(0, 8).map((i) => ({ kind: "task", key: `t:${i.id}`, i }) as Hit);
    return [...ps, ...ss, ...ts];
  }, [q, projects, rows, issues]);
}

export const HIT_GROUPS: { kind: Hit["kind"]; label: string }[] = [{ kind: "project", label: "项目" }, { kind: "session", label: "会话" }, { kind: "task", label: "任务" }];

/** The icon, title, grey subtitle and right-hand text of one search hit, as ⌘K panel row parts. */
export function HitParts({ h, me, archiveDays }: { h: Hit; me: string; archiveDays: number }) {
  const t = useT();
  if (h.kind === "project") return <><span className="lrow-ic"><span className="pj sm" style={glyphStyle(h.name)}>{h.name.slice(0, 1)}</span></span><div className="lrow-main"><span className="t">{h.name}</span><span className="s">{t("进入项目")}</span></div><div className="acc" /></>;
  if (h.kind === "session") return <><span className="lrow-ic"><Avatar actor={actorOf(h.a.agent, me)} size={16} /></span><div className="lrow-main"><span className="t">{h.a.starred && "★ "}{h.a.title}</span><span className="s">{conversationSummary(h.a)}</span></div><div className="acc">{sessionLifecycle(h.a, archiveDays) === "archived" && <Tag>{t("已归档")}</Tag>}<span>{conversationProject(h.a)} · {ago(h.a.last_at)}</span></div></>;
  const st = statusLabel(h.i);
  return <><span className="lrow-ic"><Icon name="tasks" /></span><div className="lrow-main"><span className="t">{h.i.title}</span></div><div className="acc"><Tag color={STATUS_TONE[st.cls]}>{st.text}</Tag><span className="mono" title={relTime(h.i.updated_at)}>{h.i.id}</span></div></>;
}
