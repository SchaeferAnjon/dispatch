/*
 * What a page tells the window frame (App.tsx renders the frame):
 *
 *   useShellHeader({ title, chips, subtitle, actions }, [deps])
 *                                                   the 40px header: a title in place of the page name
 *                                                   (the open conversation's), its project chip, a one-line
 *                                                   note shown as the content's first line, and the main button
 *   useActionTarget(target, [deps])                 what the page has selected; the bottom bar shows its
 *                                                   main action (↵) and ⌘K lists everything it can do
 *
 * A target names the thing, App resolves it: { kind: "task", id } | { kind: "session", key: activityKey }
 * | { kind: "project", name }. `primary` overrides the bottom bar's main action for this page.
 * Both hooks clear what they set when the page unmounts. Without a published target App falls back to
 * the open task, the open conversation or the open project.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

export type ActionTarget =
  | { kind: "task"; id: string; primary?: PrimaryAction }
  | { kind: "session"; key: string; primary?: PrimaryAction }
  | { kind: "project"; name: string; primary?: PrimaryAction };
export type PrimaryAction = { label: string; run: () => void };
export type ShellHeader = { title?: string; chips?: string[]; subtitle?: ReactNode; actions?: ReactNode };

type Ctx = { setHeader: (h: ShellHeader | null) => void; setTarget: (t: ActionTarget | null) => void };
const ShellContext = createContext<Ctx>({ setHeader: () => {}, setTarget: () => {} });

export function useShellHeader(header: ShellHeader, deps: unknown[]) {
  const { setHeader } = useContext(ShellContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setHeader(header); }, deps);
  useEffect(() => () => setHeader(null), [setHeader]);
}

export function useActionTarget(target: ActionTarget | null, deps: unknown[]) {
  const { setTarget } = useContext(ShellContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setTarget(target); }, deps);
  useEffect(() => () => setTarget(null), [setTarget]);
}

/** App owns the state; pages reach it through the two hooks above. */
export function ShellProvider({ setHeader, setTarget, children }: Ctx & { children: ReactNode }) {
  const ctx = useRef<Ctx>({ setHeader, setTarget });
  return <ShellContext.Provider value={ctx.current}>{children}</ShellContext.Provider>;
}
