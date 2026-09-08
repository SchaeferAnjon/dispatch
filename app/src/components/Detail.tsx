import { useEffect, useState } from "react";
import type { Api } from "../api";
import { actorOf, delegatedBy, delegatedTo, durSince, eventsFrom, fmtTime, isReviewed, needsReview, parseAcceptance, parsePitfall, projectOf, relTime, serializeAcceptance, statusLabel, type Interaction, type Pitfall } from "../derive";
import type { Activity, Comment, FileChange, HistoryEntry, Issue, Session, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, TYPE_LABEL } from "./ui";
import { Markdown } from "./Markdown";

import { TaskRelations } from "./ProjectHub";
import { linkedSessions } from "../projectModel";
import { FileHunks } from "./Sessions";
import { InlineImage, MediaProvider } from "./Media";
import { KINDS } from "./Delegate";

interface Props { rows: Activity[]; onOpenSession: (id: string) => void; id: string; api: Api; me: string; initial: Issue | null; root: Issue | null; stamp: string; live: Session[]; onClose: () => void; onSelect: (id: string) => void; onError: (m: string) => void; onDone: (m: string) => void }

// `initial` comes from the already-loaded list so the panel paints instantly;
// `stamp` (the issue's updated_at) is what triggers a refetch, not every list reload.
export function Detail({ rows, onOpenSession, id, api, me, initial, root, stamp, live, onClose, onSelect, onError, onDone }: Props) {
  const [editProperties, setEditProperties] = useState(false);
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
    const ids = linkedSessions(issue).length ? linkedSessions(issue) : refs.slice(0, 2).map((r) => r.session_id);
    if (!ids.length) { setWork([]); return; }
    let alive = true;
    Promise.all(ids.map(async (sid) => { try { const d = await api.sessionDetail(sid); return { sid, agent: d.meta.agent, host: d.meta.host, title: d.meta.title || sid.slice(0, 8), files: d.files.map((f) => ({ path: f.path, changes: f.changes })), attachments: (d.attachments || []).map((a) => ({ id: a.id, name: a.name, path: a.path, mime: a.mime })) }; } catch { return null; } }))
      .then((rows) => { if (alive) setWork(rows.filter((r): r is NonNullable<typeof r> => !!r && (r.files.length > 0 || r.attachments.length > 0))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id, issue?.labels?.join(","), refs.map((r) => r.session_id).join(",")]);
  const [pits, setPits] = useState<Pitfall[]>([]);

  // Pitfalls tagged with this task or its project — shown before anyone starts working.
  useEffect(() => {
    let alive = true;
    api.memories().then((ms) => { if (alive) setPits(ms.map(parsePitfall).filter((p) => p.isPit)); }).catch(() => {});
    return () => { alive = false; };
  }, [id, api]);

  useEffect(() => {
    let alive = true;
    api.taskSessions(id).then((r) => { if (alive) setRefs(r); }).catch(() => {});
    const t = window.setInterval(() => api.taskSessions(id).then((r) => { if (alive) setRefs(r); }).catch(() => {}), 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [id, api]);

  const copyResume = async (cmd: string) => {
    try { await api.copy(cmd); onDone("恢复命令已复制，去终端粘贴回车"); } catch (e) { onError(String(e)); }
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
  const [wf, setWf] = useState<"" | "discuss" | "split">("");
  const [wfKinds, setWfKinds] = useState<string[]>(["codex"]);
  const [wfQuestion, setWfQuestion] = useState("");
  const [wfRows, setWfRows] = useState<{ kind: string; title: string; desc: string }[]>([{ kind: "codex", title: "", desc: "" }]);
  const [wfBusy, setWfBusy] = useState(false);
  const refreshAfterWorkflow = async () => { try { const [i, c] = await Promise.all([api.show(id), api.comments(id)]); setIssue(i); setComments(c); } catch { /* next stamp reloads */ } };
  const runDiscuss = async () => {
    if (!wfKinds.length) return;
    setWfBusy(true);
    try { const raw = await api.on("local", ["discuss", id, "--with", wfKinds.join(","), ...(wfQuestion.trim() ? ["--question", wfQuestion.trim()] : []), "--json"]); const r = JSON.parse(raw.slice(raw.indexOf("{"))); onDone(`讨论结束：${(r.comments?.length ?? 1) - 1} 条发言`); setWf(""); await refreshAfterWorkflow(); }
    catch (e) { onError(String(e)); } finally { setWfBusy(false); }
  };
  const runSplit = async () => {
    const rows = wfRows.filter((r) => r.title.trim());
    if (!rows.length) return;
    setWfBusy(true);
    try { const raw = await api.on("local", ["split", id, ...rows.flatMap((r) => ["--to", `${r.kind}:${r.title.trim()}${r.desc.trim() ? "|" + r.desc.trim() : ""}`]), "--json"]); const r = JSON.parse(raw.slice(raw.indexOf("{"))); onDone(`已拆出 ${r.subtasks?.length ?? rows.length} 个子任务并派出`); setWf(""); await refreshAfterWorkflow(); }
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

  if (!issue) return <aside className="detail"><div className="dh"><span className="id">{id}</span><button className="x" onClick={onClose}>✕</button></div><div className="empty">载入中…</div></aside>;

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
      onDone("留言已发");
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const who = actorOf(issue.assignee, me);
  const st = statusLabel(issue);
  const ac = parseAcceptance(issue.acceptance_criteria);
  const events = eventsFrom(history, comments, audit);

  const proj = projectOf(issue);
  const related = pits.filter((p) => p.task === id || (proj && p.project === proj));

  const toggleAc = (idx: number) => act("验收项已更新", async () => {
    const next = ac.map((a, i) => (i === idx ? { ...a, done: !a.done } : a));
    await api.update(id, { acceptance: serializeAcceptance(next) });
  });

  return (
    <aside className="detail">
      <div className="dh">
        <span className="id" title={"任务编号：Beads 自动生成，前缀是板的名字（task），后面三位是随机编码，没有含义，只用来唯一标识"}>{issue.id}</span><span>·</span><span>{projectOf(issue) || "未分项目"}</span>
        <button className="btn ghost sm" onClick={() => { setEditProperties(v => !v); setClosing(false); }}>{editProperties ? "收起编辑" : "编辑属性"}</button>
        <button className="x" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className="dbody">
        {editTitle === null ? (
          <h3 onClick={() => { if (editProperties) setEditTitle(issue.title); }} title={editProperties ? "点击编辑标题" : undefined}>{issue.title}</h3>
        ) : (
          <textarea className="title" value={editTitle} autoFocus rows={2} onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditTitle(null); if (e.key === "Enter") { e.preventDefault(); const t = editTitle.trim(); setEditTitle(null); if (t && t !== issue.title) act("标题已改", () => api.update(id, { title: t })); } }}
            onBlur={() => { const t = editTitle.trim(); setEditTitle(null); if (t && t !== issue.title) act("标题已改", () => api.update(id, { title: t })); }} />
        )}

        <div className="props">
          <span className="k">状态</span>
          <span className="v">
            {!editProperties ? <span className={`st sm ${st.cls}`}>{st.text}</span> : <select value={issue.status} disabled={busy} onChange={(e) => {
              const v = e.target.value;
              if (v === "closed") { setClosing(true); return; }
              if (issue.status === "closed") return act("已重新打开", async () => { await api.reopen(id); if (v !== "open") await api.setStatus(id, v); });
              return act("状态已改", () => api.setStatus(id, v));
            }}>
              <option value="open">待办</option>
              <option value="in_progress">进行中</option>
              <option value="blocked">阻塞</option>
              <option value="deferred">搁置</option>
              <option value="closed">已完成</option>
            </select>}
          </span>
          <span className="k">负责</span>
          <span className="v">{who ? <><Avatar actor={who} />{who.name}</> : <span className="muted">未认领</span>}</span>
          <span className="k">优先级</span>
          <span className="v">
            {!editProperties ? <Pri p={issue.priority} /> : <select value={issue.priority} disabled={busy} onChange={(e) => act("优先级已改", () => api.update(id, { priority: Number(e.target.value) }))}>
              {[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}{p === 0 ? " 最急" : p === 4 ? " 最低" : ""}</option>)}
            </select>}
          </span>
          {delegatedBy(issue) && (<><span className="k">派活</span><span className="v">{actorOf(delegatedBy(issue), me)?.name ?? delegatedBy(issue)} 派给 {actorOf(delegatedTo(issue), me)?.name ?? delegatedTo(issue)}</span></>)}
          <span className="k">类型</span><span className="v">{TYPE_LABEL[issue.issue_type] ?? issue.issue_type}</span>
          <span className="k">项目</span><span className="v"><ProjectTag name={projectOf(issue)} /></span>
          {root && (<><span className="k">源自</span><span className="v"><span className="link" onClick={() => onSelect(root.id)} title={root.title}>{root.id}</span><span className="muted" style={{ fontSize: 12 }}>{root.title}</span></span></>)}
          {(issue.labels ?? []).filter((l) => !l.startsWith("project:") && !l.startsWith("session:") && !l.startsWith("session-origin:") && !l.startsWith("outcome-task:") && !l.startsWith("dispatch:") && !l.startsWith("delegated-") && !l.startsWith("host:") && l !== "reviewed").length > 0 && (<><span className="k">标签</span><span className="v mono" style={{ fontSize: 12 }}>{(issue.labels ?? []).filter((l) => !l.startsWith("project:") && !l.startsWith("session:") && !l.startsWith("session-origin:") && !l.startsWith("outcome-task:") && !l.startsWith("dispatch:") && !l.startsWith("delegated-") && !l.startsWith("host:") && l !== "reviewed").join(" · ")}</span></>)}
          {(issue.dependencies ?? []).length > 0 && (<><span className="k">依赖</span><span className="v">{issue.dependencies!.map((d) => <span key={d.id} className="link" onClick={() => onSelect(d.id)} title={d.title}>{d.id}{d.status === "closed" ? " ✓" : ""}</span>)}</span></>)}
          {(issue.dependents ?? []).length > 0 && (<><span className="k">被依赖</span><span className="v">{issue.dependents!.map((d) => <span key={d.id} className="link" onClick={() => onSelect(d.id)} title={d.title}>{d.id}</span>)}</span></>)}
          <span className="k">创建</span><span className="v mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{fmtTime(issue.created_at)}{issue.created_by ? ` · ${actorOf(issue.created_by, me)?.name}` : ""}</span>
          {issue.closed_at && (<><span className="k">完成</span><span className="v mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{fmtTime(issue.closed_at)}</span></>)}
        </div>

        {editProperties && <div className="actions">
          {issue.status !== "closed" && !closing && <button className="btn sm" disabled={busy} onClick={() => setClosing(true)}>标记完成</button>}
          {issue.status === "closed" && <button className="btn sm" disabled={busy} onClick={() => act("已重新打开", () => api.reopen(id))}>重新打开</button>}
          {closing && (
            <div className="reason">
              <input autoFocus placeholder="完成说明（交付内容与验证结果）" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) { setClosing(false); act("已完成", () => api.close(id, reason.trim())); } if (e.key === "Escape") setClosing(false); }} />
              <button className="btn primary sm" disabled={!reason.trim() || busy} onClick={() => { setClosing(false); act("已完成", () => api.close(id, reason.trim())); }}>完成</button>
              <button className="btn ghost sm" onClick={() => setClosing(false)}>取消</button>
            </div>
          )}
        </div>}

        <section className="sec sec-origin"><h4>来自哪次会话</h4><TaskRelations issue={issue} rows={rows} api={api} onOpen={onOpenSession} onSaved={()=>onDone("会话归属已保存")}/></section>
        {(() => {
          const discussion = comments.filter((c) => c.text.trimStart().startsWith("【讨论】")).sort((a, b) => a.created_at.localeCompare(b.created_at));
          const subtasks = (issue.dependents ?? []).filter((d) => !d.dependency_type || d.dependency_type === "parent-child");
          if (issue.status === "closed" && !discussion.length && !subtasks.length) return null;
          return (
            <section className="sec workflow">
              <h4>讨论与分工 <span className="muted">先让几个 Agent 各说一次，再拆成子任务派出去</span></h4>
              {discussion.length > 0 && <div className="discussion">{discussion.map((c) => { const a = actorOf(c.author, me); return <div key={c.id} className="say"><Avatar actor={a} /><div><div className="l1"><b>{a?.name ?? c.author}</b><span className="ts">{relTime(c.created_at)}</span></div><Markdown src={c.text.trimStart().slice(4)} className="compact" /></div></div>; })}</div>}
              {subtasks.length > 0 && <div className="subtasks">{subtasks.map((d) => { const st = statusLabel(d); const who = actorOf(d.assignee, me); return <button key={d.id} className="subtask" onClick={() => onSelect(d.id)}><span className={`st sm ${st.cls}`}>{st.text}</span><span className="t">{d.title}</span>{who && <span className="muted small">{who.name}</span>}<span className="mono muted small">{d.id}</span></button>; })}</div>}
              {issue.status !== "closed" && wf === "" && <div className="task-links"><button className="btn sm" onClick={() => setWf("discuss")}>发起讨论…</button><button className="btn sm" onClick={() => setWf("split")}>拆分并派活…</button></div>}
              {wf === "discuss" && <div className="wf-form">
                <div className="task-links">{KINDS.map(([k, l]) => <label key={k} className="chip"><input type="checkbox" checked={wfKinds.includes(k)} onChange={(e) => setWfKinds(e.target.checked ? [...wfKinds, k] : wfKinds.filter((x) => x !== k))} /> {l}</label>)}</div>
                <input placeholder="想让他们决定什么（可空）" value={wfQuestion} onChange={(e) => setWfQuestion(e.target.value)} />
                <p className="muted small">每个 Agent 会在这台电脑的 Herdr 里起一个会话，读任务和前面的发言，只留一条【讨论】评论就停。通常要几分钟，期间这个面板会等着。</p>
                <div className="task-links"><button className="btn primary sm" disabled={wfBusy || !wfKinds.length} onClick={() => void runDiscuss()}>{wfBusy ? "讨论进行中…" : "开始讨论"}</button><button className="btn sm" disabled={wfBusy} onClick={() => setWf("")}>取消</button></div>
              </div>}
              {wf === "split" && <div className="wf-form">
                {wfRows.map((r, n) => <div key={n} className="wf-row"><select value={r.kind} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, kind: e.target.value } : x))}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><input placeholder="子任务标题" value={r.title} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, title: e.target.value } : x))} /><input placeholder="说明（可空）" value={r.desc} onChange={(e) => setWfRows(wfRows.map((x, i) => i === n ? { ...x, desc: e.target.value } : x))} /></div>)}
                <div className="task-links"><button className="link" onClick={() => setWfRows([...wfRows, { kind: "codex", title: "", desc: "" }])}>＋ 再加一个</button></div>
                <p className="muted small">每个子任务建成父任务的子项，标上谁派给谁，并在 Herdr 里起对应 Agent 开始做。</p>
                <div className="task-links"><button className="btn primary sm" disabled={wfBusy || !wfRows.some((r) => r.title.trim())} onClick={() => void runSplit()}>{wfBusy ? "拆分中…" : "拆分并派出"}</button><button className="btn sm" disabled={wfBusy} onClick={() => setWf("")}>取消</button></div>
              </div>}
            </section>
          );
        })()}
        {issue.status === "closed" && <section className="sec review-evidence">
          <h4>交付与验证 <span className="muted">{isReviewed(issue) ? "已记录复核通过" : needsReview(issue) ? "等待 Agent 复核" : "已完成 · 无需你点击审核"}</span></h4>
          <p className="review-gap">{ac.length ? `${ac.filter((a) => a.done).length}/${ac.length} 项已勾选 · ${ac.filter((a) => !a.done).length} 项仍待核对` : "尚未填写验收标准"}</p>
          {ac.some((a) => !a.done) && <details open><summary>待核对的验收项</summary><ul>{ac.filter((a) => !a.done).map((a, n) => <li key={n}>{a.text}</li>)}</ul></details>}
          <details><summary>查看记录依据 · {comments.length} 条进展 / 留言 · {refs.length} 个关联会话</summary>
            <p className="muted small">以下是原始记录，测试结果需要结合完成说明和会话核对。</p>
            {comments.length ? [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3).map((c) => <div key={c.id} className="evidence-note"><b>{c.author} · {fmtTime(c.created_at)}</b><Markdown src={c.text} className="compact" /></div>) : <p>没有进展记录</p>}
            {refs.map((r) => <button key={r.session_id} className="btn sm" onClick={() => onOpenSession(r.session_id)}>查看会话 · {r.project || r.session_id.slice(0, 8)}</button>)}
          </details>
          {!issue.close_reason && <p className="review-gap">缺少完成说明，尚无法判断交付内容与验证结果。</p>}
        </section>}

        {issue.status === "closed" && issue.close_reason && <div className="sec">
          <h4>完成说明</h4>
          <p className={expandedReason ? "" : "completion-preview"}>{issue.close_reason}</p>
          <button className="link-btn" aria-expanded={expandedReason} onClick={() => setExpandedReason(!expandedReason)}>{expandedReason ? "收起" : "展开完成说明"}</button>
        </div>}

        <div className="sec">
          <h4>描述</h4>
          {editDesc === null ? (
            issue.description ? <div className="md-edit" onDoubleClick={() => setEditDesc(issue.description ?? "")} title="双击编辑"><Markdown src={issue.description} className="compact" /></div>
              : <p className="empty-p" onClick={() => setEditDesc("")} title="点击编辑">还没写描述——下一个接手的 Agent 会不知道为什么做这件事。</p>
          ) : (
            <textarea className="edit" value={editDesc} autoFocus onChange={(e) => setEditDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditDesc(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
              onBlur={() => { const d = editDesc; setEditDesc(null); if (d !== (issue.description ?? "")) act("描述已改", () => api.update(id, { description: d })); }} />
          )}
        </div>

        <div className="sec">
          <h4>验收标准{editAc === null && <button className="btn ghost sm" onClick={() => setEditAc(issue.acceptance_criteria ?? "")}>{ac.length ? "编辑" : "添加"}</button>}</h4>
          {editAc === null ? (
            ac.length ? <ul>{ac.map((a, i) => <li key={i}><span className={`box${a.done ? " on" : ""}`} onClick={() => toggleAc(i)} role="checkbox" aria-checked={a.done}>{a.done ? "✓" : ""}</span><span>{a.text}</span></li>)}</ul> : <p className="empty-p" style={{ margin: 0 }}>没有验收标准</p>
          ) : (
            <textarea className="edit" value={editAc} autoFocus placeholder={"- [ ] 一行一条\n- [x] 已完成的打 x"} onChange={(e) => setEditAc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditAc(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur(); }}
              onBlur={() => { const v = editAc; setEditAc(null); if (v !== (issue.acceptance_criteria ?? "")) act("验收标准已改", () => api.update(id, { acceptance: v })); }} />
          )}
        </div>

        {related.length > 0 && (
          <details className="sec context-fold">
            <summary>相关的坑 <span className="muted">{related.length} 条 · 任务与项目背景</span></summary>
            <div className="rel-pits">
              {related.map((p) => (
                <div key={p.key} className="rel-pit">
                  <div className="l1"><span className="lbl trap">坑</span><span>{p.trap}</span></div>
                  {p.fix && <div className="l1"><span className="lbl fix">解法</span><span>{p.fix}</span></div>}
                </div>
              ))}
            </div>
          </details>
        )}

        <details className="sec context-fold" open={work.length > 0}>
          <summary>文件修改与产出 <span className="muted">{work.reduce((n, w) => n + w.files.length, 0)} 个文件 · {work.reduce((n, w) => n + w.attachments.length, 0)} 个产物</span></summary>
          {work.length === 0 ? <p className="empty-p" style={{ margin: 0 }}>关联的会话里没有记录到文件改动或产物。</p> : work.map((w) => (
            <div key={w.sid} className="work-block">
              <div className="work-head"><button className="link" onClick={() => onOpenSession(w.sid)}>{w.title} ↗</button></div>
              {w.files.length > 0 && <div className="work-files">{w.files.map((f) => <details key={f.path} className="fdiff file work-file" data-menu="file" data-id={f.path}><summary title={f.path}><code>{f.path.replace(/^\/Users\/[^/]+/, "~").replace(/^(.{0,18}).*?([^/]+\/[^/]+)$/, (m, a, b) => (m.length > 44 ? `${a}…/${b}` : m))}</code><span className="muted small">{f.changes.length} 次</span></summary><FileHunks changes={f.changes} /></details>)}</div>}
              {w.attachments.length > 0 && <MediaProvider api={api} session={{ agent: w.agent, session_id: w.sid, host: w.host }}><div className="work-attachments">{w.attachments.map((a) => a.mime.startsWith("image/") ? <InlineImage key={a.id} id={a.id} /> : <button key={a.id} className="chip" title={a.path || a.mime} onClick={() => (a.path ? api.openPath(a.path).catch(() => onOpenSession(w.sid)) : onOpenSession(w.sid))}>📄 {a.name}</button>)}</div></MediaProvider>}
            </div>
          ))}
        </details>

        <details className="sec context-fold">
          <summary>对话中提到过 <span className="muted">{refs.length} 个会话 · 仅供参考，不代表归属</span></summary>
          {refs.length === 0 ? (
            <p className="empty-p" style={{ margin: 0 }}>还没有会话提到 {id}。以上方「来自哪次会话」为准。</p>
          ) : (
            <div className="sess-list">
              {refs.map((r) => {
                const a = actorOf(r.agent, me);
                const l = live.find((s) => s.session_id === r.session_id);
                return (
                  <div key={r.session_id} className={`sref${l ? " live" : ""}`} title={r.cwd}>
                    <Avatar actor={a} />
                    <div className="info">
                      <div>{r.project || r.cwd || "（未知目录）"} <span className="muted">· {r.mentions} 次提到</span>{l ? <span className="muted"> · {l.source_app}{l.state === "working" ? " · 在跑" : " · 开着"}</span> : null}</div>
                      <div className="l2">{r.session_id} · {r.last_at ? `最近 ${durSince(r.last_at)}前` : ""}</div>
                    </div>
                    <button className="btn sm" onClick={() => onOpenSession(r.session_id)}>查看记录</button>
                    <button className="copy-btn" onClick={() => copyResume(r.resume_cmd)} title={r.resume_cmd}>{"复制恢复命令"}</button>
                  </div>
                );
              })}
            </div>
          )}
        </details>

        <div className="sec">
          <h4>活动</h4>
          <div className="act">
            {events.length === 0 && <p className="empty-p">还没有活动</p>}
            {events.map((ev, i) => {
              const a = actorOf(ev.actor, me);
              return (
                <div className="ev" key={i}>
                  {a ? <Avatar actor={a} /> : <span className="av" style={{ background: "var(--line-2)", color: "var(--ink-2)" }}>·</span>}
                  <div>
                    <div className="l1"><b>{a?.name ?? "系统"}</b><span className="muted">{ev.kind === "comment" ? "留言" : ev.text}</span><span className="ts" title={fmtTime(ev.ts)}>{relTime(ev.ts)}</span></div>
                    {ev.kind === "comment" ? <div className="note"><Markdown src={ev.text} className="compact" /></div> : ev.cmd ? <span className="cmd">{ev.cmd}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="compose">
        <textarea placeholder="留言给下一个接手的 Agent…（⌘⏎ 发送）" value={draft} disabled={busy} rows={1} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendComment(); } }} />
        <button className="btn primary" disabled={!draft.trim() || busy} onClick={() => void sendComment()}>发送</button>
      </div>
    </aside>
  );
}
