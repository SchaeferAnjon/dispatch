// Knowledge: what every agent knows about the person and their work, in the Agents window's Customizations
// (Dispatch IDE, patches/525-knowledge.patch), direction B of design/knowledge/redesign.
// The page answers "what does Dispatch know about me" first: a box like Overview's "Customize Your Agent"
// with the preferences agents follow most, the ones remembered since the last visit and what is coming up
// in Profile; under it five entries like Overview's cards (Preferences, Profile, Facts, Wiki, Engine
// memory). Lists are Skills' stacked groups (a head, one line saying what the group holds, a box of rows);
// one entry has a breadcrumb back. Preferences come from `dispatch prefs`, remembered from the person's
// feedback on deliveries, each with their words and the part it hangs on; the evidence opens in the right
// panel, like a task's deliverable. The window hosts this page in a webview and passes its calls to
// dispatch-bridge's `dispatch.knowledge` (ide-ext/src/knowledge.ts); built by vite.knowledge.config.ts into
// ide-ext/media/knowledge.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  changedFields, factRows, fieldValues, filterRows, groupsOf, kindInfo, KINDS, newestFirst, profileRows, shortDate, wikiRows,
  type Area, type FactTopic, type Profile, type Row, type WikiItem, type WikiKind,
} from "./model";
import {
  aboutCount, aboutSoon, appliesTo, areaLabel, dayLabel, engineName, eventLine, evidenceCards, filterPrefs, isActive, momentLabel,
  PREF_AREAS, prefGroups, regionOf, rememberedLine, saidAt, scopeAndDay, topPrefs, usedLine, whereFrom,
  type EvidenceCard, type Polarity, type Pref, type PrefArea, type PrefList,
} from "./prefs";
import "./knowledge.css";

// ---- the host ------------------------------------------------------------------------------------

interface VsCode { postMessage(m: unknown): void }
declare function acquireVsCodeApi(): VsCode;
const vscode = acquireVsCodeApi();
let seq = 0;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
type HostMessage =
  | { kind: "reply"; id: number; ok: boolean; result?: unknown; error?: string }
  | { kind: "navigate"; view: "home" | "prefs" | "pref"; id?: string; edit?: boolean }
  | { kind: "changed"; what?: string };
const hostListeners = new Set<(m: HostMessage) => void>();
window.addEventListener("message", (ev: MessageEvent) => {
  const m = ev.data as HostMessage;
  if (m?.kind === "reply") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.res(m.result);
    else p.rej(new Error(m.error || "Failed"));
    return;
  }
  if (m?.kind === "navigate" || m?.kind === "changed") hostListeners.forEach((f) => f(m));
});
function call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    pending.set(id, { res: res as (v: unknown) => void, rej });
    vscode.postMessage({ kind: "call", id, op, payload });
  });
}
/** A Markdown file at a line, in the window's editor (FACTS.md, PROFILE.md, where a preference came from). */
const openFile = (path: string, line: number) => vscode.postMessage({ kind: "openFile", path, line });
/** Evidence in the right panel, the way a task's deliverable opens: a page in the browser tab, an image in the preview. */
const openEvidence = (target: string) => vscode.postMessage({ kind: "openEvidence", target });
/** The session the words were said in, at the message. */
const openSession = (session: string, at: string, engine: string) => vscode.postMessage({ kind: "openSession", session, at, engine });
const reveal = (path: string) => vscode.postMessage({ kind: "reveal", path });
// links in entries open outside the page; the webview itself never navigates
document.addEventListener("click", (e) => {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ kind: "open", href: a.getAttribute("href") });
});

const md = (s: string) => DOMPurify.sanitize(marked.parse(s, { async: false, breaks: true }) as string);

// ---- icons: single-colour line icons in the codicon manner (no colour: DESIGN.md) ----------------

const ICONS: Record<string, string> = {
  win: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM5.5 8.2l1.8 1.8 3.3-3.6",
  pit: "M8 2.2l6.2 11H1.8zM8 6.5v3M8 11.4v.1",
  retro: "M2.5 8A5.5 5.5 0 1 0 4.1 4.1M2.2 2.5v2.3h2.3M8 5v3.2l2 1.3",
  howto: "M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z",
  wiki: "M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z",
  fact: "M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.5 8h5M5.5 10.5h5",
  facts: "M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.5 8h5M5.5 10.5h5",
  me: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4",
  person: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4",
  device: "M2.5 3.5h11v7h-11zM6 13h4M8 10.5V13",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  history: "M2.5 8A5.5 5.5 0 1 0 4.1 4.1M2.2 2.5v2.3h2.3M8 5v3.2l2 1.3",
  chevron: "M6 4l4 4-4 4",
  plus: "M8 3v10M3 8h10",
  like: "M5 7.2v6.3H2.5V7.2zM5 7.2 7.6 2c1.1 0 1.8.8 1.6 1.9L8.8 6H12a1.3 1.3 0 0 1 1.3 1.5l-.9 4.9a1.3 1.3 0 0 1-1.3 1.1H5",
  avoid: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM4.1 11.9l7.8-7.8",
  bookmark: "M4.5 2.5h7v11L8 11l-3.5 2.5z",
  sparkle: "M8 1.5c.4 3.4 1.6 4.8 5 5.5-3.4.7-4.6 2.1-5 5.5-.4-3.4-1.6-4.8-5-5.5 3.4-.7 4.6-2.1 5-5.5z",
  archive: "M2 3h12v3.2H2zM3 6.2v7.3h10V6.2M6.5 9h3",
  quote: "M3 11.5c0-4 1.2-6 3.5-7M3.2 9.3h2.6v3H3.2zM9.2 11.5c0-4 1.2-6 3.5-7M9.4 9.3H12v3H9.4z",
  layout: "M2 2.5h12v11H2zM2 6h12M6 6v7.5",
  image: "M2 3h12v10H2zM6 7.7a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM14 11l-3.5-3.5L4 13",
  globe: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM2 8h12M8 2c1.9 2 1.9 10 0 12M8 2c-1.9 2-1.9 10 0 12",
  undo: "M5 3.5 2.5 6 5 8.5M2.5 6H10a3.5 3.5 0 0 1 0 7H6",
  folder: "M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z",
  claude: "M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4",
  code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
};

