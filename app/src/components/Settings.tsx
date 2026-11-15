import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EnvView } from "./Env";
import { Tabs } from "./primitives";
import { useShellHeader } from "./Shell";
import type { DispatchSettings } from "../projectFlags";
import type { Api } from "../api";
import type { Host } from "../types";
import { t as tr, useT, useLocale, useLocalePref, setLocale, LOCALES, LOCALE_NAMES, type LocalePref } from "../i18n";
import { isWindows } from "../platform";
type Theme = "light" | "dark" | "";
// A model the summary setting can point at (`dispatch summarize providers --json`). Providers that
// bill to a subscription carry no env; the rest need a key in the local dispatch env store.
export interface SummaryProvider { id: string; provider: string; label: string; env: string; configured: boolean; model: string; subscription: boolean }
// One place summaries are shown (`dispatch summarize uses --json`); the CLI keeps the enabled
// default and the token count/date of the last summary it wrote there.
export interface SummaryUse { key: string; name: string; desc: string; enabled: boolean; last: { at: number; tokens: number; model: string } | null }
// The fixture/fallback shape: only id + label are required, matching the plain `dispatch summarize providers` list.
export interface SummaryProviderOption { id: string; label: string; provider?: string; env?: string; configured?: boolean; model?: string; subscription?: boolean }
interface Props { settings: DispatchSettings; onSave: (next: DispatchSettings) => Promise<void>; theme: Theme; onTheme: (t: Theme) => void; api?: Api; summaryProviders?: SummaryProviderOption[]; onScreen?: () => void; screenReady?: boolean; screen?: { url: string; up: boolean; sharing: boolean; issue: string }; hosts?: Host[]; onRenameHost?: (host: Host, name: string) => Promise<void>; onDeleteHost?: (host: Host) => Promise<void>; onRedetectHost?: (host: Host) => Promise<void>; onTestNotify?: () => Promise<void>; update?: UpdateInfo | null; onCheckUpdate?: () => Promise<void>; onDone?: (m: string) => void; onError?: (m: string) => void; hostId?: string }
export interface UpdateInfo { current: string; latest: string; newer?: boolean; url: string; error?: string; needs_token?: boolean; notes?: string }
// What `dispatch screen setup --json` returns: the steps it walked and the one thing left for the user.

