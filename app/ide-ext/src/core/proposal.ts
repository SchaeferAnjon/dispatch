// ⌘K proposals: which lines the edit covers and where they are when the person accepts.

export interface LineSpan {
  /** 0-based first line and last line (inclusive) */
  start: number;
  end: number;
}

/**
 * The whole lines a selection touches. A selection that ends at column 0 of a line (a triple
 * click, Shift+Down) does not include that line. An empty selection is the cursor's line.
 */
export function selectedLines(sel: { startLine: number; startCol: number; endLine: number; endCol: number }): LineSpan {
  let end = sel.endLine;
  if (end > sel.startLine && sel.endCol === 0) end -= 1;
  return { start: sel.startLine, end };
}

/** The document text with lines start..end (0-based, inclusive, without their final newline) replaced. */
export function replaceLines(text: string, span: LineSpan, replacement: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, span.start);
  const tail = lines.slice(span.end + 1);
  return [...head, replacement, ...tail].join("\n");
}

export function linesText(text: string, span: LineSpan): string {
  return text.split("\n").slice(span.start, span.end + 1).join("\n");
}

/**
 * Where the original selection is now. The person may have typed elsewhere while the model was
 * working: find the exact original lines, nearest to where they were. Undefined when they are gone.
 */
export function locate(text: string, original: string, expectedStart: number): LineSpan | undefined {
  const lines = text.split("\n");
  const want = original.split("\n");
  const n = want.length;
  let best: number | undefined;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (lines[i + k] !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok && (best === undefined || Math.abs(i - expectedStart) < Math.abs(best - expectedStart))) best = i;
  }
  return best === undefined ? undefined : { start: best, end: best + n - 1 };
}

/** ⌘K instruction: "@codebase …" asks for project context first. */
export function parseInstruction(raw: string): { instruction: string; codebase: boolean } {
  const m = /^\s*@codebase\b\s*/i.exec(raw);
  if (!m) return { instruction: raw.trim(), codebase: false };
  return { instruction: raw.slice(m[0].length).trim(), codebase: true };
}

export interface SearchHit {
  path: string;
  start: number;
  end: number;
  text: string;
}

/** The first `n` code-search hits as ⌘K context, skipping the lines being edited. */
export function contextFromHits(hits: SearchHit[], relPath: string, span: LineSpan, n = 6): SearchHit[] {
  const out: SearchHit[] = [];
  for (const h of hits) {
    const overlaps = h.path === relPath && h.start <= span.end + 1 && h.end >= span.start + 1;
    if (overlaps) continue;
    out.push({ path: h.path, start: h.start, end: h.end, text: h.text });
    if (out.length >= n) break;
  }
  return out;
}

/** The same limits as `dispatch ide edit` (ide.py EDIT_MAX_LINES / EDIT_MAX_CHARS): a larger
 *  selection would come back cut off at the model's output limit. */
export const EDIT_MAX_LINES = 500;
export const EDIT_MAX_CHARS = 20000;

export function selectionTooLarge(text: string): boolean {
  return text.split("\n").length > EDIT_MAX_LINES || text.length > EDIT_MAX_CHARS;
}
