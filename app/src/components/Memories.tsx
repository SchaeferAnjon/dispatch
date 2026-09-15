import { confirmAction } from '../confirm';
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface MemoryEntry {
  id: string; agent: string; project: string; project_dir: string; expired: boolean;
  path: string; name: string; description: string; type: string; index: boolean;
  size: number; mtime: number; body: string;
}
interface MemorySummary {
  at: number; model: string; cached: boolean; fingerprint: string;
  overall: string; projects: Record<string, string>;
}
type Sel = { kind: "entry"; path: string } | { kind: "project"; agent: string; project: string } | null;

const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", zcode: "ZCode", hermes: "Hermes" };
const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };
const fmtSize = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const fmtTime = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const cleanName = (n: string) => n.replace(/\.md$/, "");
const isGeneral = (p: string) => p === "通用" || p === "全局";
const projectKey = (agent: string, project: string) => `${agent}|${project}`;
const agentRank = (a: string) => { const i = Object.keys(AGENT_LABEL).indexOf(a); return i < 0 ? 99 : i; };
const norm = (r: Partial<MemoryEntry>): MemoryEntry => ({
  id: r.id ?? r.path ?? "", agent: r.agent ?? "", project: r.project ?? "通用", project_dir: r.project_dir ?? "",
  expired: Boolean(r.expired), path: r.path ?? "", name: r.name ?? "", description: r.description ?? "",
  type: r.type ?? "", index: Boolean(r.index), size: r.size ?? 0, mtime: r.mtime ?? 0, body: r.body ?? "",
});

