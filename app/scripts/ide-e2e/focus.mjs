// Where a scenario may type. `describeFocus` runs in the page and describes document.activeElement;
// `focusVerdict` decides from that description alone (a pure function: vitest and test_ide_e2e.py run
// it). The rule: text goes only into an input box: a plain <input>/<textarea>, a contenteditable, or a
// Monaco editor that is a chat / quick pick / search input. Never into a text editor holding a file
// (a script once typed into an open file and it was saved). Monaco's focused element is a textarea in
// older builds and a div.native-edit-context (EditContext) in newer ones: the ancestors decide.

/** Ancestor classes that make a Monaco editor an input box, not a file. */
export const INPUT_EDITOR_CLASSES = [
  "interactive-input-part", // chat input of the editor window's chat
  "chat-input-container",
  "interactive-input-editor",
  "sessions-chat-editor", // chat input of the Agents window (new session page and sessions)
  "new-chat-input-area",
  "chat-input-stack",
  "quick-input-widget", // ⌘P, command palette, pickers
  "scm-editor", // commit message box
  "suggest-input-container", // Settings / Extensions search
  "find-widget", // find in a file: types a search, not into the file
  "agent-feedback-input-widget", // a note on a diff's selected lines (Add Feedback): types the note, not into the file
  "dset-soul-editor", // Settings › Soul: the text is saved only by its Save button, never straight into a file
];

/** Ancestor classes that mean "an editor holding a document". */
export const DOCUMENT_EDITOR_CLASSES = ["editor-instance", "editor-group-container", "monaco-diff-editor", "notebook-editor"];

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "number", "tel", "password"]);

/**
 * @param {{tag?: string, type?: string, readOnly?: boolean, disabled?: boolean, contentEditable?: boolean,
 *          classes?: string[], ancestors?: string[]}|null} d  classes: the element's own; ancestors: every
 *          class of every ancestor, nearest first.
 * @returns {{ok: boolean, kind: string, reason: string}}
 */
export function focusVerdict(d) {
  if (!d || !d.tag || d.tag === "BODY" || d.tag === "HTML") return { ok: false, kind: "none", reason: "nothing has the keyboard focus" };
  if (d.frame) return { ok: false, kind: "frame", reason: "the focus is in a frame this page cannot see into" };
  const tag = String(d.tag).toUpperCase();
  const own = d.classes || [];
  const anc = d.ancestors || [];
  const has = (list) => list.find((c) => own.includes(c) || anc.includes(c));
  const monaco = own.includes("inputarea") || anc.includes("monaco-editor");
  if (d.disabled || d.readOnly) return { ok: false, kind: "readonly", reason: `the focused ${tag.toLowerCase()} is read-only or disabled` };
  if (monaco) {
    const box = has(INPUT_EDITOR_CLASSES);
    if (box) return { ok: true, kind: "input-editor", reason: `Monaco input box (${box})` };
    const doc = has(DOCUMENT_EDITOR_CLASSES);
    return { ok: false, kind: "document", reason: `focus is in a text editor${doc ? ` (${doc})` : ""}: typing would change a file` };
  }
  if (tag === "INPUT") {
    const type = String(d.type || "").toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) return { ok: true, kind: "input", reason: `<input type=${type || "text"}>` };
    return { ok: false, kind: "input-other", reason: `<input type=${type}> is not a text box` };
  }
  if (tag === "TEXTAREA") return { ok: true, kind: "textarea", reason: "<textarea>" };
  if (d.contentEditable) {
    if (has(DOCUMENT_EDITOR_CLASSES)) return { ok: false, kind: "document", reason: "contenteditable inside an editor" };
    return { ok: true, kind: "contenteditable", reason: "contenteditable" };
  }
  return { ok: false, kind: "not-input", reason: `focus is on a <${tag.toLowerCase()}>, not an input box` };
}

/** Whether Enter here would send a message to an agent: a chat input (a session, the new session page) or Customizations › Overview's "Customize Your Agent" box. */
export function sendsChat(d) {
  if (!d) return false;
  const all = [...(d.classes || []), ...(d.ancestors || [])];
  return ["interactive-input-part", "chat-input-container", "interactive-input-editor", "sessions-chat-editor", "new-chat-input-area", "chat-input-stack", "welcome-prompts-primary"].some((c) => all.includes(c));
}

/** Runs in the page (injected with toString()): the description focusVerdict reads. */
export function describeFocus() {
  let a = document.activeElement;
  // a focused iframe: its own document's focus is what receives keys. A webview is another process:
  // say so, and the runner asks inside it.
  while (a && a.tagName === "IFRAME") {
    let inner = null;
    try {
      inner = a.contentDocument && a.contentDocument.activeElement;
    } catch {
      inner = null;
    }
    if (!inner) return { tag: "IFRAME", frame: true, src: a.getAttribute("src") || "", classes: [...a.classList], ancestors: [] };
    a = inner;
  }
  if (!a) return null;
  const ancestors = [];
  for (let e = a.parentElement; e; e = e.parentElement) ancestors.push(...e.classList);
  return {
    tag: a.tagName,
    type: a.getAttribute("type") || "",
    readOnly: !!a.readOnly || a.getAttribute("aria-readonly") === "true",
    disabled: !!a.disabled,
    contentEditable: !!a.isContentEditable,
    classes: [...a.classList],
    ancestors,
    label: a.getAttribute("aria-label") || a.getAttribute("placeholder") || "",
  };
}
