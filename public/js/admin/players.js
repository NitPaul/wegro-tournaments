/**
 * The Players screen — the roster every tournament draws from.
 *
 * Three jobs, one per card:
 *
 *  1. The roster: every person, with photo and rating. The super admin edits
 *     and rates; a tournament admin can add a newcomer and give a photo to
 *     their own players.
 *  2. Add from photos: pick a folder's worth of headshots and each becomes a
 *     person, named from its file name, shrunk before upload.
 *  3. Match players: for the open tournament, say which roster person each
 *     player is. The site suggests; a person decides.
 *
 * Every rule is enforced by the server. What this file hides is only there to
 * keep the screen from offering what will be refused.
 */

import * as D from "/shared/domain/index.js";
import { nameFromFileName, suggestPeople } from "/shared/domain/names.js";
import { $, setHTML, toast } from "../ui.js";
import { people } from "../api.js";
import { cropEditor, defaultCrop, drawCrop, encodeCrop, loadImage } from "./photo.js";

const e = D.escapeHtml;

let roster = [];
let ctx = () => ({ me: null, data: null, perms: {} });

/** "MH" for Mahmud Hasan — the placeholder where there is no photo yet. */
export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

export function avatar(person, className = "avatar") {
  return person?.photoUrl
    ? `<img class="${className}" src="${e(person.photoUrl)}" alt="" loading="lazy" width="96" height="96" />`
    : `<span class="${className} ${className}--empty" aria-hidden="true">${e(initials(person?.name))}</span>`;
}

const posOptions = (selected, blank = "Position not set") =>
  `<option value="">${e(blank)}</option>` +
  D.POSITIONS.map((p) => `<option value="${p}"${p === selected ? " selected" : ""}>${p}</option>`).join("");

/* ------------------------------------------------------------------- wire */

/** @param {() => {me: object, data: object|null, perms: object}} getContext */
export function wirePlayers(getContext) {
  ctx = getContext;

  $("#peopleSearch").addEventListener("input", paintRoster);
  $("#peopleFilter").addEventListener("change", paintRoster);

  $("#panel-players").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    if (btn.id === "addPerson") return openEditor(null);
    if (btn.id === "bulkAdd") return $("#bulkFiles").click();
    if (btn.dataset.person) return openEditor(roster.find((p) => p.id === btn.dataset.person));

    const { data } = ctx();
    if (!data) return;

    try {
      if (btn.dataset.linkPlayer) {
        await people.link(data.id, btn.dataset.linkPlayer, btn.dataset.personId || null);
        toast(btn.dataset.personId ? "Matched." : "Unmatched.");
        await renderPlayers(); // their record and rating have just changed
      } else if (btn.dataset.newFromPlayer) {
        const player = data.players[btn.dataset.newFromPlayer];
        const { person } = await people.create({ name: player.name, pos: player.pos });
        await people.link(data.id, player.id, person.id);
        toast(`${player.name} added to the roster and matched.`);
        await renderPlayers();
      }
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#linkList").addEventListener("change", async (ev) => {
    const select = ev.target.closest("select[data-link-choose]");
    if (!select || !select.value) return;
    const { data } = ctx();
    try {
      await people.link(data.id, select.dataset.linkChoose, select.value);
      toast("Matched.");
      await renderPlayers();
    } catch (err) {
      toast(err.message, "err");
      select.value = "";
    }
  });

  $("#bulkFiles").addEventListener("change", (ev) => {
    const files = [...(ev.target.files ?? [])];
    ev.target.value = "";
    if (files.length) openBulk(files);
  });
}

/* ----------------------------------------------------------------- render */

export async function renderPlayers() {
  try {
    ({ people: roster } = await people.list());
  } catch (err) {
    setHTML($("#peopleGrid"), `<p class="faint err">${e(err.message)}</p>`);
    return;
  }
  const { me, perms, data } = ctx();
  $("#bulkAdd").hidden = !me?.isSuper;
  $("#addPerson").hidden = !(me?.isSuper || (perms.role === "admin" && !perms.readOnly));
  paintRoster();
  paintLinks(data);
}

