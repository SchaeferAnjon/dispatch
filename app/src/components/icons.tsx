// One consistent 14px stroke icon set for navigation. Same weight, same optical
// size, so the sidebar reads as one system instead of a row of unrelated glyphs.
const P: Record<string, string> = {
  home: "M3 7.5 8 3l5 4.5V13H9.5V9.5h-3V13H3z",
  inbox: "M2.5 9h3l1 1.5h3l1-1.5h3M2.5 9V4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5V9M2.5 9v2.5A1.5 1.5 0 0 0 4 13h8a1.5 1.5 0 0 0 1.5-1.5V9",
  board: "M3 3h3v10H3zM10 3h3v6h-3z",
  graph: "M3 8h3M6 8a1.5 1.5 0 1 0 3 0M9 8h1.5M10.5 5.5v5M10.5 5.5h2.5M10.5 10.5h2.5M3 8a1.5 1.5 0 1 1 0-.01",
  project: "M3 4.5h10v8H3zM3 4.5l2-2h3l1 2",
  folder: "M2.5 5.5V4a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z",
  chat: "M3 3.5h10v7H7l-3 2.5v-2.5H3z",
  discuss: "M2 3h8v5.5H5.5L3.5 10V8.5H2zM7 6.5h7V12h-1.5v1.5L10.5 12H7z",
  agent: "M8 3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3.5 13.5c.5-2.5 2.3-3.5 4.5-3.5s4 1 4.5 3.5",
  skill: "M8 2.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L8 10.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z",
  rule: "M4 3.5h8M4 6.5h8M4 9.5h5M4 12.5h3",
  pit: "M8 2.5l6 10.5H2zM8 7v3M8 11.5v.5",
  chart: "M3 13V8M6.5 13V4M10 13V6.5M13.5 13V9.5M2 13h12",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M3.8 12.2l1-1M11.2 4.8l1-1",
};

export function Icon({ name, size = 14 }: { name: keyof typeof P | string; size?: number }) {
  const d = P[name] ?? P.board;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
