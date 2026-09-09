import { useEffect, useState } from "react";
import type { DispatchSettings } from "../projectFlags";
import { isTauri } from "../api";
type Theme = "light" | "dark" | "";
interface Props { settings: DispatchSettings; onSave: (next: DispatchSettings) => Promise<void>; theme: Theme; onTheme: (t: Theme) => void; summaryProviders?: { id: string; label: string }[]; onPhone?: () => void; onScreen?: () => void; screenReady?: boolean; hosts?: { name: string; online: boolean; local: boolean; ip: string }[]; onSetup?: () => void; update?: UpdateInfo | null; onCheckUpdate?: () => Promise<void>; onApplyUpdate?: () => Promise<void> }
export interface UpdateInfo { current: string; latest: string; newer?: boolean; url: string; error?: string; needs_token?: boolean; notes?: string }

// The few knobs that change how the workbench reads. Shared through the board
// (`dispatch settings`), so both Macs agree.
export function SettingsView({ settings, onSave, theme, onTheme, summaryProviders = [], onPhone, onScreen, screenReady, hosts = [], onSetup, update, onCheckUpdate, onApplyUpdate }: Props) {
  const [checking, setChecking] = useState(false);
  // The version line should not read "v…" forever: look it up once when the page opens.
  useEffect(() => { if (!update && onCheckUpdate) { setChecking(true); void Promise.resolve(onCheckUpdate()).finally(() => setChecking(false)); } }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [applying, setApplying] = useState(false);
  const [draft, setDraft] = useState<DispatchSettings>(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(settings); }, [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const num = (k: keyof DispatchSettings, v: string, max: number) => setDraft({ ...draft, [k]: Math.max(0, Math.min(max, Number(v) || 0)) });
  const save = async () => { setBusy(true); try { await onSave(draft); } finally { setBusy(false); } };
  return (
    <div className="settings">
      <section className="settings-card">
        <h3>会话</h3>
        <label className="settings-row">
          <div><b>普通会话多少天没有活动后自动归档</b><p>收藏（追踪中）的会话不受影响；归档的会话在会话页「已归档」和 ⌘K 里还能找到。填 0 表示永不自动归档。</p></div>
          <span className="settings-num"><input type="number" min={0} max={3650} value={draft.session_archive_days} onChange={(e) => num("session_archive_days", e.target.value, 3650)} /> 天</span>
        </label>
        <label className="settings-row">
          <div><b>自动给会话写总结</b><p>一轮结束后由模型写一段 120 字的总结，工作台、项目页、会话页都显示它；以前的会话也会逐步补上（每次几段，从最近的往前）。关掉后仍可在会话上手动点「用模型总结」。</p></div>
          <input type="checkbox" checked={draft.summary_auto} onChange={(e) => setDraft({ ...draft, summary_auto: e.target.checked })} />
        </label>
        <label className="settings-row">
          <div><b>总结用的模型</b><p>Claude 走你的订阅，不用 Key，但计入用量；API Key 的来自「环境」页里配的密钥。空着就自动选：设置 → 环境变量 SUMMARY_MODEL → 第一个可用的。</p></div>
          <select value={draft.summary_model} onChange={(e) => setDraft({ ...draft, summary_model: e.target.value })} aria-label="总结用的模型"><option value="">自动</option>{summaryProviders.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}{draft.summary_model && !summaryProviders.some((p) => p.id === draft.summary_model) && <option value={draft.summary_model}>{draft.summary_model}（当前不可用）</option>}</select>
        </label>
        <label className="settings-row">
          <div><b>脚本或其他 Agent 通过 SDK 启动的会话，自动当作定时会话</b><p>定时会话不进「等我」、不发通知、不出现在工作台；会话页「定时」筛选里能看到。对单条会话手动标记过的，以手动为准。</p></div>
          <input type="checkbox" checked={draft.sdk_sessions_scheduled} onChange={(e) => setDraft({ ...draft, sdk_sessions_scheduled: e.target.checked })} />
        </label>
      </section>
      <section className="settings-card">
        <h3>项目</h3>
        <label className="settings-row">
          <div><b>工作区根目录</b><p>这些文件夹的直接子文件夹各算一个项目（例如 ~/Projects/kanban 下的会话都归 kanban）。其它位置按 git 仓库根目录归项目，没有仓库就按所在文件夹。一行一个。</p></div>
          <textarea className="settings-text" rows={3} value={draft.workspace_roots.join("\n")} onChange={(e) => setDraft({ ...draft, workspace_roots: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} placeholder="~/Projects" />
        </label>
        <p className="muted small" style={{ margin: "0 0 8px" }}>有任务、有成果、或手动关联过的才算正式项目；其余只是「目录」，在项目页底部的「其他目录与未归类」里。</p>
      </section>
      <section className="settings-card">
        <h3>工作台</h3>
        <label className="settings-row">
          <div><b>默认展开前几个项目</b><p>其余项目折叠成一行摘要，点一下展开。有等你回复或等待确认的项目总是展开。</p></div>
          <span className="settings-num"><input type="number" min={0} max={50} value={draft.home_expanded} onChange={(e) => num("home_expanded", e.target.value, 50)} /> 个</span>
        </label>
      </section>
      <section className="settings-card">
        <h3>这台电脑</h3>
        <label className="settings-row">
          <div><b>外观</b><p>只影响这台电脑上的 Dispatch 窗口。</p></div>
          <select value={theme} onChange={(e) => onTheme(e.target.value as Theme)} aria-label="外观"><option value="">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>
        </label>
        {onPhone && <div className="settings-row">
          <div><b>手机访问</b><p>复制 dispatch serve 的链接；手机连上 Tailscale 后用浏览器打开，可以添加到主屏幕。</p></div>
          <button className="btn sm" onClick={onPhone}>复制链接</button>
        </div>}
        {onScreen && <div className="settings-row">
          <div><b>屏幕访问</b><p>{screenReady ? "手机连上 Tailscale 后，用浏览器打开这个链接就能看到并操作这台电脑的屏幕（noVNC），登录用这台 Mac 的用户名和密码。" : "还没配置：先打开 系统设置 → 通用 → 共享 → 屏幕共享，再在 Agent 状态页按提示跑一次 novnc-setup；配好后这里能复制链接。"}</p></div>
          <button className="btn sm" disabled={!screenReady} onClick={onScreen}>复制屏幕链接</button>
        </div>}
        {onCheckUpdate && <div className="settings-row">
          <div><b>版本与更新</b><p>当前 v{update?.current ?? "…"}{update?.latest ? `，最新 v${update.latest}` : ""}{update?.newer ? "，有新版本" : update?.latest ? "，已是最新" : ""}。{update?.error ? update.error : isTauri ? "从 GitHub Release 下载并替换应用，完成后自动重启。" : "网页版只能查看版本；更新在 Mac 上的 Dispatch.app 里做。"}</p></div>
          <span className="setup-row">{update?.newer && !update.error && isTauri ? <button className="btn sm primary" disabled={applying} onClick={async () => { setApplying(true); try { await onApplyUpdate?.(); } finally { setApplying(false); } }}>{applying ? "更新中…" : `更新到 v${update.latest}`}</button> : null}<button className="btn sm" disabled={checking} onClick={async () => { setChecking(true); try { await onCheckUpdate(); } finally { setChecking(false); } }}>{checking ? "检查中…" : "检查更新"}</button></span>
        </div>}
        {onSetup && <div className="settings-row">
          <div><b>首次设置</b><p>装依赖、建或接入任务板、选 Agent、同步规则与技能。跳过过的可以从这里再打开，每一步都能重跑。</p></div>
          <button className="btn sm" onClick={onSetup}>打开首次设置</button>
        </div>}
        {hosts.length > 0 && <div className="settings-row">
          <div><b>机器</b><p>来自 ~/tasks/.dispatch/hosts.json；侧栏可按机器筛选。要加一台：在那台电脑上装 Dispatch，走首次设置时选「接入」并填这台的地址；或者在这台上「接入另一台」。</p></div>
          <span className="setup-row">{onSetup && <button className="btn sm" onClick={onSetup}>接入另一台电脑…</button>}{hosts.map((h) => <span key={h.name} className="host-chip" title={h.ip}>{h.online ? "● " : "○ "}{h.name}{h.local ? "（本机）" : ""}</span>)}</span>
        </div>}
      </section>
      <div className="settings-actions">
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
        {dirty && <button className="btn" disabled={busy} onClick={() => setDraft(settings)}>还原</button>}
        <span className="muted small">存在共享任务板上，两台 Mac 一致；命令行 <span className="mono">dispatch settings</span> 读写同一份。</span>
      </div>
    </div>
  );
}
