import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { useT } from "../i18n";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface ProfileSection { heading: string; key: string; body: string; lines: number }
interface ProfileDoc { path: string; exists: boolean; content: string; sections: ProfileSection[]; inventory_at: string }

const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };
const EMPTY: ProfileDoc = { path: "", exists: false, content: "", sections: [], inventory_at: "" };

// The personal profile: one shared markdown file that prime injects, plus a fleet
// inventory that rewrites its 现状 section with what each machine looks like now.
export function ProfileView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const t = useT();
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [doc, setDoc] = useState<ProfileDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const blocked = hostReason(hosts, host);

  const load = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { setDoc(parseJson<ProfileDoc>(await api.on(host, ["profile", "show", "--json"]), EMPTY)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);
  useEffect(() => { setDoc(null); setDraft(null); void load(); }, [load]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try { await api.on(host, ["profile", "write"], draft); setDraft(null); onDone(t("已保存")); await load(); }
    catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  const inventory = async () => {
    setScanning(true); setBusy(true); setError("");
    try {
      const r = parseJson<{ targets?: { name: string; state: string; error?: string }[] }>(await api.on(host, ["profile", "inventory", "--refresh", "--json"]), {});
      const targets = r.targets ?? [];
      const bad = targets.filter((t) => t.state !== "ok");
      await load();
      onDone(t("已重新盘点 {n} 台机器", { n: targets.length - bad.length }) + (bad.length ? t("，{names} 没连上", { names: bad.map((x) => x.name).join(t("、")) }) : ""));
    }
    catch (e) { onError(String(e)); } finally { setScanning(false); setBusy(false); }
  };

  return <div className="instruction-center">
    <div className="instruction-top"><HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={(h) => { if (!busy && draft === null) setHost(h); }} /><span className="spacer" /><button className="btn sm" disabled={busy || draft !== null || !!blocked} onClick={() => void inventory()}>{scanning ? t("正在盘点…") : t("重新盘点")}</button><button className="btn sm" disabled={busy || draft !== null || !!blocked} onClick={() => void load()}>{t("重新读取")}</button></div>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="instruction-grid profile-grid">
      <div className="instruction-detail">
        <header><div><h3>{t("关于我")}</h3><div className="muted mono small">{doc ? short(doc.path) : "…"}{doc && !doc.exists ? ` · ${t("尚未创建")}` : ""}</div></div><span className="spacer" />
          {draft === null
            ? <button className="btn primary sm" disabled={busy || !doc} onClick={() => setDraft(doc?.content || "")}>{t("编辑")}</button>
            : <><button className="btn sm" disabled={busy} onClick={() => setDraft(null)}>{t("取消")}</button><button className="btn primary sm" disabled={busy} onClick={() => void save()}>{t("保存")}</button></>}
        </header>
        {doc?.inventory_at && <p className="small muted">{t("盘点于 {at}", { at: doc.inventory_at })}</p>}
        {draft === null
          ? <div className="instruction-content facts-content">{doc?.content ? <Markdown src={doc.content} /> : <span className="muted">{t("尚未创建，点「编辑」开始写。")}</span>}</div>
          : <textarea className="instruction-editor" aria-label={t("关于我草稿")} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      </div>
    </div>
  </div>;
}
