/**
 * The league table, and who plays in the final.
 *
 * Everything here is derived from played matches. No total is ever stored, so
 * the table can never drift out of step with the results that produced it.
 *
 * Nothing assumes four teams or seven matches — that was only ever true of the
 * seed data. This works for any number of teams.
 */

import {
  finalMatch,
  groupLabels,
  groupMatches,
  isFriendly,
  isPlayed,
  teamById,
  teamsInGroup,
  teamsList,
} from "./helpers.js";

/**
 * Tiebreaks, in order: Points → Goal Difference → Goals For → head-to-head →
 * team name.
 *
 * Head-to-head only settles a straight pair. With three or more level teams it
 * is a non-transitive comparator inside a sort and is effectively skipped,
 * which is the standard convention rather than an oversight. Team name is the
 * final fallback purely so the order is deterministic — two renders of the same
 * data must never disagree.
 */
export function standings(data, { group = null } = {}) {
  const teams = teamsInGroup(data, group);
  const inTable = new Set(teams.map((t) => t.id));
  // A group's table counts only the matches played inside that group.
  const played = groupMatches(data)
    .filter(isPlayed)
    .filter((m) => !group || (inTable.has(m.homeId) && inTable.has(m.awayId)));
  const rows = {};

  for (const t of teams) {
    rows[t.id] = {
      teamId: t.id,
      team: t,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
      form: [],
    };
  }

  for (const m of played) {
    const h = rows[m.homeId];
    const a = rows[m.awayId];
    if (!h || !a) continue; // a team was deleted — skip rather than crash
    const hs = Number(m.homeScore);
    const as = Number(m.awayScore);

    h.played++;
    a.played++;
    h.goalsFor += hs;
    h.goalsAgainst += as;
    a.goalsFor += as;
    a.goalsAgainst += hs;

    if (hs > as) {
      h.won++;
      h.points += 3;
      a.lost++;
      h.form.push("W");
      a.form.push("L");
    } else if (hs < as) {
      a.won++;
      a.points += 3;
      h.lost++;
      h.form.push("L");
      a.form.push("W");
    } else {
      h.drawn++;
      a.drawn++;
      h.points++;
      a.points++;
      h.form.push("D");
      a.form.push("D");
    }
  }

  const list = Object.values(rows);
  for (const r of list) r.goalDiff = r.goalsFor - r.goalsAgainst;

  const headToHead = (a, b) => {
    const m = played.find(
      (x) =>
        (x.homeId === a.teamId && x.awayId === b.teamId) ||
        (x.homeId === b.teamId && x.awayId === a.teamId),
    );
    if (!m) return 0;
    const aScore = m.homeId === a.teamId ? Number(m.homeScore) : Number(m.awayScore);
    const bScore = m.homeId === b.teamId ? Number(m.homeScore) : Number(m.awayScore);
    return bScore - aScore;
  };

  list.sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDiff - a.goalDiff ||
      b.goalsFor - a.goalsFor ||
      headToHead(a, b) ||
      String(a.team.name).localeCompare(String(b.team.name)),
  );

  list.forEach((r, i) => (r.pos = i + 1));
  return list;
}

/** True once every group match is full-time — the knockout can then be seeded. */
export const groupStageComplete = (data) => {
  const gm = groupMatches(data);
  return gm.length > 0 && gm.every(isPlayed);
};

/** One table per group, or a single table when no groups are in use. */
export function groupTables(data) {
  const labels = groupLabels(data);
  if (!labels.length) return [{ group: null, table: standings(data) }];
  return labels.map((group) => ({ group, table: standings(data, { group }) }));
}

/**
 * Resolve a match's two sides.
 *
 * A match that names its teams uses them — that is the organiser's decision,
 * including the knockout pairings they choose. Only a final left blank derives
 * its finalists from the table, so correcting a group result re-seeds it
 * automatically instead of leaving a stale pairing behind. That is how every
 * football tournament here has worked, and it still does.
 */
