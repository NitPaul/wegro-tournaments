/**
 * Building a tournament from the roster: pick the people who are playing, and
 * they arrive in the auction pool with their photo, position and record already
 * attached — no retyping names, and no matching step afterwards.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, toast } from "../ui.js";
import { people, tournaments } from "../api.js";

const e = D.escapeHtml;

let getData = () => null;
let roster = null;

async function loadRoster(force = false) {
  if (!roster || force) ({ people: roster } = await people.list());
  return roster;
}

const initials = (name) => {
  const w = String(name ?? "").trim().split(" ").filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
};

export function wireRosterPicker(dataGetter) {
  getData = dataGetter;
  $("#openRosterPicker").addEventListener("click", open);
}

/** The captain dropdown on the "Add team" row: roster people not already in this tournament. */
export async function renderCaptainPicker() {
  const data = getData();
  const select = $("#newCaptainPerson");
  if (!data || !select) return;
  try {
    await loadRoster();
  } catch {
    return;
  }
  const taken = new Set(Object.values(data.players).map((p) => p.personId).filter(Boolean));
  const keep = select.value;
  setHTML(
    select,
    `<option value="">Captain from the roster…</option>` +
      roster
        .filter((p) => !taken.has(p.id))
        .map((p) => `<option value="${e(p.id)}"${p.id === keep ? " selected" : ""}>${e(p.name)}${p.pos ? ` · ${e(p.pos)}` : ""}</option>`)
        .join(""),
  );
}

async function open() {
  const data = getData();
  if (!data) return;
  const dialog = $("#rosterDialog");

  try {
    await loadRoster(true);
  } catch (err) {
    return toast(err.message, "err");
  }

  const taken = new Set(Object.values(data.players).map((p) => p.personId).filter(Boolean));
  const available = roster.filter((p) => p.active !== false && !taken.has(p.id));
  const chosen = new Set();
  let pos = "";

  setHTML(
    dialog,
    `<div class="dialog__panel picker-roster">
      <header class="dialog__head">
        <h2>Add players to ${e(data.name)}</h2>
        <button class="btn btn--ghost btn--sm" type="button" data-close>Close</button>
      </header>
      <div class="row">
        <input class="input" type="search" id="rpSearch" placeholder="Search" aria-label="Search the roster" />
        <div class="seg" id="rpPos" role="group" aria-label="Position">
          ${["", ...D.POSITIONS].map((p) => `<button type="button" data-pos="${p}" aria-pressed="${p === ""}">${p || "All"}</button>`).join("")}
        </div>
      </div>
      <div class="rp-grid" id="rpGrid"></div>
      <footer class="dialog__foot">
        <label class="field rp-kind">
          <span>Add as</span>
          <select class="input input--sm" id="rpKind">
            <option value="auction">Auction pool</option>
            <option value="guest">Guests</option>
          </select>
        </label>
        <button class="btn btn--primary" type="button" id="rpAdd" disabled>Add players</button>
      </footer>
    </div>`,
  );

  const paint = () => {
    const q = $("#rpSearch", dialog).value.trim().toLowerCase();
    const shown = available.filter((p) => (!pos || p.pos === pos) && (!q || p.name.toLowerCase().includes(q)));
    setHTML(
      $("#rpGrid", dialog),
      shown
        .map(
          (p) => `<button type="button" class="rp-card${chosen.has(p.id) ? " is-on" : ""}" data-id="${e(p.id)}" aria-pressed="${chosen.has(p.id)}"${p.pos ? "" : ' title="Set a position on the Players screen first"'}>
            ${p.photoUrl ? `<img src="${e(p.photoUrl)}" alt="" loading="lazy" />` : `<span class="rp-card__empty">${e(initials(p.name))}</span>`}
            <span class="rp-card__name">${e(p.name)}</span>
            <span class="rp-card__meta">${p.pos ? `<span class="pos-tag ${e(p.pos)}">${e(p.pos)}</span>` : `<span class="faint">No position</span>`}${p.rating !== null ? ` <b>${p.rating}</b>` : ""}</span>
          </button>`,
        )
        .join("") ||
        `<p class="faint">${available.length ? "Nobody matches that." : "Everyone on the roster is already in this tournament."}</p>`,
    );
    updateButton();
  };

  const updateButton = () => {
    const add = $("#rpAdd", dialog);
    add.disabled = chosen.size === 0;
    add.textContent = chosen.size ? `Add ${D.plural(chosen.size, "player")}` : "Add players";
  };

  // Assigned, not added: the <dialog> element is reused every time this opens,
  // and a listener added per opening would fire once per past opening — a
  // single tap would select and unselect, and "Add" would send twice.
  dialog.onclick = async (ev) => {
    if (ev.target.closest("[data-close]")) return dialog.close();

    // Toggle in place rather than redrawing the grid, so a long list keeps its
    // scroll position while people are ticked off one by one.
    const card = ev.target.closest(".rp-card");
    if (card) {
      const on = !chosen.has(card.dataset.id);
      on ? chosen.add(card.dataset.id) : chosen.delete(card.dataset.id);
      card.classList.toggle("is-on", on);
      card.setAttribute("aria-pressed", String(on));
      return updateButton();
    }

    const posBtn = ev.target.closest("#rpPos button");
    if (posBtn) {
      pos = posBtn.dataset.pos;
      for (const b of dialog.querySelectorAll("#rpPos button")) b.setAttribute("aria-pressed", String(b === posBtn));
      return paint();
    }

    if (ev.target.closest("#rpAdd")) {
      const add = $("#rpAdd", dialog);
      add.disabled = true;
      try {
        const { added, skipped } = await tournaments.addFromRoster(data.id, {
          personIds: [...chosen],
          kind: $("#rpKind", dialog).value,
        });
        toast(`Added ${D.plural(added.length, "player")}.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}` : ""}`, skipped.length ? "err" : "ok", skipped.length ? 8000 : 3200);
        dialog.close();
      } catch (err) {
        toast(err.message, "err");
        add.disabled = false;
      }
    }
  };
  $("#rpSearch", dialog).addEventListener("input", paint);

  paint();
  dialog.showModal();
}
