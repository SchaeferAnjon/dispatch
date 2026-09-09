import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// A script error in the desktop webview has no console anyone can see: surface it in the page instead
// of leaving a frozen screen. Click the strip to copy the text for a bug report.
function showFatal(kind: string, detail: string) {
  let el = document.getElementById("fatal-strip");
  if (!el) { el = document.createElement("div"); el.id = "fatal-strip"; el.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b42318;color:#fff;font:12px/1.4 -apple-system,system-ui,sans-serif;padding:8px 12px;white-space:pre-wrap;max-height:40vh;overflow:auto;cursor:pointer"); el.title = "点击复制"; el.onclick = () => { void navigator.clipboard?.writeText(el!.textContent || ""); }; document.body.appendChild(el); }
  el.textContent = `界面出错了（${kind}），刷新可恢复；请把这段发给开发者：\n${detail}`.slice(0, 4000);
}
// console.error from the app (swallowed polling failures, React warnings) lands in the same strip.
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => { origError(...args); showFatal("console", args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
window.addEventListener("error", (e) => showFatal("error", `${e.message}\n${(e.error as Error | undefined)?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (e) => { const r = (e as PromiseRejectionEvent).reason as { message?: string; stack?: string } | string; showFatal("promise", typeof r === "string" ? r : `${r?.message ?? String(r)}\n${r?.stack ?? ""}`); });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
