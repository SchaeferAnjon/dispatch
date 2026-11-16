// Point and talk (direction A「Button by the input」, the person picked it 2026-11-16, task-0y0km; kanban
// design/screen-talk). Walked as a person does it, in a test instance that never touches the screen, the microphone or
// System Settings: the window's test sources draw a checkout page with a moving pointer and play a real Chinese take
// (macOS `say`, four sentences with pauses) into the microphone track; everything after that is real: the recorders,
// the files, Soniox's real-time socket with a temporary key, the spots where the pointer rests, the message, an
// OpenCode session on a cheap model answering it.
//   1. no Soniox key: the camera brings the key card;
//   2. first time: the permission card, Allow (macOS's dialog played), Open Settings, the switch turned on: Quit &
//      Reopen; then everything allowed and the recording starts by itself;
//   3. recording (A1): the words come while it plays, the spots get numbers; Stop;
//   4. stopped (A2): placeholders, then the keyframes, the video and four timed lines; change a line, remove a frame,
//      the video chip; Enter sends;
//   5. sent (A3): keyframes above the bubble, the video, the lines; a frame opens Where to look (A4), a line switches it;
//   6. Dispatch on another display: the bar at the top of the recorded one, its Stop; Discard.
// Light and dark screenshots, facts in qa.json.
export const meta = {
  needs: ['opencode', 'internet'], instance: { motion: true }, timeout: 900,
  title: "Point and talk：输入框里录屏口述",
  description: "测试实例里用假屏幕、假指针和一段真的中文语音：没 Key 的卡；第一次的权限卡（Allow、Open Settings、Quit & Reopen）；录制中边说边出字、指针停住出编号；停下后关键帧、视频片、逐句带时间，改一句、删一帧、Enter 发出；发出的消息和 Where to look；Dispatch 不在被录的屏上时的浮条和它的 Stop；Discard。浅色深色各截图。",
};

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { until, offscreen, onDemo, toDemo, focusInput, chooseCheapModel, closeTips } from "./session-now.mjs";

const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);
const T = "window.__dispatchPointTalkTest";
const INPUT = ".session-view .interactive-input-part";
const CAMERA = { css: `${INPUT} .chat-execute-toolbar .action-label.codicon-device-camera-video` };
const LAST = `(() => { const r = [...document.querySelectorAll('.session-view .interactive-response')].at(-1); return r ? r.innerText.trim() : ''; })()`;
const RUNNING = `!!document.querySelector('${INPUT} .chat-execute-toolbar .codicon-stop-circle')`;

// the take: on the Ship to field while the first sentence is said, on Shipping for the second, on Pay now for the
// third, moving all the time during the fourth (no spot)
const POINTER = [
  { t: 0, x: 320, y: 420 },
  { t: 150, x: 204, y: 236 },
  { t: 2800, x: 420, y: 270 },
  { t: 3000, x: 652, y: 292 },
  { t: 5800, x: 600, y: 380 },
  { t: 6100, x: 682, y: 452 },
  ...Array.from({ length: 22 }, (_, i) => ({ t: 9400 + i * 320, x: 300 + (i % 2) * 60 + i * 9, y: 560 + (i % 3) * 30 })),
];
const SPEECH = "[[slnc 600]]这里我把国家切到 Canada，[[slnc 900]]运费还是 15.40，应该跟着变。[[slnc 1200]]然后点 Pay now，它就一直转圈不停。[[slnc 1200]]两个都修，先修转圈那个。[[slnc 800]]";

