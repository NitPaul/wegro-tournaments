/**
 * The points engine and every statistics table.
 *
 * All of this keys off a player id, which is exactly why captains had to become
 * real players: in the previous version a captain's goal carried only a name
 * string, so it was dropped here — silently — while still appearing in the
 * match log. There is no name fallback anywhere in this file, and there should
 * never be one. If a name ever needs looking up, the fix is upstream, at the
 * point the event was written.
 */

import { POSITIONS, POSITION_LABEL, ZONES } from "./constants.js";
import {
  getPoints,
  isGuest,
  isPlayed,
  matchesList,
  playerById,
  playersList,
  teamById,
  teamKeeper,
  teamsList,
} from "./helpers.js";
import { allEvents } from "./events.js";
import { matchSides } from "./standings.js";

/**
 * A goal that counts towards a player's tally.
 *
 * Punctuality penalties are excluded because they are awarded against a team,
 * not scored by a person. Own goals are excluded because crediting one to the
 * scorer's own total would be absurd — they are counted separately, and cost
 * points, in `playerStats`.
 *
 * The previous version omitted this filter in `topScorers` and
 * `goalsByPosition`, so an own goal could win somebody the Golden Boot while
 * the points ledger on the same page recorded it correctly as an own goal. The
 * two tables disagreed.
 */
const isScoringGoal = (ev) => ev.type === "goal" && !ev.ownGoal;

function playerTable(data, matches, pick) {
  const counts = new Map();
  for (const ev of allEvents(data)) {
    if (!matches(ev)) continue;
    const id = pick(ev);
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([playerId, value]) => ({
      playerId,
      player: playerById(data, playerId),
      team: teamById(data, playerById(data, playerId)?.teamId),
      value,
    }))
    .filter((r) => r.player)
    .sort((a, b) => b.value - a.value || String(a.player.name).localeCompare(String(b.player.name)));
}

export const topScorers = (data) => playerTable(data, isScoringGoal, (ev) => ev.playerId);
export const topAssists = (data) => playerTable(data, isScoringGoal, (ev) => ev.assistId);

/**
 * Clean sheets, credited to a team's goalkeeper.
 *
 * `teamKeeper` prefers a bought keeper and falls back to the captain if the
 * captain is the one in goal — which the previous version could not do, because
 * a captain was not a player and therefore could not be found.
 */
