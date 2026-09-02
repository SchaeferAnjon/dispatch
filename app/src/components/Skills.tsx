import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Skill } from "../types";
import { Markdown, splitFrontmatter } from "./Markdown";

interface Props { api: Api; onDone: (m: string) => void; onError: (m: string) => void }

const AGENTS: { id: string; label: string; cls: string }[] = [
  { id: "claude", label: "Claude Code", cls: "claude" },
  { id: "codex", label: "Codex", cls: "codex" },
];

export function SkillsView({ api, onDone, onError }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<string>("");
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => { try { setSkills(await api.skills()); setLoaded(true); } catch (e) { onError(String(e)); } };
  useEffect(() => { load(); }, [api]);
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setDraft(null);
    api.skillRead(sel).then((c) => { if (alive) setContent(c); }).catch((e) => onError(String(e)));
    return () => { alive = false; };
  }, [sel, api]);

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return skills.filter((s) => (!only || s.agents[only]) && (!qq || s.name.toLowerCase().includes(qq) || s.description.toLowerCase().includes(qq)));
  }, [skills, q, only]);
  const cur = skills.find((s) => s.name === sel) ?? null;
  const counts = AGENTS.map((a) => ({ ...a, n: skills.filter((s) => s.agents[a.id]).length }));

  const toggle = async (s: Skill, agent: string) => {
    if (busy) return;
    setBusy(true);
    try { const msg = await api.skillToggle(s.name, agent, !s.agents[agent]); onDone(msg.split("\n")[0] || "已更新"); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!sel || draft === null) return;
    setBusy(true);
    try { await api.skillWrite(sel, draft); setContent(draft); setDraft(null); onDone("SKILL.md 已保存（旧版本留在 .md.bak）"); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="sk-wrap">
      <div className="sk-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="搜技能名、描述…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views" style={{ marginTop: 6 }}>
            <button className={only === "" ? "on" : ""} onClick={() => setOnly("")}>全部 {skills.length}</button>
            {counts.map((a) => <button key={a.id} className={only === a.id ? "on" : ""} onClick={() => setOnly(a.id)}>{a.label} {a.n}</button>)}
          </div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">读取技能池…</div>}
          {items.map((s) => (
            <button key={s.name} className={`sk-item${sel === s.name ? " sel" : ""}`} onClick={() => setSel(s.name)}>
              <div className="l1"><span className="t mono">{s.name}</span>{!s.in_pool && <span className="muted small" title={s.path}>池外</span>}</div>
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
                <div className="sub mono">{cur.path.replace(/^\/Users\/[^/]+/, "~")}/SKILL.md</div>
              </div>
              <button className="btn sm" onClick={() => api.skillOpen(cur.name)}>用编辑器打开</button>
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
                    <Markdown src={body} />
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
