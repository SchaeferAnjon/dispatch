import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Host, Skill } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { Markdown, splitFrontmatter } from "./Markdown";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const AGENTS: { id: string; label: string; cls: string }[] = [
  { id: "claude", label: "Claude Code", cls: "claude" },
  { id: "codex", label: "Codex", cls: "codex" },
];

export function SkillsView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const blocked = hostReason(hosts, host);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<string>("");
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  // Which file of the skill folder is open: SKILL.md, or something it links to (detail-04.md, references/x.md).
  const [file, setFile] = useState<string>("SKILL.md");
  const [files, setFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [byUse, setByUse] = useState(true);

  const total = (s: Skill) => Object.values(s.usage ?? {}).reduce((a, b) => a + b, 0);
  const improve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.skillImprove(14);
      try { await navigator.clipboard.writeText(r.command); onDone("启动命令已复制：在终端粘贴运行，Agent 会按最近 14 天的会话审查并改进常用技能"); }
      catch { onDone("剪贴板不可用；命令：" + r.command.slice(0, 120) + "…"); }
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  const load = async () => { if (blocked) { setSkills([]); setLoaded(true); return; } try { setSkills(parseJson<Skill[]>(await api.on(host, ["skills", "list", "--json"]), [])); setLoaded(true); } catch (e) { onError(String(e)); } };
  useEffect(() => { setSel(null); load(); }, [api, host, blocked]);
  useEffect(() => { setFile("SKILL.md"); }, [sel]);
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setDraft(null); setContent("");
    api.on(host, ["skills", "show", sel, "--file", file]).then((c) => { if (alive) setContent(c); }).catch((e) => onError(String(e)));
    api.on(host, ["skills", "show", sel, "--json"]).then((j) => { if (alive) setFiles(parseJson<{ files?: string[] }>(j, {}).files ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, [sel, file, api]);
  // A relative link inside the markdown stays inside the skill folder.
  const follow = (href: string) => { const clean = href.split("#")[0]; if (!clean) return; const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : ""; const parts = (base + clean).split("/").filter((p) => p && p !== "."); const out: string[] = []; for (const p of parts) { if (p === "..") out.pop(); else out.push(p); } setFile(out.join("/") || "SKILL.md"); };

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const rows = skills.filter((s) => (!only || s.agents[only]) && (!qq || s.name.toLowerCase().includes(qq) || s.description.toLowerCase().includes(qq)));
    return byUse ? [...rows].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name)) : rows;
  }, [skills, q, only, byUse]);
  useEffect(() => { if (sel === null && items.length > 0) setSel(items[0].name); }, [items, sel]);
  const cur = skills.find((s) => s.name === sel) ?? null;
  const counts = AGENTS.map((a) => ({ ...a, n: skills.filter((s) => s.agents[a.id]).length }));

  const toggle = async (s: Skill, agent: string) => {
    if (busy) return;
    setBusy(true);
    try { const msg = await api.on(host, ["skills", s.agents[agent] ? "disable" : "enable", s.name, "--agent", agent]); onDone(msg.split("\n")[0] || "已更新"); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  // Right-click on a skill: open, mount/unmount, reveal, copy, trash. The view menu adds
  // the page-level actions.
  useItemMenu("skill", (name) => {
    const s = skills.find((x) => x.name === name);
    if (!s) return null;
    const on = (agent: string) => api.on(host, ["skills", s.agents[agent] ? "disable" : "enable", s.name, "--agent", agent]).then((m) => { onDone(m.split("\n")[0] || "已更新"); return load(); }).catch((e) => onError(String(e)));
    return { title: s.name, items: [
      { label: "查看", onClick: () => setSel(s.name) },
      { label: s.agents.claude ? "从 Claude Code 卸载" : "挂给 Claude Code", onClick: () => on("claude") },
      { label: s.agents.codex ? "从 Codex 卸载" : "挂给 Codex", onClick: () => on("codex") },
      "-",
      ...(host === "local" ? [
        { label: "用编辑器打开", onClick: () => api.on(host, ["skills", "open", s.name]).catch((e) => onError(String(e))) },
        { label: "在访达中打开", onClick: () => api.on(host, ["skills", "open", s.name, "--reveal"]).catch((e) => onError(String(e))) },
      ] : []),
      { label: "复制路径", onClick: () => api.copy(s.path).then(() => onDone("路径已复制")) },
      { label: "复制 SKILL.md 内容", onClick: () => api.on(host, ["skills", "show", s.name]).then((c) => api.copy(c)).then(() => onDone("内容已复制")).catch((e) => onError(String(e))) },
      "-",
      { label: s.in_pool ? "移到废纸篓" : "卸载挂载（本体不在池里）", danger: true, onClick: () => api.on(host, ["skills", "trash", s.name]).then((m) => { onDone(m.trim().split("\n")[0]); if (sel === s.name) setSel(null); return load(); }).catch((e) => onError(String(e))) },
    ] };
  }, [skills, host, sel, api]);
  useViewMenuExtras([
    { label: "刷新技能列表", onClick: () => void load() },
    { label: "按最近工作流改进技能", onClick: () => void improve() },
    ...(host === "local" ? [{ label: "在访达中打开技能池", onClick: () => api.openPath(skills.find((s) => s.in_pool)?.path.replace(/\/[^/]+$/, "") || "").catch((e) => onError(String(e))) }] : []),
  ], [host, skills.length]);

  const save = async () => {
    if (!sel || draft === null) return;
    setBusy(true);
    try { await api.on(host, ["skills", "write", sel, "--file", file], draft); setContent(draft); setDraft(null); onDone(`${file} 已保存（旧版本留在 .bak）`); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="sk-wrap">
      <HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={setHost} />
      {blocked && <div className="empty" style={{ gridColumn: "1 / -1" }}>{blocked}</div>}
      <div className="sk-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="搜技能名、描述…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views" style={{ marginTop: 6 }}>
            <button className={only === "" ? "on" : ""} onClick={() => setOnly("")}>全部 {skills.length}</button>
            {counts.map((a) => <button key={a.id} className={only === a.id ? "on" : ""} onClick={() => setOnly(a.id)}>{a.label} {a.n}</button>)}
          </div>
          <div className="views" style={{ marginTop: 6 }}>
            <button className={byUse ? "on" : ""} onClick={() => setByUse(!byUse)} title="按各 Agent 的调用次数排序（来自会话索引；Codex / ZCode 不记录技能调用）">按使用频次</button>
            <button className="primary" disabled={busy} onClick={improve} title="生成一条 Agent 任务：回看最近 14 天的会话，审查并改进最常用的技能">✦ 按最近工作流改进技能</button>
          </div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">读取技能池…</div>}
          {items.map((s) => (
            <button key={s.name} data-menu="skill" data-id={s.name} className={`sk-item${sel === s.name ? " sel" : ""}`} onClick={() => setSel(s.name)}>
              <div className="l1"><span className="t mono">{s.name}</span>{!s.in_pool && <span className="muted small" title={`不在共享技能池 ~/.cc-switch/skills 里，只装在这一处：${s.path}`}>只装在一处</span>}<span className="spacer" />{total(s) > 0 && <span className="use mono" title={"调用次数（C=Claude Code，X=Codex）：" + Object.entries(s.usage ?? {}).map(([a, n]) => `${a} ${n} 次`).join("，") + (s.last_used ? `，最近 ${s.last_used}` : "")}>{Object.entries(s.usage ?? {}).map(([a, n]) => `${a === "claude-code" ? "C" : a === "codex" ? "X" : a[0].toUpperCase()} ${n} 次`).join(" · ")}</span>}</div>
              <div className="l2">{s.description || <span className="muted">（没有描述）</span>}</div>
              <div className="l3">{AGENTS.map((a) => <span key={a.id} className={`mount ${a.cls}${s.agents[a.id] ? " on" : ""}`}>{a.label}</span>)}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="sess-main">
        {!cur && <div className="empty">技能池在 <span className="mono">~/.cc-switch/skills</span>（{skills.filter((s) => s.in_pool).length} 个）。左边选一个：看它给哪些 Agent 挂着、读/改 SKILL.md。Agent 自己也能用 <span className="mono">dispatch skills</span> 做同样的事。</div>}
        {cur && (
          <>
            <div className="sess-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ttl mono">{cur.name}</div>
                <div className="sub mono">{cur.path.replace(/^\/Users\/[^/]+/, "~")}/{file !== "SKILL.md" ? <><button className="link mono" onClick={() => setFile("SKILL.md")}>SKILL.md</button> › {file}</> : "SKILL.md"}</div>
              </div>
              {host === "local" && <button className="btn sm" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file, "--reveal"]).catch((e) => onError(String(e)))} title="在访达里显示这个文件所在的技能目录">在访达中打开</button>}
              {host === "local" && <button className="btn sm" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file]).catch((e) => onError(String(e)))}>用编辑器打开</button>}
              {draft === null ? <button className="btn primary sm" onClick={() => setDraft(content)}>在这里改</button> : (
                <>
                  <button className="btn ghost sm" onClick={() => setDraft(null)}>放弃</button>
                  <button className="btn primary sm" disabled={busy || draft === content} onClick={save}>保存 ⌘S</button>
                </>
              )}
            </div>
            <div className="sk-mounts">
              {AGENTS.map((a) => (
                <label key={a.id} className={`mount-row ${a.cls}`}>
                  <input type="checkbox" checked={!!cur.agents[a.id]} disabled={busy} onChange={() => toggle(cur, a.id)} />
                  <span className={`av ${a.cls}`}>{a.id === "claude" ? "C" : "X"}</span>
                  <span>{a.label} {cur.agents[a.id] ? "可用" : "未挂载"}</span>
                  <span className="muted small mono">{(cur.mounts?.[a.id] ?? (a.id === "claude" ? "~/.claude/skills" : "~/.codex/skills")).replace(/^\/Users\/[^/]+/, "~")}</span>
                </label>
              ))}
              <span className="muted small">挂载 = 软链到 Agent 的技能目录；新会话生效。卸载只删软链，本体不动。</span>
            </div>
            <div className="sess-body">
              {draft === null ? (() => {
                if (!content) return <div className="empty">读取中…</div>;
                const { meta, body } = splitFrontmatter(content);
                return (
                  <>
                    {meta.length > 0 && <div className="fm">{meta.map(([k, v]) => <><b key={k + "k"}>{k}</b><span key={k + "v"}>{v}</span></>)}</div>}
                    <Markdown src={body} onRelativeLink={follow} />
                    {files.length > 1 && <details className="skill-files"><summary className="muted small">这个技能的文件 · {files.length}</summary>{files.map((f) => <button key={f} className={`link mono small${f === file ? " on" : ""}`} onClick={() => setFile(f)}>{f}</button>)}</details>}
                  </>
                );
              })() : (
                <textarea className="skill-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } if (e.key === "Escape") setDraft(null); }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
