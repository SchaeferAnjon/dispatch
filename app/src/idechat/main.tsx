// Dispatch IDE's chat column: the conversation Dispatch opened this folder for, with the same
// ChatPage as Dispatch (history, live turns, tool lines, permission cards, composer).
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Host, SessionDetail } from "../types";
import { ChatPage, isLiveView, lifeLabelOf } from "../components/ChatPage";
import { useChatSession } from "../chatStore";
import { splitKey } from "../chatProtocol";
import { detectLocale, setLocale, useT } from "../i18n";
import { api, onPage, parseJson, send, type PanelInit } from "./bridge";
import { openMenu } from "./menu";
import { NewConversation } from "./NewConversation";
import { handoverToDispatch } from "../components/SessionActions";
import "../styles.css";
import "../conversation.css";
import "./idechat.css";

// No macOS menus in the IDE: a click (or ↵ / space / ↓) on a composer <select> opens the menu above the chip (menu.ts).
// the whole chip counts (its text and the arrow), not only the <select> inside it
const selectOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLSelectElement>("select") ?? t.closest(".dd")?.querySelector<HTMLSelectElement>("select") ?? null : null);
document.addEventListener("mousedown", (e) => { const s = selectOf(e.target); if (!s) return; e.preventDefault(); s.focus(); openMenu(s); }, true);
document.addEventListener("keydown", (e) => { const s = selectOf(e.target); if (!s || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return; e.preventDefault(); openMenu(s); }, true);

// how long the column takes to show something (the extension logs it: 「chat timing」 in the Dispatch output)
const T = { bundle: performance.now(), init: 0, detail: 0, paint: 0, sent: false };

function Panel() {
  const t = useT();
  const [init, setInit] = useState<PanelInit | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [insert, setInsert] = useState<{ text: string; token: number } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => onPage((m) => {
    if (m.kind === "init") {
      if (!T.init) T.init = performance.now();
      setLocale(detectLocale(m.init.language));
      // VS Code's theme, not Dispatch's: idechat.css maps the tokens to --vscode-* (light keeps Dispatch's dark blocks off)
      document.documentElement.dataset.theme = "light";
      document.documentElement.dataset.vs = m.init.dark ? "dark" : "light";
      setInit(m.init);
    } else if (m.kind === "focus") document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    // 任务 / 改动 / 产物: the view title bar has the button; the page's own title row is hidden
    else if (m.kind === "drawer") document.querySelector<HTMLButtonElement>(".chat-page .ch button[aria-pressed]")?.click();
    else if (m.kind === "fresh") {
      if (m.key === "hosts --json") setHosts(parseJson<Host[]>(m.result));
      else if (m.key.startsWith("session ")) { const d = parseJson<SessionDetail>(m.result); setDetail((cur) => (cur && cur.meta.session_id === d.meta.session_id) ? d : cur); }
    } else if (m.kind === "insert") setInsert((p) => ({ text: m.text, token: (p?.token ?? 0) + 1 }));
  }), []);
  useEffect(() => { send({ kind: "ready" }); void api.hosts().then(setHosts).catch(() => {}); }, []);
  const session = init?.session ?? null;
  useEffect(() => {
    setDetail(null);
    const id = session ? splitKey(session)?.id : null;
    if (!id) return;
    let alive = true;
    api.sessionDetail(id).then((d) => { if (!T.detail) T.detail = performance.now(); if (alive) setDetail(d); }).catch(() => { /* a brand-new chat has no transcript yet */ });
    return () => { alive = false; };
  }, [session]);
  // one title row: the conversation's name and state go into VS Code's view title
  const live = useChatSession(api, session);
  const state = session ? lifeLabelOf(live.view && isLiveView(live.view) ? live.view : null) : "";
  // no title yet: the folder, never a 「（无标题）」 placeholder
  const name = detail?.meta.title_override || detail?.meta.title || (init?.root.split("/").filter(Boolean).pop() ?? "");
  useEffect(() => { send({ kind: "title", title: name, state }); }, [name, state]);
  // still reading the transcript after 120 ms: skeleton rows instead of an empty column (DESIGN.md 动效表)
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!session || detail) return;
    const tm = window.setTimeout(() => setSlow(true), 120);
    return () => window.clearTimeout(tm);
  }, [session, !!detail]);  // eslint-disable-line react-hooks/exhaustive-deps
  // first real content: the transcript, or the new-conversation composer
  const shown = !!init && (!session || !!detail);
  useEffect(() => {
    if (!shown || T.sent) return;
    T.paint = performance.now(); T.sent = true;
    requestAnimationFrame(() => send({ kind: "timing", origin: performance.timeOrigin, bundle: T.bundle, init: T.init, detail: T.detail || undefined, paint: T.paint }));
  }, [shown]);
  if (!init) return <div className="ic-empty muted">{t("连接中")}</div>;
  if (!session) return <NewConversation root={init.root} hosts={hosts} />;
  return <div className="ic">
    {(name || state) && <div className="ic-head" title={name}>{name && <b>{name}</b>}{state && <span className={name ? "" : "only"}>{state}</span>}</div>}
    <ChatPage compact api={api} session={session} detail={detail} hosts={hosts}
      title={detail?.meta.title_override || detail?.meta.title}
      onHandover={() => { const k = splitKey(session); if (k) void handoverToDispatch(api, api, { agent: k.agent, session_id: k.id, cwd: detail?.meta.cwd || init.root }).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))); }} onClose={() => send({ kind: "close" })}
      onOpenFile={(path, line) => send({ kind: "openFile", path, line })}
      insertText={insert} onError={setErr} />
    {slow && !detail && <div className="ic-skel" aria-hidden="true"><i className="b" /><i className="l" /><i className="l s" /><i className="t" /><i className="l m" /></div>}
    {err && <div className="ic-err" role="alert" onClick={() => setErr("")}>{err}</div>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Panel /></StrictMode>);
