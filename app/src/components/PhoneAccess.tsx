import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import { useT } from "../i18n";

export interface ServeStatus { installed: boolean; loaded: boolean; running: boolean; address: string; port: number; tailscale: boolean; tailscale_ip: string; lan_ip: string; allow_lan: boolean; phone_reachable: boolean; log: string; built: boolean }
const parse = <T,>(s: string): T => JSON.parse(s.slice(Math.max(0, s.indexOf("{"))));

/** Phone access, from nothing to a scannable QR: the always-on service is installed from here
 *  (`dispatch serve install`), and the QR only appears once something actually answers at that address. */
export function PhoneAccess({ api, onDone, onError, compact = false }: { api: Api; onDone: (m: string) => void; onError: (m: string) => void; compact?: boolean }) {
  const t = useT();
  const [st, setSt] = useState<ServeStatus | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [lan, setLan] = useState(false);
  const load = useCallback(async () => {
    try {
      const s = parse<ServeStatus>(await api.on("local", ["serve", "status", "--json"]));
      setSt(s); setLan(s.allow_lan);
      if (s.running && s.phone_reachable) { try { setQr((await api.on("local", ["serve", "qr", "--svg"])).trim()); } catch { setQr(""); } } else setQr("");
    } catch (e) { onError(String(e)); }
  }, [api, onError]);
  useEffect(() => { void load(); }, [load]);
  const install = async (allowLan: boolean) => {
    setBusy(true);
    try { const s = parse<ServeStatus>(await api.on("local", ["serve", "install", allowLan ? "--lan" : "--no-lan", "--json"])); setSt(s); onDone(s.running ? t("手机访问已开启") : t("常驻服务装好了，但还没应答，稍等几秒再看")); await load(); }
    catch (e) { onError(String(e).replace(/^Error: /, "")); } finally { setBusy(false); }
  };
  const uninstall = async () => {
    setBusy(true);
    try { await api.on("local", ["serve", "uninstall", "--json"]); onDone(t("手机访问已关闭")); await load(); }
    catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const copy = async () => { try { const url = (await api.on("local", ["serve", "url"])).trim(); await api.copy(url); onDone(t("手机访问链接已复制：在手机浏览器里打开一次就记住了，可添加到主屏幕")); } catch (e) { onError(String(e).replace(/^Error: /, "")); } };
  if (!st) return <p className="muted small">{t("正在检查手机访问…")}</p>;
  const where = st.tailscale ? t("Tailscale 地址 {ip}：手机也登录同一个 Tailscale 账号，在哪都能连", { ip: st.tailscale_ip }) : st.allow_lan ? t("局域网地址 {ip}：手机和这台电脑在同一个 Wi‑Fi 时能连", { ip: st.lan_ip }) : t("只监听这台电脑自己：手机连不上");
  return <div className="phone-access">
    <p className="muted small">{st.running ? t("已开启 · {where}", { where }) : st.installed ? t("常驻服务已装，但现在没有应答（日志：{log}）", { log: st.log }) : t("还没开启。开启后这台电脑会常驻一个网页服务，开机自动启动；手机扫码打开同一套界面，能看进展、回复原会话。")}</p>
    {!st.tailscale && <label className="check"><input type="checkbox" checked={lan} disabled={busy} onChange={(e) => { setLan(e.target.checked); if (st.installed) void install(e.target.checked); }} /> {t("没装 Tailscale：允许同一 Wi‑Fi / 局域网里的设备访问（要有带令牌的链接才进得来；在公共 Wi‑Fi 上建议关掉）")}</label>}
    {!st.built && <p className="setup-bad">{t("这个安装包里没有网页资源，开不了手机访问。")}</p>}
    <div className="settings-inline">
      {!st.installed && <button className="btn primary sm" disabled={busy || !st.built} onClick={() => void install(lan)}>{busy ? t("开启中…") : t("开启手机访问")}</button>}
      {st.installed && !st.running && <button className="btn sm" disabled={busy} onClick={() => void install(lan)}>{busy ? t("重启中…") : t("重新启动服务")}</button>}
      {st.running && st.phone_reachable && <button className="btn sm" onClick={() => void copy()}>{t("复制链接")}</button>}
      {st.installed && !compact && <button className="btn sm" disabled={busy} onClick={() => void uninstall()}>{t("关闭手机访问")}</button>}
    </div>
    {st.running && !st.phone_reachable && <p className="muted small">{t("要让手机连上：装 Tailscale（推荐，出门也能用），或勾上面的「允许局域网」。")}</p>}
    {qr && <><p className="muted small">{t("用手机相机扫这个二维码（里面带登录令牌，只在这里显示，扫一次就记住）：")}</p><div className="settings-qr" dangerouslySetInnerHTML={{ __html: qr }} /></>}
  </div>;
}
