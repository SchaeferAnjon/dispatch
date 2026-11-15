// The delivery page's local server, the pure part (the server is src/deliveryPage.ts).
//
// `dispatch deliver … --show` asks the Agents window to open a delivery page (kanban
// app/cli/deliver.py). The bridge serves that page's folder on 127.0.0.1 under a random token and
// opens it from there, so the page's Choose A / B can ask the bridge to record the pick. The one
// thing a page can ask for is `dispatch flow pick <its own task> <A-F> --reason <text>`: the task
// comes from the show request, never from the page, and nothing else is run.

export type Route =
  | { kind: "file"; rel: string }
  | { kind: "state" }
  | { kind: "pick" };

export interface Pick {
  option: string;
  reason: string;
}

const TOKEN = /^[a-f0-9]{32}$/;
const TASK = /^[A-Za-z][\w.-]{1,60}$/;
export const MAX_BODY = 4096;
export const MAX_REASON = 300;

export function isToken(t: string): boolean {
  return TOKEN.test(t);
}

export function isTask(t: string): boolean {
  return TASK.test(t);
}

/** The route of a request path `/<token>/…` for this token; undefined for anything else. */
export function routeOf(rawPath: string, token: string): Route | undefined {
  if (!isToken(token)) return undefined;
  const q = rawPath.indexOf("?");
  const p = q >= 0 ? rawPath.slice(0, q) : rawPath;
  const prefix = `/${token}/`;
  if (!p.startsWith(prefix)) return undefined;
  let rest: string;
  try {
    rest = decodeURIComponent(p.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (rest === "__dispatch/state") return { kind: "state" };
  if (rest === "__dispatch/pick") return { kind: "pick" };
  if (rest === "") rest = "index.html";
  if (/[\0\\]/.test(rest) || rest.startsWith("/") || rest.split("/").some((s) => s === ".." || s === "." || s === "")) return undefined;
  if (rest.startsWith("__dispatch/") || rest.split("/").some((s) => s.startsWith("."))) return undefined;
  return { kind: "file", rel: rest };
}

/** The token of a request path (its first segment), "" when there is none. */
export function tokenOf(rawPath: string): string {
  const m = /^\/([a-f0-9]{32})(?:\/|$)/.exec(rawPath);
  return m ? m[1] : "";
}

/** Only requests addressed to this server by its loopback address (no DNS rebinding through a name). */
export function hostOk(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}`;
}

/** A pick has to come from the page itself: same origin, JSON (a cross-site form cannot send that). */
export function pickAllowed(headers: { origin?: string; "content-type"?: string; host?: string }, port: number): boolean {
  const ct = (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  return hostOk(headers.host, port) && headers.origin === `http://127.0.0.1:${port}` && ct === "application/json";
}

/** The body of a pick, or an error in words. */
export function parsePick(body: string): Pick | { error: string } {
  if (body.length > MAX_BODY) return { error: "too long" };
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(body);
  } catch {
    return { error: "not JSON" };
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { error: "not an object" };
  const option = typeof rec.option === "string" ? rec.option.trim().toUpperCase() : "";
  if (!/^[A-F]$/.test(option)) return { error: "option must be one of A to F" };
  const raw = rec.reason === undefined || rec.reason === null ? "" : rec.reason;
  if (typeof raw !== "string") return { error: "reason must be text" };
  // one line, no control characters, capped: it becomes a --reason argument (never a shell string)
  const reason = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  return { option, reason };
}

/** The argv for recording the pick: always exactly this command. */
export function pickArgs(task: string, pick: Pick): string[] {
  if (!isTask(task)) throw new Error("bad task");
  return ["flow", "pick", task, pick.option, "--reason", pick.reason, "--json"];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** The content type of a file we serve; undefined for kinds we do not serve. */
export function contentType(rel: string): string | undefined {
  const m = /\.[A-Za-z0-9]+$/.exec(rel);
  return m ? TYPES[m[0].toLowerCase()] : undefined;
}

/** What `dispatch flow show --json` says, cut to what the page may know. */
export function pageState(kind: string, flow: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: true, kind };
  if (kind !== "proposal" || !flow) return out;
  const state = typeof flow.state === "string" ? flow.state : "";
  out.state = state;
  if (state === "picked" && typeof flow.picked === "string") {
    out.picked = flow.picked;
    out.reason = typeof flow.reason === "string" ? flow.reason : "";
  }
  return out;
}

/** What the page gets back from a pick: the words it shows, no ids. */
export function pickAnswer(res: Record<string, unknown>): Record<string, unknown> {
  if (!res || res.ok !== true) return { ok: false, error: typeof res?.error === "string" ? res.error : "the pick was not recorded" };
  const impl = (res.impl && typeof res.impl === "object" ? res.impl : {}) as Record<string, unknown>;
  const option = (res.option && typeof res.option === "object" ? res.option : {}) as Record<string, unknown>;
  return {
    ok: true,
    picked: res.picked,
    title: typeof option.title === "string" ? option.title : "",
    reason: typeof res.reason === "string" ? res.reason : "",
    impl: { title: typeof impl.title === "string" ? impl.title : "" },
    project: typeof res.project === "string" ? res.project : "",
  };
}

/**
 * Draw and ask in the Agents window's Docs tab puts a long page together a screen at a time (Dispatch IDE
 * patches/435-docs.patch, drawScrollAgent: the same agent). A delivery page sits in an iframe
 * there, so it answers its parent: `{dispatchDraw: "metrics" | "scroll", id, y?, hideFixed?}` in,
 * `{dispatchDraw: "done", id, m: {top, height, vh}}` back once painted there. Fixed and sticky elements
 * step out while `hideFixed`, so a bar that stays on screen is in the picture once. Lazy pictures load at
 * once, and a screen is answered once the pictures on it are in (up to 1.5 s).
 */
export const DRAW_SCROLL_AGENT =
  "<script>(function(){if(window.parent===window)return;var hidden=null;" +
  // The Docs toolbar owns document actions. Keep the template's standalone controls outside Docs.
  "var style=document.createElement('style');style.textContent='.where .enl,.pic .zoom{display:none!important}.where .vp{cursor:zoom-in}';document.head.appendChild(style);" +
  "var down=null;addEventListener('pointerdown',function(e){var v=e.target.closest&&e.target.closest('.where:not(.full):not(.still) .vp');down=v?{v:v,x:e.clientX,y:e.clientY}:null;},true);" +
  "addEventListener('pointerup',function(e){var d=down;down=null;if(!d||Math.abs(e.clientX-d.x)+Math.abs(e.clientY-d.y)>4)return;var w=d.v.closest('.where'),b=w.querySelector('.enl');if(b){setTimeout(function(){var a=w.querySelector('.all');if(a)a.click();b.click();},0);}},true);" +
  "addEventListener('keydown',function(e){if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('.lb,.where.full,.proto.full')){window.parent.postMessage({dispatchDraw:'escape'},'*');}},true);" +
  "function se(){return document.scrollingElement||document.documentElement;}" +
  "function m(){var s=se();return {top:s.scrollTop,height:Math.max(s.scrollHeight,document.body?document.body.scrollHeight:0),vh:innerHeight};}" +
  "function fixed(on){if(on&&!hidden){hidden=[];var all=document.body?document.body.getElementsByTagName('*'):[];for(var i=0;i<all.length&&i<20000;i++){var p=getComputedStyle(all[i]).position;if(p==='fixed'||p==='sticky'){hidden.push([all[i],all[i].style.visibility]);all[i].style.visibility='hidden';}}}else if(!on&&hidden){for(var j=0;j<hidden.length;j++){hidden[j][0].style.visibility=hidden[j][1];}hidden=null;}}" +
  "function eager(){var im=document.images;for(var i=0;i<im.length;i++){if(im[i].loading==='lazy'){im[i].loading='eager';}}}function settle(done){var t0=Date.now();(function w(){var im=document.images,pend=false;for(var i=0;i<im.length;i++){var r=im[i].getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&r.width>0&&!im[i].complete){pend=true;break;}}if(pend&&Date.now()-t0<1500){setTimeout(w,50);}else{requestAnimationFrame(function(){requestAnimationFrame(done);});}})();}" +
  "addEventListener('message',function(e){var d=e.data;if(!d||typeof d.dispatchDraw!=='string'||d.dispatchDraw==='done'||e.source!==window.parent)return;" +
  "var done=function(){window.parent.postMessage({dispatchDraw:'done',id:d.id,m:m()},'*');};" +
  "if(d.dispatchDraw==='scroll'){fixed(!!d.hideFixed);var s=se(),b=s.style.scrollBehavior;s.style.scrollBehavior='auto';s.scrollTop=d.y;s.style.scrollBehavior=b;settle(done);}else{eager();done();}});})();</script>";

/** An HTML file of a delivery page as served: with {@link DRAW_SCROLL_AGENT} at the top of its head. */
export function withDrawScrollAgent(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + DRAW_SCROLL_AGENT + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + DRAW_SCROLL_AGENT + html.slice(doctype[0].length);
  return DRAW_SCROLL_AGENT + html;
}
