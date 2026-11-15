// The composer's chips (Agent, model, permission mode) are native <select>s. In Dispatch IDE a click
// on one opens this menu right above the chip instead of the macOS menu: the select's own options,
// optgroups as a separator line with a small title, a check on the current one, ↑ ↓ ↵ Esc, a click
// outside closes it. The choice goes back through the select (value + change), so React sees a normal pick.
import { selectItems, type PickItem } from "./bridge";

let open: { el: HTMLElement; sel: HTMLSelectElement; close: () => void } | null = null;

export function closeMenu() { open?.close(); }

function choose(sel: HTMLSelectElement, value: string) {
  if (value === sel.value) return;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(sel, value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

export function openMenu(sel: HTMLSelectElement) {
  const again = open?.sel === sel;
  closeMenu();
  if (again || sel.disabled) return;  // a second click on the same chip closes it
  const items: PickItem[] = selectItems(sel).filter((i) => i.kind === "separator" || !i.disabled);
  const el = document.createElement("div");
  el.className = "ic-menu";
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", sel.getAttribute("aria-label") || "");
  const rows: { row: HTMLElement; value: string }[] = [];
  for (const it of items) {
    if (it.kind === "separator") {
      const s = document.createElement("div");
      s.className = "ic-menu-sep";
      s.textContent = it.label;
      el.appendChild(s);
      continue;
    }
    const row = document.createElement("div");
    row.className = `ic-menu-row${it.picked ? " cur" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(it.picked));
    const check = document.createElement("span");
    check.className = "ic-menu-check";
    const label = document.createElement("span");
    label.className = "ic-menu-l";
    label.textContent = it.label;
    row.append(check, label);
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => { closeMenu(); choose(sel, it.value); sel.focus(); });
    row.addEventListener("mousemove", () => setActive(rows.findIndex((r) => r.row === row)));
    el.appendChild(row);
    rows.push({ row, value: it.value });
  }
  let active = Math.max(0, rows.findIndex((r) => r.row.classList.contains("cur")));
  function setActive(i: number) {
    if (i < 0 || i >= rows.length) return;
    rows[active]?.row.classList.remove("on");
    active = i;
    rows[active].row.classList.add("on");
    rows[active].row.scrollIntoView({ block: "nearest" });
  }
  document.body.appendChild(el);
  // above the chip (the composer sits at the bottom), left edges aligned, kept inside the column
  const anchor = (sel.closest(".dd") as HTMLElement | null) ?? sel;
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, a.top - h - 4)}px`;
  setActive(active);
  anchor.classList.add("open");

  const key = (e: KeyboardEvent) => {
    if (e.key === "Tab") { closeMenu(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); sel.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setActive(Math.min(rows.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); const v = rows[active]?.value; closeMenu(); if (v !== undefined) choose(sel, v); sel.focus(); }
  };
  const outside = (e: MouseEvent) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu(); };
  window.addEventListener("keydown", key, true);
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  open = { el, sel, close: () => {
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("resize", closeMenu);
    anchor.classList.remove("open");
    // closing fades out too (100 ms, DESIGN.md popover); the menu is already gone for input
    el.style.pointerEvents = "none";
    el.classList.add("out");
    window.setTimeout(() => el.remove(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 100);
    open = null;
  } };
}
