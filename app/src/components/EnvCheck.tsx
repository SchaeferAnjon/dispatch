import { useState } from "react";
import type { Api, EnvReport } from "../api";
import { useT } from "../i18n";

const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Shown instead of the first-run guide when the bundled CLI cannot start at all (no Python, or
 *  one too old): everything else in the app goes through that CLI, so say what is missing and
 *  how to fix it, instead of an empty workbench. The report comes from Rust, not from Python. */
export function EnvCheck({ api, report, error, onRetry }: { api: Api; report: EnvReport | null; error: string; onRetry: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const copy = async (cmd: string) => { try { await api.copy(cmd); setCopied(cmd); window.setTimeout(() => setCopied(""), 1500); } catch { /* clipboard unavailable */ } };
  const retry = async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } };
  const py = report?.python;
  const rows: { name: string; ok: boolean; detail: string; fix?: string; why: string; optional?: boolean }[] = report ? [
    { name: "Python", ok: !!py?.ok, detail: py?.ok ? `${py.version ?? ""} · ${py.path ?? ""}` : t("没找到 3.9 或更新的版本"), why: t("运行 Dispatch 自带的命令行（需要 3.9 或更新）"), fix: report.brew ? "brew install python@3.12" : "xcode-select --install" },
    { name: "Homebrew", ok: !!report.brew, detail: report.brew ?? t("没装"), why: t("macOS 的包管理器，下面几样都靠它装"), fix: BREW_INSTALL },
    { name: "git", ok: !!report.git, detail: report.git ?? t("没装（系统自带的只是占位）"), why: t("项目页的提交记录、项目迁移、看屏幕的安装都要它"), fix: report.brew ? "brew install git" : "xcode-select --install" },
    { name: "dolt", ok: !!report.dolt, detail: report.dolt ?? t("没装"), why: t("任务板的数据库（带版本历史，能在两台电脑之间同步）"), fix: "brew install dolt" },
    { name: "bd", ok: !!report.bd, detail: report.bd ?? t("没装"), why: t("任务板本身（Beads），Agent 用它记任务"), fix: "brew install beads" },
    { name: "herdr", ok: !!report.herdr, detail: report.herdr ?? t("没装"), why: t("终端里的 Agent 多路复用器，Dispatch 用它派活给 Agent"), fix: "brew install herdr" },
    { name: "tmux", ok: !!report.tmux, detail: report.tmux ?? t("没装"), why: t("让 Herdr 在后台常驻，Dispatch 随时能把活派给 Agent（不用先开终端）"), fix: "brew install tmux" },
    { name: "Tailscale", ok: !!report.tailscale, detail: report.tailscale ?? t("没装（可选）"), why: t("两台电脑不在同一 Wi‑Fi 时互相访问；只有一台电脑可以不装"), optional: true },
  ] : [];
  return <div className="setup env-check">
    <header className="setup-head"><h2>{t("先检查这台电脑的环境")}</h2><p className="muted">{t("Dispatch 的命令行没能启动，所以首次设置还打不开。下面是这台电脑上找到和没找到的东西：照着装好带 ✗ 的，再点「重新检查」。")}</p></header>
    {report && <p className="muted small">macOS {report.macos} · {report.arch}{report.clt ? "" : ` · ${t("还没装 Xcode 命令行工具")}`}</p>}
    {rows.length > 0 && <ul className="setup-deps env-rows">{rows.map((r) => <li key={r.name} className={r.ok ? "ok" : r.optional ? "opt" : "miss"}>
      <span className="mark">{r.ok ? "✓" : r.optional ? "·" : "✗"}</span><b className="mono">{r.name}</b>
      <span className="muted">{r.why}<br /><code className="small">{r.detail}</code></span>
      {!r.ok && r.fix && <button className="btn sm" onClick={() => void copy(r.fix!)} title={r.fix}>{copied === r.fix ? t("已复制") : t("复制安装命令")}</button>}
    </li>)}</ul>}
    {report && !report.cli_exists && <p className="setup-bad">{t("应用包里没找到命令行文件：{path}。重新下载 Dispatch 再试。", { path: report.cli })}</p>}
    {error && <details className="env-error"><summary>{t("原始错误")}</summary><pre className="setup-log">{error}</pre></details>}
    <p className="muted small">{t("装命令：打开「终端」粘贴并回车。Homebrew 会问管理员密码；xcode-select 会弹一个系统安装窗口，装完再回来。")}</p>
    <button className="btn primary" disabled={busy} onClick={() => void retry()}>{busy ? t("检查中…") : t("重新检查")}</button>
  </div>;
}
