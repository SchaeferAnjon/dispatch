import { useEffect, useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { Api } from "../api";
import { actorOf, ago, projectColor, projectOf, statusLabel } from "../derive";
import { isOutcome } from "../projectModel";
import { isTrashed } from "./TaskActions";
import type { GraphData, Issue } from "../types";

interface Props { api: Api; me: string; version: number; selected: string | null; onSelect: (id: string) => void; projects: { name: string; count: number }[] }

const W = 220, H = 64;
const EDGE_LABEL: Record<string, string> = { "discovered-from": "派生出", blocks: "解锁", "parent-child": "包含", related: "相关", relates_to: "相关" };

type LinDep = { type: string; label: string; id: string };
type LinSession = { session_id: string; agent: string; title?: string; summary?: string; state?: string; live?: boolean; relation?: string; verdict?: string; reason?: string; also?: string[]; also_count?: number; last_at?: number };
type LinEvent = { ts: number; kind: string; ref: string; text: string; by?: string };
type LinTask = { id: string; title: string; status: string; assignee: string; acceptance_done: number; acceptance_total: number; last_at: number; deps: LinDep[]; mentions_count: number; sessions: LinSession[]; events: LinEvent[] };
type LinData = { project: string; days: number; cwd: string; counts: { tasks: number; live_sessions: number; unassigned_sessions: number }; tasks: LinTask[]; unassigned_sessions: LinSession[]; unassigned_events: LinEvent[] };
const LIN_STATUS: Record<string, { text: string; cls: string }> = { in_progress: { text: "进行中", cls: "prog" }, open: { text: "待办", cls: "open" }, blocked: { text: "阻塞", cls: "block" }, deferred: { text: "搁置", cls: "open" }, closed: { text: "已完成", cls: "done" } };
const LIN_STATE: Record<string, string> = { working: "在跑", idle: "等你", ended: "已结束" };
const LIN_KIND: Record<string, string> = { task: "进展", done: "完成", commit: "提交" };
const short = (s: string, n = 8) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const eventDate = (ts: number) => { const d = new Date(ts * 1000); const p = (x: number) => String(x).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

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

export function GraphView({ api, me, version, selected, onSelect, projects }: Props) {
  const [picked, setPicked] = useState("");
  const [data, setData] = useState<LinData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [onlyProg, setOnlyProg] = useState(false);
  const [onlyLive, setOnlyLive] = useState(false);
  const [onlyWait, setOnlyWait] = useState(false);
  const active = picked || projects[0]?.name || "";
  const pick = (name: string) => { if (name !== active) setData(null); setPicked(name); };

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

  const tasks = (data?.tasks || []).filter((t) =>
    (!onlyProg || t.status === "in_progress") &&
    (!onlyLive || t.sessions.some((s) => s.live)) &&
    (!onlyWait || t.sessions.some((s) => s.live && (s.verdict === "别关" || s.state === "idle"))));
  const first = (data?.tasks || []).find((t) => t.status === "in_progress");
  const doing = first ? (first.sessions.find((s) => s.relation === "在做" && s.live) || first.sessions.find((s) => s.relation === "在做") || first.sessions[0]) : undefined;
  const who = doing ? (actorOf(doing.agent, me)?.name || doing.agent) : first ? (actorOf(first.assignee, me)?.name || first.assignee) : "";
  const sentence = first
    ? doing ? `${who} 在会话「${doing.title || short(doing.session_id)}」做「${first.title}」` : `${who || "有人"} 在做「${first.title}」`
    : "暂时没有进行中的任务";

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
        <button className={`chip${onlyProg ? " on" : ""}`} aria-pressed={onlyProg} onClick={() => setOnlyProg(!onlyProg)}>只看进行中</button>
        <button className={`chip${onlyLive ? " on" : ""}`} aria-pressed={onlyLive} onClick={() => setOnlyLive(!onlyLive)}>只看有活会话</button>
        <button className={`chip${onlyWait ? " on" : ""}`} aria-pressed={onlyWait} onClick={() => setOnlyWait(!onlyWait)}>只看我在等的</button>
        <span className="spacer" />
        <span className="muted small">{tasks.length} 个任务</span>
      </div>
      <div className="lineage-tree">
        {busy && !data && <p className="empty">正在读脉络…</p>}
        {err && <p className="err" role="alert">{err}</p>}
        {!busy && !err && data && tasks.length === 0 && <p className="muted small">没有符合条件的任务。</p>}
        {tasks.map((t) => <LinTaskCard key={t.id} task={t} me={me} onSelect={onSelect} />)}
        {data && data.unassigned_sessions.length > 0 && <section className="lineage-unassigned">
          <h4>未挂任务的会话 <span className="muted">{data.unassigned_sessions.length}</span></h4>
          {data.unassigned_sessions.map((s) => <LinSessionRow key={s.session_id} s={s} me={me} />)}
        </section>}
        <details className="lineage-dep">
          <summary>依赖</summary>
          <div className="lineage-dep-body"><DependencyGraph api={api} me={me} version={version} selected={selected} onSelect={onSelect} /></div>
        </details>
      </div>
    </div>
  </div>;
}

interface DepProps { api: Api; me: string; version: number; selected: string | null; onSelect: (id: string) => void }

// Tasks as a thread: upstream on the left, whatever they spawned or unblocked on
// the right. Forks and merges are just nodes with several out- or in-edges.
function DependencyGraph({ api, me, version, selected, onSelect }: DepProps) {
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [project, setProject] = useState<string>("");
  const [showClosed, setShowClosed] = useState(true);
  const [onlyThread, setOnlyThread] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let alive = true;
    api.graph().then((g) => {
      if (!alive) return;
      // Outcomes are deliverables, trashed tasks are gone: neither belongs on a thread.
      const keep = new Set(g.nodes.filter((n) => !isOutcome(n) && !isTrashed(n)).map((n) => n.id));
      setData({ nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) });
      setLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, version]);

  const projects = useMemo(() => [...new Set(data.nodes.map(projectOf))].filter(Boolean).sort(), [data]);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);

  // Adjacency for highlighting the whole line a node sits on.
  const { up, down } = useMemo(() => {
    const up = new Map<string, string[]>(), down = new Map<string, string[]>();
    for (const e of data.edges) { (down.get(e.from) ?? down.set(e.from, []).get(e.from)!).push(e.to); (up.get(e.to) ?? up.set(e.to, []).get(e.to)!).push(e.from); }
    return { up, down };
  }, [data]);
  const lineOf = (id: string) => {
    const seen = new Set<string>([id]);
    const walk = (m: Map<string, string[]>, start: string) => { const st = [start]; while (st.length) { const x = st.pop()!; for (const y of m.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); } } };
    walk(up, id); walk(down, id);
    return seen;
  };
  const focus = hover ?? selected;
  const line = useMemo(() => (focus && byId.has(focus) ? lineOf(focus) : null), [focus, data]);

  const visible = useMemo(() => {
    let ns = data.nodes.filter((n) => (!project || projectOf(n) === project) && (showClosed || n.status !== "closed"));
    if (onlyThread && line) ns = ns.filter((n) => line.has(n.id));
    const ids = new Set(ns.map((n) => n.id));
    const es = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const connected = new Set(es.flatMap((e) => [e.from, e.to]));
    return { nodes: ns.filter((n) => connected.has(n.id)), loose: ns.filter((n) => !connected.has(n.id)), edges: es };
  }, [data, project, showClosed, onlyThread, line]);

  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of visible.nodes) g.setNode(n.id, { width: W, height: H });
    for (const e of visible.edges) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const gg = g.graph();
    return { g, width: Math.max(gg.width ?? 0, 400), height: Math.max(gg.height ?? 0, 120) };
  }, [visible]);

  const dim = (id: string) => line !== null && !line.has(id);

  return (
    <div className="graph-wrap">
      <div className="graph-tools">
        <div className="views">
          <button className={project === "" ? "on" : ""} onClick={() => setProject("")}>全部项目</button>
          {projects.map((p) => <button key={p} className={project === p ? "on" : ""} onClick={() => setProject(p)}><span className="proj" style={{ background: projectColor(p), display: "inline-block", width: 7, height: 7, borderRadius: 2, marginRight: 5 }} />{p}</button>)}
        </div>
        <span className="spacer" />
        <button className={`chip${showClosed ? " on" : ""}`} onClick={() => setShowClosed(!showClosed)}>含已完成</button>
        <button className={`chip${onlyThread ? " on" : ""}`} onClick={() => setOnlyThread(!onlyThread)} disabled={!selected} title="只显示选中任务所在的那根线">只看这条线</button>
        <span className="muted small mono">{visible.nodes.length} 节点 · {visible.edges.length} 边</span>
        <input type="range" min={0.5} max={1.5} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="缩放" style={{ width: 90 }} />
      </div>
      <div className="graph-legend small muted">
        <span><i className="lg discovered" />派生出（做 A 时发现了 B）</span>
        <span><i className="lg blocks" />解锁（A 做完 B 才能开始）</span>
        <span><i className="lg parent" />包含（epic → 子任务）</span>
        <span>悬停或选中一个节点，整条线高亮；其余变淡</span>
      </div>
      <div className="graph-scroll">
        {!loaded && <div className="empty">读取依赖关系…</div>}
        {loaded && visible.nodes.length === 0 && <div className="empty">还没有相连的任务。Agent 用 <span className="mono">dispatch done --next</span> 派生后续、或 <span className="mono">bd dep add</span> 加依赖，这里就会长出线来。</div>}
        {visible.nodes.length > 0 && (
          <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} className="graph-svg">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)" /></marker>
              <marker id="arr-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" /></marker>
            </defs>
            {visible.edges.map((e, i) => {
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
              return (
                <g key={i}>
                  <path d={d} className={cls} markerEnd={hi ? "url(#arr-hi)" : "url(#arr)"} />
                  {hi && <text x={mid.x} y={mid.y - 6} className="edge-lbl">{EDGE_LABEL[e.type] ?? e.type}</text>}
                </g>
              );
            })}
            {visible.nodes.map((n) => {
              const p = layout.g.node(n.id);
              if (!p) return null;
              const x = p.x - W / 2, y = p.y - H / 2;
              const st = statusLabel(n);
              const a = actorOf(n.assignee, me);
              const outs = (down.get(n.id) ?? []).length, ins = (up.get(n.id) ?? []).length;
              return (
                <g key={n.id} data-task={n.id} transform={`translate(${x},${y})`} className={`node${selected === n.id ? " sel" : ""}${dim(n.id) ? " dim" : ""}`}
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect(n.id)} role="button" tabIndex={0}>
                  <rect width={W} height={H} rx={9} className="node-bg" />
                  <rect x={0} y={0} width={4} height={H} rx={2} className={`node-stripe ${st.cls}`} />
                  <foreignObject x={10} y={6} width={W - 16} height={H - 12}>
                    <div className="node-body">
                      <div className="node-t">{n.title}</div>
                      <div className="node-m">
                        <span className={`st sm ${st.cls}`}>{st.text}</span>
                        {a && <span className={`av ${a.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{a.glyph}</span>}
                        <span className="mono muted">{n.id}</span>
                        {(outs > 1 || ins > 1) && <span className="muted" title={`${ins} 进 · ${outs} 出`}>{ins > 1 ? "⇒ 汇合" : "⇉ 分叉"}</span>}
                      </div>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        )}
        {visible.loose.length > 0 && (
          <div className="loose">
            <h4>还没连上线的任务 <span className="muted">{visible.loose.length}</span></h4>
            <div className="loose-list">
              {visible.loose.map((n) => { const st = statusLabel(n); return <button key={n.id} className={`chip${selected === n.id ? " on" : ""}`} onClick={() => onSelect(n.id)}><span className={`dot ${st.cls}`} />{n.title}<span className="mono muted">{n.id}</span></button>; })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export type { Issue };
