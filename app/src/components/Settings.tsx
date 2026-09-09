import { useEffect, useState } from "react";
import type { DispatchSettings } from "../projectFlags";
import { isTauri } from "../api";
import type { Host } from "../types";
type Theme = "light" | "dark" | "";
interface Props { settings: DispatchSettings; onSave: (next: DispatchSettings) => Promise<void>; theme: Theme; onTheme: (t: Theme) => void; summaryProviders?: { id: string; label: string }[]; onPhone?: () => void; phoneQr?: string; onScreen?: () => void; screenReady?: boolean; screen?: { url: string; up: boolean; sharing: boolean; issue: string }; onScreenSetup?: () => Promise<ScreenSetupResult | null>; hosts?: Host[]; onSetup?: () => void; onRenameHost?: (host: Host, name: string) => Promise<void>; onDeleteHost?: (host: Host) => Promise<void>; onRedetectHost?: (host: Host) => Promise<void>; onTestNotify?: () => Promise<void>; update?: UpdateInfo | null; onCheckUpdate?: () => Promise<void>; onApplyUpdate?: () => Promise<void> }
export interface UpdateInfo { current: string; latest: string; newer?: boolean; url: string; error?: string; needs_token?: boolean; notes?: string }
// What `dispatch screen setup --json` returns: the steps it walked and the one thing left for the user.
export interface ScreenSetupResult { ok: boolean; url?: string; error?: string; steps?: { id?: string; title: string; ok: boolean; detail: string }[]; manual?: { id?: string; title: string; detail: string }[]; state?: { url: string; ready: boolean; screen_sharing: boolean; issue: string } }