function Icon({ name, className = "", size = 16 }: { name: string; className?: string; size?: number }) {
  return (
    <svg className={`ic ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] || ICONS.fact} />
    </svg>
  );
}
const PolIcon = ({ p, className = "" }: { p: { polarity: Polarity }; className?: string }) => (
  <Icon name={p.polarity === "avoid" ? "avoid" : "like"} className={className} />
);

function Loading() {
  return (
    <div className="loading" aria-label="Loading">
      {[72, 56, 64].map((w, i) => <div key={i} className="bar" style={{ width: `${w}%` }} />)}
    </div>
  );
}

/** A textarea that grows with its text. */
function Area_({ value, onChange, label, autoFocus, placeholder }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 360)}px`;
  }, [value]);
  return <textarea ref={ref} aria-label={label} className="input ta" value={value} autoFocus={autoFocus} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

// ---- a toast at the bottom of the page (Forgotten · Undo) -----------------------------------------

interface ToastState { text: string; undo?: () => void }
let showToast: (t: ToastState | null) => void = () => undefined;

function PageToast() {
  const [t, setT] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    showToast = (next) => {
      window.clearTimeout(timer.current);
      setT(next);
      if (next) timer.current = window.setTimeout(() => setT(null), 6000);
    };
    return () => { showToast = () => undefined; };
  }, []);
  if (!t) return null;
  return (
    <div className="toast" role="status"
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={() => { timer.current = window.setTimeout(() => setT(null), 3000); }}>
      <Icon name="undo" className="toast-ic" size={14} />
      <span className="toast-t">{t.text}</span>
      {t.undo && <button className="toast-b" onClick={() => { t.undo!(); setT(null); }}>Undo</button>}
    </div>
  );
}

// ---- data ----------------------------------------------------------------------------------------

const AREAS: { area: Area; label: string; icon: string; what: string }[] = [
  { area: "wiki", label: "Wiki", icon: "wiki", what: "What agents learned while working: wins, pitfalls, retros and how-tos." },
  { area: "facts", label: "Facts", icon: "facts", what: "Machines, accounts and services every project uses." },
  { area: "me", label: "Profile", icon: "me", what: "Who you are, your devices and what is coming up." },
];
const areaInfo = (a: Area) => AREAS.find((x) => x.area === a)!;
const WIKI_DESC: Record<string, string> = {
  Wins: "What worked, and why it did.",
  Pitfalls: "Traps agents fell into, and the way out.",
  Retros: "What went well and what went wrong on a task.",
  "How-tos": "Steps worth doing the same way again.",
};

interface MemoryFile { agent: string; path: string; project?: string; type?: string }

interface Data {
  wiki: WikiItem[] | null;
  facts: FactTopic[] | null;
  profile: Profile | null;
  prefs: PrefList | null;
  memories: MemoryFile[] | null;
  /** how many places an import would take preferences from (the empty state's button) */
  importPlaces: number;
  error: string;
}

function useData() {
  const [d, setD] = useState<Data>({ wiki: null, facts: null, profile: null, prefs: null, memories: null, importPlaces: 0, error: "" });
  // the preferences not seen before this visit: they stay under New until the page is opened again
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());
  const fail = (e: Error) => setD((x) => ({ ...x, error: e.message }));
  const loadWiki = useCallback(() => call<WikiItem[]>("wikiList").then((wiki) => setD((x) => ({ ...x, wiki })), fail), []);
  const loadFacts = useCallback(() => call<FactTopic[]>("factsList").then((facts) => setD((x) => ({ ...x, facts })), fail), []);
  const loadProfile = useCallback(() => call<Profile>("profileShow").then((profile) => setD((x) => ({ ...x, profile })), fail), []);
  const loadPrefs = useCallback(() => call<PrefList>("prefsList").then((prefs) => {
    setD((x) => ({ ...x, prefs }));
    const unseen = prefs.items.filter((p) => isActive(p) && !p.seen).map((p) => p.id);
    if (unseen.length) {
      setNewIds((s) => new Set([...s, ...unseen]));
      // seen means the person had the page in front of them: a reload while the page is hidden (an agent
      // remembered something in the background) waits until it shows
      const seen = () => void call("prefsSeen").catch(() => undefined);
      if (document.visibilityState === "visible") seen();
      else {
        const once = () => {
          if (document.visibilityState !== "visible") return;
          document.removeEventListener("visibilitychange", once);
          seen();
        };
        document.addEventListener("visibilitychange", once);
      }
    }
    if (!prefs.items.some(isActive)) {
      void call<{ plan: { places: Record<string, number> } }>("prefsImport", { apply: false })
        .then((r) => setD((x) => ({ ...x, importPlaces: Object.values(r.plan.places).filter((n) => n > 0).length })), () => undefined);
    }
  }, fail), []);
  const loadMemories = useCallback(() => call<MemoryFile[]>("memoriesList").then((memories) => setD((x) => ({ ...x, memories })), () => undefined), []);
  useEffect(() => {
    void loadPrefs();
    void loadProfile();
    void loadFacts();
    void loadWiki();
    void loadMemories();
    // FACTS.md / PROFILE.md edited in the editor: read them again when the page comes back into view
    const again = () => { if (document.visibilityState === "visible") { void loadFacts(); void loadProfile(); void loadPrefs(); } };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    const onHost = (m: HostMessage) => { if (m.kind === "changed") void loadPrefs(); };
    hostListeners.add(onHost);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); hostListeners.delete(onHost); };
  }, [loadWiki, loadFacts, loadProfile, loadPrefs, loadMemories]);
  return { d, setD, newIds, loadWiki, loadFacts, loadProfile, loadPrefs };
}