/** The take's voice as a WAV, made on this Mac (macOS say, voice Tingting, 16 kHz mono). */
function makeVoice(dir) {
  const aiff = path.join(dir, "take.aiff");
  const wav = path.join(dir, "take.wav");
  execFileSync("say", ["-v", "Tingting", "-r", "190", "-o", aiff, SPEECH]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  fs.rmSync(aiff, { force: true });
  return wav;
}

export default async function (ui) {
  const qa = { checks: [], failed: [], facts: {} };
  const note = () => fs.writeFileSync(path.join(ui.out, "qa.json"), JSON.stringify(qa, null, 2));
  const check = (name, ok, detail) => {
    (ok ? qa.checks : qa.failed).push(detail === undefined ? name : `${name}: ${JSON.stringify(detail).slice(0, 600)}`);
    console.error(`${ok ? "ok" : "FAILED"}: ${name}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`);
    note();
  };
  const state = () => ui.eval(`${T}.state()`);
  const events = () => ui.eval(`${T}.events()`);
  const waitState = (fn, what, ms = 30000) => until(ui, async () => { const s = await state(); return s && fn(s) ? s : null; }, ms, what, 250);
  const shots = async (name) => {
    await closeTips(ui);
    await ui.setTheme("light");
    await ui.sleep(700);
    await ui.screenshot(`${name}-light`);
    await ui.setTheme("dark");
    await ui.sleep(700);
    await ui.screenshot(`${name}-dark`);
    await ui.setTheme("light");
    await ui.sleep(400);
  };
  const voice = makeVoice(ui.out);

  // a session on OpenCode's cheap model, the way a person starts one
  await offscreen(ui);
  try { await ui.openAgents(ui.demoFolder); } catch (e) { if (!/editor window/.test(String(e && e.message))) throw e; await ui.openAgents(); }
  await offscreen(ui);
  await closeTips(ui);
  await onDemo(ui);
  await ui.newSession();
  await toDemo(ui);
  await ui.pickEngine("OpenCode", 180000);
  await ui.sleep(1500);
  const model = await chooseCheapModel(ui, ".sessions-chat-editor");
  qa.facts.model = model;
  await focusInput(ui, ".sessions-chat-editor");
  await ui.type("Checkout 页你改完了吗？Reply with one short English sentence saying it is done and asking me to try it.");
  await ui.press("Enter", { send: true });
  await until(ui, async () => (await ui.eval(LAST)).length > 0 && !(await ui.eval(RUNNING)), 180000, "the first answer");
  await ui.waitFor(CAMERA, { timeoutMs: 20000 });
  const tip = await ui.eval(`(() => { const a = document.querySelector('${CAMERA.css}'); return a ? (a.getAttribute('aria-label') || a.title || '') : ''; })()`);
  check("the camera sits in the box's tool row, named with its shortcut", /Point and talk/.test(tip) && /⌃⇧S|Ctrl\+Shift\+S/.test(tip), tip);
  const order = await ui.eval(`[...document.querySelectorAll('${INPUT} .chat-execute-toolbar .action-label')].map(a => [...a.classList].find(c => c.startsWith('codicon-')) || a.getAttribute('aria-label'))`);
  qa.facts.toolOrder = order;
  check("camera after the microphone, before send", order.indexOf("codicon-device-camera-video") > order.findIndex(c => /mic/.test(c || "")) , order);

  // 1. no key
  await ui.eval(`${T}.configure({ key: false })`);
  await ui.click(CAMERA);
  await ui.waitFor({ css: ".dispatch-pt-card" }, { timeoutMs: 15000 });
  const keyCard = await ui.eval(`document.querySelector('.dispatch-pt-card').innerText`);
  check("no Soniox key: the card says where to add it", /Soniox key/.test(keyCard) && /SONIOX_API_KEY/.test(keyCard) && /Open Keys/.test(keyCard), keyCard);
  await ui.screenshot("a0-key");
  await ui.click({ text: "Not now", within: ".dispatch-pt-card" });
  await ui.waitFor({ css: ".dispatch-pt-card" }, { gone: true, timeoutMs: 5000 });

  // 2. first time: the two permissions
  await ui.eval(`${T}.configure(${JSON.stringify({ audio: voice, pointer: POINTER, access: { microphone: "not-determined", screen: "denied" } })})`);
  await ui.click(CAMERA);
  await ui.waitFor({ text: "Point and talk needs two permissions" }, { timeoutMs: 15000 });
  const card = await ui.eval(`(() => { const c = document.querySelector('.dispatch-pt-card'); const box = document.querySelector('${INPUT} .chat-input-container'); const b = c.getBoundingClientRect(), x = box.getBoundingClientRect();
    return { text: c.innerText, w: Math.round(b.width), boxW: Math.round(x.width), gap: Math.round(x.top - b.bottom), radius: getComputedStyle(c).borderTopLeftRadius,
      buttons: [...c.querySelectorAll('button')].map(e => ({ t: e.innerText, h: Math.round(e.getBoundingClientRect().height), wrap: e.scrollHeight > e.clientHeight + 1, ws: getComputedStyle(e).whiteSpace, r: getComputedStyle(e).borderTopLeftRadius })) }; })()`);
  check("the card is as wide as the box, right above it", Math.abs(card.w - card.boxW) <= 2 && card.gap >= 0 && card.gap <= 12, card);
  check("rows: Microphone Allow, Screen Recording Open Settings, Not now", /Microphone/.test(card.text) && /Allow/.test(card.text) && /Screen Recording/.test(card.text) && /Open Settings/.test(card.text) && /Not now/.test(card.text), card.text);
  check("buttons keep their words on one line, corners 4", card.buttons.every(b => !b.wrap && b.ws === "nowrap" && b.r === "4px"), card.buttons);
  await shots("a0-perm");
  await ui.click({ text: "Allow", exact: true, within: ".dispatch-pt-card" });
  await ui.waitFor({ text: "Allowed", within: ".dispatch-pt-card" }, { timeoutMs: 8000 });
  await ui.click({ text: "Open Settings", within: ".dispatch-pt-card" });
  await ui.sleep(500);
  check("Open Settings asked for System Settings (a test instance opens nothing)", (await events()).includes("open-screen-settings"), await events());
  // the person turns the switch on in System Settings: macOS wants Dispatch reopened
  await ui.eval(`${T}.set({ access: { microphone: 'granted', screen: 'granted', relaunch: true } })`);
  await ui.waitFor({ text: "Quit & Reopen", within: ".dispatch-pt-card" }, { timeoutMs: 8000 });
  const reopen = await ui.eval(`document.querySelector('.dispatch-pt-card').innerText`);
  check("after the switch: Quit & Reopen, and the sessions come back", /Quit & Reopen/.test(reopen) && /reopen once/.test(reopen) && /Allowed/.test(reopen), reopen);
  await shots("a0c-reopen");
  await ui.click({ text: "Quit & Reopen", within: ".dispatch-pt-card" });
  await ui.sleep(300);
  check("Quit & Reopen relaunches (a test instance only says so)", (await events()).includes("relaunch"));

  // 3. reopened, everything allowed: the recording starts by itself
  await ui.eval(`${T}.set({ access: { microphone: 'granted', screen: 'granted', relaunch: false } })`);
  const rec0 = await waitState(s => s.recording, "the recording to start", 20000);
  check("the card goes and the recording starts", rec0.recording && !(await ui.exists({ css: ".dispatch-pt-card" })), rec0);
  const words = await waitState(s => s.words.length >= 6, "the first words", 30000);
  check("the words come while the voice plays (Soniox real-time)", words.words.length >= 6, { words: words.words, at: words.elapsed });
  qa.facts.firstWordsAt = words.elapsed;
  const mid = await waitState(s => s.spots >= 2 && s.elapsed >= 6.5, "two spots marked", 30000);
  const a1 = await ui.eval(`(() => { const box = document.querySelector('${INPUT} .chat-input-container'); const s = box.querySelector('.dispatch-pt-slot'); const stop = s.querySelector('.pt-stop');
    return { cls: box.className, border: getComputedStyle(box).borderTopColor, live: s.querySelector('.pt-live').innerText, clock: s.querySelector('.pt-clock').innerText, dot: s.querySelector('.pt-dot').innerText,
      stop: stop.innerText, stopR: getComputedStyle(stop).borderTopLeftRadius, editorHidden: getComputedStyle(box.querySelector('.chat-editor-container')).display === 'none',
      label: s.querySelector('.pt-rec-label')?.innerText, recDot: s.querySelector('.pt-rec') ? getComputedStyle(s.querySelector('.pt-rec')).backgroundColor : null,
      recAnim: s.querySelector('.pt-rec') ? getComputedStyle(s.querySelector('.pt-rec')).animationName : null, red: getComputedStyle(document.body).getPropertyValue('--vscode-errorForeground').trim() }; })()`);
  // the red of the dot and of the border is the theme's errorForeground (task-dd4hw: the person could not tell it was recording)
  const reddish = c => { const m = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(c || ""); return !!m && Number(m[1]) > 150 && Number(m[1]) > Number(m[2]) * 1.6 && Number(m[1]) > Number(m[3]) * 1.6; };
  check("A1: the box shows a breathing red dot, Recording, the words, the clock, the newest number and Stop with its word", a1.editorHidden && a1.live.length > 0 && a1.label === "Recording" && reddish(a1.recDot) && a1.recAnim === "pt-breathe" && /^0:0\d$/.test(a1.clock) && Number(a1.dot) >= 2 && a1.stop.trim() === "Stop", a1);
  check("A1: the box keeps its own border (no recording colour on it)", !reddish(a1.border), a1.border);
  check("A1: the moving red frame is on the recorded display from the start, without the bar", (await events()).includes("frame") && !(await events()).includes("bar"), await events());
  await shots("a1-rec");
  await ui.mark({ text: "Stop", exact: true, within: `${INPUT} .dispatch-pt-slot` }, { what: "录制中：边说边出字、计时、音量、最新编号", where: "输入框里，Stop 在发送键的位置", how: "点 Stop 或再按 ⌃⇧S 停下，Discard 丢掉" });
  const full = await waitState(s => s.elapsed >= 14, "the take to play out", 30000);
  qa.facts.spotsWhileRecording = full.spots;
  await ui.click({ text: "Stop", exact: true, within: `${INPUT} .dispatch-pt-slot` });
  const picking = await ui.eval(`!!document.querySelector('${INPUT} .dispatch-pt-slot.picking')`);
  check("Stop: placeholders and Picking frames… first", picking || (await events()).includes("review"));

  // 4. stopped: review in the box
  const rev = await waitState(s => !!s.review, "the review", 30000);
  qa.facts.review = rev.review;
  check("A2: four sentences, each with its time", rev.review.lines.length === 4, rev.review.lines);
  check("A2: three keyframes, numbered 1-3 in time order, on the first three sentences", rev.review.frames.length === 3 && rev.review.lines.slice(0, 3).map(l => l.n).join() === "1,2,3" && rev.review.lines[3].n === undefined, rev.review);
  const files = fs.existsSync(rev.review.folder) ? fs.readdirSync(rev.review.folder) : [];
  qa.facts.files = files.map(f => [f, fs.statSync(path.join(rev.review.folder, f)).size]);
  check("the recording's folder has the video, the voice, the spots and take.json", files.some(f => /^screen\.(mp4|webm)$/.test(f)) && files.includes("audio.webm") && files.filter(f => /^spot-\d+\.png$/.test(f)).length >= 3 && files.includes("take.json"), qa.facts.files);
  const a2 = await ui.eval(`(() => { const box = document.querySelector('${INPUT} .chat-input-container'); const s = box.querySelector('.dispatch-pt-slot.review');
    const th = [...s.querySelectorAll('.pt-th')].map(t => ({ w: Math.round(t.getBoundingClientRect().width), h: Math.round(t.getBoundingClientRect().height), lab: t.querySelector('.pt-lab').innerText.replace(/\\s+/g, ' '), boxes: t.querySelectorAll('.rb').length }));
    return { th, chip: s.querySelector('.pt-vchip').innerText.replace(/\\s+/g, ' '), chipTitle: s.querySelector('.pt-vchip').title, rows: [...s.querySelectorAll('.pt-row')].map(r => r.innerText.replace(/\\s+/g, ' ')),
      hiddenAttachments: box.querySelectorAll('.chat-attached-context-attachment.dispatch-pt-hidden').length, toolbar: getComputedStyle(box.querySelector('.chat-input-toolbars')).display,
      text: document.querySelector('${INPUT} .view-lines')?.innerText || '' }; })()`);
  qa.facts.a2 = a2;
  check("A2: thumbnails 144×96 with a red box, number and time", a2.th.length === 3 && a2.th.every(t => t.w === 144 && t.h === 96 && t.boxes === 1 && /^\d \d:\d\d$/.test(t.lab)), a2.th);
  check("A2: the video chip says Screen recording and its length; the path on hover", /^Screen recording \d:\d\d$/.test(a2.chip.trim()) && /screen\.(mp4|webm)$/.test(a2.chipTitle), a2);
  check("A2: the keyframes are the box's attachments (hidden behind the review), the box's own tool row stays", a2.hiddenAttachments === 3 && a2.toolbar !== "none", a2);
  // every framed element round the review, from the slot up to the input part: a border, an outline, a box shadow, or a
  // ::before / ::after ring that shows (task-dd4hw: the focused review got VS Code's [tabindex="-1"]:focus outline, a
  // darker frame inside the box; a border-only look missed it)
  qa.facts.reviewFrames = await ui.eval(`(() => {
    const clear = c => !c || c === 'transparent' || /rgba\\([^)]*,\\s*0\\)$/.test(c);
    const frame = (cs, pseudo) => {
      if (pseudo && (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || Number(cs.opacity) === 0)) return null;
      const f = [];
      if (['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && !clear(cs['border' + s + 'Color']))) f.push('border ' + cs.borderTopColor);
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && !clear(cs.outlineColor)) f.push('outline ' + cs.outlineWidth + ' ' + cs.outlineColor);
      if (cs.boxShadow && cs.boxShadow !== 'none') f.push('shadow ' + cs.boxShadow);
      if (pseudo && cs.backgroundImage !== 'none') f.push('ring ' + cs.backgroundImage.slice(0, 40));
      return f.length ? f : null;
    };
    const out = []; let e = document.querySelector('${INPUT} .dispatch-pt-slot'); const top = document.querySelector('${INPUT}');
    while (e && e !== top.parentElement) {
      const f = [frame(getComputedStyle(e), false), frame(getComputedStyle(e, '::before'), true), frame(getComputedStyle(e, '::after'), true)];
      if (f.some(Boolean)) { const r = e.getBoundingClientRect(); out.push({ cls: e.className, own: f[0], before: f[1], after: f[2], h: Math.round(r.height), top: Math.round(r.top) }); }
      e = e.parentElement;
    }
    return { framed: out, focusInReview: !!document.activeElement?.closest('${INPUT} .dispatch-pt-slot') }; })()`);
  const rf = qa.facts.reviewFrames;
  check("A2: one frame round the review, the box's own (none inside it, the focused review included)", rf.focusInReview && rf.framed.length === 1 && /\bchat-input-container\b/.test(rf.framed[0].cls), rf);
  const lines = await ui.eval(`(() => { const l = document.querySelector('${INPUT} .dispatch-pt-slot .pt-lines'); const cs = getComputedStyle(l); return { maxH: cs.maxHeight, overflow: cs.overflowY }; })()`);
  check("A2: the lines have a height limit and scroll inside the box", lines.maxH !== "none" && lines.overflow === "auto", lines);
  await shots("a2-stop");
  await ui.mark(CAMERA, { what: "Point and talk 按钮（摄像机）", where: "输入框工具行，发送键左边", how: "点它或按 ⌃⇧S 开录，录鼠标所在那块屏和声音" });
  await ui.mark({ css: `${INPUT} .pt-th[data-n="1"]` }, { what: "关键帧：指针停住的地方，红框、编号和这句开始的时间", where: "停下后输入框里第一行", how: "悬停出 × 删、笔改框，Tab 走到后 Delete、Enter 同效" });
  await ui.mark({ css: `${INPUT} .pt-vchip` }, { what: "视频片 Screen recording 和时长", where: "关键帧下面", how: "悬停看完整路径，点开用系统播放器看" });
  await ui.mark({ css: `${INPUT} .pt-row .pt-tx[data-i="1"]` }, { what: "逐句转写：编号、时间、原话", where: "视频片下面", how: "点一句改字，Enter 收下；Enter 或发送键发出" });

  // change a line: click it, type, Enter
  await ui.click({ css: `${INPUT} .pt-row .pt-tx[data-i="3"]` });
  await ui.press("End");
  await ui.type("谢谢");
  // Enter in a line keeps the change and does not send (the runner cannot tell that from the box, hence send: true)
  await ui.press("Enter", { send: true });
  await ui.sleep(400);
  check("Enter in a line did not send the message", !(await ui.exists({ css: ".session-view .interactive-request .dispatch-pt-bubble" })));
  const edited = await state();
  check("a line changed by typing in it", /谢谢$/.test(edited.review.lines[3].text), edited.review.lines[3]);
  // remove frame 2: its number goes from its line, the others keep theirs
  const tile = await ui.hover({ css: `${INPUT} .pt-th[data-n="2"]` });
  qa.facts.hoverProbe = await ui.eval(`(() => { const t = document.querySelector('${INPUT} .pt-th[data-n="2"]'); const r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hover: t.matches(':hover'), x: getComputedStyle(t.querySelector('.pt-x')).display, top: e ? (e.className && e.className.baseVal === undefined ? e.className : e.tagName) : null, inside: !!e && t.contains(e) }; })()`);
  note();
  if (qa.facts.hoverProbe.x === "none") {
    // the tile is a Tab stop: focused, its × and pen show the same way
    await ui.click({ css: `${INPUT} .pt-th[data-n="2"]` });
  }
  check("the frame's × shows on hover or focus", (await ui.eval(`getComputedStyle(document.querySelector('${INPUT} .pt-th[data-n="2"] .pt-x')).display`)) !== "none", { tile: tile && tile.box, probe: qa.facts.hoverProbe });
  await ui.click({ css: `${INPUT} .pt-th[data-n="2"] .pt-x` });
  const removed = await waitState(s => s.review && s.review.frames.length === 2, "frame 2 removed", 8000);
  check("frame 2 removed: its line has no number, 1 and 3 keep theirs", removed.review.lines.map(l => l.n ?? "-").join() === "1,-,3,-", removed.review.lines);
  await ui.click({ css: `${INPUT} .pt-vchip` });
  await ui.sleep(300);
  check("the video chip opens the video (a test instance only says so)", (await events()).some(e => /^open-video .*screen\.(mp4|webm)$/.test(e)), await events());
  await ui.screenshot("a2b-edited");

  // Enter sends
  await ui.click({ css: `${INPUT} .pt-chiprow` });
  await ui.press("Enter", { send: true });
  await ui.waitFor({ css: ".session-view .interactive-request .dispatch-pt-bubble" }, { timeoutMs: 20000 });
  await until(ui, async () => !(await ui.eval(RUNNING)), 240000, "the agent's answer", 2000);
  const sent = await ui.eval(`(() => { const reqs = [...document.querySelectorAll('.session-view .interactive-request')].filter(x => !x.closest('.monaco-tree-sticky-row') && x.querySelector('.dispatch-pt-bubble')); const r = reqs.at(-1); const b = r.querySelector('.dispatch-pt-bubble');
    return { frames: [...r.querySelectorAll('.dispatch-pt-sent')].map(e => e.dataset.ptN), chip: r.querySelector('.pt-vchip')?.innerText.replace(/\\s+/g, ' '), rows: [...b.querySelectorAll('.pt-row')].map(x => x.innerText.replace(/\\s+/g, ' ')),
      raw: !!r.querySelector('.rendered-markdown.dispatch-pt-raw'), radius: getComputedStyle(b).borderTopLeftRadius, boxIdle: !document.querySelector('${INPUT} .dispatch-pt-slot') }; })()`);
  qa.facts.sent = sent;
  check("A3: the two keyframes above the bubble, the video, four timed lines", sent.frames.join() === "1,3" && /Screen recording/.test(sent.chip || "") && sent.rows.length === 4 && sent.raw, sent);
  check("A3: the bubble's corners are 6, the box is back to normal", sent.radius === "6px" && sent.boxIdle, sent);
  qa.facts.answer = (await ui.eval(LAST)).slice(0, 400);
  await shots("a3-sent");
  await ui.mark({ css: `.session-view .interactive-request .dispatch-pt-sent[data-pt-n="1"]` }, { what: "发出去的关键帧", where: "消息气泡上方，按时间排", how: "点它在消息下面展开 Where to look" });
  await ui.mark({ css: `.session-view .interactive-request:not(.monaco-tree-sticky-row *) .dispatch-pt-bubble` }, { what: "气泡里一句一行，开头是时间", where: "视频片下面", how: "点编号看那一处，指着一句它的关键帧亮一圈" });

  // 5. Where to look
  await ui.click({ css: `.session-view .interactive-request .dispatch-pt-sent[data-pt-n="3"]` });
  await ui.waitFor({ css: ".dispatch-pt-where" }, { timeoutMs: 8000 });
  const where = await ui.eval(`(() => { const w = document.querySelector('.dispatch-pt-where'); return { head: w.querySelector('.pt-wvh').innerText.replace(/\\s+/g, ' '), rows: [...w.querySelectorAll('.pt-wvr')].map(r => ({ t: r.innerText.replace(/\\s+/g, ' '), on: r.classList.contains('on') })), box: !!w.querySelector('.pt-rb .pt-rk') }; })()`);
  check("A4: Picture 2 of 2 with its numbered box, the numbered lines under it", /Picture 2 of 2/.test(where.head) && where.box && where.rows.length === 2 && where.rows[1].on, where);
  await shots("a4-view");
  await ui.click({ css: ".dispatch-pt-where .pt-wvr" });
  await ui.sleep(400);
  const switched = await ui.eval(`document.querySelector('.dispatch-pt-where .pt-wvh').innerText`);
  check("a line switches the picture", /Picture 1 of 2/.test(switched), switched);
  await ui.click({ text: "Close", exact: true, within: ".dispatch-pt-where" });
  await ui.waitFor({ css: ".dispatch-pt-where" }, { gone: true, timeoutMs: 5000 });

  // 6. Dispatch on another display: the bar at the top of the recorded one
  await ui.eval(`${T}.configure(${JSON.stringify({ audio: voice, pointer: POINTER, elsewhere: true })})`);
  await ui.click(CAMERA);
  const barred = await waitState(s => s.recording && s.bar, "the bar", 20000);
  check("not on the recorded display: the bar shows", barred.bar, barred);
  await waitState(s => s.words.length > 4, "words in the bar", 30000);
  await ui.sleep(1500);
  let barShot = null;
  try {
    await ui.attach("other", 8000, "Point and talk");
    barShot = await ui.eval(`(() => { const b = document.querySelector('.bar'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), clock: document.getElementById('clock').innerText, words: document.getElementById('live').innerText, stop: document.getElementById('stop').innerText.trim(), radius: getComputedStyle(b).borderTopLeftRadius }; })()`);
    await ui.screenshot("a5-bar");
    check("the bar: 440×36, round 12, clock, words, Stop", barShot.w === 440 && barShot.h === 36 && barShot.radius === "12px" && barShot.stop === "Stop" && barShot.words.length > 0, barShot);
    await ui.click({ css: "#stop" });
  } finally {
    await ui.attach("agents", 15000);
  }
  if (!barShot) {
    await ui.click({ text: "Stop", exact: true, within: `${INPUT} .dispatch-pt-slot` });
  }
  const back = await waitState(s => !!s.review, "the review after the bar's Stop", 30000);
  check("the bar's Stop brings the review back to the box", !!back.review && !back.bar, back.events);
  await ui.click({ text: "Discard", exact: true, within: `${INPUT} .dispatch-pt-slot` });
  const gone = await waitState(s => !s.review && s.reviews === 0, "the review discarded", 8000);
  check("Discard throws the recording away and the box is empty again", !gone.review && !(await ui.exists({ css: `${INPUT} .dispatch-pt-slot` })), gone.events);
  qa.facts.events = gone.events;
  note();
  if (qa.failed.length) {
    throw new Error(`${qa.failed.length} checks failed: ${qa.failed.join(" | ")}`);
  }
}
