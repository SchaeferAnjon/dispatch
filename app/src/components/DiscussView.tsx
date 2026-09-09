import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Issue } from "../types";
import { actorOf, projectOf, relTime } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KIND_ACTOR } from "./Delegate";
import { DiscussChat } from "./DiscussChat";
import { DISCUSSION_LABEL, delegatePrompt, ideaText, imagePaths, partName, partsFromDescription, useDiscussion } from "./Discuss";

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
  const all = useMemo(() => issues.filter((i) => i.labels?.includes(DISCUSSION_LABEL)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [issues]);
  const [task, setTask] = useState<string>(initialTask ?? "");
  const [showList, setShowList] = useState(!initialTask);
  const [showSummary, setShowSummary] = useState(() => window.innerWidth > 760);
  const [showDoc, setShowDoc] = useState(false);
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
      onDone("讨论已归档"); setTask(""); setShowList(true);
    } catch (e) { onError(String(e)); }
  };
  const images = imagePaths(ideaText(issue?.description));

  return (
    <div className={`discuss-view${showList ? " list-open" : ""}${task ? " has-task" : ""}`}>
      <aside className="disc-list">
        <div className="disc-list-head">
          <input className="search-in" placeholder="找讨论…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="找讨论" />
          <button className="btn primary sm" onClick={onNew}>＋ 讨论一个念头</button>
        </div>
        <label className="muted small disc-list-opt"><input type="checkbox" checked={withArchived} onChange={(e) => setWithArchived(e.target.checked)} /> 含已归档</label>
        {rows.length === 0 && <div className="empty small">{all.length ? "没有匹配的讨论" : "还没有讨论。点「讨论一个念头」开始。"}</div>}
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
                {runningHere ? <span className="disc-live-dot">进行中</span> : concluded || documented ? <span className="muted small">{documented ? "有文档" : "有结论"}</span> : null}
                <span className="spacer" /><span className="muted small">{relTime(i.updated_at)}</span>
              </div>
            </button>
          );
        })}
      </aside>

      {!task && <div className="disc-empty empty"><p>左边挑一个讨论，或者</p><button className="btn primary" onClick={onNew}>讨论一个念头</button></div>}
      {task && issue && (
        <>
          <aside className={`disc-summary${showSummary ? "" : " folded"}`}>
            <div className="disc-summary-head">
              <button className="btn ghost sm disc-back" onClick={() => setShowList(true)}>‹ 全部讨论</button>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => setShowSummary(!showSummary)} title={showSummary ? "收起摘要" : "展开摘要"}>{showSummary ? "收起" : "摘要"}</button>
            </div>
            {showSummary && <div className="disc-summary-body">
              <h3 className="disc-title">{issue.title.replace(/^【讨论】/, "")}<span className="mono muted small"> {issue.id}</span></h3>
              <section className="disc-sec"><h4>念头</h4><Markdown src={ideaText(issue.description)} className="compact" />
                {images.length > 0 && <div className="disc-images">{images.map((p) => <span key={p} className="chip sm mono" title={p}>🖼 {p.split("/").pop()}</span>)}</div>}
              </section>
              <section className="disc-sec"><h4>参加者</h4>
                <div className="disc-members">{parts.map((p, n) => <span key={n} className={`chip${n === leader ? " disc-leader-tag" : ""}`}><Avatar actor={actorOf(KIND_ACTOR[p.kind] ?? p.kind, me)} size={16} /> {partName(p)}{n === leader ? " · 领队" : ""}</span>)}{parts.length === 0 && <span className="muted small">描述里没记参加者</span>}</div>
              </section>
              <section className="disc-sec"><h4>结论</h4>
                {d.conclusion ? <div className="disc-conclusion"><div className="l1"><span className="muted small">{d.conclusion.when.includes("T") ? relTime(d.conclusion.when) : d.conclusion.when}{d.conclusion.by ? ` · ${d.conclusion.by}` : ""}</span></div><Markdown src={d.conclusion.text} className="compact" /></div> : <p className="muted small">还没有结论。「整理成文档」会先写一条结论（领队或总结模型），再整理文档。</p>}
              </section>
              <section className="disc-sec"><h4>文档</h4>
                {d.hasDoc ? <>{showDoc ? <div className="disc-doc"><Markdown src={d.docText} className="compact" /><button className="link sm" onClick={() => setShowDoc(false)}>收起</button></div> : <button className="btn sm" onClick={() => setShowDoc(true)}>看文档</button>}</> : <p className="muted small">还没整理成文档。</p>}
              </section>
              <div className="disc-actions">
                <button className="btn primary sm" disabled={d.running || !parts.length} onClick={() => void d.round(task)} title={parts.length ? "让参加者再回应一轮（领队最后说）" : "描述里没记参加者，从对话框重开"}>{d.running ? "讨论中…" : "让他们回应"}</button>
                <button className="btn sm" disabled={d.running || d.docBusy} onClick={() => { void d.makeDoc().then((ok) => { if (ok) setShowDoc(true); }); }}>{d.docBusy ? "整理中…" : d.hasDoc ? "重新整理" : "整理成文档"}</button>
                <button className="btn sm" disabled={d.running || !d.hasDoc} onClick={delegate} title={d.hasDoc ? "读这份文档开工，默认派给领队" : "先整理成文档"}>派 Agent 去做 →</button>
                <button className="btn sm" disabled={d.running} onClick={() => onOpened(task, "split")}>拆分</button>
                <button className="btn ghost sm" disabled={d.running || issue.labels?.includes("dispatch:archived")} onClick={() => void archive()}>{issue.labels?.includes("dispatch:archived") ? "已归档" : "归档"}</button>
              </div>
            </div>}
          </aside>
          <section className="disc-chat">
            <DiscussChat api={api} d={d} me={me} onError={onError} />
          </section>
        </>
      )}
    </div>
  );
}
