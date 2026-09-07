import { useEffect, useState } from "react";
import type { DispatchSettings } from "../projectFlags";

interface Props { settings: DispatchSettings; onSave: (next: DispatchSettings) => Promise<void> }

// The few knobs that change how the workbench reads. Shared through the board
// (`dispatch settings`), so both Macs agree.
export function SettingsView({ settings, onSave }: Props) {
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
          <div><b>脚本或其他 Agent 通过 SDK 启动的会话，自动当作定时会话</b><p>定时会话不进「等我」、不发通知、不出现在工作台；会话页「定时」筛选里能看到。对单条会话手动标记过的，以手动为准。</p></div>
          <input type="checkbox" checked={draft.sdk_sessions_scheduled} onChange={(e) => setDraft({ ...draft, sdk_sessions_scheduled: e.target.checked })} />
        </label>
      </section>
      <section className="settings-card">
        <h3>工作台</h3>
        <label className="settings-row">
          <div><b>默认展开前几个项目</b><p>其余项目折叠成一行摘要，点一下展开。有等你回复或等待确认的项目总是展开。</p></div>
          <span className="settings-num"><input type="number" min={0} max={50} value={draft.home_expanded} onChange={(e) => num("home_expanded", e.target.value, 50)} /> 个</span>
        </label>
      </section>
      <div className="settings-actions">
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
        {dirty && <button className="btn" disabled={busy} onClick={() => setDraft(settings)}>还原</button>}
        <span className="muted small">存在共享任务板上，两台 Mac 一致；命令行 <span className="mono">dispatch settings</span> 读写同一份。</span>
      </div>
    </div>
  );
}
