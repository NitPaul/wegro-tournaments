/**
 * The medals.
 *
 * All of them read the same points table; they differ only in who is eligible
 * and what they are ranked on. Golden Boot stays a pure goal count — it is the
 * one award whose name promises exactly one thing.
 *
 * Every medal accepts a manual override from settings, and an override wins
 * over the computed leader: a referee, or management afterwards, may see
 * something a tally cannot. Overridden rows come back with `picked: true` so
 * the public card can say the award was assigned, rather than appearing to
 * contradict the numbers printed underneath it.
 *
 * Captains are eligible for everything. In the previous version they could not
 * win a medal at all — not by computation, because they had no statistics, and
 * not by override either, because the admin dropdown was built from the player
 * list they were absent from.
 */

import { MEDALS, TEAM_MEDALS } from "./constants.js";
import { getSettings, isGuest, teamById } from "./helpers.js";
import { disciplineTable, leader, playerStats } from "./stats.js";

export function awards(data) {
  const all = playerStats(data);
  const s = getSettings(data);

  /** The overridden row for a medal, or null to fall back to the computation. */
  const override = (key) => {
    const id = s[key];
    const row = id ? all.find((r) => r.playerId === id) : null;
    return row ? { ...row, picked: true, tied: false } : null;
  };
  const computed = (row) => (row ? { ...row, picked: false } : null);

  const byGoals = all
    .filter((r) => r.goals > 0)
    .sort(
      (a, b) =>
        b.goals - a.goals ||
        b.assists - a.assists ||
        String(a.player.name).localeCompare(String(b.player.name)),
    );
  const topGoals = byGoals[0]?.goals || 0;
  const bootPick = override("goldenBootPlayerId");

  // Guests are excluded from the two position medals: they played one match as
  // a favour, and a season award for a squad's keeper or defence should not go
  // to somebody who was passing. They remain eligible for Ball and Boot, where
  // the achievement speaks for itself.
  const eligible = (pos) => all.filter((r) => r.player.pos === pos && !isGuest(r.player));

  const fair = disciplineTable(data);
  const fairOverride = s.fairPlayTeamId ? fair.find((r) => r.teamId === s.fairPlayTeamId) : null;

  return {
    all,
    goldenBall: override("goldenBallPlayerId") || computed(leader(all)),
    // An array, because the Boot really can be shared. An override names one
    // player, so it collapses the tie by decree.
    goldenBoot: bootPick
      ? [bootPick]
      : byGoals.filter((r) => r.goals === topGoals).map((r) => ({ ...r, picked: false })),
    goldenGlove: override("goldenGlovePlayerId") || computed(leader(eligible("GK"))),
    bestDefender: override("bestDefenderPlayerId") || computed(leader(eligible("DEF"))),
    fairPlay: fairOverride
      ? { ...fairOverride, picked: true }
      : fair.length
        ? { ...fair[0], picked: false }
        : null,
  };
}

/**
 * Flatten the medals into something storable — used when a tournament is
 * archived into the hall of fame, where the winners have to survive even if the
 * underlying rows are later edited.
 */
export function medalSummary(data) {
  const a = awards(data);
  const out = {};

  for (const [key, label, icon] of MEDALS) {
    const value = a[key];
    const row = Array.isArray(value) ? value[0] : value;
    out[key] = row
      ? {
          label,
          icon,
          playerId: row.playerId,
          playerName: row.player?.name ?? "",
          teamName: row.team?.name ?? "",
          value: key === "goldenBoot" ? row.goals : row.points,
          shared: Array.isArray(value) && value.length > 1 ? value.map((r) => r.player?.name ?? "") : null,
          picked: Boolean(row.picked),
        }
      : null;
  }

  for (const [key, label, icon] of TEAM_MEDALS) {
    const row = a[key];
    out[key] = row
      ? {
          label,
          icon,
          teamId: row.teamId,
          teamName: teamById(data, row.teamId)?.name ?? row.team?.name ?? "",
          value: row.points,
          picked: Boolean(row.picked),
        }
      : null;
  }

  return out;
}
