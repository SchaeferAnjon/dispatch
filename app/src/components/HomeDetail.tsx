/*
 * 工作台 v2 Detail for one conversation: the decision first (the command waiting for a yes, the
 * question it asked), then what this turn did, the tasks it works on and a few facts. Decisions
 * are made in the conversation itself; the Detail links there.
 */
import type { ReactNode } from "react";
import { actorOf, parseAcceptance } from "../derive";
import { conversationProject, UNGROUPED_PROJECT } from "../activity";
import { tasksOf, type SessionItem } from "../homeModel";
import type { Activity, Issue } from "../types";
import { useT } from "../i18n";
import { Avatar, Pri } from "./ui";
import { Meta, Meter, Sep, Tag } from "./primitives";
import { AssignProjectButton } from "./AssignProject";
import { ProjectGlyph, firstLine, plainPreview, shortId, when } from "./ListRows";

/** The command part of an activity line ("Bash · npm test" → "npm test"); the whole line when it has none. */
export function stepOf(activity?: string): string {
  const s = (activity ?? "").replace(/^已执行 · /, "").trim();
  const m = /^[\w.:-]+ · ([\s\S]+)$/.exec(s);
  return m ? m[1] : s;
}
/** The unread digest when it belongs to the latest reply, else "". */
export const digestOf = (a?: Activity) => (a?.unread_summary && a.unread_summary_reply === a.reply_id ? a.unread_summary : "");
/** "你当时说" only adds something when the row's name is not already that sentence. */
export function saidOf(a: Activity | undefined, name: string): string {
  const said = (a?.first_prompt ?? "").trim();
  if (!said) return "";
  const norm = (x: string) => x.replace(/\s+/g, "").replace(/[…。.]+$/, "");
  return norm(said).startsWith(norm(name)) || norm(name).startsWith(norm(said)) ? "" : said;
}

/** Waiting on a permission prompt: what it wants to run, and the way to the conversation, where
 * the in-app chat shows 允许 / 拒绝. */
function Decision({ item, onOpen }: { item: SessionItem; onOpen: () => void }) {
  const t = useT();
  const step = stepOf(item.a?.activity);
  return <>
    <div className="home-ask"><div className="k">{t("它停在权限框上，等你点头")}</div>{step && <pre>{step}</pre>}</div>
    <div className="home-acts"><button type="button" className="btn sm primary" onClick={onOpen}>{t("打开会话")}</button></div>
  </>;
}

function TaskLines({ tasks, onTask }: { tasks: Issue[]; onTask: (id: string) => void }) {
  return <div className="home-tasks">{tasks.slice(0, 4).map((i) => {
    const ac = parseAcceptance(i.acceptance_criteria);
    return <button key={i.id} type="button" className="home-taskline" onClick={() => onTask(i.id)} title={i.title}>
      <span className="mono">{shortId(i.id)}</span><span className="tt">{i.title}</span>
      {ac.length > 0 && i.status !== "closed" ? <Meter value={ac.filter((x) => x.done).length} max={ac.length} /> : i.status === "closed" ? <Tag color="green">✓</Tag> : <Pri p={i.priority} />}
    </button>;
  })}</div>;
}

export function HomeDetail({ item, name, me, issues, onOpen, onTask }: { item: SessionItem; name: string; me: string; issues: Issue[]; onOpen: () => void; onTask: (id: string) => void }) {
  const t = useT();
  const { a, s, verb } = item;
  const who = actorOf(a?.agent ?? s?.agent, me);
  const project = a ? conversationProject(a) : s?.project || UNGROUPED_PROJECT;
  const host = a?.host_name || s?.host_name || t("本机");
  const source = s?.source_app || (a?.entrypoint === "cli" ? t("终端") : "");
  const digest = digestOf(a);
  const said = saidOf(a, name);
  const files = Object.keys(a?.files ?? {}).length;
  const tasks = tasksOf(a, issues);
  const subs = a?.background_agents?.length ?? 0;
  const tag = verb === "confirm" ? <Tag color="orange">{t("要确认")}</Tag> : verb === "ask" ? <Tag color="orange">{t("问你")}</Tag>
    : verb === "delivered" ? <Tag color="blue">{t("未读")}</Tag> : verb === "running" ? <Tag color="green" dot>{t("在跑")}</Tag> : null;
  const turn = digest || firstLine(a?.reply_preview) ? <><h4>{verb === "running" ? t("上一轮交了") : t("这一轮做了")}</h4><p className="clamp">{digest || plainPreview(a?.reply_preview ?? "", 600)}</p></> : null;
  return (
    <div className="lst-brief home-d">
      <div className="lst-crumb"><ProjectGlyph name={project} small />{project === UNGROUPED_PROJECT ? t(project) : project}<span className="sepc">›</span>{host}{source && <><span className="sepc">›</span>{source}</>}{tag}
        {a && project === UNGROUPED_PROJECT && <AssignProjectButton activity={a} />}</div>
      <h2>{name}</h2>
      {said && <div className="home-said"><b>{t("你当时说：")}</b>{said}</div>}
      {verb === "confirm" && <Decision item={item} onOpen={onOpen} />}
      {verb === "ask" && <>
        <div className="home-ask"><div className="k">{t("它问你")}</div>{a?.question || stepOf(a?.activity).replace(/^等你回答：?/, "") || firstLine(a?.reply_preview)}</div>
        <div className="home-acts"><button type="button" className="btn sm primary" onClick={onOpen}>{t("去回答")}</button></div>
      </>}
      <div className="lst-md">
        {verb === "running" && a?.activity && <><h4>{t("正在做")}</h4><pre>{a.activity}{subs ? ` · ${t("子 Agent {n} 个在跑", { n: subs })}` : ""}</pre></>}
        {turn}
        {tasks.length > 0 && <h4>{t("任务")}</h4>}
      </div>
      {tasks.length > 0 && <TaskLines tasks={tasks} onTask={onTask} />}
      <Sep />
      <Meta rows={[
        ["Agent", <><Avatar actor={who} />{who?.name ?? a?.agent ?? s?.agent}</>],
        [t("主机"), <>{(s?.alive || (a && !a.stale)) && <span className="dotc" />}{host}{source ? ` · ${source}` : ""}</>],
        [t("最后活动"), when(item.at)],
        ...(files ? [[t("改动"), t("{n} 个文件", { n: files })] as [ReactNode, ReactNode]] : []),
      ]} />
    </div>
  );
}
