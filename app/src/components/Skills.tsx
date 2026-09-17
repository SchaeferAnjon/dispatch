import { Fragment,  useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Host, Skill } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { Markdown, splitFrontmatter } from "./Markdown";
import { useT } from "../i18n";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const AGENTS: { id: string; label: string; cls: string }[] = [
  { id: "claude", label: "Claude Code", cls: "claude" },
  { id: "codex", label: "Codex", cls: "codex" },
];

export function SkillsView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const t = useT();
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
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const total = (s: Skill) => Object.values(s.usage ?? {}).reduce((a, b) => a + b, 0);
  const improve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.skillImprove(14);
      try { await navigator.clipboard.writeText(r.command); onDone(t("启动命令已复制：在终端粘贴运行，Agent 会按最近 14 天的会话审查并改进常用技能")); }
      catch { onDone(t("剪贴板不可用；命令：{cmd}…", { cmd: r.command.slice(0, 120) })); }
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  const load = async () => { if (blocked) { setSkills([]); setLoaded(true); return; } try { setSkills(parseJson<Skill[]>(await api.on(host, ["skills", "list", "--json"]), [])); } catch (e) { onError(String(e)); } finally { setLoaded(true); } };
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

  // Where the shared pool is on that Mac: the CLI decides (cc-switch's folder when there is one, else ~/.agents/skill-pool).

  const poolDir = (() => { const one = skills.find((x) => x.in_pool)?.path ?? ""; const dir = one ? one.replace(/\/[^/]+\/?$/, "") : "~/.agents/skill-pool"; return dir.replace(/^\/(Users|home)\/[^/]+/, "~"); })();

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
    try { const msg = await api.on(host, ["skills", s.agents[agent] ? "disable" : "enable", s.name, "--agent", agent]); onDone(msg.split("\n")[0] || t("已更新")); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  // Right-click on a skill: open, mount/unmount, reveal, copy, trash. The view menu adds
  // the page-level actions.
  useItemMenu("skill", (name) => {
    const s = skills.find((x) => x.name === name);
    if (!s) return null;
    const on = (agent: string) => api.on(host, ["skills", s.agents[agent] ? "disable" : "enable", s.name, "--agent", agent]).then((m) => { onDone(m.split("\n")[0] || t("已更新")); return load(); }).catch((e) => onError(String(e)));
    return { title: s.name, items: [
      { label: t("查看"), onClick: () => setSel(s.name) },
      { label: s.agents.claude ? t("从 {agent} 卸载", { agent: "Claude Code" }) : t("挂给 {agent}", { agent: "Claude Code" }), onClick: () => on("claude") },
      { label: s.agents.codex ? t("从 {agent} 卸载", { agent: "Codex" }) : t("挂给 {agent}", { agent: "Codex" }), onClick: () => on("codex") },
      "-",
      ...(host === "local" ? [
        { label: t("用编辑器打开"), onClick: () => api.on(host, ["skills", "open", s.name]).catch((e) => onError(String(e))) },
        { label: t("在访达中打开"), onClick: () => api.on(host, ["skills", "open", s.name, "--reveal"]).catch((e) => onError(String(e))) },
      ] : []),
      { label: t("复制路径"), onClick: () => api.copy(s.path).then(() => onDone(t("路径已复制"))) },
      { label: t("复制 SKILL.md 内容"), onClick: () => api.on(host, ["skills", "show", s.name]).then((c) => api.copy(c)).then(() => onDone(t("内容已复制"))).catch((e) => onError(String(e))) },
      "-",
      { label: s.in_pool ? t("移到废纸篓") : t("卸载挂载（本体不在池里）"), danger: true, onClick: () => api.on(host, ["skills", "trash", s.name]).then((m) => { onDone(m.trim().split("\n")[0]); if (sel === s.name) setSel(null); return load(); }).catch((e) => onError(String(e))) },
    ] };
  }, [skills, host, sel, api]);
  useViewMenuExtras([
    { label: t("刷新技能列表"), onClick: () => void load() },
    { label: t("按最近工作流改进技能"), onClick: () => void improve() },
    ...(host === "local" ? [{ label: t("在访达中打开技能池"), onClick: () => api.openPath(skills.find((s) => s.in_pool)?.path.replace(/\/[^/]+$/, "") || "").catch((e) => onError(String(e))) }] : []),
  ], [host, skills.length]);

  const save = async () => {
    if (!sel || draft === null) return;
    setBusy(true);
    try { await api.on(host, ["skills", "write", sel, "--file", file], draft); setContent(draft); setDraft(null); onDone(t("{file} 已保存（旧版本留在 .bak）", { file })); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  // Create writes the SKILL.md template into the pool and mounts it; import pulls a public
  // repo (or a subdirectory of one) in. Both then reload the list and open the new skill.
  const createSkill = async (v: { name: string; description: string; trigger: string; constraint: string; agents: string[] }) => {
    if (busy) return;
    setBusy(true);
    try {
      const args = ["skills", "new", v.name, "--json"];
      if (v.description) args.push("--description", v.description);
      if (v.trigger) args.push("--trigger", v.trigger);
      if (v.constraint) args.push("--constraint", v.constraint);
      for (const ag of v.agents) args.push("--agent", ag);
      const res = parseJson<{ name?: string }>(await api.on(host, args), {});
      setNewOpen(false);
      await load();
      if (res.name) setSel(res.name);
      onDone(t("已新建 {name}", { name: res.name ?? v.name }) + (v.agents.length ? t("，已挂给 {agents}（新会话生效）", { agents: v.agents.join(" / ") }) : ""));
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  const importSkill = async (v: { url: string; name: string; path: string; agents: string[] }) => {
    if (busy) return;
    setBusy(true);
    try {
      const args = ["skills", "import", v.url, "--json"];
      if (v.name) args.push("--as", v.name);
      if (v.path) args.push("--path", v.path);
      for (const ag of v.agents) args.push("--agent", ag);
      const res = parseJson<{ name?: string; generated?: boolean }>(await api.on(host, args), {});
      setImportOpen(false);
      await load();
      if (res.name) setSel(res.name);
      onDone(t("已导入 {name}", { name: res.name ?? v.name }) + (res.generated ? t("（仓库里没有 SKILL.md，生成了待提炼的入口）") : "") + (v.agents.length ? t("，已挂给 {agents}（新会话生效）", { agents: v.agents.join(" / ") }) : ""));
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="sk-wrap">
      <HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={setHost} />
      {blocked && <div className="empty" style={{ gridColumn: "1 / -1" }}>{blocked}</div>}
      <div className="sk-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder={t("搜技能名、描述…")} value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views" style={{ marginTop: 6 }}>
            <button className={only === "" ? "on" : ""} onClick={() => setOnly("")}>{t("全部")} {skills.length}</button>
            {counts.map((a) => <button key={a.id} className={only === a.id ? "on" : ""} onClick={() => setOnly(a.id)}>{a.label} {a.n}</button>)}
          </div>
          <div className="views" style={{ marginTop: 6 }}>
            <button className={byUse ? "on" : ""} onClick={() => setByUse(!byUse)} title={t("按各 Agent 的调用次数排序（来自会话索引；Codex / ZCode 不记录技能调用）")}>{t("按使用频次")}</button>
            <button className="primary" disabled={busy} onClick={improve} title={t("生成一条 Agent 任务：回看最近 14 天的会话，审查并改进最常用的技能")}>{t("✦ 按最近工作流改进技能")}</button>
          </div>
          <div className="views" style={{ marginTop: 6 }}>
            <button disabled={busy || !!blocked} onClick={() => setNewOpen(true)} title={t("按 SKILL.md 模板建到技能池并挂给选中的 Agent")}>{t("＋ 新建技能")}</button>
            <button disabled={busy || !!blocked} onClick={() => setImportOpen(true)} title={t("从公开 GitHub 仓库（或它的子目录）导入一个技能")}>{t("从 GitHub 导入")}</button>
          </div>
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">{t("读取技能池…")}</div>}
          {items.map((s) => (
            <button key={s.name} data-menu="skill" data-id={s.name} className={`sk-item${sel === s.name ? " sel" : ""}`} onClick={() => setSel(s.name)}>
              <div className="l1"><span className="t mono">{s.name}</span>{!s.in_pool && <span className="muted small" title={t("不在共享技能池 {pool} 里，只装在这一处：{path}", { pool: poolDir, path: s.path })}>{t("只装在一处")}</span>}<span className="spacer" />{total(s) > 0 && <span className="use mono" title={t("调用次数（C=Claude Code，X=Codex）：") + Object.entries(s.usage ?? {}).map(([a, n]) => t("{agent} {n} 次", { agent: a, n })).join(t("，")) + (s.last_used ? t("，最近 {when}", { when: s.last_used }) : "")}>{Object.entries(s.usage ?? {}).map(([a, n]) => t("{agent} {n} 次", { agent: a === "claude-code" ? "C" : a === "codex" ? "X" : a[0].toUpperCase(), n })).join(" · ")}</span>}</div>
              <div className="l2">{s.description || <span className="muted">{t("（没有描述）")}</span>}</div>
              <div className="l3">{AGENTS.map((a) => <span key={a.id} className={`mount ${a.cls}${s.agents[a.id] ? " on" : ""}`}>{a.label}</span>)}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="sess-main">
        {!cur && <div className="empty">{t("技能池在 {pool}（{n} 个）。左边选一个：看它给哪些 Agent 挂着、读/改 SKILL.md。Agent 自己也能用 dispatch skills 做同样的事。", { pool: poolDir, n: skills.filter((s) => s.in_pool).length })}</div>}
        {cur && (
          <>
            <div className="sess-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ttl mono">{cur.name}</div>
                <div className="sub mono">{cur.path.replace(/^\/Users\/[^/]+/, "~")}/{file !== "SKILL.md" ? <><button className="link mono" onClick={() => setFile("SKILL.md")}>SKILL.md</button> › {file}</> : "SKILL.md"}</div>
              </div>
              {host === "local" && <button className="btn sm" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file, "--reveal"]).catch((e) => onError(String(e)))} title={t("在访达里显示这个文件所在的技能目录")}>{t("在访达中打开")}</button>}
              {host === "local" && <button className="btn sm" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file]).catch((e) => onError(String(e)))}>{t("用编辑器打开")}</button>}
              {draft === null ? <button className="btn primary sm" onClick={() => setDraft(content)}>{t("在这里改")}</button> : (
                <>
                  <button className="btn ghost sm" onClick={() => setDraft(null)}>{t("放弃")}</button>
                  <button className="btn primary sm" disabled={busy || draft === content} onClick={save}>{t("保存 ⌘S")}</button>
                </>
              )}
            </div>
            <div className="sk-mounts">
              {AGENTS.map((a) => (
                <label key={a.id} className={`mount-row ${a.cls}`}>
                  <input type="checkbox" checked={!!cur.agents[a.id]} disabled={busy} onChange={() => toggle(cur, a.id)} />
                  <span className={`av ${a.cls}`}>{a.id === "claude" ? "C" : "X"}</span>
                  <span>{a.label} {cur.agents[a.id] ? t("可用") : t("未挂载")}</span>
                  <span className="muted small mono">{(cur.mounts?.[a.id] ?? (a.id === "claude" ? "~/.claude/skills" : "~/.codex/skills")).replace(/^\/Users\/[^/]+/, "~")}</span>
                </label>
              ))}
              <span className="muted small">{t("挂载 = 软链到 Agent 的技能目录；新会话生效。卸载只删软链，本体不动。")}</span>
            </div>
            <div className="sess-body">
              {draft === null ? (() => {
                if (!content) return <div className="empty">{t("读取中…")}</div>;
                const { meta, body } = splitFrontmatter(content);
                return (
                  <>
                    {meta.length > 0 && <div className="fm">{meta.map(([k, v]) => <Fragment key={k}><b>{k}</b><span>{v}</span></Fragment>)}</div>}
                    <Markdown src={body} onRelativeLink={follow} />
                    {files.length > 1 && <details className="skill-files"><summary className="muted small">{t("这个技能的文件 · {n}", { n: files.length })}</summary>{files.map((f) => <button key={f} className={`link mono small${f === file ? " on" : ""}`} onClick={() => setFile(f)}>{f}</button>)}</details>}
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
      {newOpen && <NewSkillDialog poolDir={poolDir} busy={busy} onCancel={() => setNewOpen(false)} onSave={createSkill} />}
      {importOpen && <ImportSkillDialog busy={busy} onCancel={() => setImportOpen(false)} onSave={importSkill} />}
    </div>
  );
}

function AgentPicker({ agents, onToggle, busy }: { agents: string[]; onToggle: (id: string) => void; busy: boolean }) {
  const t = useT();
  return (
    <div className="skill-agents">
      <span className="muted small">{t("挂给")}</span>
      {AGENTS.map((a) => (
        <label key={a.id} className={`mount-row ${a.cls}`}>
          <input type="checkbox" checked={agents.includes(a.id)} disabled={busy} onChange={() => onToggle(a.id)} />
          <span className={`av ${a.cls}`}>{a.id === "claude" ? "C" : "X"}</span>
          <span>{a.label}</span>
        </label>
      ))}
    </div>
  );
}

const NAME_RE = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._-]*$/;

export function NewSkillDialog({ busy, onCancel, onSave, poolDir = "~/.agents/skill-pool" }: { busy: boolean; onCancel: () => void; poolDir?: string; onSave: (v: { name: string; description: string; trigger: string; constraint: string; agents: string[] }) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("");
  const [constraint, setConstraint] = useState("");
  const [agents, setAgents] = useState<string[]>(["claude"]);
  const ok = !busy && NAME_RE.test(name.trim());
  const toggle = (id: string) => setAgents((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const submit = () => ok && onSave({ name: name.trim(), description: description.trim(), trigger: trigger.trim(), constraint: constraint.trim(), agents });
  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onCancel()}>
      <div className="dialog skill-dialog" role="dialog" aria-modal="true" aria-label={t("新建技能")} onKeyDown={(e) => { if (e.key === "Escape" && !busy) onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>{t("新建技能")}</h3>
        <p className="skill-hint">{t("按 SKILL.md 模板建到技能池 {pool}，再挂给选中的 Agent。", { pool: poolDir })}</p>
        <div className="row two">
          <label>{t("技能名（目录名）")}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="code-review" spellCheck={false} /></label>
          <label>{t("一句话触发描述")}<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("用户要…时用。")} /></label>
        </div>
        <label>{t("触发条件")}<textarea value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder={t("用户明确要做…时用。")} /></label>
        <label>{t("关键约束")}<textarea value={constraint} onChange={(e) => setConstraint(e.target.value)} placeholder={t("先确认本机实际路径与命令；只写模型推不出来的内容。")} /></label>
        <AgentPicker agents={agents} onToggle={toggle} busy={busy} />
        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onCancel}>{t("取消")}</button>
          <button className="btn primary" disabled={!ok} onClick={submit}>{busy ? t("创建中…") : t("创建 ⌘⏎")}</button>
        </div>
      </div>
    </div>
  );
}

export function ImportSkillDialog({ busy, onCancel, onSave }: { busy: boolean; onCancel: () => void; onSave: (v: { url: string; name: string; path: string; agents: string[] }) => Promise<void> }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [agents, setAgents] = useState<string[]>(["claude"]);
  const ok = !busy && url.trim().length > 0 && (!name.trim() || NAME_RE.test(name.trim()));
  const toggle = (id: string) => setAgents((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const submit = () => ok && onSave({ url: url.trim(), name: name.trim(), path: path.trim(), agents });
  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onCancel()}>
      <div className="dialog skill-dialog" role="dialog" aria-modal="true" aria-label={t("从 GitHub 导入技能")} onKeyDown={(e) => { if (e.key === "Escape" && !busy) onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>{t("从 GitHub 导入技能")}</h3>
        <p className="skill-hint">{t("下载公开仓库，把里面的 SKILL.md 目录（或指定子目录）拷进技能池；仓库没有 SKILL.md 时按 skill-from-github 的思路生成待提炼的入口。来源和 LICENSE 一并记下。")}</p>
        <label>{t("仓库地址")}<input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("anthropics/skills 或 https://github.com/owner/repo/tree/main/skills/pdf")} spellCheck={false} /></label>
        <div className="row two">
          <label>{t("落到技能池的名字（可留空）")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("默认用 SKILL.md 里的 name")} spellCheck={false} /></label>
          <label>{t("仓库里的子目录（可留空）")}<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="skills/pdf" spellCheck={false} /></label>
        </div>
        <AgentPicker agents={agents} onToggle={toggle} busy={busy} />
        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onCancel}>{t("取消")}</button>
          <button className="btn primary" disabled={!ok} onClick={submit}>{busy ? t("导入中…") : t("导入 ⌘⏎")}</button>
        </div>
      </div>
    </div>
  );
}
