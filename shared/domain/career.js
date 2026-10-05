/**
 * Careers — a person's record across every tournament they have played.
 *
 * A `player` belongs to one tournament. A `person` is the human being, and a
 * tournament player points at one through `personId`. A career is simply the
 * existing per-tournament ledger (`playerStats`) summed over the players that
 * point at the same person. Nothing is counted a second way, so a captain's
 * goal counts in a career exactly as it counts in the tournament's own table.
 *
 * Appearances are not recorded — there are no team sheets — so `matches` is an
 * honest approximation: every finished match the player's team took part in.
 * A guest, who turns up for a match as a favour, is credited only with the
 * matches in which something was logged against them.
 */

import { MEDALS } from "./constants.js";
import { isEsports, isGuest, isPlayed, matchesList, teamMembers } from "./helpers.js";
import { matchWinner } from "./knockout.js";
import { standings } from "./standings.js";
import { matchSides } from "./standings.js";
import { seasonSortKey } from "./season.js";
import { playerStats } from "./stats.js";

/** The counters a career adds up. Every one comes straight from playerStats. */
export const CAREER_FIELDS = [
  "goals",
  "assists",
  "saves",
  "clearances",
  "shots",
  "chances",
  "cleanSheets",
  "ownGoals",
  "fouls",
  "yellows",
  "reds",
  "points",
];

const emptyTotals = () => Object.fromEntries([["matches", 0], ...CAREER_FIELDS.map((f) => [f, 0])]);

/**
 * What a gaming record counts. Nothing per-player: in FC 26 the goals are
 * scored by Mbappé, not by the person holding the controller, so a pair's
 * record is their results — played, won, drawn, lost, goals, points.
 */
export const GAME_FIELDS = ["matches", "won", "drawn", "lost", "goalsFor", "goalsAgainst", "goalDiff", "points"];

const emptyGameTotals = () => Object.fromEntries(GAME_FIELDS.map((f) => [f, 0]));

/** Finished matches a team played in, counting a final once its sides are known. */
function teamMatchCount(data, teamId) {
  if (!teamId) return 0;
  let n = 0;
  for (const m of matchesList(data)) {
    if (!isPlayed(m)) continue;
    const { home, away } = matchSides(data, m);
    if (home?.id === teamId || away?.id === teamId) n++;
  }
  return n;
}

/** Matches in which anything at all was logged against this player. */
function matchesWithEvents(data, playerId) {
  let n = 0;
  for (const m of matchesList(data)) {
    const events = Object.values(m.events ?? {});
    if (events.some((e) => e.playerId === playerId || e.assistId === playerId)) n++;
  }
  return n;
}

/**
 * Build every person's career from a set of tournaments.
 *
 * A person has two records, kept apart because they measure different things:
 * `pitch` is football — goals, saves, cards, medals — and `game` is the console,
 * where only results count. Someone who plays both has both; someone who plays
 * one has an empty other, and the site simply does not show it.
 *
 * @param {object[]} tournaments  tournament documents (as loadTournament returns)
 * @param {object[]} archives     hall of fame rows (as listArchive returns), for medals and titles
 * @returns {Map<string, object>} personId -> { personId, totals, tournaments, medals, titles, game }
 */
