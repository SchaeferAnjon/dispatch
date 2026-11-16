/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: the three small pages Point and talk shows outside the Agents window (task-0y0km, kanban
 *  design/screen-talk direction A, B's bar borrowed): the bar at the top of the recorded display, the thin frame round
 *  it, and the panel beside System Settings that holds Dispatch's icon to drag into the Screen Recording list.
 *
 *  Each is one self-contained HTML page (a data: URL: no files to ship, no access to anything), drawn in the
 *  window's theme colours. The main process updates it with executeJavaScript and hears its two clicks (Stop, the
 *  icon's drag) as console lines that start with `dispatch-pt:`. Icons are inline SVG: the codicon font is a file
 *  of the workbench these windows cannot load.
 *--------------------------------------------------------------------------------------------*/

import type { IPointTalkTheme } from '../common/dispatchPointTalk.js';

/** A line a page logs to ask the main process for something. */
export const POINT_TALK_PAGE_SIGNAL = 'dispatch-pt:';

/** The bar's own size (the window adds a margin for the shadow). */
export const POINT_TALK_BAR_SIZE = { width: 440, height: 36 } as const;
export const POINT_TALK_BAR_MARGIN = 16;
export const POINT_TALK_HELP_SIZE = { width: 300, height: 88 } as const;

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** A colour that is safe to put into CSS (theme colours come from the window: #rgb[a] or rgb[a](…)). */
function color(v: string, fallback: string): string {
	return /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\))$/.test(v.trim()) ? v.trim() : fallback;
}

function vars(t: IPointTalkTheme): string {
	return `--bg:${color(t.bg, t.dark ? '#1c1917' : '#fafaf9')};--border:${color(t.border, t.dark ? 'rgba(255,255,255,.15)' : '#e7e5e4')};`
		+ `--text:${color(t.text, t.dark ? '#fafaf9' : '#0c0a09')};--text2:${color(t.text2, t.dark ? '#a6a09b' : '#79716b')};`
		+ `--fill:${color(t.fill, t.dark ? '#fafaf9' : '#252525')};--fillText:${color(t.fillText, t.dark ? '#0c0a09' : '#fafaf9')};`
		+ `--pop:${t.dark ? '0 8px 24px -8px rgba(0,0,0,.6)' : '0 8px 24px -8px rgba(0,0,0,.16)'};`;
}

const BASE = `*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none}`;

/** Video camera, 14 px, the line glyph of codicon device-camera-video. */
const CAMERA = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2.2v6.4l-4-2.2"/></svg>`;
const STOP = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>`;

/**
 * The bar (B1 of the design, borrowed by A while Dispatch is not on the recorded display): the camera breathing, the
 * clock, the level, the words fading in from the left, the newest spot's number, Stop. Dragged by any part but Stop.
 */
export function pointTalkBarPage(theme: IPointTalkTheme, stopLabel: string, listening: string): string {
	const m = POINT_TALK_BAR_MARGIN;
	return `<!doctype html><html><head><meta charset="utf-8"><title>Point and talk</title><style>${BASE}
