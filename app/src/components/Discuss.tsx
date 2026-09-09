import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import type { Api } from "../api";
import type { Comment, Issue } from "../types";
import { actorOf, isMe, relTime, discussionConclusion } from "../derive";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";
import { KINDS, KIND_ACTOR } from "./Delegate";

export const TAG = "【讨论】";
export const DISCUSSION_LABEL = "dispatch:discussion";
// Model choices per agent kind; "" = the agent's own default. Claude ids are the CLI aliases.
const MODELS: Record<string, [string, string][]> = {
  claude: [["", "默认"], ["claude-fable-5-1", "Fable 5.1（最强）"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku（快、省）"]],
  codex: [["", "默认"], ["gpt-5.5", "gpt-5.5"], ["gpt-5.6-terra", "gpt-5.6-terra"], ["gpt-6-astra", "gpt-6-astra"]],
  pi: [["", "默认"]], gemini: [["", "默认"]], opencode: [["", "默认"]],
};
export type Participant = { kind: string; model: string };
export const partArg = (p: Participant) => p.model ? `${p.kind}:${p.model}` : p.kind;
export const partName = (p: Participant) => `${KINDS.find(([x]) => x === p.kind)?.[1] ?? p.kind}${p.model ? ` · ${p.model}` : ""}`;

// Members and leader as the discussion task's description records them (「参加：…」/「领队：…」).
export function partsFromDescription(desc: string | undefined): { parts: Participant[]; leader: number } {
  const m = /参加：([^。\n]+)/.exec(desc ?? "");
  const parts: Participant[] = m ? m[1].split(/[,，、]\s*/).map((x) => x.trim()).filter(Boolean).map((x) => { const [kind, model = ""] = x.split(":"); return { kind, model }; }) : [];
  const l = /^领队[:：]\s*([a-z0-9_-]+)(?::(\S+))?/mi.exec(desc ?? "");
  const leader = l ? Math.max(0, parts.findIndex((x) => x.kind === l[1].toLowerCase() && (x.model || "") === (l[2] || ""))) : 0;
  return { parts, leader };
}
// The idea itself: the description without the 参加/领队/附图 bookkeeping and the generated blocks.
export function ideaText(desc: string | undefined): string {
  return (desc ?? "").split("\n\n## 讨论结论")[0].split("\n\n## 讨论文档")[0].split("\n\n参加：")[0].split("\n\n附图")[0].trim();
}
export const imagePaths = (text: string | undefined) => Array.from((text ?? "").matchAll(/((?:~|\/)[^\s"'`<>()[\]]+?\.(?:png|jpe?g|gif|webp|bmp))/gi)).map((m) => m[1]);

type LiveMember = { kind: string; status: string; text: string; at: number };
type Live = { round: number; started: number; at: number; finished?: number; members: Record<string, LiveMember> };
type Img = { path: string; preview: string };

// Everything one open discussion needs, shared by the dialog and the 讨论 page: the comments
// (polled while a round runs), the typing bubbles from discussions/<task>.live.json, one more
// round, the person's own line, and the wrap-up (conclusion + document).
export function useDiscussion({ api, me, issues, task, parts, leader, watch, onDone, onError }: { api: Api; me: string; issues: Issue[]; task: string; parts: Participant[]; leader: number; watch?: boolean; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [quiet, setQuiet] = useState(0);
  const [freshConclusion, setFreshConclusion] = useState("");
  const [doc, setDoc] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  // A line the person sends triggers a round by itself; sent during a round, it waits for that
  // round to end and then runs one. `saying` guards against the same line going twice (Enter repeat).
  const [saying, setSaying] = useState(false);
  const sayingRef = useRef(false);
  const queuedRef = useRef(false);
  const leaderPart = parts[Math.min(leader, parts.length - 1)] ?? parts[0];
  const withArg = parts.map(partArg).join(",");
  const leaderArgs = leaderPart ? ["--leader", partArg(leaderPart)] : [];

  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => { setComments([]); setQuiet(0); setFreshConclusion(""); setDoc(""); setLive(null); queuedRef.current = false; }, [task]);
  // The typing bubbles: queued → thinking → typing + text so far → done → posted, polled every
  // second while a round runs here; with `watch` the file is polled anyway, so a round started
  // elsewhere (the dialog, the CLI) shows up too — it counts as running until the file says finished.
  const running = busy || (!!watch && !!live && !live.finished && Date.now() / 1000 - live.at < 180);
  useEffect(() => {
    if (!task || !(busy || watch)) { if (!watch) setLive(null); return; }
    let alive = true;
    const poll = async () => { try { const t = await api.on("local", ["discuss-live", task, "--json"]); const d = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))); if (alive && d.members) setLive(d); } catch { /* next tick */ } };
    void poll();
    const h = window.setInterval(poll, busy ? 1_000 : 2_000);
    return () => { alive = false; window.clearInterval(h); };
  }, [api, task, busy, watch]);
  // Watch the task's comments while agents talk (and once more after they stop).
  useEffect(() => {
    if (!task) return;
    let alive = true;
    const tick = async () => { try { const cs = await api.comments(task); if (alive) setComments(cs); } catch { /* next tick */ } };
    void tick();
    const h = running ? window.setInterval(tick, 3_000) : 0;
    return () => { alive = false; window.clearInterval(h); };
  }, [api, task, running]);
  // Once a member's reply is posted the comment poll shows it; its bubble stays until then.
  const postedAt = (m: LiveMember) => comments.some((c) => c.text.trimStart().startsWith(TAG) && actorOf(c.author, me)?.id === KIND_ACTOR[m.kind] && Date.parse(c.created_at) / 1000 >= (live?.started ?? 0) - 1);
  const bubbles = running && live ? Object.entries(live.members).filter(([, m]) => m.status === "thinking" || m.status === "typing" || m.status === "done" || (m.status === "posted" && !postedAt(m))) : [];
  const skippedNow = running && live ? Object.entries(live.members).filter(([, m]) => m.status === "skip").map(([w]) => w) : [];
  const erroredNow = running && live ? Object.entries(live.members).filter(([, m]) => m.status === "error") : [];
  const queued = live ? Object.values(live.members).filter((m) => m.status === "queued").length : 0;

  // One more round: everyone (leader last) answers what was said since.
  const round = async (id: string, question = "") => {
    setBusy(true);
    try {
      const raw = await api.on("local", ["discuss", id, "--with", withArg, ...leaderArgs, "--rounds", "1", ...(question.trim() ? ["--question", question.trim()] : []), "--close", "--json"]);
      const r = JSON.parse(raw.slice(Math.max(0, raw.indexOf("{"))));
      setQuiet(r.quiet_rounds ?? 0);
      const skipped = (r.skipped?.length ?? 0), spoke = (r.comments ?? []).filter((c: Comment) => !/^【讨论】发起[:：]/.test(c.text.trimStart())).length;
      onDone(`这轮 ${spoke} 条发言${skipped ? `，${skipped} 人没话说` : ""}${(r.quiet_rounds ?? 0) >= 2 ? "；连续两轮没有新提议了，可以整理成文档收尾" : ""}`);
    } catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  };
  // The person is in the group too: a line lands as a 【讨论】 comment (pictures by path) and
  // the members answer it — right away, or after the round that is running.
  const say = async (line: string, images: Img[]) => {
    if (!task || (!line.trim() && !images.length) || sayingRef.current) return false;
    sayingRef.current = true; setSaying(true);
    const text = `${TAG}${me}：${line.trim()}` + (images.length ? "\n附图（用 Read 看）：\n" + images.map((x) => x.path).join("\n") : "");
    try { await api.on("local", ["log", task, text]); setComments(await api.comments(task)); }
    catch (e) { onError(String(e)); sayingRef.current = false; setSaying(false); return false; }
    sayingRef.current = false; setSaying(false);
    if (running) queuedRef.current = true; else void round(task);
    return true;
  };
  useEffect(() => { if (!running && queuedRef.current && task) { queuedRef.current = false; void round(task); } }, [running]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Wrap-up: the conclusion (one block, replaced) then the document, both written into the task.
  const makeDoc = async () => {
    if (!task) return;
    setDocBusy(true);
    try { const t = await api.on("local", ["discuss-doc", task, "--json"]); const r = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))); setDoc(r.doc); if (r.conclusion) setFreshConclusion(r.conclusion); setQuiet(0); onDone("结论和讨论文档已写进任务，验收项也填好了"); return true; }
    catch (e) { onError(String(e)); return false; }
    finally { setDocBusy(false); }
  };
  const saveImage = async (f: File, name: string): Promise<Img> => {
    const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
    const t = await api.on("local", ["save-image", "--json"], JSON.stringify({ name: f.name || name, data }));
    return { path: JSON.parse(t.slice(Math.max(0, t.indexOf("{")))).path, preview: data };
  };

  const issue = task ? issues.find((i) => i.id === task) : undefined;
  const existingDoc = (issue?.description ?? "").split("\n\n## 讨论文档")[1] ?? "";
  const docText = doc || existingDoc.replace(/^[^\n]*\n/, "");
  const stored = discussionConclusion(issue?.description, comments);
  const conclusion = freshConclusion ? { text: freshConclusion, when: "刚刚", by: "" } : stored;
  const said = comments.filter((c) => c.text.trimStart().startsWith(TAG)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const system = comments.filter((c) => c.text.trimStart().startsWith("【系统】")).sort((a, b) => a.created_at.localeCompare(b.created_at));
  // Rounds: what the members said since the person last spoke (the 发起 line or a line typed here).
  let n = 0;
  const thread = said.map((c) => { const body = c.text.trimStart().slice(TAG.length).trim(); const opener = /^发起[:：]/.test(body); const prefix = (/^([^：:\n]{1,24})[：:]/.exec(body)?.[1] ?? "").trim(); const mine = !opener && (isMe(c.author, me) || isMe(prefix, me) || actorOf(c.author, me)?.kind === "human"); if (opener || mine) n += 1; return { c, body, opener, mine, round: Math.max(1, n) }; });
  const roundsSeen = Math.max(0, ...thread.map((t) => t.round));
  const spoken = thread.filter((t) => !t.opener && !t.mine && t.round === Math.max(1, roundsSeen)).length;
  const waiting = running ? Math.max(0, parts.length - spoken) : 0;
  const isLeaderLine = (c: Comment, body: string) => { const a = actorOf(c.author, me); return !!leaderPart && a?.id === KIND_ACTOR[leaderPart.kind] && (!leaderPart.model || body.startsWith(`${leaderPart.kind}（${leaderPart.model}）`)); };
  const isLeaderLive = (who: string) => !!leaderPart && who === `${leaderPart.kind}${leaderPart.model ? `（${leaderPart.model}）` : ""}`;

  return { busy, running, saying, comments, quiet, issue, leaderPart, conclusion, docText, hasDoc: !!docText, docBusy, live, bubbles, skippedNow, erroredNow, queued, thread, roundsSeen, waiting, system, round, say, makeDoc, saveImage, isLeaderLine, isLeaderLive };
}
export type Discussion = ReturnType<typeof useDiscussion>;

// The group chat: rounds of statements, the typing bubbles, system lines, the hints — and the
// box where the person says a line. Used in the dialog and on the 讨论 page.
export function DiscussThread({ d, me, showConclusion, compact }: { d: Discussion; me: string; showConclusion?: boolean; compact?: boolean }) {
  const { running, conclusion, thread, roundsSeen, bubbles, skippedNow, erroredNow, system, waiting, live, queued, quiet, comments } = d;
  const threadRef = useRef<HTMLDivElement>(null);
  const growth = comments.length * 100000 + bubbles.length * 10000 + bubbles.map(([, m]) => m.text.length).reduce((a, b) => a + b, 0);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [growth]);
  return (
    <div className={`disc-thread${compact ? " compact" : ""}`} ref={threadRef}>
      {showConclusion && conclusion && <div className="disc-conclusion"><div className="l1"><b>结论</b><span className="muted small">{conclusion.when.includes("T") ? relTime(conclusion.when) : conclusion.when}{conclusion.by ? ` · ${conclusion.by}` : ""}</span></div><Markdown src={conclusion.text} className="compact" /></div>}
      {thread.filter((t) => t.opener).slice(0, 1).map(({ c, body }) => <div key={c.id} className="disc-opener muted small">{body}</div>)}
      {thread.length === 0 && <div className="empty small">{running ? "Agent 正在读上下文……第一条发言通常十几秒后出现" : "还没有发言"}</div>}
      {Array.from({ length: roundsSeen }, (_, i) => i + 1).map((r) => (
        <div key={r} className="disc-round">
          {roundsSeen > 1 && <div className="disc-round-h muted small">第 {r} 轮</div>}
          {thread.filter((t) => t.round === r && !t.opener).map(({ c, body, mine }) => { const a = mine ? actorOf(me, me) : actorOf(c.author, me); return (
            <div key={c.id} className={`disc-say${mine ? " mine" : ""}`}>
              <Avatar actor={a} size={28} />
              <div className="disc-bubble"><div className="l1"><b>{mine ? "你" : a?.name ?? c.author}</b>{!mine && d.isLeaderLine(c, body) && <span className="chip disc-leader-tag">领队</span>}<span className="muted small">{relTime(c.created_at)}</span></div><Markdown src={body.replace(/^[^：:\n]{1,24}[：:]\s*/, "")} className="compact" /></div>
            </div>
          ); })}
        </div>
      ))}
      {bubbles.map(([who, m]) => { const a = actorOf(KIND_ACTOR[m.kind] ?? m.kind, me); return (
        <div key={who} className="disc-say disc-live">
          <Avatar actor={a} size={28} />
          <div className="disc-bubble"><div className="l1"><b>{a?.name ?? who}</b>{d.isLeaderLive(who) && <span className="chip disc-leader-tag">领队</span>}<span className="muted small">{m.status === "thinking" ? "正在想" : m.status === "typing" ? "正在输入" : "写好了"}</span></div>
            {m.text ? <Markdown src={m.text + (m.status === "typing" ? " ▍" : "")} className="compact" /> : <span className="disc-dots"><i /><i /><i /></span>}
          </div>
        </div>
      ); })}
      {skippedNow.length > 0 && <div className="disc-opener muted small">{skippedNow.join("、")} 这轮没话说</div>}
      {erroredNow.map(([who, m]) => <div key={who} className="disc-system small">{who}：{m.text || "没说上话"}</div>)}
      {system.map((c) => <div key={c.id} className="disc-system small">{c.text.trimStart().slice(4)}</div>)}
      {running && waiting > 0 && bubbles.length === 0 && <div className="disc-waiting muted small">{live ? `${queued} 个成员排队中…` : "正在起会话……"}</div>}
      {!running && quiet >= 2 && <div className="disc-waiting muted small">连续 {quiet} 轮没有新提议了——可以「整理成文档」收尾，或者你再说一句把话题推进一步。</div>}
    </div>
  );
}

// The person's line, with pictures pasted or picked; Enter sends, Shift+Enter breaks the line.
export function DiscussCompose({ d, onError }: { d: Discussion; onError: (m: string) => void }) {
  const [line, setLine] = useState("");
  const [images, setImages] = useState<Img[]>([]);
  const add = async (files: File[]) => { for (const f of files.filter((x) => x.type.startsWith("image/"))) { try { const im = await d.saveImage(f, "reply"); setImages((xs) => [...xs, im]); } catch (e) { onError(String(e)); } } };
  const send = async () => { if (d.saying) return; if (await d.say(line, images)) { setLine(""); setImages([]); } };
  return (
    <div className="disc-compose-wrap">
      {images.length > 0 && <div className="disc-images">{images.map((im, i) => <div key={im.path} className="disc-img"><img src={im.preview} alt="" /><button className="x" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="移除">✕</button></div>)}</div>}
      <div className="disc-compose"><textarea rows={2} placeholder={d.running ? "你也说一句（回车发言）；他们正在说，你的话会在这轮结束后得到回应" : "你也说一句（回车发言，Shift+回车换行；截图直接粘贴），他们会接着回应"} value={line} disabled={d.saying} onChange={(e) => setLine(e.target.value)} onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void add(files); } }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!e.repeat && !d.saying && (line.trim() || images.length)) void send(); } }} /><label className="btn sm disc-img-add" title="附图">🖼<input type="file" accept="image/*" multiple hidden disabled={d.saying} onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label><button className="btn sm" disabled={d.saying || (!line.trim() && !images.length)} onClick={() => void send()}>{d.saying ? "发送中…" : "发言"}</button></div>
    </div>
  );
}

