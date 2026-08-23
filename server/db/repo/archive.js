/**
 * The hall of fame.
 *
 * This is the one place the system stores something it could derive. Everywhere
 * else, champions and medals are computed from matches on demand — and that
 * property is worth keeping, because it means the numbers can never drift away
 * from the results that produced them.
 *
 * The hall of fame is the exception because it lists every tournament ever
 * played. Deriving each row would mean loading every tournament's full match
 * log on every page view, which does not scale past a few seasons. So the row
 * is computed once, when a tournament is marked completed, and there is a
 * Recompute action for when a result is corrected afterwards.
 *
 * The derivation still lives in shared/domain/. This table only caches its
 * answer.
 */

import { champion } from "../../../shared/domain/standings.js";
import { medalSummary } from "../../../shared/domain/awards.js";
import { hasRecord, playerStats, topScorers } from "../../../shared/domain/stats.js";
import { db } from "../index.js";
import { loadTournament } from "./tournaments.js";

const parse = (json, fallback = {}) => {
  try {
    return JSON.parse(json ?? "");
  } catch {
    return fallback;
  }
};

/** Compute an archive row from the live data and store it. */
export function recomputeArchive(tournamentId) {
  const data = loadTournament(tournamentId);
  if (!data) return null;

  const result = champion(data);
  const medals = medalSummary(data);
  const scorers = topScorers(data);

  const summary = {
    format: data.format,
    teamCount: Object.keys(data.teams).length,
    playerCount: Object.keys(data.players).length,
    matchesPlayed: Object.values(data.matches).filter((m) => m.status === "ft").length,
    goals: Object.values(data.matches).reduce(
      (n, m) => n + Object.values(m.events ?? {}).filter((e) => e.type === "goal").length,
      0,
    ),
    decidedBy: result?.decidedBy ?? null,
    topScorer: scorers[0]
      ? { name: scorers[0].player.name, team: scorers[0].team?.name ?? "", goals: scorers[0].value }
      : null,
    ledgerSize: playerStats(data).filter(hasRecord).length,
  };

  db.prepare(
    `INSERT INTO archive (tournament_id, champion_team_id, runner_up_team_id,
                          champion_name, runner_up_name, final_score,
                          medals_json, summary_json, completed_on, recomputed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tournament_id) DO UPDATE SET
       champion_team_id  = excluded.champion_team_id,
       runner_up_team_id = excluded.runner_up_team_id,
       champion_name     = excluded.champion_name,
       runner_up_name    = excluded.runner_up_name,
       final_score       = excluded.final_score,
       medals_json       = excluded.medals_json,
       summary_json      = excluded.summary_json,
       completed_on      = excluded.completed_on,
       recomputed_at     = excluded.recomputed_at`,
  ).run(
    data.id,
    result?.winner?.id ?? null,
    result?.runnerUp?.id ?? null,
    // The names are stored as text as well as by id, so the hall of fame still
    // reads correctly years later even if a team is renamed or removed.
    result?.winner?.name ?? "",
    result?.runnerUp?.name ?? "",
    result?.finalScore ?? "",
    JSON.stringify(medals),
    JSON.stringify(summary),
    data.startsOn ?? null,
    Date.now(),
  );

  return getArchiveRow(data.id);
}

export function getArchiveRow(tournamentId) {
  const r = db.prepare("SELECT * FROM archive WHERE tournament_id = ?").get(tournamentId);
  return r ? shape(r) : null;
}

export function removeArchive(tournamentId) {
  db.prepare("DELETE FROM archive WHERE tournament_id = ?").run(tournamentId);
}

/** Every completed tournament, newest first. */
export function listArchive() {
  return db
    .prepare(
      `SELECT a.*, t.name, t.slug, t.season, t.format, t.starts_on, t.completed_at
         FROM archive a
         JOIN tournaments t ON t.id = a.tournament_id
        WHERE t.status = 'completed'
        ORDER BY COALESCE(t.starts_on, '') DESC, t.completed_at DESC`,
    )
    .all()
    .map(shape);
}

function shape(r) {
  return {
    tournamentId: r.tournament_id,
    name: r.name,
    slug: r.slug,
    season: r.season,
    format: r.format,
    startsOn: r.starts_on,
    completedAt: r.completed_at,
    championTeamId: r.champion_team_id,
    runnerUpTeamId: r.runner_up_team_id,
    champion: r.champion_name,
    runnerUp: r.runner_up_name,
    finalScore: r.final_score,
    medals: parse(r.medals_json),
    summary: parse(r.summary_json),
    recomputedAt: r.recomputed_at,
  };
}
