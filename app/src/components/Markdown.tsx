import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// Strip YAML frontmatter (SKILL.md) and return it as key/values for a header table.
export function splitFrontmatter(src: string): { meta: [string, string][]; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: [], body: src };
  const meta: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith(" ")) meta.push([line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, "")]);
  }
  return { meta, body: src.slice(m[0].length) };
}

export function Markdown({ src, className }: { src: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(src ?? "", { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
  }, [src]);
  return <div className={`md sel-text${className ? " " + className : ""}`} dangerouslySetInnerHTML={{ __html: html }} onClick={(e) => {
    // Links open in the system browser, never inside the app webview.
    const a = (e.target as HTMLElement).closest("a");
    if (a && a.href) { e.preventDefault(); import("@tauri-apps/plugin-opener").then((o) => o.openUrl(a.href)).catch(() => window.open(a.href, "_blank")); }
  }} />;
}