:root{${vars(theme)}}
.bar{position:absolute;left:${m}px;top:${m}px;width:${POINT_TALK_BAR_SIZE.width}px;height:${POINT_TALK_BAR_SIZE.height}px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--pop);color:var(--text2);-webkit-app-region:drag;cursor:default}
.cam{color:var(--text);display:grid;place-items:center;animation:breathe 2s ease-in-out infinite}
@keyframes breathe{50%{opacity:.8}}
.clock{width:36px;color:var(--text);font-variant-numeric:tabular-nums}
.meter{display:inline-flex;align-items:center;gap:2px;height:10px;width:18px}
.meter i{width:2px;border-radius:1px;background:var(--text);height:2px;transition:height .12s}
.live{flex:1;min-width:0;white-space:nowrap;overflow:hidden;direction:rtl;text-align:left;-webkit-mask-image:linear-gradient(to right,transparent 0,#000 16px)}
.live span{direction:ltr;unicode-bidi:plaintext}
.shim{background:linear-gradient(90deg,var(--text2) 0%,var(--text2) 40%,var(--text) 50%,var(--text2) 60%,var(--text2) 100%);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shim 2s linear infinite}
@keyframes shim{from{background-position:100% 0}to{background-position:0 0}}
.nd{display:inline-grid;place-items:center;min-width:16px;height:16px;border-radius:8px;background:var(--text);color:var(--bg);font-size:11px;font-weight:500;padding:0 4px;font-variant-numeric:tabular-nums;flex:none}
.nd[hidden]{display:none}
.nd.pop{animation:pop .15s ease-out}
@keyframes pop{50%{transform:scale(1.15)}}
.stop{-webkit-app-region:no-drag;height:24px;padding:0 8px;border:0;border-radius:4px;background:var(--fill);color:var(--fillText);display:inline-flex;align-items:center;gap:6px;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;flex:none;cursor:pointer}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="bar" role="status" aria-label="Point and talk is recording">
<span class="cam">${CAMERA}</span><span class="clock" id="clock">0:00</span><span class="meter" id="meter"><i></i><i></i><i></i><i></i><i></i></span>
<span class="live" id="live"><span class="shim">${esc(listening)}</span></span><span class="nd" id="spot" hidden></span>
<button class="stop" id="stop" type="button">${STOP}${esc(stopLabel)}</button>
</div>
<script>
document.getElementById('stop').addEventListener('click', () => console.log('${POINT_TALK_PAGE_SIGNAL}stop'));
window.__pt = s => {
	document.getElementById('clock').textContent = s.clock;
	const bars = document.querySelectorAll('#meter i');
	s.level.forEach((v, i) => { if (bars[i]) bars[i].style.height = (2 + Math.round(v * 8)) + 'px'; });
	const live = document.getElementById('live');
	if (s.words) { live.textContent = ''; const w = document.createElement('span'); w.textContent = s.words; live.appendChild(w); }
	const dot = document.getElementById('spot');
	dot.hidden = !s.spot;
	if (s.spot) { dot.textContent = String(s.spot); if (s.popped) { dot.classList.remove('pop'); void dot.offsetWidth; dot.classList.add('pop'); } }
};
</script></body></html>`;
}

/** The thin neutral frame round a display recorded from another one, and the ring where a spot is marked. */
export function pointTalkFramePage(theme: IPointTalkTheme): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Point and talk frame</title><style>${BASE}
:root{${vars(theme)}}
.frame{position:fixed;inset:0;border:2px solid color-mix(in srgb,var(--text2) 70%,transparent);pointer-events:none}
.ring{position:fixed;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:1.5px solid var(--text2);opacity:0;pointer-events:none}
.ring.go{animation:ring .8s cubic-bezier(0,0,.2,1)}
@keyframes ring{0%{opacity:.8;transform:scale(.4)}100%{opacity:0;transform:scale(1.3)}}
@media (prefers-reduced-motion:reduce){.ring.go{animation:none}}
</style></head><body><div class="frame"></div><div class="ring" id="ring"></div>
<script>
window.__ptRing = (x, y) => { const r = document.getElementById('ring'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); };
</script></body></html>`;
}

/**
 * The panel beside System Settings (the person's way for Mac apps: a tile to drag into the permission list, not a
 * "go and allow" button alone): the app's icon, one line, a close button.
 */
export function pointTalkHelpPage(theme: IPointTalkTheme, iconUrl: string, appName: string, closeLabel: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Point and talk permission</title><style>${BASE}
:root{${vars(theme)}}
.panel{position:absolute;inset:8px;display:flex;align-items:center;gap:12px;padding:0 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;box-shadow:var(--pop);color:var(--text);-webkit-app-region:drag}
.icon{width:48px;height:48px;flex:none;-webkit-app-region:no-drag;cursor:grab;-webkit-user-drag:element}
.icon img{width:48px;height:48px;display:block;pointer-events:none}
.t{flex:1;min-width:0;font-size:12px;line-height:1.45}
.t b{font-weight:500;display:block}
.t span{color:var(--text2)}
.x{-webkit-app-region:no-drag;width:20px;height:20px;border:0;border-radius:4px;background:none;color:var(--text2);display:grid;place-items:center;cursor:pointer;align-self:flex-start;margin-top:8px}
.x:hover{background:color-mix(in srgb,var(--text) 8%,transparent)}
</style></head><body><div class="panel">
<div class="icon" id="icon" draggable="true" title="${esc(appName)}"><img src="${esc(iconUrl)}" alt="${esc(appName)}"></div>
<div class="t"><b>Turn on ${esc(appName)} here</b><span>or drag it into the Screen &amp; System Audio Recording list</span></div>
<button class="x" id="x" type="button" aria-label="${esc(closeLabel)}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
</div><script>
document.getElementById('icon').addEventListener('dragstart', e => { e.preventDefault(); console.log('${POINT_TALK_PAGE_SIGNAL}drag'); });
document.getElementById('x').addEventListener('click', () => console.log('${POINT_TALK_PAGE_SIGNAL}close'));
</script></body></html>`;
}
