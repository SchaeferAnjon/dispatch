import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Api } from '../api';
import { t } from '../i18n';
import { actorOf } from '../derive';
import { modelNameOf } from '../models';
import { newId, request } from '../chatStore';
import type { ChatApi, ChatAgent } from '../chatProtocol';

/** `dispatch session-control <op>` on a host: browse folders, release a terminal's hold on a conversation. */
export const control = async <T,>(api: Api, host: string, op: string, input: unknown): Promise<T> => JSON.parse(await api.on(host, ['session-control', op], JSON.stringify(input)));

const Context = createContext<{ api: Api | null; notify: (message: string, error?: boolean) => void } | null>(null);
export function SessionActions({ api, notify, children }: { api: Api | null; notify: (message: string, error?: boolean) => void; children: ReactNode }) {
  return <Context.Provider value={{ api, notify }}>{children}</Context.Provider>;
}

/** The app's Api and toast, for a component that talks to a session outside the conversation page (工作台 Detail). */
export function useSessionApi(): { api: Api | null; notify: (message: string, error?: boolean) => void } {
  const ctx = useContext(Context);
  return { api: ctx?.api ?? null, notify: ctx?.notify ?? (() => {}) };
}

// 「接管到 Dispatch」: the session goes on in Dispatch's own chat process. Claude has no lock on a
// transcript, so the terminal's TUI is stopped first (`session-control release`, refused while it
// works); Codex runs on the shared app-server, where both sides can watch the same thread, so it is
// opened directly. Resolves with the chat key; rejects with the reason to show in place.
export async function handoverToDispatch(api: Api, chat: ChatApi, s: { agent: string; session_id: string; cwd: string }, force = false): Promise<string> {
  if (s.agent !== 'claude-code' && s.agent !== 'codex') throw new Error(t('{agent} 还只能在终端里跑', { agent: s.agent }));
  if (s.agent === 'claude-code') {
    const r = await control<{ state?: string; message?: string }>(api, 'local', 'release', { session_id: s.session_id, agent: s.agent, ...(force ? { force: true } : {}) });
    if (r && (r.state === 'rejected' || r.state === 'failed' || r.state === 'busy')) throw new Error(r.message || t('它正在终端里跑，等它停下来再接'));
  }
  const e = await request(chat, { cmd: 'open', request_id: newId(), agent: s.agent as ChatAgent, cwd: s.cwd, resume: s.session_id }, 60000);
  return 'session' in e && typeof e.session === 'string' ? e.session : `${s.agent}:${s.session_id}`;
}
export function useHandover() {
  const ctx = useContext(Context);
  return async (chat: ChatApi, s: { agent: string; session_id: string; cwd: string }): Promise<string> => {
    if (!ctx?.api) throw new Error(t('应用内聊天只在电脑上的 Dispatch 里可用'));
    return handoverToDispatch(ctx.api, chat, s);
  };
}

/** Close an in-app conversation: chatd ends its process and drops it from chatd.json. The transcript
 *  stays; opening it again resumes it. */
export async function closeChat(chat: ChatApi, key: string): Promise<void> {
  await request(chat, { cmd: 'close', request_id: newId(), session: key }, 30000);
}
/** chatd holds this conversation with its process up (in a turn, idle, or waiting on you): it is still
 *  open in the background. One the idle timer already closed (`stopped`) is not. */
export const heldOpen = (a: { runner?: string; chat_lifecycle?: string; remote?: boolean } | null | undefined): boolean =>
  !!a && a.runner === 'dispatch' && !a.remote && a.chat_lifecycle !== 'stopped';

