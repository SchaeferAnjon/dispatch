import { useEffect, useMemo, useRef, useState } from "react";
import { DiscussStage } from "./DiscussStage";
import type { Api } from "../api";
import type { Issue } from "../types";
import { actorOf, projectOf, relTime } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KIND_ACTOR } from "./Delegate";
import { DiscussChat } from "./DiscussChat";
import { DISCUSSION_LABEL, delegatePrompt, ideaText, imagePaths, partName, partsFromDescription, useDiscussion } from "./Discuss";
import { useT } from "../i18n";

interface Props {
  api: Api; me: string; issues: Issue[]; initialTask?: string | null;
  onShown: (taskId: string | null) => void;
  onNew: () => void;
  onOpened: (taskId: string, intent?: "split") => void;
  onDelegate: (taskId: string, prompt: string, leader?: { kind: string; model: string }) => void;
  onDone: (m: string) => void; onError: (m: string) => void;
}

// 讨论: every discussion in one place. The list on the left, and for the chosen one a summary
// column (the idea, the members, the conclusion, the document, the actions) next to the group
// chat itself — the same thread and typing bubbles as the dialog, so a round started anywhere
// is visible here as it happens. On a phone it is one column: list → chat, summary folded on top.
export function DiscussView({ api, me, issues, initialTask, onShown, onNew, onOpened, onDelegate, onDone, onError }: Props) {
  const t = useT();
  const all = useMemo(() => issues.filter((i) => i.labels?.includes(DISCUSSION_LABEL)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [issues]);
  const [task, setTask] = useState<string>(initialTask ?? "");
  const [showList, setShowList] = useState(!initialTask);
  // Both side columns fold on their own and stay that way; the phone layout has its own rules (list or chat).
  const remembered = (k: string) => { try { return localStorage.getItem(k) !== "0"; } catch { return true; } };
  const remember = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* private mode */ } };
  const [listOpen, setListOpenRaw] = useState(() => remembered("dispatch-discuss-list"));
  const setListOpen = (v: boolean) => { setListOpenRaw(v); remember("dispatch-discuss-list", v); };
  const [showSummary, setShowSummaryRaw] = useState(() => window.innerWidth > 640 && remembered("dispatch-discuss-summary"));
  const setShowSummary = (v: boolean) => { setShowSummaryRaw(v); if (window.innerWidth > 640) remember("dispatch-discuss-summary", v); };
  const [showDoc, setShowDoc] = useState(false);
  // The round-table view above the transcript; remembered per browser, on by default.
  const [stage, setStage] = useState(() => { try { return localStorage.getItem("dispatch-discuss-stage") !== "0"; } catch { return true; } });
  // With room to spare (both side columns folded, or a very wide window) the conversation sits on
  // the left and the round table takes the right half at a larger size.
  const chatRef = useRef<HTMLElement | null>(null);
  const [chatWidth, setChatWidth] = useState(0);
  useEffect(() => {
    const el = chatRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((es) => setChatWidth(es[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [task, issues.length]);
  const [q, setQ] = useState("");
  const [withArchived, setWithArchived] = useState(false);
  useEffect(() => { if (initialTask && initialTask !== task) { setTask(initialTask); setShowList(false); } }, [initialTask]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onShown(task || null); }, [task]);  // eslint-disable-line react-hooks/exhaustive-deps
  const issue = all.find((i) => i.id === task) ?? issues.find((i) => i.id === task);
  const { parts, leader } = useMemo(() => partsFromDescription(issue?.description), [issue?.description]);
  const d = useDiscussion({ api, me, issues, task, parts, leader, watch: true, onDone, onError });
  const rows = all.filter((i) => (withArchived || i.status !== "closed") && (!q.trim() || i.title.toLowerCase().includes(q.trim().toLowerCase()) || i.id.includes(q.trim())));
  const pick = (id: string) => { setTask(id); setShowList(false); setShowDoc(false); };
  const leaderPart = d.leaderPart;
  const delegate = () => { if (!task) return; onDelegate(task, delegatePrompt(task), leaderPart ? { kind: leaderPart.kind, model: leaderPart.model } : undefined); };
  const archive = async () => {
    if (!task || !issue) return;
    try {
      if (issue.status !== "closed") await api.close(task, "讨论结束，归档");
      await api.labels(task, ["dispatch:archived"], []);
      onDone(t("讨论已归档")); setTask(""); setShowList(true);
    } catch (e) { onError(String(e)); }
  };
  const images = imagePaths(ideaText(issue?.description));
  const side = chatWidth >= 1280 || (!listOpen && !showSummary && chatWidth >= 900);

  return (
    <div className={`discuss-view${showList ? " list-open" : ""}${task ? " has-task" : ""}${listOpen ? "" : " list-folded"}${showSummary ? "" : " summary-folded"}`}>
      <aside className="disc-list">
        <button className="disc-rail" onClick={() => setListOpen(true)} title={t("展开讨论列表")} aria-label={t("展开讨论列表")}><span className="arrow">›</span><span className="label">{t("全部讨论")} · {rows.length}</span></button>
        <div className="disc-list-head">
          <input className="search-in" placeholder={t("找讨论…")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("找讨论")} />
          <button className="btn primary sm" onClick={onNew}>{t("＋ 讨论一个念头")}</button>
          <button className="btn ghost sm disc-fold-btn" onClick={() => setListOpen(false)} title={t("收起讨论列表")} aria-label={t("收起讨论列表")}>‹</button>
        </div>
        <label className="muted small disc-list-opt"><input type="checkbox" checked={withArchived} onChange={(e) => setWithArchived(e.target.checked)} /> {t("含已归档")}</label>
        {rows.length === 0 && <div className="empty small">{all.length ? t("没有匹配的讨论") : t("还没有讨论。点「讨论一个念头」开始。")}</div>}
        {rows.map((i) => {
          const p = partsFromDescription(i.description);
          const concluded = /\n## 讨论结论/.test(i.description ?? "");
          const documented = /\n## 讨论文档/.test(i.description ?? "");
          const runningHere = i.id === task && d.running;
          return (
            <button key={i.id} className={`disc-row${i.id === task ? " on" : ""}${i.status === "closed" ? " closed" : ""}`} onClick={() => pick(i.id)} data-task={i.id}>
              <div className="t">{i.title.replace(/^【讨论】/, "")}</div>
              <div className="m">
                <span className="faces">{p.parts.map((x, n) => <Avatar key={n} actor={actorOf(KIND_ACTOR[x.kind] ?? x.kind, me)} size={18} />)}</span>
                {projectOf(i) && <span className="chip sm">{projectOf(i)}</span>}
                {runningHere ? <span className="disc-live-dot">{t("进行中")}</span> : concluded || documented ? <span className="muted small">{documented ? t("有文档") : t("有结论")}</span> : null}
                <span className="spacer" /><span className="muted small">{relTime(i.updated_at)}</span>
              </div>
            </button>
          );
        })}
      </aside>

      {!task && <div className="disc-empty empty"><p>{t("左边挑一个讨论，或者")}</p><button className="btn primary" onClick={onNew}>{t("讨论一个念头")}</button></div>}
      {task && issue && (
        <>
          <aside className={`disc-summary${showSummary ? "" : " folded"}`}>
            <button className="disc-rail" onClick={() => setShowSummary(true)} title={t("展开摘要")} aria-label={t("展开摘要")}><span className="arrow">›</span><span className="label">{issue.title.replace(/^【讨论】\s*/, "")}</span></button>
            <div className="disc-summary-head">
              <button className="btn ghost sm disc-back" onClick={() => setShowList(true)}>{t("‹ 全部讨论")}</button>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => setShowSummary(!showSummary)} title={showSummary ? t("收起摘要") : t("展开摘要")}>{showSummary ? t("收起") : t("摘要")}</button>
            </div>
            {showSummary && <div className="disc-summary-body">
              <h3 className="disc-title">{issue.title.replace(/^【讨论】/, "")}<span className="mono muted small"> {issue.id}</span></h3>
              <section className="disc-sec"><h4>{t("念头")}</h4><Markdown src={ideaText(issue.description)} className="compact" />
                {images.length > 0 && <div className="disc-images">{images.map((p) => <span key={p} className="chip sm mono" title={p}>🖼 {p.split("/").pop()}</span>)}</div>}
              </section>
              <section className="disc-sec"><h4>{t("参加者")}</h4>
                <div className="disc-members">{parts.map((p, n) => <span key={n} className={`chip${n === leader ? " disc-leader-tag" : ""}`}><Avatar actor={actorOf(KIND_ACTOR[p.kind] ?? p.kind, me)} size={16} /> {partName(p)}{n === leader ? ` · ${t("领队")}` : ""}</span>)}{parts.length === 0 && <span className="muted small">{t("描述里没记参加者")}</span>}</div>
              </section>
              <section className="disc-sec"><h4>{t("结论")}</h4>
                {d.conclusion ? <div className="disc-conclusion"><div className="l1"><span className="muted small">{d.conclusion.when.includes("T") ? relTime(d.conclusion.when) : d.conclusion.when}{d.conclusion.by ? ` · ${d.conclusion.by}` : ""}</span></div><Markdown src={d.conclusion.text} className="compact" /></div> : <p className="muted small">{t("还没有结论。「整理成文档」会先写一条结论（领队或总结模型），再整理文档。")}</p>}
              </section>
              <section className="disc-sec"><h4>{t("文档")}</h4>
                {d.hasDoc ? <>{showDoc ? <div className="disc-doc"><Markdown src={d.docText} className="compact" /><button className="link sm" onClick={() => setShowDoc(false)}>{t("收起")}</button></div> : <button className="btn sm" onClick={() => setShowDoc(true)}>{t("看文档")}</button>}</> : <p className="muted small">{t("还没整理成文档。")}</p>}
              </section>
              <div className="disc-actions">
                <button className="btn primary sm" disabled={d.running || !parts.length} onClick={() => void d.round(task)} title={parts.length ? t("让参加者再回应一轮（领队最后说）") : t("描述里没记参加者，从对话框重开")}>{d.running ? t("讨论中…") : t("让他们回应")}</button>
                <button className="btn sm" disabled={d.running || d.docBusy} onClick={() => { void d.makeDoc().then((ok) => { if (ok) setShowDoc(true); }); }}>{d.docBusy ? t("整理中…") : d.hasDoc ? t("重新整理") : t("整理成文档")}</button>
                <button className="btn sm" disabled={d.running || !d.hasDoc} onClick={delegate} title={d.hasDoc ? t("读这份文档开工，默认派给领队") : t("先整理成文档")}>{t("派 Agent 去做 →")}</button>
                <button className="btn sm" disabled={d.running} onClick={() => onOpened(task, "split")}>{t("拆分")}</button>
                <button className="btn ghost sm" disabled={d.running || issue.labels?.includes("dispatch:archived")} onClick={() => void archive()}>{issue.labels?.includes("dispatch:archived") ? t("已归档") : t("归档")}</button>
              </div>
            </div>}
          </aside>
          <section className={`disc-chat${side && stage && parts.length > 0 ? " side" : ""}`} ref={chatRef}>
            {stage && parts.length > 0 && <div className="disc-stage-col"><DiscussStage d={d} parts={parts} leader={leader} me={me} topic={issue.title.replace(/^【讨论】\s*/, "")} big={side} /></div>}
            <div className="disc-chat-col">
            <button className="link stage-toggle" onClick={() => { const v = !stage; setStage(v); try { localStorage.setItem("dispatch-discuss-stage", v ? "1" : "0"); } catch { /* private mode */ } }}>{stage ? t("收起现场") : t("看讨论现场")}</button>
            <DiscussChat api={api} d={d} me={me} onError={onError} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
