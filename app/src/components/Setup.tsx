import { useEffect, useState } from "react";
import type { Api } from "../api";

// The first-run guide. Every card is one `dispatch init` step; the CLI owns the
// logic, this page only shows state and presses buttons. 跳过 marks the guide done
// so it never comes back unless asked for from 设置.

interface Dep { name: string; found: boolean; path: string; formula: string | null; why: string; required: boolean; installable: boolean }
interface AgentRow { id: string; name: string; found: boolean; home: string; hooks: boolean | null; rules: boolean }
interface Step { id: string; title: string; ok: boolean; detail: string; optional?: boolean; deps?: Dep[]; reviewers?: { id: string; kind: string; name: string }[]; cli?: { link: string; exists: boolean; target: string; in_app: boolean }; board?: { exists: boolean; server_up: boolean; hub?: { name: string; ssh: string } | null; mode: string }; agents?: AgentRow[]; rules?: { have_rules: boolean; targets: { agent: string; state: string; path: string }[]; seeded_from: string } }
export interface InitStatus { done: boolean; skipped: boolean; all_ok: boolean; machine: { name: string; user: string; tailscale_ip: string; lan_ip: string }; steps: Step[]; state: Record<string, unknown> }

const parse = <T,>(s: string): T => { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); };

export function SetupView({ api, status, onStatus, onDone, onError, onNotify }: { api: Api; status: InitStatus; onStatus: (s: InitStatus) => void; onDone: () => void; onError: (m: string) => void; onNotify: (m: string) => void }) {
  const [busy, setBusy] = useState<string>("");
  const [boardMode, setBoardMode] = useState<"first" | "join">("first");
  const [hub, setHub] = useState("");
  const [hubPassword, setHubPassword] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [log, setLog] = useState<Record<string, string>>({});
  const [reviewer, setReviewer] = useState<string>("");
  const step = (id: string) => status.steps.find((s) => s.id === id)!;
  const refresh = async () => { try { onStatus(parse<InitStatus>(await api.on("local", ["init", "status", "--json"]))); } catch (e) { onError(String(e)); } };
  const run = async (id: string, args: string[], label: string) => {
    setBusy(id);
    try {
      const out = await api.on("local", ["init", "run", id, ...args, "--json"]);
      let r: Record<string, unknown> = {};
      try { r = parse(out); } catch { r = { raw: out }; }
      if (r.error) { setLog((l) => ({ ...l, [id]: String(r.error) })); onError(String(r.error)); }
      else { setLog((l) => ({ ...l, [id]: summarize(id, r) })); onNotify(label); }
      await refresh();
    } catch (e) { setLog((l) => ({ ...l, [id]: String(e) })); onError(String(e)); }
    finally { setBusy(""); }
  };
  const agents = step("agents").agents ?? [];
  useEffect(() => { if (picked === null && agents.length) setPicked(agents.filter((a) => a.found).map((a) => a.id)); }, [agents, picked]);
  const deps = step("deps").deps ?? [];
  const missing = deps.filter((d) => !d.found && d.required);
  const brewMissing = deps.some((d) => d.name === "brew" && !d.found);
  const board = step("board").board;
  const rules = step("rules").rules;
  const m = status.machine;

  return (
    <div className="setup">
      <header className="setup-head">
        <div>
          <h2>欢迎使用 Dispatch</h2>
          <p>这台电脑：<b>{m.name}</b>{m.tailscale_ip ? ` · Tailscale ${m.tailscale_ip}` : m.lan_ip ? ` · 局域网 ${m.lan_ip}` : ""}。按顺序走完下面几步，Agent 就能用同一块任务板、同一份规则。每一步都能重跑。</p>
        </div>
        <div className="setup-head-actions">
          <button className="btn" onClick={() => void refresh()}>重新检测</button>
          <button className="btn ghost" title="以后不再显示这个指引；设置页里可以再打开" onClick={async () => { try { await api.on("local", ["init", "skip", "--json"]); onNotify("已跳过首次设置，设置页可以再打开"); onDone(); } catch (e) { onError(String(e)); } }}>跳过，以后不再提示</button>
        </div>
      </header>

      <ol className="setup-steps">
        <Card n={1} s={step("deps")} busy={busy === "deps"}>
          <ul className="setup-deps">{deps.map((d) => <li key={d.name} className={d.found ? "ok" : d.required ? "miss" : "opt"}><span className="mark">{d.found ? "✓" : d.required ? "✗" : "·"}</span><b className="mono">{d.name}</b><span className="muted">{d.why}</span></li>)}</ul>
          {brewMissing && <p className="setup-note">Homebrew 要在终端里装（会要管理员密码）。打开「终端」粘贴这一行，装完回来点「重新检测」：<code>/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"</code><button className="btn sm" onClick={() => api.copy('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"').then(() => onNotify("已复制"))}>复制</button></p>}
          {!brewMissing && missing.length > 0 && <button className="btn primary" disabled={!!busy} onClick={() => void run("deps", missing.map((d) => d.name), "依赖装好了")}>{busy === "deps" ? "安装中…（可能要几分钟）" : `装上 ${missing.map((d) => d.name).join("、")}`}</button>}
          {!deps.find((d) => d.name === "tailscale")?.found && <p className="muted small">Tailscale 可选：两台电脑不在同一个 Wi‑Fi 时才需要。<button className="link" onClick={() => api.openPath("https://tailscale.com/download/mac").catch(() => {})}>下载页 ↗</button></p>}
          {log.deps && <pre className="setup-log">{log.deps}</pre>}
        </Card>

        <Card n={2} s={step("cli")} busy={busy === "cli"}>
          <p className="muted">在终端里能直接敲 <code>dispatch</code>；Agent 的 hook 也靠它。指向的是应用自带的 CLI，更新应用就一起更新。</p>
          {!step("cli").ok && <button className="btn primary" disabled={!!busy} onClick={() => void run("cli", [], "终端命令已就绪")}>建立 dispatch 命令</button>}
          {log.cli && <pre className="setup-log">{log.cli}</pre>}
        </Card>

        <Card n={3} s={step("board")} busy={busy === "board"}>
          {board?.exists ? <p className="muted">{board.hub ? `已接入 ${board.hub.name}（${board.hub.ssh}），每 2 分钟双向同步。` : "任务板在这台电脑上；别的电脑接入时填这台的地址。"}</p> : <>
            <div className="setup-choice">
              <label className={boardMode === "first" ? "on" : ""}><input type="radio" name="board" checked={boardMode === "first"} onChange={() => setBoardMode("first")} /><b>只有这一台，或这是第一台</b><span>在这里新建任务板，这台成为其他电脑接入的枢纽</span></label>
              <label className={boardMode === "join" ? "on" : ""}><input type="radio" name="board" checked={boardMode === "join"} onChange={() => setBoardMode("join")} /><b>已有一台电脑装了 Dispatch</b><span>接入它的任务板，两边同一份任务</span></label>
            </div>
            {boardMode === "join" && <div className="setup-join">
              <input placeholder="那台电脑的 ssh 地址，如 name@100.x.y.z" value={hub} onChange={(e) => setHub(e.target.value)} />
              <input type="password" placeholder="那台电脑的登录密码（只用一次，不保存；已能免密可留空）" value={hubPassword} onChange={(e) => setHubPassword(e.target.value)} autoComplete="off" />
              <p className="muted small">前提：那台电脑已经跑过首次设置，并打开了「远程登录」（系统设置 → 通用 → 共享）。填上密码，Dispatch 会把这台的公钥放过去，之后两边免密互访；不想给密码也可以交给本机 Agent 在终端里做。</p>
              <button className="btn" disabled={!!busy || !hub.trim()} onClick={() => void run("helper", ["ssh", hub.trim()], "已交给本机 Agent，去会话页看进度")}>让本机 Agent 代劳</button>
            </div>}
            <button className="btn primary" disabled={!!busy || (boardMode === "join" && !hub.trim())} onClick={async () => { if (boardMode === "join" && hubPassword) { setBusy("board"); try { const out = await api.on("local", ["init", "run", "ssh-key", hub.trim(), "--json"], hubPassword); const r = parse<{ error?: string }>(out); if (r.error) { onError(r.error); setLog((l) => ({ ...l, board: r.error! })); return; } setHubPassword(""); } catch (e) { onError(String(e)); return; } finally { setBusy(""); } } void run("board", boardMode === "first" ? ["first"] : ["join", hub.trim()], boardMode === "first" ? "任务板已建立" : "已接入任务板"); }}>{busy === "board" ? "处理中…" : boardMode === "first" ? "新建任务板" : "打通并接入"}</button>
          </>}
          {log.board && <pre className="setup-log">{log.board}</pre>}
        </Card>

        <Card n={4} s={step("agents")} busy={busy === "agents"}>
          <p className="muted">检测到已安装的 Agent。选中的会收到同一份规则；Claude Code 还会装上 hook（会话状态、任务板摘要、编辑互斥、额度）。</p>
          <div className="setup-agents">{agents.map((a) => <label key={a.id} className={a.found ? "" : "off"}><input type="checkbox" checked={picked?.includes(a.id) ?? false} onChange={(e) => setPicked((p) => e.target.checked ? [...(p ?? []), a.id] : (p ?? []).filter((x) => x !== a.id))} /><b>{a.name}</b><span className="muted small">{a.found ? (a.hooks ? "hook 已装" : a.home.replace(/^\/Users\/[^/]+/, "~")) : "未安装"}</span></label>)}</div>
          <button className="btn primary" disabled={!!busy || !(picked?.length)} onClick={() => void run("agents", picked ?? [], "Agent 已配置")}>{busy === "agents" ? "配置中…" : "就用这些"}</button>
          {log.agents && <pre className="setup-log">{log.agents}</pre>}
        </Card>

        <Card n={5} s={step("rules")} busy={busy === "rules"}>
          <p className="muted">{board?.hub ? `从 ${board.hub.name} 复制 GLOBAL.md 和技能池，再同步到这里的每个 Agent。` : rules?.have_rules ? "已有 ~/.agents/rules/GLOBAL.md，同步到每个 Agent。" : "还没有共同规则：有 CLAUDE.md / AGENTS.md 就导入它作为起点，没有就用一份精简模板。"}</p>
          {rules?.targets?.length ? <ul className="setup-deps">{rules.targets.map((t) => <li key={t.agent} className={t.state === "synced" ? "ok" : "opt"}><span className="mark">{t.state === "synced" ? "✓" : "·"}</span><b>{t.agent}</b><span className="muted mono small">{t.path.replace(/^\/Users\/[^/]+/, "~")} · {t.state}</span></li>)}</ul> : null}
          <button className="btn primary" disabled={!!busy} onClick={() => void run("rules", [], "规则与技能已同步")}>{busy === "rules" ? "同步中…" : step("rules").ok ? "再同步一次" : "准备规则并同步"}</button>
          {log.rules && <pre className="setup-log">{log.rules}</pre>}
        </Card>

        <Card n={6} s={step("review")} busy={busy === "review"}>
          <p className="muted">派一个 Agent 审查这台电脑上所有 Agent 共用的规则和技能：先做减法（删掉为老模型补的行为规则、逐步菜谱、和全局重复的内容），保留架构约束、安全边界和项目知识，然后直接改好并同步。一台电脑也值得做一次。</p>
          <div className="setup-row">
            {(() => { const list = ((step("review") as unknown as { agents?: { id: string; kind: string; name: string }[] }).agents) ?? []; const cur = reviewer || list[0]?.kind || ""; return list.length > 0 ? <select className="sess-agent" value={cur} onChange={(e) => setReviewer(e.target.value)} aria-label="用哪个 Agent 审查">{list.map((a) => <option key={a.kind} value={a.kind}>{a.name}</option>)}</select> : <span className="muted small">没有检测到带命令行的 Agent（Claude Code / Codex / pi / Gemini CLI / OpenCode）</span>; })()}
            <button className="btn primary" disabled={!!busy} onClick={() => { const list = ((step("review") as unknown as { agents?: { kind: string }[] }).agents) ?? []; void run("review", [reviewer || list[0]?.kind || "claude"], "已派 Agent 审查"); }}>{busy === "review" ? "启动中…" : "派它审查并优化"}</button>
            <button className="btn" onClick={async () => { try { const r = parse<{ prompt: string }>(await api.on("local", ["init", "run", "review", "--json"])); await api.copy(r.prompt); onNotify("审查提示词已复制，发给任意 Agent 即可"); } catch (e) { onError(String(e)); } }}>复制提示词</button>
          </div>
          {log.review && <pre className="setup-log">{log.review}</pre>}
        </Card>
      </ol>

      <footer className="setup-foot">
        <button className="btn primary" disabled={!status.steps.filter((s) => !s.optional).every((s) => s.ok)} onClick={async () => { try { await api.on("local", ["init", "finish", "--json"]); onNotify("设置完成"); onDone(); } catch (e) { onError(String(e)); } }}>完成，进入工作台</button>
        <span className="muted small">{status.steps.filter((s) => !s.optional).every((s) => s.ok) ? "都就绪了。" : "必做的几步都打勾后才能完成；也可以右上角跳过。"}</span>
      </footer>
    </div>
  );
}

function Card({ n, s, busy, children }: { n: number; s: Step; busy: boolean; children: React.ReactNode }) {
  return <li className={`setup-card${s.ok ? " ok" : ""}${busy ? " busy" : ""}`}>
    <header><span className={`setup-n${s.ok ? " ok" : ""}`}>{s.ok ? "✓" : n}</span><h3>{s.title}{s.optional && <span className="muted small"> · 可选</span>}</h3><span className="muted small">{s.detail}</span></header>
    <div className="setup-body">{children}</div>
  </li>;
}

function summarize(id: string, r: Record<string, unknown>): string {
  try {
    if (id === "deps") { const f = (r.failed as { name: string; error: string; command?: string }[]) ?? []; return [...((r.installed as string[]) ?? []).map((n) => `✓ ${n}`), ...f.map((x) => `✗ ${x.name}：${x.error}${x.command ? `\n  终端里跑：${x.command}` : ""}`)].join("\n"); }
    if (id === "board") { return r.remote_for_others ? `其他电脑接入时用：${r.remote_for_others}` : r.hub ? `已接入 ${(r.hub as { name: string }).name}` : JSON.stringify(r); }
    if (id === "rules") { const s = r.sync as { targets?: { agent: string; state: string }[]; results?: { agent: string; action: string }[] } | undefined; const rows = s?.results ?? s?.targets; return `来源：${r.seed_label ?? r.seed}` + (rows ? "\n" + rows.map((t) => `${t.agent}: ${"action" in t ? t.action : (t as { state: string }).state}`).join("，") : ""); }
    if (id === "agents") { const inst = (r.installed as Record<string, { note?: string; error?: string; mode?: string }>) ?? {}; const hooks = Object.keys(inst).filter((k) => k !== "herdr"); const h = inst.herdr; return `已选：${((r.agents as string[]) ?? []).join("、")}` + (hooks.length ? `\n已装 hook：${hooks.join("、")}` : "") + (h ? `\nHerdr：${h.error ? "没起来（" + h.error + "）" : h.note}` : ""); }
    if (id === "helper") { return r.started ? "Agent 已在 Herdr 里开始处理，会话页能看到它；需要输密码时它会提醒" : `没起成：${r.error}\n可以把这段发给任意 Agent：\n${r.prompt}`; }
    if (id === "review") { return r.started ? "Agent 已在 Herdr 里开始审查，会话页能看到它" : `没起成：${r.error}\n提示词已在上面「复制提示词」`; }
    return JSON.stringify(r, null, 1).slice(0, 600);
  } catch { return ""; }
}
