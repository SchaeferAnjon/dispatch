import { useEffect, useMemo, useRef } from "react";
import { useMedia, dataUrl } from "./Media";
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

export function Markdown({ src, className, onRelativeLink }: { src: string; className?: string; onRelativeLink?: (href: string) => void }) {
  const media = useMedia();
  const root = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const raw = marked.parse(src ?? "", { async: false }) as string;
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ["target"] });
    const dom = new DOMParser().parseFromString(clean, 'text/html');
    // `root@1.2.3.4` is an ssh target, not an address: undo marked's mailto autolink for user@host forms.
    for (const a of dom.querySelectorAll('a[href^="mailto:"]')) { const addr = a.getAttribute('href')!.slice(7); if (/^[^@]+@(\d{1,3}\.){3}\d{1,3}$/.test(addr) || !addr.includes('.')) a.replaceWith(dom.createTextNode(a.textContent || addr)); }
    if (media) for (const img of dom.querySelectorAll('img')) {
      const path = img.getAttribute('src') || '';
      if (path && !/^(https?:|data:|blob:)/i.test(path)) { img.dataset.attachment = path; img.removeAttribute('src'); img.alt = img.alt || '图片'; img.classList.add('local-image'); }
    }
    return dom.body.innerHTML;
  }, [src, Boolean(media)]);
  const markup = useMemo(() => ({ __html: html }), [html]);
  useEffect(() => {
    if (!media || !root.current) return;
    let alive = true;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const img = entry.target as HTMLImageElement; observer.unobserve(img);
        void media.read(img.dataset.attachment!).then(a => { if (alive) img.src = dataUrl(a); }).catch(() => { if (alive) { img.alt = '图片不可用，点击查看原因'; img.classList.add('unavailable'); } });
      }
    }, { rootMargin: '200px' });
    root.current.querySelectorAll('img[data-attachment]').forEach(img => observer.observe(img));
    return () => { alive = false; observer.disconnect(); };
  }, [html, media?.read]);
  return <div ref={root} className={`md sel-text${className ? " " + className : ""}`} dangerouslySetInnerHTML={markup} onClick={(e) => {
    const img = (e.target as HTMLElement).closest('img[data-attachment]') as HTMLImageElement | null;
    if (img && media) { media.open(img.dataset.attachment!); return; }
    const link = (e.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href') || '';
    if (onRelativeLink && href && !/^(https?:|mailto:|#|\/)/i.test(href)) { e.preventDefault(); onRelativeLink(href); return; }
    if (media && href && !/^(https?:|mailto:|#)/i.test(href)) { e.preventDefault(); media.open(href); return; }
    // Links open in the system browser, never inside the app webview.
    const a = (e.target as HTMLElement).closest("a");
    if (a && a.href) { e.preventDefault(); import("@tauri-apps/plugin-opener").then((o) => o.openUrl(a.href)).catch(() => window.open(a.href, "_blank")); }
  }} />;
}
