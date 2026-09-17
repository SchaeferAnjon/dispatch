import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initLocale, t } from "./i18n";
// Fonts ship with the app (Fontsource, OFL): no request to Google at every cold start, and the
// first screen does not wait on a network that may be slow or blocked.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";

// A script error in the desktop webview has no console anyone can see: surface it in the page instead
// of leaving a frozen screen. Click the strip to copy the text for a bug report.
// @assistant-ui/tap throws this when React discards a render mid-way (a poll landed while the
// thread was rendering) and a store update later reaches the never-mounted fiber. The committed
// thread is unaffected, so it is noise here — nothing to fix on our side while the library does it.
const IGNORED = /Resource updated before mount/;
function showFatal(kind: string, detail: string) {
  if (IGNORED.test(detail)) return;
  let el = document.getElementById("fatal-strip");
  if (!el) { el = document.createElement("div"); el.id = "fatal-strip"; el.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b42318;color:#fff;font:12px/1.4 -apple-system,system-ui,sans-serif;padding:8px 12px;white-space:pre-wrap;max-height:40vh;overflow:auto;cursor:pointer"); el.title = t("点击复制"); el.onclick = () => { void navigator.clipboard?.writeText(el!.textContent || ""); }; document.body.appendChild(el); }
  el.textContent = `${t("界面出错了（{kind}），刷新可恢复；请把这段发给开发者：", { kind })}\n${detail}`.slice(0, 4000);
  // It must never trap the page under it (the phone's reply box sits at the bottom): ✕ dismisses it.
  const close = document.createElement("button");
  close.textContent = "✕"; close.setAttribute("aria-label", t("关闭"));
  close.setAttribute("style", "position:absolute;top:4px;right:8px;background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;padding:4px 8px");
  close.addEventListener("click", (e) => { e.stopPropagation(); el?.remove(); });
  el.appendChild(close);
}
// console.error from the app (swallowed polling failures, React warnings) lands in the same strip.
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => { origError(...args); showFatal("console", args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
window.addEventListener("error", (e) => showFatal("error", `${e.message}\n${(e.error as Error | undefined)?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (e) => { const r = (e as PromiseRejectionEvent).reason as { message?: string; stack?: string } | string; showFatal("promise", typeof r === "string" ? r : `${r?.message ?? String(r)}\n${r?.stack ?? ""}`); });

initLocale();
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