function paintRoster() {
  const q = $("#peopleSearch").value.trim().toLowerCase();
  const filter = $("#peopleFilter").value;
  const shown = roster.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (filter === "nophoto") return !p.photoUrl;
    if (filter === "unrated") return p.rating === null;
    if (filter === "new") return p.tournamentCount === 0;
    return true;
  });

  $("#peopleCount").textContent = `${roster.length} on the roster · ${roster.filter((p) => !p.photoUrl).length} without a photo`;

  setHTML(
    $("#peopleGrid"),
    shown
      .map(
        (p) => `<button class="pcard" type="button" data-person="${e(p.id)}">
          ${avatar(p, "pcard__photo")}
          <span class="pcard__body">
            <span class="pcard__name">${e(p.name)}</span>
            <span class="pcard__meta">
              ${p.pos ? `<span class="pos-tag ${e(p.pos)}">${e(p.pos)}</span>` : ""}
              <span class="faint">${p.tournamentCount ? D.plural(p.tournamentCount, "tournament") : "New"}</span>
            </span>
          </span>
          <span class="pcard__rating rating--${e(p.headline.band)}" title="${p.rating !== null ? "Admin rating" : p.statsRating !== null ? "From stats" : "Not rated"}">
            ${p.rating ?? "—"}
            <small>${p.statsRating !== null ? `stats ${p.statsRating}` : "no stats"}</small>
          </span>
        </button>`,
      )
      .join("") || `<p class="faint">${roster.length ? "Nobody matches that." : "The roster is empty. Add players, or add a batch from photos."}</p>`,
  );
}

function paintLinks(data) {
  const { me, perms } = ctx();
  const card = $("#linkCard");
  const canLink = Boolean(data) && (me?.isSuper || (perms.role === "admin" && !perms.readOnly));
  card.hidden = !canLink;
  if (!canLink) return;

  $("#linkTournament").textContent = `${data.name}${data.season ? ` ${data.season}` : ""}`;
  const players = D.playersList(data);
  const unlinked = players.filter((p) => !p.personId);
  const linked = players.filter((p) => p.personId);
  const byId = new Map(roster.map((p) => [p.id, p]));

  const options = roster.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join("");

  setHTML(
    $("#linkList"),
    (unlinked.length
      ? unlinked
          .map((pl) => {
            const suggestions = suggestPeople(pl.name, roster);
            return `<div class="link-row">
              <span class="link-row__who">
                <span class="pos-tag ${e(pl.pos)}">${e(pl.pos)}</span>
                <b>${e(pl.name)}</b>
                <span class="faint">${e(D.teamById(data, pl.teamId)?.name ?? (pl.kind === "auction" ? "Unsold" : ""))}</span>
              </span>
              <span class="link-row__choices">
                ${suggestions
                  .map(
                    (s) => `<button class="btn btn--sm btn--ghost link-suggest" type="button" data-link-player="${e(pl.id)}" data-person-id="${e(s.person.id)}">
                      ${avatar(s.person, "avatar avatar--xs")} ${e(s.person.name)}
                    </button>`,
                  )
                  .join("")}
                <select class="input input--sm" data-link-choose="${e(pl.id)}" aria-label="Choose who ${e(pl.name)} is">
                  <option value="">${suggestions.length ? "Someone else…" : "Choose…"}</option>${options}
                </select>
                <button class="btn btn--sm btn--ghost" type="button" data-new-from-player="${e(pl.id)}">New on roster</button>
              </span>
            </div>`;
          })
          .join("")
      : `<p class="faint">Every player in this tournament is matched to the roster.</p>`) +
      (linked.length
        ? `<details class="link-done"><summary>${D.plural(linked.length, "player")} already matched</summary>
            ${linked
              .map((pl) => {
                const person = byId.get(pl.personId);
                return `<div class="link-row">
                  <span class="link-row__who"><span class="pos-tag ${e(pl.pos)}">${e(pl.pos)}</span> <b>${e(pl.name)}</b></span>
                  <span class="link-row__choices">
                    <span class="link-chip">${avatar(person, "avatar avatar--xs")} ${e(person?.name ?? "Unknown")}</span>
                    <button class="btn btn--sm btn--ghost" type="button" data-link-player="${e(pl.id)}" data-person-id="">Unmatch</button>
                  </span>
                </div>`;
              })
              .join("")}
          </details>`
        : ""),
  );
}

/** The open tournament changed (a player was added, matched, sold): redraw the matching list. */
export function tournamentChanged() {
  if (roster.length) paintLinks(ctx().data);
}

/* ----------------------------------------------------------------- editor */

