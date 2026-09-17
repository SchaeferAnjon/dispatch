// A small i18n layer, no library. Chinese is the source language: the *key* of every string is the
// Chinese text itself (`t("保存")`), so the zh dictionary is empty and en/de map that text to a
// translation. Missing entries fall back to the key, which makes a leftover easy to spot by grep.
//
//   t("已选 {n} 项", { n: 3 })        placeholders are `{name}`; values come from `params`
//   const t = useT();                 inside a component: re-renders when the locale changes
//   setLocale("de" | "en" | "zh" | "system")
//
// The choice lives in localStorage (`dispatch-locale`); "system" follows navigator.language
// (zh* → zh, de* → de, else en). Node (tests, SSR) has no window and uses zh, the source.
import { useSyncExternalStore } from "react";
import zh from "./locales/zh";
import en from "./locales/en";
import de from "./locales/de";

export type Locale = "zh" | "en" | "de";
export type LocalePref = Locale | "system";
export type Params = Record<string, string | number>;
export type Dict = Record<string, string | ((p: Params) => string)>;
export const LOCALE_KEY = "dispatch-locale";
export const LOCALES: Locale[] = ["zh", "en", "de"];
export const LOCALE_NAMES: Record<Locale, string> = { zh: "中文", en: "English", de: "Deutsch" };
const HTML_LANG: Record<Locale, string> = { zh: "zh-CN", en: "en", de: "de" };

const DICTS: Record<Locale, Dict> = { zh, en, de };

export function detectLocale(lang?: string): Locale {
  // Node ≥ 21 ships a global navigator (language "en-US"); only a real browser window counts.
  const l = (lang ?? (typeof window !== "undefined" && typeof navigator !== "undefined" ? navigator.language : "")) || "";
  if (!l) return "zh";
  if (/^zh/i.test(l)) return "zh";
  if (/^de/i.test(l)) return "de";
  return "en";
}
function readPref(): LocalePref {
  try { const v = typeof localStorage !== "undefined" ? localStorage.getItem(LOCALE_KEY) : null; return v === "zh" || v === "en" || v === "de" ? v : "system"; } catch { return "system"; }
}

let pref: LocalePref = readPref();
let locale: Locale = pref === "system" ? detectLocale() : pref;
const listeners = new Set<() => void>();

export const getLocale = (): Locale => locale;
export const getLocalePref = (): LocalePref => pref;

function applyToDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = HTML_LANG[locale];
  document.title = t("Dispatch 调度台");
}
function tellTauri() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/core").then((m) => m.invoke("set_locale", { locale })).catch(() => {});
}

/** Change the language: stored, applied to <html>/<title>, pushed to the tray, and every useT() re-renders. */
export function setLocale(next: LocalePref) {
  pref = next;
  try { if (next === "system") localStorage.removeItem(LOCALE_KEY); else localStorage.setItem(LOCALE_KEY, next); } catch { /* private mode */ }
  const resolved = next === "system" ? detectLocale() : next;
  const changed = resolved !== locale;
  locale = resolved;
  applyToDocument();
  tellTauri();
  if (changed) listeners.forEach((l) => l());
}
/** Called once at startup so <html lang>, <title> and the tray match the stored choice. */
export function initLocale() { applyToDocument(); tellTauri(); }

export function t(key: string, params?: Params): string {
  const v = DICTS[locale][key];
  let s = typeof v === "function" ? v(params ?? {}) : v ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  return s;
}
/** Render-time t(): the component re-renders when the locale changes. */
export function useT(): typeof t { useLocale(); return t; }
export function useLocale(): Locale { return useSyncExternalStore(subscribe, getLocale, getLocale); }
export function useLocalePref(): LocalePref { return useSyncExternalStore(subscribe, getLocalePref, getLocalePref); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** How each locale writes a relative or short time: en/de use Intl, zh keeps the compact hand-written form. */
export const intlLocale = (): string => HTML_LANG[locale];