type View =
  | { layer: "home" }
  | { layer: "list"; area: Area }
  | { layer: "detail"; area: Area; id: string }
  | { layer: "new" }
  | { layer: "prefs" }
  | { layer: "pref"; id: string; edit?: boolean }
  | { layer: "prefNew" }
  | { layer: "memory" };

// ---- header --------------------------------------------------------------------------------------

function Crumbs({ parts, actions }: { parts: { label: string; go?: () => void }[]; actions?: ReactNode }) {
  return (
    <div className="head">
      <h1 className="crumbs">
        {parts.map((p, i) => (
          <span key={i} className={i === parts.length - 1 ? "here" : "up"}>
            {p.go ? <button className="crumb" onClick={p.go}>{p.label}</button> : p.label}
            {i < parts.length - 1 && <span className="sep" aria-hidden>{" › "}</span>}
          </span>
        ))}
      </h1>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

function Card({ icon, label, badge, text, go }: { icon: string; label: string; badge: string; text: string; go: () => void }) {
  return (
    <button className="card" onClick={go}>
      <span className="card-head"><Icon name={icon} className="dim" /><span className="card-label">{label}</span><span className="badge">{badge}</span></span>
      <span className="card-text">{text}</span>
    </button>
  );
}

// ---- layer 1: what Dispatch knows about you --------------------------------------------------------

function Home({ d, newIds, go, forget }: {
  d: Data; newIds: Set<string>; go: (v: View) => void; forget: (p: Pref) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const prefs = d.prefs?.items ?? null;
  const active = useMemo(() => (prefs ?? []).filter(isActive), [prefs]);
  const top = useMemo(() => topPrefs(active, newIds), [active, newIds]);
  const fresh = useMemo(() => active.filter((p) => newIds.has(p.id)), [active, newIds]);
  const soon = useMemo(() => aboutSoon(d.profile), [d.profile]);
  const wikiCount = d.wiki ? wikiRows(d.wiki).length : null;
  const memCount = d.memories ? d.memories.length : null;
  const n = (v: number | null, unit = "") => (v === null ? "…" : `${v}${unit}`);

  return (
    <>
      <Crumbs parts={[{ label: "Knowledge" }]} />
      <p className="lede">What agents know about you and your work. Every agent reads it at the start of a session.</p>
      <section className="know" aria-label="What Dispatch knows about you">
        <div className="know-h"><Icon name="sparkle" />What Dispatch knows about you</div>
        {prefs === null ? <Loading /> : !active.length ? (
          <div className="empty in-box">
            <Icon name="bookmark" size={24} />
            <div className="empty-t">Nothing remembered yet</div>
            <div className="empty-d">Your feedback on agents’ work lands here.</div>
            {d.importPlaces > 0 && <ImportButton places={d.importPlaces} onDone={() => go({ layer: "prefs" })} />}
          </div>
        ) : (
          <>
            <div className="know-sub">Agents read this at the start of every session. It grows as you tell them what you like.</div>
            <div className="know-cols">
              <div className="know-col">
                <div className="kh"><span>How you like things done</span><button className="lnk" onClick={() => go({ layer: "prefs" })}>See all {active.length}</button></div>
                {top.map((p) => (
                  <button key={p.id} className="kr" onClick={() => go({ layer: "pref", id: p.id })} title={p.text}>
                    <PolIcon p={p} className="dim" />
                    <span className="s">{p.text}</span>
                    <span className="m">{areaLabel(p.area)}</span>
                  </button>
                ))}
                {fresh.length > 0 && (
                  <div className="knew">
                    <Icon name="bookmark" className="dim" />
                    <span><b>{fresh.length} new</b> since you last looked</span>
                    <button className="lnk" aria-expanded={showNew} onClick={() => setShowNew(!showNew)}>{showNew ? "Hide" : "Show"}</button>
                  </div>
                )}
                {showNew && (
                  <div className="knew-list">
                    {fresh.map((p) => (
                      <div key={p.id} className="kr static" title={p.text}>
                        <PolIcon p={p} className="dim" />
                        <button className="s as-link" onClick={() => go({ layer: "pref", id: p.id })}>{p.text}</button>
                        <span className="rowacts">
                          <button className="btn ghost" onClick={() => go({ layer: "pref", id: p.id, edit: true })}>Edit</button>
                          <button className="btn ghost" onClick={() => forget(p)}>Forget</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="know-col">
                <div className="kh"><span>About you</span><button className="lnk" onClick={() => go({ layer: "list", area: "me" })}>See all {aboutCount(d.profile) || ""}</button></div>
                {d.profile === null ? <Loading /> : soon.length ? soon.map((s, i) => (
                  <button key={i} className="kr" onClick={() => go({ layer: "list", area: "me" })} title={s.text}>
                    <span className="d">{s.when}</span>
                    <span className="s">{s.text}</span>
                  </button>
                )) : <div className="kr static dim">Nothing coming up.</div>}
              </div>
            </div>
          </>
        )}
      </section>
      <h2 className="explore-h">Everything agents share</h2>
      <p className="explore-sub">Open one to see all of it.</p>
      <div className="cards">
        <Card icon="bookmark" label="Preferences" badge={prefs === null ? "…" : String(active.length)}
          text={active.length ? "How you like things done, with your words and the part you pointed at." : "Nothing yet."} go={() => go({ layer: "prefs" })} />
        <Card icon="person" label={areaInfo("me").label} badge={d.profile ? String(aboutCount(d.profile)) : "…"} text={areaInfo("me").what} go={() => go({ layer: "list", area: "me" })} />
        <Card icon="facts" label="Facts" badge={d.facts ? `${d.facts.length} topics` : "…"} text={areaInfo("facts").what} go={() => go({ layer: "list", area: "facts" })} />
        <Card icon="wiki" label="Wiki" badge={n(wikiCount)} text={areaInfo("wiki").what} go={() => go({ layer: "list", area: "wiki" })} />
        <Card icon="archive" label="Engine memory" badge={n(memCount, " files")} text="Notes Claude Code, Codex and ZCode keep for themselves. Read only." go={() => go({ layer: "memory" })} />
      </div>
    </>
  );
}

function ImportButton({ places, onDone }: { places: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button className="btn" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          await call("prefsImport", { apply: true });
          onDone();
        } catch (e) { setError((e as Error).message); setBusy(false); }
      }}>{busy ? "Importing…" : `Import from ${places} ${places === 1 ? "place" : "places"}`}</button>
      {error && <div className="err">{error}</div>}
    </>
  );
}

// ---- preferences: the list ---------------------------------------------------------------------------

function Chip({ p }: { p: Pref }) {
  if (!p.thumb) return null;
  const region = regionOf(p);
  return (
    <span className="part" title={p.part || (p.evidence ?? [])[0] || ""}>
      <img src={p.thumb} alt="" />
      <span>{region || (p.part ? "Whole delivery" : "Screenshot")}</span>
    </span>
  );
}

function PrefRow({ p, gone, open, keep, forget }: { p: Pref; gone: boolean; open: () => void; keep: () => void; forget: () => void }) {
  return (
    <div className={`row pref${gone ? " gone" : ""}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === "Enter") open(); }} title={p.text}>
      <PolIcon p={p} className="dim" />
      <span className="row-text">
        <span className="row-top">
          <span className="row-title wrap">{p.text}</span>
          <span className="row-meta">{scopeAndDay(p)}</span>
        </span>
        <span className="row-sub">
          <span className="row-summary">{whereFrom(p)}</span>
          <Chip p={p} />
        </span>
        {p.stale && (
          <span className="stale" onClick={(e) => e.stopPropagation()}>
            Not used in 3 weeks. Still true?
            <button className="btn" onClick={keep}>Yes</button>
            <button className="btn ghost" onClick={forget}>Forget</button>
          </span>
        )}
      </span>
    </div>
  );
}

function PrefsList({ d, newIds, home, open, onNew, forget, reload }: {
  d: Data; newIds: Set<string>; home: () => void; open: (p: Pref) => void; onNew: () => void; forget: (p: Pref) => void; reload: () => void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = d.prefs?.items ?? null;
  const groups = useMemo(() => (items ? prefGroups(filterPrefs(items, query), newIds) : []), [items, query, newIds]);
  const searching = !!query.trim();
  const toggle = (g: string) => setClosed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const drop = (p: Pref) => { setGone((s) => new Set([...s, p.id])); window.setTimeout(() => forget(p), 150); };
  const keep = (p: Pref) => { void call("prefsKeep", { id: p.id }).then(reload, () => undefined); };

  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: "Preferences" }]} />
      <p className="lede">How you like things done. Agents read these at the start of every session and follow them.</p>
      <div className="toolbar">
        <input ref={input} className="input search" aria-label="Search" placeholder="Type to search..." value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        <button className="btn" onClick={onNew}>New Preference</button>
      </div>
      {!items ? <Loading /> : !groups.length ? (
        <div className="box"><div className="empty">
          <Icon name="bookmark" size={24} />
          <div className="empty-t">{searching ? `Nothing matches “${query.trim()}”` : "Nothing remembered yet"}</div>
          <div className="empty-d">{searching ? "Try fewer words." : "Your feedback on agents’ work lands here."}</div>
          {!searching && d.importPlaces > 0 && <ImportButton places={d.importPlaces} onDone={reload} />}
        </div></div>
      ) : (
        <div className="secs">
          {groups.map((g) => {
            const isClosed = !searching && closed.has(g.id);
            return (
              <section key={g.id} className={`sec${isClosed ? " closed" : ""}`}>
                <button className="section-head" aria-expanded={!isClosed} onClick={() => toggle(g.id)}>
                  <Icon name="chevron" className={`chev${isClosed ? "" : " down"}`} />
                  <span className="section-title">{g.label}</span>
                  <span className="badge">{g.items.length}</span>
                </button>
                <p className="sec-desc">{g.description}</p>
                {!isClosed && (
                  <div className="box">
                    {g.items.map((p) => (
                      <PrefRow key={p.id} p={p} gone={gone.has(p.id)} open={() => open(p)} keep={() => keep(p)} forget={() => drop(p)} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---- preferences: one --------------------------------------------------------------------------------

const SCOPE_HINT = "Everywhere, a project (kanban), or a place in it (kanban:Tasks tab)";

function PrefForm({ p0, busy, error, onSave, onCancel, withQuote }: {
  p0: Partial<Pref>; busy: boolean; error: string; withQuote?: boolean;
  onSave: (v: { text: string; polarity: Polarity; area: PrefArea; scope: string; name: string; quote: string }) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(p0.text ?? "");
  const [polarity, setPolarity] = useState<Polarity>(p0.polarity ?? "like");
  const [area, setArea] = useState<PrefArea>(p0.area ?? "design");
  const [scope, setScope] = useState(p0.scope && p0.scope !== "everywhere" ? p0.scope : "");
  const [name, setName] = useState(p0.name ?? "");
  const [quote, setQuote] = useState(p0.quote ?? "");
  const save = () => { if (text.trim() && !busy) onSave({ text, polarity, area, scope: scope.trim() || "everywhere", name, quote }); };
  return (
    <div className="form pref-form" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } if (e.key === "Escape") onCancel(); }}>
      <label className="flabel">One sentence an agent can follow</label>
      <Area_ label="Preference" value={text} onChange={setText} autoFocus placeholder="Toggles use the tab's slightly rounded corners, not full capsules." />
      <div className="form-row">
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(["like", "avoid"] as Polarity[]).map((k) => (
            <button key={k} role="radio" aria-checked={polarity === k} className={`seg-b${polarity === k ? " on" : ""}`} onClick={() => setPolarity(k)}>
              <Icon name={k} size={14} />{k === "like" ? "Like" : "Avoid"}
            </button>
          ))}
        </div>
        <select className="input select" aria-label="Group" value={area} onChange={(e) => setArea(e.target.value as PrefArea)}>
          {PREF_AREAS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <input className="input scope" aria-label="Applies to" placeholder="Everywhere" title={SCOPE_HINT} value={scope} onChange={(e) => setScope(e.target.value)} />
      </div>
      <label className="flabel">Short name <span className="opt">agents cite it in replies</span></label>
      <input className="input" aria-label="Short name" value={name} onChange={(e) => setName(e.target.value)} />
      {withQuote && (
        <>
          <label className="flabel">Your words <span className="opt">optional</span></label>
          <input className="input" aria-label="Your words" value={quote} onChange={(e) => setQuote(e.target.value)} />
        </>
      )}
      {error && <div className="err">{error}</div>}
      <div className="form-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function EvidenceCardView({ c }: { c: EvidenceCard }) {
  const icon = c.kind === "image" ? "image" : c.kind === "link" ? "globe" : "layout";
  return (
    <button className="ev" onClick={() => openEvidence(c.target)} title={`Open ${c.file} in the right panel`}>
      <span className="th">{c.thumb ? <img src={c.thumb} alt="" /> : <Icon name={icon} size={24} className="dim" />}</span>
      <span className="eb">
        <span className="et"><Icon name={icon} size={14} className="dim" /><span>{c.title}</span></span>
        {c.part && <span className="em">{c.part}</span>}
        <span className="ep"><b>{c.file}</b><span>{c.dir}</span></span>
        <span className="how"><Icon name="globe" size={14} className="dim" />Opens in the right panel</span>
      </span>
    </button>
  );
}

function PrefView({ id, edit0, fromList, home, list, reload, goPref }: {
  id: string; edit0?: boolean; fromList?: Pref; home: () => void; list: () => void; reload: () => void; goPref: (id: string) => void;
}) {
  const [p, setP] = useState<Pref | null>(fromList ?? null);
  const [mode, setMode] = useState<"view" | "edit" | "forgotten">(edit0 ? "edit" : "view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => call<{ pref: Pref }>("prefsShow", { id }).then((r) => setP(r.pref), (e: Error) => setError(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onHost = (m: HostMessage) => { if (m.kind === "changed" && mode === "view") void load(); };
    hostListeners.add(onHost);
    return () => { hostListeners.delete(onHost); };
  }, [load, mode]);
  if (!p) return error ? <div className="err">{error}</div> : <Loading />;

  const save = async (v: { text: string; polarity: Polarity; area: PrefArea; scope: string; name: string }) => {
    setBusy(true); setError("");
    try {
      const changes: Record<string, unknown> = { id };
      if (v.text.trim() !== p.text) changes.text = v.text;
      if (v.polarity !== p.polarity) changes.polarity = v.polarity;
      if (v.area !== p.area) changes.area = v.area;
      if (v.scope !== (p.scope || "everywhere")) changes.scope = v.scope;
      if (v.name.trim() && v.name.trim() !== p.name) changes.name = v.name.trim();
      if (Object.keys(changes).length > 1) await call("prefsEdit", changes);
      await load();
      reload();
      setMode("view");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const forget = async () => {
    setBusy(true); setError("");
    try {
      await call("prefsForget", { ids: [id] });
      setMode("forgotten");
      reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setError("");
    try {
      await call("prefsUndo", { id });
      setMode("view");
      await load();
      reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const gone = mode === "forgotten" || p.status === "forgotten";
  // the first words: said with the entry, or later (quote_said) when an imported note got them
  // words that came with the import say where they were found, not "with import"
  const fromImport = !!p.imported && (!p.quote_said || p.quote_said.engine === "import");
  const first = fromImport ? { at: p.quote_said?.at || saidAt(p), engine: "", session: "" }
    : p.quote_said ?? { at: saidAt(p), engine: p.said?.engine, session: p.said?.session };
  const quotes = [...(p.quote ? [{ text: p.quote, at: first.at, session: first.session, engine: first.engine, source: fromImport ? p.sources?.[0]?.label ?? "" : "" }] : []), ...(p.quotes ?? [])];
  const cards = evidenceCards(p);
  const replacedBy = p.related?.find((r) => r.id === p.replaced_by);
  const history = [...(p.history ?? [])].reverse();
  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: "Preferences", go: list }, { label: p.name || "Preference" }]}
        actions={mode === "view" && !gone && (
          <>
            <button className="btn" onClick={() => setMode("edit")}>Edit</button>
            <button className="btn" disabled={busy} onClick={() => void forget()}>Forget</button>
          </>
        )} />
      {gone && (
        <div className="stale gone-line"><Icon name="undo" size={14} />Forgotten. Agents will not see it from the next session on.<button className="lnk" disabled={busy} onClick={() => void undo()}>Undo</button></div>
      )}
      {mode === "edit" ? (
        <PrefForm p0={p} busy={busy} error={error} onSave={(v) => void save(v)} onCancel={() => setMode("view")} />
      ) : (
        <p className={`sent${gone ? " faded" : ""}`}>{p.text}</p>
      )}
      {error && mode !== "edit" && <div className="err">{error}</div>}
      <dl className="kv">
        <dt>Kind</dt><dd><PolIcon p={p} />{p.polarity === "avoid" ? "Avoid" : "Like"}</dd>
        <dt>Group</dt><dd>{areaLabel(p.area)}</dd>
        <dt>Applies to</dt><dd>{appliesTo(p)}</dd>
        <dt>Remembered</dt><dd>{rememberedLine(p)}</dd>
        <dt>Used</dt><dd>{usedLine(p)}</dd>
        {!!p.also_in?.length && (<><dt>Also in</dt><dd>{p.also_in.join(", ")}, so agents do not get it twice</dd></>)}
        {p.status === "replaced" && (<><dt>Replaced by</dt><dd>{replacedBy ? <button className="lnk" onClick={() => goPref(replacedBy.id)}>{replacedBy.name}</button> : p.replaced_by}. Agents no longer get this one.</dd></>)}
      </dl>
      {quotes.length > 0 && (
        <>
          <h2 className="dh">Your words</h2>
          {quotes.map((q, i) => (
            <div key={i} className="qt">
              <Icon name="quote" className="dim" />
              <div>
                <div className="q">「{q.text}」</div>
                <div className="qm">
                  {[momentLabel(q.at || "", new Date()), q.source || (q.engine ? `with ${engineName(q.engine)}` : "")].filter(Boolean).join(" · ")}
                  {q.session && <> · <button className="lnk" onClick={() => openSession(q.session!, q.at || "", q.engine || "")}>Open in session</button></>}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {!!p.sources?.length && (
        <>
          <h2 className="dh">Where it came from</h2>
          {p.sources.map((s, i) => (
            <div key={i} className="qt">
              <Icon name="fact" className="dim" />
              <div>
                <div className="q">{s.label}</div>
                <div className="qm">
                  {[s.at ? dayLabel(s.at) : "", (s.path || "").replace(/^\/Users\/[^/]+\//, "~/")].filter(Boolean).join(" · ")}
                  {s.path && /\.md$/i.test(s.path) && <> · <button className="lnk" onClick={() => openFile(s.path, s.line || 1)}>Open file</button></>}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {cards.length > 0 && (
        <>
          <h2 className="dh">Evidence <span className="badge">{cards.length}</span></h2>
          <div className="evs">{cards.map((c) => <EvidenceCardView key={c.key} c={c} />)}</div>
        </>
      )}
      <h2 className="dh">History</h2>
      <ul className="hist">
        {history.map((h, i) => (
          <li key={i}><span className="w">{momentLabel(h.at)}</span><span>{eventLine(h)}{h.event === "replaces" && h.id && (
            <> <button className="lnk" onClick={() => goPref(h.id!)}>Open</button></>
          )}</span></li>
        ))}
      </ul>
      <p className="source">Stored in ~/.dispatch/preferences.jsonl</p>
    </>
  );
}

function PrefNew({ home, list, onAdded }: { home: () => void; list: () => void; onAdded: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (v: { text: string; polarity: Polarity; area: PrefArea; scope: string; name: string; quote: string }) => {
    setBusy(true); setError("");
    try {
      const r = await call<{ remembered: Pref[] }>("prefsAdd", { text: v.text, polarity: v.polarity, area: v.area, scope: v.scope, ...(v.name.trim() ? { name: v.name.trim() } : {}), ...(v.quote.trim() ? { quote: v.quote.trim() } : {}) });
      onAdded(r.remembered[0].id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: "Preferences", go: list }, { label: "New Preference" }]} />
      <p className="lede">Agents follow it from their next session.</p>
      <PrefForm p0={{}} busy={busy} error={error} withQuote onSave={(v) => void save(v)} onCancel={list} />
    </>
  );
}

// ---- engine memory -------------------------------------------------------------------------------

const ENGINE_ROWS = [
  { agent: "claude-code", label: "Claude Code", icon: "claude", folder: "~/.claude/projects/*/memory" },
  { agent: "codex", label: "Codex", icon: "code", folder: "~/.codex/memories" },
  { agent: "zcode", label: "ZCode", icon: "folder", folder: "~/.zcode/cli/memories" },
];

function EngineMemory({ d, home }: { d: Data; home: () => void }) {
  const files = d.memories;
  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: "Engine memory" }]} />
      <p className="lede">Notes Claude Code, Codex and ZCode keep for themselves. Dispatch shows them and never changes them.</p>
      {!files ? <Loading /> : (
        <div className="box">
          {ENGINE_ROWS.map((r) => {
            const mine = files.filter((f) => f.agent === r.agent);
            const top = mine.reduce<Record<string, number>>((m, f) => { if (f.project) m[f.project] = (m[f.project] ?? 0) + 1; return m; }, {});
            const best = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
            const dir = mine[0]?.path ? mine[0].path.replace(/\/[^/]+$/, "") : "";
            return (
              <div key={r.agent} className="row static">
                <Icon name={r.icon} className="dim" />
                <span className="row-text">
                  <span className="row-top"><span className="row-title">{r.label}</span><span className="row-meta">{mine.length} files</span></span>
                  <span className="row-summary">{r.folder}{best ? ` · most for ${best[0]} (${best[1]})` : ""}</span>
                </span>
                {dir && <button className="btn" onClick={() => reveal(dir)}>Open folder</button>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---- wiki, facts, about me: Skills' stacked groups ----------------------------------------------------

const PAGE = 50;
const CLOSED_BY_DEFAULT = new Set(["Past events"]);

function RowItem({ r, open }: { r: Row; open: () => void }) {
  return (
    <button className="row" onClick={open} title={r.title}>
      <Icon name={r.icon} className="dim" />
      <span className="row-text">
        <span className="row-top">
          <span className="row-title">{r.title}</span>
          <span className="row-meta">{[r.source, shortDate(r.date)].filter(Boolean).join(" · ")}</span>
        </span>
        {r.summary && <span className="row-summary">{r.summary}</span>}
      </span>
    </button>
  );
}

function List({ area, rows, searchWiki, open, crumbsHome, onNew }: {
  area: Area; rows: Row[] | null; searchWiki: (q: string) => Promise<Row[]>; open: (r: Row) => void; crumbsHome: () => void; onNew?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(CLOSED_BY_DEFAULT));
  const [shown, setShown] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (area !== "wiki" || !q) { setHits(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchWiki(q).then((r) => { setHits(r); setSearching(false); }, (e: Error) => { setError(e.message); setSearching(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [area, query, searchWiki]);

  const all = useMemo(() => (rows ? newestFirst(rows) : null), [rows]);
  const visible = useMemo(() => (all ? (area === "wiki" ? (hits ?? all) : filterRows(all, query)) : null), [all, hits, query, area]);
  // groups in file order (Who I am, Devices and services, Upcoming, Past events), rows in each newest first
  const groups = useMemo(() => groupsOf(rows ?? [], area), [rows, area]);
  const searching_ = !!query.trim();
  const toggle = (g: string) => setClosed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; });

  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: crumbsHome }, { label: areaInfo(area).label }]} />
      <p className="lede">{area === "facts" ? "Machines, accounts and services every project uses, from FACTS.md." : area === "me" ? "Who you are, your devices and what is coming up, from PROFILE.md." : areaInfo(area).what}</p>
      <div className="toolbar">
        <input ref={input} className="input search" aria-label="Search" placeholder="Type to search..." value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} />
        {searching && <span className="spin" aria-label="Searching" />}
        {onNew && <button className="btn" onClick={onNew}>New Entry</button>}
      </div>
      {error && <div className="err">{error}</div>}
      {!visible ? <Loading /> : (
        <div className="secs">
          {visible.length === 0 && <div className="box"><div className="empty"><div className="empty-t">{searching_ ? `Nothing matches “${query.trim()}”` : "Nothing here yet"}</div></div></div>}
          {groups.map((g) => g.name).map((name) => {
            const inGroup = visible.filter((r) => r.group === name);
            if (!inGroup.length) return null;
            const isClosed = !searching_ && closed.has(name);
            const n = shown[name] ?? PAGE;
            return (
              <section key={name} className={`sec${isClosed ? " closed" : ""}`}>
                <button className="section-head" aria-expanded={!isClosed} onClick={() => toggle(name)}>
                  <Icon name="chevron" className={`chev${isClosed ? "" : " down"}`} />
                  <span className="section-title">{name}</span>
                  <span className="badge">{inGroup.length}</span>
                </button>
                {WIKI_DESC[name] && area === "wiki" && <p className="sec-desc">{WIKI_DESC[name]}</p>}
                {!isClosed && (
                  <div className="box">
                    {inGroup.slice(0, searching_ ? inGroup.length : n).map((r) => <RowItem key={r.id} r={r} open={() => open(r)} />)}
                    {!searching_ && inGroup.length > n && (
                      <button className="row more" onClick={() => setShown({ ...shown, [name]: n + PAGE * 4 })}>Show {Math.min(PAGE * 4, inGroup.length - n)} more</button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---- wiki, facts, about me: one entry --------------------------------------------------------------

function WikiForm({ kind, body0, fields0, withProject, busy, error, onSave, onCancel }: {
  kind: WikiKind; body0: string; fields0: Record<string, string>; withProject?: boolean; busy: boolean; error: string;
  onSave: (body: string, fields: Record<string, string>, project: string) => void; onCancel: () => void;
}) {
  const [body, setBody] = useState(body0);
  const [fields, setFields] = useState(fields0);
  const [project, setProject] = useState("");
  const info = kindInfo(kind);
  const save = () => { if (body.trim() && !busy) onSave(body, fields, project); };
  return (
    <div className="form" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } if (e.key === "Escape") onCancel(); }}>
      <label className="flabel">{info.one}</label>
      <Area_ label={info.one} value={body} onChange={setBody} autoFocus />
      {info.fields.map((f) => (
        <div key={f.name}>
          <label className="flabel">{f.label}</label>
          <Area_ label={f.label} value={fields[f.name] ?? ""} onChange={(v) => setFields({ ...fields, [f.name]: v })} />
        </div>
      ))}
      {withProject && (
        <>
          <label className="flabel">Project <span className="opt">optional</span></label>
          <input className="input" aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} />
        </>
      )}
      {error && <div className="err">{error}</div>}
      <div className="form-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!body.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

function Detail({ row, back, home, onWikiSaved, onDeleted }: {
  row: Row; back: () => void; home: () => void; onWikiSaved: (it: WikiItem) => void; onDeleted: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const area = areaInfo(row.area);
  const w = row.wiki;
  const meta = [w ? kindInfo(w.kind!).one : row.group, row.source, row.date].filter(Boolean).join(" · ");

  const edit = () => {
    if (w) setMode("edit");
    else if (row.path && row.line) openFile(row.path, row.line);
  };
  const saveWiki = async (body: string, fields: Record<string, string>) => {
    if (!w) return;
    const changed = changedFields(w, fields);
    const bodyChanged = body.trim() !== w.text.trim();
    if (!changed && !bodyChanged) { setMode("view"); return; }
    setBusy(true); setError("");
    try {
      const ans = await call<{ item: WikiItem }>("wikiEdit", { key: w.key, ...(bodyChanged ? { body } : {}), ...(changed ? { fields: changed } : {}) });
      onWikiSaved({ ...ans.item, created: w.created });
      setMode("view");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError("");
    try {
      if (w) await call("wikiRemove", { key: w.key });
      else await call(row.area === "facts" ? "factsDrop" : "profileDrop", { line: row.line, text: row.raw });
      onDeleted();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: area.label, go: back }, { label: row.title }]}
        actions={mode === "view" && (
          <>
            <button className="btn" onClick={edit} title={w ? "Edit this entry" : `Open ${row.area === "facts" ? "FACTS.md" : "PROFILE.md"} at line ${row.line}`}>Edit</button>
            <button className="btn" onClick={() => setMode("confirm")}>Delete</button>
          </>
        )} />
      <p className="lede">{meta}</p>
      {mode === "confirm" && (
        <div className="confirm">
          <span>Delete this entry for every agent?</span>
          <button className="btn" disabled={busy} onClick={() => setMode("view")}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</button>
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {mode === "edit" && w ? (
        <WikiForm kind={w.kind!} body0={w.text} fields0={fieldValues(w)} busy={busy} error={error} onSave={(b, f) => void saveWiki(b, f)} onCancel={() => setMode("view")} />
      ) : (
        <article className="doc">
          <div className="md" dangerouslySetInnerHTML={{ __html: md(w ? w.text : row.body) }} />
          {w && kindInfo(w.kind!).fields.map((f) => w.fields[f.cli] ? (
            <section key={f.name}>
              <h2>{f.label}</h2>
              <div className="md" dangerouslySetInnerHTML={{ __html: md(w.fields[f.cli]) }} />
            </section>
          ) : null)}
          {row.path && <p className="source">{row.path.replace(/^.*\//, "")}, line {row.line}</p>}
        </article>
      )}
    </>
  );
}

function NewEntry({ home, back, onAdded }: { home: () => void; back: () => void; onAdded: (it: WikiItem) => void }) {
  const [kind, setKind] = useState<WikiKind>("pit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (body: string, fields: Record<string, string>, project: string) => {
    setBusy(true); setError("");
    try {
      const ans = await call<{ item: WikiItem }>("wikiAdd", { kind, body, fields, project });
      onAdded({ ...ans.item, created: new Date().toISOString() });
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <>
      <Crumbs parts={[{ label: "Knowledge", go: home }, { label: "Wiki", go: back }, { label: "New Entry" }]} />
      <p className="lede">Agents see it from their next session.</p>
      <div className="kinds" role="radiogroup" aria-label="Kind">
        {KINDS.map((k) => (
          <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={`chip${kind === k.kind ? " on" : ""}`} onClick={() => setKind(k.kind)}>
            <Icon name={k.kind} />{k.one}
          </button>
        ))}
      </div>
      <WikiForm key={kind} kind={kind} body0="" fields0={{}} withProject busy={busy} error={error} onSave={(b, f, p) => void save(b, f, p)} onCancel={back} />
    </>
  );
}

// ---- the page ------------------------------------------------------------------------------------

function Page() {
  const { d, setD, newIds, loadFacts, loadProfile, loadPrefs } = useData();
  const [view, setView] = useState<View>({ layer: "home" });
  const rowsOf = useCallback((a: Area): Row[] | null => {
    if (a === "wiki") return d.wiki && wikiRows(d.wiki);
    if (a === "facts") return d.facts && factRows(d.facts);
    return d.profile && profileRows(d.profile);
  }, [d]);
  const searchWiki = useCallback((q: string) => call<WikiItem[]>("wikiSearch", { query: q }).then(wikiRows), []);
  const scroller = useRef<HTMLElement>(null);
  const go = useCallback((v: View) => { setView(v); scroller.current?.scrollTo(0, 0); window.scrollTo(0, 0); }, []);
  const home = () => go({ layer: "home" });

  // the window opens a preference (Edit in a session's toast or line) or the list
  useEffect(() => {
    const onHost = (m: HostMessage) => {
      if (m.kind !== "navigate") return;
      if (m.view === "pref" && m.id) go({ layer: "pref", id: m.id, edit: !!m.edit });
      else if (m.view === "prefs") go({ layer: "prefs" });
      else go({ layer: "home" });
    };
    hostListeners.add(onHost);
    vscode.postMessage({ kind: "ready" });
    return () => { hostListeners.delete(onHost); };
  }, [go]);

  const forget = useCallback((p: Pref) => {
    void call("prefsForget", { ids: [p.id] }).then(() => {
      void loadPrefs();
      showToast({ text: `Forgotten: ${p.name || p.text}`, undo: () => { void call("prefsUndo", { id: p.id }).then(() => loadPrefs(), () => undefined); } });
    }, (e: Error) => setD((x) => ({ ...x, error: e.message })));
  }, [loadPrefs, setD]);

  let body: ReactNode;
  if (view.layer === "home") body = <Home d={d} newIds={newIds} go={go} forget={forget} />;
  else if (view.layer === "prefs") {
    body = <PrefsList d={d} newIds={newIds} home={home} open={(p) => go({ layer: "pref", id: p.id })} onNew={() => go({ layer: "prefNew" })} forget={forget} reload={() => void loadPrefs()} />;
  } else if (view.layer === "pref") {
    body = <PrefView key={`${view.id}${view.edit ? "-e" : ""}`} id={view.id} edit0={view.edit} fromList={d.prefs?.items.find((p) => p.id === view.id)}
      home={home} list={() => go({ layer: "prefs" })} reload={() => void loadPrefs()} goPref={(id) => go({ layer: "pref", id })} />;
  } else if (view.layer === "prefNew") {
    body = <PrefNew home={home} list={() => go({ layer: "prefs" })} onAdded={(id) => { void loadPrefs(); go({ layer: "pref", id }); }} />;
  } else if (view.layer === "memory") {
    body = <EngineMemory d={d} home={home} />;
  } else if (view.layer === "list") {
    body = <List key={view.area} area={view.area} rows={rowsOf(view.area)} searchWiki={searchWiki} crumbsHome={home}
      open={(r) => go({ layer: "detail", area: view.area, id: r.id })} onNew={view.area === "wiki" ? () => go({ layer: "new" }) : undefined} />;
  } else if (view.layer === "new") {
    body = <NewEntry home={home} back={() => go({ layer: "list", area: "wiki" })}
      onAdded={(it) => { setD((x) => ({ ...x, wiki: x.wiki ? [it, ...x.wiki] : [it] })); go({ layer: "detail", area: "wiki", id: `wiki:${it.key}` }); }} />;
  } else {
    const row = rowsOf(view.area)?.find((r) => r.id === view.id);
    const back = () => go({ layer: "list", area: view.area });
    body = !row ? <Loading /> : (
      <Detail key={row.id} row={row} back={back} home={home}
        onWikiSaved={(it) => setD((x) => ({ ...x, wiki: x.wiki && x.wiki.map((o) => (o.key === it.key ? it : o)) }))}
        onDeleted={() => {
          if (row.wiki) setD((x) => ({ ...x, wiki: x.wiki && x.wiki.filter((o) => o.key !== row.wiki!.key) }));
          else if (row.area === "facts") void loadFacts();
          else void loadProfile();
          back();
        }} />
    );
  }
  return (
    <main className="page" ref={scroller}>
      {d.error && view.layer === "home" && <div className="err">{d.error}</div>}
      {body}
      <PageToast />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
