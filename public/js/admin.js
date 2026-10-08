/**
 * The admin console.
 *
 * The rule this file follows: the UI shapes itself around what you are allowed
 * to do, but it never *enforces* it. Every button here calls an endpoint that
 * checks permission again on the server. Hiding a tab is a courtesy to keep the
 * screen tidy; if somebody opens devtools and calls the endpoint directly they
 * get a 403, which is exactly what the previous version could not do.
 */

import * as D from "/shared/domain/index.js";
import { $, $$, confirmPhrase, rememberTab, setHTML, show, toast, wireSiteHeader, wireTabs } from "./ui.js";
import { auth, people, serverNow, syncClock, tournaments, transfer, watchTournament } from "./api.js";
import { renderAccounts, wireAccounts } from "./admin/accounts.js";
import { renderSite, wireSite } from "./admin/site.js";
import { renderOverview, wireOverview } from "./admin/overview.js";
import { renderPlayers as renderRoster, tournamentChanged, wirePlayers } from "./admin/players.js";
import { renderAuctionDesk, sellOnBlock, wireAuctionDesk } from "./admin/auction-desk.js";
import { loadRoster, renderCaptainPicker, wireRosterPicker } from "./admin/roster-picker.js";

const e = D.escapeHtml;

let me = null;
let myTournaments = [];
let data = null;
let perms = { role: null, canScore: false, canManage: false };
let stop = null;
let selectTab = () => {};
let liveMatchId = null;

boot();

async function boot() {
  wireSiteHeader();
  await syncClock();
  wireAuthForm();

  let saveTab = () => {};
  selectTab = wireTabs($("#tabs"), {
    onChange: (n) => {
      saveTab(n);
      if (n === "players") renderRoster();
      if (n === "site") renderSite();
      // The tournament bar says which tournament the tabs act on. The super
      // admin's Tournaments and Accounts screens act on none, so hide it there.
      $("#adminView").classList.toggle("on-global-tab", ["site", "tournaments", "accounts"].includes(n));
    },
  });
  saveTab = rememberTab("wgt:admintab", selectTab);

  wireConsole();
  wireOverview({
    open: (tid) => {
      $("#pickTournament").value = tid;
      openTournament(tid);
      selectTab("setup");
    },
    refresh: refreshIdentity,
  });
  wireAccounts({ getTournaments: () => myTournaments });
  wireSite({ toast });
  wirePlayers(() => ({ me, data, perms }));
  wireAuctionDesk(() => data);
  wireRosterPicker(() => data);
  await refreshIdentity();
  setInterval(tickClock, 500);
}

/* ------------------------------------------------------------------- auth */

function wireAuthForm() {
  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const button = $("#submitBtn");
    button.disabled = true;
    try {
      await auth.login($("#login").value.trim(), $("#password").value);
      $("#password").value = "";
      await refreshIdentity();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      button.disabled = false;
    }
  });

  $("#signOut").addEventListener("click", async () => {
    await auth.logout();
    stop?.();
    location.reload();
  });
}

/**
 * Who is signed in, and which tournament(s) they may work on.
 *
 * A super admin gets a picker over every tournament plus the Tournaments and
 * Accounts screens. Anybody else has exactly one tournament — the server only
 * ever tells them about that one — so it is shown by name and code, with
 * nothing to choose.
 */
async function refreshIdentity() {
  const payload = await auth.me().catch(() => ({ user: null, tournaments: [] }));
  me = payload.user;
  myTournaments = payload.tournaments ?? [];

  show($("#loginView"), !me);
  show($("#adminView"), Boolean(me));
  if (!me) return;

  $("#whoami").textContent = `${me.name || me.username}${me.isSuper ? " · super admin" : ""}`;

  const isSuper = me.isSuper;
  const picker = $("#pickTournament");
  const hasOne = myTournaments.length > 0;

  show($("#contextBar"), hasOne);
  show(picker, isSuper && hasOne);
  show($("#contextName"), !isSuper && hasOne);

  if (isSuper) {
    const current = picker.value;
    setHTML(
      picker,
      myTournaments
        .map((t) => `<option value="${e(t.id)}">${e(t.name)}${t.season ? ` ${e(t.season)}` : ""}</option>`)
        .join(""),
    );
    if (current && myTournaments.some((t) => t.id === current)) picker.value = current;
    if (!picker.dataset.wired) {
      picker.dataset.wired = "1";
      picker.addEventListener("change", () => openTournament(picker.value));
    }
  }

  show($("#tab-site"), isSuper);
  show($("#tab-tournaments"), isSuper);
  show($("#tab-accounts"), isSuper);
  show($("#noTournaments"), !hasOne && !isSuper);
  $("#noTournamentsWhy").textContent =
    "This account is not attached to a tournament. Ask the super admin to check it.";
  show($("#adminBody"), hasOne || isSuper);

  if (isSuper) {
    renderOverview();
    renderAccounts(myTournaments);
  }

  if (hasOne) {
    openTournament(isSuper ? picker.value || myTournaments[0].id : myTournaments[0].id);
  } else {
    // A super admin with no tournaments yet: only the two super-admin screens
    // make sense, so start on the one where the first tournament is created.
    data = null;
    stop?.();
    applyRole();
    selectTab("tournaments");
  }
}

/* ------------------------------------------------------------- tournament */

function openTournament(tid) {
  stop?.();
  stop = watchTournament(
    tid,
    (next, permissions) => {
      data = next;
      perms = permissions ?? perms;
      applyRole();
      renderAll();
    },
    (err) => toast(err.message, "err"),
  );
}

