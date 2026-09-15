/**
 * One tournament's public scoreboard, at /t/<slug>. Read-only: this file never
 * writes anything.
 *
 * Every number on the page is computed from the tournament document by
 * shared/domain/ — the same code the server validates with. There is no
 * duplicate definition of how a table sorts or what a player's points are.
 */

import * as D from "/shared/domain/index.js";
import { $, setHTML, show, rememberTab, wireScrollFade, wireSiteHeader, wireTabs } from "./ui.js";
import { serverNow, syncClock, watchTournament } from "./api.js";

const e = D.escapeHtml;

let data = null;
let stop = null;
let lastUpdate = null;

/* ------------------------------------------------------------------ boot */

init();

async function init() {
  wireSiteHeader();
  await syncClock();

  // /t/<slug>. The server redirects the old /?t=<slug> links here, but a page
  // opened from a cached copy of the old site may still carry ?t=, so read both.
  const slug = decodeURIComponent(location.pathname.split("/")[2] ?? "") || new URLSearchParams(location.search).get("t");
  if (!slug) {
    location.replace("/");
    return;
  }

  open(slug);

  // `wireTabs` fires onChange synchronously while selecting the initial tab,
  // which is before `rememberTab` has returned its writer. Declaring the
  // binding first and filling it in afterwards keeps that first call harmless.
  let saveTab = () => {};
  const selectTab = wireTabs($("#tabs"), { onChange: (n) => saveTab(n) });
  saveTab = rememberTab("wgt:tab", selectTab);
  for (const el of document.querySelectorAll(".table-scroll")) wireScrollFade(el);

  // Only the clock digits and the "updated" stamp tick — never a full repaint.
  setInterval(tick, 1000);
}

function open(slug) {
  stop?.();
  stop = watchTournament(
    slug,
    (next) => {
      data = next;
      lastUpdate = serverNow();
      render();
    },
    (err) => fail(err.message, err),
  );
}

function fail(message, err) {
  show($("#loading"), false);
  show($("#content"), false);
  if (err?.status === 404) {
    document.title = "Not found — WeGro Tournaments";
    return show($("#notFound"), true);
  }
  $("#offlineWhy").textContent = message || "Check your connection and refresh.";
  show($("#offline"), true);
}

/* ---------------------------------------------------------------- render */

function render() {
  show($("#loading"), false);
  show($("#offline"), false);
  show($("#content"), true);

  document.title = `${data.name}${data.season ? ` ${data.season}` : ""} — WeGro`;
  $("#brandTitle").textContent = data.name;

  paintHero();
  paintBanners();
  paintCaptains();
  paintNextUp();
  paintTable($("#miniTable"), true);
  paintVenue();
  paintFixtures();
  paintTable($("#table"), false);
  paintSquads();
  paintStats();
  paintDiscipline();
  tick();
}

function paintHero() {
  const meta = D.getMeta(data);

  $("#heroEyebrow").textContent = data.season ? `Season ${data.season}` : "";

  // The stylesheet gives the <span> a gradient fill, so the last word or two of
  // the name is the coloured part — that is where the brand look comes from.
  const words = String(data.name).trim().split(/\s+/);
  const lead = words.length > 1 ? words.slice(0, -2).join(" ") : "";
  const tail = words.length > 1 ? words.slice(-2).join(" ") : words[0];
  setHTML($("#heroTitle"), `${e(lead)}${lead ? " " : ""}<span>${e(tail)}</span>`);

  $("#heroSub").textContent = [meta.venueName, meta.dateLabel, meta.timeLabel].filter(Boolean).join(" · ");

  setHTML(
    $("#heroPills"),
    [
      data.format === "friendly"
        ? `<span class="pill">Friendly</span>`
        : `<span class="pill pill--mint">League</span>`,
      data.status === "completed" ? `<span class="pill pill--gold">Finished</span>` : "",
      D.matchesList(data).some((m) => m.status === "live") ? `<span class="pill pill--live">Live now</span>` : "",
    ]
      .filter(Boolean)
      .join(""),
  );
}

function paintBanners() {
  const live = D.matchesList(data).find((m) => m.status === "live");
  const result = data.status === "completed" ? D.champion(data) : null;
  const parts = [];

  if (result?.winner) {
    parts.push(
      `<div class="card card--flat"><b class="pill pill--gold">Champions</b>
       <h2 style="margin:.4rem 0 0">${e(result.winner.name)}</h2>
       ${result.runnerUp ? `<p class="muted" style="margin:.2rem 0 0">Runners-up ${e(result.runnerUp.name)}${result.finalScore ? ` · ${e(result.finalScore)}` : ""}</p>` : ""}
       </div>`,
    );
  }
  if (live) {
    const { homeLabel, awayLabel } = D.matchSides(data, live);
    parts.push(
      `<div class="card card--flat"><span class="pill pill--live">Live</span>
       <b style="margin-left:.5rem">${e(homeLabel)} ${live.homeScore ?? 0} – ${live.awayScore ?? 0} ${e(awayLabel)}</b></div>`,
    );
  }
  setHTML($("#banners"), parts.join(""));
}

