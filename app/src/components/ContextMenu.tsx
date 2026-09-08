import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Activity, Issue, View } from '../types';
import { useTaskMenu } from './TaskActions';
import { useConversationMenu } from './ConversationActions';

// Where a menu opens from. React's MouseEvent satisfies this, and so does the
// synthetic anchor the global right-click handler builds from a DOM element.
export type Anchor = { clientX: number; clientY: number; currentTarget: EventTarget | null; preventDefault(): void; stopPropagation(): void };
export const anchorAt = (el: HTMLElement | null, x: number, y: number): Anchor => ({ clientX: x, clientY: y, currentTarget: el, preventDefault() {}, stopPropagation() {} });

// One panel for every context menu: fixed position clamped to the window,
// Escape / click-outside to close, arrow keys between items, focus returned
// to the element the menu was opened from.
export function MenuPanel({ x, y, title, label, busy = false, onClose, returnTo, className = '', children }: { x: number; y: number; title?: string; label: string; busy?: boolean; onClose: () => void; returnTo?: HTMLElement | null; className?: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const el = panel.current; if (!el) return; el.style.left = `${Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8))}px`; el.style.top = `${Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8))}px`; el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [x, y]);
  useEffect(() => { const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); returnTo?.focus(); } }; window.addEventListener('keydown', esc, true); return () => window.removeEventListener('keydown', esc, true); }, [busy, onClose, returnTo]);
  const nav = (e: React.KeyboardEvent) => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const buttons = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const n = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (n + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); };
  return <div className="task-menu-shade" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }} onContextMenu={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <div ref={panel} className={`task-menu ${className}`} role="menu" aria-label={label} onKeyDown={nav}>
      {title && <div className="task-menu-title">{title}</div>}
      {children}
    </div>
  </div>;
}

export const MenuItem = ({ onClick, disabled, danger, hint, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; hint?: string; children: ReactNode }) => (
  <button role="menuitem" className={`${danger ? 'danger' : ''}${hint ? ' with-hint' : ''}`} disabled={disabled} onClick={onClick}>{children}{hint && <kbd>{hint}</kbd>}</button>
);

// ---- Project menu -----------------------------------------------------------

interface ProjectMenuActions { starred: (name: string) => boolean; archived: (name: string) => boolean; onFlag: (name: string, change: { starred?: boolean; archived?: boolean }) => void; onProject: (name: string) => void; onNew: (name: string) => void; onTasks: (name: string) => void }
const ProjectContext = createContext<(name: string, e: Anchor) => void>(() => {});
export const useProjectMenu = () => useContext(ProjectContext);
export function ProjectActions({ children, ...act }: ProjectMenuActions & { children: ReactNode }) {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number; from: HTMLElement | null } | null>(null);
  const open = (name: string, e: Anchor) => { e.preventDefault(); e.stopPropagation(); setMenu({ name, x: e.clientX, y: e.clientY, from: e.currentTarget as HTMLElement | null }); };
  const close = () => setMenu(null);
  const run = (fn: () => void) => { fn(); close(); };
  return <ProjectContext.Provider value={open}>{children}{menu && <MenuPanel x={menu.x} y={menu.y} title={menu.name} label="项目操作" onClose={close} returnTo={menu.from}>
    <MenuItem onClick={() => run(() => act.onProject(menu.name))}>进入项目</MenuItem>
    <MenuItem onClick={() => run(() => act.onNew(menu.name))}>在这个项目新建会话</MenuItem>
    <MenuItem onClick={() => run(() => act.onTasks(menu.name))}>只看它的任务</MenuItem>
    <hr />
    <MenuItem onClick={() => run(() => act.onFlag(menu.name, { starred: !act.starred(menu.name) }))}>{act.starred(menu.name) ? '取消收藏' : '收藏：置顶'}</MenuItem>
    <MenuItem onClick={() => run(() => act.onFlag(menu.name, { archived: !act.archived(menu.name) }))}>{act.archived(menu.name) ? '取消归档' : '归档：从工作台隐藏'}</MenuItem>
  </MenuPanel>}</ProjectContext.Provider>;
}

// ---- View menu (right-click on empty space) --------------------------------

export interface ViewMenuItem { label: string; hint?: string; onClick: () => void | Promise<void>; disabled?: boolean; danger?: boolean }
interface ViewMenuContext { open: (e: Anchor) => void; setExtras: (items: ViewMenuItem[]) => void }
const ViewContext = createContext<ViewMenuContext>({ open: () => {}, setExtras: () => {} });
export const useViewMenu = () => useContext(ViewContext).open;
// A view contributes its own entries (工作台: 全部展开/收起) while it is mounted.
export function useViewMenuExtras(items: ViewMenuItem[], deps: unknown[]) {
  const { setExtras } = useContext(ViewContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setExtras(items); return () => setExtras([]); }, deps);
}
export function ViewMenu({ items, children }: { items: ViewMenuItem[]; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; from: HTMLElement | null } | null>(null);
  const [extras, setExtras] = useState<ViewMenuItem[]>([]);
  const open = (e: Anchor) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, from: e.currentTarget as HTMLElement | null }); };
  const close = () => setMenu(null);
  const ctx = useRef<ViewMenuContext>({ open, setExtras });
  ctx.current.open = open;
  return <ViewContext.Provider value={ctx.current}>{children}{menu && <MenuPanel x={menu.x} y={menu.y} label="快捷操作" onClose={close} returnTo={menu.from}>
    {extras.map(i => <MenuItem key={i.label} disabled={i.disabled} hint={i.hint} onClick={() => { i.onClick(); close(); }}>{i.label}</MenuItem>)}
    {extras.length > 0 && <hr />}
    {items.map(i => <MenuItem key={i.label} disabled={i.disabled} hint={i.hint} onClick={() => { i.onClick(); close(); }}>{i.label}</MenuItem>)}
  </MenuPanel>}</ViewContext.Provider>;
}

