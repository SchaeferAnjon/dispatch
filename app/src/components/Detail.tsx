import { useEffect, useState } from "react";
import type { Api } from "../api";
import { actorOf, durSince, eventsFrom, fmtTime, isReviewed, needsReview, parseAcceptance, parsePitfall, projectOf, relTime, serializeAcceptance, statusLabel, type Interaction, type Pitfall } from "../derive";
import type { Activity, Comment, HistoryEntry, Issue, Session, SessionRef } from "../types";
import { Avatar, Pri, ProjectTag, TYPE_LABEL } from "./ui";
import { Markdown } from "./Markdown";

import { TaskRelations } from "./ProjectHub";

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
        <span className="id">{issue.id}</span><span>·</span><span>{projectOf(issue) || "未分项目"}</span>
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
          <span className="k">类型</span><span className="v">{TYPE_LABEL[issue.issue_type] ?? issue.issue_type}</span>
          <span className="k">项目</span><span className="v"><ProjectTag name={projectOf(issue)} /></span>
          {root && (<><span className="k">源自</span><span className="v"><span className="link" onClick={() => onSelect(root.id)} title={root.title}>{root.id}</span><span className="muted" style={{ fontSize: 12 }}>{root.title}</span></span></>)}
          {(issue.labels ?? []).filter((l) => !l.startsWith("project:") && !l.startsWith("session:") && !l.startsWith("session-origin:") && !l.startsWith("outcome-task:") && !l.startsWith("dispatch:") && l !== "reviewed").length > 0 && (<><span className="k">标签</span><span className="v mono" style={{ fontSize: 12 }}>{(issue.labels ?? []).filter((l) => !l.startsWith("project:") && !l.startsWith("session:") && !l.startsWith("session-origin:") && !l.startsWith("outcome-task:") && !l.startsWith("dispatch:") && l !== "reviewed").join(" · ")}</span></>)}
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

        <section className="sec"><h4>所属会话</h4><TaskRelations issue={issue} rows={rows} api={api} onOpen={onOpenSession} onSaved={()=>onDone("会话归属已保存")}/></section>
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

        <details className="sec context-fold">
          <summary>对话中提到过 <span className="muted">{refs.length} 个会话 · 仅供参考，不代表归属</span></summary>
          {refs.length === 0 ? (
            <p className="empty-p" style={{ margin: 0 }}>还没有会话提到 {id}。归属以上方「所属会话」为准。</p>
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