function paintCaptains() {
  const rows = D.teamsList(data).map((t) => {
    const captain = D.teamCaptain(data, t.id);
    return `<div class="captain-row">
      ${face(captain, "face")}
      <span class="captain-row__text">
        <b>${e(t.name)}</b>
        <span class="muted">${captain ? personLink(captain) : "No captain yet"}</span>
      </span>
      <span class="jersey-dot" style="background:${e(t.jerseyColor || "#888")}" title="Jersey"></span>
    </div>`;
  });
  setHTML($("#captains"), rows.join("") || `<p class="faint">No teams yet.</p>`);
}

/** A player's photo, or their initials. */
function face(player, className) {
  if (player?.photo) return `<img class="${className}" src="${e(player.photo)}" alt="" loading="lazy" width="48" height="48" />`;
  // Letters only, so "Mehedi (ops)" is "MO" rather than "M(".
  const words = String(player?.name ?? "").replace(/[^\p{L}\s]/gu, " ").trim().split(" ").filter(Boolean);
  const letters = ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return `<span class="${className} face--empty" aria-hidden="true">${e(letters || "?")}</span>`;
}

/** A player's name, linking to their record when they are on the roster. */
function personLink(player) {
  return player.personId
    ? `<a class="person-link" href="/players/${encodeURIComponent(player.personId)}">${e(player.name)}</a>`
    : e(player.name);
}

function paintNextUp() {
  const next = D.matchesList(data).find((m) => m.status !== "ft");
  if (!next) return setHTML($("#nextUp"), `<p class="faint">Every match has been played.</p>`);
  setHTML($("#nextUp"), matchRow(next, { plain: true }));
}

function paintVenue() {
  const meta = D.getMeta(data);
  const rows = [
    ["Where", meta.venueName],
    ["When", [meta.dateLabel, meta.timeLabel].filter(Boolean).join(" · ")],
    ["Auction", meta.auctionLabel],
  ].filter(([, v]) => v);

  show($("#venueCard"), rows.length > 0);
  setHTML($("#venue"), rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join(""));
}

function matchRow(m, { plain = false } = {}) {
  const { homeLabel, awayLabel } = D.matchSides(data, m);
  const played = D.isPlayed(m);
  const score = played || m.status === "live" ? `${m.homeScore ?? 0} – ${m.awayScore ?? 0}` : "v";
  const pill =
    m.status === "live"
      ? `<span class="pill pill--live">Live</span>`
      : m.isFinal
        ? `<span class="pill pill--gold">Final</span>`
        : `<span class="pill">${e(D.STATUS_LABEL[m.status] ?? m.status)}</span>`;

  const log = played ? matchLog(m) : "";
  return `<div class="fx${plain ? " fx--plain" : ""}">
    <div class="row spread">
      <span class="fx__team">${e(homeLabel)}</span>
      <b class="fx__score">${e(score)}</b>
      <span class="fx__team">${e(awayLabel)}</span>
    </div>
    <div class="row spread"><span class="faint">Match ${m.no}${m.time ? ` · ${e(m.time)}` : ""}</span>${pill}</div>
    ${log}
  </div>`;
}

function matchLog(m) {
  const events = D.matchEvents(m);
  if (!events.length) return "";
  const lines = events.map((ev) => {
    const who = D.playerById(data, ev.playerId);
    const icon = D.ACTION_ICON[ev.type] ?? "•";
    const assist = ev.assistId ? ` (assist ${e(D.playerById(data, ev.assistId)?.name ?? "")})` : "";
    return `<li>${icon} ${e(who?.name ?? "Not recorded")}${assist}
      <span class="faint">${e(ev.clockLabel ?? "")}</span></li>`;
  });
  return `<ul class="fx__events">${lines.join("")}</ul>`;
}

function paintFixtures() {
  setHTML(
    $("#fixtures"),
    D.matchesList(data).map((m) => matchRow(m)).join("") || `<p class="faint">No fixtures yet.</p>`,
  );
}

