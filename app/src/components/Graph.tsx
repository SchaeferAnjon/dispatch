import { useEffect, useMemo, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { Api } from "../api";
import { actorOf, projectColor, projectOf, statusLabel } from "../derive";
import type { GraphData, Issue } from "../types";

interface Props { api: Api; me: string; version: number; selected: string | null; onSelect: (id: string) => void }

const W = 220, H = 64;
const EDGE_LABEL: Record<string, string> = { "discovered-from": "派生出", blocks: "解锁", "parent-child": "包含", related: "相关", relates_to: "相关" };

// Tasks as a thread: upstream on the left, whatever they spawned or unblocked on
// the right. Forks and merges are just nodes with several out- or in-edges.
export function GraphView({ api, me, version, selected, onSelect }: Props) {
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [project, setProject] = useState<string>("");
  const [showClosed, setShowClosed] = useState(true);
  const [onlyThread, setOnlyThread] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let alive = true;
    api.graph().then((g) => { if (alive) { setData(g); setLoaded(true); } }).catch(() => {});
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
                <g key={n.id} transform={`translate(${x},${y})`} className={`node${selected === n.id ? " sel" : ""}${dim(n.id) ? " dim" : ""}`}
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