// ---- Item menus: any view can describe a menu for its own kind of thing --------
// A row carries data-menu="skill" data-id="pdf-ingestion"; the view that owns skills
// registers a resolver that turns that id into a titled list of items.

export interface ItemMenuSpec { title: string; items: (ViewMenuItem | "-")[] }
type Resolver = (id: string, el: HTMLElement) => ItemMenuSpec | null;
interface ItemMenuContext { register: (kind: string, r: Resolver) => () => void; open: (kind: string, id: string, el: HTMLElement, e: Anchor) => boolean }
const ItemContext = createContext<ItemMenuContext>({ register: () => () => {}, open: () => false });
export function useItemMenu(kind: string, resolver: Resolver, deps: unknown[]) {
  const { register } = useContext(ItemContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => register(kind, resolver), deps);
}
export function ItemMenus({ children }: { children: ReactNode }) {
  const resolvers = useRef(new Map<string, Resolver>());
  const [menu, setMenu] = useState<{ spec: ItemMenuSpec; x: number; y: number; from: HTMLElement | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const ctx = useRef<ItemMenuContext>({
    register: (kind, r) => { resolvers.current.set(kind, r); return () => { if (resolvers.current.get(kind) === r) resolvers.current.delete(kind); }; },
    open: (kind, id, el, e) => { const r = resolvers.current.get(kind); const spec = r?.(id, el); if (!spec) return false; e.preventDefault(); e.stopPropagation(); setMenu({ spec, x: e.clientX, y: e.clientY, from: el }); return true; },
  });
  const close = () => setMenu(null);
  return <ItemContext.Provider value={ctx.current}>{children}{menu && <MenuPanel x={menu.x} y={menu.y} title={menu.spec.title} label="操作" busy={busy} onClose={close} returnTo={menu.from}>
    {menu.spec.items.map((i, n) => i === "-" ? <hr key={n} /> : <MenuItem key={i.label} disabled={i.disabled || busy} danger={i.danger} hint={i.hint} onClick={async () => { setBusy(true); try { await i.onClick(); } finally { setBusy(false); close(); } }}>{i.label}</MenuItem>)}
  </MenuPanel>}</ItemContext.Provider>;
}

// ---- Global dispatch --------------------------------------------------------

// Every row or card that stands for something carries a data attribute:
// data-task="id", data-session="<activityKey>", data-project="name". A right
// click anywhere finds the nearest one and opens the matching menu; empty
// space gets the view menu. Text fields and selected text keep the browser's.
export function GlobalContextMenu({ issues, sessions }: { issues: Issue[]; sessions: Map<string, Activity> }) {
  const openTask = useTaskMenu(); const openConversation = useConversationMenu(); const openProject = useProjectMenu(); const openView = useViewMenu(); const openItem = useContext(ItemContext).open;
  const latest = useRef({ issues, sessions, openTask, openConversation, openProject, openView, openItem });
  latest.current = { issues, sessions, openTask, openConversation, openProject, openView, openItem };
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('input,textarea,select,[contenteditable="true"]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      e.preventDefault();
      if (t.closest('.task-menu-shade,.overlay,.dialog')) return;
      const { issues, sessions, openTask, openConversation, openProject, openView, openItem } = latest.current;
      const found = ['[data-task]', '[data-session]', '[data-project]', '[data-menu]'].map(s => t.closest<HTMLElement>(s)).filter((x): x is HTMLElement => !!x);
      const nearest = found.length ? found.reduce((a, b) => (a.contains(b) ? b : a)) : null;
      const anchor = anchorAt(nearest ?? t, e.clientX, e.clientY);
      if (nearest?.dataset.task) { const i = issues.find(x => x.id === nearest.dataset.task); if (i) { openTask(i, anchor); return; } }
      if (nearest?.dataset.session) { const a = sessions.get(nearest.dataset.session); if (a) { openConversation(a, anchor); return; } }
      if (nearest?.dataset.project !== undefined) { openProject(nearest.dataset.project, anchor); return; }
      if (nearest?.dataset.menu && openItem(nearest.dataset.menu, nearest.dataset.id ?? '', nearest, anchor)) return;
      openView(anchor);
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);
  return null;
}

export const VIEW_SHORTCUTS: Partial<Record<View, string>> = { home: '⌘1', projects: '⌘2', inbox: '⌘3', sessions: '⌘4', board: '⌘5', graph: '⌘6', agents: '⌘7', stats: '⌘8', pitfalls: '⌘9' };