function openEditor(person) {
  const { me } = ctx();
  const isSuper = Boolean(me?.isSuper);
  const creating = !person;
  const dialog = $("#personDialog");

  let editor = null;
  let bitmap = null;

  setHTML(
    dialog,
    `<form method="dialog" class="dialog__panel person-editor">
      <header class="dialog__head">
        <h2>${creating ? "Add a player" : e(person.name)}</h2>
        <button class="btn btn--ghost btn--sm" value="cancel" type="submit" aria-label="Close">Close</button>
      </header>

      <div class="person-editor__photo">
        <div id="photoStage">${avatar(person, "avatar avatar--xl")}</div>
        <div class="card-buttons">
          <label class="btn btn--sm btn--ghost file-btn">
            ${person?.photoUrl ? "Change photo" : "Add photo"}
            <input type="file" accept="image/*" id="photoFile" />
          </label>
          ${person?.photoUrl ? `<button class="btn btn--sm btn--danger" type="button" id="photoRemove">Remove photo</button>` : ""}
        </div>
      </div>

      <div class="form-grid">
        <label class="field"><span>Name</span>
          <input class="input" id="pName" value="${e(person?.name ?? "")}" maxlength="60" ${!creating && !isSuper ? "disabled" : ""} required />
        </label>
        <label class="field"><span>Usual position</span>
          <select class="input" id="pPos" ${!creating && !isSuper ? "disabled" : ""}>${posOptions(person?.pos)}</select>
        </label>
      </div>

      ${
        isSuper
          ? `<fieldset class="rating-edit">
              <legend>Rating</legend>
              <div class="rating-edit__row">
                <input type="range" min="1" max="99" id="pRatingRange" value="${person?.rating ?? 60}" ${person?.rating === null || creating ? "disabled" : ""} />
                <output class="rating-edit__value" id="pRatingOut">${person?.rating ?? "—"}</output>
              </div>
              <label class="check"><input type="checkbox" id="pUnrated" ${person?.rating === null || creating ? "checked" : ""} /> Not rated yet</label>
              <p class="faint">${person?.statsRating != null ? `From stats: <b>${person.statsRating}</b> over ${D.plural(person.totals.matches, "match", "matches")}.` : "Not enough matches for a rating from stats."}</p>
              <label class="field"><span>Note (only you see this)</span>
                <input class="input" id="pNote" maxlength="280" value="${e(person?.ratingNote ?? "")}" placeholder="Why this rating" />
              </label>
            </fieldset>`
          : `<p class="faint">${creating ? "The super admin sets ratings." : "Only the super admin can rename or rate players. You can change the photo of players in your own tournament."}</p>`
      }

      ${
        !creating && person.tournamentCount
          ? `<p class="faint person-editor__record">${D.plural(person.totals.matches, "match", "matches")} · ${D.plural(person.totals.goals, "goal")} · ${D.plural(person.totals.saves, "save")}${person.titles ? ` · ${D.plural(person.titles, "title")}` : ""}${person.medals.length ? ` · ${person.medals.map((m) => `${m.icon} ${e(m.label)} ${e(m.season)}`).join(", ")}` : ""}</p>`
          : ""
      }

      <footer class="dialog__foot">
        ${!creating && isSuper ? `<button class="btn btn--danger" type="button" id="pDelete">Delete from roster</button>` : "<span></span>"}
        <button class="btn btn--primary" type="button" id="pSave">${creating ? "Add player" : "Save"}</button>
      </footer>
    </form>`,
  );

  const close = () => {
    editor?.destroy();
    bitmap?.close?.();
    dialog.close();
  };

  if (isSuper) {
    const range = $("#pRatingRange", dialog);
    const out = $("#pRatingOut", dialog);
    const unrated = $("#pUnrated", dialog);
    range.addEventListener("input", () => (out.textContent = range.value));
    unrated.addEventListener("change", () => {
      range.disabled = unrated.checked;
      out.textContent = unrated.checked ? "—" : range.value;
    });
  }

  $("#photoFile", dialog).addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      bitmap?.close?.();
      bitmap = await loadImage(file);
      editor?.destroy();
      editor = cropEditor($("#photoStage", dialog), bitmap);
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#photoRemove", dialog)?.addEventListener("click", async () => {
    if (!confirm(`Remove ${person.name}'s photo?`)) return;
    try {
      await people.removePhoto(person.id);
      toast("Photo removed.");
      close();
      await renderPlayers();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#pDelete", dialog)?.addEventListener("click", async () => {
    if (!confirm(`Delete ${person.name} from the roster? Their tournament records stay, unmatched.`)) return;
    try {
      await people.remove(person.id);
      toast("Deleted.");
      close();
      await renderPlayers();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#pSave", dialog).addEventListener("click", async () => {
    const button = $("#pSave", dialog);
    button.disabled = true;
    try {
      let target = person;
      const name = $("#pName", dialog).value.trim();
      const pos = $("#pPos", dialog).value || null;
      const rating = isSuper && !$("#pUnrated", dialog).checked ? Number($("#pRatingRange", dialog).value) : null;
      const ratingNote = isSuper ? $("#pNote", dialog).value : undefined;

      if (creating) {
        if (!name) throw new Error("Enter the player's name.");
        ({ person: target } = await people.create({ name, pos, rating, ratingNote }));
      } else if (isSuper) {
        await people.update(person.id, { name, pos, rating, ratingNote });
      }

      if (editor && bitmap) {
        const blob = await encodeCrop(bitmap, editor.crop());
        await people.uploadPhoto(target.id, blob);
      }

      toast(creating ? `${name} added.` : "Saved.");
      close();
      await renderPlayers();
    } catch (err) {
      toast(err.message, "err");
      button.disabled = false;
    }
  });

  dialog.showModal();
}

