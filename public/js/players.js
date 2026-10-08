/**
 * The public player list, at /players, and one player, at /players/<id>.
 *
 * One page for both: the list is the index, a card opens the player, and the
 * browser's back button returns to the list with the filters as they were. The
 * filters live in the address (?pos=GK&sort=goals&q=mun) so a filtered list can
 * be shared.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, show, wireSiteHeader } from "./ui.js";
import { people } from "./api.js";
import { byStrength, playerCard, playsGame } from "./player-card.js";

const e = D.escapeHtml;

let roster = null;

wireSiteHeader();
wireList();
route();
window.addEventListener("popstate", route);

// A goal logged on match day moves a career; keep the page current.
if ("EventSource" in window) {
  let timer = null;
  new EventSource("/api/stream").addEventListener("changed", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      roster = null;
      route();
    }, 1500);
  });
}

/** Which view the address asks for. */
async function route() {
  const id = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  show($("#problem"), false);
  if (id) return showProfile(id);
  return showList();
}

function problem(title, text) {
  show($("#loading"), false);
  show($("#listView"), false);
  show($("#profileView"), false);
  $("#problemTitle").textContent = title;
  $("#problemText").textContent = text;
  show($("#problem"), true);
}

/* ------------------------------------------------------------------- list */

const SORTS = {
  rating: byStrength,
  goals: (a, b) => b.totals.goals - a.totals.goals || byStrength(a, b),
  assists: (a, b) => b.totals.assists - a.totals.assists || byStrength(a, b),
  saves: (a, b) => b.totals.saves - a.totals.saves || byStrength(a, b),
  matches: (a, b) => b.totals.matches - a.totals.matches || byStrength(a, b),
  name: (a, b) => a.name.localeCompare(b.name),
};

function readFilters() {
  const q = new URLSearchParams(location.search);
  return { pos: q.get("pos") ?? "", sort: SORTS[q.get("sort")] ? q.get("sort") : "rating", text: q.get("q") ?? "" };
}

function writeFilters(next) {
  const f = { ...readFilters(), ...next };
  const q = new URLSearchParams();
  if (f.pos) q.set("pos", f.pos);
  if (f.sort !== "rating") q.set("sort", f.sort);
  if (f.text) q.set("q", f.text);
  const qs = q.toString();
  history.replaceState(null, "", `/players${qs ? `?${qs}` : ""}`);
  paintList();
}

function wireList() {
  $("#search").addEventListener("input", (ev) => writeFilters({ text: ev.target.value.trim() }));
  $("#sort").addEventListener("change", (ev) => writeFilters({ sort: ev.target.value }));
  $("#posFilter").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-pos]");
    if (btn) writeFilters({ pos: btn.dataset.pos });
  });

  // Open a player without a full page load; the back button still works.
  $("#grid").addEventListener("click", (ev) => {
    const link = ev.target.closest("a.pc");
    if (!link || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    history.pushState({ fromList: true }, "", link.getAttribute("href"));
    window.scrollTo(0, 0);
    route();
  });
}

async function loadRoster() {
  if (!roster) ({ people: roster } = await people.list());
  return roster;
}

async function showList() {
  document.title = "Players — WeGro Tournaments";
  try {
    await loadRoster();
  } catch (err) {
    return problem("Cannot load the players", err.message);
  }
  show($("#loading"), false);
  show($("#profileView"), false);
  show($("#listView"), true);

  const f = readFilters();
  $("#search").value = f.text;
  $("#sort").value = f.sort;
  paintList();
}

function paintList() {
  if (!roster) return;
  const f = readFilters();
  for (const b of document.querySelectorAll("#posFilter button")) {
    b.setAttribute("aria-pressed", String(b.dataset.pos === f.pos));
  }

  const text = f.text.toLowerCase();
  const shown = roster
    .filter((p) => p.active !== false)
    .filter((p) => !f.pos || p.pos === f.pos)
    .filter((p) => !text || p.name.toLowerCase().includes(text))
    .sort(SORTS[f.sort]);

  const played = roster.filter((p) => p.tournamentCount > 0).length;
  $("#listSub").textContent = `${D.plural(roster.length, "player")} · ${played} have played in a tournament so far.`;

  setHTML(
    $("#grid"),
    shown.map((p, i) => playerCard(p, { index: i })).join("") ||
      `<p class="faint">${roster.length ? "Nobody matches that." : "The roster is being put together."}</p>`,
  );
}