// Where a conversation runs, as the reply box's `terminal` / `desktop` toggle. terminal → desktop is
// the handover above; desktop → terminal closes Dispatch's chat and copies the resume command (Dispatch
// never opens a terminal itself). Resolves with the line to show.
export async function moveToTerminal(api: Api, chat: ChatApi, s: { agent: string; session_id: string; cwd: string }): Promise<string> {
  await closeChat(chat, `${s.agent}:${s.session_id}`);
  await api.copy(await api.resumeCmd(s.agent, s.session_id, s.cwd));
  return t('恢复命令已复制，去终端粘贴回车');
}
/** Which toggle a reply box shows: only for a Claude or Codex conversation on this Mac, in Dispatch IDE's webview (the phone page has no chat). */
export function toggleWhere(api: Api, s: { agent: string; host?: string; remote?: boolean }, where?: string): 'terminal' | 'desktop' | null {
  if (!api.chatAvailable || s.remote || (s.host && s.host !== 'local') || (s.agent !== 'claude-code' && s.agent !== 'codex')) return null;
  return where === 'terminal' || where === 'desktop' ? where : null;
}
/** Which side a conversation of the activity list runs on, for the header's ⋯ entry. */
export const whereOf = (a: { runner?: string }): 'terminal' | 'desktop' | undefined => (a.runner === 'dispatch' ? 'desktop' : a.runner === 'terminal' ? 'terminal' : undefined);

/** The header ⋯ entry that moves a conversation between Dispatch and a terminal: 接管到 Dispatch while a terminal
 *  holds it, 放回终端 while Dispatch runs it (closes the chat here and copies the resume command). */
export function useWhereFlip(api: Api | null, where: 'terminal' | 'desktop' | null, session: { agent: string; session_id: string; cwd: string }, busy?: boolean) {
  const { notify } = useSessionApi();
  const [moving, setMoving] = useState(false);
  const chat = api && api.chatAvailable ? api : null;
  if (!chat || !api || !where) return null;
  const run = async () => {
    setMoving(true);
    try {
      if (where === 'terminal') await handoverToDispatch(api, chat, session);
      else notify(await moveToTerminal(api, chat, session));
    } catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
    finally { setMoving(false); }
  };
  return {
    label: where === 'terminal' ? t('接管到 Dispatch') : t('放回终端'),
    title: busy && where === 'desktop' ? t('Agent 正在跑，这一轮结束再切到终端') : where === 'terminal' ? t('在终端里跑：接管到 Dispatch 里接着聊') : t('关掉 Dispatch 里的这段对话，复制恢复命令到终端接着跑'),
    disabled: moving || (where === 'desktop' && !!busy),
    run,
  };
}

/** 接管到 Dispatch / 放回终端 as a menu row (the header's ⋯); nothing when the conversation cannot move here. */
export function WhereItem({ api, where, session, busy, className, onDone }: { api: Api | null; where: 'terminal' | 'desktop' | null; session: { agent: string; session_id: string; cwd: string }; busy?: boolean; className?: string; onDone?: () => void }) {
  const flip = useWhereFlip(api, where, session, busy);
  if (!flip) return null;
  return <button type="button" role="menuitem" className={className} disabled={flip.disabled} title={flip.title} onClick={() => { onDone?.(); void flip.run(); }}>{flip.label}</button>;
}

/** The line under a reply box (DESIGN.md 输入框): only what it is doing, a dot while it runs or waits on you
 *  (idle shows none), and 在终端里跑 when a terminal holds it. Agent, model, Mac and folder are on hover. */
export function ConvStatus({ agent, model, host, cwd, state, tone, note, terminal }: { agent: string; model?: string; host?: string; cwd?: string; state: string; tone: 'run' | 'wait' | 'idle'; note?: string; terminal?: boolean }) {
  const name = actorOf(agent, '')?.name ?? agent;
  const hover = [name, model ? modelNameOf(model) : '', host ?? '', cwd ?? '', note ?? ''].filter(Boolean).join(' · ');
  return <span className="cstat" title={hover || undefined}>
    {tone !== 'idle' && <span className={`dotc${tone === 'wait' ? ' wait' : ''}`} />}
    <span className="cs-now">{state}</span>
    {terminal && <><i className="sep" aria-hidden="true">·</i><span className="cs-where">{t('在终端里跑')}</span></>}
  </span>;
}
