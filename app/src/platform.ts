// Platform helpers for the webview. Paths from the CLI and the Rust shell always use forward slashes
// (C:/Users/x/proj on Windows), so the helpers here only split on "/" after toSlash().

export type Platform = 'mac' | 'windows' | 'other';

function detect(): Platform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  return 'other';
}

let current: Platform = detect();

export let isMac = current === 'mac';
export let isWindows = current === 'windows';

/** Override the detected platform (tests only). Pass null to go back to the user agent. */
export function __setPlatformForTests(p: Platform | null): void {
  current = p ?? detect();
  isMac = current === 'mac';
  isWindows = current === 'windows';
}

export function platform(): Platform {
  return current;
}

/** Modifier prefix for shortcut labels: '⌘' on macOS, 'Ctrl+' elsewhere. */
export function modKey(): string {
  return current === 'mac' ? '⌘' : 'Ctrl+';
}

/** Home directory prefix: /Users/x, /home/x, C:/Users/x (either slash, any drive letter). */
export const HOME_RE = /^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\/Users\/[^/]+)/i;

export function toSlash(p: string): string {
  return (p ?? '').replace(/\\/g, '/');
}

/** The home directory `p` lies in ('/Users/x', 'C:/Users/x'), or '' when it is not under one. */
export function homeOf(p: string): string {
  return toSlash(p).match(HOME_RE)?.[0] ?? '';
}

/** True when `p` is exactly a home directory (trailing slash allowed). */
export function isHome(p: string): boolean {
  const s = toSlash(p);
  const h = homeOf(s);
  return !!h && s.replace(/\/+$/, '').length === h.length;
}

/** Display form: home directory to '~', the iCloud Drive and Obsidian containers to short names. */
export function shortPath(p: string): string {
  return toSlash(p)
    .replace(new RegExp(HOME_RE.source + '(?=/|$)', 'i'), '~')
    .replace('/Library/Mobile Documents/com~apple~CloudDocs', '/iCloud')
    .replace('/Library/Mobile Documents/iCloud~md~obsidian/Documents', '/Obsidian');
}

/** Parent folder ('' for a bare name). Splits on either slash. */
export function dirname(p: string): string {
  const s = toSlash(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i + 1);
  return s.slice(0, i);
}

/** Last path component. Splits on either slash. */
export function basename(p: string): string {
  const parts = (p ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function normFor(p: string, caseless: boolean): string {
  let s = toSlash(p).replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(s) || caseless) s = s.toLowerCase();
  return s;
}

/** True when `p` is `root` or inside it. Case-insensitive for drive-letter paths and on Windows. */
export function isUnder(p: string, root: string): boolean {
  if (!p || !root) return false;
  const caseless = current === 'windows';
  const a = normFor(p, caseless);
  const b = normFor(root, caseless);
  if (!b) return a.startsWith('/');
  return a === b || a.startsWith(b + '/');
}
