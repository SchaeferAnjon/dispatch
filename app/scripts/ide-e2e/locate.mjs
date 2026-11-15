// Finding an element in the page from what a person would say: its visible text or its aria-label.
// `locate` runs in the page (injected with toString()); it returns every visible candidate with a
// score, best first. Pure enough to read: no Dispatch-specific selectors here.

/**
 * @param {string|{text?: string, aria?: string, css?: string, within?: string, index?: number, exact?: boolean}} spec
 * @param {Document} [doc] the document to search (a webview's inner frame); the page's by default
 * @returns {{count: number, hits: {box: {x:number,y:number,w:number,h:number}, label: string, tag: string, score: number}[]}}
 */
export function locate(spec, doc) {
  const d = doc || document;
  const win = d.defaultView || window;
  const s = typeof spec === "string" ? { any: spec } : spec || {};
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  // "New Session (Command+N)" -> "New Session"; "Waiting for you, 0" -> "Waiting for you"
  const bare = (t) => norm(t).replace(/\s*\((?:[⌘⌃⌥⇧]|Command|Ctrl|Alt|Shift)[^)]*\)$/, "").replace(/,\s*\d+$/, "");
  const roots = s.within ? [...d.querySelectorAll(s.within)] : [d.body];
  const W = win.innerWidth;
  const H = win.innerHeight;
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) return false;
    const cs = win.getComputedStyle(e);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const ownText = (e) => {
    let t = "";
    for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent;
    return norm(t);
  };
  const want = norm(s.any ?? s.text ?? s.aria ?? "");
  const wantL = want.toLowerCase();
  const scored = [];
  const seen = new Set();
  for (const root of roots) {
    const all = s.css ? root.querySelectorAll(s.css) : root.querySelectorAll("*");
    for (const e of all) {
      if (seen.has(e) || !visible(e)) continue;
      seen.add(e);
      let score = 0;
      if (s.css && !want) score = 50;
      else {
        const aria = norm(e.getAttribute("aria-label"));
        const text = norm(e.innerText);
        const own = ownText(e);
        const title = norm(e.getAttribute("title"));
        const hint = norm(e.getAttribute("placeholder"));
        if (s.text === undefined) {
          if (aria && aria === want) score = 100;
          else if (aria && bare(aria) === want) score = 95;
          else if (hint && hint === want) score = 92;
          else if (!s.exact && aria && aria.toLowerCase().startsWith(wantL)) score = 60;
          else if (!s.exact && hint && hint.toLowerCase().startsWith(wantL)) score = 58;
          else if (title && (title === want || bare(title) === want)) score = 55;
        }
        if (s.aria === undefined && score < 90) {
          if (own === want) score = Math.max(score, 90);
          else if (text === want) score = Math.max(score, 85);
          else if (!s.exact && text && text.toLowerCase().startsWith(wantL) && text.length <= want.length + 40) score = Math.max(score, 40);
        }
      }
      if (!score) continue;
      let r = e.getBoundingClientRect();
      // a heading or row found by its text: the box of the text itself, not the full-width block
      if (score >= 40 && !/^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(e.tagName) && norm(e.innerText)) {
        const rg = d.createRange();
        rg.selectNodeContents(e);
        const t = rg.getBoundingClientRect();
        if (t.width > 2 && t.height > 2 && r.width > t.width + 40) r = t;
      }
      scored.push({ e, score, box: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }
  }
  // best score first; among equals, the one earlier on the page (what a person reads first)
  scored.sort((a, b) => b.score - a.score || (a.e.compareDocumentPosition(b.e) & 4 ? -1 : 1));
  // drop a hit that merely contains a better or equal hit (the row around the label)
  const hits = scored.filter((h) => !scored.some((o) => o !== h && o.score >= h.score && h.e.contains(o.e)));
  const top = hits.length ? hits[0].score : 0;
  const best = hits.filter((h) => h.score === top);
  const out = (s.index !== undefined ? best.slice(s.index, s.index + 1) : best).concat(hits.filter((h) => h.score !== top));
  return {
    count: best.length,
    hits: out.slice(0, 8).map((h) => ({
      box: h.box,
      score: h.score,
      tag: h.e.tagName,
      label: norm(h.e.getAttribute("aria-label")) || norm(h.e.innerText).slice(0, 80) || norm(h.e.getAttribute("placeholder")),
    })),
  };
}
