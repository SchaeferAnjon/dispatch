import { useEffect, useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { Api } from "../api";
import { actorOf, ago, projectColor } from "../derive";

interface Props { api: Api; me: string; version: number; selected: string | null; onSelect: (id: string) => void; onOpenSession: (sessionId: string) => void; projects: { name: string; count: number }[] }

const W = 220, H = 64, SW = 156, SH = 46, EW = 122, EH = 40;
const EDGE_LABEL: Record<string, string> = { "discovered-from": "派生出", blocks: "解锁", "parent-child": "包含", "discussed-in": "拆分自", related: "相关", relates_to: "相关" };

type LinDep = { type: string; label: string; id: string };
type LinSession = { session_id: string; agent: string; title?: string; short?: string; summary?: string; state?: string; live?: boolean; relation?: string; verdict?: string; reason?: string; also?: string[]; also_count?: number; last_at?: number };
type LinEvent = { ts: number; kind: string; ref: string; text: string; short?: string; by?: string };
type LinTask = { id: string; title: string; short?: string; status: string; assignee: string; acceptance_done: number; acceptance_total: number; last_at: number; deps: LinDep[]; mentions_count: number; sessions: LinSession[]; events: LinEvent[] };
type LinData = { project: string; days: number; cwd: string; counts: { tasks: number; live_sessions: number; unassigned_sessions: number }; tasks: LinTask[]; unassigned_sessions: LinSession[]; unassigned_events: LinEvent[] };
const LIN_STATUS: Record<string, { text: string; cls: string }> = { in_progress: { text: "进行中", cls: "prog" }, open: { text: "待办", cls: "open" }, blocked: { text: "阻塞", cls: "block" }, deferred: { text: "搁置", cls: "open" }, closed: { text: "已完成", cls: "done" } };
const LIN_STATE: Record<string, string> = { working: "在跑", idle: "等你", ended: "已结束" };
const LIN_KIND: Record<string, string> = { task: "进展", done: "完成", commit: "提交" };
const short = (s: string, n = 8) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const eventDate = (ts: number) => { const d = new Date(ts * 1000); const p = (x: number) => String(x).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Unique graph ids: task/session ids and event refs can collide, so namespace them.
const TID = (x: string) => `t:${x}`;
const SID = (x: string) => `s:${x}`;
const EID = (taskId: string, i: number) => `e:${taskId}:${i}`;

type GKind = "task" | "session" | "step";
interface GNode { id: string; kind: GKind; label: string; status: string; task?: LinTask; sess?: LinSession; ev?: LinEvent; taskId?: string; idx?: number }
interface GEdge { from: string; to: string; type: string }
const sizeOf = (k: GKind) => (k === "task" ? { w: W, h: H } : k === "session" ? { w: SW, h: SH } : { w: EW, h: EH });

function LinSessionRow({ s, me, showRelation }: { s: LinSession; me: string; showRelation?: boolean }) {
  const a = actorOf(s.agent, me);
  return <div className="lin-session">
    <div className="lin-session-head">
      <span className={`av ${a?.kind || "human"} lin-av`} style={{ width: 18, height: 18, fontSize: 8 }}>{a?.glyph || s.agent.slice(0, 1).toUpperCase()}</span>
      <span className="lin-session-agent">{a?.name || s.agent}</span>
      <span className="lin-session-title" title={s.title || s.session_id}>{s.title || short(s.session_id)}</span>
      {s.state && <span className={`lin-state${s.live ? " live" : ""}`}>{LIN_STATE[s.state] || s.state}</span>}
      {showRelation && s.relation ? <span className="muted small lin-relation">{s.relation}</span> : null}
      {s.verdict ? <span className={`review-verdict${s.verdict === "别关" ? " hold" : ""}`}>{s.verdict}</span> : null}
    </div>
    {s.summary && <p className="review-summary small">{s.summary}</p>}
    {s.reason && <p className="review-note muted small">{s.reason}</p>}
    {!!s.also_count && <p className="muted small lin-also">还涉及 {s.also_count} 个任务{Array.isArray(s.also) && s.also.length ? `：${s.also.slice(0, 3).join("、")}${s.also.length < s.also_count ? "…" : ""}` : ""}</p>}
  </div>;
}

function LinTaskCard({ task, me, onSelect }: { task: LinTask; me: string; onSelect: (id: string) => void }) {
  const st = LIN_STATUS[task.status] || { text: task.status, cls: "open" };
  const total = task.acceptance_total || 0;
  const done = task.acceptance_done || 0;
  return <article className="lin-task">
    <div className="lin-task-head">
      <button className="link lin-task-title" title="打开这个任务" onClick={() => onSelect(task.id)}>{task.title}</button>
      <span className={`st sm ${st.cls}`}>{st.text}</span>
      <code className="muted small mono">{task.id}</code>
    </div>
    <div className="lin-task-meta">
      {total > 0 && <span className="lin-prog"><span className="bar"><i style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></span><span className="mono small muted">{done}/{total}</span></span>}
      {task.assignee && <span className="muted small">{actorOf(task.assignee, me)?.name || task.assignee}</span>}
      {task.last_at ? <span className="muted small">最后进展 {ago(task.last_at)}</span> : null}
      {task.mentions_count > 0 && <span className="muted small">提到 {task.mentions_count} 次</span>}
      {task.deps.length > 0 && task.deps.map((d, i) => <span className="lin-dep chip" key={`${d.id}-${i}`} title={d.id}>{d.label}{d.id ? ` · ${short(d.id, 10)}` : ""}</span>)}
    </div>
    {task.sessions.length > 0 && <div className="lin-sessions">{task.sessions.map((s) => <LinSessionRow key={s.session_id} s={s} me={me} showRelation />)}</div>}
    {task.events.length > 0 && <div className="lin-events">{task.events.map((e, i) => <div className="lin-event" key={`${e.ts}-${i}`}>
      <span className={`review-kind k-${e.kind}`}>{LIN_KIND[e.kind] || e.kind}</span>
      <span className="review-date mono">{eventDate(e.ts)}</span>
      {e.kind === "commit" && e.ref ? <code className="review-ref mono">{String(e.ref).slice(0, 7)}</code> : null}
      <span className="review-text clamp-2" title={e.text}>{e.text}</span>
    </div>)}</div>}
  </article>;
}

function NodePanel({ n, me, onSelect, onOpenSession, onClose }: { n: GNode; me: string; onSelect: (id: string) => void; onOpenSession: (sessionId: string) => void; onClose: () => void }) {
  if (n.kind === "task") {
    const t = n.task!;
    const st = LIN_STATUS[t.status] || { text: t.status, cls: "open" };
    const a = actorOf(t.assignee, me);
    const total = t.acceptance_total || 0, done = t.acceptance_done || 0;
    return <aside className="node-panel">
      <div className="np-head"><span className="np-kind">任务</span><button className="np-close" onClick={onClose} aria-label="关闭">×</button></div>
      <h3 className="np-title">{t.title}</h3>
      <div className="np-meta">
        <span className={`st sm ${st.cls}`}>{st.text}</span>
        {a && <span className="muted small">{a.name}</span>}
        {total > 0 && <span className="lin-prog"><span className="bar"><i style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></span><span className="mono small muted">{done}/{total}</span></span>}
        {t.last_at ? <span className="muted small">最后进展 {ago(t.last_at)}</span> : null}
      </div>
      <button className="btn sm primary np-open" onClick={() => onSelect(t.id)}>打开任务</button>
    </aside>;
  }
  if (n.kind === "session") {
    const s = n.sess!;
    const a = actorOf(s.agent, me);
    const state = s.state || "ended";
    return <aside className="node-panel">
      <div className="np-head"><span className="np-kind">会话</span><button className="np-close" onClick={onClose} aria-label="关闭">×</button></div>
      <h3 className="np-title">{s.title || short(s.session_id)}</h3>
      <div className="np-meta">
        {a && <span className={`av ${a.kind}`} style={{ width: 18, height: 18, fontSize: 8 }}>{a.glyph}</span>}
        {a && <span className="muted small">{a.name}</span>}
        <span className={`lin-state${s.live ? " live" : ""}`}>{LIN_STATE[state] || state}</span>
        {s.verdict ? <span className={`review-verdict${s.verdict === "别关" ? " hold" : ""}`}>{s.verdict}</span> : null}
      </div>
      {s.summary && <p className="review-summary small">{s.summary}</p>}
      {s.reason && <p className="review-note muted small">{s.reason}</p>}
      {!!s.also_count && <p className="muted small lin-also">还涉及 {s.also_count} 个任务{Array.isArray(s.also) && s.also.length ? `：${s.also.slice(0, 3).join("、")}${s.also.length < s.also_count ? "…" : ""}` : ""}</p>}
      <button className="btn sm primary np-open" onClick={() => onOpenSession(s.session_id)}>打开会话</button>
    </aside>;
  }
  const e = n.ev!;
  return <aside className="node-panel">
    <div className="np-head"><span className="np-kind">进展</span><button className="np-close" onClick={onClose} aria-label="关闭">×</button></div>
    <div className="np-meta">
      <span className={`review-kind k-${e.kind}`}>{LIN_KIND[e.kind] || e.kind}</span>
      <span className="review-date mono">{eventDate(e.ts)}</span>
      {e.kind === "commit" && e.ref ? <code className="review-ref mono">{String(e.ref).slice(0, 7)}</code> : null}
    </div>
    <p className="review-text np-text">{e.text}</p>
    {e.by && <span className="muted small">记录者 {actorOf(e.by, me)?.name || e.by}</span>}
    {n.taskId && <button className="btn sm primary np-open" onClick={() => onSelect(n.taskId!)}>打开任务</button>}
  </aside>;
}

export function GraphView({ api, me, version, selected, onSelect, onOpenSession, projects }: Props) {
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

  const visibleTasks = useMemo(() => {
    const since = Date.now() / 1000 - (data?.days ?? 14) * 86400;
    return (data?.tasks || []).filter((t) =>
      (!t.last_at || t.last_at >= since) &&
      (!onlyProg || t.status === "in_progress") &&
      (!onlyLive || t.sessions.some((s) => s.live)) &&
      (!onlyWait || t.sessions.some((s) => s.live && (s.verdict === "别关" || s.state === "idle"))));
  }, [data, onlyProg, onlyLive, onlyWait]);

  // Build the node+edge model: task cards + their 在做 sessions + every event as its own step,
  // chained left-to-right into one line, plus task→task dependency edges.
  const model = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    const seenNode = new Set<string>();
    const seenEdge = new Set<string>();
    const addNode = (n: GNode) => { if (!seenNode.has(n.id)) { seenNode.add(n.id); nodes.push(n); } };
    const addEdge = (from: string, to: string, type: string) => { const k = `${from}|${to}|${type}`; if (!seenEdge.has(k)) { seenEdge.add(k); edges.push({ from, to, type }); } };
    const taskIds = new Set(visibleTasks.map((t) => t.id));

    for (const t of visibleTasks) addNode({ id: TID(t.id), kind: "task", label: t.short || short(t.title, 14), status: t.status, task: t });

    for (const t of visibleTasks) {
      const doers = t.sessions.filter((s) => s.relation === "在做");
      const firstDoer: string | null = doers.length ? SID(doers[0].session_id) : null;
      for (const s of doers) {
        addNode({ id: SID(s.session_id), kind: "session", label: s.short || short(s.title || s.session_id, 16), status: s.state || "ended", sess: s, taskId: t.id });
        addEdge(TID(t.id), SID(s.session_id), "flow");
      }
      // Events arrive newest-first; reverse so the chain reads oldest→newest left→right.
      const steps = [...(t.events || [])].reverse();
      let prev = firstDoer || TID(t.id);
      steps.forEach((e, i) => {
        const id = EID(t.id, i);
        addNode({ id, kind: "step", label: e.short || short(e.text, 12), status: e.kind, ev: e, taskId: t.id, idx: i });
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
    for (const n of model.nodes) { const s = sizeOf(n.kind); g.setNode(n.id, { width: s.w, height: s.h }); }
    for (const e of model.edges) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const gg = g.graph();
    return { g, width: Math.max(gg.width ?? 0, 400), height: Math.max(gg.height ?? 0, 120) };
  }, [model]);

  const clickNode = (n: GNode) => { setSel(n.id); if (n.kind === "task") onSelect(n.task!.id); };
  const first = (data?.tasks || []).find((t) => t.status === "in_progress");
  const doing = first ? (first.sessions.find((s) => s.relation === "在做" && s.live) || first.sessions.find((s) => s.relation === "在做") || first.sessions[0]) : undefined;
  const who = doing ? (actorOf(doing.agent, me)?.name || doing.agent) : first ? (actorOf(first.assignee, me)?.name || first.assignee) : "";
  const sentence = first
    ? doing ? `${who} 在会话「${doing.title || short(doing.session_id)}」做「${first.title}」` : `${who || "有人"} 在做「${first.title}」`
    : "暂时没有进行中的任务";

  const nodeCount = model.nodes.filter((n) => model.connected.has(n.id)).length;

  return <div className="lineage">
    <aside className="lineage-side">
      <div className="lineage-side-head">项目 <span className="muted small">{projects.length}</span></div>
      <div className="lineage-projects">
        {projects.map((p) => <button key={p.name} className={`lineage-proj${p.name === active ? " on" : ""}`} onClick={() => pick(p.name)}>
          <span className="proj" style={{ background: projectColor(p.name) }} />
          <span className="lineage-proj-name">{p.name}</span>
          {p.count > 0 && <span className="muted small mono">{p.count}</span>}
        </button>)}
        {projects.length === 0 && <p className="empty small">还没有项目。</p>}
      </div>
    </aside>
    <div className="lineage-main">
      <div className="lineage-top">
        <div className="lineage-head">
          <h3>{data?.project || active || "脉络"}</h3>
          <p className="lineage-sentence">{sentence}</p>
        </div>
        {data && <span className="muted small">{data.counts.tasks} 个任务 · {data.counts.live_sessions} 个活会话 · {data.counts.unassigned_sessions} 个未挂会话</span>}
      </div>
      <div className="lineage-tools">
        <div className="review-seg" role="tablist" aria-label="视图">
          <button role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "on" : ""} onClick={() => setTab("graph")}>图</button>
          <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>清单</button>
        </div>
        <button className={`chip${onlyProg ? " on" : ""}`} aria-pressed={onlyProg} onClick={() => setOnlyProg(!onlyProg)}>只看进行中</button>
        <button className={`chip${onlyLive ? " on" : ""}`} aria-pressed={onlyLive} onClick={() => setOnlyLive(!onlyLive)}>只看有活会话</button>
        <button className={`chip${onlyWait ? " on" : ""}`} aria-pressed={onlyWait} onClick={() => setOnlyWait(!onlyWait)}>只看我在等的</button>
        <span className="spacer" />
        <span className="muted small">最近 {data?.days ?? 14} 天 · {visibleTasks.length} 个任务</span>
      </div>
      <div className="lineage-body">
        {tab === "list" ? <div className="lineage-tree">
          {busy && !data && <p className="empty">正在读脉络…</p>}
          {err && <p className="err" role="alert">{err}</p>}
          {!busy && !err && data && visibleTasks.length === 0 && <p className="muted small">没有符合条件的任务。</p>}
          {visibleTasks.map((t) => <LinTaskCard key={t.id} task={t} me={me} onSelect={onSelect} />)}
          {data && data.unassigned_sessions.length > 0 && <section className="lineage-unassigned">
            <h4>未挂任务的会话 <span className="muted">{data.unassigned_sessions.length}</span></h4>
            {data.unassigned_sessions.map((s) => <LinSessionRow key={s.session_id} s={s} me={me} />)}
          </section>}
        </div> : <div className="lineage-graph">
          <div className="graph-wrap">
            <div className="graph-tools">
              <span className="muted small mono">{nodeCount} 节点 · {model.edges.length} 边</span>
              <span className="spacer" />
              <input type="range" min={0.4} max={1.5} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="缩放" style={{ width: 90 }} />
            </div>
            <div className="graph-legend small muted">
              <span><i className="lg discovered" />派生出（做 A 时发现了 B）</span>
              <span><i className="lg blocks" />解锁（A 做完 B 才能开始）</span>
              <span><i className="lg parent" />包含（epic → 子任务）</span>
              <span>悬停或选中一个节点，整条线高亮；其余变淡</span>
            </div>
            <div className="graph-scroll">
              {busy && !data && <div className="empty">正在读脉络…</div>}
              {err && <p className="err" role="alert">{err}</p>}
              {!busy && data && nodeCount === 0 && model.loose.length === 0 && <div className="empty">这些任务还没有会话或进展，连不成线。</div>}
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
                        {hi && lbl && <text x={mid.x} y={mid.y - 6} className="edge-lbl">{lbl}</text>}
                      </g>
                    );
                  })}
                  {model.nodes.map((n) => {
                    if (!model.connected.has(n.id)) return null;
                    const p = layout.g.node(n.id);
                    if (!p) return null;
                    const cls = `node kind-${n.kind}${hover === n.id || sel === n.id ? " sel" : ""}${dim(n.id) ? " dim" : ""}`;
                    const handlers = { onMouseEnter: () => setHover(n.id), onMouseLeave: () => setHover(null), onClick: () => clickNode(n), role: "button" as const, tabIndex: 0 };
                    if (n.kind === "task") {
                      const s = sizeOf("task"), t = n.task!;
                      const st = LIN_STATUS[t.status] || { text: t.status, cls: "open" };
                      const a = actorOf(t.assignee, me);
                      return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={cls} {...handlers}>
                        <rect width={s.w} height={s.h} rx={9} className="node-bg" />
                        <rect x={0} y={0} width={4} height={s.h} rx={2} className={`node-stripe ${st.cls}`} />
                        <foreignObject x={10} y={6} width={s.w - 16} height={s.h - 12}>
                          <div className="node-body">
                            <div className="node-t">{n.label}</div>
                            <div className="node-m">
                              <span className={`st sm ${st.cls}`}>{st.text}</span>
                              {a && <span className={`av ${a.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{a.glyph}</span>}
                              <span className="mono muted">{t.id}</span>
                            </div>
                          </div>
                        </foreignObject>
                      </g>;
                    }
                    if (n.kind === "session") {
                      const s = sizeOf("session"), ss = n.sess!;
                      const a = actorOf(ss.agent, me);
                      const state = ss.state || "ended";
                      return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={cls} {...handlers}>
                        <rect width={s.w} height={s.h} rx={9} className="node-bg" />
                        <rect x={0} y={0} width={4} height={s.h} rx={2} className={`node-stripe ${ss.live ? "prog" : "open"}`} />
                        <foreignObject x={10} y={5} width={s.w - 16} height={s.h - 10}>
                          <div className="node-body sess-body">
                            <div className="node-t one">{n.label}</div>
                            <div className="node-m">
                              {a && <span className={`av ${a.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{a.glyph}</span>}
                              <span className={`lin-state${ss.live ? " live" : ""}`}>{LIN_STATE[state] || state}</span>
                            </div>
                          </div>
                        </foreignObject>
                      </g>;
                    }
                    const s = sizeOf("step"), e = n.ev!;
                    return <g key={n.id} transform={`translate(${p.x - s.w / 2},${p.y - s.h / 2})`} className={`${cls} k-${e.kind}`} {...handlers}>
                      <rect width={s.w} height={s.h} rx={8} className="node-bg step-bg" />
                      <foreignObject x={8} y={4} width={s.w - 12} height={s.h - 8}>
                        <div className="step-body">
                          <span className={`review-kind k-${e.kind}`}>{LIN_KIND[e.kind] || e.kind}</span>
                          <span className="step-t">{n.label}</span>
                        </div>
                      </foreignObject>
                    </g>;
                  })}
                </svg>
              )}
              {model.loose.length > 0 && (
                <div className="loose">
                  <h4>还没连上线的任务 <span className="muted">{model.loose.length}</span></h4>
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
