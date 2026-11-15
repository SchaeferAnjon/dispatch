// Tab completion: build the DeepSeek FIM request, read its answer, price it (design/full-ide/PLAN.md §3.2).

export const FIM_URL = "https://api.deepseek.com/beta/completions";
export const PREFIX_CHARS = 6000;
export const SUFFIX_CHARS = 2000;

export interface FimInput {
  /** path relative to the project, for the header comment */
  relPath: string;
  languageId: string;
  /** the whole document and the cursor offset in it */
  text: string;
  offset: number;
}

export interface FimRequest {
  body: {
    model: string;
    prompt: string;
    suffix: string;
    max_tokens: number;
    temperature: number;
    stop: string[];
  };
  multiline: boolean;
  linePrefix: string;
  lineSuffix: string;
}

const HASH_LANGS = new Set([
  "python", "shellscript", "shell", "ruby", "perl", "r", "yaml", "toml", "dockerfile", "makefile", "powershell", "elixir", "coffeescript", "julia", "nix",
]);
const DASH_LANGS = new Set(["sql", "lua", "haskell", "elm"]);
const HTML_LANGS = new Set(["html", "xml", "markdown", "vue", "svelte"]);

export function headerComment(relPath: string, languageId: string): string {
  if (HASH_LANGS.has(languageId)) return `# Path: ${relPath}\n`;
  if (DASH_LANGS.has(languageId)) return `-- Path: ${relPath}\n`;
  if (HTML_LANGS.has(languageId)) return `<!-- Path: ${relPath} -->\n`;
  if (languageId === "plaintext" || languageId === "json") return "";
  return `// Path: ${relPath}\n`;
}

/** The text before the cursor, at most PREFIX_CHARS, starting on a whole line. */
export function clipPrefix(text: string, offset: number, max = PREFIX_CHARS): string {
  if (offset <= max) return text.slice(0, offset);
  const s = text.slice(offset - max, offset);
  const nl = s.indexOf("\n");
  return nl >= 0 && nl < s.length - 1 ? s.slice(nl + 1) : s;
}

/** The text after the cursor, at most SUFFIX_CHARS, ending on a whole line. */
export function clipSuffix(text: string, offset: number, max = SUFFIX_CHARS): string {
  const s = text.slice(offset, offset + max);
  if (offset + max >= text.length) return s;
  const nl = s.lastIndexOf("\n");
  return nl > 0 ? s.slice(0, nl + 1) : s;
}

export function lineAround(text: string, offset: number): { linePrefix: string; lineSuffix: string } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  let end = text.indexOf("\n", offset);
  if (end < 0) end = text.length;
  return { linePrefix: text.slice(start, offset), lineSuffix: text.slice(offset, end).replace(/\r$/, "") };
}

/**
 * Worth asking the model here? After a letter, digit, `_`, `.`, an opening bracket, or on an empty
 * line (a fresh newline); after a space only when it follows a word or an operator. Never in the
 * middle of a word. An explicit request (Alt+\ etc.) always asks.
 */
export function shouldTrigger(linePrefix: string, lineSuffix: string, explicit: boolean): boolean {
  if (explicit) return true;
  if (/^[\w$]/.test(lineSuffix)) return false;
  if (linePrefix.trim() === "") return true;
  const last = linePrefix[linePrefix.length - 1];
  if (/[\w$.([{]/.test(last)) return true;
  if (last === " " && linePrefix.length > 1) return /[\w=:,>)]/.test(linePrefix[linePrefix.length - 2]);
  return false;
}

export function buildFimRequest(i: FimInput, model: string): FimRequest {
  const { linePrefix, lineSuffix } = lineAround(i.text, i.offset);
  const multiline = linePrefix.trim() === "";
  const prompt = headerComment(i.relPath, i.languageId) + clipPrefix(i.text, i.offset);
  return {
    body: {
      model,
      prompt,
      suffix: clipSuffix(i.text, i.offset),
      max_tokens: multiline ? 160 : 64,
      temperature: 0,
      stop: multiline ? ["\n\n"] : ["\n"],
    },
    multiline,
    linePrefix,
    lineSuffix,
  };
}

/**
 * The completion to show: one line when the cursor is mid-line, trailing blanks dropped, and the
 * part that repeats what already follows the cursor on this line cut off. "" when nothing is left.
 */
export function cleanCompletion(raw: string, lineSuffix: string, multiline: boolean): string {
  let t = raw.replace(/\r\n/g, "\n");
  if (!multiline) {
    const nl = t.indexOf("\n");
    if (nl >= 0) t = t.slice(0, nl);
  }
  t = t.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  const tail = lineSuffix.trim();
  if (tail && !multiline && t.endsWith(tail)) t = t.slice(0, t.length - tail.length).replace(/[ \t]+$/, "");
  return t.trim() === "" ? "" : t;
}

export interface FimUsage {
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
}

export function parseFimResponse(json: unknown): { text: string; usage: FimUsage } {
  const j = (json || {}) as {
    choices?: Array<{ text?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_cache_hit_tokens?: unknown };
  };
  const text = typeof j.choices?.[0]?.text === "string" ? (j.choices[0].text as string) : "";
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    text,
    usage: {
      prompt_tokens: n(j.usage?.prompt_tokens),
      cached_tokens: n(j.usage?.prompt_cache_hit_tokens),
      completion_tokens: n(j.usage?.completion_tokens),
    },
  };
}

/** Prices per million tokens as `dispatch ide usage today` gives them: [off-peak, peak]. */
export interface TabPrices {
  input_miss: [number, number];
  input_hit: [number, number];
  output: [number, number];
}

export const DEFAULT_PRICES: TabPrices = { input_miss: [0.15, 0.3], input_hit: [0.003, 0.006], output: [0.6, 1.2] };

/** The same estimate as ide.tab_usd: peak prices, so the daily cap errs on the safe side. */
export function costUsd(u: FimUsage, prices: TabPrices = DEFAULT_PRICES): number {
  const miss = Math.max(0, u.prompt_tokens - u.cached_tokens);
  return (miss * prices.input_miss[1] + u.cached_tokens * prices.input_hit[1] + u.completion_tokens * prices.output[1]) / 1e6;
}

/**
 * What a request may cost before its answer is in: every prompt character a token (code runs
 * about 3 to 4 characters per token, so this errs high) and the whole max_tokens, all uncached.
 * Reserved against the cap while the request is out, and booked as spent when it is aborted after
 * it went out (DeepSeek bills a request the client stopped waiting for).
 */
export function estimateUsage(body: FimRequest["body"]): FimUsage {
  return { prompt_tokens: Math.ceil((body.prompt.length + body.suffix.length) / 3), cached_tokens: 0, completion_tokens: body.max_tokens };
}
