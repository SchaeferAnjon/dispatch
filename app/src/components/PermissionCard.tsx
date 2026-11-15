import { useState } from "react";
import { toolLabel, type Decision, type PermissionCard as Card } from "../chatProtocol";
import { lineDiff } from "../diff";
import { t, useT } from "../i18n";
import { Kbd } from "./primitives";

// A permission request of a live session, drawn inside the conversation (not a dialog; design 图 13):
// what it wants and why, the command or the diff, then 允许一次 ↵ / 本会话都允许 ⇧↵ / 拒绝 esc.
// A question (AskUserQuestion, Codex requestUserInput) uses the same card with its options and
// 「回答」. Answered cards shrink to one grey line.

const TITLE: Record<Card["kind"], string> = {
  command: "要跑一条命令，等你点头",
  edit: "要改一个文件，等你点头",
  read: "要读一个文件，等你点头",
  fetch: "要访问一个网址，等你点头",
  permission: "要一项权限，等你点头",
  question: "它在问你",
  other: "要用一个工具，等你点头",
};
export const permissionTitle = (c: Pick<Card, "kind">) => t(TITLE[c.kind] ?? TITLE.other);

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** The part of the input a person decides on: the command, the URL, the path, else the input itself. */
export function permissionSubject(c: Pick<Card, "kind" | "input" | "summary">): string {
  const i = c.input || {};
  if (c.kind === "command") return str(i.command) || str(i.cmd) || c.summary;
  if (c.kind === "fetch") return str(i.url) || str(i.query) || c.summary;
  if (c.kind === "read" || c.kind === "edit") return str(i.file_path) || str(i.path) || c.summary;
  if (c.summary) return c.summary;
  const raw = JSON.stringify(i);
  return raw === "{}" ? "" : raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

/** The grey line an answered card turns into. */
export function resolvedLine(c: Card): string {
  const r = c.resolved;
  if (!r) return "";
  if (r.by === "elsewhere") return t("已在别处处理");
  if (r.decision === "deny") return c.kind === "command" ? t("你拒绝了这条命令，Agent 在等你的下一句") : t("你拒绝了，Agent 在等你的下一句");
  if (r.decision === "allow_session") return t("已允许，本会话同类的不再问");
  if (r.decision === "answered") return t("已回答");
  return t("已允许一次");
}

/** Up to 14 changed lines of an edit request, the way the mockup's `.mini` shows them. */
function MiniDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = lineDiff(oldText, newText).filter((l) => l.kind !== "same");
  const shown = lines.slice(0, 14);
  return <div className="mini">{shown.map((l, i) => <div key={i} className={l.kind === "add" ? "ln-add" : "ln-del"}>{l.kind === "add" ? "+" : "−"}{l.text}</div>)}{lines.length > shown.length && <div className="h">{t("还有 {n} 行改动", { n: lines.length - shown.length })}</div>}</div>;
}

export interface PermissionBodyProps {
  card: Card;
  busy?: boolean;
  answers: Record<string, string[]>;
  onPickAnswer: (qid: string, option: string, multi: boolean) => void;
  onDecide: (d: Decision) => void;
  onAnswer: (answers: Record<string, string[]>) => void;
}

/** The card without state (the wrapper below keeps the chosen answers); every string goes through t(). */
export function PermissionBody({ card, busy, answers, onPickAnswer, onDecide, onAnswer }: PermissionBodyProps) {
  if (card.resolved) return <div className="denied" role="status"><span className="sq" />{resolvedLine(card)}</div>;
  const subject = permissionSubject(card);
  const question = card.kind === "question" && (card.questions?.length ?? 0) > 0;
  const allAnswered = question && card.questions!.every((q) => (answers[q.id] ?? []).length > 0);
  return (
    <div className="perm" role="group" aria-label={permissionTitle(card)} data-permission={card.permission_id}>
      <div className="k"><span className="dot" /><span className="ttl">{permissionTitle(card)}</span><span className="tool">{toolLabel(card.tool_name)}{card.reason ? ` · ${card.reason}` : ""}</span></div>
      {card.summary && card.summary !== subject && <div className="why">{card.summary}</div>}
      {question ? card.questions!.map((q) => <div key={q.id} className="perm-q">
        <div className="why">{q.text}</div>
        <div className="perm-opts">{q.options.map((o) => { const on = (answers[q.id] ?? []).includes(o); return <button key={o} type="button" className={`btn sm${on ? " on" : ""}`} aria-pressed={on} disabled={busy} onClick={() => onPickAnswer(q.id, o, !!q.multi)}>{o}</button>; })}</div>
      </div>)
        : card.kind === "edit" && card.diff ? <MiniDiff oldText={card.diff.old} newText={card.diff.new} />
        : subject ? <pre className="sel-text">{subject}</pre> : null}
      {/* right-aligned pills (DESIGN.md 权限卡): 拒绝 and 允许一次 outlined, the third one filled */}
      <div className="acts">
        <span className="hint">{question ? t("选好再点回答") : t("拒绝后在下面告诉它改怎么做")}</span>
        {card.options.includes("deny") || question ? <button type="button" className="btn outline" disabled={busy} onClick={() => onDecide("deny")}>{t("拒绝")}<Kbd>esc</Kbd></button> : null}
        {question ? <button type="button" className="btn primary" disabled={busy || !allAnswered} onClick={() => onAnswer(answers)}>{t("回答")}<Kbd>↵</Kbd></button>
          : <button type="button" className={`btn ${card.options.includes("allow_session") ? "outline" : "primary"}`} disabled={busy} onClick={() => onDecide("allow")}>{t("允许一次")}<Kbd>↵</Kbd></button>}
        {!question && card.options.includes("allow_session") && <button type="button" className="btn primary" disabled={busy} onClick={() => onDecide("allow_session")}>{t("本会话都允许")}<Kbd>⇧</Kbd><Kbd>↵</Kbd></button>}
      </div>
    </div>
  );
}

/** Toggle one option of a question: single choice replaces, multi adds or removes. */
export function pickAnswer(prev: Record<string, string[]>, qid: string, option: string, multi: boolean): Record<string, string[]> {
  const cur = prev[qid] ?? [];
  const next = multi ? (cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option]) : cur.includes(option) ? [] : [option];
  return { ...prev, [qid]: next };
}

export function PermissionCard({ card, busy, onDecide, onAnswer }: { card: Card; busy?: boolean; onDecide: (d: Decision) => void; onAnswer: (answers: Record<string, string[]>) => void }) {
  useT();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return <PermissionBody card={card} busy={busy} answers={answers} onPickAnswer={(q, o, m) => setAnswers((a) => pickAnswer(a, q, o, m))} onDecide={onDecide} onAnswer={onAnswer} />;
}
