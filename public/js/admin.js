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
import { $, $$, confirmPhrase, rememberTab, setHTML, show, toast, wireTabs } from "./ui.js";
import { auth, serverNow, syncClock, tournaments, transfer, users, watchTournament } from "./api.js";

const e = D.escapeHtml;

let me = null;
let myTournaments = [];
let data = null;
let perms = { role: null, canScore: false, canManage: false };
let stop = null;
let selectTab = () => {};
let liveMatchId = null;
let mode = "login";

boot();

async function boot() {
  await syncClock();
  wireAuthForm();

  let saveTab = () => {};
  selectTab = wireTabs($("#tabs"), { onChange: (n) => saveTab(n) });
  saveTab = rememberTab("wgt:admintab", selectTab);

  wireConsole();
  await refreshIdentity();
  setInterval(tickClock, 500);
}

/* ------------------------------------------------------------------- auth */

function wireAuthForm() {
  $("#switchMode").addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    const registering = mode === "register";
    $("#authTitle").textContent = registering ? "Create an account" : "Sign in";
    $("#submitBtn").textContent = registering ? "Create account" : "Sign in";
    $("#switchPrompt").textContent = registering ? "Already have one?" : "New here?";
    $("#switchMode").textContent = registering ? "Sign in instead" : "Create an account";
    show($("#nameField"), registering);
    $("#password").autocomplete = registering ? "new-password" : "current-password";
  });

  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("#email").value.trim();
    const password = $("#password").value;
    try {
      if (mode === "register") {
        await auth.register($("#name").value.trim(), email, password);
      } else {
        await auth.login(email, password);
      }
      $("#password").value = "";
      await refreshIdentity();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  for (const btn of [$("#signOut"), $("#pendingSignOut")]) {
    btn.addEventListener("click", async () => {
      await auth.logout();
      stop?.();
      location.reload();
    });
  }
}

async function refreshIdentity() {
  const payload = await auth.me().catch(() => ({ user: null, tournaments: [] }));
  me = payload.user;
  myTournaments = payload.tournaments ?? [];

  show($("#loginView"), !me);
  show($("#pendingView"), Boolean(me) && me.status === "pending" && !me.isSuper);
  show($("#adminView"), Boolean(me) && (me.status === "active" || me.isSuper));

  if (!me) return;
  $("#pendingWho").textContent = `Signed in as ${me.email}`;
  if (me.status === "pending" && !me.isSuper) return;

  $("#whoami").textContent = `${me.name || me.email}${me.isSuper ? " · super admin" : ""}`;
  show($("#createCard"), me.isSuper);

  const picker = $("#pickTournament");
  setHTML(
    picker,
    myTournaments
      .map((t) => `<option value="${e(t.id)}">${e(t.name)}${t.season ? ` ${e(t.season)}` : ""} — ${e(t.status)}</option>`)
      .join(""),
  );
  show(picker, myTournaments.length > 0);

  show($("#noTournaments"), myTournaments.length === 0);
  $("#noTournamentsWhy").textContent = me.isSuper
    ? "Create one below to get started."
    : "You have not been assigned to a tournament yet. An organiser needs to add you.";
  show($("#adminBody"), myTournaments.length > 0);

  if (!picker.dataset.wired) {
    picker.dataset.wired = "1";
    picker.addEventListener("change", () => openTournament(picker.value));
  }
  if (myTournaments.length) openTournament(picker.value || myTournaments[0].id);
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
  const manage = perms.canManage || me?.isSuper;
  const superOnly = Boolean(me?.isSuper);

  show($("#tab-setup"), manage);
  show($("#tab-auction"), manage && data.format !== "friendly");
  show($("#tab-live"), perms.canScore || manage);
  show($("#tab-settings"), manage);
  show($("#tab-people"), superOnly);
  show($("#tab-danger"), superOnly);

  const note =
    perms.role === "referee"
      ? "You are the referee on this tournament. You can run match day — the clock, scores, goals and cards. Squads, the auction and settings belong to the tournament admin."
      : perms.role === "admin"
        ? "You are the tournament admin. You can set up squads, run the auction and score matches. Only the super admin can create tournaments or assign staff."
        : "";
  show($("#roleNote"), Boolean(note));
  $("#roleNote").textContent = note;

  // If the open tab is one this person cannot use, move them somewhere useful
  // rather than leaving them on a blank panel.
  const active = $$('[role="tab"]').find((t) => t.getAttribute("aria-selected") === "true");
  if (active?.hidden) selectTab(perms.canScore ? "live" : "setup");
}

/* ---------------------------------------------------------------- rendering */

