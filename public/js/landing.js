/**
 * The landing page: what WeGro Tournaments is, every tournament — happening now,
 * coming soon, or finished — and the players.
 *
 * Content first, motion second. The cards appear the moment the data arrives;
 * the pitch animation and the counting numbers are decoration layered on top,
 * and both switch off for anyone who has asked their device for less motion.
 */

import * as D from "/shared/domain/index.js";
import { PHASE_LABEL, formatDay, sortByPhase, tournamentPhase } from "/shared/domain/phase.js";
import { $, setHTML, show, wireSiteHeader } from "./ui.js";
import { api, archive, people } from "./api.js";
import { byStrength, playerCard } from "./player-card.js";

const e = D.escapeHtml;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

wireSiteHeader();
load();
startPitch();
watchForChanges();

async function load() {
  const [list, site, roster, hof] = await Promise.allSettled([
    api.get("/tournaments"),
    api.get("/site"),
    people.list(),
    archive.list(),
  ]);

  const entries = hof.status === "fulfilled" ? hof.value.entries : [];
  if (list.status === "fulfilled") paintTournaments(list.value.tournaments, entries);
  else setHTML($("#tournamentGroups"), `<p class="faint err">${e(list.reason.message)}</p>`);

  if (site.status === "fulfilled") countUp(site.value.totals);
  if (roster.status === "fulfilled") paintPlayers(roster.value.people);
  paintHallOfFame(entries);
}

/* ------------------------------------------------------------ tournaments */

function paintTournaments(list, entries) {
  const champions = new Map(entries.map((x) => [x.tournamentId, x]));
  const visible = sortByPhase(list.filter((t) => tournamentPhase(t) !== "hidden"));

  if (!visible.length) {
    setHTML(
      $("#tournamentGroups"),
      `<div class="empty-state"><h3>The next tournament is being planned</h3><p class="muted">It will appear here as soon as it is announced.</p></div>`,
    );
    return;
  }

  const groups = [
    ["live", "Happening now", (p) => p === "live" || p === "ongoing"],
    ["upcoming", "Coming soon", (p) => p === "upcoming"],
    ["finished", "Finished", (p) => p === "finished"],
  ];

  let index = 0;
  setHTML(
    $("#tournamentGroups"),
    groups
      .map(([key, title, test]) => {
        const items = visible.filter((t) => test(tournamentPhase(t)));
        if (!items.length) return "";
        return `<div class="tgroup tgroup--${key}">
          <h3 class="tgroup__title">${e(title)}</h3>
          <div class="tgrid">${items.map((t) => tournamentCard(t, champions.get(t.id), index++)).join("")}</div>
        </div>`;
      })
      .join(""),
  );
}

function tournamentCard(t, hof, index) {
  const phase = tournamentPhase(t);
  const meta = t.meta ?? {};
  const day = meta.dateLabel || formatDay(t.startsOn);
  const venue = meta.venueName;

  const badge = `<span class="phase phase--${phase}">${e(PHASE_LABEL[phase])}</span>`;
  const facts = [
    t.teamCount ? D.plural(t.teamCount, "team") : null,
    t.matchCount ? D.plural(t.matchCount, "match", "matches") : null,
    t.format === "friendly" ? "Friendly" : null,
  ].filter(Boolean);

  return `<a class="tcard tcard--${phase}" href="/t/${encodeURIComponent(t.slug)}" style="--i:${index}">
    <span class="tcard__top">
      ${badge}
      ${t.season ? `<span class="tcard__season">${e(t.season)}</span>` : ""}
    </span>
    <span class="tcard__name">${e(t.name)}</span>
    <span class="tcard__facts">
      <span class="tcard__fact"><span aria-hidden="true">📅</span> ${day ? e(day) : `<i>Date to be announced</i>`}</span>
      <span class="tcard__fact"><span aria-hidden="true">📍</span> ${venue ? e(venue) : `<i>Venue to be announced</i>`}</span>
    </span>
    ${
      phase === "finished" && hof?.champion
        ? `<span class="tcard__champion"><span aria-hidden="true">🏆</span> <b>${e(hof.champion)}</b>${hof.runnerUp ? ` <span class="faint">beat ${e(hof.runnerUp)}${hof.finalScore ? ` ${e(hof.finalScore)}` : ""}</span>` : ""}</span>`
        : `<span class="tcard__meta faint">${facts.length ? e(facts.join(" · ")) : "Squads to be announced"}</span>`
    }
    <span class="tcard__go" aria-hidden="true">→</span>
  </a>`;
}

/* ---------------------------------------------------------------- players */

function paintPlayers(list) {
  if (!list.length) return;
  const top = [...list].filter((p) => p.active !== false).sort(byStrength).slice(0, 8);
  show($("#playersSection"), true);
  setHTML($("#playerStrip"), top.map((p, i) => playerCard(p, { index: i })).join(""));
}