export function cleanSheets(data) {
  const sheets = new Map();
  const conceded = new Map();

  for (const m of matchesList(data)) {
    if (!isPlayed(m)) continue;
    const { home, away } = matchSides(data, m);
    const hs = Number(m.homeScore);
    const as = Number(m.awayScore);

    const bump = (team, against) => {
      if (!team) return;
      conceded.set(team.id, (conceded.get(team.id) || 0) + against);
      if (against === 0) sheets.set(team.id, (sheets.get(team.id) || 0) + 1);
    };
    bump(home, as);
    bump(away, hs);
  }

  return teamsList(data)
    .map((t) => {
      const gk = teamKeeper(data, t.id);
      if (!gk) return null;
      return {
        playerId: gk.id,
        player: gk,
        team: t,
        value: sheets.get(t.id) || 0,
        conceded: conceded.get(t.id) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value || a.conceded - b.conceded);
}

/** Clean sheets and goals conceded per team, from full-time matches only. */
function teamDefensive(data) {
  const out = {};
  for (const t of teamsList(data)) out[t.id] = { sheets: 0, conceded: 0, played: 0 };

  for (const m of matchesList(data)) {
    if (!isPlayed(m)) continue;
    const { home, away } = matchSides(data, m);
    const hs = Number(m.homeScore);
    const as = Number(m.awayScore);

    const bump = (team, against) => {
      if (!team || !out[team.id]) return;
      out[team.id].played++;
      out[team.id].conceded += against;
      if (against === 0) out[team.id].sheets++;
    };
    bump(home, as);
    bump(away, hs);
  }
  return out;
}

/**
 * Every player's match record and award points, highest first.
 *
 * This is the single table the four medals are read from, so a player can add
 * up their own row from the match log and get the same answer the site shows.
 * Ties break on points → goals → assists → name, which is deterministic: the
 * order never changes between two renders of identical data.
 */
export function playerStats(data) {
  const w = getPoints(data);
  const def = teamDefensive(data);
  const rows = new Map();

  for (const p of playersList(data)) {
    rows.set(p.id, {
      playerId: p.id,
      player: p,
      team: teamById(data, p.teamId),
      goals: 0,
      criticalGoals: 0,
      assists: 0,
      chances: 0,
      shots: 0,
      saves: 0,
      clearances: 0,
      ownGoals: 0,
      fouls: 0,
      yellows: 0,
      reds: 0,
      cleanSheets: 0,
      conceded: 0,
      points: 0,
    });
  }

  const at = (id) => (id ? rows.get(id) : null);

  /** Every event type that is simply "one more of these for this player". */
  const TALLY = {
    save: "saves",
    clearance: "clearances",
    shot: "shots",
    chance: "chances",
    foul: "fouls",
    yellow: "yellows",
    red: "reds",
  };

  for (const ev of allEvents(data)) {
    const row = at(ev.playerId);

    if (ev.type === "goal") {
      if (row) {
        if (ev.ownGoal) {
          row.ownGoals++;
        } else {
          row.goals++;
          // Tracked separately from `goals` so the bonus is visible in the
          // ledger rather than hidden inside a total nobody can reproduce.
          if (ev.critical) row.criticalGoals++;
        }
      }
      // Nobody assists an own goal.
      if (!ev.ownGoal) {
        const assister = at(ev.assistId);
        if (assister) assister.assists++;
      }
      continue;
    }

    // penalty_goal is awarded against a team rather than scored by a person, so
    // it is absent from TALLY and deliberately credits nobody.
    const field = TALLY[ev.type];
    if (field && row) row[field]++;
  }

  // A clean sheet belongs to the whole back line, not just the keeper. Guests
  // are left out — they played one match, not the season. Captains are in,
  // which they could not be before.
  for (const r of rows.values()) {
    const d = def[r.player.teamId];
    if (!d || isGuest(r.player)) continue;
    if (r.player.pos === "GK") {
      r.cleanSheets = d.sheets;
      r.conceded = d.conceded;
    } else if (r.player.pos === "DEF") {
      r.cleanSheets = d.sheets;
    }
  }

  for (const r of rows.values()) {
    r.disciplinePoints = r.fouls * w.foul + r.yellows * w.yellow + r.reds * w.red;
    r.points =
      r.goals * w.goal +
      r.criticalGoals * w.criticalGoal +
      r.assists * w.assist +
      r.chances * w.chance +
      r.shots * w.shot +
      r.saves * w.save +
      r.clearances * w.clearance +
      r.ownGoals * w.ownGoal +
      r.disciplinePoints +
      (r.player.pos === "GK"
        ? r.cleanSheets * w.cleanSheetGK + r.conceded * w.concededGK
        : r.player.pos === "DEF"
          ? r.cleanSheets * w.cleanSheetDEF
          : 0);
  }

  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.goals - a.goals ||
      b.assists - a.assists ||
      String(a.player.name).localeCompare(String(b.player.name)),
  );
}

/** Did this player do anything worth a row in the ledger? */
export const hasRecord = (r) =>
  Boolean(
    r.points !== 0 ||
      r.goals ||
      r.assists ||
      r.chances ||
      r.shots ||
      r.saves ||
      r.clearances ||
      r.ownGoals ||
      r.fouls ||
      r.yellows ||
      r.reds,
  );

/** Has anyone done anything yet? Used to keep empty tables off the page. */
export const hasMatchData = (data) => playerStats(data).some(hasRecord);

/** Top of a leaderboard, plus whether it is currently a tie. */
export function leader(rows, key = "points") {
  const live = rows.filter((r) => r[key] > 0);
  if (!live.length) return null;
  const top = live[0];
  return { ...top, tied: live.filter((r) => r[key] === top[key]).length > 1 };
}

/**
 * Discipline by team — fouls, cards, and the points they cost.
 *
 * Ordered cleanest first, which makes it the fair-play table as well.
 */
export function disciplineTable(data) {
  const w = getPoints(data);
  const rows = new Map();
  for (const t of teamsList(data)) {
    rows.set(t.id, { teamId: t.id, team: t, fouls: 0, yellows: 0, reds: 0, points: 0 });
  }

  for (const ev of allEvents(data)) {
    const r = rows.get(ev.teamId);
    if (!r) continue;
    if (ev.type === "foul") r.fouls++;
    else if (ev.type === "yellow") r.yellows++;
    else if (ev.type === "red") r.reds++;
  }

  for (const r of rows.values()) {
    // Reported as a positive cost, because "12 discipline points" reads more
    // naturally on a fair-play table than "−12 points".
    r.points = Math.abs(r.fouls * w.foul + r.yellows * w.yellow + r.reds * w.red);
  }

  return [...rows.values()].sort(
    (a, b) => a.points - b.points || a.reds - b.reds || String(a.team.name).localeCompare(String(b.team.name)),
  );
}

/** Where goals were struck from — feeds the pitch-zone chart. */
export function goalsByZone(data) {
  const counts = Object.fromEntries(ZONES.map(([k]) => [k, 0]));
  let unknown = 0;
  for (const ev of allEvents(data)) {
    if (!isScoringGoal(ev)) continue;
    if (counts[ev.zone] != null) counts[ev.zone]++;
    else unknown++;
  }
  return { counts, unknown, total: Object.values(counts).reduce((n, v) => n + v, 0) };
}

/** Goals broken down by the scorer's position. */
export function goalsByPosition(data) {
  const counts = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  for (const ev of allEvents(data)) {
    if (!isScoringGoal(ev)) continue;
    const p = playerById(data, ev.playerId);
    if (p && counts[p.pos] != null) counts[p.pos]++;
  }
  return POSITIONS.map((pos) => ({ pos, label: POSITION_LABEL[pos], value: counts[pos] }));
}
