import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../api";
import type { Host, Skill } from "../types";
import { hostReason } from "./HostPicker";
import { MenuItem, MenuPanel, useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { Markdown, splitFrontmatter } from "./Markdown";
import { useLocale, useT } from "../i18n";
import { Dropdown, EmptyView, ListDetail, Meta, Row, Sep, Tabs, Tag, useListKeyboard } from "./primitives";
import { DetailHead, SearchField, hostName, revealDetail } from "./PageParts";
import { useShellHeader } from "./Shell";
import { Icon } from "./icons";
import { tildePath } from "../activity";
import { dirname, isWindows } from "../platform";

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
  const [more, setMore] = useState<{ x: number; y: number; from: HTMLElement } | null>(null);

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

  const poolDir = (() => { const one = skills.find((x) => x.in_pool)?.path ?? ""; const dir = one ? dirname(one) : "~/.agents/skill-pool"; return tildePath(dir); })();

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
        { label: (isWindows ? t("在资源管理器中显示") : t("在访达中打开")), onClick: () => api.on(host, ["skills", "open", s.name, "--reveal"]).catch((e) => onError(String(e))) },
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
    ...(host === "local" ? [{ label: isWindows ? t("在资源管理器中显示技能池") : t("在访达中打开技能池"), onClick: () => api.openPath(dirname(skills.find((s) => s.in_pool)?.path ?? "")).catch((e) => onError(String(e))) }] : []),
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

  const where = hostName(hosts, host);
  const locale = useLocale();
  useShellHeader({
    subtitle: [where, loaded ? t("{n} 个技能", { n: skills.length }) : ""].filter(Boolean).join(" · "),
    // one main button in the header (DESIGN.md 页头); 改进技能 and 从 GitHub 导入 sit behind ⋯
    actions: <SkillsHeadActions disabled={busy || !!blocked} onNew={() => setNewOpen(true)} onMore={(el) => { const r = el.getBoundingClientRect(); setMore({ x: r.right - 250, y: r.bottom + 4, from: el }); }} />,
  }, [where, loaded, skills.length, busy, blocked, locale]);
  const ids = items.map((s) => s.name);
  useListKeyboard(ids, sel, setSel, { enabled: draft === null && !newOpen && !importOpen });
  const usageText = (s: Skill) => Object.entries(s.usage ?? {}).map(([a, n]) => t("{agent} {n} 次", { agent: a === "claude-code" ? "C" : a === "codex" ? "X" : a[0].toUpperCase(), n })).join(" · ");
  const usageTitle = (s: Skill) => t("调用次数（C=Claude Code，X=Codex）：") + Object.entries(s.usage ?? {}).map(([a, n]) => t("{agent} {n} 次", { agent: a, n })).join(t("，")) + (s.last_used ? t("，最近 {when}", { when: s.last_used }) : "");

  const tabs = (
    <Tabs items={[{ key: "", label: t("全部"), count: skills.length }, ...counts.map((a) => ({ key: a.id, label: a.label, count: a.n }))]} value={only} onChange={setOnly}
      right={<span className="ak-tools">
        <Dropdown label={t("排序")} value={byUse ? "use" : "name"} onChange={(v) => setByUse(v === "use")} options={[{ value: "use", label: t("按使用频次") }, { value: "name", label: t("按名称") }]} />
        <SearchField value={q} onChange={setQ} placeholder={t("搜技能名、描述…")} />
      </span>} />
  );

  const detail = cur ? (
    <div className="ak-detail">
      <DetailHead mono crumb={[t("技能"), tildePath(cur.path)]} title={cur.name}
        tag={!cur.in_pool ? <Tag color="orange" title={t("不在共享技能池 {pool} 里，只装在这一处：{path}", { pool: poolDir, path: cur.path })}>{t("只装在一处")}</Tag> : undefined}
        actions={draft === null ? <>
          <button className="btn sm" onClick={() => setDraft(content)}>{t("在这里改")}</button>
          {host === "local" && <button className="btn sm" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file]).catch((e) => onError(String(e)))}>{t("用编辑器打开")}</button>}
          {host === "local" && <button className="btn sm ghost" onClick={() => api.on(host, ["skills", "open", cur.name, "--file", file, "--reveal"]).catch((e) => onError(String(e)))} title={isWindows ? t("在资源管理器里显示这个文件所在的技能目录") : t("在访达里显示这个文件所在的技能目录")}>{(isWindows ? t("在资源管理器中显示") : t("在访达中打开"))}</button>}
        </> : <>
          <button className="btn sm primary" disabled={busy || draft === content} onClick={save}>{t("保存 {mod}S")}</button>
          <button className="btn sm ghost" onClick={() => setDraft(null)}>{t("放弃")}</button>
        </>} />
      <Meta rows={[
        ...AGENTS.map((a) => [a.label, <label className="ak-check" title={tildePath(cur.mounts?.[a.id] ?? (a.id === "claude" ? "~/.claude/skills" : "~/.codex/skills"))}>
          <input type="checkbox" checked={!!cur.agents[a.id]} disabled={busy} onChange={() => toggle(cur, a.id)} />
          <span>{cur.agents[a.id] ? t("可用") : t("未挂载")}</span>
          <span className="mono s">{tildePath(cur.mounts?.[a.id] ?? (a.id === "claude" ? "~/.claude/skills" : "~/.codex/skills"))}</span>
        </label>] as [ReactNode, ReactNode]),
        ...(total(cur) > 0 ? [[t("调用"), <span title={usageTitle(cur)}>{usageText(cur)}{cur.last_used ? ` · ${cur.last_used}` : ""}</span>] as [ReactNode, ReactNode]] : []),
        [t("文件"), file === "SKILL.md" ? "SKILL.md" : <span><button className="link mono" onClick={() => setFile("SKILL.md")}>SKILL.md</button> › <span className="mono">{file}</span></span>],
      ]} />
      <p className="akd-note">{t("挂载 = 软链到 Agent 的技能目录；新会话生效。卸载只删软链，本体不动。")}</p>
      <Sep />
      {draft === null ? (() => {
        if (!content) return <p className="akd-note">{t("读取中…")}</p>;
        const { meta, body } = splitFrontmatter(content);
        return (
          <>
            {meta.length > 0 && <div className="fm ak-fm">{meta.map(([k, v]) => <Fragment key={k}><b>{k}</b><span>{v}</span></Fragment>)}</div>}
            <div className="akd-md"><Markdown src={body} onRelativeLink={follow} /></div>
            {files.length > 1 && <details className="skill-files ak-fold"><summary>{t("这个技能的文件 · {n}", { n: files.length })}</summary>{files.map((f) => <button key={f} className={`link mono small${f === file ? " on" : ""}`} onClick={() => setFile(f)}>{f}</button>)}</details>}
          </>
        );
      })() : (
        <textarea className="akd-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={t("在这里改")}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } if (e.key === "Escape") setDraft(null); }} />
      )}
    </div>
  ) : null;

  return (
    <>
      <ListDetail className="ak-page ak-doc" tabs={tabs} detail={detail}>
        {blocked ? <EmptyView icon="star" title={t("连不上这台机器")} description={blocked} />
          : !loaded ? <p className="akd-note ak-pad">{t("读取技能池…")}</p>
          : items.length === 0 ? <EmptyView icon="star" title={q ? t("没有匹配的技能") : t("还没有技能")} description={t("技能池在 {pool}（{n} 个）。左边选一个：看它给哪些 Agent 挂着、读/改 SKILL.md。Agent 自己也能用 dispatch skills 做同样的事。", { pool: poolDir, n: skills.filter((s) => s.in_pool).length })} actions={!q && <button className="btn sm" onClick={() => setNewOpen(true)}>{t("新建技能")}</button>} />
          : items.map((s) => (
            <Row key={s.name} id={s.name} data-menu="skill" data-id={s.name} selected={sel === s.name} onClick={() => { if (draft === null) { setSel(s.name); revealDetail(); } }}
              icon={<Icon name="star" filled={sel === s.name} />} title={s.name} tooltip={s.description}
              accessories={[
                ...(!s.in_pool ? [<Tag color="orange">{t("只装在一处")}</Tag>] : []),
                <span className="ak-mounts" title={AGENTS.filter((a) => s.agents[a.id]).map((a) => a.label).join(" · ") || t("未挂载")}>{AGENTS.map((a) => <span key={a.id} className={`av sm ${a.cls}${s.agents[a.id] ? "" : " ak-unmounted"}`}>{a.id === "claude" ? "C" : "X"}</span>)}</span>,
                ...(total(s) > 0 ? [<span className="num" title={usageTitle(s)}>{total(s)}</span>] : []),
              ]} />
          ))}
      </ListDetail>
      {newOpen && <NewSkillDialog poolDir={poolDir} busy={busy} onCancel={() => setNewOpen(false)} onSave={createSkill} />}
      {importOpen && <ImportSkillDialog busy={busy} onCancel={() => setImportOpen(false)} onSave={importSkill} />}
      {more && <MenuPanel x={more.x} y={more.y} label={t("更多技能操作")} onClose={() => setMore(null)} returnTo={more.from}>
        <MenuItem disabled={busy} onClick={() => { setMore(null); void improve(); }}>{t("改进技能")}</MenuItem>
        <MenuItem disabled={busy || !!blocked} onClick={() => { setMore(null); setImportOpen(true); }}>{t("从 GitHub 导入")}</MenuItem>
      </MenuPanel>}
    </>
  );
}

/** The skills page header: 新建技能 is the one main button; 改进技能 and 从 GitHub 导入 open from ⋯. */
export function SkillsHeadActions({ disabled, onNew, onMore }: { disabled: boolean; onNew: () => void; onMore: (from: HTMLElement) => void }) {
  const t = useT();
  return <>
    <button className="btn sm" disabled={disabled} onClick={onNew} title={t("按 SKILL.md 模板建到技能池并挂给选中的 Agent")} aria-label={t("新建技能")}><Icon name="plus" size={14} /><span className="ak-hd-lbl">{t("新建技能")}</span></button>
    <button className="hd-icon" aria-haspopup="menu" aria-label={t("更多技能操作")} title={t("更多技能操作")} onClick={(e) => onMore(e.currentTarget)}><Icon name="more" /></button>
  </>;
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
          <button className="btn primary" disabled={!ok} onClick={submit}>{busy ? t("创建中…") : t("创建 {mod}⏎")}</button>
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
          <button className="btn primary" disabled={!ok} onClick={submit}>{busy ? t("导入中…") : t("导入 {mod}⏎")}</button>
        </div>
      </div>
    </div>
  );
}
