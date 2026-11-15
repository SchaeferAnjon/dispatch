/* Dispatch Quiet markers: optional CLI measurements, no conversation mutation. */
import './dispatchLife.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IObservable, autorun } from '../../../../base/common/observable.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { isDispatchWindowIdle, onDidChangeDispatchWindowIdle } from '../../../../workbench/contrib/dispatchMotion/browser/dispatchIdle.js';
import { onDidChangeDispatchBoard } from '../../dispatchBoard/browser/dispatchBoard.js';
import { keepLastReading } from '../common/dispatchLifeReading.js';
import { contextGrid, contextGroups, IContextBreakdown } from '../common/dispatchContextGroups.js';

export interface Handoff {
 readonly id: string; readonly path: string; readonly task: string; readonly title: string;
 readonly after_turn?: number; readonly after_message?: number; readonly created_at?: number;
 /** The plan step in progress when it was written (index from 0). */
 readonly plan_step?: { readonly index?: number; readonly text?: string; readonly state?: string } | null;
}
function handoffTime(at?: number): string {
 if (!at) { return ''; }
 const d = new Date(at * 1000), now = new Date();
 const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
 return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}
interface Life {
 readonly elapsed_seconds?: number; readonly rounds?: number; readonly tool_steps?: number;
 readonly context_tokens?: number; readonly cumulative_read_tokens?: number; readonly limit_tokens?: number;
 readonly percent?: number; readonly status?: string; readonly handoff_state?: string; readonly handoffs?: readonly Handoff[];
 /** Claude Code's own /context rows after the last turn (dispatchContextUsage.ts); absent for other engines. */
 readonly breakdown?: IContextBreakdown;
}
/** 126.4k, 1.2M: a token count at a glance; the exact number is in the row's hover. */
function compact(n: number): string {
 return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n);
}
const cache = new Map<string, { at: number; value: Promise<Life | undefined> }>();
/** The last reading each session showed, so a view opened again (or a split's second one) starts from it. */
const lastShown = new Map<string, Life>();
function read(commands: ICommandService, session: string, maxAge = 8000): Promise<Life | undefined> {
 const old = cache.get(session);
 if (old && Date.now() - old.at < maxAge) { return old.value; }
 const value = commands.executeCommand<Life | undefined>('dispatch.sessionLife', session).catch(() => undefined);
 cache.set(session, { at: Date.now(), value });
 if (cache.size > 100) { cache.delete(cache.keys().next().value!); }
 return value;
}
function duration(seconds: number): string {
 const m = Math.floor(seconds / 60), h = Math.floor(m / 60);
 return h ? `${h}h ${m % 60}m` : m ? `${m}m ${Math.floor(seconds % 60)}s` : `${Math.floor(seconds)}s`;
}
/**
 * A quiet marker per handoff on a task card: right after the plan step that was in progress when it was written
 * (the plan's own list, when the card is open), else at the end of the card; it says when, and opens the handoff.
 */