export const delegatePrompt = (task: string) => `你接手 ${task}。先 \`bd show ${task} --json\` 读完整描述——里面有一份讨论文档（背景、结论、方案、步骤、风险、验收），按「步骤」和「验收」做，进展用 dispatch log，做完 dispatch done --reason。有疑问先 \`bd comments ${task}\` 看讨论原文。`;

interface Props { api: Api; projects: string[]; issues: Issue[]; me: string; initialProject?: string; initialTask?: string; onClose: () => void; onOpened: (taskId: string, intent?: "split") => void; onDelegate: (taskId: string, prompt: string, leader?: { kind: string; model: string }) => void; onAll?: (taskId?: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

// 讨论一个念头: a thought — with or without a project — put to several agents at once. Each
// reads the context and leaves one 【讨论】 comment; the leader (or the summary model) writes the
// conclusion on demand. It all lives on a 【讨论】 task, so it can be split into work.
export function DiscussDialog({ api, projects, issues, me, initialProject, initialTask, onClose, onOpened, onDelegate, onAll, onDone, onError }: Props) {
  const [topic, setTopic] = useState("");
  const [project, setProject] = useState(initialProject ?? "");
  const [parts, setParts] = useState<Participant[]>([{ kind: "claude", model: "" }, { kind: "codex", model: "" }]);
  // The leader: one member (index into parts). Speaks last each round; conclusion and document
  // come from its model; 派 Agent 去做 preselects it. Recorded on the task as 「领队：kind:model」.
  const [leader, setLeader] = useState(0);
  const [task, setTask] = useState<string>(initialTask ?? "");
  const restoreFrom = (desc: string) => { const r = partsFromDescription(desc); if (r.parts.length) { setParts(r.parts); setLeader(r.leader); } };
  useEffect(() => { if (initialTask) { const desc = issues.find((i) => i.id === initialTask)?.description; if (desc) restoreFrom(desc); } }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [question, setQuestion] = useState("");
  const [images, setImages] = useState<{ path: string; preview: string; name: string }[]>([]);
  const [saving, setSaving] = useState(0);
  const [creating, setCreating] = useState(false);
  const [full, setFull] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const d = useDiscussion({ api, me, issues, task, parts, leader, onDone, onError });
  const busy = d.busy || creating;
  const addFiles = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/"))) {
      setSaving((n) => n + 1);
      try { const im = await d.saveImage(f, "pasted"); setImages((xs) => [...xs, { ...im, name: f.name || "粘贴的图片" }]); }
      catch (e) { onError(String(e)); }
      finally { setSaving((n) => n - 1); }
    }
  };
  const onPaste = (e: ReactClipboardEvent) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } };
  const leaderPart = parts[Math.min(leader, parts.length - 1)] ?? parts[0];

  const go = async () => {
    if (!parts.length || (!task && !topic.trim())) return;
    let id = task;
    if (!id) {
      setCreating(true);
      try {
        const made = JSON.parse((await api.on("local", ["discuss", "--topic", topic.trim(), ...(project ? ["--project", project] : []), "--with", parts.map(partArg).join(","), ...images.flatMap((im) => ["--image", im.path]), ...(leaderPart ? ["--leader", partArg(leaderPart)] : []), "--create-only", "--json"])).replace(/^[^{]*/, ""));
        id = made.task; setTask(id);
      } catch (e) { onError(String(e)); setCreating(false); return; }
      setCreating(false);
    }
    await d.round(id, question);
  };
  const makeDoc = async () => { if (await d.makeDoc()) setShowDoc(true); };
  const delegate = () => { if (!task) return; onDelegate(task, delegatePrompt(task), leaderPart ? { kind: leaderPart.kind, model: leaderPart.model } : undefined); onClose(); };
  const recent = issues.filter((i) => i.labels?.includes(DISCUSSION_LABEL)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`dialog delegate discuss-dialog${full ? " full" : ""}`} role="dialog" aria-label="讨论一个念头">
        <h3>讨论一个念头{project ? ` · ${project}` : ""}{task ? <span className="mono muted small"> · {task}</span> : null}<span className="spacer" />{onAll && <button className="btn ghost sm" onClick={() => { onAll(task || undefined); onClose(); }} title="到「讨论」页看全部讨论">看全部 ›</button>}<button className="btn ghost sm" onClick={() => setFull(!full)} title={full ? "缩回窗口" : "占满整页"}>{full ? "⤡ 缩回" : "⤢ 放大"}</button></h3>
        {!task && <>
          <p className="muted small">把一个想法交给几个 Agent 各说一次：值不值得做、怎么做、怎么拆、风险在哪。每个 Agent 读项目现状和坑，只留一条发言就停。你看完可以回一句，点「让他们回应」他们就接着讨论；方向定了就「整理成文档」，再派人或拆分。</p>
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
            <div className="muted small">参加的 Agent（同一种可以加多个，各选各的模型）；选一个当领队：它每轮最后发言并归纳，结论和文档由它写，派活默认给它</div>
            {parts.map((p, i) => <div key={i} className="disc-part">
              <label className="disc-leader" title="领队"><input type="radio" name="disc-leader" checked={Math.min(leader, parts.length - 1) === i} disabled={busy} onChange={() => setLeader(i)} /> 领队</label>
              <select value={p.kind} disabled={busy} onChange={(e) => setParts(parts.map((x, j) => j === i ? { kind: e.target.value, model: "" } : x))}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select value={p.model} disabled={busy} onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, model: e.target.value } : x))}>{(MODELS[p.kind] ?? [["", "默认"]]).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
              <button className="link sm" disabled={busy || parts.length <= 1} onClick={() => { setParts(parts.filter((_, j) => j !== i)); if (leader === i) setLeader(0); else if (leader > i) setLeader(leader - 1); }}>移除</button>
            </div>)}
            <button className="link sm" disabled={busy || parts.length >= 6} onClick={() => setParts([...parts, { kind: "claude", model: "" }])}>＋ 再加一个</button>
          </div>
          <label>想让他们决定什么（可空）<input placeholder="比如：先做手机端还是先做自动化？" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} /></label>
          {recent.length > 0 && <div className="disc-recent"><div className="muted small">最近的讨论{onAll && <> · <button className="link sm" onClick={() => { onAll(); onClose(); }}>看全部</button></>}</div>{recent.map((i) => <button key={i.id} className="disc-recent-row" onClick={() => { restoreFrom(i.description ?? ""); setTask(i.id); }}><span className="t">{i.title.replace(/^【讨论】/, "")}</span><span className="muted small mono">{i.id}</span></button>)}</div>}
        </>}

        {task && <DiscussThread d={d} me={me} showConclusion />}
        {task && showDoc && d.hasDoc && <div className="disc-doc"><div className="l1"><b>讨论文档</b><span className="muted small">已写进任务描述</span><span className="spacer" /><button className="link sm" onClick={() => setShowDoc(false)}>收起</button></div><Markdown src={d.docText} className="compact" /></div>}
        {task && <DiscussCompose d={d} onError={onError} />}

        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onClose}>{task ? "关闭" : "取消"}</button>
          {task && d.hasDoc && !showDoc && <button className="btn" disabled={busy || d.docBusy} onClick={() => setShowDoc(true)}>看文档</button>}
          {task && <button className="btn" disabled={busy || d.docBusy} onClick={() => void makeDoc()} title="收尾：先写（覆盖）一条结论，再把讨论整理成文档（背景、结论、方案、步骤、风险、验收）写进任务；讨论继续后可以再整理一次">{d.docBusy ? "整理中…" : d.hasDoc ? "重新整理" : "整理成文档"}</button>}
          {task && d.hasDoc && <button className="btn" disabled={busy || d.docBusy} onClick={delegate} title="选一个 Agent 和模型，读这份文档开工">派 Agent 去做 →</button>}
          {task && <button className="btn" disabled={busy} onClick={() => { onOpened(task, "split"); onClose(); }} title="或者拆成几个子任务分给不同 Agent">拆分</button>}
          {task && !busy && <span className="disc-parts-inline">{parts.map((p, i) => <span key={i} className={`chip${Math.min(leader, parts.length - 1) === i ? " disc-leader-tag" : ""}`}>{partName(p)}{Math.min(leader, parts.length - 1) === i ? " · 领队" : ""}</span>)}</span>}
          <button className="btn primary" disabled={busy || !parts.length || (!task && !topic.trim())} onClick={() => void go()}>{busy ? "讨论中…" : task ? "让他们回应" : `请 ${parts.length} 个 Agent 讨论`}</button>
        </div>
      </div>
    </div>
  );
}
