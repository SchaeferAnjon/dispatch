import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import type { Api } from "../api";
import type { Comment, Issue } from "../types";
import { actorOf, relTime, discussionConclusion } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KINDS, KIND_ACTOR } from "./Delegate";

const TAG = "【讨论】";
// Model choices per agent kind; "" = the agent's own default. Claude ids are the CLI aliases.
const MODELS: Record<string, [string, string][]> = {
  claude: [["", "默认"], ["claude-fable-5-1", "Fable 5.1（最强）"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku（快、省）"]],
  codex: [["", "默认"], ["gpt-5.5", "gpt-5.5"], ["gpt-5.6-terra", "gpt-5.6-terra"], ["gpt-6-astra", "gpt-6-astra"]],
  pi: [["", "默认"]], gemini: [["", "默认"]], opencode: [["", "默认"]],
};
type Participant = { kind: string; model: string };

interface Props { api: Api; projects: string[]; issues: Issue[]; me: string; initialProject?: string; initialTask?: string; onClose: () => void; onOpened: (taskId: string, intent?: "split") => void; onDelegate: (taskId: string, prompt: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

// 讨论一个念头: a thought — with or without a project — put to several agents at once. Each
// reads the context (project summary, open tasks, pits) and leaves one 【讨论】 comment; the
// summary model writes a 【结论】. It all lives on a 【讨论】 task, so it can be split into work.
// The thread is drawn live: each statement appears as it lands, the conclusion on top.
export function DiscussDialog({ api, projects, issues, me, initialProject, initialTask, onClose, onOpened, onDelegate, onDone, onError }: Props) {
  const [topic, setTopic] = useState("");
  const [project, setProject] = useState(initialProject ?? "");
  const [parts, setParts] = useState<Participant[]>([{ kind: "claude", model: "" }, { kind: "codex", model: "" }]);
  const withArg = parts.map((p) => p.model ? `${p.kind}:${p.model}` : p.kind).join(",");
  const [question, setQuestion] = useState("");
  // Pictures pasted into the thought: saved on this Mac, their paths go into the task so the agents can Read them.
  const [images, setImages] = useState<{ path: string; preview: string; name: string }[]>([]);
  const [saving, setSaving] = useState(0);
  const addFiles = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/"))) {
      setSaving((n) => n + 1);
      try {
        const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
        const t = await api.on("local", ["save-image", "--json"], JSON.stringify({ name: f.name || "pasted", data }));
        const r = JSON.parse(t.slice(Math.max(0, t.indexOf("{"))));
        setImages((xs) => [...xs, { path: r.path, preview: data, name: f.name || "粘贴的图片" }]);
      } catch (e) { onError(String(e)); }
      finally { setSaving((n) => n - 1); }
    }
  };
  const onPaste = (e: ReactClipboardEvent) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } };
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<string>(initialTask ?? "");
  const [comments, setComments] = useState<Comment[]>([]);
  // Two quiet rounds in a row (everyone skipped or only short acknowledgements): suggest wrapping up.
  const [quiet, setQuiet] = useState(0);
  // The conclusion just written by 整理成文档, shown before the issue list catches up.
  const [freshConclusion, setFreshConclusion] = useState<string>("");
  const timer = useRef<number>(0);

  // Watch the task's comments while agents talk (and once more after they stop).
  useEffect(() => {
    if (!task) return;
    let alive = true;
    const tick = async () => { try { const cs = await api.comments(task); if (alive) setComments(cs); } catch { /* next tick */ } };
    void tick();
    if (busy) timer.current = window.setInterval(tick, 3_000);
    return () => { alive = false; window.clearInterval(timer.current); };
  }, [api, task, busy]);
  // The typing bubbles: the CLI streams each member's reply into discussions/<task>.live.json
  // (queued → thinking → typing + text so far → done → posted); poll it while a round runs.
  type LiveMember = { kind: string; status: string; text: string; at: number };
  const [live, setLive] = useState<{ round: number; started: number; finished?: number; members: Record<string, LiveMember> } | null>(null);
  useEffect(() => {
    if (!task || !busy) { setLive(null); return; }
    let alive = true;
    const poll = async () => { try { const t = await api.on("local", ["discuss-live", task, "--json"]); const d = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))); if (alive && d.members) setLive(d); } catch { /* next tick */ } };
    void poll();
    const h = window.setInterval(poll, 1_000);
    return () => { alive = false; window.clearInterval(h); };
  }, [api, task, busy]);
  // Once a member's reply is posted, the comment poll shows it; the bubble stays until then.
  const postedAt = (m: LiveMember) => comments.some((c) => c.text.trimStart().startsWith(TAG) && actorOf(c.author, me)?.id === KIND_ACTOR[m.kind] && Date.parse(c.created_at) / 1000 >= (live?.started ?? 0) - 1);
  const bubbles = busy && live ? Object.entries(live.members).filter(([, m]) => m.status === "thinking" || m.status === "typing" || m.status === "done" || (m.status === "posted" && !postedAt(m))) : [];
  const skippedNow = busy && live ? Object.entries(live.members).filter(([, m]) => m.status === "skip").map(([w]) => w) : [];
  const erroredNow = busy && live ? Object.entries(live.members).filter(([, m]) => m.status === "error") : [];

  const go = async () => {
    if (!parts.length || (!task && !topic.trim())) return;
    setBusy(true);
    try {
      let id = task;
      if (!id) {
        const made = JSON.parse((await api.on("local", ["discuss", "--topic", topic.trim(), ...(project ? ["--project", project] : []), "--with", withArg, ...images.flatMap((im) => ["--image", im.path]), "--create-only", "--json"])).replace(/^[^{]*/, ""));
        id = made.task; setTask(id);
      }
      const raw = await api.on("local", ["discuss", id, "--with", withArg, "--rounds", "1", ...(question.trim() ? ["--question", question.trim()] : []), "--close", "--json"]);
      const r = JSON.parse(raw.slice(Math.max(0, raw.indexOf("{"))));
      setQuiet(r.quiet_rounds ?? 0);
      const skipped = (r.skipped?.length ?? 0), spoke = (r.comments ?? []).filter((c: Comment) => !/^【讨论】发起[:：]/.test(c.text.trimStart())).length;
      onDone(`这轮 ${spoke} 条发言${skipped ? `，${skipped} 人没话说` : ""}${(r.quiet_rounds ?? 0) >= 2 ? "；连续两轮没有新提议了，可以整理成文档收尾" : ""}`);
    } catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  };

  // The person is in the group too: a line typed here lands as a 【讨论】 comment, and「让他们回应」runs one more round.
  const [line, setLine] = useState("");
  const [full, setFull] = useState(false);
  // Pictures attached to a reply go the same way as the topic's: saved on this Mac, path in the comment.
  const [lineImages, setLineImages] = useState<{ path: string; preview: string }[]>([]);
  const addLineFiles = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/"))) {
      try {
        const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
        const t = await api.on("local", ["save-image", "--json"], JSON.stringify({ name: f.name || "reply", data }));
        const r = JSON.parse(t.slice(Math.max(0, t.indexOf("{"))));
        setLineImages((xs) => [...xs, { path: r.path, preview: data }]);
      } catch (e) { onError(String(e)); }
    }
  };
  const say = async () => {
    if (!task || (!line.trim() && !lineImages.length)) return;
    const text = `${TAG}${me}：${line.trim()}` + (lineImages.length ? "\n附图（用 Read 看）：\n" + lineImages.map((x) => x.path).join("\n") : "");
    try { await api.on("local", ["log", task, text]); setLine(""); setLineImages([]); const cs = await api.comments(task); setComments(cs); }
    catch (e) { onError(String(e)); }
  };
  // The document: the thread condensed into 背景/结论/方案/步骤/风险/验收, written into the task so
  // the next agent only needs `bd show`.
  const [doc, setDoc] = useState<string>("");
  const [docBusy, setDocBusy] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const makeDoc = async () => {
    if (!task) return;
    setDocBusy(true);
    try { const t = await api.on("local", ["discuss-doc", task, "--json"]); const r = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))); setDoc(r.doc); if (r.conclusion) setFreshConclusion(r.conclusion); setShowDoc(true); setQuiet(0); onDone("结论和讨论文档已写进任务，验收项也填好了"); }
    catch (e) { onError(String(e)); }
    finally { setDocBusy(false); }
  };
  const issue = task ? issues.find((i) => i.id === task) : undefined;
  const existingDoc = (issue?.description ?? "").split("\n\n## 讨论文档")[1] ?? "";
  const hasDoc = !!(doc || existingDoc);
  const delegate = () => { if (!task) return; onDelegate(task, `你接手 ${task}。先 \`bd show ${task} --json\` 读完整描述——里面有一份讨论文档（背景、结论、方案、步骤、风险、验收），按「步骤」和「验收」做，进展用 dispatch log，做完 dispatch done --reason。有疑问先 \`bd comments ${task}\` 看讨论原文。`); onClose(); };
  const recent = issues.filter((i) => i.labels?.includes("dispatch:discussion")).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const said = comments.filter((c) => c.text.trimStart().startsWith(TAG)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const system = comments.filter((c) => c.text.trimStart().startsWith("【系统】")).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const stored = discussionConclusion(issue?.description, comments);
  const conclusion = freshConclusion ? { text: freshConclusion, when: "刚刚", by: "" } : stored;
  // Rounds: a round is what the members said since the person last spoke (the 发起 line or a
  // line typed here). Members may skip a round (SKIP never reaches the board), so nothing is
  // counted per participant.
  let round = 0;
  const thread = said.map((c) => { const body = c.text.trimStart().slice(TAG.length).trim(); const opener = /^发起[:：]/.test(body); const mine = !opener && actorOf(c.author, me)?.kind === "human"; if (opener || mine) round += 1; return { c, body, opener, mine, round: Math.max(1, round) }; });
  const roundsSeen = Math.max(0, ...thread.map((t) => t.round));
  const spoken = thread.filter((t) => !t.opener && !t.mine && t.round === Math.max(1, roundsSeen)).length;
  const waiting = busy ? Math.max(0, parts.length - spoken) : 0;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`dialog delegate discuss-dialog${full ? " full" : ""}`} role="dialog" aria-label="讨论一个念头">
        <h3>讨论一个念头{project ? ` · ${project}` : ""}{task ? <span className="mono muted small"> · {task}</span> : null}<span className="spacer" /><button className="btn ghost sm" onClick={() => setFull(!full)} title={full ? "缩回窗口" : "占满整页"}>{full ? "⤡ 缩回" : "⤢ 放大"}</button></h3>
        {!task && <>
          <p className="muted small">把一个想法交给几个 Agent 各说一次：值不值得做、怎么做、怎么拆、风险在哪。每个 Agent 读项目现状和坑，只留一条发言就停，总结模型再写一段结论。你看完可以回一句，点「让他们回应」他们就接着讨论；方向定了就「拆分派活」，决定谁来干。</p>
          <label>念头<textarea rows={6} autoFocus placeholder="比如：把洞察报告改成每周自动发到手机；或者：要不要给 Dispatch 做 iOS 原生版。截图直接粘贴进来。" value={topic} onChange={(e) => setTopic(e.target.value)} onPaste={onPaste} disabled={busy} /></label>
          <div className="disc-images">
            {images.map((im, i) => <div key={im.path} className="disc-img"><img src={im.preview} alt={im.name} title={im.path} /><button className="x" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="移除图片">✕</button></div>)}
            <label className="disc-img-add btn sm">{saving ? "存图中…" : "＋ 图片"}<input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
            <span className="muted small">贴进来或选文件；图片存在本机，Agent 发言前会先看。</span>
          </div>
          <div className="new-session-selects">
            <label>项目<select value={project} onChange={(e) => setProject(e.target.value)} disabled={busy}><option value="">不挂项目，就一个念头</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          </div>
          <div className="disc-parts">
            <div className="muted small">参加的 Agent（同一种可以加多个，各选各的模型）</div>
            {parts.map((p, i) => <div key={i} className="disc-part">
              <select value={p.kind} disabled={busy} onChange={(e) => setParts(parts.map((x, j) => j === i ? { kind: e.target.value, model: "" } : x))}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select value={p.model} disabled={busy} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, model: e.target.value } : x))}>{(MODELS[p.kind] ?? [["", "默认"]]).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
              <button className="link sm" disabled={busy || parts.length <= 1} onClick={() => setParts(parts.filter((_, j) => j !== i))}>移除</button>
            </div>)}
            <button className="link sm" disabled={busy || parts.length >= 6} onClick={() => setParts([...parts, { kind: "claude", model: "" }])}>＋ 再加一个</button>
          </div>
          <label>想让他们决定什么（可空）<input placeholder="比如：先做手机端还是先做自动化？" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} /></label>
          {recent.length > 0 && <div className="disc-recent"><div className="muted small">最近的讨论</div>{recent.map((i) => <button key={i.id} className="disc-recent-row" onClick={() => { const m = /参加：([^。\n]+)/.exec(i.description ?? ""); if (m) { const ps = m[1].split(/[,，、]\s*/).map((x) => x.trim()).filter(Boolean).map((x) => { const [kind, model = ""] = x.split(":"); return { kind, model }; }); if (ps.length) setParts(ps); } setTask(i.id); }}><span className="t">{i.title.replace(/^【讨论】/, "")}</span><span className="muted small mono">{i.id}</span></button>)}</div>}
        </>}

        {task && (
          <div className="disc-thread">
            {conclusion && <div className="disc-conclusion"><div className="l1"><b>结论</b><span className="muted small">总结模型归纳 · {conclusion.when.includes("T") ? relTime(conclusion.when) : conclusion.when}{conclusion.by ? ` · ${conclusion.by}` : ""}</span></div><Markdown src={conclusion.text} className="compact" /></div>}
            {thread.length === 0 && <div className="empty small">{busy ? "Agent 正在起会话、读上下文……第一条发言通常一两分钟后出现" : "还没有发言"}</div>}
            {Array.from({ length: roundsSeen }, (_, i) => i + 1).map((r) => (
              <div key={r} className="disc-round">
                {roundsSeen > 1 && <div className="disc-round-h muted small">第 {r} 轮</div>}
                {thread.filter((t) => t.round === r).map(({ c, body }) => { const a = actorOf(c.author, me); return (
                  <div key={c.id} className="disc-say">
                    <Avatar actor={a} size={28} />
                    <div className="disc-bubble"><div className="l1"><b>{a?.name ?? c.author}</b><span className="muted small">{relTime(c.created_at)}</span></div><Markdown src={body.replace(/^[^：:]{1,24}[：:]\s*/, "")} className="compact" /></div>
                  </div>
                ); })}
              </div>
            ))}
            {thread.filter((t) => t.opener).map(({ c, body }) => <div key={c.id} className="disc-opener muted small">{body}</div>)}
            {system.map((c) => <div key={c.id} className="disc-system small">{c.text.trimStart().slice(4)}</div>)}
            {bubbles.map(([who, m]) => { const a = actorOf(KIND_ACTOR[m.kind] ?? m.kind, me); return (
              <div key={who} className="disc-say disc-live">
                <Avatar actor={a} size={28} />
                <div className="disc-bubble"><div className="l1"><b>{a?.name ?? who}</b><span className="muted small">{m.status === "thinking" ? "正在想" : m.status === "typing" ? "正在输入" : "写好了"}</span></div>
                  {m.text ? <Markdown src={m.text + (m.status === "typing" ? " ▍" : "")} className="compact" /> : <span className="disc-dots"><i /><i /><i /></span>}
                </div>
              </div>
            ); })}
            {skippedNow.length > 0 && <div className="disc-opener muted small">{skippedNow.join("、")} 这轮没话说</div>}
            {erroredNow.map(([who, m]) => <div key={who} className="disc-system small">{who}：{m.text || "没说上话"}</div>)}
            {busy && waiting > 0 && bubbles.length === 0 && <div className="disc-waiting muted small">{live ? `${live.members ? Object.values(live.members).filter((m) => m.status === "queued").length : waiting} 个成员排队中…` : "正在起会话……"}</div>}
            {!busy && quiet >= 2 && <div className="disc-waiting muted small">连续 {quiet} 轮没有新提议了——可以「整理成文档」收尾，或者你再说一句把话题推进一步。</div>}
          </div>
        )}
        {task && showDoc && (doc || existingDoc) && <div className="disc-doc"><div className="l1"><b>讨论文档</b><span className="muted small">已写进任务描述</span><span className="spacer" /><button className="link sm" onClick={() => setShowDoc(false)}>收起</button></div><Markdown src={doc || existingDoc.replace(/^[^\n]*\n/, "")} className="compact" /></div>}
        {task && <div className="disc-compose-wrap">
          {lineImages.length > 0 && <div className="disc-images">{lineImages.map((im, i) => <div key={im.path} className="disc-img"><img src={im.preview} alt="" /><button className="x" onClick={() => setLineImages(lineImages.filter((_, j) => j !== i))} aria-label="移除">✕</button></div>)}</div>}
          <div className="disc-compose"><textarea rows={2} placeholder="你也说一句（回车发言，Shift+回车换行；截图直接粘贴）。然后点「让他们回应」" value={line} disabled={busy} onChange={(e) => setLine(e.target.value)} onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addLineFiles(files); } }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (line.trim() || lineImages.length) void say(); } }} /><label className="btn sm disc-img-add" title="附图">🖼<input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => { void addLineFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label><button className="btn sm" disabled={busy || (!line.trim() && !lineImages.length)} onClick={() => void say()}>发言</button></div>
        </div>}

        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onClose}>{task ? "关闭" : "取消"}</button>
          {task && hasDoc && !showDoc && <button className="btn" disabled={busy || docBusy} onClick={() => setShowDoc(true)}>看文档</button>}
          {task && <button className="btn" disabled={busy || docBusy} onClick={makeDoc} title="收尾：先写（覆盖）一条结论，再把讨论整理成文档（背景、结论、方案、步骤、风险、验收）写进任务；讨论继续后可以再整理一次">{docBusy ? "整理中…" : hasDoc ? "重新整理" : "整理成文档"}</button>}
          {task && hasDoc && <button className="btn" disabled={busy || docBusy} onClick={delegate} title="选一个 Agent 和模型，读这份文档开工">派 Agent 去做 →</button>}
          {task && <button className="btn" disabled={busy} onClick={() => { onOpened(task, "split"); onClose(); }} title="或者拆成几个子任务分给不同 Agent">拆分</button>}
          {task && !busy && <span className="disc-parts-inline">{parts.map((p, i) => <span key={i} className="chip">{KINDS.find(([x]) => x === p.kind)?.[1]}{p.model ? ` · ${p.model}` : ""}</span>)}</span>}
          <button className="btn primary" disabled={busy || !parts.length || (!task && !topic.trim())} onClick={() => void go()}>{busy ? "讨论中…" : task ? "让他们回应" : `请 ${parts.length} 个 Agent 讨论`}</button>
        </div>
      </div>
    </div>
  );
}