/* ---------------------------------------------------------------- profile */

/**
 * The other half of a player: who they are on the console and how they have
 * done there. Deliberately a separate card with its own rating, because a goal
 * on the pitch and a goal in FC 26 are not the same thing, and mixing them
 * would flatter whoever plays both.
 */
function gameCard(person) {
  if (!playsGame(person)) return "";

  const g = person.game;
  const t = g.totals ?? {};
  const profile = [
    g.gamerTag ? `<b>${e(g.gamerTag)}</b>` : "",
    g.platform ? e(g.platform) : "",
    g.favClub ? `plays as ${e(g.favClub)}` : "",
  ].filter(Boolean);

  const tile = (label, value) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;
  const record = t.matches
    ? `<dl class="career-tiles">
         ${tile("Matches", t.matches)}
         ${tile("Won", t.won)}
         ${tile("Drawn", t.drawn)}
         ${tile("Lost", t.lost)}
         ${tile("Goals for", t.goalsFor)}
         ${tile("Goals against", t.goalsAgainst)}
         ${t.goals ? tile("Per. Goals", t.goals) : ""}
         ${t.assists ? tile("Per. Assists", t.assists) : ""}
         ${t.saves ? tile("Per. Saves", t.saves) : ""}
         ${t.shots ? tile("Per. Shots", t.shots) : ""}
         ${t.chances ? tile("Per. Chances", t.chances) : ""}
         ${tile("Points", t.points)}
         ${g.titles ? tile("Titles", `\u{1F3C6} ${g.titles}`) : ""}
       </dl>`
    : `<p class="faint">No FC 26 matches yet.</p>`;

  const rows = (g.tournaments ?? []).map(
    (x) => `<tr>
      <td><a href="/t/${encodeURIComponent(x.slug)}">${e(x.name)}${x.season ? ` ${e(x.season)}` : ""}</a>${x.champion ? " \u{1F3C6}" : x.runnerUp ? " \u{1F948}" : ""}</td>
      <td>${e(x.team?.name ?? "\u2014")}${x.team?.group ? ` <span class="faint">Group ${e(x.team.group)}</span>` : ""}</td>
      <td>${x.partners?.length ? e(x.partners.map((p) => p.name).join(", ")) : `<span class="faint">solo</span>`}</td>
      <td class="num">${x.stats.matches}</td><td class="num">${x.stats.won}</td><td class="num">${x.stats.drawn}</td>
      <td class="num">${x.stats.lost}</td><td class="num">${x.stats.goalsFor}:${x.stats.goalsAgainst}</td>
      <td class="num"><b>${x.stats.points}</b></td>
    </tr>`,
  );

  return `<div class="card card--game">
    <h2 class="card__title">\u{1F3AE} On FC 26</h2>
    ${profile.length ? `<p class="profile__sub">${profile.join(" \u00b7 ")}</p>` : ""}
    <dl class="rating-pair">
      <div><dt>Gaming rating</dt><dd>${g.rating ?? "\u2013"}</dd></div>
      <div><dt>From results</dt><dd>${g.statsRating ?? "\u2013"}</dd></div>
    </dl>
    ${g.statsRating === null && t.matches ? `<p class="faint">A rating from results appears after ${D.plural(2, "match", "matches")}.</p>` : ""}
    ${record}
    ${
      rows.length
        ? `<div class="table-scroll">
             <table class="tbl">
               <thead><tr><th>Tournament</th><th>Team</th><th>With</th><th class="num">M</th><th class="num">W</th><th class="num">D</th><th class="num">L</th><th class="num">GF:GA</th><th class="num">Pts</th></tr></thead>
               <tbody>${rows.join("")}</tbody>
             </table>
           </div>`
        : ""
    }
  </div>`;
}