// Each agent keeps its own long-term memory on disk; this page only reads them.
export function MemoriesView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [files, setFiles] = useState<MemoryEntry[]>([]);
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const blocked = hostReason(hosts, host);

  const loadList = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { setFiles(parseJson<Partial<MemoryEntry>[]>(await api.on(host, ["memories", "list", "--json"]), []).map(norm)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);

  const loadSummary = useCallback(async (force = false) => {
    if (blocked) return;
    setSummaryBusy(true); setSummaryFailed(false);
    try {
      const args = force ? ["memories", "summary", "--force", "--json"] : ["memories", "summary", "--json"];
      const s = parseJson<MemorySummary | null>(await api.on(host, args), null);
      setSummary(s);
      if (!s) setSummaryFailed(true);
    } catch { setSummaryFailed(true); }
    finally { setSummaryBusy(false); }
  }, [api, host, blocked]);

  useEffect(() => { setFiles([]); setSummary(null); setSel(null); setSummaryFailed(false); void loadList(); void loadSummary(false); }, [loadList, loadSummary]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byAgent = new Map<string, Map<string, MemoryEntry[]>>();
    for (const f of files) {
      if (q && !`${f.project} ${f.description} ${f.name}`.toLowerCase().includes(q)) continue;
      const projects = byAgent.get(f.agent) ?? new Map<string, MemoryEntry[]>();
      projects.set(f.project, [...(projects.get(f.project) ?? []), f]);
      byAgent.set(f.agent, projects);
    }
    return [...byAgent.entries()]
      .sort((a, b) => agentRank(a[0]) - agentRank(b[0]))
      .map(([agent, projects]) => [agent, [...projects.entries()].sort((a, b) => {
        const ga = isGeneral(a[0]) ? 1 : 0, gb = isGeneral(b[0]) ? 1 : 0;
        return ga !== gb ? ga - gb : a[0].localeCompare(b[0], "zh");
      })] as [string, [string, MemoryEntry[]][]]);
  }, [files, q]);

  const selectedPath = sel?.kind === "entry" ? sel.path : "";
  const selectedEntry = useMemo(() => (sel?.kind === "entry" ? files.find((f) => f.path === sel.path) ?? null : null), [files, sel]);
  const isOpen = (agent: string, project: string, list: MemoryEntry[]) => {
    if (q) return true;
    const k = projectKey(agent, project);
    if (openProjects[k] === true) return true;
    if (openProjects[k] === false) return false;
    if (sel?.kind === "project" && sel.agent === agent && sel.project === project) return true;
    return list.length <= 3 || list.some((f) => f.path === selectedPath);
  };

  const selectEntry = (e: MemoryEntry) => {
    setSel({ kind: "entry", path: e.path });
    const k = projectKey(e.agent, e.project);
    setOpenProjects((o) => (o[k] === undefined ? o : { ...o, [k]: true }));
  };
  const archive = async (e: MemoryEntry) => {
    const label = e.description || cleanName(e.name);
    setBusy(true);
    try {
      if (!await confirmAction(`归档「${label}」？文件会移到同目录的 archived/ 文件夹，不再出现在这里。`)) return;
      await api.on(host, ["memories", "archive", "--path", e.path, "--json"]); onDone("已归档"); await loadList();
    }
    catch (err) { onError(String(err)); } finally { setBusy(false); }
  };
  const promote = async (e: MemoryEntry) => {
    const text = (e.description || cleanName(e.name)).trim();
    if (!text) return;
    setBusy(true);
    try { await api.on(host, ["profile", "add", text]); onDone("已归入「关于我」"); }
    catch (err) { onError(String(err)); } finally { setBusy(false); }
  };

  const entryRow = (e: MemoryEntry) => {
    const active = selectedPath === e.path;
    return <div key={e.path} className={`memories-entry${active ? " on" : ""}${e.expired ? " memories-entry-expired" : ""}`}>
      <button className="memories-entry-main" onClick={() => selectEntry(e)} title={e.name} aria-current={active ? "true" : undefined}>
        <span className="memories-entry-desc">{e.description || cleanName(e.name)}{e.index ? <span className="memories-tag">索引</span> : null}{e.expired ? <span className="memories-tag memories-tag-expired">过期</span> : null}</span>
        <small className="memories-entry-meta">{fmtSize(e.size)} · {fmtTime(e.mtime)}</small>
      </button>
      {e.expired ? <button className="memories-archive" disabled={busy} onClick={() => void archive(e)} title="移到 archived/ 文件夹">归档</button> : null}
    </div>;
  };

  const overview = () => {
    const entries = Object.entries(summary?.projects ?? {});
    return <>
      <header><div><h3>Agent 记忆总览</h3><div className="muted small">{summary ? `${summary.model || "模型"} 总结于 ${summary.at ? fmtTime(summary.at) : "—"}${summary.cached ? "（缓存）" : ""}` : "各 Agent 跨会话自己积累的记忆，按项目分组，只读。"}</div></div><span className="spacer" />
        <button className="btn sm" disabled={summaryBusy || busy || !!blocked} onClick={() => void loadSummary(true)}>{summaryBusy ? "正在总结…" : "重新总结"}</button>
      </header>
      {summaryBusy && !summary ? <p className="muted small">正在总结各项目的记忆，第一次可能要等半分钟…</p> : null}
      {summary ? <>
        <div className="instruction-content memories-summary"><Markdown src={summary.overall || "暂无总览。"} /></div>
        {entries.length > 0 ? <section className="memories-summary-projects">
          <h4 className="muted small">各项目一句话</h4>
          {entries.map(([key, sentence]) => { const i = key.indexOf("|"); const a = i < 0 ? "" : key.slice(0, i); const p = i < 0 ? key : key.slice(i + 1); return <article key={key} className="memories-summary-project"><b>{p}{a && a !== "codex" ? <span className="muted"> · {AGENT_LABEL[a] ?? a}</span> : null}</b><p>{sentence}</p></article>; })}
        </section> : null}
      </> : !summaryBusy ? <div className="memories-intro">
        <p className="small muted">{summaryFailed ? "暂时取不到总览，点「重新总结」再试；左侧的记忆仍然可以直接查看。" : "还没有总览。"}</p>
        <p className="small muted">左侧按 Agent 和项目列出本机的长期记忆，点开一条就能读正文。</p>
      </div> : null}
    </>;
  };

  const projectDetail = (agent: string, project: string) => {
    const list = files.filter((f) => f.agent === agent && f.project === project);
    const sentence = summary?.projects?.[projectKey(agent, project)] ?? "";
    return <>
      <header><div><h3>{project}</h3><div className="muted small">{AGENT_LABEL[agent] ?? agent} · {list.length} 条记忆</div></div></header>
      {sentence ? <p className="memories-project-summary">{sentence}</p> : <p className="muted small">这个项目还没有一句话总结，点「重新总结」可以生成。</p>}
      {list.length > 0 ? <div className="memories-project-entries">{list.map(entryRow)}</div> : <p className="muted small">这个项目下没有记忆文件。</p>}
    </>;
  };

  const entryDetail = (e: MemoryEntry) => {
    const text = (e.description || cleanName(e.name)).trim();
    return <>
      <header><div><h3>{e.description || cleanName(e.name)}</h3><div className="muted mono small">{e.name}{e.type ? ` · ${e.type}` : ""} · {short(e.path)} · {fmtSize(e.size)} · {fmtTime(e.mtime)}{e.expired ? " · 项目目录已不存在" : ""}</div></div><span className="spacer" />
        <button className="btn sm" disabled={busy} onClick={() => api.copy(e.path).then(() => onDone("路径已复制")).catch((err) => onError(String(err)))}>复制路径</button>
        <button className="btn sm" disabled={busy} onClick={() => api.openPath(e.path).catch((err) => onError(String(err)))}>用默认应用打开</button>
        {text ? <button className="btn sm" disabled={busy} onClick={() => void promote(e)} title="把这句话追加到「关于我」，之后所有 Agent 都会看到">归入关于我</button> : null}
      </header>
      {e.index ? <p className="small muted">这是本项目的索引文件，列出的条目就是下面这些记忆。</p> : null}
      <div className="instruction-content facts-content memories-content">{e.body ? <Markdown src={e.body} /> : <span className="muted">这个文件是空的。</span>}</div>
    </>;
  };

  return <div className="instruction-center">
    <div className="instruction-top">
      <HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={(h) => { if (!busy) setHost(h); }} />
      <input className="memories-search" type="search" placeholder="按项目、描述或文件名筛选" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="筛选记忆文件" />
      <span className="spacer" />
      <button className="btn sm" disabled={busy} onClick={() => { void loadList(); void loadSummary(false); }}>重新读取</button>
    </div>
    <p className="memories-lead">每个 Agent 在这里保存自己跨会话积累的长期记忆，按项目分组，页面只读不会改动它们。想让它变成所有 Agent 都知道的事实，打开一条记忆点「归入关于我」。</p>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="instruction-grid memories-grid">
      <aside className="instruction-docs memories-list">
        <h3>Agent 记忆 <span className="muted">{files.length || "…"}</span></h3>
        {groups.map(([agent, projects]) => <section key={agent} className="memories-agent">
          <h4>{AGENT_LABEL[agent] ?? agent} <span className="muted">{projects.reduce((n, [, l]) => n + l.length, 0)}</span></h4>
          {projects.map(([project, list]) => {
            const open = isOpen(agent, project, list);
            const dirs = [...new Set(list.map((f) => f.project_dir).filter(Boolean))];
            const active = sel?.kind === "project" && sel.agent === agent && sel.project === project;
            return <div key={project} className="memories-project">
              <button className={`memories-project-head${active ? " on" : ""}`} aria-expanded={open}
                onClick={() => { setOpenProjects((o) => ({ ...o, [projectKey(agent, project)]: !open })); setSel({ kind: "project", agent, project }); }}>
                <span className="memories-caret">{open ? "▾" : "▸"}</span>
                <b title={dirs.length > 1 ? dirs.map(short).join("\n") : project}>{project}</b>
                <span className="muted">{list.length}</span>
              </button>
              {open ? list.map(entryRow) : null}
            </div>;
          })}
        </section>)}
        {!busy && files.length === 0 && !error && <p className="muted small">这台机器上没找到任何 Agent 的记忆文件。</p>}
        {files.length > 0 && groups.length === 0 && <p className="muted small">没有匹配「{query}」的记忆。</p>}
      </aside>
      <div className="instruction-detail">
        {selectedEntry ? entryDetail(selectedEntry) : sel?.kind === "project" ? projectDetail(sel.agent, sel.project) : overview()}
      </div>
    </div>
  </div>;
}
