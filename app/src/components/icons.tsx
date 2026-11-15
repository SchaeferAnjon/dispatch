import type { ReactElement } from "react";

// One 16px line icon set, 1.5 stroke, round caps: the sidebar, header, bottom bar and ⌘K panel all
// draw from here so they read as one system. `filled` is the selected-state variant (closed shapes
// get a soft fill in the current colour); the same name always means the same thing.
//
//   <Icon name="chat" />                  16px outline
//   <Icon name="chat" filled />           selected state (sidebar current page)
//   <Icon name="search" size={14} />      smaller where a row is tight
//
// Old names (project, board, skill, rule, pit) stay as aliases so existing call sites keep working.
const I: Record<string, ReactElement> = {
  home: <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z" />,
  folder: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" />,
  inbox: <path d="M2.5 9h3l1 1.5h3l1-1.5h3M3.5 3.5h9l1 5.5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9z" />,
  chat: <path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />,
  discuss: <><path d="M2 4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5.5L3.5 9.5V8H3a1 1 0 0 1-1-1z" /><path d="M11.5 6.5H13a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-.5V13l-2-1.5H8.5a1 1 0 0 1-1-1V9.5" /></>,
  tasks: <path d="M2.5 4.5l1 1 2-2M2.5 8.5l1 1 2-2M2.5 12.5l1 1 2-2M7.5 4h6M7.5 8h6M7.5 12h6" />,
  graph: <><circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="4" r="1.5" /><circle cx="8" cy="12" r="1.5" /><path d="M5 5.2l2.2 5.4M11 5.2l-2.2 5.4" /></>,
  agent: <><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 3v2M6 9h.01M10 9h.01" /></>,
  chart: <path d="M3 13h10M4.5 11V7M8 11V4M11.5 11V8.5" />,
  star: <path d="M8 2.5l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11.3l-3.5 1.9.8-3.9L2.4 6.6l3.9-.5z" />,
  doc: <path d="M4 2.5h5l3 3v8a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-10.5a.5.5 0 0 1 .5-.5zM9 2.5v3h3M6 8h4M6 10.5h4" />,
  book: <path d="M3 3.5a1 1 0 0 1 1-1h3.5v10H4a1 1 0 0 1-1-1zM8.5 2.5H12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8.5z" />,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></>,
  grid: <><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  think: <path d="M6 13.5h4M6.5 11.5h3M8 2.5a4 4 0 0 0-2.4 7.2c.5.4.9 1 .9 1.8h3c0-.8.4-1.4.9-1.8A4 4 0 0 0 8 2.5z" />,
  pen: <path d="M10.5 3 13 5.5 6 12.5H3.5V10zM9 4.5l2.5 2.5" />,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5z" /></>,
  term: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3.5" /></>,
  left: <path d="M9.5 3.5 5 8l4.5 4.5" />,
  right: <path d="M6.5 3.5 11 8l-4.5 4.5" />,
  down: <path d="M3.5 6.5 8 11l4.5-4.5" />,
  up: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  reply: <path d="M6.5 4 3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4v1" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
  undo: <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3" />,
  bolt: <path d="M9 2 3.5 9H8l-1 5 5.5-7H8z" />,
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" /></>,
  eye: <><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /></>,
  phone: <><rect x="4.5" y="2" width="7" height="12" rx="1.5" /><path d="M7 12h2" /></>,
  cal: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 7h11M5.5 2v3M10.5 2v3" /></>,
  sidebar: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></>,
  window: <><rect x="4.5" y="4.5" width="9" height="8" rx="1.5" /><path d="M2.5 10V4a1.5 1.5 0 0 1 1.5-1.5h7" /></>,
  help: <><circle cx="8" cy="8" r="5.5" /><path d="M6.4 6.3a1.7 1.7 0 0 1 3.3.6c0 1.1-1.7 1.4-1.7 2.4M8 11.2h.01" /></>,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />,
  archive: <><rect x="2.5" y="3" width="11" height="3" rx="1" /><path d="M3.5 6v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 8.5h3" /></>,
  more: <path d="M4 8h.01M8 8h.01M12 8h.01" />,
  bell: <path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9zM6.8 14h2.4" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />,
  play: <path d="M5 3.5v9l7-4.5z" />,
  send: <path d="M2.5 8 13.5 3 10 13.5 7.5 9zM7.5 9l6-6" />,
  filter: <path d="M2.5 3.5h11l-4.3 5v4l-2.4 1v-5z" />,
  shield: <path d="M8 2 13 4v3.8c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2V4z" />,
  branch: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="5.5" r="1.5" /><path d="M5 5.5v5M11 7c0 2.5-3 2.5-5.3 4" /></>,
  key: <><circle cx="5.5" cy="10.5" r="2.5" /><path d="M7.3 8.7 13 3M11 5l1.5 1.5" /></>,
  screen: <><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 13.5h4M8 11v2.5" /></>,
};
// Names the app used before this set; they point at the matching new icon.
const ALIAS: Record<string, string> = { project: "folder", board: "tasks", skill: "star", rule: "doc", pit: "book", overview: "grid" };

export const ICON_NAMES = Object.keys(I);

export function Icon({ name, size = 16, filled = false, className }: { name: string; size?: number; filled?: boolean; className?: string }) {
  const body = I[name] ?? I[ALIAS[name] ?? ""] ?? I.tasks;
  return (
    <svg className={`ic${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.2 : undefined} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {body}
    </svg>
  );
}