export function matchSides(data, match) {
  if (!match) return { home: null, away: null, homeLabel: "—", awayLabel: "—", derived: false };

  const named = teamById(data, match.homeId) || teamById(data, match.awayId);
  if (named) {
    const home = teamById(data, match.homeId);
    const away = teamById(data, match.awayId);
    return {
      home,
      away,
      homeLabel: home?.name || "TBD",
      awayLabel: away?.name || "TBD",
      derived: false,
    };
  }

  if (match.isFinal) {
    if (groupStageComplete(data)) {
      const table = standings(data);
      const home = table[0]?.team || null;
      const away = table[1]?.team || null;
      return {
        home,
        away,
        homeLabel: home?.name || "Leaderboard 1",
        awayLabel: away?.name || "Leaderboard 2",
        derived: true,
      };
    }
    return {
      home: null,
      away: null,
      homeLabel: "Leaderboard 1",
      awayLabel: "Leaderboard 2",
      derived: true,
    };
  }

  const home = teamById(data, match.homeId);
  const away = teamById(data, match.awayId);
  return {
    home,
    away,
    homeLabel: home?.name || "TBD",
    awayLabel: away?.name || "TBD",
    derived: false,
  };
}

/**
 * The champion and runner-up.
 *
 * A league is decided by its final. A friendly series has no final, so the top
 * of the table wins it — which is what makes a friendly a first-class citizen
 * in the hall of fame rather than an entry with two blank columns.
 */
export function champion(data) {
  if (isFriendly(data)) {
    const table = standings(data);
    const anyPlayed = table.some((r) => r.played > 0);
    if (!anyPlayed) return null;
    return {
      winner: table[0]?.team || null,
      runnerUp: table[1]?.team || null,
      decidedBy: "table",
      finalScore: "",
    };
  }

  const f = finalMatch(data);
  if (!isPlayed(f)) return null;

  const { home, away } = matchSides(data, f);
  const hs = Number(f.homeScore);
  const as = Number(f.awayScore);
  // A final can end level on the night; the shoot-out is what decides it. Until
  // that is recorded there is no champion, and the console says so.
  const level = hs === as;
  const hp = Number(f.homePens);
  const ap = Number(f.awayPens);
  const onPenalties = level && Number.isFinite(hp) && Number.isFinite(ap) && hp !== ap;
  if (level && !onPenalties) return null;

  const homeWon = onPenalties ? hp > ap : hs > as;
  return {
    winner: homeWon ? home : away,
    runnerUp: homeWon ? away : home,
    decidedBy: onPenalties ? "penalties" : "final",
    finalScore: onPenalties
      ? `${hs}–${as} (${Math.max(hp, ap)}–${Math.min(hp, ap)} on pens)`
      : `${Math.max(hs, as)}–${Math.min(hs, as)}`,
  };
}

/**
 * Generate a full round-robin fixture list — every team plays every other once.
 *
 * The circle method: fix one team, rotate the rest. With an odd number of teams
 * a bye is inserted, so one team sits out each round rather than the schedule
 * silently dropping a fixture.
 *
 * Returns `[{ no, homeId, awayId, round }]`, ready to be written as matches.
 */
export function roundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length < 2) return [];

  const bye = ids.length % 2 === 1 ? "__bye__" : null;
  if (bye) ids.push(bye);

  const rounds = ids.length - 1;
  const half = ids.length / 2;
  const rotating = ids.slice(1);
  const fixtures = [];
  let no = 1;

  for (let r = 0; r < rounds; r++) {
    const lineup = [ids[0], ...rotating];
    for (let i = 0; i < half; i++) {
      const home = lineup[i];
      const away = lineup[lineup.length - 1 - i];
      if (home === bye || away === bye) continue;
      // Alternate who is nominally at home each round, so no team is always
      // listed first. Cosmetic here — there is one pitch — but it keeps the
      // fixture list from looking lopsided.
      const flip = r % 2 === 1;
      fixtures.push({
        no: no++,
        round: r + 1,
        homeId: flip ? away : home,
        awayId: flip ? home : away,
      });
    }
    rotating.unshift(rotating.pop());
  }

  return fixtures;
}