// The CLI prefixes its JSON with log lines; find the first { or [ (same helper as Env/Stats).
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };
// `glm-5.3-flash（智谱） · 已配 Key` / `... · 缺 Key`; subscription models say 订阅 instead.
export function summaryOptionLabel(p: SummaryProvider): string { return `${p.label} · ${p.subscription ? tr("订阅") : p.configured ? tr("已配 Key") : tr("缺 Key")}`; }
// A non-subscription provider with no key yet is the only case that needs the inline key box.
export function missingKeyProvider(p: SummaryProvider | undefined): SummaryProvider | undefined { return p && !p.subscription && !p.configured ? p : undefined; }
// The settings a use toggle saves: `summary_uses` holds 0/1 (same as the CLI stores it).
export function withSummaryUses(s: DispatchSettings, key: string, on: boolean): DispatchSettings { return { ...s, summary_uses: { ...(s.summary_uses || {}), [key]: on ? 1 : 0 } }; }
export function compactTokens(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`; }
// 设置 is six tabs (design/raycast-redesign 图 5): each a two-column form, 200px right-aligned labels
// (240px for the longer English and German labels), the control, and its help text under it.
type SettingsTab = "general" | "sessions" | "ide" | "phone" | "env" | "hosts" | "about";
const TAB_KEY = "dispatch-settings-tab";
function Field({ k, help, children }: { k: ReactNode; help?: ReactNode; children: ReactNode }) {
  return <div className="frow"><div className="fk">{k}</div><div className="fc">{children}{help ? <div className="help">{help}</div> : null}</div></div>;
}
/** A segmented control (外观, 列表密度): every option visible, the chosen one raised. */
function Seg<V extends string>({ value, onChange, options, label, disabled }: { value: V; onChange: (v: V) => void; options: [V, string][]; label: string; disabled?: boolean }) {
  return <div className={`fseg${disabled ? " disabled" : ""}`} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>{options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} disabled={disabled} onClick={() => onChange(v)}>{l}</button>)}</div>;
}
function formatSummaryTime(at: number): string { const d = new Date(at < 1e12 ? at * 1000 : at); if (Number.isNaN(d.getTime())) return ""; const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }

/** A cap typed by hand: an empty or half-typed field never saves (empty used to save 0, which means
 *  no cap at all); only a number does, and leaving the field puts the saved value back. */
export function capFromInput(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function CapInput({ value, label, onChange }: { value: number; label: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((cur) => (capFromInput(cur) === value ? cur : String(value))); }, [value]);
  return <input className="ctl" type="number" min={0} max={100} step={0.1} aria-label={label} value={text}
    onChange={(e) => { setText(e.target.value); const v = capFromInput(e.target.value); if (v !== null) onChange(v); }}
    onBlur={() => setText(String(value))} />;
}

/** `ide usage today` (Tab completion spend). */
interface TabUsage { date: string; count: number; usd: number; cap_usd: number; over_cap: boolean; enabled: boolean; model: string; month: { count: number; usd: number }; prices_as_of?: string }

/**
 * 设置 › IDE: what Dispatch IDE's bridge extension uses: the ⌘K model and Tab completion (switch,
 * daily cap, today's spend). The fields go through the page's draft and 保存 bar like every other setting.
 */
function IdeTab({ api, draft, setDraft, options, active, onEnv }: { api?: Api; draft: DispatchSettings; setDraft: (d: DispatchSettings) => void; options: SummaryProvider[]; active: boolean; onEnv: () => void }) {
  const t = useT();
  const [usage, setUsage] = useState<TabUsage | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    if (!api) return;
    try { const raw = await api.on("local", ["ide", "usage", "today", "--json"]); setUsage(JSON.parse(raw.slice(Math.max(0, raw.indexOf("{")))) as TabUsage); } catch { setUsage(null); }
    try { const raw = await api.on("local", ["env", "list", "--json"]); setHasKey((JSON.parse(raw.slice(Math.max(0, raw.indexOf("[")))) as { name: string }[]).some((e) => e.name === "DEEPSEEK_API_KEY")); } catch { setHasKey(false); }
  }, [api]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const cap = draft.ide_tab_daily_cap_usd;
  return <>
    <div className="fsec">{t("{mod}K 改写与 Tab 补全")}</div>
    <Field k={t("{mod}K 改写用的模型")} help={t("在 IDE 里选中代码按 {mod}K，写一句要怎么改。订阅模型不用 Key、计入用量。")}>
      <select className="ctl" value={draft.ide_edit_model} onChange={(e) => setDraft({ ...draft, ide_edit_model: e.target.value })} aria-label={t("{mod}K 改写用的模型")}>{!options.some((p) => p.id === "claude:sonnet") && <option value="claude:sonnet">{t("Claude Sonnet（订阅，默认）")}</option>}{options.map((p) => <option key={p.id} value={p.id}>{summaryOptionLabel(p)}</option>)}{draft.ide_edit_model && draft.ide_edit_model !== "claude:sonnet" && !options.some((p) => p.id === draft.ide_edit_model) && <option value={draft.ide_edit_model}>{t("{model}（当前不可用）", { model: draft.ide_edit_model })}</option>}</select>
    </Field>
    <Field k={t("Tab 补全")} help={hasKey === false ? <>{t("要 DEEPSEEK_API_KEY。")} <button type="button" className="lk" onClick={onEnv}>{t("去「环境」里加")}</button></> : t("打字时用 DeepSeek 给灰色的续写，按 Tab 接受。按 {when} 价目估算，一次约 $0.0005。", { when: usage?.prices_as_of ?? "2026-09" })}>
      <label className="check"><input type="checkbox" disabled={hasKey === false && !draft.ide_tab_completion} checked={draft.ide_tab_completion} onChange={(e) => setDraft({ ...draft, ide_tab_completion: e.target.checked })} />{t("开启")}</label>
      {usage && <span className="help">{t("今天 {n} 次，${usd}；本月 {m} 次，${musd}", { n: usage.count, usd: usage.usd.toFixed(4), m: usage.month.count, musd: usage.month.usd.toFixed(4) })}{usage.over_cap ? t("，已到今天的上限") : ""}</span>}
    </Field>
    <Field k={t("每天上限")} help={t("今天的花费到这个数就停止补全，明天自动恢复。填 0 表示不限。")}>
      <span className="settings-num">$ <CapInput value={cap} label={t("Tab 补全每天上限（美元）")} onChange={(v) => setDraft({ ...draft, ide_tab_daily_cap_usd: v })} /></span>
    </Field>
  </>;
}

// The few knobs that change how the workbench reads. Shared through the board
// (`dispatch settings`), so both Macs agree.
export function SettingsView({ settings, onSave, theme, onTheme, api, summaryProviders = [], onScreen, screenReady, screen, hosts = [], onRenameHost, onDeleteHost, onRedetectHost, onTestNotify, update, onCheckUpdate, onDone, onError, hostId }: Props) {
  const t = useT();
  const locale = useLocale();
  const [tab, setTab] = useState<SettingsTab>(() => { try { const v = localStorage.getItem(TAB_KEY) as SettingsTab | null; return v && ["general", "sessions", "ide", "phone", "env", "hosts", "about"].includes(v) ? v : "general"; } catch { return "general"; } });
  const pickTab = (k: SettingsTab) => { setTab(k); try { localStorage.setItem(TAB_KEY, k); } catch { /* private mode */ } };
  useShellHeader({ subtitle: t("存在共享任务板上，两台 Mac 一致") }, [locale]);
  const localePref = useLocalePref();
  const [checking, setChecking] = useState(false);
  // The version line should not read "v…" forever: look it up once when the page opens.
  useEffect(() => { if (!update && onCheckUpdate) { setChecking(true); void Promise.resolve(onCheckUpdate()).finally(() => setChecking(false)); } }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [notifying, setNotifying] = useState(false);
  // Phone channel: the keys live in `dispatch env` (NTFY_URL / BARK_KEY); only whether they are set is shown.
  const [barkKey, setBarkKey] = useState(""); const [ntfyUrl, setNtfyUrl] = useState("");
  const [barkSet, setBarkSet] = useState(false); const [ntfySet, setNtfySet] = useState(false); const [channelBusy, setChannelBusy] = useState(false);
  const loadChannel = useCallback(async () => { if (!api) return; try { const raw = await api.on("local", ["env", "list", "--json"]); const list = JSON.parse(raw.slice(Math.max(0, raw.indexOf("[")))) as { name: string }[]; setBarkSet(list.some((e) => e.name === "BARK_KEY")); setNtfySet(list.some((e) => e.name === "NTFY_URL")); } catch { /* env unavailable */ } }, [api]);
  useEffect(() => { void loadChannel(); }, [loadChannel]);
  const saveChannel = async (name: "BARK_KEY" | "NTFY_URL", value: string) => { if (!api) return; setChannelBusy(true); try { await api.on("local", ["env", "set", name, "--stdin", "--note", name === "BARK_KEY" ? "手机通知：Bark" : "手机通知：ntfy"], value.trim()); if (name === "BARK_KEY") setBarkKey(""); else setNtfyUrl(""); await loadChannel(); } finally { setChannelBusy(false); } };
  const clearChannel = async (name: "BARK_KEY" | "NTFY_URL") => { if (!api) return; setChannelBusy(true); try { await api.on("local", ["env", "unset", name]); await loadChannel(); } finally { setChannelBusy(false); } };
  const [draft, setDraft] = useState<DispatchSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<SummaryProvider[]>([]);
  const [uses, setUses] = useState<SummaryUse[]>([]);
  const [keyValue, setKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  // A save from elsewhere (列表密度, a summary toggle, the other Mac) refreshes the draft but keeps
  // the fields typed here and not saved yet.
  const saved = useRef(settings);
  useEffect(() => {
    const before = saved.current; saved.current = settings;
    setDraft((d) => { const next = { ...settings } as Record<string, unknown>; for (const k of Object.keys(d) as (keyof DispatchSettings)[]) if (JSON.stringify(d[k]) !== JSON.stringify(before[k])) next[k] = d[k]; return next as unknown as DispatchSettings; });
  }, [settings]);
  const loadSummary = useCallback(async () => {
    if (!api) return;
    try {
      const r = parseJson<{ providers?: SummaryProvider[] }>(await api.on("local", ["summarize", "providers", "--json"]), {});
      if (Array.isArray(r.providers)) setProviders(r.providers);
    } catch { /* keep the last list */ }
    try {
      const r = parseJson<SummaryUse[]>(await api.on("local", ["summarize", "uses", "--json"]), []);
      if (Array.isArray(r)) setUses(r);
    } catch { /* keep the last list */ }
  }, [api]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  const fallbackProviders = useMemo<SummaryProvider[]>(() => summaryProviders.map((p) => ({ id: p.id, provider: p.provider ?? p.id.split(":")[0] ?? "", label: p.label, env: p.env ?? "", configured: p.configured ?? true, model: p.model ?? "", subscription: p.subscription ?? false })), [summaryProviders]);
  const options = api ? providers : fallbackProviders;
  const selectedProvider = options.find((p) => p.id === draft.summary_model);
  const keyTarget = missingKeyProvider(selectedProvider);
  const useOn = (u: SummaryUse) => { const v = draft.summary_uses?.[u.key]; return v === undefined ? u.enabled : v !== 0; };
  const saveKey = async () => {
    if (!api || !keyTarget || !keyValue.trim()) return;
    setKeyBusy(true); setSummaryError("");
    try {
      const r = parseJson<{ ok?: boolean; error?: string }>(await api.on("local", ["summarize", "set-key", keyTarget.provider], keyValue.trim()), {});
      if (r.error || !r.ok) { setSummaryError(r.error || t("保存 Key 失败")); return; }
      setKeyValue("");
      await loadSummary();
    } catch (e) { setSummaryError(String(e)); }
    finally { setKeyBusy(false); }
  };
  const toggleUse = async (key: string, on: boolean) => {
    setSummaryError("");
    try { await onSave(withSummaryUses(draft, key, on)); await loadSummary(); }
    catch (e) { setSummaryError(String(e)); }
  };
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
  const wide = locale !== "zh";
  const channelNote = barkSet || ntfySet ? t("当前渠道：{ch}。推送由网页版服务（dispatch serve）每 20 秒检查一次，桌面应用不用开着。", { ch: ntfySet ? "ntfy" : "Bark" }) : t("还没配手机渠道：下面的事件只会以这台 Mac 的系统通知出现。");
  const tabItems: { key: SettingsTab; label: string }[] = [{ key: "general", label: t("通用") }, { key: "sessions", label: t("会话") }, { key: "ide", label: "IDE" }, { key: "phone", label: t("手机通知") }, { key: "env", label: t("环境") }, { key: "hosts", label: t("主机") }, { key: "about", label: t("关于") }];
  // Every tab stays mounted (hidden when not shown): typed-in drafts survive a tab switch.
  const panel = (key: SettingsTab, body: ReactNode) => <div className="g" role="tabpanel" hidden={tab !== key} aria-label={tabItems.find((i) => i.key === key)!.label}>{body}</div>;
  return (
    <div className="ld settings-page">
      <div className="ld-col">
        <Tabs items={tabItems} value={tab} onChange={pickTab} />
        <div className={`form${wide ? " wide-k" : ""}`}>
          {panel("general", <>
            <div className="fsec">{t("语言与外观")}</div>
            <Field k={t("界面语言")} help={t("跟随系统时按 macOS / 浏览器的语言自动选择；选定后立即生效。")}>
              <select className="ctl" value={localePref} onChange={(e) => setLocale(e.target.value as LocalePref)} aria-label={t("界面语言")}>
                <option value="system">{t("跟随系统")}</option>
                {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
              </select>
            </Field>
            <Field k={t("外观")} help={t("只影响这台电脑上的 Dispatch 窗口。")}>
              <Seg label={t("外观")} value={theme} onChange={onTheme} options={[["light", t("浅色")], ["dark", t("深色")], ["", t("跟随系统")]]} />
            </Field>
            <div className="fsec">{t("项目")}</div>
            <Field k={t("也算你的署名")} help={t("任务板上的署名默认是这台电脑的用户名。换过用户名、两台电脑用户名不一样、或早期记录用了别的名字时，把它们写在这里（逗号分隔），界面就都显示成「你」。")}>
              <input className="ctl wide" type="text" aria-label={t("也算你的署名")} value={draft.human_aliases} placeholder="alice, alice-macbook" onChange={(e) => setDraft({ ...draft, human_aliases: e.target.value })} />
            </Field>
            <Field k={t("工作区根目录")} help={<>{t("这些文件夹的直接子文件夹各算一个项目（例如 ~/Projects/kanban 下的会话都归 kanban）。其它位置按 git 仓库根目录归项目，没有仓库就按所在文件夹。一行一个。")} {t("有任务、有成果、手动关联过、在软件里新建过、收藏过，或在这些根目录下开过会话的，都算正式项目；其余只是「目录」，在项目页底部的「其他目录与未归类」里。")}</>}>
              <textarea className="ctl wide" rows={3} aria-label={t("工作区根目录")} value={draft.workspace_roots.join("\n")} onChange={(e) => setDraft({ ...draft, workspace_roots: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} placeholder="~/Projects" />
            </Field>
            <div className="fsec">{t("工作台")}</div>
            <Field k={t("已完成任务自动归档")} help={t("完成超过这些天的任务自动打上归档标记，从已完成列和计数里移开，「已归档」里能找到，随时可取消归档。填 0 表示不自动归档（看板上仍有「归档 30 天前完成的」按钮）。")}>
              <span className="settings-num"><input className="ctl" type="number" min={0} max={3650} aria-label={t("已完成任务多少天后自动归档")} value={draft.task_archive_days} onChange={(e) => num("task_archive_days", e.target.value, 3650)} /> {t("天")}</span>
            </Field>
          </>)}
          {panel("sessions", <>
            <div className="fsec">{t("会话")}</div>
            <Field k={t("自动归档")} help={t("收藏（追踪中）的会话不受影响；归档的会话在会话页「已归档」和 {mod}K 里还能找到。填 0 表示永不自动归档。")}>
              <span className="settings-num"><input className="ctl" type="number" min={0} max={3650} aria-label={t("普通会话多少天没有活动后自动归档")} value={draft.session_archive_days} onChange={(e) => num("session_archive_days", e.target.value, 3650)} /> {t("天没有活动")}</span>
            </Field>
            <Field k={t("空闲会话自动关掉")} help={t("Dispatch 里开着的会话空闲这么久，就关掉它在后台的进程；记录还在，再发一句会自动续上。填 0 表示不自动关。")}>
              <span className="settings-num"><input className="ctl" type="number" min={0} max={1440} aria-label={t("应用内会话空闲多少分钟后自动关掉")} value={draft.chat_idle_close_minutes} onChange={(e) => num("chat_idle_close_minutes", e.target.value, 1440)} /> {t("分钟没有动静")}</span>
            </Field>
            <Field k={t("总结用的模型")} help={t("订阅模型不用 Key、计入用量；API Key 的来自「环境」页里配的密钥。空着就自动选：设置 → 环境变量 SUMMARY_MODEL → 第一个可用的。下面决定总结显示在哪些地方。")}>
              <select className="ctl" value={draft.summary_model} onChange={(e) => { setDraft({ ...draft, summary_model: e.target.value }); setKeyValue(""); setSummaryError(""); }} aria-label={t("总结用的模型")}><option value="">{t("自动")}</option>{options.map((p) => <option key={p.id} value={p.id}>{summaryOptionLabel(p)}</option>)}{draft.summary_model && !options.some((p) => p.id === draft.summary_model) && <option value={draft.summary_model}>{t("{model}（当前不可用）", { model: draft.summary_model })}</option>}</select>
              {keyTarget && <div className="summary-key-row">
                <input className="ctl wide" type="password" autoComplete="off" aria-label={t("{provider} 的 API Key", { provider: keyTarget.provider })} placeholder={t("粘贴 {env} 的值（只存到本机 dispatch env）", { env: keyTarget.env })} value={keyValue} onChange={(e) => setKeyValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }} />
                <button className="btn" disabled={keyBusy || !keyValue.trim()} onClick={() => void saveKey()}>{keyBusy ? t("保存中…") : t("保存 Key")}</button>
              </div>}
              {summaryError && <span className="setup-bad">{summaryError}</span>}
            </Field>
            {uses.length > 0 && <Field k={t("总结显示在")}>
              <div className="summary-uses">
                {uses.map((u) => (
                  <label key={u.key} className="check">
                    <input type="checkbox" checked={useOn(u)} onChange={(e) => void toggleUse(u.key, e.target.checked)} />
                    <span><b>{u.name}</b>{u.desc ? <span className="help"> {u.desc}</span> : null}{u.last ? <span className="help summary-use-last"> · {t("最近")}{u.last.tokens > 0 ? ` ${compactTokens(u.last.tokens)} token ·` : ""} {formatSummaryTime(u.last.at)}{u.last.model ? ` · ${u.last.model}` : ""}</span> : null}</span>
                  </label>
                ))}
              </div>
            </Field>}
            <Field k={t("不再自动选用的供应商")} help={t("逗号分隔，如 deepseek：有它的 Key 也不会被自动选中或当作回退；上面显式选它仍然可用。留空表示都可以用。")}>
              <input className="ctl wide" type="text" aria-label={t("不再自动选用的供应商")} value={draft.retired_providers} placeholder="deepseek, kimi" onChange={(e) => setDraft({ ...draft, retired_providers: e.target.value })} />
            </Field>
            <Field k={t("SDK 启动的会话当作定时会话")} help={<>{t("脚本或其他 Agent 通过 SDK 启动的会话，自动当作定时会话")}{t("。")}{t("定时会话不进「等我」、不发通知、不出现在工作台；会话页「定时」筛选里能看到。对单条会话手动标记过的，以手动为准。")}</>}>
              <label className="check"><input type="checkbox" checked={draft.sdk_sessions_scheduled} onChange={(e) => setDraft({ ...draft, sdk_sessions_scheduled: e.target.checked })} />{t("启用")}</label>
            </Field>
            <div className="fsec">{t("讨论")}</div>
            <p className="fnote">{t("「讨论一个念头」里每个成员的人设和群里的规矩，进它们的系统提示；每轮只再给新消息。空着就用默认。")}</p>
            <Field k={t("群里的规矩")} help={t("发言多长、什么时候闲聊、什么时候只回 SKIP（不显示）。")}>
              <textarea className="ctl wide" rows={3} aria-label={t("群里的规矩")} value={draft.discuss_rules} onChange={(e) => setDraft({ ...draft, discuss_rules: e.target.value })} />
            </Field>
            {([["discuss_persona_claude", "Claude 的人设"], ["discuss_persona_codex", "Codex 的人设"], ["discuss_persona_pi", "pi 的人设"]] as const).map(([k, label]) => (
              <Field key={k} k={t(label)} help={t("一句话：关注什么、怎么表达、习惯质疑什么。")}>
                <textarea className="ctl wide" rows={2} aria-label={t(label)} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
              </Field>
            ))}
          </>)}
          {panel("ide", <IdeTab api={api} draft={draft} setDraft={setDraft} options={options} active={tab === "ide"} onEnv={() => pickTab("env")} />)}
          {panel("phone", <>
            <p className="fnote">{t("网页版弹不出系统通知，所以推送走手机上的 Bark（iOS，App Store 免费）或 ntfy（iOS / Android，免费开源）：装好 App，把它给你的 key 或主题地址填在这里，Dispatch 就会把事件推到手机，点通知直接打开对应页面。两个都没配就只发这台 Mac 的系统通知。")}</p>
            <div className="fsec">{t("推送渠道")}</div>
            <Field k="Bark" help={t("Bark App 首页那串 key（或整条 https://api.day.app/… 地址）")}>
              <span className="settings-inline"><input className="ctl wide" type="text" aria-label="Bark" value={barkKey} placeholder={barkSet ? t("已配置，留空表示不改") : "xxxxxxxxxxxxxxxxxxxx"} onChange={(e) => setBarkKey(e.target.value)} /><button className="btn" disabled={!barkKey.trim() || channelBusy} onClick={() => void saveChannel("BARK_KEY", barkKey)}>{t("保存")}</button>{barkSet && <button className="btn" disabled={channelBusy} onClick={() => void clearChannel("BARK_KEY")}>{t("清除")}</button>}</span>
            </Field>
            <Field k="ntfy" help={t("ntfy 的主题地址，例如 https://ntfy.sh/你的主题（自建服务器也行）；Bark 和 ntfy 都配了以 ntfy 为准")}>
              <span className="settings-inline"><input className="ctl wide" type="text" aria-label="ntfy" value={ntfyUrl} placeholder={ntfySet ? t("已配置，留空表示不改") : "https://ntfy.sh/your-topic"} onChange={(e) => setNtfyUrl(e.target.value)} /><button className="btn" disabled={!ntfyUrl.trim() || channelBusy} onClick={() => void saveChannel("NTFY_URL", ntfyUrl)}>{t("保存")}</button>{ntfySet && <button className="btn" disabled={channelBusy} onClick={() => void clearChannel("NTFY_URL")}>{t("清除")}</button>}</span>
            </Field>
            <p className="fnote">{channelNote}</p>
            <div className="fsec">{t("推送哪些事件")}</div>
            {([["notify_reply", t("Agent 回复了（本轮结束、还没看）"), t("正文带回复的开头，点开直接进会话")], ["notify_attention", t("Agent 等你确认 / 提问"), t("停在权限确认或问题上，高优先级")], ["notify_done", t("任务完成（dispatch done）"), t("Agent 关掉一个任务时")], ["notify_needs_you", t("只有你能做（dispatch need-you）"), t("Agent 记下一件要你亲自做的事，高优先级")]] as const).map(([k, label, hint]) => (
              <Field key={k} k={label} help={hint}>
                <label className="check"><input type="checkbox" checked={draft[k]} aria-label={label} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />{t("推送")}</label>
              </Field>
            ))}
            {onTestNotify && <Field k={t("试一下")} help={t("发一条测试通知到当前渠道。命令行：dispatch notify \"标题\" \"正文\"")}>
              <button className="btn" disabled={notifying} onClick={async () => { setNotifying(true); try { await onTestNotify(); } finally { setNotifying(false); } }}>{notifying ? t("发送中…") : t("发一条测试通知")}</button>
            </Field>}
          </>)}
          {panel("env", api
            ? <><p className="fnote">{t("API Key 和其他密钥，Agent 需要时自己取。总结用的模型也从这里拿 Key。")}</p><EnvView api={api} hosts={hosts} hostId={hostId} onDone={onDone ?? (() => {})} onError={onError ?? (() => {})} /></>
            : <p className="fnote">{t("连上任务板后才能管理密钥。")}</p>)}
          {panel("hosts", <>
            <div className="fsec">{t("这台电脑")}</div>
            {isWindows && <Field k={t("屏幕访问")} help={t("Windows 版暂不支持，Mac 上可用。")}><span className="muted">{t("不可用")}</span></Field>}
            {onScreen && !isWindows && <Field k={t("屏幕访问")} help={<>{screenReady ? t("手机连上 Tailscale 后，用浏览器打开这个链接就能看到并操作这台电脑的屏幕（noVNC），登录用这台 Mac 的用户名和密码。") : t("在这台 Mac 的终端里跑 dispatch screen setup，装好 noVNC 与常驻服务、开通 Tailscale HTTPS；屏幕共享这个开关只能你自己在系统设置里打开。")}</>}>
              <span className="settings-inline">
                <button className="btn" disabled={!screenReady} onClick={onScreen}>{t("复制屏幕链接")}</button>
              </span>
              {screen?.url ? <code className="help mono">{screen.url}</code> : screen?.issue ? <span className="help">{screen.issue}</span> : null}
            </Field>}
            {hosts.length > 0 && <>
              <div className="fsec">{t("机器")}</div>
              <Field k={t("机器")} help={t("来自 ~/tasks/.dispatch/hosts.json；侧栏可按机器筛选。要加一台：在那台电脑上装 Dispatch，走首次设置时选「接入」并填这台的地址；或者在这台上「接入另一台」。改名会同步推给已知的机器；删除后本机不再尝试连接它。")}>
                <div className="host-list">
                  {hosts.map((h) => {
                    const key = hostKey(h);
                    const rowBusy = hostBusyId === key;
                    return (
                      <div key={key} className="host-row">
                        <span className={`dot${h.online ? " on" : ""}`} title={h.ip} />
                        {renamingId === key ? (
                          <>
                            <input className="ctl host-name-input" autoFocus value={nameDraft} aria-label={t("机器名")} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void confirmRename(h); if (e.key === "Escape") setRenamingId(null); }} />
                            <button className="btn ghost sm" disabled={rowBusy} onClick={() => void confirmRename(h)}>{t("保存")}</button>
                            <button className="btn ghost sm" disabled={rowBusy} onClick={() => setRenamingId(null)}>{t("取消")}</button>
                          </>
                        ) : (
                          <>
                            <span className="host-name" title={h.ip}>{h.name}{h.local ? t("（本机）") : ""}</span>
                            {onRenameHost && <button className="btn ghost sm" disabled={rowBusy} onClick={() => startRename(h)}>{rowBusy ? "…" : t("改名")}</button>}
                            {onRedetectHost && !h.local && <button className="btn ghost sm" disabled={rowBusy} onClick={() => void redetectHost(h)}>{t("重新检测")}</button>}
                            {onDeleteHost && !h.local && <button className="btn ghost sm danger" disabled={rowBusy} onClick={() => void deleteHost(h)}>{pendingDeleteId === key ? t("再点一次确认删除") : t("删除")}</button>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Field>
            </>}
          </>)}
          {panel("about", <>
            {onCheckUpdate && <Field k={t("版本与更新")} help={<>{t("当前 v{v}", { v: update?.current ?? "…" })}{update?.latest ? t("，最新 v{v}", { v: update.latest }) : ""}{update?.newer ? t("，有新版本") : update?.latest ? t("，已是最新") : ""}{t("。")}{update?.error ? update.error : t("网页版只能查看版本；更新在 Mac 上的 Dispatch.app 里做。")}</>}>
              <span className="settings-inline"><button className="btn" disabled={checking} onClick={async () => { setChecking(true); try { await onCheckUpdate(); } finally { setChecking(false); } }}>{checking ? t("检查中…") : t("检查更新")}</button></span>
            </Field>}
            <Field k={t("设置存在哪")} help={t("存在共享任务板上，两台 Mac 一致；命令行 dispatch settings 读写同一份。外观只存在这台电脑。")}>
              <code className="mono settings-where">dispatch settings</code>
            </Field>
          </>)}
        </div>
        {dirty && <div className="settings-save" role="region" aria-label={t("未保存的改动")}>
          <span>{t("有未保存的改动")}</span><span className="sp" />
          <button className="btn ghost" disabled={busy} onClick={() => setDraft(settings)}>{t("还原")}</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? t("保存中…") : t("保存")}</button>
        </div>}
      </div>
    </div>
  );
}
