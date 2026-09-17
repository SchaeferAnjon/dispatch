import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api";
import { Markdown } from "./Markdown";
import { avatar } from "./DiscussStage";
import { useT } from "../i18n";

// 顺便问 (by the way): a classmate sitting at the edge of the discussion. Ask about anything you
// did not follow, or select a sentence and ask about that. The answers live beside the discussion
// (`dispatch discuss-aside`), never in the task, so the members do not see them and the
// discussion itself is not affected.

type Item = { id: string; q: string; quote?: string; a: string; error?: string; at: number; by?: string };
const parse = (s: string): Item[] => { try { const d = JSON.parse(s.slice(Math.max(0, s.indexOf("{")))); return Array.isArray(d.items) ? d.items : []; } catch { return []; } };
const head = (s: string, n: number) => { const x = s.replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

export function DiscussAside({ api, task, scope, onError }: { api: Api; task: string; scope: React.RefObject<HTMLElement | null>; onError: (m: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [quote, setQuote] = useState("");
  const [pending, setPending] = useState<{ q: string; quote: string } | null>(null);
  const [unseen, setUnseen] = useState(false);
  const [pick, setPick] = useState<{ x: number; y: number; text: string } | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open); openRef.current = open;

  useEffect(() => {
    let alive = true;
    setItems([]); setPending(null); setQuote(""); setText(""); setUnseen(false);
    api.on("local", ["discuss-aside", task, "--json"]).then((s) => { if (alive) setItems(parse(s)); }).catch(() => { /* an older CLI has no such command: the classmate just has nothing to show */ });
    return () => { alive = false; };
  }, [api, task]);

  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [items, pending, open]);
  useEffect(() => { if (open) { setUnseen(false); input.current?.focus(); } }, [open, quote]);

  // Select a sentence anywhere in the discussion: a small button offers to ask about it.
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const up = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest(".disc-aside-panel,.disc-aside-pick,textarea,input")) return;
      const sel = window.getSelection();
      const s = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      const inside = !!sel?.anchorNode && root.contains(sel.anchorNode);
      setPick(s.length >= 2 && s.length <= 600 && inside ? { x: e.clientX, y: e.clientY, text: s } : null);
    };
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement | null)?.closest(".disc-aside-pick")) setPick(null); };
    root.addEventListener("mouseup", up);
    document.addEventListener("mousedown", down);
    return () => { root.removeEventListener("mouseup", up); document.removeEventListener("mousedown", down); };
  }, [scope, task]);

  const ask = useCallback(async () => {
    const q = text.trim() || (quote ? t("这句是什么意思？") : "");
    if (!q || pending) return;
    const asked = { q, quote };
    setPending(asked); setText(""); setQuote("");
    try {
      const args = ["discuss-aside", task, "--json", "--stdin"];
      if (asked.quote) args.push("--quote", asked.quote);
      const rows = parse(await api.on("local", args, q));
      if (rows.length) setItems(rows);
      if (!openRef.current) setUnseen(true);
    } catch (e) {
      onError(String(e));
      setText(asked.q); setQuote(asked.quote);
    } finally { setPending(null); }
  }, [api, task, text, quote, pending, onError, t]);

  const clear = async () => { try { await api.on("local", ["discuss-aside", task, "--clear", "--json"]); setItems([]); } catch (e) { onError(String(e)); } };
  const last = items[items.length - 1];
  const bubble = pending ? t("我想想…") : unseen && last ? head(last.a || last.error || "", 60) : "";

  return <>
    <div className={`aside-mate${pending ? " thinking" : ""}${open ? " on" : ""}`}>
      {bubble && !open && <button type="button" className="seat-bubble aside-bubble" onClick={() => setOpen(true)}><span>{bubble}</span></button>}
      <button type="button" className="seat-person" onClick={() => setOpen(!open)} title={t("顺便问：有没听懂的，问旁边的同学。不写进讨论，参加者看不到")} aria-label={t("顺便问")}>
        <img src={avatar("classmate:by-the-way")} alt="" />
      </button>
      <div className="seat-name"><b>{t("同学")}</b><em>{t("顺便问")}</em></div>
    </div>
    {pick && <button type="button" className="disc-aside-pick" style={{ left: Math.min(pick.x, window.innerWidth - 120), top: pick.y + 12 }} onClick={() => { setQuote(pick.text); setPick(null); setOpen(true); window.getSelection()?.removeAllRanges(); }}>{t("问同学")}</button>}
    {open && <div className="disc-aside-panel" role="dialog" aria-label={t("顺便问")}>
      <div className="aside-head"><b>{t("顺便问")}</b><span className="muted small">{t("不写进讨论，参加者看不到")}</span><span className="spacer" />
        {items.length > 0 && <button className="link sm" onClick={() => void clear()}>{t("清空")}</button>}
        <button className="btn ghost sm" onClick={() => setOpen(false)} aria-label={t("关闭")}>✕</button>
      </div>
      <div className="aside-list" ref={list}>
        {items.length === 0 && !pending && <p className="muted small aside-empty">{t("哪个词、哪句话没听懂，直接问。也可以在讨论里划一句话，点「问同学」。")}</p>}
        {items.map((it) => <div key={it.id} className="aside-item">
          {it.quote && <blockquote className="aside-quote">{head(it.quote, 140)}</blockquote>}
          <div className="aside-q">{it.q}</div>
          {it.a ? <div className="aside-a"><Markdown src={it.a} className="compact" /></div> : <div className="aside-a err small">{t("没答上来：{why}", { why: it.error || "" })}</div>}
        </div>)}
        {pending && <div className="aside-item">
          {pending.quote && <blockquote className="aside-quote">{head(pending.quote, 140)}</blockquote>}
          <div className="aside-q">{pending.q}</div>
          <div className="aside-a muted small">{t("同学在想…")}</div>
        </div>}
      </div>
      {quote && <div className="aside-quoting"><blockquote className="aside-quote">{head(quote, 140)}</blockquote><button className="link sm" onClick={() => setQuote("")} aria-label={t("不引用这句")}>✕</button></div>}
      <div className="aside-compose">
        <textarea ref={input} rows={2} value={text} placeholder={quote ? t("这句哪里没懂？直接回车就是问「这句是什么意思」") : t("问一个没听懂的概念（回车发出）")} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } if (e.key === "Escape") setOpen(false); }} />
        <button className="btn primary sm" disabled={!!pending || (!text.trim() && !quote)} onClick={() => void ask()}>{t("问")}</button>
      </div>
    </div>}
  </>;
}
