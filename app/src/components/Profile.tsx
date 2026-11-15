import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { useLocale, useT } from "../i18n";
import { ListDetail, Row, Section, Sep, Tag, useListKeyboard } from "./primitives";
import { About, DetailHead, hostName, revealDetail } from "./PageParts";
import { useShellHeader } from "./Shell";
import { Icon } from "./icons";
import { tildePath } from "../activity";
import { relTime } from "../derive";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface ProfileSection { heading: string; key: string; body: string; lines: number }
interface ProfileDoc { path: string; exists: boolean; content: string; sections: ProfileSection[]; inventory_at: string }

const short = tildePath;
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

  const locale = useLocale();
  const locked = busy || draft !== null || !!blocked;
  useShellHeader({
    subtitle: [hostName(hosts, host), doc?.inventory_at ? t("盘点于 {at}", { at: Number.isNaN(Date.parse(doc.inventory_at)) ? doc.inventory_at : relTime(doc.inventory_at) }) : ""].filter(Boolean).join(" · "),
    actions: <>
      <button className="btn sm ghost" disabled={locked} onClick={() => void load()} title={t("重新读取")} aria-label={t("重新读取")}><Icon name="refresh" size={14} /></button>
      <button className="btn sm" disabled={locked} onClick={() => void inventory()} title={t("重新扫描各台机器，更新「设备与服务现状」一节")}><Icon name="screen" size={14} /><span className="ak-hd-lbl">{scanning ? t("正在盘点…") : t("重新盘点")}</span></button>
    </>,
  }, [host, hosts, doc?.inventory_at, locked, scanning, locale]);
  // One row per section of the file; the first row is the whole file (and the place to edit it).
  const [part, setPart] = useState<string>("all");
  const sections = doc?.sections ?? [];
  const cur = sections.find((s) => s.key === part);
  useListKeyboard(["all", ...sections.map((s) => s.key)], cur ? part : "all", (k) => { if (draft === null) setPart(k); }, { enabled: draft === null });
  const detail = <div className="ak-detail">
    {(blocked || error) && <p className="akd-note err">{blocked || error}</p>}
    <DetailHead crumb={[t("关于我"), doc ? short(doc.path) : "…"]} title={cur ? cur.heading : t("关于我")} tag={doc && !doc.exists ? <Tag>{t("尚未创建")}</Tag> : undefined}
      actions={draft === null
        ? <button className="btn sm" disabled={busy || !doc} onClick={() => { setPart("all"); setDraft(doc?.content || ""); }}>{t("编辑")}</button>
        : <><button className="btn sm primary" disabled={busy} onClick={() => void save()}>{t("保存")}</button><button className="btn sm ghost" disabled={busy} onClick={() => setDraft(null)}>{t("取消")}</button></>} />
    <Sep />
    {draft === null
      ? <div className="akd-md">{cur ? <Markdown src={cur.body} /> : doc?.content ? <Markdown src={doc.content} /> : <p className="akd-note">{t("尚未创建，点「编辑」开始写。")}</p>}</div>
      : <textarea className="akd-edit" aria-label={t("关于我草稿")} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
  </div>;
  return <ListDetail className="ak-page ak-doc" detail={detail}>
    <Row id="all" selected={!cur} onClick={() => { if (draft === null) { setPart("all"); revealDetail(); } }} icon={<Icon name="doc" filled={!cur} />} title={t("全文")} />
    {sections.length > 0 && <Section title={t("分节")} count={sections.length}>
      {sections.map((s) => <Row key={s.key} id={s.key} selected={part === s.key} onClick={() => { if (draft === null) { setPart(s.key); revealDetail(); } }} icon={<Icon name="doc" size={14} />} title={s.heading} accessories={[<span className="num">{t("{n} 行", { n: s.lines })}</span>]} />)}
    </Section>}
    <About summary={t("关于这份文件")}><p>{t("一份所有 Agent 共用的个人资料，会话启动时注入；「重新盘点」会把各台机器现在的样子写进「设备与服务现状」一节。")}</p></About>
  </ListDetail>;
}
