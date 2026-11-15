import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { EnvKeys } from "./Env";
import { useLocale, useT } from "../i18n";
import { EmptyView, ListDetail, Row, Section, Sep, Tag, useListKeyboard } from "./primitives";
import { DetailHead, hostName, revealDetail } from "./PageParts";
import { useShellHeader } from "./Shell";
import { Icon } from "./icons";
import { tildePath } from "../activity";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface FactsDocMeta { key: string; name: string; path: string; dir: string; exists: boolean; hint: string }
interface FactsDoc { path: string; content: string; exists: boolean }
interface Vault { id: string; name: string; path: string; exists: boolean; open: boolean }

const short = tildePath;
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const GENERAL_TEMPLATE = `# 服务器与数据库

> 记录机器、云服务、数据库和账号用途。密码、Token 和 API Key 在「密钥与 API」中管理。
> Agent 的行为规则和项目指令在「Agent 规则」中管理。

## 通用

### 服务器

- 名称与用途：
- 地址：
- 关联密钥名称：

### 数据库

- 名称与用途：
- 连接地址：
- 关联密钥名称：

### 常用资料

- 资料位置：
`;

// Resources use the existing facts document; project instructions live in Agent rules.
export function FactsView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const t = useT();
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [docs, setDocs] = useState<FactsDocMeta[]>([]);
  const [selected, setSelected] = useState("通用");
  const [doc, setDoc] = useState<FactsDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"docs" | "keys" | "vaults">("keys");
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [keysRevision, setKeysRevision] = useState(0);
  const blocked = hostReason(hosts, host);

  const meta = docs.find((d) => d.key === selected);
  const loadDocs = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { const [d,v]=await Promise.all([api.on(host, ["facts", "docs", "--json"]),api.on(host,['facts','vaults','--json'])]);setDocs(parseJson<FactsDocMeta[]>(d, []).filter(x=>x.key==='通用'));setVaults(parseJson<Vault[]>(v,[])); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);
  useEffect(() => { setDocs([]); setDoc(null); setDraft(null); setSelected("通用"); void loadDocs(); }, [loadDocs]);
  const load = useCallback(async () => {
    if (blocked || !meta) return;
    setBusy(true); setError("");
    try { setDoc(parseJson<FactsDoc>(await api.on(host, ["facts", "show", "--path", meta.path, "--json"]), { path: meta.path, content: "", exists: false })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked, meta]);
  useEffect(() => { setDoc(null); setDraft(null); void load(); }, [load]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    if (!meta) return;
    try { await api.on(host, ["facts", "write", "--path", meta.path], draft); setDraft(null); onDone(meta.key === "通用" ? t("已保存；新开的会话会带上") : t("已保存到 {path}（记得 commit）", { path: short(meta.path) })); await loadDocs(); await load(); }
    catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  const locale = useLocale();
  useShellHeader({
    subtitle: hostName(hosts, host),
    actions: <button className="btn sm ghost" disabled={busy || draft !== null} onClick={() => { if (panel === "keys") setKeysRevision(n => n + 1); else { void loadDocs(); void load(); } }} title={t("重新读取")} aria-label={t("重新读取")}><Icon name="refresh" size={14} /></button>,
  }, [host, hosts, busy, draft, panel, locale]);
  const PANELS: { key: "keys" | "docs" | "vaults"; icon: string; title: string; sub: string }[] = [
    { key: "keys", icon: "key", title: t("密钥与 API"), sub: t("Token、密码、API Key 与用途") },
    { key: "docs", icon: "doc", title: t("服务器与数据库"), sub: t("机器、云服务、连接信息与个人资料") },
    { key: "vaults", icon: "book", title: t("Obsidian 资料库"), sub: t("你的笔记和个人知识库") },
  ];
  const choose = (p: "keys" | "docs" | "vaults") => { if (draft !== null) return; if (p === "docs") setSelected("通用"); setPanel(p); };
  useListKeyboard(PANELS.map((p) => p.key), panel, (k) => choose(k as typeof panel), { enabled: draft === null });
  const openVault = (v: Vault) => `obsidian://open?vault=${encodeURIComponent(v.name)}`;

  const detail = <div className="ak-detail">
    {(blocked || error) && <p className="akd-note err">{blocked || error}</p>}
    {panel === "keys" ? <section className="facts-key-content" aria-label={t("密钥管理")}>
      <DetailHead crumb={[t("常用资料"), hostName(hosts, host)]} title={t("密钥与 API")} />
      <p className="akd-note">{t("按名称或用途搜索，查看和修改都在这里。")}</p>
      <EnvKeys key={keysRevision} api={api} host={host} blocked={blocked} onDone={onDone} onError={onError} compact />
    </section> : panel === "vaults" ? <section className="vaults-content">
      <DetailHead crumb={[t("常用资料"), hostName(hosts, host)]} title={t("Obsidian 资料库")} />
      <p className="akd-note">{t("笔记在 Obsidian 中编辑。这里列出所选电脑的资料库；打开时使用当前设备的 Obsidian。")}</p>
      {vaults.length ? vaults.map(v => <div className="ak-vault" key={v.id}>
        <div className="l1"><Icon name="book" /><b>{v.name}</b>{!v.exists && <Tag title={t("当前机器暂时无法访问这个目录")}>{t("无法访问")}</Tag>}</div>
        <div className="mono s">{short(v.path)}</div>
        <div className="akd-acts"><a className="btn sm" href={openVault(v)}>{t("在 Obsidian 打开")}</a><button className="btn sm ghost" onClick={() => api.copy(v.path).then(() => onDone(t('资料库路径已复制'))).catch(e => onError(String(e)))}>{t("复制路径")}</button></div>
      </div>) : <EmptyView icon="book" title={t("没有资料库")} description={t("尚未检测到资料库。先在这台电脑的 Obsidian 中打开你的资料库，再点「重新读取」。")} />}
    </section> : <>
      <DetailHead crumb={[t("常用资料"), doc ? short(doc.path) : "…"]} title={t("服务器与数据库")} tag={doc && !doc.exists ? <Tag>{t("尚未创建")}</Tag> : undefined}
        actions={draft === null
          ? <button className="btn sm" disabled={busy || !doc || !meta} onClick={() => setDraft(doc?.content || t(GENERAL_TEMPLATE))}>{t("编辑")}</button>
          : <><button className="btn sm primary" disabled={busy} onClick={() => void save()}>{t("保存")}</button><button className="btn sm ghost" disabled={busy} onClick={() => setDraft(null)}>{t("取消")}</button></>} />
      <p className="akd-note">{t("记录服务器、数据库、账号用途和常用资料；密码与 Token 在左侧「密钥与 API」管理。Agent 的行为要求和项目文档在「Agent 规则」。")}</p>
      <Sep />
      {draft === null
        ? <div className="akd-md">{doc?.content ? <Markdown src={doc.content} /> : <p className="akd-note">{t("尚未创建，点「编辑」用模板开始。")}</p>}</div>
        : <textarea aria-label={t("常用信息草稿")} className="akd-edit" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
    </>}
  </div>;

  return <ListDetail className="ak-page ak-doc" detail={detail}>
    <Section title={t("常用资料")}>
      {PANELS.map((p) => <Row key={p.key} id={p.key} selected={panel === p.key} onClick={() => { choose(p.key); revealDetail(); }} icon={<Icon name={p.icon} filled={panel === p.key} />} title={p.title}
        accessories={p.key === "vaults" && vaults.length ? [<span className="num">{vaults.length}</span>] : []} />)}
    </Section>
  </ListDetail>;
}