function paintTable(target, mini) {
  const table = D.standings(data);
  if (!table.length) return setHTML(target, `<p class="faint">No teams yet.</p>`);

  const qualify = D.groupStageComplete(data) && data.format === "league";
  const head = mini
    ? `<tr><th>#</th><th>Team</th><th class="num">Pts</th></tr>`
    : `<tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th>
       <th class="num">L</th><th class="num">GF</th><th class="num">GA</th><th class="num">GD</th><th class="num">Pts</th></tr>`;

  const rows = table.map(
    (r) => `<tr${qualify && r.pos <= 2 ? ' class="is-q"' : ""}>
      <td>${r.pos}</td>
      <td>${e(r.team.name)}${qualify && r.pos <= 2 ? ' <span class="pill pill--mint">Q</span>' : ""}</td>
      ${mini ? "" : `<td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.drawn}</td>
        <td class="num">${r.lost}</td><td class="num">${r.goalsFor}</td><td class="num">${r.goalsAgainst}</td>
        <td class="num">${r.goalDiff > 0 ? "+" : ""}${r.goalDiff}</td>`}
      <td class="num"><b>${r.points}</b></td>
    </tr>`,
  );

  setHTML(target, `<table class="tbl"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`);
}

function paintSquads() {
  const progress = D.auctionProgress(data);
  const state = D.auctionState(data);

  setHTML(
    $("#auctionProgress"),
    progress.total
      ? `<div class="progress-line"><div class="progress-bar" style="width:${(progress.sold / progress.total) * 100}%"></div></div>
         <p class="faint">${progress.sold} of ${progress.total} sold · ${e(D.bdt(progress.spend))} spent</p>`
      : `<p class="faint">No auction pool for this tournament.</p>`,
  );

  const cards = D.teamsList(data).map((t) => {
    const st = state[t.id];
    const captain = D.teamCaptain(data, t.id);
    const squad = D.teamSquad(data, t.id);
    const guests = D.teamGuests(data, t.id);

    const line = (p, extra = "") =>
      `<li>${face(p, "face face--sm")}<span class="pos">${e(p.pos)}</span> <span class="grow">${personLink(p)}</span> ${extra}</li>`;

    return `<div class="card squad">
      <h3 class="card__title">
        <span class="jersey-dot" style="background:${e(t.jerseyColor || "#888")}"></span>
        ${e(t.name)}
      </h3>
      <ul class="squad__list">
        ${captain ? line(captain, `<span class="pill pill--gold">CAP</span>`) : ""}
        ${squad.map((p) => line(p, `<span class="faint">${e(D.bdt(p.price))}</span>`)).join("")}
        ${guests.map((p) => line(p, `<span class="pill">Guest</span>`)).join("")}
      </ul>
      ${st ? `<p class="faint">${e(D.bdt(st.spent))} spent · ${e(D.bdt(st.remaining))} left · ${squad.length}/${st.squadSize}</p>` : ""}
    </div>`;
  });

  setHTML($("#squads"), `<div class="cols-2">${cards.join("")}</div>`);

  const unsold = D.unsoldPlayers(data);
  show($("#poolCard"), unsold.length > 0);
  setHTML(
    $("#pool"),
    `<div class="pool">${unsold.map((p) => `<span class="pill">${e(p.pos)} ${e(p.name)}</span>`).join("")}</div>`,
  );
}

