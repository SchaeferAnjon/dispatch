import { useEffect, useState, type ReactNode } from "react";
import { hostOfProject } from "../projectHosts";
import type { Api } from "../api";
import { acceptanceProgress, actorOf, delegatedBy, delegatedTo, eventsFrom, fmtTime, isReviewed, needsReview, issueAcceptance, parsePitfall, glyphStyle, projectOf, relTime, type Interaction, type Pitfall, discussionConclusion } from "../derive";
import type { Activity, Comment, FileChange, HistoryEntry, Issue, Session, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, StatusPill, TYPE_LABEL } from "./ui";
import { EmptyView, Meta, Sep, Shortcut, modCap } from "./primitives";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { AssignProjectButton } from "./AssignProject";

import { linkedSessions } from "../projectModel";
import { FileHunks } from "./Sessions";
import { ImageGrid, MediaProvider } from "./Media";
import { KINDS } from "./Delegate";
import { useT } from "../i18n";
import { tildePath } from "../activity";
import { AcceptanceList } from "./Acceptance";
import { TaskSessions } from "./TaskSessions";

// 编辑属性: a pencil in the 16px, 1.5-stroke style of icons.tsx (the shared set has none).
const PencilIcon = () => <svg className="ic" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" /></svg>;

interface Props { rows: Activity[]; onOpenSession: (id: string) => void; onDiscuss?: (taskId: string) => void; initialWf?: "split" | "discuss"; id: string; api: Api; me: string; initial: Issue | null; root: Issue | null; stamp: string; live: Session[]; onClose: () => void; onSelect: (id: string) => void; onError: (m: string) => void; onDone: (m: string, undo?: () => void) => void }

