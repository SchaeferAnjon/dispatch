import { useEffect, useState } from 'react';
import type { Api } from '../api';
import type { Block, SessionRef, TimelineMsg } from '../types';
import { blocksOf } from '../timeline';

export interface Question { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
type Pending = { id: string; questions: Question[] };
/** The AskUserQuestion call still waiting for its result, if the latest turn has one. */
export function pendingQuestion(messages: TimelineMsg[]): Pending | null {
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 3; i--) {
    for (const b of blocksOf(messages[i]).slice().reverse() as Block[]) {
      if (b.type === 'tool_call' && b.name === 'AskUserQuestion' && (b.status === 'running' || b.status === 'incomplete')) {
        const qs = (b.input as { questions?: Question[] }).questions;
        return Array.isArray(qs) && qs.length ? { id: b.id, questions: qs } : null;
      }
    }
  }
  return null;
}
type Answer = { picks: number[]; other: string };

// The picker the agent put up in its terminal, answerable from here: `dispatch reply answer`
// presses the same keys a person would.
export function SessionQuestion({ api, session, pending, onAnswered, onError }: { api: Api; session: SessionRef; pending: Pending; onAnswered: () => void; onError: (m: string) => void }) {
  const [answers, setAnswers] = useState<Answer[]>(() => pending.questions.map(() => ({ picks: [], other: '' })));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { setAnswers(pending.questions.map(() => ({ picks: [], other: '' }))); setNote(''); }, [pending.id]);
  const toggle = (qi: number, n: number) => setAnswers(xs => xs.map((a, i) => {
    if (i !== qi) return a;
    const multi = !!pending.questions[qi].multiSelect;
    const picks = a.picks.includes(n) ? a.picks.filter(x => x !== n) : multi ? [...a.picks, n].sort((x, y) => x - y) : [n];
    return { picks, other: '' };
  }));
  const ready = answers.every(a => a.picks.length > 0 || a.other.trim());
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setNote('');
    try {
      const raw = await api.on(session.host || 'local', ['reply', 'answer', session.session_id, '--agent', session.agent, '--json'], JSON.stringify({ tool_id: pending.id, questions: pending.questions, answers: answers.map(a => a.other.trim() ? { other: a.other.trim() } : { picks: a.picks }) }));
      const r = JSON.parse(raw.slice(raw.indexOf('{'))) as { state: string; note: string };
      if (r.state === 'accepted') onAnswered(); else setNote(r.note);
    } catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="session-question" aria-label="Agent 的提问">
    <div className="sq-head"><span className="conversation-caption">Agent 在问你</span><span className="muted small">{pending.questions.length > 1 ? `${pending.questions.length} 题` : ''}</span></div>
    {pending.questions.map((q, qi) => <div key={qi} className="sq-q">
      <div className="sq-title">{q.header && <span className="sq-tag">{q.header}</span>}{q.question}{q.multiSelect && <span className="muted small"> · 可多选</span>}</div>
      <div className="sq-options">
        {q.options.map((o, oi) => { const n = oi + 1; const on = answers[qi]?.picks.includes(n); return <button key={oi} type="button" className={`sq-opt${on ? ' on' : ''}`} onClick={() => toggle(qi, n)} disabled={busy}><span className="sq-n">{n}</span><span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span></button>; })}
        <label className={`sq-opt sq-other${answers[qi]?.other ? ' on' : ''}`}><span className="sq-n">{q.options.length + 1}</span><input placeholder="其他：自己写一句" value={answers[qi]?.other ?? ''} disabled={busy} onChange={e => setAnswers(xs => xs.map((a, i) => i === qi ? { picks: [], other: e.target.value } : a))} /></label>
      </div>
    </div>)}
    <div className="sq-actions"><button className="btn primary" type="button" disabled={!ready || busy} onClick={() => void submit()}>{busy ? '提交中…' : '回答'}</button>{note && <span className="reply-error">{note}</span>}</div>
  </section>;
}