async function showProfile(id) {
  show($("#listView"), false);
  let person;
  try {
    ({ person } = await people.get(id));
  } catch (err) {
    return err.status === 404
      ? problem("No such player", "They may have been removed from the roster.")
      : problem("Cannot load this player", err.message);
  }
  show($("#loading"), false);
  document.title = `${person.name} — WeGro Players`;

  const t = person.totals;
  const tile = (label, value) => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;
  const tiles = [
    tile("Tournaments", person.tournamentCount ?? person.tournaments.length),
    tile("Matches", t.matches),
    tile("Goals", t.goals),
    tile("Assists", t.assists),
    person.pos === "GK" || t.saves ? tile("Saves", t.saves) : "",
    person.pos === "GK" || person.pos === "DEF" || t.cleanSheets ? tile("Clean sheets", t.cleanSheets) : "",
    person.pos === "DEF" || t.clearances ? tile("Clearances", t.clearances) : "",
    tile("Points", t.points),
    t.yellows || t.reds ? tile("Cards", `${t.yellows ? `🟨${t.yellows}` : ""} ${t.reds ? `🟥${t.reds}` : ""}`) : "",
  ].join("");

  const back = history.state?.fromList
    ? `<a class="back-link" href="/players" data-back>← All players</a>`
    : `<a class="back-link" href="/players">← All players</a>`;

  setHTML(
    $("#profileView"),
    `${back}
    <div class="profile">
      <div class="profile__card">${playerCard(person)}</div>
      <div class="stack">
        <div>
          <h1 class="profile__name">${e(person.name)}</h1>
          <p class="profile__sub">${e({ GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", FWD: "Forward" }[person.pos] ?? "Player")}${person.lastTournament?.team ? ` · last played for ${e(person.lastTournament.team.name)}` : ""}</p>
          <dl class="rating-pair">
            <div><dt>Rating</dt><dd>${person.rating ?? "–"}</dd></div>
            <div><dt>From stats</dt><dd>${person.statsRating ?? "–"}</dd></div>
          </dl>
          ${
            person.statsRating === null && t.matches
              ? `<p class="faint">A rating from stats appears after ${D.plural(2, "match", "matches")}.</p>`
              : ""
          }
        </div>

        ${
          person.titles || person.medals.length
            ? `<div class="card">
                <h2 class="card__title">Honours</h2>
                <ul class="medal-list">
                  ${person.titles ? `<li>🏆 ${D.plural(person.titles, "title")}</li>` : ""}
                  ${person.medals.map((m) => `<li>${m.icon} ${e(m.label)} ${e(m.season ?? "")}</li>`).join("")}
                </ul>
              </div>`
            : ""
        }

        <div class="card">
          <h2 class="card__title">${playsGame(person) ? "On the pitch" : "Career"}</h2>
          ${t.matches || person.tournaments.length ? `<dl class="career-tiles">${tiles}</dl>` : `<p class="faint">Yet to play in a tournament.</p>`}
        </div>

        ${
          person.tournaments.length
            ? `<div class="card">
                <h2 class="card__title">Tournament by tournament</h2>
                <div class="table-scroll">
                  <table class="tbl">
                    <thead><tr><th>Tournament</th><th>Team</th><th class="num">M</th><th class="num">G</th><th class="num">A</th><th class="num">Sv</th><th class="num">Pts</th></tr></thead>
                    <tbody>${person.tournaments
                      .map(
                        (x) => `<tr>
                          <td><a href="/t/${encodeURIComponent(x.slug)}">${e(x.name)}${x.season ? ` ${e(x.season)}` : ""}</a>${x.champion ? " 🏆" : ""}${x.medals.map((m) => ` ${m.icon}`).join("")}</td>
                          <td>${e(x.team?.name ?? (x.kind === "guest" ? "Guest" : "—"))}${x.kind === "captain" ? ' <span class="flag-special">CAP</span>' : ""}</td>
                          <td class="num">${x.matches}</td><td class="num">${x.stats.goals}</td><td class="num">${x.stats.assists}</td>
                          <td class="num">${x.stats.saves}</td><td class="num"><b>${x.stats.points}</b></td>
                        </tr>`,
                      )
                      .join("")}</tbody>
                  </table>
                </div>
              </div>`
            : ""
        }
        ${gameCard(person)}
      </div>
    </div>`,
  );
  show($("#profileView"), true);

  $("#profileView [data-back]")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    history.back();
  });
}