// `initial` comes from the already-loaded list so the panel paints instantly;
// `stamp` (the issue's updated_at) is what triggers a refetch, not every list reload.
export function Detail({ rows, onOpenSession, onDiscuss, initialWf, id, api, me, initial, root, stamp, live, onClose, onSelect, onError, onDone }: Props) {
  const t = useT();
  const [editProperties, setEditProperties] = useState(false);
  // A 380px Detail beside the list by default; 占满宽度 gives diffs and images the whole page (two
  // columns, the list hidden). Remembered per device.
  const [full, setFull] = useState<boolean>(() => { try { return localStorage.getItem("dispatch-detail-full") === "1"; } catch { return false; } });
  const toggleFull = () => { setFull((w) => { try { localStorage.setItem("dispatch-detail-full", w ? "0" : "1"); } catch { /* per-device */ } return !w; }); };
  // Git: commits whose message names this task, or whose hash is written in its close reason / comments.
  const [commits, setCommits] = useState<{ root: string; remote: string; commits: { hash: string; short: string; date: string; author: string; subject: string; files: string[]; file_count: number; add: number; del: number }[] } | null>(null);
  const [issue, setIssue] = useState<Issue | null>(initial);
  const [comments, setComments] = useState<Comment[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [audit, setAudit] = useState<Interaction[]>([]);
  const [refs, setRefs] = useState<SessionRef[]>([]);
  // What the task's conversations touched: edited files and produced artifacts, from the
  // sessions explicitly linked to it (else the ones that mention it most).
  const [work, setWork] = useState<{ sid: string; agent: string; host?: string; title: string; files: { path: string; changes: FileChange[] }[]; attachments: { id: string; name: string; path: string; mime: string }[] }[]>([]);
  useEffect(() => {
    if (!issue) return;
    // Only sessions the task is explicitly linked to (session: / session-origin: labels). Sessions that merely
    // mention the id are listed below as "对话中提到过" and never contribute files or images here.
    const ids = linkedSessions(issue);
    if (!ids.length) { setWork([]); return; }
    let alive = true;
    Promise.all(ids.map(async (sid) => { try { const d = await api.sessionDetail(sid, true); return { sid, agent: d.meta.agent, host: d.meta.host, title: d.meta.title || sid.slice(0, 8), files: d.files.map((f) => ({ path: f.path, changes: f.changes })), attachments: (d.attachments || []).map((a) => ({ id: a.id, name: a.name, path: a.path, mime: a.mime })) }; } catch { return null; } }))
      .then((rows) => { if (alive) setWork(rows.filter((r): r is NonNullable<typeof r> => !!r && (r.files.length > 0 || r.attachments.length > 0))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, issue?.labels?.join(","), refs.map((r) => r.session_id).join(",")]);
  useEffect(() => {
    let alive = true;
    api.on(hostOfProject(issue ? projectOf(issue) : ""), ["commits", id, "--json"]).then((t) => { if (alive) setCommits(JSON.parse(t.slice(Math.max(0, t.indexOf("{"))))); }).catch(() => { if (alive) setCommits({ root: "", remote: "", commits: [] }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, stamp]);
  const [pits, setPits] = useState<Pitfall[]>([]);
  // `dispatch wiki related` hits: the pits whose meaning is closest to this task (智谱 embedding
  // + sqlite-vec), across projects. `null` means semantic search is unavailable right now.
  const [semPits, setSemPits] = useState<(Pitfall & { score?: number })[] | null>(null);

  // Every pit, kept as the project fallback for when semantic search has no answer.
  useEffect(() => {
    let alive = true;
    api.memories().then((ms) => { if (alive) setPits(ms.map(parsePitfall).filter((p) => p.isPit)); }).catch(() => {});
    return () => { alive = false; };
  }, [id, api]);

  // Meaning, not the project tag: only ask again when the task itself changes.
  useEffect(() => {
    let alive = true;
    setSemPits(null);
    api.on("local", ["wiki", "related", id, "--json"]).then((raw) => {
      if (!alive) return;
      const rows = JSON.parse(raw.slice(Math.max(0, raw.indexOf("[")))) as { key: string; raw: string; score?: number | null }[];
      setSemPits(rows.map((r) => ({ ...parsePitfall({ key: r.key, value: r.raw }), score: r.score ?? undefined })));
    }).catch(() => { if (alive) setSemPits(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, stamp]);

  useEffect(() => {
    let alive = true;
    api.taskSessions(id).then((r) => { if (alive) setRefs(r); }).catch(() => {});
    const t = window.setInterval(() => api.taskSessions(id).then((r) => { if (alive) setRefs(r); }).catch(() => {}), 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [id, api]);

  const copyResume = async (cmd: string) => {
    try { await api.copy(cmd); onDone(t("恢复命令已复制，去终端粘贴回车")); } catch (e) { onError(String(e)); }
  };
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const [editAc, setEditAc] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [expandedReason, setExpandedReason] = useState(false);
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`dispatch-draft:${id}`) ?? ""; } catch { return ""; } });
  useEffect(() => { try { if (draft) sessionStorage.setItem(`dispatch-draft:${id}`, draft); else sessionStorage.removeItem(`dispatch-draft:${id}`); } catch { /* storage unavailable */ } }, [id, draft]);
  const [busy, setBusy] = useState(false);
  // Dynamic workflow: a discussion round (each agent leaves one 【讨论】 comment) and a split into sub-tasks.
  const [wf, setWf] = useState<"" | "discuss" | "split">(initialWf ?? "");
  const [wfKinds, setWfKinds] = useState<string[]>(["claude", "codex"]);
  const [wfQuestion, setWfQuestion] = useState("");
  const [wfRows, setWfRows] = useState<{ kind: string; title: string; desc: string }[]>([{ kind: "codex", title: "", desc: "" }]);
  const [wfBusy, setWfBusy] = useState(false);
  const [allPits, setAllPits] = useState(false);
  // Esc leaves edit mode first, then the page — unless you are typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement)?.closest("input, textarea, select, [role=dialog]")) return;
      if (editProperties) setEditProperties(false); else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editProperties, onClose]);
  const refreshAfterWorkflow = async () => { try { const [i, c] = await Promise.all([api.show(id), api.comments(id)]); setIssue(i); setComments(c); } catch { /* next stamp reloads */ } };
  const runDiscuss = async () => {
    if (!wfKinds.length) return;
    setWfBusy(true);
    try { const raw = await api.on("local", ["discuss", id, "--with", wfKinds.join(","), ...(wfQuestion.trim() ? ["--question", wfQuestion.trim()] : []), "--json"]); const r = JSON.parse(raw.slice(raw.indexOf("{"))); onDone(t("讨论结束：{n} 条发言", { n: (r.comments?.length ?? 1) - 1 })); setWf(""); await refreshAfterWorkflow(); }
    catch (e) { onError(String(e)); } finally { setWfBusy(false); }
  };
  const runSplit = async () => {
    const rows = wfRows.filter((r) => r.title.trim());
    if (!rows.length) return;
    setWfBusy(true);
    try { const raw = await api.on("local", ["split", id, ...rows.flatMap((r) => ["--to", `${r.kind}:${r.title.trim()}${r.desc.trim() ? "|" + r.desc.trim() : ""}`]), "--json"]); const r = JSON.parse(raw.slice(raw.indexOf("{"))); onDone(t("已拆出 {n} 个子任务并派出", { n: r.subtasks?.length ?? rows.length })); setWf(""); await refreshAfterWorkflow(); }
    catch (e) { onError(String(e)); } finally { setWfBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [i, c, h, au] = await Promise.all([api.show(id), api.comments(id), api.history(id), api.interactions(id)]);
        if (!alive) return;
        setIssue(i); setComments(c); setHistory(h); setAudit(au);
      } catch (e) { onError(String(e)); }
    })();
    return () => { alive = false; };
  }, [id, stamp, api]);

  useEffect(() => { setIssue(initial); setComments([]); setHistory([]); setEditTitle(null); setEditDesc(null); setEditAc(null); setClosing(false); setReason(""); }, [id]);

  if (!issue) return <aside className={`detail${full ? " full" : ""}`}><div className="dbody"><div className="d-top"><div className="d-crumb"><span className="mono d-id">{id}</span></div><div className="d-tools"><button className="hd-icon detail-back" onClick={onClose} title={t("关闭 esc")} aria-label={t("关闭")}><Icon name="x" /></button></div></div><EmptyView icon="tasks" title={t("载入中…")} /></div></aside>;

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onDone(label); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const sendComment = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    try {
      await api.comment(id, draft.trim());
      setDraft("");
      try { sessionStorage.removeItem(`dispatch-draft:${id}`); } catch { /* storage unavailable */ }
      onDone(t("留言已发"));
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const who = actorOf(issue.assignee, me);
  const ac = issueAcceptance(issue);
  const events = eventsFrom(history, comments, audit);

  const proj = projectOf(issue);
  const projectPits = pits.filter((p) => p.task === id || (proj && p.project === proj)).sort((a, b) => Number(b.task === id) - Number(a.task === id));
  const semantic = !!(semPits && semPits.some((p) => p.score != null));
  const related: (Pitfall & { score?: number })[] = semantic ? semPits! : projectPits;
  const shownPits = allPits ? related : related.slice(0, 3);

  const labels = (issue.labels ?? []).filter((l) => !l.startsWith("project:") && !l.startsWith("session:") && !l.startsWith("session-origin:") && !l.startsWith("outcome-task:") && !l.startsWith("dispatch:") && !l.startsWith("delegated-") && !l.startsWith("host:") && l !== "reviewed");
  const acDone = acceptanceProgress(ac).done;
  const statusCell = !editProperties ? <StatusPill issue={issue} sm /> : <select value={issue.status} disabled={busy} onChange={(e) => {
    const v = e.target.value;
    if (v === "closed") { setClosing(true); return; }
    if (issue.status === "closed") return act(t("已重新打开"), async () => { await api.reopen(id); if (v !== "open") await api.setStatus(id, v); });
    return act(t("状态已改"), () => api.setStatus(id, v));
  }}>
    <option value="open">{t("待办")}</option>
    <option value="in_progress">{t("进行中")}</option>
    <option value="blocked">{t("阻塞")}</option>
    <option value="deferred">{t("搁置")}</option>
    <option value="closed">{t("已完成")}</option>
  </select>;
  const priCell = !editProperties ? <Pri p={issue.priority} /> : <select value={issue.priority} disabled={busy} onChange={(e) => act(t("优先级已改"), () => api.update(id, { priority: Number(e.target.value) }))}>
    {[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>{p === 0 ? t("P0 最急") : p === 4 ? t("P4 最低") : `P${p}`}</option>)}
  </select>;
  const meta: [ReactNode, ReactNode][] = [
    [t("状态"), statusCell],
    [t("负责"), who ? <><Avatar actor={who} />{who.name}</> : <span className="muted">{t("未认领")}</span>],
    [t("优先级"), priCell],
  ];
  if (delegatedBy(issue)) meta.push([t("派活"), delegatedBy(issue) === delegatedTo(issue) ? t("{who} 派给另一个自己的会话", { who: actorOf(delegatedBy(issue), me)?.name ?? delegatedBy(issue) }) : t("{from} 派给 {to}", { from: actorOf(delegatedBy(issue), me)?.name ?? delegatedBy(issue), to: actorOf(delegatedTo(issue), me)?.name ?? delegatedTo(issue) })]);
  meta.push([t("类型"), t(TYPE_LABEL[issue.issue_type] ?? issue.issue_type)]);
  meta.push([t("项目"), <ProjectTag name={proj} />]);
  if (root) meta.push([t("源自"), <button className="dlink" onClick={() => onSelect(root.id)} title={root.title}><span className="mono">{root.id}</span> <span className="muted">{root.title}</span></button>]);
  if (labels.length) meta.push([t("标签"), <span className="mono small" title={labels.join(" · ")}>{labels.join(" · ")}</span>]);
  if ((issue.dependencies ?? []).length) meta.push([t("依赖"), <span className="d-links">{issue.dependencies!.map((d) => <button key={d.id} className="dlink mono" onClick={() => onSelect(d.id)} title={d.title}>{d.id}{d.status === "closed" ? " ✓" : ""}</button>)}</span>]);
  if ((issue.dependents ?? []).length) meta.push([t("被依赖"), <span className="d-links">{issue.dependents!.map((d) => <button key={d.id} className="dlink mono" onClick={() => onSelect(d.id)} title={d.title}>{d.id}</button>)}</span>]);
  meta.push([t("创建"), <span title={fmtTime(issue.created_at)}>{fmtTime(issue.created_at)}{issue.created_by ? ` · ${actorOf(issue.created_by, me)?.name}` : ""}</span>]);
  if (issue.closed_at) meta.push([t("完成"), fmtTime(issue.closed_at)]);

  return (
    <aside className={`detail${full ? " full" : ""}`} aria-label={issue.title}>
      <div className="dbody">
       <div className="dcol dcol-main">
        <div className="d-top">
          <div className="d-crumb">
            <span className="pj sm" style={glyphStyle(proj)}>{(proj || "?").slice(0, 1).toUpperCase()}</span>
            <span className="d-proj">{proj || t("未分项目")}</span>
            <span className="d-sep">›</span>
            <span className="mono d-id" title={t("任务编号：Beads 自动生成，前缀是板的名字（task），后面三位是随机编码，没有含义，只用来唯一标识")}>{issue.id}</span>
            {!editProperties && issue.priority <= 1 && <Pri p={issue.priority} />}
            {!proj && <AssignProjectButton issue={issue} />}
          </div>
          <div className="d-tools">
            <button className="hd-icon detail-edit" aria-pressed={editProperties} onClick={() => { setEditProperties(v => !v); setClosing(false); }} title={editProperties ? t("收起编辑") : t("编辑属性")} aria-label={editProperties ? t("收起编辑") : t("编辑属性")}><PencilIcon /></button>
            <button className="hd-icon detail-full" onClick={toggleFull} title={full ? t("收回右栏") : t("占满宽度：看文件改动和产物")} aria-label={full ? t("收回右栏") : t("占满宽度")} aria-pressed={full}><Icon name="window" /></button>
            <button className="hd-icon detail-back" onClick={onClose} title={t("关闭 esc")} aria-label={t("关闭")}><Icon name="x" /></button>
          </div>
        </div>
        {editTitle === null ? (
          <h2 className={`d-title${editProperties ? " editable" : ""}`} onClick={() => { if (editProperties) setEditTitle(issue.title); }} title={editProperties ? t("点击编辑标题") : undefined}>{issue.title}</h2>
        ) : (
          <textarea className="title" value={editTitle} autoFocus rows={2} onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditTitle(null); if (e.key === "Enter") { e.preventDefault(); const v = editTitle.trim(); setEditTitle(null); if (v && v !== issue.title) act(t("标题已改"), () => api.update(id, { title: v })); } }}
            onBlur={() => { const v = editTitle.trim(); setEditTitle(null); if (v && v !== issue.title) act(t("标题已改"), () => api.update(id, { title: v })); }} />
        )}

        <TaskSessions issue={issue} refs={refs} live={live} rows={rows} me={me} onOpenSession={onOpenSession} onCopyResume={(cmd) => void copyResume(cmd)} />

        <div className="d-md sec">
          {editDesc === null ? (
            issue.description ? <div className="md-edit" onDoubleClick={() => setEditDesc(issue.description ?? "")} title={t("双击编辑")}><Markdown src={issue.description} className="compact" /></div>
              : <p className="empty-p" onClick={() => setEditDesc("")} title={t("点击编辑")}>{t("还没写描述。下一个接手的 Agent 会不知道为什么做这件事。")}</p>
          ) : (
            <textarea className="edit" value={editDesc} autoFocus onChange={(e) => setEditDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditDesc(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
              onBlur={() => { const d = editDesc; setEditDesc(null); if (d !== (issue.description ?? "")) act(t("描述已改"), () => api.update(id, { description: d })); }} />
          )}

          {editAc === null ? (
            <AcceptanceList issue={issue} api={api} host={hostOfProject(proj)} me={me} stamp={stamp} busy={busy} onEdit={() => setEditAc(issue.acceptance_criteria ?? "")} onChanged={() => void refreshAfterWorkflow()} onDone={onDone} onError={onError} />
          ) : (<>
            <h4>{t("验收标准")}</h4>
            <textarea className="edit" value={editAc} autoFocus placeholder={t("- [ ] 一行一条\n- [x] 已完成的打 x")} onChange={(e) => setEditAc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditAc(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
              onBlur={() => { const v = editAc; setEditAc(null); if (v !== (issue.acceptance_criteria ?? "")) act(t("验收标准已改"), () => api.update(id, { acceptance: v })); }} />
          </>)}

          {issue.status === "closed" && issue.close_reason && <>
            <h4>{t("完成说明")}</h4>
            <p className={expandedReason ? "" : "completion-preview"}>{issue.close_reason}</p>
            <button className="link-btn" aria-expanded={expandedReason} onClick={() => setExpandedReason(!expandedReason)}>{expandedReason ? t("收起") : t("展开完成说明")}</button>
          </>}
        </div>

        {issue.status === "closed" && <section className="sec review-evidence">
          <h4>{t("交付与验证")} <span className="muted">{isReviewed(issue) ? t("已记录复核通过") : needsReview(issue) ? t("等待 Agent 复核") : t("已完成 · 无需你点击审核")}</span></h4>
          <p className="review-gap">{ac.length ? t("{done}/{total} 项已通过验收 · {left} 项仍待核对", { done: acDone, total: ac.length, left: ac.length - acDone }) : t("尚未填写验收标准")}</p>
          {ac.some((a) => !["verified", "human", "waived"].includes(a.state)) && <details open><summary>{t("待核对的验收项")}</summary><ul className="checks">{ac.filter((a) => !["verified", "human", "waived"].includes(a.state)).map((a, n) => <li key={n}>{a.text}</li>)}</ul></details>}
          <details><summary>{t("查看记录依据 · {comments} 条进展 / 留言 · {refs} 个关联会话", { comments: comments.length, refs: refs.length })}</summary>
            <p className="muted small">{t("以下是原始记录，测试结果需要结合完成说明和会话核对。")}</p>
            {comments.length ? [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3).map((c) => <div key={c.id} className="evidence-note"><b>{c.author} · {fmtTime(c.created_at)}</b><Markdown src={c.text} className="compact" /></div>) : <p>{t("没有进展记录")}</p>}
            {refs.map((r) => <button key={r.session_id} className="btn sm" onClick={() => onOpenSession(r.session_id)}>{t("查看会话 · {what}", { what: r.project || r.session_id.slice(0, 8) })}</button>)}
          </details>
          {!issue.close_reason && <p className="review-gap">{t("缺少完成说明，尚无法判断交付内容与验证结果。")}</p>}
        </section>}

        {(() => {
          const discussion = comments.filter((c) => c.text.trimStart().startsWith("【讨论】")).sort((a, b) => a.created_at.localeCompare(b.created_at));
          const subtasks = (issue.dependents ?? []).filter((d) => !d.dependency_type || d.dependency_type === "parent-child");
          if (issue.status === "closed" && !discussion.length && !subtasks.length) return null;
          return (
            <section className="sec workflow">
              <h4>{t("讨论与分工")}{onDiscuss && discussion.length > 0 && <button className="btn ghost sm" onClick={() => onDiscuss(id)}>{t("可视化 · 继续讨论")}</button>}</h4>
              {(() => { const con = discussionConclusion(issue.description, comments); return con ? <div className="disc-conclusion"><div className="l1"><b>{t("结论")}</b><span className="muted small">{t("总结模型归纳 · {when}", { when: con.when.includes("T") ? relTime(con.when) : con.when })}</span></div><Markdown src={con.text} className="compact" /></div> : null; })()}
              {discussion.length > 0 && <div className="discussion">{discussion.map((c) => { const a = actorOf(c.author, me); return <div key={c.id} className="say"><Avatar actor={a} /><div><div className="l1"><b>{a?.name ?? c.author}</b><span className="ts">{relTime(c.created_at)}</span></div><Markdown src={c.text.trimStart().slice(4)} className="compact" /></div></div>; })}</div>}
              {subtasks.length > 0 && <div className="subtasks">{subtasks.map((d) => { const who = actorOf(d.assignee, me); return <button key={d.id} className="subtask" onClick={() => onSelect(d.id)}><StatusPill issue={d as Issue} sm /><span className="t">{d.title}</span>{who && <span className="muted small">{who.name}</span>}<span className="mono muted small">{d.id}</span></button>; })}</div>}
              {issue.status !== "closed" && wf === "" && <div className="task-links"><button className="btn sm" onClick={() => setWf("discuss")}>{t("发起讨论…")}</button><button className="btn sm" onClick={() => setWf("split")}>{t("拆分并派活…")}</button></div>}
              {wf === "discuss" && <div className="wf-form">
                <div className="task-links">{KINDS.map(([k, l]) => <label key={k} className="chip"><input type="checkbox" checked={wfKinds.includes(k)} onChange={(e) => setWfKinds(e.target.checked ? [...wfKinds, k] : wfKinds.filter((x) => x !== k))} /> {l}</label>)}</div>
                <input placeholder={t("想让他们决定什么（可空）")} value={wfQuestion} onChange={(e) => setWfQuestion(e.target.value)} />
                <p className="muted small">{t("每个 Agent 无头直调（claude -p / codex exec / pi），读任务和前面的发言，各留一条【讨论】评论；通常一分钟内到齐，期间这个面板会等着。")}</p>
                <div className="task-links"><button className="btn primary sm" disabled={wfBusy || !wfKinds.length} onClick={() => void runDiscuss()}>{wfBusy ? t("讨论进行中…") : t("开始讨论")}</button><button className="btn sm" disabled={wfBusy} onClick={() => setWf("")}>{t("取消")}</button></div>
              </div>}
              {wf === "split" && <div className="wf-form">
                {wfRows.map((r, n) => <div key={n} className="wf-row"><select value={r.kind} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, kind: e.target.value } : x))}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><input placeholder={t("子任务标题")} value={r.title} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, title: e.target.value } : x))} /><input placeholder={t("说明（可空）")} value={r.desc} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, desc: e.target.value } : x))} /></div>)}
                <div className="task-links"><button className="link" onClick={() => setWfRows([...wfRows, { kind: "codex", title: "", desc: "" }])}>{t("＋ 再加一个")}</button></div>
                <p className="muted small">{t("每个子任务建成父任务的子项，标上谁派给谁，并在 Dispatch 里起对应 Agent 开始做。")}</p>
                <div className="task-links"><button className="btn primary sm" disabled={wfBusy || !wfRows.some((r) => r.title.trim())} onClick={() => void runSplit()}>{wfBusy ? t("拆分中…") : t("拆分并派出")}</button><button className="btn sm" disabled={wfBusy} onClick={() => setWf("")}>{t("取消")}</button></div>
              </div>}
            </section>
          );
        })()}

        <Sep />
        <Meta rows={meta} />
        {editProperties && <div className="actions">
          {issue.status !== "closed" && !closing && <button className="btn sm" disabled={busy} onClick={() => setClosing(true)}>{t("标记完成")}</button>}
          {issue.status === "closed" && <button className="btn sm" disabled={busy} onClick={() => act(t("已重新打开"), () => api.reopen(id))}>{t("重新打开")}</button>}
          {closing && (
            <div className="reason">
              <input autoFocus placeholder={t("完成说明（交付内容与验证结果）")} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) { setClosing(false); act(t("已完成"), () => api.close(id, reason.trim())); } if (e.key === "Escape") setClosing(false); }} />
              <button className="btn primary sm" disabled={!reason.trim() || busy} onClick={() => { setClosing(false); act(t("已完成"), () => api.close(id, reason.trim())); }}>{t("完成")}</button>
              <button className="btn ghost sm" onClick={() => setClosing(false)}>{t("取消")}</button>
            </div>
          )}
        </div>}
       </div>

       <div className="dcol dcol-side">
        <section className="sec git-sec">
          <h4 title={t(" · 提交信息里带 {id}，或完成说明里写了哈希的", { id }).replace(/^ · /, "")}>{t("Git 提交")} <span className="muted">{commits ? t("{n} 个", { n: commits.commits.length }) : "…"}</span></h4>
          {commits && commits.commits.length === 0 && <p className="empty-p">{commits.root ? t("还没有对上的提交。Agent 提交时在信息末尾写上任务 id，或在完成说明里写 commit 哈希，这里就会列出来。") : t("这个项目不在 git 仓库里，或者找不到它的目录。")}</p>}
          {commits && commits.commits.length > 0 && <div className="git-list">
            {commits.commits.map((c) => (
              <details key={c.hash} className="git-commit">
                <summary><span className="mono hash">{c.short}</span><span className="subj">{c.subject}</span><span className="mono small diffstat"><span className="add">+{c.add}</span> <span className="del">−{c.del}</span></span><span className="muted small">{relTime(c.date)}</span></summary>
                <div className="git-files">
                  <div className="muted small">{fmtTime(c.date)} · {c.author} · {t("{n} 个文件", { n: c.file_count })}{commits.remote ? <> · <button className="link" onClick={() => api.openPath(`${commits.remote}/commit/${c.hash}`)}>{t("在 GitHub 打开 ↗")}</button></> : null} · <button className="link" onClick={() => api.copy(c.hash).then(() => onDone(t("已复制 commit 哈希"))).catch(() => {})}>{t("复制哈希")}</button></div>
                  {c.files.map((f) => <div key={f} className="mono small git-file">{f}</div>)}
                </div>
              </details>
            ))}
          </div>}
        </section>

        <section className="sec work-sec">
          <h4>{t("文件修改与产出")} <span className="muted">{t("{files} 个文件 · {artifacts} 个产物 · 来自明确关联的会话", { files: work.reduce((n, w) => n + w.files.length, 0), artifacts: work.reduce((n, w) => n + w.attachments.length, 0) })}</span></h4>
          {work.length === 0 ? <p className="empty-p">{issue && linkedSessions(issue).length ? t("关联的会话里没有记录到文件改动或产物。") : t("还没有关联会话，所以这里是空的。Agent 认领、记进展或声称验收项时会自动关联；「会话」一节里「提到过」的只是线索。")}</p> : work.map((w) => (
            <div key={w.sid} className="work-block">
              <div className="work-head"><button className="link" onClick={() => onOpenSession(w.sid)}>{w.title} ↗</button></div>
              {w.files.length > 0 && <div className="work-files">{w.files.map((f) => <details key={f.path} className="fdiff file work-file" data-menu="file" data-id={f.path} open={full && w.files.length <= 3}><summary title={f.path}><code>{tildePath(f.path).replace(/^(.{0,18}).*?([^/]+\/[^/]+)$/, (m, a, b) => (m.length > 44 ? `${a}…/${b}` : m))}</code><span className="muted small">{t("{n} 次", { n: f.changes.length })}</span></summary><FileHunks changes={f.changes} /></details>)}</div>}
              {w.attachments.length > 0 && <MediaProvider api={api} session={{ agent: w.agent, session_id: w.sid, host: w.host }}><div className="work-attachments"><ImageGrid ids={w.attachments.filter((a) => a.mime.startsWith("image/")).map((a) => a.id)} max={6} />{w.attachments.filter((a) => !a.mime.startsWith("image/")).map((a) => <button key={a.id} className="chip" title={a.path || a.mime} onClick={() => (a.path ? api.openPath(a.path).catch(() => onOpenSession(w.sid)) : onOpenSession(w.sid))}>📄 {a.name}</button>)}</div></MediaProvider>}
            </div>
          ))}
        </section>

        {related.length > 0 && (
          <details className="sec context-fold">
            <summary>{t("相关的坑")} <span className="muted">{t("{n} 条", { n: related.length })} · {semantic ? t("按这条任务的意思找的，跨项目") : t("项目 {project} 的经验", { project: proj })}</span></summary>
            <div className="rel-pits">
              {shownPits.map((p) => (
                <div key={p.key} className="rel-pit">
                  <div className="l1"><span className="lbl trap">{t("坑")}</span><span>{p.trap}</span>{semantic && p.score ? <span className="muted small">{p.score.toFixed(2)}</span> : null}</div>
                  {p.fix && <div className="l1"><span className="lbl fix">{t("解法")}</span><span>{p.fix}</span></div>}
                </div>
              ))}
              {related.length > shownPits.length && <button className="link sm" onClick={() => setAllPits(true)}>{t("还有 {n} 条，展开", { n: related.length - shownPits.length })}</button>}
            </div>
          </details>
        )}

       </div>

       <div className="dcol dcol-act sec">
        <h4>{t("活动")}</h4>
        <div className="act">
          {events.length === 0 && <p className="empty-p">{t("还没有活动")}</p>}
          {events.map((ev, i) => {
            const a = actorOf(ev.actor, me);
            return (
              <div className="ev" key={i}>
                {a ? <Avatar actor={a} /> : <span className="av" style={{ background: "var(--hair-2)", color: "var(--text-2)" }}>·</span>}
                <div>
                  <div className="l1"><b>{a?.name ?? t("系统")}</b><span className="muted">{ev.kind === "comment" ? t("留言") : ev.text}</span><span className="ts" title={fmtTime(ev.ts)}>{relTime(ev.ts)}</span></div>
                  {ev.kind === "comment" ? <div className="note"><Markdown src={ev.text} className="compact" /></div> : ev.cmd ? <span className="cmd">{ev.cmd}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
       </div>
      </div>
      <div className="compose composer"><div className="cbox">
        <textarea className="ta" placeholder={t("留言给下一个接手的 Agent…（{mod}⏎ 发送）")} value={draft} disabled={busy} rows={1} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendComment(); } }} />
        <div className="tools"><span className="sp" /><button className="btn primary" disabled={!draft.trim() || busy} onClick={() => void sendComment()}>{t("发送")}<Shortcut keys={[modCap(), "↵"]} /></button></div>
      </div></div>
    </aside>
  );
}