function paintStats() {
  const a = D.awards(data);

  /**
   * The class names here are the stylesheet's, not invented ones: `.award`
   * styles `.medal`, `.label`, `.winner` and `.sub` children. Getting that
   * wrong is what made these render as a run-on list of plain text.
   */
  const card = (medal, label, winner, sub, note) =>
    `<div class="award${winner ? "" : " tbd"}">
       <div class="medal">${medal}</div>
       <div class="label">${e(label)}</div>
       <div class="winner">${winner ? e(winner) : "To be decided"}</div>
       ${winner && sub ? `<div class="sub">${e(sub)}</div>` : ""}
       ${winner && note ? `<div class="award-note">${e(note)}</div>` : ""}
     </div>`;

  /**
   * Why a medal went where it did.
   *
   * "Chosen by the organisers" is said plainly rather than left implied: when a
   * medal is overridden, the name on the card will not be top of the table
   * printed underneath it, and without a note that reads as the arithmetic
   * contradicting itself.
   */
  const note = (row) =>
    row?.picked ? "Chosen by the organisers" : row?.tied ? "Tied on points" : "";

  const pts = (r) => `${r.points} pts · ${r.team?.name ?? "unsold"}`;
  const boot = a.goldenBoot?.[0];

  setHTML(
    $("#awards"),
    [
      card("🏅", "Golden Ball", a.goldenBall?.player.name, a.goldenBall && pts(a.goldenBall), note(a.goldenBall)),
      card(
        "👟",
        "Golden Boot",
        boot && a.goldenBoot.map((r) => r.player.name).join(" & "),
        boot && `${boot.goals} ${boot.goals === 1 ? "goal" : "goals"} · ${boot.team?.name ?? "unsold"}`,
        boot?.picked ? "Chosen by the organisers" : a.goldenBoot.length > 1 ? "Shared" : "",
      ),
      card("🧤", "Golden Glove", a.goldenGlove?.player.name, a.goldenGlove && pts(a.goldenGlove), note(a.goldenGlove)),
      card("🛡", "Best Defender", a.bestDefender?.player.name, a.bestDefender && pts(a.bestDefender), note(a.bestDefender)),
      card(
        "🤝",
        "Fair Play",
        a.fairPlay?.team?.name,
        a.fairPlay && `${a.fairPlay.points} discipline points`,
        a.fairPlay?.picked ? "Chosen by the organisers" : "",
      ),
    ].join(""),
  );

  const leaderboard = (rows, one) =>
    rows.length
      ? `<ol class="stat-list">${rows
          .slice(0, 10)
          .map((r) => `<li><b>${e(r.player.name)}</b> <span class="faint">${e(r.team?.name ?? "")}</span><span class="num">${e(D.plural(r.value, one))}</span></li>`)
          .join("")}</ol>`
      : `<p class="faint">Nothing logged yet.</p>`;

  setHTML($("#scorers"), leaderboard(D.topScorers(data), "goal"));
  setHTML($("#assists"), leaderboard(D.topAssists(data), "assist"));

  const points = D.getPoints(data);
  setHTML(
    $("#pointsKey"),
    D.POINT_FIELDS.map(([k, label]) => `<span class="pt-chip">${e(label)} ${points[k] > 0 ? "+" : ""}${points[k]}</span>`).join(" "),
  );

  const ledger = D.playerStats(data).filter(D.hasRecord);
  const cols = [
    ["goals", "G"], ["assists", "A"], ["saves", "Sv"], ["clearances", "Cl"],
    ["shots", "Sh"], ["chances", "Ch"], ["cleanSheets", "CS"],
    ["fouls", "F"], ["yellows", "🟨"], ["reds", "🟥"],
  ];

  setHTML(
    $("#pointsTable"),
    ledger.length
      ? `<table class="tbl tbl--ledger">
          <thead><tr><th>Player</th><th class="num">Pts</th>${cols.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead>
          <tbody>${ledger
            .map(
              (r) => `<tr>
                <td>
                  <span class="ledger-name">${e(r.player.name)}${r.player.kind === "captain" ? ' <span class="flag-special">CAP</span>' : ""}${r.player.kind === "guest" ? ' <span class="flag-special">Guest</span>' : ""}</span>
                  <span class="ledger-team">${e(r.team?.name ?? "No team")}</span>
                </td>
                <td class="num ledger-pts">${r.points}</td>
                ${cols.map(([k]) => `<td class="num">${r[k] || ""}</td>`).join("")}
              </tr>`,
            )
            .join("")}</tbody>
         </table>`
      : `<p class="faint">Nothing logged yet.</p>`,
  );
}

function paintDiscipline() {
  const table = D.disciplineTable(data);
  setHTML(
    $("#fairPlay"),
    `<table class="tbl">
      <thead><tr><th>#</th><th>Team</th><th class="num">Fouls</th><th class="num">🟨</th><th class="num">🟥</th><th class="num">Points</th></tr></thead>
      <tbody>${table
        .map(
          (r, i) => `<tr><td>${i + 1}</td><td>${e(r.team.name)}</td>
            <td class="num">${r.fouls || ""}</td><td class="num">${r.yellows || ""}</td>
            <td class="num">${r.reds || ""}</td><td class="num"><b>${r.points}</b></td></tr>`,
        )
        .join("")}</tbody>
    </table>`,
  );

  const carded = D.playerStats(data).filter((r) => r.yellows || r.reds || r.fouls);
  setHTML(
    $("#cards"),
    carded.length
      ? `<table class="tbl">
          <thead><tr><th>Player</th><th>Team</th><th class="num">Fouls</th><th class="num">🟨</th><th class="num">🟥</th></tr></thead>
          <tbody>${carded
            .map(
              (r) => `<tr><td>${e(r.player.name)}</td><td>${e(r.team?.name ?? "—")}</td>
                <td class="num">${r.fouls || ""}</td><td class="num">${r.yellows || ""}</td><td class="num">${r.reds || ""}</td></tr>`,
            )
            .join("")}</tbody>
        </table>`
      : `<p class="faint">A clean tournament so far.</p>`,
  );
}

/** One second tick: the "updated" stamp and any running match clock only. */
function tick() {
  if (!data) return;
  // When this page last received data, not a stored field. The old site showed
  // `new Date()` at render time, which is just the viewer's own clock and
  // always says "now" however stale the data actually is.
  $("#updated").textContent = D.formatUpdated(lastUpdate, serverNow());

  for (const el of document.querySelectorAll("[data-clock]")) {
    const match = D.matchById(data, el.dataset.clock);
    if (!match) continue;
    const state = D.clockState(match, serverNow());
    const { main, extra } = D.formatClock(state.elapsed, D.periodLength(data, state.period));
    el.textContent = extra ? `${main} ${extra}` : main;
  }
}