/* ------------------------------------------------------------------- bulk */

/**
 * Add many people from their photos at once. Each file becomes a row to check —
 * the name guessed from the file name, a position to choose — and nothing is
 * saved until "Add". Photos already on the roster by the same name are marked,
 * so running it twice does not create twins.
 */
async function openBulk(files) {
  const dialog = $("#bulkDialog");
  const existing = new Set(roster.map((p) => p.name.toLowerCase()));

  setHTML(
    dialog,
    `<div class="dialog__panel bulk">
      <header class="dialog__head">
        <h2>Add ${D.plural(files.length, "player")} from photos</h2>
        <button class="btn btn--ghost btn--sm" type="button" data-close>Close</button>
      </header>
      <p class="faint">Check each name — it comes from the file name. Each photo is cropped to the face and shrunk before it is sent.</p>
      <div class="bulk__list" id="bulkList"><p class="faint">Reading photos…</p></div>
      <footer class="dialog__foot">
        <span class="faint" id="bulkStatus"></span>
        <button class="btn btn--primary" type="button" id="bulkGo" disabled>Add players</button>
      </footer>
    </div>`,
  );
  dialog.showModal();

  const rows = [];
  for (const file of files) {
    try {
      const bitmap = await loadImage(file);
      const name = nameFromFileName(file.name);
      rows.push({ file, bitmap, name, crop: defaultCrop(bitmap.width, bitmap.height), skip: existing.has(name.toLowerCase()) });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }

  setHTML(
    $("#bulkList", dialog),
    rows
      .map(
        (r, i) => `<div class="bulk__row${r.error ? " is-error" : ""}" data-row="${i}">
          <canvas class="avatar avatar--sm" width="64" height="64"></canvas>
          ${
            r.error
              ? `<span class="faint err">${e(r.error)}</span>`
              : `<input class="input" data-field="name" value="${e(r.name)}" maxlength="60" aria-label="Name" />
                 <select class="input input--sm" data-field="pos" aria-label="Position">${posOptions(null, "Position")}</select>
                 <label class="check"><input type="checkbox" data-field="skip" ${r.skip ? "checked" : ""} /> ${r.skip ? "Already on roster — skip" : "Skip"}</label>`
          }
        </div>`,
      )
      .join(""),
  );

  rows.forEach((r, i) => {
    if (r.bitmap) drawCrop($(`[data-row="${i}"] canvas`, dialog), r.bitmap, r.crop, 64);
  });

  const go = $("#bulkGo", dialog);
  go.disabled = !rows.some((r) => !r.error);

  const closeBulk = () => {
    for (const r of rows) r.bitmap?.close?.();
    dialog.close();
  };
  $("[data-close]", dialog).addEventListener("click", closeBulk);

  go.addEventListener("click", async () => {
    go.disabled = true;
    const status = $("#bulkStatus", dialog);
    let added = 0;
    const failed = [];

    const todo = rows
      .map((r, i) => ({ r, el: $(`[data-row="${i}"]`, dialog) }))
      .filter(({ r, el }) => !r.error && !$('[data-field="skip"]', el).checked);

    for (const [n, { r, el }] of todo.entries()) {
      const name = $('[data-field="name"]', el).value.trim();
      status.textContent = `Adding ${n + 1} of ${todo.length}: ${name}`;
      try {
        if (!name) throw new Error("no name");
        const { person } = await people.create({ name, pos: $('[data-field="pos"]', el).value || null });
        await people.uploadPhoto(person.id, await encodeCrop(r.bitmap, r.crop));
        el.classList.add("is-done");
        added++;
      } catch (err) {
        el.classList.add("is-error");
        failed.push(`${name || r.file.name}: ${err.message}`);
      }
    }

    status.textContent = failed.length ? `Added ${added}. ${failed.length} failed — see the red rows.` : `Added ${added}.`;
    if (failed.length) console.warn("[bulk add]", failed);
    toast(`Added ${D.plural(added, "player")}.`, failed.length ? "err" : "ok");
    await renderPlayers();
    if (!failed.length) setTimeout(closeBulk, 900);
  });
}