function paintHallOfFame(entries) {
  const latest = entries.find((x) => x.champion);
  if (!latest) return;
  show($("#hofTeaser"), true);
  $("#hofTitle").textContent = `${latest.champion} — ${latest.name}${latest.season ? ` ${latest.season}` : ""}`;
  $("#hofSub").textContent =
    entries.length > 1 ? `And ${D.plural(entries.length - 1, "more champion")} before them.` : "The first name on the list.";
}

/* ---------------------------------------------------------------- numbers */

function countUp(totals) {
  const cells = [...document.querySelectorAll("[data-count]")];
  const setFinal = () => cells.forEach((el) => (el.textContent = String(totals[el.dataset.count] ?? 0)));
  if (reduceMotion || !("IntersectionObserver" in window)) return setFinal();

  const run = () => {
    const start = performance.now();
    const duration = 1100;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      for (const el of cells) el.textContent = String(Math.round((totals[el.dataset.count] ?? 0) * eased));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };

  const io = new IntersectionObserver((seen) => {
    if (seen.some((s) => s.isIntersecting)) {
      io.disconnect();
      run();
    }
  });
  io.observe($("#siteStats"));
}

/* ------------------------------------------------------------------ pitch */

/**
 * A five-a-side move on the hero pitch: the ball is passed along a chain of
 * players and finished into the right-hand goal, which glows. Then again, from
 * a different build-up. Drawn with plain SVG and requestAnimationFrame.
 */
function startPitch() {
  const svg = $("#pitch");
  if (!svg) return;

  const players = [
    // [x, y, side] — side "us" is orange, "them" is white.
    [60, 130, "us"], [130, 70, "us"], [140, 190, "us"], [230, 110, "us"], [300, 160, "us"],
    [340, 130, "them"], [270, 70, "them"], [250, 200, "them"], [170, 130, "them"], [385, 130, "them"],
  ];
  setHTML(
    $("#pitchPlayers"),
    players
      .map(([x, y, side], i) => `<circle class="pitch__player pitch__player--${side}" cx="${x}" cy="${y}" r="6" style="--i:${i}" />`)
      .join(""),
  );

  const ball = $("#ball");
  const trail = $("#ballTrail");
  const glow = $("#goalGlow");
  svg.classList.add("is-drawn");

  if (reduceMotion) {
    ball.setAttribute("cx", "300");
    ball.setAttribute("cy", "160");
    return;
  }

  // Build-ups, as indexes into `players`, always ending with a shot at goal.
  const moves = [
    [0, 1, 3, 4, "goal"],
    [0, 2, 3, "goal"],
    [2, 1, 3, 4, "goal"],
  ];
  const GOAL = [394, 124];

  let move = 0;
  let leg = 0;
  let legStart = performance.now() + 1600; // let the lines draw first

  const point = (ref) => (ref === "goal" ? GOAL : players[ref]);

  const frame = (now) => {
    const chain = moves[move];
    const from = point(chain[leg]);
    const to = point(chain[leg + 1]);
    const shot = chain[leg + 1] === "goal";
    const duration = shot ? 520 : 780;
    const t = Math.max(0, Math.min(1, (now - legStart) / duration));
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // A gentle arc for a pass, a flat line for a shot.
    const lift = shot ? 0 : -22;
    const cx = (from[0] + to[0]) / 2;
    const cy = (from[1] + to[1]) / 2 + lift;
    const x = (1 - eased) ** 2 * from[0] + 2 * (1 - eased) * eased * cx + eased ** 2 * to[0];
    const y = (1 - eased) ** 2 * from[1] + 2 * (1 - eased) * eased * cy + eased ** 2 * to[1];
    ball.setAttribute("cx", x.toFixed(1));
    ball.setAttribute("cy", y.toFixed(1));
    trail.setAttribute("d", `M${from[0]},${from[1]} Q${cx},${cy} ${x.toFixed(1)},${y.toFixed(1)}`);

    if (t >= 1) {
      leg++;
      legStart = now + (shot ? 0 : 120);
      if (shot) {
        glow.classList.remove("is-on");
        void glow.getBoundingClientRect(); // restart the flash
        glow.classList.add("is-on");
      }
      if (leg >= chain.length - 1) {
        leg = 0;
        move = (move + 1) % moves.length;
        legStart = now + 1400;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* -------------------------------------------------------------- live data */

/** Refresh when anything changes anywhere, so a tournament turns "Live" on its own. */
function watchForChanges() {
  if (!("EventSource" in window)) return;
  let timer = null;
  const source = new EventSource("/api/stream");
  source.addEventListener("changed", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 1500);
  });
}
