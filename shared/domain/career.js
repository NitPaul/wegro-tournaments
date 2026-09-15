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
import { isGuest, isPlayed, matchesList } from "./helpers.js";
import { matchSides } from "./standings.js";
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
 * @param {object[]} tournaments  tournament documents (as loadTournament returns)
 * @param {object[]} archives     hall of fame rows (as listArchive returns), for medals and titles
 * @returns {Map<string, object>} personId -> { personId, totals, tournaments, medals, titles }
 */
export function buildCareers(tournaments, archives = []) {
  const careers = new Map();
  const archiveFor = new Map(archives.map((a) => [a.tournamentId, a]));

  const careerOf = (personId) => {
    if (!careers.has(personId)) {
      careers.set(personId, { personId, totals: emptyTotals(), tournaments: [], medals: [], titles: 0 });
    }
    return careers.get(personId);
  };

  for (const data of tournaments) {
    const archive = archiveFor.get(data.id) ?? null;
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
    c.tournaments.sort((a, b) => String(b.startsOn ?? b.season ?? "").localeCompare(String(a.startsOn ?? a.season ?? "")));
  }
  return careers;
}
