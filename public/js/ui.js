/* ==========================================================================
   Tiny DOM helpers shared by the public site, admin console and auction.
   ========================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setHTML(el, html) {
  if (el) el.innerHTML = html;
}

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

/** Accessible tab strip: click + arrow keys, panels toggled by aria-controls. */
export function wireTabs(tabsEl, { onChange } = {}) {
  if (!tabsEl) return () => {};
  const tabs = $$('[role="tab"]', tabsEl);

  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    onChange?.(tab.id.replace(/^tab-/, ""));
  };

  tabsEl.addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab);
  });

  tabsEl.addEventListener("keydown", (e) => {
    // Navigate only the visible tabs. A tab can be hidden for the signed-in
    // account (Danger, for a scoreboard-only admin), and arrowing onto it would
    // open the very panel we took away.
    const usable = tabs.filter((t) => !t.hidden);
    const i = usable.indexOf(document.activeElement);
    if (i < 0) return;
    const next =
      e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? usable.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = usable[(next + usable.length) % usable.length];
    t.focus();
    select(t);
  });

  const initial = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
  if (initial) select(initial);

  return (name) => {
    const t = tabs.find((x) => x.id === `tab-${name}`);
    if (t && !t.hidden) select(t);
  };
}

/** Bottom-centre toast. `kind` of "err" turns it red. */
let toastEl = null;
let toastTimer = null;
export function toast(message, kind = "ok", ms = 3200) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.className = `toast show${kind === "err" ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = "toast"), kind === "err" ? ms + 1800 : ms);
}

/** Confirm dialog that requires typing an exact phrase. Returns boolean. */
export function confirmPhrase(message, phrase) {
  const typed = window.prompt(`${message}\n\nType ${phrase} to confirm:`);
  return typed !== null && typed.trim().toUpperCase() === phrase.toUpperCase();
}

/** Remember which tab was open across reloads. */
export function rememberTab(key, selectFn) {
  const saved = sessionStorage.getItem(key);
  if (saved) selectFn(saved);
  return (name) => sessionStorage.setItem(key, name);
}
