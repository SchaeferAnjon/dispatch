import { useEffect, useState } from "react";
import type { Api } from "../api";
import { acceptanceProgress, actorOf, issueAcceptance, relTime, type AcState } from "../derive";
import type { Issue } from "../types";
import { useT } from "../i18n";

export interface AcStatusRow { n: number; text: string; state: AcState; by: string; evidence: string; at: string }
export interface AcStatus { items: AcStatusRow[] }

export function AcTally({ issue }: { issue: { acceptance_criteria?: string; status?: string; closed_at?: string } }) {
  const p = acceptanceProgress(issueAcceptance(issue));
  return p.total ? <span className="ac-tally small" title={`Checklist ${p.done}/${p.total}`}>✓{p.done}<span className="muted"> / {p.total}</span></span> : null;
}

interface ListProps { issue: Issue; api: Api; host: string; me: string; stamp: string; busy: boolean; onEdit: () => void; onChanged: () => void; onDone: (m: string, undo?: () => void) => void; onError: (m: string) => void }

/** The working agent's checklist and evidence. Completion is recorded through dispatch done. */
export function AcceptanceList({ issue, api, host, me, stamp, onEdit }: ListProps) {
  const t = useT();
  const ac = issueAcceptance(issue);
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const id = issue.id;
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setOpen(null);
    if (issue.acceptance_criteria) {
      api.on(host, ["check", id, "--status", "--json"]).then((raw) => {
        if (alive) setStatus(JSON.parse(raw.slice(Math.max(0, raw.indexOf("{")))));
      }).catch(() => { if (alive) setStatus(null); });
    }
    return () => { alive = false; };
  }, [api, host, id, stamp, issue.acceptance_criteria]);
  const p = acceptanceProgress(ac);
  return <>
    <h4>Checklist{ac.length > 0 && <span className="num">{p.done} / {ac.length}</span>}<span className="sp" />
      <button className="btn ghost sm" onClick={onEdit}>{ac.length ? t("编辑") : t("添加")}</button>
    </h4>
    {ac.length ? <ul className="checks ac-list">{ac.map((a, i) => {
      const n = i + 1;
      const row = status?.items.find((r) => r.n === n && r.text === a.text);
      return <li key={i} className={`ac-item ${a.state}`}>
        <div className="ac-line">
          <span className={`box${a.done ? " on" : ""}`} aria-label={a.done ? "Completed" : "Not started"}>{a.done ? "✓" : ""}</span>
          <span className="ac-text">{a.text}</span>
          {row?.evidence && <button className="link sm" onClick={() => setOpen(open === n ? null : n)} aria-expanded={open === n}>Evidence</button>}
        </div>
        {open === n && row?.evidence && <div className="ac-ev">
          <div className="muted small">{actorOf(row.by, me)?.name ?? row.by}{row.at ? ` · ${relTime(row.at)}` : ""}</div>
          <div className="ac-ev-text">{row.evidence}</div>
        </div>}
      </li>;
    })}</ul> : <p className="empty-p">No checklist items</p>}
  </>;
}
