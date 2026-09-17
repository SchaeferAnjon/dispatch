import { useMemo, useState } from "react";
import { createAvatar } from "@dicebear/core";
import * as openPeeps from "@dicebear/open-peeps";
import type { Discussion, Participant } from "./Discuss";
import { KINDS, KIND_ACTOR } from "./Delegate";
import { actorOf } from "../derive";
import { useT } from "../i18n";

// The discussion as a round table: one little person per member (and you), seated around the
// topic. Whoever is thinking bobs with a thought bubble, whoever is speaking gets the words as
// they arrive, and a member who could not speak says so in red instead of just being absent.
// Avatars: DiceBear "Open Peeps" (library MIT, artwork CC0 by Pablo Stanley), generated locally
// from the member's name, so the same member always looks the same.

const whoOf = (p: Participant) => `${p.kind}${p.model ? `（${p.model}）` : ""}`;
export const avatar = (seed: string) => `data:image/svg+xml;utf8,${encodeURIComponent(createAvatar(openPeeps, { seed, size: 96, backgroundColor: ["transparent"] }).toString())}`;
const clip = (s: string, n: number) => { const x = s.replace(/\s+/g, " ").trim(); return x.length > n ? "…" + x.slice(-n) : x; };
const head = (s: string, n: number) => { const x = s.replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

type Seat = { key: string; name: string; sub: string; leader: boolean; you: boolean; state: "idle" | "queued" | "thinking" | "typing" | "done" | "skip" | "error"; text: string; step: string };

export function DiscussStage({ d, parts, leader, me, topic, big }: { d: Discussion; parts: Participant[]; leader: number; me: string; topic: string; big?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const seats = useMemo<Seat[]>(() => {
    const kindName = (k: string) => KINDS.find(([id]) => id === k)?.[1] ?? k;
    const sameKind = (k: string) => parts.filter((p) => p.kind === k).length;
    const lastSaid = (p: Participant) => {
      const who = whoOf(p);
      for (let i = d.thread.length - 1; i >= 0; i--) {
        const x = d.thread[i];
        if (x.opener || x.mine) continue;
        const named = x.body.startsWith(who + "：") || x.body.startsWith(who + ":");
        const byActor = sameKind(p.kind) === 1 && actorOf(x.c.author, me)?.id === KIND_ACTOR[p.kind];
        if (named || byActor) return x.body.replace(/^[^：:\n]{1,40}[：:]\s*/, "");
      }
      return "";
    };
    const rows: Seat[] = parts.map((p, i) => {
      const live = d.running ? d.live?.members[whoOf(p)] : undefined;
      const st = live?.status ?? "";
      const state: Seat["state"] = st === "queued" ? "queued" : st === "thinking" ? "thinking" : st === "typing" ? "typing" : st === "done" || st === "posted" ? "done" : st === "skip" ? "skip" : st === "error" ? "error" : "idle";
      return { key: whoOf(p), name: kindName(p.kind), sub: p.model, leader: i === Math.min(leader, parts.length - 1), you: false, state, text: state === "idle" || !live?.text ? lastSaid(p) : live.text, step: live?.step ?? "" };
    });
    const mineLast = [...d.thread].reverse().find((x) => x.mine || x.opener);
    rows.push({ key: "__me", name: t("你"), sub: "", leader: false, you: true, state: d.saying ? "typing" : "idle", text: mineLast ? mineLast.body.replace(/^[^：:\n]{1,40}[：:]\s*/, "") : "", step: "" });
    return rows;
  }, [d.thread, d.live, d.running, d.saying, parts, leader, me, t]);
  // Seats on an ellipse, you at the bottom centre, the others spread over the rest of the ring.
  const n = seats.length;
  // The ring sits low in the box: speech bubbles open upwards and need the headroom.
  const pos = (i: number) => { const a = Math.PI / 2 + (2 * Math.PI * ((i + 1) % n)) / n; return { left: `${50 + (big ? 32 : 38) * Math.cos(a)}%`, top: `${56 + 27 * Math.sin(a)}%` }; };
  const label: Record<Seat["state"], string> = { idle: "", queued: t("等着发言"), thinking: t("在想…"), typing: t("正在说"), done: t("说完了"), skip: t("这轮没话说"), error: t("没说上话") };
  return <div className={`disc-stage${d.running ? " live" : ""}`} aria-label={t("讨论现场")}>
    <div className="stage-table"><span>{head(topic, 60)}</span>{d.running && d.live ? <small>{t("第 {n} 轮", { n: d.live.round })}</small> : d.conclusion ? <small>{t("已有结论")}</small> : null}</div>
    {seats.map((s, i) => {
      const bubble = s.state === "thinking" ? (s.step || "…") : s.state === "error" ? s.text || label.error : s.text;
      const showBubble = open === s.key || s.state === "thinking" || s.state === "typing" || s.state === "error" || (s.state === "done" && !!s.text);
      const x = parseFloat(pos(i).left);
      // A bubble never leaves the box: seats near an edge open theirs inwards.
      // Seats in the upper half open a long bubble beside themselves, not above: above is the edge of the box.
      const edge = (x < 30 ? " edge-l" : x > 70 ? " edge-r" : "") + (parseFloat(pos(i).top) < 50 ? " upper" : "");
      return <div key={s.key} className={`seat s-${s.state}${s.you ? " you" : ""}${edge}${open === s.key ? " open" : ""}`} style={pos(i)}>
        {showBubble && bubble && <div className={`seat-bubble${s.state === "thinking" ? " thought" : ""}${s.state === "error" ? " err" : ""}${open === s.key ? " full" : ""}`}><span>{open === s.key ? head(bubble, 400) : s.state === "typing" ? clip(bubble, 56) : head(bubble, 56)}</span></div>}
        <div className="seat-figure">
          <button type="button" className="seat-person" onClick={() => setOpen(open === s.key ? null : s.key)} title={s.text ? t("点一下看 ta 最近说的话") : ""}>
            <img src={avatar(s.key === "__me" ? `me:${me}` : s.key)} alt="" />
          </button>
          {s.leader && <i className="seat-crown" title={t("领队：每轮最后发言，结论和文档由 ta 写")}>★</i>}
        </div>
        <div className="seat-name"><b>{s.name}</b>{s.sub && <span className="muted">{s.sub.split("/").pop()}</span>}{label[s.state] && <em>{label[s.state]}</em>}</div>
      </div>;
    })}
  </div>;
}