/**
 * Shape the console around this person's role.
 *
 * Note the banner: somebody who cannot do a thing is better served by being
 * told why than by the control quietly not existing. A referee who finds the
 * Auction tab missing assumes the site is broken; one who is told "referees run
 * match day" knows exactly where they stand.
 */
function applyRole() {
  const isSuper = Boolean(me?.isSuper);
  const loaded = Boolean(data);
  const manage = loaded && (perms.canManage || isSuper);
  const canRead = loaded && Boolean(perms.role);

  show($("#tab-setup"), canRead && perms.role !== "referee");
  const esports = D.isEsports(data);
  show($("#tab-auction"), canRead && perms.role !== "referee" && data?.format !== "friendly" && !esports);
  show($("#tab-live"), canRead);
  show($("#tab-settings"), canRead && perms.role !== "referee");
  show($("#tab-danger"), loaded && isSuper);
  show($("#tab-players"), isSuper || perms.role === "admin");

  if (loaded) {
    const current = myTournaments.find((t) => t.id === data.id);
    // A gaming tournament has no auction and no positions.
    show($("#pairsCard"), esports);
    show($("#teamsCard"), !esports);
    show($("#squadCard"), !esports);
    $("#contextName").textContent = data.name;
    $("#contextCode").textContent = data.code ?? current?.code ?? "";
  }

  // Finished: everything stays visible, nothing can be changed. The server
  // refuses the writes anyway; disabling the controls just says so up front.
  const readOnly = Boolean(perms.readOnly);
  show($("#readOnlyNote"), readOnly);
  for (const id of ["panel-setup", "panel-auction", "panel-live", "panel-settings"]) {
    $(`#${id}`).classList.toggle("is-readonly", readOnly);
    for (const el of $$(`#${id} input, #${id} select, #${id} button, #${id} textarea`)) {
      if (el.id === "liveMatch") continue; // choosing which match to look at is still fine
      el.disabled = readOnly;
    }
  }

  const note =
    perms.role === "referee"
      ? "You are the referee. You run match day — the clock, scores, goals and cards."
      : perms.role === "admin"
        ? "You are the tournament admin. You set up squads, run the auction and score matches."
        : "";
  show($("#roleNote"), Boolean(note) && !readOnly);
  $("#roleNote").textContent = note;

  // If the open tab is one this person cannot use, move them somewhere useful
  // rather than leaving them on a blank panel.
  const active = $$('[role="tab"]').find((t) => t.getAttribute("aria-selected") === "true");
  if (!active || active.hidden) {
    selectTab(!loaded ? "tournaments" : perms.role === "referee" ? "live" : manage || isSuper ? "setup" : "live");
  }
}

/* ---------------------------------------------------------------- rendering */

function renderAll() {
  renderTeams();
  renderPairs();
  renderPlayers();
  renderMatches();
  renderAuctionDesk();
  renderCaptainPicker();
  renderLive();
  renderSettings();
  $("#statusSelect").value = data.status;
  tournamentChanged();
  // Re-apply after re-rendering, so freshly drawn controls are disabled too.
  if (perms.readOnly) applyRole();
}

/**
 * What the import actually did.
 *
 * The two lists are the point of showing this at all. "Resolved by name" is
 * every event the old site stored with a name and no player id — the captain
 * goals that were missing from the statistics. "Could not match" is the short
 * list worth a human look. Nothing is ever silently dropped, and this is where
 * that promise is made good.
 */
