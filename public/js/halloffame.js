/**
 * The Hall of Fame — every finished tournament, newest first.
 *
 * Reads the archive endpoint rather than every tournament's full match log.
 * See server/db/repo/archive.js for why that one denormalisation exists.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, show } from "./ui.js";
import { archive } from "./api.js";

const e = D.escapeHtml;

load();

async function load() {
  let payload;
  try {
    payload = await archive.list();
  } catch (err) {
    show($("#loading"), false);
    show($("#empty"), true);
    $("#empty").querySelector("p").textContent = err.message;
    return;
  }

  show($("#loading"), false);

  if (!payload.entries.length) {
    show($("#empty"), true);
    return;
  }

  show($("#content"), true);
  paintTiles(payload);
  paintTitles(payload.summary.titles);
  paintTree(payload.entries);
  setHTML($("#friendlies"), "");
}

/**
 * The history as a tree: a year, then the tournaments inside it, each one
 * collapsed to a single line until you open it.
 *
 * Built on <details>/<summary>, which is why there is no open/close code here.
 * The browser handles the toggle, the keyboard, and the accessibility, and it
 * works with JavaScript half-loaded. Trying to do this with click handlers and
 * a chevron would be more code and worse.
 *
 * The most recent year starts open, because that is the one people came for.
 */
function paintTree(entries) {
  const years = new Map();
  for (const x of entries) {
    const year = (x.startsOn || "").slice(0, 4) || x.season || "Undated";
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(x);
  }

  const sorted = [...years.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));

  setHTML(
    $("#leagues"),
    `<div class="tree">${sorted
      .map(
        ([year, list], i) => `
        <details class="tree__year" ${i === 0 ? "open" : ""}>
          <summary class="tree__yearhead">
            <span class="tree__yearname">${e(year)}</span>
            <span class="faint">${list.length} ${list.length === 1 ? "tournament" : "tournaments"}</span>
          </summary>
          <div class="tree__body">
            ${list.map(entryNode).join("")}
          </div>
        </details>`,
      )
      .join("")}</div>`,
  );
}

/** One tournament: a summary line that opens into the full record. */
function entryNode(x) {
  const when = x.startsOn ? D.formatDate(x.startsOn) : x.season || "";
  const medals = Object.values(x.medals ?? {}).filter(Boolean);

  return `<details class="tree__item">
    <summary class="tree__head">
      <span class="tree__dot" aria-hidden="true"></span>
      <span class="tree__name">${e(x.name)}${x.season ? ` <span class="faint">${e(x.season)}</span>` : ""}</span>
      <span class="tree__champ">🏆 ${e(x.champion || "—")}</span>
      <span class="pill${x.format === "friendly" ? "" : " pill--gold"}">${x.format === "friendly" ? "Friendly" : "Tournament"}</span>
    </summary>

    <div class="tree__detail">
      <p class="faint">
        ${e(when)}
        ${x.summary?.matchesPlayed ? ` · ${x.summary.matchesPlayed} matches` : ""}
        ${x.summary?.goals ? ` · ${x.summary.goals} goals` : ""}
        ${x.summary?.teamCount ? ` · ${x.summary.teamCount} teams` : ""}
      </p>

      <div class="hof__result">
        <div class="hof__champ"><span class="pill pill--gold">Champions</span><b>${e(x.champion || "Not decided")}</b></div>
        ${x.runnerUp ? `<div class="hof__runner"><span class="pill">Runners-up</span><b>${e(x.runnerUp)}</b></div>` : ""}
        ${x.finalScore ? `<div class="faint">Final ${e(x.finalScore)}</div>` : ""}
        ${x.summary?.decidedBy === "table" ? `<div class="faint">Decided on the table</div>` : ""}
      </div>

      ${
        medals.length
          ? `<div class="awards">${medals
              .map(
                (m) => `<div class="award">
                  <div class="medal">${m.icon ?? "🏅"}</div>
                  <div class="label">${e(m.label)}</div>
                  <div class="winner">${e(m.playerName || m.teamName || "—")}</div>
                  ${m.playerName && m.teamName ? `<div class="sub">${e(m.teamName)}</div>` : ""}
                  ${m.value != null ? `<div class="sub">${e(m.value)}</div>` : ""}
                  ${m.picked ? `<div class="award-note">Chosen by the organisers</div>` : ""}
                </div>`,
              )
              .join("")}</div>`
          : `<p class="faint">No medals recorded.</p>`
      }

      <p><a class="btn btn--ghost btn--sm" href="/?t=${encodeURIComponent(x.slug)}">Open the full scoreboard →</a></p>
    </div>
  </details>`;
}

function paintTiles({ entries, summary }) {
  const goals = entries.reduce((n, x) => n + (x.summary?.goals ?? 0), 0);
  const tiles = [
    [summary.tournaments, "tournaments"],
    [summary.friendlies, "friendlies"],
    [goals, "goals scored"],
    [summary.titles[0]?.team ?? "—", "most titles"],
  ];
  setHTML(
    $("#tiles"),
    tiles.map(([value, label]) => `<div class="tile"><b>${e(value)}</b><span>${e(label)}</span></div>`).join(""),
  );
}

function paintTitles(titles) {
  const winners = titles.filter((t) => t.wins > 0);
  show($("#titlesCard"), winners.length > 1);
  setHTML(
    $("#titles"),
    `<table class="tbl">
       <thead><tr><th>#</th><th>Team</th><th class="num">Titles</th></tr></thead>
       <tbody>${winners
         .map((t, i) => `<tr><td>${i + 1}</td><td>${e(t.team)}</td><td class="num"><b>${t.wins}</b></td></tr>`)
         .join("")}</tbody>
     </table>`,
  );
}

