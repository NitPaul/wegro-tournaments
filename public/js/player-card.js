/**
 * The player card — used on the landing page and the player list, so a player
 * looks the same wherever they appear.
 *
 * The big number is the admin's rating when there is one; the rating worked out
 * from stats sits underneath, labelled, so nobody mistakes one for the other.
 */

import * as D from "/shared/domain/index.js";

const e = D.escapeHtml;

export function initials(name) {
  const words = String(name ?? "").trim().split(" ").filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

export function photo(person, className = "pc__photo") {
  return person?.photoUrl
    ? `<img class="${className}" src="${e(person.photoUrl)}" alt="" loading="lazy" decoding="async" width="320" height="320" />`
    : `<span class="${className} ${className}--empty" aria-hidden="true">${e(initials(person?.name))}</span>`;
}

const POS_NAME = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" };

/** The one line of numbers that matters for each position. */
export function statLine(person) {
  const t = person.totals ?? {};
  if (!t.matches && !person.tournamentCount) return "Yet to play";
  const parts = [D.plural(t.matches ?? 0, "match", "matches")];
  if (person.pos === "GK") {
    parts.push(D.plural(t.saves ?? 0, "save"), `${t.cleanSheets ?? 0} clean`);
  } else if (person.pos === "DEF") {
    parts.push(D.plural(t.clearances ?? 0, "clearance"), D.plural(t.goals ?? 0, "goal"));
  } else {
    parts.push(D.plural(t.goals ?? 0, "goal"), D.plural(t.assists ?? 0, "assist"));
  }
  return parts.join(" · ");
}

export function playerCard(person, { index = 0 } = {}) {
  const h = person.headline ?? {};
  const rated = h.value !== null && h.value !== undefined;
  return `<a class="pc pc--${e(h.band ?? "none")}" href="/players/${encodeURIComponent(person.id)}" style="--i:${index}">
    <span class="pc__media">
      ${photo(person)}
      <span class="pc__rating" title="${h.source === "admin" ? "Rating" : h.source === "stats" ? "Rating from stats" : "Not rated yet"}">
        <b>${rated ? h.value : "–"}</b>
        <small>${h.source === "stats" ? "stats" : person.pos ? e(person.pos) : "&nbsp;"}</small>
      </span>
      ${person.titles ? `<span class="pc__titles" title="${D.plural(person.titles, "title")}">🏆${person.titles > 1 ? ` ×${person.titles}` : ""}</span>` : ""}
    </span>
    <span class="pc__body">
      <span class="pc__name">${e(person.name)}</span>
      <span class="pc__pos">${e(POS_NAME[person.pos] ?? "Player")}${person.rating !== null && person.statsRating !== null ? ` · stats ${person.statsRating}` : ""}</span>
      <span class="pc__stats">${e(statLine(person))}</span>
    </span>
  </a>`;
}

/** Strongest first: rated players by rating, then by what they have done. */
export function byStrength(a, b) {
  const av = a.headline?.value ?? -1;
  const bv = b.headline?.value ?? -1;
  return (
    bv - av ||
    (b.titles ?? 0) - (a.titles ?? 0) ||
    (b.totals?.points ?? 0) - (a.totals?.points ?? 0) ||
    a.name.localeCompare(b.name)
  );
}