function showImportReport(report) {
  const counts = Object.entries(report.counts)
    .map(([k, n]) => `<span class="pill">${e(k)} ${n}</span>`)
    .join(" ");

  const grouped = new Map();
  for (const r of report.resolvedByName) {
    const key = `${r.name} (${r.as})`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  setHTML(
    $("#importReport"),
    `<div class="hof__result" style="display:block">
       <p><b>Imported.</b> ${counts}</p>
       ${
         grouped.size
           ? `<p style="margin-top:10px"><b>Recovered ${report.resolvedByName.length} event(s)</b> that the old site
                stored as a name with no player id — these were the ones missing from the statistics tables:</p>
              <ul>${[...grouped].map(([who, n]) => `<li>${e(who)} — ${n} event(s)</li>`).join("")}</ul>`
           : `<p class="faint" style="margin-top:10px">No name-only events needed recovering.</p>`
       }
       ${
         report.medalPicks?.length
           ? `<p style="margin-top:10px"><b>Medals awarded by hand on the old site</b> — carried across, so the
                public card still says they were chosen rather than computed:</p>
              <ul>${report.medalPicks
                .map(
                  (m) =>
                    `<li>${e(m.label)} — ${e(m.who)}${m.kept ? "" : " <b>(not carried over — set it again under Settings)</b>"}</li>`,
                )
                .join("")}</ul>`
           : ""
       }
       ${
         report.unresolved.length
           ? `<p style="margin-top:10px"><b>Could not match ${report.unresolved.length}:</b></p>
              <ul>${report.unresolved.map((u) => `<li>"${e(u.name)}" at ${e(u.where)} — ${e(u.action)}</li>`).join("")}</ul>
              <p class="faint">Nothing was discarded. Rename these in the Setup tab if needed.</p>`
           : ""
       }
       ${report.warnings.length ? `<ul>${report.warnings.map((w) => `<li class="faint">${e(w)}</li>`).join("")}</ul>` : ""}
       <p class="faint" style="margin-top:10px">
         Check the standings, top scorers and medals against the old site before trusting this.
       </p>
     </div>`,
  );
}

const teamOptions = (selected, { blank = "— no team —" } = {}) =>
  `<option value="">${e(blank)}</option>` +
  D.teamsList(data)
    .map((t) => `<option value="${e(t.id)}"${t.id === selected ? " selected" : ""}>${e(t.name)}</option>`)
    .join("");

function renderTeams() {
  setHTML(
    $("#teamList"),
    D.teamsList(data)
      .map((t) => {
        const captain = D.teamCaptain(data, t.id);
        const squad = D.teamSquad(data, t.id);
        return `<div class="staff-row">
          <span class="jersey-dot" style="background:${e(t.jerseyColor || "#888")}"></span>
          <input class="input grow" data-team-name="${e(t.id)}" value="${e(t.name)}" maxlength="60" />
          <span class="faint">${captain ? `CAP ${e(captain.name)}` : "no captain"} · ${squad.length} bought</span>
          <button class="btn btn--sm btn--danger" data-team-del="${e(t.id)}" type="button">Remove</button>
        </div>`;
      })
      .join("") || `<p class="faint">No teams yet. Add the first one below.</p>`,
  );

  setHTML($("#newPlayerTeam"), teamOptions(null));
  setHTML(
    $("#newPlayerPos"),
    D.POSITIONS.map((p) => `<option value="${p}"${p === "MID" ? " selected" : ""}>${p}</option>`).join(""),
  );
}

/** The teams of a gaming tournament: a name, a group, and the two who play. */
function renderPairs() {
  if (!D.isEsports(data)) return;

  setHTML(
    $("#pairList"),
    D.teamsList(data)
      .map((t) => {
        const members = D.teamMembers(data, t.id);
        return `<div class="staff-row">
          ${t.group ? `<span class="pill pill--mint">Group ${e(t.group)}</span>` : ""}
          <input class="input grow" data-team-name="${e(t.id)}" value="${e(t.name)}" maxlength="60" />
          <span class="faint">${members.map((m) => e(m.name)).join(" &amp; ") || "nobody yet"}</span>
          <button class="btn btn--sm btn--danger" data-team-del="${e(t.id)}" type="button">Remove</button>
        </div>`;
      })
      .join("") || `<p class="faint">No teams yet. Add the first pair below.</p>`,
  );

  // Taken means "in a team", not "has ever been in one". Someone whose team was
  // removed is free again, and the server moves their existing row into the new
  // team rather than adding a second one.
  const taken = new Set(
    D.playersList(data)
      .filter((p) => p.teamId)
      .map((p) => p.personId)
      .filter(Boolean),
  );
  const options = (roster) => {
    const free = roster.filter((p) => !taken.has(p.id));
    // Say why the list is empty, rather than offering an empty dropdown.
    return (
      `<option value="">${
        free.length ? "— nobody —" : roster.length ? "— everybody is already in a team —" : "— nobody on the roster yet —"
      }</option>` +
      free
        .map((p) => `<option value="${e(p.id)}">${e(p.name)}${p.game?.gamerTag ? ` (${e(p.game.gamerTag)})` : ""}</option>`)
        .join("")
    );
  };

  // Shared with the roster picker, so a live update does not re-fetch everyone.
  loadRoster()
    .then((roster) => {
      for (const id of ["#newPairOne", "#newPairTwo"]) {
        const keep = $(id).value;
        setHTML($(id), options(roster));
        if (keep) $(id).value = keep;
      }
    })
    .catch(() => {});
}

function renderPlayers() {
  const rows = D.playersList(data).map((p) => {
    const badge =
      p.kind === "captain"
        ? `<span class="pill pill--gold">CAP</span>`
        : p.kind === "guest"
          ? `<span class="pill">Guest</span>`
          : `<span class="pill pill--mint">${e(D.bdt(p.price ?? 0))}</span>`;
    return `<div class="people-row">
      <span class="faint" style="min-width:34px">${e(p.pos)}</span>
      <span class="grow">${e(p.name)}</span>
      ${badge}
      <span class="faint">${e(D.teamById(data, p.teamId)?.name ?? "unsold")}</span>
      <button class="btn btn--sm btn--danger" data-player-del="${e(p.id)}" type="button">Remove</button>
    </div>`;
  });
  setHTML($("#playerList"), rows.join("") || `<p class="faint">No players yet.</p>`);
}

function renderMatches() {
  const groups = D.groupLabels(data);
  $("#fixtureHint").textContent =
    data.format === "friendly"
      ? "Friendlies have no table and no final — add matches as you arrange them."
      : groups.length
        ? `Everyone plays everyone inside their own group (${groups.join(", ")}), then the knockout rounds you choose. You pick who plays whom in those.`
        : "A round robin plays everyone once, then the knockout rounds you choose.";

  // Seeding is a suggestion, so it only appears once there is something to
  // suggest: the semi-finals after the groups, then the final after the semis.
  const semis = D.knockoutMatches(data).filter((m) => D.stageOf(m) === "semi");
  const final = D.finalMatch(data);
  const finalReady = Boolean(D.finalists(data)) && final && !final.homeId && !final.awayId;
  show($("#seedKnockout"), finalReady || (semis.length > 0 && D.groupStageComplete(data)));
  $("#seedKnockout").textContent = finalReady ? "Set the final from the semi-finals" : "Seed from the groups";

  // Come back to the shape this tournament was generated with.
  $("#knockoutChoice").value = D.getSettings(data).knockout ?? "final";

  setHTML(
    $("#matchList"),
    D.matchesList(data)
      .map((m) => {
        const { homeLabel, awayLabel } = D.matchSides(data, m);
        const stage = D.stageOf(m);
        const teamOptions = (selectedId) =>
          `<option value="">— to be decided —</option>` +
          D.teamsList(data)
            .map((t) => `<option value="${e(t.id)}"${t.id === selectedId ? " selected" : ""}>${e(t.name)}</option>`)
            .join("");

        // A knockout match names its two sides, and the admin chooses them.
        const sides =
          stage === "group"
            ? `<span class="grow">${e(homeLabel)} v ${e(awayLabel)}</span>`
            : `<span class="grow row">
                 <select class="input input--sm" data-match-side="home" data-match="${e(m.id)}">${teamOptions(m.homeId)}</select>
                 <span class="faint">v</span>
                 <select class="input input--sm" data-match-side="away" data-match="${e(m.id)}">${teamOptions(m.awayId)}</select>
               </span>`;

        // Clearing wipes a result, so it has nothing to do on a fixture nobody
        // has played yet — and a button that reports success while changing
        // nothing reads as a bug. Removing the fixture is the other thing an
        // admin wants in that spot, so it is always there.
        const hasResult = m.status !== "scheduled" || m.homeScore != null || m.awayScore != null;

        return `<div class="staff-row">
          <span class="faint" style="min-width:28px">${m.no}</span>
          ${stage === "group" ? "" : `<span class="pill pill--gold">${e(D.STAGE_LABEL[stage])}</span>`}
          ${sides}
          <span class="pill">${e(D.STATUS_LABEL[m.status] ?? m.status)}</span>
          <span class="faint">${D.scoreLine(m) || "– : –"}</span>
          ${hasResult ? `<button class="btn btn--sm btn--ghost" data-match-clear="${e(m.id)}" type="button">Clear</button>` : ""}
          <button class="btn btn--sm btn--danger" data-match-del="${e(m.id)}" type="button">Remove</button>
        </div>`;
      })
      .join("") || `<p class="faint">No fixtures yet.</p>`,
  );
}

function renderLive() {
  const matches = D.matchesList(data);
  if (!matches.length) {
    setHTML($("#console"), `<p class="faint">No fixtures yet.</p>`);
    return setHTML($("#liveEvents"), "");
  }

  liveMatchId = matches.some((m) => m.id === liveMatchId)
    ? liveMatchId
    : (matches.find((m) => m.status === "live") ?? matches.find((m) => m.status !== "ft") ?? matches[0]).id;

  setHTML(
    $("#liveMatch"),
    matches
      .map(
        (m) =>
          `<option value="${e(m.id)}"${m.id === liveMatchId ? " selected" : ""}>Match ${m.no} — ${e(D.matchSides(data, m).homeLabel)} v ${e(D.matchSides(data, m).awayLabel)}</option>`,
      )
      .join(""),
  );

  const match = D.matchById(data, liveMatchId);
  const { home, away, homeLabel, awayLabel } = D.matchSides(data, match);
  const state = D.clockState(match, serverNow());
  const suspended = D.suspendedFor(data, match.id);

  const esports = D.isEsports(data);
  const knockout = D.isKnockout(match);
  const level = match.homeScore != null && match.homeScore === match.awayScore;

  const actionTypes = esports
    ? D.GAMING_ACTION_TYPES
    : ["goal", "save", "clearance", "shot", "chance", "foul", "yellow", "red"];
  const actionsFor = (team, label) => {
    if (!team) return `<p class="faint">${e(label)} is not decided yet.</p>`;
    const tally = D.disciplineTally(data, match, team.id);
    return `<div class="card">
      <h3 class="card__title">${e(team.name)}</h3>
      <div class="card-buttons">
        ${actionTypes
          .map(
            (type) =>
              `<button class="btn ${type === "goal" ? "btn--primary" : "btn--ghost"} btn--sm"
                 data-log="${type}" data-team="${e(team.id)}" type="button">
                 ${D.ACTION_ICON[type]} ${e(D.ACTION_LABEL[type])}</button>`,
          )
          .join("")}
      </div>
      ${esports ? "" : `<p class="faint">Fouls ${tally.foul} · 🟨 ${tally.yellow} · 🟥 ${tally.red}</p>`}
    </div>`;
  };

  setHTML(
    $("#console"),
    `<div class="card">
       <div class="row spread">
         <b>${e(homeLabel)}</b>
         <span style="font-size:2rem;font-family:var(--font-display)">${match.homeScore ?? 0} – ${match.awayScore ?? 0}</span>
         <b>${e(awayLabel)}</b>
       </div>
       <p class="row spread">
         <span class="pill">${e(state.label)}</span>
         <span data-clock="${e(match.id)}" style="font-variant-numeric:tabular-nums">00:00</span>
       </p>
       <div class="card-buttons">
         <button class="btn btn--primary" id="clockStart" type="button">${state.running ? "Pause" : "Start"}</button>
         <button class="btn btn--ghost" id="clockNext" type="button">Next period</button>
         <button class="btn btn--ghost" id="matchFT" type="button">Full time</button>
       </div>
       ${
         esports
           ? `<p class="faint score-entry__hint">The score, as it stands. It saves as you type and shows on the public page straight away.</p>
              <div class="score-entry">
                <label class="field"><span>${e(homeLabel)}</span>
                  <input class="input input--score" type="number" min="0" placeholder="0" inputmode="numeric" data-score="home" value="${match.homeScore ?? ""}" /></label>
                <label class="field"><span>${e(awayLabel)}</span>
                  <input class="input input--score" type="number" min="0" placeholder="0" inputmode="numeric" data-score="away" value="${match.awayScore ?? ""}" /></label>
              </div>`
           : ""
       }
       ${
         knockout && level
           ? `<div class="score-entry score-entry--pens">
                <p class="faint">A knockout match cannot end level. Record the shoot-out.</p>
                <label class="field"><span>${e(homeLabel)} penalties</span>
                  <input class="input input--score" type="number" min="0" inputmode="numeric" data-pens="home" placeholder="0" value="${match.homePens ?? ""}" /></label>
                <label class="field"><span>${e(awayLabel)} penalties</span>
                  <input class="input input--score" type="number" min="0" inputmode="numeric" data-pens="away" placeholder="0" value="${match.awayPens ?? ""}" /></label>
              </div>`
           : ""
       }
       ${
         suspended.size
           ? `<p class="faint">⚠ Suspended for this match: ${[...suspended.values()]
               .map((s) => e(s.player.name))
               .join(", ")}</p>`
           : ""
       }
     </div>
     <div class="cols-2">${actionsFor(home, homeLabel)}${actionsFor(away, awayLabel)}</div>`,
  );


  setHTML(
    $("#liveEvents"),
    D.matchEvents(match)
      .slice()
      .reverse()
      .map((ev) => {
        const who = D.playerById(data, ev.playerId);
        return `<div class="people-row">
          <span>${D.ACTION_ICON[ev.type] ?? "•"}</span>
          <span class="grow">${e(D.ACTION_LABEL[ev.type] ?? ev.type)} — ${e(who?.name ?? "not recorded")}</span>
          <span class="faint">${e(ev.clockLabel ?? "")}</span>
          <button class="btn btn--sm btn--danger" data-ev-del="${e(ev.id)}" type="button">Remove</button>
        </div>`;
      })
      .join("") || `<p class="faint">Nothing logged yet.</p>`,
  );
}

function renderSettings() {
  const s = D.getSettings(data);
  const meta = D.getMeta(data);

  const field = (id, label, value, type = "text") =>
    `<label class="field"><span>${e(label)}</span>
       <input class="input" data-setting="${e(id)}" type="${type}" value="${e(value ?? "")}" /></label>`;

  $("#detailsCode").textContent = data.code ?? "";
  // Season as a month and a year ("September 2026"). A season written some other
  // way before this existed is kept, and shown, until someone picks a month or year.
  const seasonDetail = (season) => {
    const { month, year } = D.parseSeason(season);
    const custom = season && !year ? `<small class="faint">Currently “${e(season)}”</small>` : "";
    return `<div class="field"><span>Season</span>
      <span class="season-pick">
        <select class="input" data-season-part="month" aria-label="Month">
          <option value="">No month</option>
          ${D.MONTHS.map((m, i) => `<option value="${i + 1}"${month === i + 1 ? " selected" : ""}>${m}</option>`).join("")}
        </select>
        <input class="input" data-season-part="year" type="number" inputmode="numeric" min="2000" max="2100" placeholder="Year" value="${year ?? ""}" aria-label="Year" />
      </span>${custom}</div>`;
  };
  const detail = (key, label, value, type = "text", extra = "") =>
    `<label class="field"><span>${e(label)}</span>
       <input class="input" data-detail="${e(key)}" type="${type}" value="${e(value ?? "")}" ${extra} /></label>`;
  setHTML(
    $("#detailsGrid"),
    [
      detail("name", "Name", data.name, "text", 'maxlength="80" required'),
      seasonDetail(data.season),
      detail("startsOn", "Start date (leave empty if not decided)", data.startsOn, "date"),
    ].join(""),
  );

  setHTML(
    $("#metaGrid"),
    [
      field("meta.venueName", "Venue", meta.venueName),
      field("meta.dateLabel", "Date shown on the site", meta.dateLabel),
      field("meta.timeLabel", "Time", meta.timeLabel),
      field("meta.kickoffISO", "Kick-off (ISO, drives the countdown)", meta.kickoffISO),
      field("meta.mapUrl", "Map link", meta.mapUrl),
    ].join(""),
  );

  setHTML(
    $("#auctionSettings"),
    [
      field("budget", "Budget per team", s.budget, "number"),
      field("basePrice", "Base price", s.basePrice, "number"),
      field("squadSize", "Squad size", s.squadSize, "number"),
      field("minPerCategory", "Minimum per position", s.minPerCategory, "number"),
      field("maxPerCategory", "Maximum per position", s.maxPerCategory, "number"),
      field("maxGK", "Maximum goalkeepers", s.maxGK, "number"),
      field("halfSeconds", "Half length (seconds)", s.halfSeconds, "number"),
      field("redCardSuspensionMatches", "Matches missed after a red card", s.redCardSuspensionMatches, "number"),
    ].join(""),
  );

  const points = D.getPoints(data);
  setHTML(
    $("#pointsGrid"),
    D.POINT_FIELDS.map(([k, label]) => field(`points.${k}`, label, points[k], "number")).join(""),
  );

  const ledger = D.playerStats(data);
  setHTML(
    $("#medalGrid"),
    D.MEDALS.map(
      ([key, label, icon, setting]) => `<label class="field"><span>${icon} ${e(label)}</span>
        <select class="input" data-setting="${e(setting)}">
          <option value="">— computed from the points table —</option>
          ${ledger
            .map((r) => `<option value="${e(r.playerId)}"${s[setting] === r.playerId ? " selected" : ""}>${e(r.player.name)}</option>`)
            .join("")}
        </select></label>`,
    ).join("") +
      D.TEAM_MEDALS.map(
        ([key, label, icon, setting]) => `<label class="field"><span>${icon} ${e(label)}</span>
          <select class="input" data-setting="${e(setting)}">
            <option value="">— computed —</option>
            ${D.teamsList(data)
              .map((t) => `<option value="${e(t.id)}"${s[setting] === t.id ? " selected" : ""}>${e(t.name)}</option>`)
              .join("")}
          </select></label>`,
      ).join(""),
  );
}

/* ------------------------------------------------------------------ events */

/** One delegated handler for the whole console, so re-rendering never unbinds. */
function wireConsole() {
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;

    const run = async (fn, okMessage) => {
      try {
        await fn();
        if (okMessage) toast(okMessage);
      } catch (err) {
        toast(err.message, "err");
      }
    };

    // Everything below acts on the open tournament.
    if (!data) return;

    // --- setup
    if (t.id === "addPair") {
      const name = $("#newPairName").value.trim();
      if (!name) return toast("Give the team a name.", "err");
      const memberIds = [$("#newPairOne").value, $("#newPairTwo").value].filter(Boolean);
      if (!memberIds.length) return toast("Pick at least one player for the team.", "err");
      return run(async () => {
        await tournaments.addPair(data.id, { name, group: $("#newPairGroup").value || null, memberIds });
        $("#newPairName").value = "";
        $("#newPairOne").value = "";
        $("#newPairTwo").value = "";
      }, `${name} added.`);
    }

    if (t.id === "seedKnockout") {
      const semis = D.knockoutMatches(data).filter((m) => D.stageOf(m) === "semi");
      const final = D.finalMatch(data);
      const blank = (m) => m && !m.homeId && !m.awayId;

      // Once the semis are won, the obvious thing to fill in is the final.
      const pair = D.finalists(data);
      if (pair && blank(final)) {
        const name = (id) => D.teamById(data, id)?.name ?? "";
        if (!confirm(`Set the final to ${name(pair.homeId)} v ${name(pair.awayId)}?`)) return;
        return run(() => tournaments.updateMatch(data.id, final.id, pair), "Final set from the semi-finals.");
      }

      const seeds = D.seedKnockout(data);
      if (!seeds.length) return toast("Finish the group matches first.", "err");
      if (!confirm(`Set the semi-finals to ${seeds.map((x) => `${x.homeLabel} v ${x.awayLabel}`).join(" and ")}?`)) return;
      return run(async () => {
        for (const [i, semi] of semis.entries()) {
          if (!seeds[i]) break;
          await tournaments.updateMatch(data.id, semi.id, { homeId: seeds[i].homeId, awayId: seeds[i].awayId });
        }
      }, "Semi-finals seeded. Change them if you want a different pairing.");
    }

    if (t.id === "addTeam") {
      const name = $("#newTeamName").value.trim();
      if (!name) return toast("Give the team a name.", "err");
      return run(async () => {
        await tournaments.addTeam(data.id, {
          name,
          captainPersonId: $("#newCaptainPerson").value || undefined,
          captainName: $("#newCaptainName").value.trim(),
        });
        $("#newTeamName").value = "";
        $("#newCaptainName").value = "";
        $("#newCaptainPerson").value = "";
      }, `${name} added.`);
    }
    if (t.dataset.teamDel) {
      if (!confirm("Remove this team? Its bought players go back to the pool.")) return;
      return run(() => tournaments.removeTeam(data.id, t.dataset.teamDel), "Team removed.");
    }
    if (t.id === "addPlayer") {
      const name = $("#newPlayerName").value.trim();
      return run(async () => {
        await tournaments.addPlayer(data.id, {
          name,
          pos: $("#newPlayerPos").value,
          kind: $("#newPlayerKind").value,
          teamId: $("#newPlayerTeam").value || null,
        });
        $("#newPlayerName").value = "";
        $("#newPlayerName").focus();
      }, `${name} added.`);
    }
    if (t.dataset.playerDel) {
      return run(() => tournaments.removePlayer(data.id, t.dataset.playerDel), "Player removed.");
    }
    if (t.id === "generateFixtures") {
      const knockout = $("#knockoutChoice").value;
      const groups = D.groupLabels(data);
      const how = groups.length ? `a round robin inside ${D.plural(groups.length, "group")}` : "a round robin";
      if (!confirm(`Generate ${how}${knockout === "none" ? "" : knockout === "semis" ? ", semi-finals and a final" : " and a final"}? Existing fixtures are replaced.`)) return;
      return run(() => tournaments.generateFixtures(data.id, { knockout }), "Fixtures generated.");
    }
    if (t.id === "addMatch") return run(() => tournaments.addMatch(data.id, {}), "Match added.");
    if (t.dataset.matchClear) {
      if (!confirm("Clear this match back to unplayed, log and all?")) return;
      return run(() => tournaments.clearMatch(data.id, t.dataset.matchClear), "Match cleared.");
    }
    if (t.dataset.matchDel) {
      const match = D.matchById(data, t.dataset.matchDel);
      const { homeLabel, awayLabel } = D.matchSides(data, match);
      const what = match?.isFinal ? "the final" : `match ${match?.no}`;
      if (!confirm(`Remove ${what} — ${homeLabel} v ${awayLabel} — from the fixture list? Its score and log go with it.`)) return;
      return run(() => tournaments.removeMatch(data.id, t.dataset.matchDel), "Match removed.");
    }

    // --- auction
    if (t.id === "sellBtn") {
      try {
        toast(await sellOnBlock());
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    if (t.dataset.unsell) {
      return run(() => tournaments.unsell(data.id, t.dataset.unsell), "Returned to the pool.");
    }

    // --- match day
    if (t.dataset.log) {
      const type = t.dataset.log;
      const teamId = t.dataset.team;
      const match = D.matchById(data, liveMatchId);
      const roster = D.teamPlayers(data, teamId);

      const who = await pickPlayer(roster, `${D.ACTION_LABEL[type]} — who?`);
      if (who === undefined) return; // cancelled

      // The one moment the second-yellow warning is any use is before it is
      // logged. It warns; the referee decides.
      if (who && D.cardWouldSendOff(match, who, type)) {
        const name = D.playerById(data, who)?.name;
        if (!confirm(`${name} already has a yellow. A second one is a sending off. Log it?`)) return;
      }

      return run(
        () => tournaments.addEvent(data.id, liveMatchId, { type, teamId, playerId: who || null }),
        `${D.ACTION_LABEL[type]} logged.`,
      );
    }
    if (t.dataset.evDel) {
      return run(() => tournaments.removeEvent(data.id, liveMatchId, t.dataset.evDel), "Removed.");
    }
    if (t.id === "clockStart") {
      const match = D.matchById(data, liveMatchId);
      const state = D.clockState(match, serverNow());
      const clock = state.running
        ? { ...match.clock, running: false, elapsed: state.elapsed, startedAt: null }
        : {
            ...match.clock,
            period: state.period === "pre" ? "h1" : state.period,
            running: true,
            startedAt: serverNow(),
          };
      return run(
        () => tournaments.updateMatch(data.id, liveMatchId, { clock, status: "live" }),
        state.running ? "Paused." : "Started.",
      );
    }
    if (t.id === "clockNext") {
      const match = D.matchById(data, liveMatchId);
      const state = D.clockState(match, serverNow());
      return run(
        () =>
          tournaments.updateMatch(data.id, liveMatchId, {
            clock: D.freshClock(D.nextPeriod(state.period)),
          }),
        "Next period.",
      );
    }
    if (t.id === "matchFT") {
      if (!confirm("Mark this match full time?")) return;
      return run(
        () => tournaments.updateMatch(data.id, liveMatchId, { status: "ft", clock: D.freshClock("ft") }),
        "Full time.",
      );
    }

    // --- import and export
    if (t.id === "exportBtn") {
      // A plain navigation, so the browser handles the save dialog and the
      // filename from Content-Disposition rather than us building a blob.
      location.href = transfer.exportUrl(data.id);
      return;
    }
    if (t.id === "importBtn") {
      const file = $("#importFile").files?.[0];
      if (!file) return toast("Choose a backup file first.", "err");

      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        return toast("That file is not valid JSON. Is it the backup you downloaded?", "err");
      }

      setHTML($("#importReport"), `<p class="faint">Importing…</p>`);
      try {
        const { report } = await transfer.firebase(backup, { status: $("#importStatus").value });
        showImportReport(report);
        toast("Imported.");
        await refreshIdentity();
        $("#pickTournament").value = report.tournamentId;
        openTournament(report.tournamentId);
      } catch (err) {
        setHTML($("#importReport"), `<p class="faint err">${e(err.message)}</p>`);
        toast(err.message, "err");
      }
      return;
    }

    // --- danger
    if (t.id === "completeBtn") {
      if (!confirm("Mark this tournament finished and add it to the Hall of Fame?")) return;
      return run(() => tournaments.update(data.id, { status: "completed" }), "Finished and archived.");
    }
    if (t.id === "reopenBtn") {
      return run(() => tournaments.update(data.id, { status: "active" }), "Reopened.");
    }
    if (t.id === "recomputeBtn") {
      return run(() => tournaments.recomputeArchive(data.id), "Hall of Fame entry recomputed.");
    }
    if (t.id === "clearScores") {
      if (!confirmPhrase("Clear every score and match log. Type CLEAR to confirm.", "CLEAR")) return;
      return run(() => tournaments.clearAllScores(data.id), "Scores cleared.");
    }
    if (t.id === "resetAuction") {
      if (!confirmPhrase("Return every player to the pool. Type RESET to confirm.", "RESET")) return;
      return run(() => tournaments.resetAuction(data.id), "Auction reset.");
    }
    if (t.id === "deleteTournament") {
      if (!confirmPhrase(`Delete "${data.name}" and everything in it. Type DELETE to confirm.`, "DELETE")) return;
      return run(async () => {
        await tournaments.remove(data.id);
        location.reload();
      });
    }
  });

  // Name, season and start date — the tournament's own admin may change these.
  $("#detailsGrid").addEventListener("change", async (ev) => {
    const part = ev.target.closest("[data-season-part]");
    if (part && data) {
      const month = $('#detailsGrid [data-season-part="month"]').value;
      const year = $('#detailsGrid [data-season-part="year"]').value.trim();
      if (month && !/^\d{4}$/.test(year)) return toast("Add the year as well — for example September 2026.", "err");
      try {
        await tournaments.update(data.id, { season: D.seasonLabel(month, year) });
        toast("Saved.");
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }

    const el = ev.target.closest("[data-detail]");
    if (!el || !data) return;
    const key = el.dataset.detail;
    const value = el.value.trim();
    if (key === "name" && !value) {
      el.value = data.name;
      return toast("A tournament needs a name.", "err");
    }
    try {
      await tournaments.update(data.id, { [key]: value || null });
      toast(key === "name" ? "Renamed. The code stays the same." : "Saved.");
      if (key === "name") await refreshIdentity();
    } catch (err) {
      el.value = data[key] ?? "";
      toast(err.message, "err");
    }
  });

  // Settings save on blur — one write per field, no Save button to forget.
  document.addEventListener(
    "change",
    async (ev) => {
      const el = ev.target.closest("[data-setting]");
      if (!el || !data) return;

      const key = el.dataset.setting;
      const raw = el.value;
      const value = el.type === "number" ? Number(raw) : raw;

      try {
        if (key.startsWith("meta.")) {
          await tournaments.meta(data.id, { [key.slice(5)]: value });
        } else if (key.startsWith("points.")) {
          await tournaments.settings(data.id, { points: { [key.slice(7)]: value } });
        } else {
          await tournaments.settings(data.id, { [key]: value === "" ? null : value });
        }
        toast("Saved.");
      } catch (err) {
        toast(err.message, "err");
      }
    },
    true,
  );

  $("#liveMatch").addEventListener("change", (ev) => {
    liveMatchId = ev.target.value;
    renderLive();
  });

  $("#statusSelect").addEventListener("change", async (ev) => {
    const status = ev.target.value;
    try {
      await tournaments.update(data.id, { status });
      toast(
        status === "active"
          ? "Published on the public site."
          : status === "completed"
            ? "Finished, locked, and added to the Hall of Fame."
            : "Hidden from the public.",
      );
      await refreshIdentity();
    } catch (err) {
      ev.target.value = data.status; // put the control back where it was
      toast(err.message, "err");
    }
  });

  // Who plays in a knockout round, chosen by the admin on the fixture list.
  $("#matchList").addEventListener("change", async (ev) => {
    const el = ev.target.closest("[data-match-side]");
    if (!el || !data) return;
    try {
      await tournaments.updateMatch(data.id, el.dataset.match, {
        [el.dataset.matchSide === "home" ? "homeId" : "awayId"]: el.value || null,
      });
      toast("Fixture set.");
    } catch (err) {
      toast(err.message, "err");
    }
  });

  // The score and the shoot-out on a gaming match day.
  $("#console").addEventListener("change", async (ev) => {
    const el = ev.target.closest("[data-score], [data-pens]");
    if (!el || !data) return;
    const value = el.value === "" ? null : Number(el.value);
    const key = el.dataset.score
      ? el.dataset.score === "home"
        ? "homeScore"
        : "awayScore"
      : el.dataset.pens === "home"
        ? "homePens"
        : "awayPens";
    try {
      await tournaments.updateMatch(data.id, liveMatchId, { [key]: value });
      toast("Saved.");
    } catch (err) {
      toast(err.message, "err");
    }
  });

  for (const id of ["#teamList", "#pairList"]) {
    $(id).addEventListener("change", renameTeam);
  }

  async function renameTeam(ev) {
    const el = ev.target.closest("[data-team-name]");
    if (!el) return;
    try {
      await tournaments.updateTeam(data.id, el.dataset.teamName, { name: el.value.trim() });
      toast("Renamed.");
    } catch (err) {
      toast(err.message, "err");
    }
  }
}

/**
 * Ask who did it — a sheet of big tappable names.
 *
 * This replaced a `prompt()` that asked the referee to type a number from a
 * list. That works at a desk and is miserable on a phone at the touchline in
 * the dark, which is the only place it is ever used.
 *
 * Resolves to a player id, `null` for "not recorded", or `undefined` if
 * cancelled. "Not recorded" is deliberately a first-class button: the scoreline
 * must never be held hostage to remembering a name, and the scorer can be
 * attached afterwards from the match log.
 */
function pickPlayer(roster, question) {
  return new Promise((resolve) => {
    if (!roster.length) return resolve(null);

    const sheet = document.createElement("div");
    sheet.className = "picker";
    sheet.innerHTML = `
      <div class="picker__panel" role="dialog" aria-modal="true" aria-label="${e(question)}">
        <h3 class="picker__title">${e(question)}</h3>
        <div class="picker__grid">
          ${roster
            .map(
              (p) => `<button class="btn btn--ghost picker__name" data-pick="${e(p.id)}" type="button">
                        <b>${e(p.name)}</b><span class="faint">${e(p.pos)}${p.kind === "captain" ? " · captain" : ""}${p.kind === "guest" ? " · guest" : ""}</span>
                      </button>`,
            )
            .join("")}
        </div>
        <div class="picker__foot">
          <button class="btn btn--ghost" data-pick="" type="button">Not recorded</button>
          <button class="btn btn--ghost" data-cancel type="button">Cancel</button>
        </div>
      </div>`;

    const close = (value) => {
      sheet.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") close(undefined);
    };

    sheet.addEventListener("click", (ev) => {
      // Tapping the backdrop cancels, which is what every sheet on a phone does.
      if (ev.target === sheet || ev.target.closest("[data-cancel]")) return close(undefined);
      const btn = ev.target.closest("[data-pick]");
      if (btn) close(btn.dataset.pick || null);
    });

    document.addEventListener("keydown", onKey);
    document.body.appendChild(sheet);
    sheet.querySelector("button")?.focus();
  });
}

/** Only the clock digits repaint each tick — never the whole console. */
function tickClock() {
  if (!data) return;
  for (const el of document.querySelectorAll("[data-clock]")) {
    const match = D.matchById(data, el.dataset.clock);
    if (!match) continue;
    const state = D.clockState(match, serverNow());
    const { main, extra } = D.formatClock(state.elapsed, D.periodLength(data, state.period));
    el.textContent = extra ? `${main} ${extra}` : main;
  }
}