function renderAll() {
  renderTeams();
  renderPlayers();
  renderMatches();
  renderAuction();
  renderLive();
  renderSettings();
  $("#statusSelect").value = data.status;
  if (me?.isSuper) renderPeople();
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
  $("#fixtureHint").textContent =
    data.format === "friendly"
      ? "Friendlies have no table and no final — add matches as you arrange them."
      : "A round robin plays everyone once, then a final between the top two.";

  setHTML(
    $("#matchList"),
    D.matchesList(data)
      .map((m) => {
        const { homeLabel, awayLabel } = D.matchSides(data, m);
        return `<div class="staff-row">
          <span class="faint" style="min-width:28px">${m.no}</span>
          <span class="grow">${e(homeLabel)} v ${e(awayLabel)}${m.isFinal ? " (final)" : ""}</span>
          <span class="pill">${e(D.STATUS_LABEL[m.status] ?? m.status)}</span>
          <span class="faint">${m.homeScore ?? "–"} : ${m.awayScore ?? "–"}</span>
          <button class="btn btn--sm btn--ghost" data-match-clear="${e(m.id)}" type="button">Clear</button>
        </div>`;
      })
      .join("") || `<p class="faint">No fixtures yet.</p>`,
  );
}

function renderAuction() {
  const state = D.auctionState(data);
  const unsold = D.unsoldPlayers(data);

  setHTML(
    $("#sellPlayer"),
    `<option value="">— pick a player —</option>` +
      unsold.map((p) => `<option value="${e(p.id)}">${e(p.pos)} · ${e(p.name)}</option>`).join(""),
  );
  setHTML($("#sellTeam"), teamOptions(null, { blank: "— pick a team —" }));
  $("#sellPrice").placeholder = String(D.getSettings(data).basePrice);

  setHTML(
    $("#captainGrid"),
    D.teamsList(data)
      .map((t) => {
        const st = state[t.id];
        if (!st) return "";
        const chips = D.POSITIONS.map((pos) => `${pos} ${st.counts[pos]}/${st.max[pos]}`).join(" · ");
        return `<div class="staff-row">
          <b class="grow">${e(t.name)}</b>
          <span class="pill pill--mint">${e(D.bdt(st.remaining))} left</span>
          <span class="faint">${st.squad.length}/${st.squadSize} · ${e(chips)}</span>
          <span class="faint">max bid ${e(D.bdt(st.maxBid))}</span>
        </div>`;
      })
      .join("") || `<p class="faint">Add teams first.</p>`,
  );

  setHTML(
    $("#poolList"),
    D.auctionPlayers(data)
      .map(
        (p) => `<div class="people-row">
          <span class="faint" style="min-width:34px">${e(p.pos)}</span>
          <span class="grow">${e(p.name)}</span>
          ${
            p.teamId
              ? `<span class="pill pill--mint">${e(D.teamById(data, p.teamId)?.name)} · ${e(D.bdt(p.price))}</span>
                 <button class="btn btn--sm btn--ghost" data-unsell="${e(p.id)}" type="button">Unsell</button>`
              : `<span class="pill">Available</span>`
          }
        </div>`,
      )
      .join("") || `<p class="faint">No auction pool.</p>`,
  );

  // Live feedback as the price is typed, using the same validator the server
  // will run — so the message you see is the message you would have got.
  const hint = () => {
    const playerId = $("#sellPlayer").value;
    const teamId = $("#sellTeam").value;
    const price = Number($("#sellPrice").value);
    if (!playerId || !teamId || !$("#sellPrice").value) return ($("#sellHint").textContent = "");
    const res = D.validateSale(data, playerId, teamId, price);
    $("#sellHint").textContent = res.ok ? "Looks good." : res.error;
    $("#sellHint").className = res.ok ? "faint" : "faint err";
  };
  for (const id of ["#sellPlayer", "#sellTeam", "#sellPrice"]) {
    const el = $(id);
    if (!el.dataset.hinted) {
      el.dataset.hinted = "1";
      el.addEventListener("input", hint);
      el.addEventListener("change", hint);
    }
  }
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

  const actionsFor = (team, label) => {
    if (!team) return `<p class="faint">${e(label)} is not decided yet.</p>`;
    const tally = D.disciplineTally(data, match, team.id);
    return `<div class="card">
      <h3 class="card__title">${e(team.name)}</h3>
      <div class="card-buttons">
        ${["goal", "save", "clearance", "shot", "chance", "foul", "yellow", "red"]
          .map(
            (type) =>
              `<button class="btn ${type === "goal" ? "btn--primary" : "btn--ghost"} btn--sm"
                 data-log="${type}" data-team="${e(team.id)}" type="button">
                 ${D.ACTION_ICON[type]} ${e(D.ACTION_LABEL[type])}</button>`,
          )
          .join("")}
      </div>
      <p class="faint">Fouls ${tally.foul} · 🟨 ${tally.yellow} · 🟥 ${tally.red}</p>
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

async function renderPeople() {
  try {
    const [{ staff }, { users: all }] = await Promise.all([tournaments.staff(data.id), users.list()]);

    setHTML(
      $("#staffList"),
      staff
        .map(
          (s) => `<div class="staff-row">
            <b class="grow">${e(s.name || s.email)}</b>
            <span class="pill ${s.role === "admin" ? "pill--mint" : ""}">${e(s.role)}</span>
            <span class="faint">${e(s.email)}</span>
            <button class="btn btn--sm btn--danger" data-unassign="${e(s.userId)}" type="button">Remove</button>
          </div>`,
        )
        .join("") || `<p class="faint">Nobody assigned yet.</p>`,
    );

    setHTML(
      $("#peopleList"),
      all
        .map(
          (u) => `<div class="people-row${u.status === "pending" ? " pending-card" : ""}">
            <b class="grow">${e(u.name || u.email)}</b>
            <span class="faint">${e(u.email)}</span>
            <span class="pill${u.status === "pending" ? " pill--gold" : ""}">${e(u.status)}</span>
            ${u.isSuper ? `<span class="pill pill--mint">super</span>` : ""}
            <button class="btn btn--sm btn--primary" data-assign="${e(u.id)}" data-role="admin" type="button">Make admin</button>
            <button class="btn btn--sm btn--ghost" data-assign="${e(u.id)}" data-role="referee" type="button">Make referee</button>
          </div>`,
        )
        .join(""),
    );
  } catch (err) {
    setHTML($("#peopleList"), `<p class="faint err">${e(err.message)}</p>`);
  }
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

    // Creating a tournament is the one action that has to work when no
    // tournament is loaded — it is how the first one comes into existence.
    // It therefore sits above the guard below.
    if (t.id === "createTournament") {
      const name = $("#newTournamentName").value.trim();
      if (!name) return toast("Give it a name.", "err");
      return run(async () => {
        await tournaments.create({
          name,
          season: $("#newTournamentSeason").value.trim(),
          format: $("#newTournamentFormat").value,
          startsOn: $("#newTournamentDate").value || null,
        });
        $("#newTournamentName").value = "";
        await refreshIdentity();
      }, `${name} created.`);
    }

    // Everything below acts on the open tournament.
    if (!data) return;

    // --- setup
    if (t.id === "addTeam") {
      const name = $("#newTeamName").value.trim();
      if (!name) return toast("Give the team a name.", "err");
      return run(async () => {
        await tournaments.addTeam(data.id, { name, captainName: $("#newCaptainName").value.trim() });
        $("#newTeamName").value = "";
        $("#newCaptainName").value = "";
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
      if (!confirm("Generate the fixture list? Existing fixtures are replaced.")) return;
      return run(() => tournaments.generateFixtures(data.id), "Fixtures generated.");
    }
    if (t.id === "addMatch") return run(() => tournaments.addMatch(data.id, {}), "Match added.");
    if (t.dataset.matchClear) {
      if (!confirm("Clear this match back to unplayed, log and all?")) return;
      return run(() => tournaments.clearMatch(data.id, t.dataset.matchClear), "Match cleared.");
    }

    // --- auction
    if (t.id === "sellBtn") {
      return run(async () => {
        await tournaments.sell(data.id, $("#sellPlayer").value, $("#sellTeam").value, Number($("#sellPrice").value));
        $("#sellPrice").value = "";
        $("#sellHint").textContent = "";
      }, "Sold.");
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

    // --- people
    if (t.dataset.assign) {
      return run(async () => {
        await tournaments.assign(data.id, t.dataset.assign, t.dataset.role);
        renderPeople();
      }, `Assigned as ${t.dataset.role}.`);
    }
    if (t.dataset.unassign) {
      return run(async () => {
        await tournaments.unassign(data.id, t.dataset.unassign);
        renderPeople();
      }, "Removed from this tournament.");
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
          ? "Live on the public site."
          : status === "completed"
            ? "Finished, and added to the Hall of Fame."
            : "Back to draft — hidden from the public.",
      );
      await refreshIdentity();
    } catch (err) {
      ev.target.value = data.status; // put the control back where it was
      toast(err.message, "err");
    }
  });

  $("#teamList").addEventListener("change", async (ev) => {
    const el = ev.target.closest("[data-team-name]");
    if (!el) return;
    try {
      await tournaments.updateTeam(data.id, el.dataset.teamName, { name: el.value.trim() });
      toast("Renamed.");
    } catch (err) {
      toast(err.message, "err");
    }
  });
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