export function handoffMarkers(parent: HTMLElement, handoffs: readonly Handoff[] | undefined, commands: ICommandService, store: DisposableStore, steps: readonly HTMLElement[] = [], plan: readonly { readonly text: string }[] = []): void {
 for (const h of handoffs ?? []) {
  const ps = h.plan_step;
  // the step by its text when the plan changed since, else by its index
  const byText = ps?.text ? plan.findIndex(p => p.text === ps.text) : -1;
  const at = byText >= 0 ? byText : typeof ps?.index === 'number' && ps.index < plan.length ? ps.index : -1;
  const step = at >= 0 ? steps[at] : undefined;
  const button = DOM.$<HTMLButtonElement>('button.dispatch-handoff-marker', { type: 'button' });
  const time = handoffTime(h.created_at);
  button.textContent = time ? `Context handed off · ${time}` : 'Context handed off';
  button.setAttribute('aria-label', `Context handed off${time ? ` at ${time}` : ''}: ${h.title}`);
  button.dataset.handoffId = h.id;
  if (step) {
   const li = DOM.$('li.dispatch-handoff-step');
   li.appendChild(button);
   step.after(li);
  } else {
   parent.appendChild(button);
  }
  store.add(DOM.addDisposableListener(button, 'click', e => {
   e.stopPropagation(); void commands.executeCommand('dispatch.openDoc', h.path, { task: h.task, reason: 'task' });
  }));
 }
}
export class DispatchSessionLife extends Disposable {
 private readonly content = this._register(new DisposableStore());
 private readonly root: HTMLElement;
 private readonly button: HTMLButtonElement;
 private readonly status: HTMLElement;
 private readonly detail: HTMLElement;
 private session = '';
 private value: Life | undefined;
 constructor(widget: ChatWidget, session: IObservable<ISession | undefined>, @ICommandService private readonly commands: ICommandService) {
  super();
  this.root = DOM.$('.dispatch-life');
  const input = widget.input.inputContainerElement?.closest<HTMLElement>('.interactive-input-part');
  const usage = input?.querySelector('.chat-context-usage-container');
  (usage ?? input)?.appendChild(this.root);
  input?.classList.add('dispatch-life-input');
  this._register(toDisposable(() => input?.classList.remove('dispatch-life-input')));
  const host = input?.closest('.chat-view-widget');
  if (host) {
   this._register(DOM.addDisposableListener(host, 'click', (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a');
    if (link?.textContent?.trim() !== 'Context handed off') { return; }
    const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
    let uri: URI;
    try { uri = URI.parse(href); } catch { return; }
    if (uri.scheme !== 'file' || !uri.path.endsWith('.md')) { return; }
    e.preventDefault(); e.stopPropagation();
    void this.commands.executeCommand('dispatch.openDoc', uri.fsPath, { reason: 'list' });
   }, true));
  }
  this.button = DOM.append(this.root, DOM.$<HTMLButtonElement>('button.dispatch-life-context', { type: 'button', 'aria-expanded': 'false' }));
  this.button.textContent = 'Context unavailable';
  this.status = DOM.append(input ?? this.root, DOM.$('span.dispatch-life-status', { role: 'status' }));
  // the card floats over the whole window, not inside the input (a narrow side chat cut it off at its left edge), but
  // inside the workbench element, where the theme's colours and the window's font are: it goes there when it opens,
  // since the input is not in the page yet while this runs
  this.detail = DOM.$('.dispatch-life-detail', { hidden: true });
  const page = DOM.getWindow(this.root);
  this._register(toDisposable(() => this.detail.remove()));
  const show = (open: boolean) => {
   this.detail.hidden = !open; this.button.setAttribute('aria-expanded', String(open));
   if (open) {
    const home = this.button.closest('.monaco-workbench');
    if (home && this.detail.parentElement !== home) { home.appendChild(this.detail); }
    this.place();
    // what Claude Code counted after its last reply may be newer than the last 10 s round
    void this.refresh(0);
   }
  };
  this._register(DOM.addDisposableListener(this.button, 'click', e => {
   e.preventDefault(); e.stopPropagation();
   show(this.detail.hidden !== false);
  }));
  this._register(DOM.addDisposableListener(this.root, 'keydown', e => {
   if (e.key === 'Escape' && !this.detail.hidden) { e.stopPropagation(); show(false); this.button.focus(); }
  }));
  // a click anywhere else closes it
  this._register(DOM.addDisposableListener(page, 'pointerdown', e => {
   const t = e.target as Node;
   if (!this.detail.hidden && !this.detail.contains(t) && !this.button.contains(t)) { show(false); }
  }, true));
  this._register(autorun(reader => {
   const next = session.read(reader)?.resource.toString() ?? '';
   // the same session again (its object changes as a turn starts): keep what is shown (dispatchLifeReading.ts)
   if (next !== this.session) { this.session = next; this.value = lastShown.get(next); }
   this.draw(); void this.refresh();
  }));
  // every 10 s; every 2 s while a handoff is due or saving, which takes a few seconds with a fast model: the status line
  // says "Saving progress" while it happens, not only "Progress saved" after it
  const win = DOM.getWindow(this.root);
  let ticks = 0;
  const timer = win.setInterval(() => {
   const soon = this.value?.status === 'limit' || this.value?.handoff_state === 'saving';
   if ((soon || ++ticks % 5 === 0) && !isDispatchWindowIdle() && this.root.isConnected && this.root.getBoundingClientRect().width) { void this.refresh(soon ? 1500 : undefined); }
  }, 2000);
  this._register(onDidChangeDispatchBoard(() => { cache.clear(); if (!isDispatchWindowIdle() && this.root.isConnected && this.root.getBoundingClientRect().width) { void this.refresh(); } }));
  this._register(onDidChangeDispatchWindowIdle(idle => { if (!idle && this.root.isConnected && this.root.getBoundingClientRect().width) { void this.refresh(); } }));
  this._register(toDisposable(() => { win.clearInterval(timer); this.status.remove(); this.root.remove(); }));
 }
 /** Above the Context entry, right edges lined up, never out of the window. */
 private place(): void {
  if (this.detail.hidden) { return; }
  const page = DOM.getWindow(this.root);
  const r = this.button.getBoundingClientRect(), w = this.detail.offsetWidth, h = this.detail.offsetHeight;
  this.detail.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, page.innerWidth - w - 8)))}px`;
  this.detail.style.top = `${Math.round(Math.max(8, r.top - h - 6))}px`;
 }
 private async refresh(maxAge?: number): Promise<void> {
  const session = this.session;
  if (!session) { return; }
  const value = await read(this.commands, session, maxAge);
  if (session !== this.session || this._store.isDisposed) { return; }
  this.value = keepLastReading(this.value, value);
  if (this.value?.percent !== undefined) {
   lastShown.delete(session); lastShown.set(session, this.value);
   if (lastShown.size > 100) { lastShown.delete(lastShown.keys().next().value!); }
  }
  this.draw();
 }
 private draw(): void {
  const v = this.value;
  this.root.hidden = !this.session;
  // one entry for context (the native ring is hidden in this window): a bar and the share of the handoff limit
  DOM.clearNode(this.button);
  const meter = DOM.append(this.button, DOM.$('span.dispatch-life-meter', { 'aria-hidden': 'true' }));
  DOM.append(meter, DOM.$('span')).style.width = `${Math.max(0, Math.min(100, v?.percent ?? 0))}%`;
  this.button.classList.toggle('over', (v?.percent ?? 0) >= 80);
  // past the line the number stops meaning much (a test's tiny line gives thousands of percent): it says so instead
  const over = (v?.percent ?? 0) > 100;
  const shown = v?.percent === undefined ? 'Context unavailable' : over ? 'Context over limit' : `Context ${Math.round(v.percent)}%`;
  DOM.append(this.button, DOM.$('span.dispatch-life-label', undefined, shown));
  this.button.setAttribute('aria-label', v?.percent === undefined ? 'Context unavailable' : over ? 'Context is over the handoff limit' : `Context ${Math.round(v.percent)}% of the handoff limit`);
  this.status.textContent = v?.handoff_state === 'saving' ? 'Saving progress for handoff…' : v?.handoff_state === 'failed'
   ? 'Progress could not be saved. Context kept.' : v?.handoff_state === 'complete' ? 'Progress saved. Continuing here.'
   : v?.status === 'limit' ? 'Handoff limit reached' : v?.status === 'warning' ? 'Approaching the handoff limit' : '';
  this.content.clear(); DOM.clearNode(this.detail);
  // what fills the context: Claude Code's own rows as a grid, one square per percent of its window, and a legend
  const groups = contextGroups(v?.breakdown);
  const b = v?.breakdown;
  if (groups && b?.max) {
   const used = groups.filter(g => g.key !== 'free' && g.key !== 'reserved').reduce((n, g) => n + g.tokens, 0);
   const head = DOM.append(this.detail, DOM.$('.dispatch-life-head'));
   DOM.append(head, DOM.$('span.dispatch-life-title', undefined, 'Context'));
   DOM.append(head, DOM.$('span.dispatch-life-total', undefined, `${compact(used)} of ${compact(b.max)} tokens · ${Math.round(used / b.max * 100)}%`));
   const chart = DOM.append(this.detail, DOM.$('.dispatch-life-chart'));
   const grid = DOM.append(chart, DOM.$('.dispatch-life-grid', { role: 'img', 'aria-label': groups.map(g => `${g.label} ${g.percent}%`).join(', ') }));
   for (const key of contextGrid(groups)) { DOM.append(grid, DOM.$(`span.dispatch-life-cell.${key}`)); }
   const legend = DOM.append(chart, DOM.$('.dispatch-life-legend'));
   for (const g of groups) {
    const line = DOM.append(legend, DOM.$(`.dispatch-life-row.${g.key}`));
    line.title = g.parts.map(p => `${p.name}: ${p.tokens.toLocaleString('en-US')} tokens`).join('\n');
    DOM.append(line, DOM.$(`span.dispatch-life-swatch.${g.key}`));
    DOM.append(line, DOM.$('span.dispatch-life-name', undefined, g.label));
    DOM.append(line, DOM.$('span.dispatch-life-tokens', undefined, compact(g.tokens)));
    DOM.append(line, DOM.$('span.dispatch-life-pct', undefined, `${g.percent}%`));
   }
  } else if (v?.percent !== undefined) {
   DOM.append(this.detail, DOM.$('.dispatch-life-head', undefined, DOM.$('span.dispatch-life-title', undefined, 'Context')));
   DOM.append(this.detail, DOM.$('.dispatch-life-note', undefined, 'The breakdown by kind (skills, MCP, conversation, system) comes from Claude Code; it shows after its next reply.'));
  }
  if (v?.percent !== undefined) {
   DOM.append(this.detail, DOM.$('.dispatch-life-share', undefined, v.limit_tokens
    ? v.percent > 100
     ? `Over the handoff limit of ${compact(v.limit_tokens)} tokens.`
     : `Handoff at ${compact(v.limit_tokens)} tokens: ${Math.round(v.percent)}% there. At the limit, progress is saved and the conversation continues in a fresh context.`
    : `${Math.round(v.percent)}% of the handoff limit.`));
  }
  const rows: [string, number | undefined, boolean?][] = [['Session duration', v?.elapsed_seconds, true], ['Turns', v?.rounds], ['Tool steps', v?.tool_steps], ['Context tokens', v?.context_tokens], ['Total read', v?.cumulative_read_tokens], ['Handoff limit', v?.limit_tokens]];
  for (const [label, value, elapsed] of rows) {
   if (value === undefined) { continue; }
   const line = DOM.append(this.detail, DOM.$('.dispatch-life-stat'));
   DOM.append(line, DOM.$('span', undefined, label)); DOM.append(line, DOM.$('span', undefined, elapsed ? duration(value) : value.toLocaleString('en-US')));
  }
  if (!this.detail.querySelector('.dispatch-life-stat') && !groups) { DOM.append(this.detail, DOM.$('div', undefined, 'Usage has not been reported yet.')); }
  this.place();
 }
}