export function buildCareers(tournaments, archives = []) {
  const careers = new Map();
  const archiveFor = new Map(archives.map((a) => [a.tournamentId, a]));

  const careerOf = (personId) => {
    if (!careers.has(personId)) {
      careers.set(personId, {
        personId,
        totals: emptyTotals(),
        tournaments: [],
        medals: [],
        titles: 0,
        game: { totals: emptyGameTotals(), tournaments: [], titles: 0, finals: 0 },
      });
    }
    return careers.get(personId);
  };

  for (const data of tournaments) {
    const archive = archiveFor.get(data.id) ?? null;

    if (isEsports(data)) {
      addGameTournament(careerOf, data, archive);
      continue;
    }

    const linked = playerStats(data).filter((row) => row.player.personId);
    const teamMatches = new Map();

    for (const row of linked) {
      const career = careerOf(row.player.personId);
      const teamId = row.player.teamId;

      if (!teamMatches.has(teamId)) teamMatches.set(teamId, teamMatchCount(data, teamId));
      const matches = isGuest(row.player) ? matchesWithEvents(data, row.playerId) : teamMatches.get(teamId);

      career.totals.matches += matches;
      for (const f of CAREER_FIELDS) career.totals[f] += row[f] ?? 0;

      const champion = Boolean(archive && teamId && archive.championTeamId === teamId);
      if (champion) career.titles++;

      const medalsHere = [];
      for (const [key, label, icon] of MEDALS) {
        const medal = archive?.medals?.[key];
        if (medal?.playerId === row.playerId) medalsHere.push({ key, label, icon });
      }
      for (const m of medalsHere) {
        career.medals.push({ ...m, tournamentId: data.id, tournamentName: data.name, season: data.season });
      }

      career.tournaments.push({
        tournamentId: data.id,
        slug: data.slug,
        name: data.name,
        season: data.season,
        status: data.status,
        startsOn: data.startsOn ?? null,
        playerId: row.playerId,
        kind: row.player.kind,
        pos: row.player.pos,
        team: row.team ? { id: row.team.id, name: row.team.name } : null,
        price: row.player.price ?? null,
        champion,
        medals: medalsHere,
        matches,
        stats: Object.fromEntries(CAREER_FIELDS.map((f) => [f, row[f] ?? 0])),
      });
    }
  }

  // Newest tournament first on each person's record.
  for (const c of careers.values()) {
    // "September 2026" after "March 2026": by date, not by the words.
    c.tournaments.sort((a, b) => seasonSortKey(b).localeCompare(seasonSortKey(a)));
    c.game.tournaments.sort((a, b) => seasonSortKey(b).localeCompare(seasonSortKey(a)));
  }
  return careers;
}

/**
 * One gaming tournament, added to the record of everyone who played in it.
 *
 * A pair shares one line in the table, so both of them get that line: their
 * team's results are their results.
 */
function addGameTournament(careerOf, data, archive) {
  const table = standings(data);
  const posFor = new Map(table.map((r) => [r.teamId, r.pos]));

  for (const team of table.map((r) => r.team)) {
    // Everything they played, not only the group stage: a semi-final and a
    // final are the matches people remember, and a record that left them out
    // would be wrong in the only direction that matters.
    const row = teamRecord(data, team.id);
    const members = teamMembers(data, team.id).filter((p) => p.personId);
    const champion = Boolean(archive && archive.championTeamId === team.id);
    const runnerUp = Boolean(archive && archive.runnerUpTeamId === team.id);

    for (const member of members) {
      const career = careerOf(member.personId);
      const g = career.game;

      g.totals.matches += row.played;
      g.totals.won += row.won;
      g.totals.drawn += row.drawn;
      g.totals.lost += row.lost;
      g.totals.goalsFor += row.goalsFor;
      g.totals.goalsAgainst += row.goalsAgainst;
      g.totals.goalDiff = g.totals.goalsFor - g.totals.goalsAgainst;
      g.totals.points += row.points;
      if (champion) g.titles++;
      if (champion || runnerUp) g.finals++;

      g.tournaments.push({
        groupPos: posFor.get(team.id) ?? null,
        tournamentId: data.id,
        slug: data.slug,
        name: data.name,
        game: data.game ?? null,
        season: data.season,
        status: data.status,
        startsOn: data.startsOn ?? null,
        playerId: member.id,
        team: { id: team.id, name: team.name, group: team.group ?? null },
        partners: members.filter((m) => m.id !== member.id).map((m) => ({ personId: m.personId, name: m.name })),
        champion,
        runnerUp,
        stats: {
          matches: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          goalDiff: row.goalDiff,
          points: row.points,
        },
      });
    }
  }

}

/**
 * One team's record across every match they played — group stage and knockout.
 *
 * A knockout match cannot be drawn: whoever came through, on the night or on
 * penalties, is credited with the win. A knockout still waiting on its shoot-out
 * counts for nobody yet.
 */
function teamRecord(data, teamId) {
  const row = { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0 };

  for (const m of matchesList(data)) {
    if (!isPlayed(m) || (m.homeId !== teamId && m.awayId !== teamId)) continue;
    const home = m.homeId === teamId;
    const scored = Number(home ? m.homeScore : m.awayScore);
    const conceded = Number(home ? m.awayScore : m.homeScore);
    const { winnerId, loserId, level } = matchWinner(data, m);
    if (level && !winnerId) {
      // A knockout with no shoot-out recorded is not a result yet.
      if (m.stage && m.stage !== "group") continue;
    }

    row.played++;
    row.goalsFor += scored;
    row.goalsAgainst += conceded;
    if (winnerId === teamId) {
      row.won++;
      row.points += 3;
    } else if (loserId === teamId) {
      row.lost++;
    } else {
      row.drawn++;
      row.points += 1;
    }
  }

  row.goalDiff = row.goalsFor - row.goalsAgainst;
  return row;
}
