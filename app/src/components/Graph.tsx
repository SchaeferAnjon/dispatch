import { useEffect, useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { Api } from "../api";
import { actorOf, ago, projectColor } from "../derive";
import { useT } from "../i18n";

interface Props { api: Api; me: string; version: number; selected: string | null; onSelect: (id: string) => void; onOpenSession: (sessionId: string) => void; projects: { name: string; count: number }[] }

// Edge kinds: `origin` = the session the task was created in (the main line, thick), `flow` =
// task → session that claimed it / session → its steps, `thin` = a session's other tasks
// (「继续 task-x」 in a conversation that started elsewhere); the rest are board dependencies.
const EDGE_LABEL: Record<string, string> = { origin: "发起会话", thin: "顺带做", "discovered-from": "派生出", blocks: "解锁", "parent-child": "包含", "discussed-in": "拆分自", related: "相关", relates_to: "相关" };

type LinDep = { type: string; label: string; id: string };
type LinSession = { session_id: string; agent: string; title?: string; summary?: string; state?: string; live?: boolean; relation?: string; verdict?: string; reason?: string; also?: string[]; also_count?: number; last_at?: number };
type LinEvent = { ts: number; kind: string; ref: string; text: string; sentence?: string; by?: string };
type LinTask = { id: string; title: string; status: string; assignee: string; acceptance_done: number; acceptance_total: number; last_at: number; deps: LinDep[]; mentions_count: number; sessions: LinSession[]; events: LinEvent[] };
type LinData = { project: string; days: number; cwd: string; counts: { tasks: number; live_sessions: number; unassigned_sessions: number }; tasks: LinTask[]; unassigned_sessions: LinSession[]; unassigned_events: LinEvent[] };
const LIN_STATUS: Record<string, { text: string; cls: string }> = { in_progress: { text: "进行中", cls: "prog" }, open: { text: "待办", cls: "open" }, blocked: { text: "阻塞", cls: "block" }, deferred: { text: "搁置", cls: "open" }, closed: { text: "已完成", cls: "done" } };
const LIN_STATE: Record<string, string> = { working: "在跑", idle: "等你", ended: "已结束" };
const LIN_KIND: Record<string, string> = { task: "进展", done: "完成", commit: "提交" };
const short = (s: string, n = 8) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
// A session that did the task, as opposed to one whose transcript merely mentioned its id.
const isDoer = (s: LinSession) => s.relation === "发起" || s.relation === "在做";
const sessionLabel = (s: LinSession) => s.title || short(s.session_id);
const eventDate = (ts: number) => { const d = new Date(ts * 1000); const p = (x: number) => String(x).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Unique graph ids: task/session ids and event refs can collide, so namespace them.
const TID = (x: string) => `t:${x}`;
const SID = (x: string) => `s:${x}`;
const EID = (taskId: string, i: number) => `e:${taskId}:${i}`;

type GKind = "task" | "session" | "step";
interface GNode { id: string; kind: GKind; label: string; status: string; w: number; h: number; lines: number; task?: LinTask; sess?: LinSession; ev?: LinEvent; taskId?: string; idx?: number }
interface GEdge { from: string; to: string; type: string }
// Nodes show names whole — the board title, the session title, the first sentence of a note —
// so their height follows the text: width is fixed per kind, lines are estimated from the
// glyph widths (CJK ≈ 1em, Latin ≈ 0.56em) and capped; anything past the cap is clamped by CSS
// and readable in the panel.
const NODE_SPEC: Record<GKind, { w: number; font: number; lineH: number; pad: number; inner: number; maxLines: number }> = {
  task: { w: 300, font: 12, lineH: 15, pad: 32, inner: 274, maxLines: 3 },
  session: { w: 240, font: 12, lineH: 15, pad: 30, inner: 214, maxLines: 2 },
  step: { w: 240, font: 11, lineH: 14, pad: 14, inner: 176, maxLines: 3 },
};
const textWidth = (s: string, px: number) => { let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? px : px * 0.56; return w; };
export function nodeSize(kind: GKind, label: string): { w: number; h: number; lines: number } {
  const sp = NODE_SPEC[kind];
  const lines = Math.max(1, Math.min(sp.maxLines, Math.ceil(textWidth(label, sp.font) / sp.inner)));
  return { w: sp.w, h: sp.pad + lines * sp.lineH, lines };
}

function LinSessionRow({ s, me, showRelation }: { s: LinSession; me: string; showRelation?: boolean }) {
  const t = useT();
  const a = actorOf(s.agent, me);
  return <div className="lin-session">
    <div className="lin-session-head">
      <span className={`av ${a?.kind || "human"} lin-av`} style={{ width: 18, height: 18, fontSize: 8 }}>{a?.glyph || s.agent.slice(0, 1).toUpperCase()}</span>
      <span className="lin-session-agent">{a?.name || s.agent}</span>
      <span className="lin-session-title" title={s.title || s.session_id}>{sessionLabel(s)}</span>
      {s.state && <span className={`lin-state${s.live ? " live" : ""}`}>{t(LIN_STATE[s.state] || s.state)}</span>}
      {showRelation && s.relation ? <span className="muted small lin-relation">{t(s.relation)}</span> : null}
      {s.verdict ? <span className={`review-verdict${s.verdict === "别关" ? " hold" : ""}`}>{t(s.verdict)}</span> : null}
    </div>
    {isDoer(s) && s.summary && <p className="review-summary small">{s.summary}</p>}
    {isDoer(s) && s.reason && <p className="review-note muted small">{s.reason}</p>}
    {isDoer(s) && !!s.also_count && <p className="muted small lin-also">{t("还涉及 {n} 个任务", { n: s.also_count })}{Array.isArray(s.also) && s.also.length ? `${t("：")}${s.also.slice(0, 3).join(t("、"))}${s.also.length < s.also_count ? "…" : ""}` : ""}</p>}
  </div>;
}

function LinTaskCard({ task, me, onSelect }: { task: LinTask; me: string; onSelect: (id: string) => void }) {
  const t = useT();
  const st = LIN_STATUS[task.status] || { text: task.status, cls: "open" };
  const total = task.acceptance_total || 0;
  const done = task.acceptance_done || 0;
  return <article className="lin-task">
    <div className="lin-task-head">
      <button className="link lin-task-title" title={t("打开这个任务")} onClick={() => onSelect(task.id)}>{task.title}</button>
      <span className={`st sm ${st.cls}`}>{t(st.text)}</span>
      <code className="muted small mono">{task.id}</code>
    </div>
    <div className="lin-task-meta">
      {total > 0 && <span className="lin-prog"><span className="bar"><i style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></span><span className="mono small muted">{done}/{total}</span></span>}
      {task.assignee && <span className="muted small">{actorOf(task.assignee, me)?.name || task.assignee}</span>}
      {task.last_at ? <span className="muted small">{t("最后进展 {ago}", { ago: ago(task.last_at) })}</span> : null}
      {task.mentions_count > 0 && <span className="muted small">{t("提到 {n} 次", { n: task.mentions_count })}</span>}
      {task.deps.length > 0 && task.deps.map((d, i) => <span className="lin-dep chip" key={`${d.id}-${i}`} title={d.id}>{t(d.label)}{d.id ? ` · ${short(d.id, 10)}` : ""}</span>)}
    </div>
    {task.sessions.length > 0 && <div className="lin-sessions">{task.sessions.map((s) => <LinSessionRow key={s.session_id} s={s} me={me} showRelation />)}</div>}
    {task.events.length > 0 && <div className="lin-events">{task.events.map((e, i) => <div className="lin-event" key={`${e.ts}-${i}`}>
      <span className={`review-kind k-${e.kind}`}>{t(LIN_KIND[e.kind] || e.kind)}</span>
      <span className="review-date mono">{eventDate(e.ts)}</span>
      {e.kind === "commit" && e.ref ? <code className="review-ref mono">{String(e.ref).slice(0, 7)}</code> : null}
      <span className="review-text clamp-2" title={e.text}>{e.text}</span>
    </div>)}</div>}
  </article>;
}

function NodePanel({ n, me, onSelect, onOpenSession, onClose }: { n: GNode; me: string; onSelect: (id: string) => void; onOpenSession: (sessionId: string) => void; onClose: () => void }) {
  const tx = useT();
  if (n.kind === "task") {
    const t = n.task!;
    const st = LIN_STATUS[t.status] || { text: t.status, cls: "open" };
    const a = actorOf(t.assignee, me);
    const total = t.acceptance_total || 0, done = t.acceptance_done || 0;
    return <aside className="node-panel">
      <div className="np-head"><span className="np-kind">{tx("任务")}</span><button className="np-close" onClick={onClose} aria-label={tx("关闭")}>×</button></div>
      <h3 className="np-title">{t.title}</h3>
      <div className="np-meta">
        <span className={`st sm ${st.cls}`}>{tx(st.text)}</span>
        {a && <span className="muted small">{a.name}</span>}
        {total > 0 && <span className="lin-prog"><span className="bar"><i style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></span><span className="mono small muted">{done}/{total}</span></span>}
        {t.last_at ? <span className="muted small">{tx("最后进展 {ago}", { ago: ago(t.last_at) })}</span> : null}
      </div>
      <button className="btn sm primary np-open" onClick={() => onSelect(t.id)}>{tx("打开任务")}</button>
    </aside>;
  }
  if (n.kind === "session") {
    const s = n.sess!;
    const a = actorOf(s.agent, me);
    const state = s.state || "ended";
    return <aside className="node-panel">
      <div className="np-head"><span className="np-kind">{tx("会话")}</span><button className="np-close" onClick={onClose} aria-label={tx("关闭")}>×</button></div>
      <h3 className="np-title">{sessionLabel(s)}</h3>
      <div className="np-meta">
        {a && <span className={`av ${a.kind}`} style={{ width: 18, height: 18, fontSize: 8 }}>{a.glyph}</span>}
        {a && <span className="muted small">{a.name}</span>}
        <span className={`lin-state${s.live ? " live" : ""}`}>{tx(LIN_STATE[state] || state)}</span>
        {s.verdict ? <span className={`review-verdict${s.verdict === "别关" ? " hold" : ""}`}>{tx(s.verdict)}</span> : null}
      </div>
      {s.summary && <p className="review-summary small">{s.summary}</p>}
      {s.reason && <p className="review-note muted small">{s.reason}</p>}
      {!!s.also_count && <p className="muted small lin-also">{tx("还涉及 {n} 个任务", { n: s.also_count })}{Array.isArray(s.also) && s.also.length ? `${tx("：")}${s.also.slice(0, 3).join(tx("、"))}${s.also.length < s.also_count ? "…" : ""}` : ""}</p>}
      <button className="btn sm primary np-open" onClick={() => onOpenSession(s.session_id)}>{tx("打开会话")}</button>
    </aside>;
  }
  const e = n.ev!;
  return <aside className="node-panel">
    <div className="np-head"><span className="np-kind">{tx("进展")}</span><button className="np-close" onClick={onClose} aria-label={tx("关闭")}>×</button></div>
    <div className="np-meta">
      <span className={`review-kind k-${e.kind}`}>{tx(LIN_KIND[e.kind] || e.kind)}</span>
      <span className="review-date mono">{eventDate(e.ts)}</span>
      {e.kind === "commit" && e.ref ? <code className="review-ref mono">{String(e.ref).slice(0, 7)}</code> : null}
    </div>
    <p className="review-text np-text">{e.text}</p>
    {e.by && <span className="muted small">{tx("记录者 {who}", { who: actorOf(e.by, me)?.name || e.by })}</span>}
    {n.taskId && <button className="btn sm primary np-open" onClick={() => onSelect(n.taskId!)}>{tx("打开任务")}</button>}
  </aside>;
}

export function GraphView({ api, me, version, selected, onSelect, onOpenSession, projects }: Props) {
  const t = useT();
  const [picked, setPicked] = useState("");
  const [data, setData] = useState<LinData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"graph" | "list">("graph");
  const [onlyProg, setOnlyProg] = useState(true);
  const [onlyLive, setOnlyLive] = useState(false);
  const [onlyWait, setOnlyWait] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const active = picked || projects[0]?.name || "";
  const pick = (name: string) => { if (name !== active) { setData(null); setSel(null); } setPicked(name); };

  useEffect(() => {
    if (!active) { setData(null); return; }
    let alive = true;
    setBusy(true); setErr("");
    api.on("local", ["lineage", active, "--json"]).then((t) => {
      if (!alive) return;
      const d = JSON.parse(t.slice(Math.max(0, t.indexOf("{")))) as LinData & { error?: string };
      if (d.error) setErr(d.error); else setData(d);
    }).catch((e) => { if (alive) setErr(String(e)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [api, active, version]);

  // Keep the external task selection reflected in the graph; park it on its node.
  useEffect(() => { setSel(selected ? TID(selected) : null); }, [selected]);

  // Unfinished tasks always belong on the page; finished ones only while they are recent.
  const visibleTasks = useMemo(() => {
    const since = Date.now() / 1000 - (data?.days ?? 14) * 86400;
    return (data?.tasks || []).filter((t) =>
      (t.status !== "closed" || !t.last_at || t.last_at >= since) &&
      (!onlyProg || t.status === "in_progress") &&
      (!onlyLive || t.sessions.some((s) => s.live)) &&
      (!onlyWait || t.sessions.some((s) => s.live && (s.verdict === "别关" || s.state === "idle"))));
  }, [data, onlyProg, onlyLive, onlyWait]);

  // Build the node+edge model: task cards → the sessions that did them → every event as its
  // own step, chained left-to-right oldest→newest, plus task→task dependency edges. A session
  // that spans several tasks is one node: a thick `origin` edge from the task it was started
  // for, thin edges from the others.
  const model = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const seenNode = new Set<string>();
    const seenEdge = new Set<string>();
    const addNode = (n: Omit<GNode, "w" | "h" | "lines">) => { if (!seenNode.has(n.id)) { seenNode.add(n.id); nodes.push({ ...n, ...nodeSize(n.kind, n.label) }); } };
    const addEdge = (from: string, to: string, type: string) => { const k = `${from}|${to}|${type}`; if (!seenEdge.has(k)) { seenEdge.add(k); edges.push({ from, to, type }); } };
    const taskIds = new Set(visibleTasks.map((t) => t.id));

    for (const t of visibleTasks) addNode({ id: TID(t.id), kind: "task", label: t.title, status: t.status, task: t });

    for (const t of visibleTasks) {
      const doers = t.sessions.filter(isDoer);
      const main = doers.find((s) => s.relation === "发起") ?? doers[0];
      for (const s of doers) {
        addNode({ id: SID(s.session_id), kind: "session", label: sessionLabel(s), status: s.state || "ended", sess: s, taskId: t.id });
        // A session with an origin task elsewhere is only passing through this one.
        const passing = s.relation !== "发起" && visibleTasks.some((o) => o.id !== t.id && o.sessions.some((x) => x.session_id === s.session_id && x.relation === "发起"));
        addEdge(TID(t.id), SID(s.session_id), s.relation === "发起" ? "origin" : passing ? "thin" : "flow");
      }
      // Events arrive newest-first; reverse so the chain reads oldest→newest left→right.
      const steps = [...(t.events || [])].reverse();
      let prev = main ? SID(main.session_id) : TID(t.id);
      steps.forEach((e, i) => {
        const id = EID(t.id, i);
        addNode({ id, kind: "step", label: e.sentence || e.text, status: e.kind, ev: e, taskId: t.id, idx: i });
        addEdge(prev, id, "flow");
        prev = id;
      });
    }

    for (const t of visibleTasks) for (const d of t.deps || []) if (taskIds.has(d.id)) addEdge(TID(d.id), TID(t.id), d.type);

    const deg = new Map<string, number>();
    for (const e of edges) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
    const connected = new Set(nodes.filter((n) => deg.has(n.id)).map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return { nodes, edges, connected, byId, loose: nodes.filter((n) => n.kind === "task" && !connected.has(n.id)) };
  }, [visibleTasks]);

  const { up, down } = useMemo(() => {
    const up = new Map<string, string[]>(), down = new Map<string, string[]>();
    for (const e of model.edges) { (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to); (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from); }
    return { up, down };
  }, [model.edges]);
  const lineOf = (id: string) => {
    const seen = new Set<string>([id]);
    const walk = (m: Map<string, string[]>, start: string) => { const st = [start]; while (st.length) { const x = st.pop()!; for (const y of m.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); } } };
    walk(up, id); walk(down, id);
    return seen;
  };
  const focus = hover ?? (sel && model.byId.has(sel) ? sel : null);
  const line = useMemo(() => (focus ? lineOf(focus) : null), [focus, model]);
  const dim = (id: string) => line !== null && !line.has(id);
  const selNode = sel ? model.byId.get(sel) : undefined;

  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of model.nodes) g.setNode(n.id, { width: n.w, height: n.h });
    for (const e of model.edges) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const gg = g.graph();
    return { g, width: Math.max(gg.width ?? 0, 400), height: Math.max(gg.height ?? 0, 120) };
  }, [model]);

  const clickNode = (n: GNode) => { setSel(n.id); if (n.kind === "task") onSelect(n.task!.id); };
  const first = (data?.tasks || []).find((t) => t.status === "in_progress");
  const doing = first ? (first.sessions.find((s) => isDoer(s) && s.live) || first.sessions.find(isDoer)) : undefined;
  const who = doing ? (actorOf(doing.agent, me)?.name || doing.agent) : first ? (actorOf(first.assignee, me)?.name || first.assignee) : "";
  const sentence = first
    ? doing ? t("{who} 在会话「{session}」做「{task}」", { who, session: sessionLabel(doing), task: first.title }) : t("{who} 在做「{task}」", { who: who || t("有人"), task: first.title })
    : t("暂时没有进行中的任务");

  const nodeCount = model.nodes.filter((n) => model.connected.has(n.id)).length;

  return <div className="lineage">
    <aside className="lineage-side">
      <div className="lineage-side-head">{t("项目")} <span className="muted small">{projects.length}</span></div>
      <div className="lineage-projects">
        {projects.map((p) => <button key={p.name} className={`lineage-proj${p.name === active ? " on" : ""}`} onClick={() => pick(p.name)}>
          <span className="proj" style={{ background: projectColor(p.name) }} />
          <span className="lineage-proj-name">{p.name}</span>
          {p.count > 0 && <span className="muted small mono">{p.count}</span>}
        </button>)}
        {projects.length === 0 && <p className="empty small">{t("还没有项目。")}</p>}
      </div>
    </aside>
    <div className="lineage-main">
      <div className="lineage-top">
        <div className="lineage-head">
          <h3>{data?.project || active || t("脉络")}</h3>
          <p className="lineage-sentence">{sentence}</p>
        </div>
        {data && <span className="muted small">{t("{tasks} 个任务 · {live} 个活会话 · {loose} 个未挂会话", { tasks: data.counts.tasks, live: data.counts.live_sessions, loose: data.counts.unassigned_sessions })}</span>}
      </div>
      <div className="lineage-tools">
        <div className="review-seg" role="tablist" aria-label={t("视图")}>
          <button role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "on" : ""} onClick={() => setTab("graph")}>{t("图")}</button>
          <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>{t("清单")}</button>
        </div>
        <button className={`chip${onlyProg ? " on" : ""}`} aria-pressed={onlyProg} onClick={() => setOnlyProg(!onlyProg)}>{t("只看进行中")}</button>
        <button className={`chip${onlyLive ? " on" : ""}`} aria-pressed={onlyLive} onClick={() => setOnlyLive(!onlyLive)}>{t("只看有活会话")}</button>
        <button className={`chip${onlyWait ? " on" : ""}`} aria-pressed={onlyWait} onClick={() => setOnlyWait(!onlyWait)}>{t("只看我在等的")}</button>
        <span className="spacer" />
        <span className="muted small">{t("最近 {days} 天 · {n} 个任务", { days: data?.days ?? 14, n: visibleTasks.length })}</span>
      </div>
      <div className="lineage-body">
        {tab === "list" ? <div className="lineage-tree">
          {busy && !data && <p className="empty">{t("正在读脉络…")}</p>}
          {err && <p className="err" role="alert">{err}</p>}
          {!busy && !err && data && visibleTasks.length === 0 && <p className="muted small">{t("没有符合条件的任务。")}</p>}
          {visibleTasks.map((t) => <LinTaskCard key={t.id} task={t} me={me} onSelect={onSelect} />)}
          {data && data.unassigned_sessions.length > 0 && <section className="lineage-unassigned">
            <h4>{t("未挂任务的会话")} <span className="muted">{data.unassigned_sessions.length}</span></h4>
            {data.unassigned_sessions.map((s) => <LinSessionRow key={s.session_id} s={s} me={me} />)}
          </section>}
        </div> : <div className="lineage-graph">
          <div className="graph-wrap">
            <div className="graph-tools">
              <span className="muted small mono">{t("{nodes} 节点 · {edges} 边", { nodes: nodeCount, edges: model.edges.length })}</span>
              <span className="spacer" />
              <input type="range" min={0.4} max={1.5} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title={t("缩放")} style={{ width: 90 }} />
            </div>
            <div className="graph-legend small muted">
              <span><i className="lg origin" />{t("发起会话（任务在这段会话里建的，主线）")}</span>
              <span><i className="lg thin" />{t("顺带做（会话顺手接的其他任务）")}</span>
              <span><i className="lg discovered" />{t("派生出")}</span>
              <span><i className="lg blocks" />{t("解锁")}</span>
              <span><i className="lg parent" />{t("包含")}</span>
              <span>{t("任务 → 会话 → 进展/提交，从左到右；悬停或选中一个节点，整条线高亮")}</span>
            </div>
            <div className="graph-scroll">
              {busy && !data && <div className="empty">{t("正在读脉络…")}</div>}
              {err && <p className="err" role="alert">{err}</p>}
              {!busy && data && nodeCount === 0 && model.loose.length === 0 && <div className="empty">{t("这些任务还没有会话或进展，连不成线。")}</div>}
              {nodeCount > 0 && (
                <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} className="graph-svg">
                  <defs>
                    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)" /></marker>
                    <marker id="arr-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
                  </defs>
                  {model.edges.map((e, i) => {
                    const ed = layout.g.edge(e.from, e.to);
                    if (!ed?.points?.length) return null;
                    const pts = ed.points;
                    let d = `M ${pts[0].x} ${pts[0].y}`;
                    for (let k = 1; k < pts.length; k++) {
                      const p0 = pts[k - 1], p1 = pts[k];
                      const cx = (p0.x + p1.x) / 2;
                      d += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
                    }
                    const hi = line !== null && line.has(e.from) && line.has(e.to);
                    const faded = line !== null && !hi;
                    const cls = `edge ${e.type.replace(/[^a-z-]/g, "")}${hi ? " hi" : ""}${faded ? " dim" : ""}`;
                    const mid = pts[Math.floor(pts.length / 2)];
                    const lbl = EDGE_LABEL[e.type];
                    return (
                      <g key={i}>
                        <path d={d} className={cls} markerEnd={hi ? "url(#arr-hi)" : "url(#arr)"} />
                        {hi && lbl && <text x={mid.x} y={mid.y - 6} className="edge-lbl">{t(lbl)}</text>}
                      </g>
                    );
                  })}
                  {model.nodes.map((n) => {
                    if (!model.connected.has(n.id)) return null;
                    const p = layout.g.node(n.id);
                    if (!p) return null;
                    const cls = `node kind-${n.kind}${hover === n.id || sel === n.id ? " sel" : ""}${dim(n.id) ? " dim" : ""}`;
                    const handlers = { onMouseEnter: () => setHover(n.id), onMouseLeave: () => setHover(null), onClick: () => clickNode(n), role: "button" as const, tabIndex: 0 };
                    const s = n;
                    if (n.kind === "task") {
                      const tk = n.task!;
                      const st = LIN_STATUS[tk.status] || { text: tk.status, cls: "open" };
                      const a = actorOf(tk.assignee, me);
                      return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={cls} {...handlers}>
                        <rect width={s.w} height={s.h} rx={9} className="node-bg" />
                        <rect x={0} y={0} width={4} height={s.h} rx={2} className={`node-stripe ${st.cls}`} />
                        <foreignObject x={10} y={6} width={s.w - 16} height={s.h - 12}>
                          <div className="node-body">
                            <div className="node-t" style={{ WebkitLineClamp: n.lines }} title={n.label}>{n.label}</div>
                            <div className="node-m">
                              <span className={`st sm ${st.cls}`}>{t(st.text)}</span>
                              {a && <span className={`av ${a.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{a.glyph}</span>}
                              <span className="mono muted">{tk.id}</span>
                            </div>
                          </div>
                        </foreignObject>
                      </g>;
                    }
                    if (n.kind === "session") {
                      const ss = n.sess!;
                      const a = actorOf(ss.agent, me);
                      const state = ss.state || "ended";
                      return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={cls} {...handlers}>
                        <rect width={s.w} height={s.h} rx={9} className="node-bg" />
                        <rect x={0} y={0} width={4} height={s.h} rx={2} className={`node-stripe ${ss.live ? "prog" : "open"}`} />
                        <foreignObject x={10} y={5} width={s.w - 16} height={s.h - 10}>
                          <div className="node-body node-sess">
                            <div className="node-t" style={{ WebkitLineClamp: n.lines }} title={n.label}>{n.label}</div>
                            <div className="node-m">
                              {a && <span className={`av ${a.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{a.glyph}</span>}
                              <span className={`lin-state${ss.live ? " live" : ""}`}>{t(LIN_STATE[state] || state)}</span>
                            </div>
                          </div>
                        </foreignObject>
                      </g>;
                    }
                    const e = n.ev!;
                    return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={`${cls} k-${e.kind}`} {...handlers}>
                      <rect width={s.w} height={s.h} rx={8} className="node-bg step-bg" />
                      <foreignObject x={8} y={4} width={s.w - 12} height={s.h - 8}>
                        <div className="step-body">
                          <span className={`review-kind k-${e.kind}`}>{t(LIN_KIND[e.kind] || e.kind)}</span>
                          <span className="step-t" style={{ WebkitLineClamp: n.lines }} title={e.text}>{n.label}</span>
                        </div>
                      </foreignObject>
                    </g>;
                  })}
                </svg>
              )}
              {model.loose.length > 0 && (
                <div className="loose">
                  <h4>{t("还没连上线的任务")} <span className="muted">{model.loose.length}</span></h4>
                  <div className="loose-list">
                    {model.loose.map((n) => { const st = LIN_STATUS[n.status] || { cls: "open" }; return <button key={n.id} className={`chip${sel === n.id ? " on" : ""}`} onClick={() => clickNode(n)}><span className={`dot ${st.cls}`} />{n.label}<span className="mono muted">{n.task!.id}</span></button>; })}
                  </div>
                </div>
              )}
            </div>
          </div>
          {selNode && <NodePanel n={selNode} me={me} onSelect={onSelect} onOpenSession={onOpenSession} onClose={() => setSel(null)} />}
        </div>}
      </div>
    </div>
  </div>;
}
