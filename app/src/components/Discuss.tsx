import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import type { Api } from "../api";
import type { Comment, Issue } from "../types";
import { actorOf, relTime } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KINDS } from "./Delegate";

const TAG = "【讨论】", CONCLUSION = "【结论】";
// Model choices per agent kind; "" = the agent's own default. Claude ids are the CLI aliases.
const MODELS: Record<string, [string, string][]> = {
  claude: [["", "默认"], ["claude-fable-5-1", "Fable 5.1（最强）"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku（快、省）"]],
  codex: [["", "默认"], ["gpt-5.5", "gpt-5.5"], ["gpt-5.6-terra", "gpt-5.6-terra"], ["gpt-6-astra", "gpt-6-astra"]],
  pi: [["", "默认"]], gemini: [["", "默认"]], opencode: [["", "默认"]],
};
type Participant = { kind: string; model: string };

interface Props { api: Api; projects: string[]; issues: Issue[]; me: string; initialProject?: string; initialTask?: string; onClose: () => void; onOpened: (taskId: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

// 讨论一个念头: a thought — with or without a project — put to several agents at once. Each
// reads the context (project summary, open tasks, pits) and leaves one 【讨论】 comment; the
// summary model writes a 【结论】. It all lives on a 【讨论】 task, so it can be split into work.
// The thread is drawn live: each statement appears as it lands, the conclusion on top.
export function DiscussDialog({ api, projects, issues, me, initialProject, initialTask, onClose, onOpened, onDone, onError }: Props) {
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
  const [rounds, setRounds] = useState(1);
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<string>(initialTask ?? "");
  const [comments, setComments] = useState<Comment[]>([]);
  const [finished, setFinished] = useState<{ conclusion: string } | null>(null);
  const timer = useRef<number>(0);

  // Watch the task's comments while agents talk (and once more after they stop).
  useEffect(() => {
    if (!task) return;
    let alive = true;
    const tick = async () => { try { const cs = await api.comments(task); if (alive) setComments(cs); } catch { /* next tick */ } };
    void tick();
    if (busy) timer.current = window.setInterval(tick, 5_000);
    return () => { alive = false; window.clearInterval(timer.current); };
  }, [api, task, busy]);

  const go = async () => {
    if (!parts.length || (!task && !topic.trim())) return;
    setBusy(true); setFinished(null);
    try {
      let id = task;
      if (!id) {
        const made = JSON.parse((await api.on("local", ["discuss", "--topic", topic.trim(), ...(project ? ["--project", project] : []), "--with", withArg, ...images.flatMap((im) => ["--image", im.path]), "--create-only", "--json"])).replace(/^[^{]*/, ""));
        id = made.task; setTask(id);
      }
      const raw = await api.on("local", ["discuss", id, "--with", withArg, "--rounds", String(rounds), ...(question.trim() ? ["--question", question.trim()] : []), "--close", "--json"]);
      const r = JSON.parse(raw.slice(Math.max(0, raw.indexOf("{"))));
      setFinished({ conclusion: r.conclusion || "" });
      onDone(`讨论结束：${Math.max(0, (r.comments?.length ?? 1) - 1)} 条发言${r.conclusion ? "，结论已写好" : ""}`);
    } catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  };

  // The person is in the group too: a line typed here lands as a 【讨论】 comment, and「让他们回应」runs one more round.
  const [line, setLine] = useState("");
  const say = async () => {
    if (!task || !line.trim()) return;
    try { await api.on("local", ["log", task, `${TAG}${me}：${line.trim()}`]); setLine(""); const cs = await api.comments(task); setComments(cs); }
    catch (e) { onError(String(e)); }
  };
  const recent = issues.filter((i) => i.labels?.includes("dispatch:discussion")).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const said = comments.filter((c) => c.text.trimStart().startsWith(TAG)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const conclusion = comments.filter((c) => c.text.trimStart().startsWith(CONCLUSION)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  // Round markers: the 发起 line opens a round; each agent's first statement after it is round 1, its next is round 2…
  // Two Claudes with different models share an author name, so rounds are counted by position
  // within this run (statements arrive in order, one per participant per round); for a thread
  // reopened later the participant count is unknown and the per-author count is the fallback.
  const seen = new Map<string, number>();
  let nth = 0;
  const thread = said.map((c) => { const body = c.text.trimStart().slice(TAG.length).trim(); const opener = /^发起[:：]/.test(body); let n = 0; if (!opener) { n = task && busy ? Math.floor(nth++ / Math.max(1, parts.length)) + 1 : (seen.get(c.author) ?? 0) + 1; seen.set(c.author, n); } return { c, body, opener, round: n }; });
  const roundsSeen = Math.max(0, ...thread.map((t) => t.round));
  const spoken = thread.filter((t) => !t.opener && t.round === Math.max(1, roundsSeen)).length;
  const waiting = busy ? Math.max(0, parts.length - spoken) : 0;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog delegate discuss-dialog" role="dialog" aria-label="讨论一个念头">
        <h3>讨论一个念头{project ? ` · ${project}` : ""}{task ? <span className="mono muted small"> · {task}</span> : null}</h3>
        {!task && <>
          <p className="muted small">把一个想法交给几个 Agent 各说一次：值不值得做、怎么做、怎么拆、风险在哪。每个 Agent 在这台电脑的 Herdr 里起一个会话，读项目现状和坑，只留一条发言就停；最后由总结模型写一段结论。结果记在一条「【讨论】」任务上，觉得该做就从那里拆成子任务派出去。</p>
          <label>念头<textarea rows={6} autoFocus placeholder="比如：把洞察报告改成每周自动发到手机；或者：要不要给 Dispatch 做 iOS 原生版。截图直接粘贴进来。" value={topic} onChange={(e) => setTopic(e.target.value)} onPaste={onPaste} disabled={busy} /></label>
          <div className="disc-images">
            {images.map((im, i) => <div key={im.path} className="disc-img"><img src={im.preview} alt={im.name} title={im.path} /><button className="x" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="移除图片">✕</button></div>)}
            <label className="disc-img-add btn sm">{saving ? "存图中…" : "＋ 图片"}<input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
            <span className="muted small">贴进来或选文件；图片存在本机，Agent 发言前会先看。</span>
          </div>
          <div className="new-session-selects">
            <label>项目<select value={project} onChange={(e) => setProject(e.target.value)} disabled={busy}><option value="">不挂项目，就一个念头</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            <label>轮数<select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} disabled={busy}><option value={1}>1 轮（各说一次）</option><option value={2}>2 轮（再互相回应一次）</option></select></label>
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
            {conclusion && <div className="disc-conclusion"><div className="l1"><b>结论</b><span className="muted small">总结模型归纳 · {relTime(conclusion.created_at)}</span></div><Markdown src={conclusion.text.trimStart().slice(CONCLUSION.length).trim()} className="compact" /></div>}
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
            {busy && waiting > 0 && <div className="disc-waiting muted small">还有 {waiting} 个 Agent 在想……（{parts.map((p) => KINDS.find(([x]) => x === p.kind)?.[1] + (p.model ? ` ${p.model}` : "")).join("、")}）</div>}
            {busy && waiting === 0 && !finished && <div className="disc-waiting muted small">发言都到了，总结模型在写结论……</div>}
          </div>
        )}
        {task && <div className="disc-compose"><input placeholder="你也说一句（会作为发言记进去；然后点「让他们回应」再来一轮）" value={line} disabled={busy} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && line.trim()) void say(); }} /><button className="btn sm" disabled={busy || !line.trim()} onClick={() => void say()}>发言</button></div>}

        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onClose}>{task ? "关闭" : "取消"}</button>
          {task && <button className="btn" onClick={() => { onOpened(task); onClose(); }}>打开任务页 · 拆分派活</button>}
          {task && !busy && <span className="disc-parts-inline">{parts.map((p, i) => <span key={i} className="chip">{KINDS.find(([x]) => x === p.kind)?.[1]}{p.model ? ` · ${p.model}` : ""}</span>)}</span>}
          <button className="btn primary" disabled={busy || !parts.length || (!task && !topic.trim())} onClick={() => { if (task) { setRounds(1); setFinished(null); } void go(); }}>{busy ? "讨论中…" : task ? "让他们回应一轮" : `请 ${parts.length} 个 Agent 讨论`}</button>
        </div>
      </div>
    </div>
  );
}