// The few knobs that change how the workbench reads. Shared through the board
// (`dispatch settings`), so both Macs agree.
export function SettingsView({ settings, onSave, theme, onTheme, summaryProviders = [], onPhone, phoneQr, onScreen, screenReady, screen, onScreenSetup, hosts = [], onSetup, onRenameHost, onDeleteHost, onRedetectHost, onTestNotify, update, onCheckUpdate, onApplyUpdate }: Props) {
  const [checking, setChecking] = useState(false);
  // The version line should not read "v…" forever: look it up once when the page opens.
  useEffect(() => { if (!update && onCheckUpdate) { setChecking(true); void Promise.resolve(onCheckUpdate()).finally(() => setChecking(false)); } }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [applying, setApplying] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [draft, setDraft] = useState<DispatchSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenResult, setScreenResult] = useState<ScreenSetupResult | null>(null);
  useEffect(() => { setDraft(settings); }, [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const num = (k: keyof DispatchSettings, v: string, max: number) => setDraft({ ...draft, [k]: Math.max(0, Math.min(max, Number(v) || 0)) });
  const save = async () => { setBusy(true); try { await onSave(draft); } finally { setBusy(false); } };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [hostBusyId, setHostBusyId] = useState<string | null>(null);
  const hostKey = (h: Host) => (h.local ? "local" : h.id);
  const startRename = (h: Host) => { setRenamingId(hostKey(h)); setNameDraft(h.name); };
  const confirmRename = async (h: Host) => {
    const name = nameDraft.trim();
    setRenamingId(null);
    if (!name || name === h.name || !onRenameHost) return;
    setHostBusyId(hostKey(h));
    try { await onRenameHost(h, name); } finally { setHostBusyId(null); }
  };
  const deleteHost = async (h: Host) => {
    if (hostBusyId) return;
    const key = hostKey(h);
    if (pendingDeleteId !== key) { setPendingDeleteId(key); window.setTimeout(() => setPendingDeleteId((k) => (k === key ? null : k)), 4000); return; }
    setPendingDeleteId(null);
    if (!onDeleteHost) return;
    setHostBusyId(key);
    try { await onDeleteHost(h); } finally { setHostBusyId(null); }
  };
  const redetectHost = async (h: Host) => {
    if (!onRedetectHost) return;
    const key = hostKey(h);
    setHostBusyId(key);
    try { await onRedetectHost(h); } finally { setHostBusyId(null); }
  };
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
        {onTestNotify && <div className="settings-row">
          <div><b>手机通知</b><p>报告生成完、讨论结束、会话变成「等你」时推一条。渠道在「环境」页配：NTFY_URL（ntfy 主题地址）或 BARK_KEY（Bark 的 key）；两个都没配就发这台 Mac 的系统通知。命令行 <span className="mono">dispatch notify &quot;标题&quot; &quot;正文&quot;</span>。</p></div>
          <button className="btn sm" disabled={notifying} onClick={async () => { setNotifying(true); try { await onTestNotify(); } finally { setNotifying(false); } }}>{notifying ? "发送中…" : "发一条测试通知"}</button>
        </div>}
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
        <h3>讨论</h3>
        <p className="muted small" style={{ margin: "0 0 8px" }}>「讨论一个念头」里每个成员的人设和群里的规矩，进它们的系统提示；每轮只再给新消息。空着就用默认。</p>
        <label className="settings-row">
          <div><b>群里的规矩</b><p>发言多长、什么时候闲聊、什么时候只回 SKIP（不显示）。</p></div>
          <textarea className="settings-text" rows={3} value={draft.discuss_rules} onChange={(e) => setDraft({ ...draft, discuss_rules: e.target.value })} />
        </label>
        {([["discuss_persona_claude", "Claude 的人设"], ["discuss_persona_codex", "Codex 的人设"], ["discuss_persona_pi", "pi 的人设"]] as const).map(([k, label]) => (
          <label key={k} className="settings-row">
            <div><b>{label}</b><p>一句话：关注什么、怎么表达、习惯质疑什么。</p></div>
            <textarea className="settings-text" rows={2} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
      </section>
      <section className="settings-card">
        <h3>工作台</h3>
        <label className="settings-row">
          <div><b>已完成任务多少天后自动归档</b><p>完成超过这些天的任务自动打上归档标记，从已完成列和计数里移开，「已归档」里能找到，随时可取消归档。填 0 表示不自动归档（看板上仍有「归档 30 天前完成的」按钮）。</p></div>
          <span className="settings-num"><input type="number" min={0} max={3650} value={draft.task_archive_days} onChange={(e) => num("task_archive_days", e.target.value, 3650)} /> 天</span>
        </label>
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
        {(onPhone || phoneQr) && <div className="settings-row">
          <div><b>手机访问</b><p>手机连上 Tailscale 后，用相机扫下面的二维码就能打开网页版（二维码里带着登录令牌，扫一次就记住）；也可以复制链接发到手机，能添加到主屏幕。</p>{phoneQr ? <div className="settings-qr" dangerouslySetInnerHTML={{ __html: phoneQr }} /> : null}</div>
          {onPhone && <button className="btn sm" onClick={onPhone}>复制链接</button>}
        </div>}
        {onScreen && <div className="settings-row">
          <div><b>屏幕访问</b><p>{screenReady ? "手机连上 Tailscale 后，用浏览器打开这个链接就能看到并操作这台电脑的屏幕（noVNC），登录用这台 Mac 的用户名和密码。" : "点「配置」自动装好 noVNC 与常驻服务、开通 Tailscale HTTPS；屏幕共享这个开关只能你自己在系统设置里打开。"}</p>
            {screen?.url ? <p className="muted small mono">{screen.url}</p> : screen?.issue ? <p className="muted small">{screen.issue}</p> : null}
            {screenResult?.steps?.length ? <pre className="setup-log">{screenResult.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.title}：${s.detail}`).join("\n")}</pre> : null}
            {screenResult?.manual?.length ? <p className="muted small">还差一步：{screenResult.manual.map((m) => `${m.title}（${m.detail}）`).join("；")}</p> : null}
          </div>
          <span className="setup-row">
            {onScreenSetup && <button className="btn sm" disabled={screenBusy} onClick={async () => { setScreenBusy(true); try { setScreenResult(await onScreenSetup()); } finally { setScreenBusy(false); } }}>{screenBusy ? "配置中…（要下载 noVNC）" : screenReady ? "重新配置" : "配置"}</button>}
            <button className="btn sm" disabled={!screenReady} onClick={onScreen}>复制屏幕链接</button>
          </span>
        </div>}
        {onCheckUpdate && <div className="settings-row">
          <div><b>版本与更新</b><p>当前 v{update?.current ?? "…"}{update?.latest ? `，最新 v${update.latest}` : ""}{update?.newer ? "，有新版本" : update?.latest ? "，已是最新" : ""}。{update?.error ? update.error : isTauri ? "从 GitHub Release 下载并替换应用，完成后自动重启。" : "网页版只能查看版本；更新在 Mac 上的 Dispatch.app 里做。"}</p></div>
          <span className="setup-row">{update?.newer && !update.error && isTauri ? <button className="btn sm primary" disabled={applying} onClick={async () => { setApplying(true); try { await onApplyUpdate?.(); } finally { setApplying(false); } }}>{applying ? "更新中…" : `更新到 v${update.latest}`}</button> : null}<button className="btn sm" disabled={checking} onClick={async () => { setChecking(true); try { await onCheckUpdate(); } finally { setChecking(false); } }}>{checking ? "检查中…" : "检查更新"}</button></span>
        </div>}
        {onSetup && <div className="settings-row">
          <div><b>首次设置</b><p>装依赖、建或接入任务板、选 Agent、同步规则与技能。跳过过的可以从这里再打开，每一步都能重跑。</p></div>
          <button className="btn sm" onClick={onSetup}>打开首次设置</button>
        </div>}
        {hosts.length > 0 && <div className="settings-row host-manage">
          <div><b>机器</b><p>来自 ~/tasks/.dispatch/hosts.json；侧栏可按机器筛选。要加一台：在那台电脑上装 Dispatch，走首次设置时选「接入」并填这台的地址；或者在这台上「接入另一台」。改名会同步推给已知的机器；删除后本机不再尝试连接它。</p>{onSetup && <button className="btn sm" onClick={onSetup}>接入另一台电脑…</button>}</div>
          <div className="host-list">
            {hosts.map((h) => {
              const key = hostKey(h);
              const rowBusy = hostBusyId === key;
              return (
                <div key={key} className="host-row">
                  <span className={`dot${h.online ? " on" : ""}`} title={h.ip} />
                  {renamingId === key ? (
                    <>
                      <input className="host-name-input" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void confirmRename(h); if (e.key === "Escape") setRenamingId(null); }} />
                      <button className="btn ghost sm" disabled={rowBusy} onClick={() => void confirmRename(h)}>保存</button>
                      <button className="btn ghost sm" disabled={rowBusy} onClick={() => setRenamingId(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <span className="host-name" title={h.ip}>{h.name}{h.local ? "（本机）" : ""}</span>
                      {onRenameHost && <button className="btn ghost sm" disabled={rowBusy} onClick={() => startRename(h)}>{rowBusy ? "…" : "改名"}</button>}
                      {onRedetectHost && !h.local && <button className="btn ghost sm" disabled={rowBusy} onClick={() => void redetectHost(h)}>重新检测</button>}
                      {onDeleteHost && !h.local && <button className="btn ghost sm danger" disabled={rowBusy} onClick={() => void deleteHost(h)}>{pendingDeleteId === key ? "再点一次确认删除" : "删除"}</button>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
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
