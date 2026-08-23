/** Matches, the clock, and the match log. */

import { db, newId, transaction } from "../index.js";

export function createMatch(tournamentId, { no, homeId = null, awayId = null, isFinal = false, kickoff = null }) {
  const id = newId("mt");
  db.prepare(
    `INSERT INTO matches (id, tournament_id, no, home_team_id, away_team_id, status, is_final, kickoff, clock_json)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
  ).run(
    id,
    tournamentId,
    no,
    homeId,
    awayId,
    isFinal ? 1 : 0,
    kickoff,
    JSON.stringify({ period: "pre", running: false, startedAt: null, elapsed: 0, addedSeconds: 0 }),
  );
  return id;
}

export function getMatch(matchId) {
  return db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId) ?? null;
}

export function nextMatchNumber(tournamentId) {
  const { max } = db
    .prepare("SELECT COALESCE(MAX(no), 0) AS max FROM matches WHERE tournament_id = ?")
    .get(tournamentId);
  return max + 1;
}

const MATCH_COLUMNS = {
  no: "no",
  homeId: "home_team_id",
  awayId: "away_team_id",
  homeScore: "home_score",
  awayScore: "away_score",
  status: "status",
  kickoff: "kickoff",
};

export function updateMatch(matchId, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(MATCH_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (patch.isFinal !== undefined) {
    sets.push("is_final = ?");
    args.push(patch.isFinal ? 1 : 0);
  }
  if (patch.clock !== undefined) {
    sets.push("clock_json = ?");
    args.push(JSON.stringify(patch.clock));
  }
  if (!sets.length) return false;

  args.push(matchId);
  return db.prepare(`UPDATE matches SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes > 0;
}

export function deleteMatch(matchId) {
  return db.prepare("DELETE FROM matches WHERE id = ?").run(matchId).changes > 0;
}

/** Wipe a match back to unplayed, log and all. */
export function clearMatch(matchId) {
  return transaction(() => {
    db.prepare("DELETE FROM events WHERE match_id = ?").run(matchId);
    return updateMatch(matchId, {
      homeScore: null,
      awayScore: null,
      status: "scheduled",
      clock: { period: "pre", running: false, startedAt: null, elapsed: 0, addedSeconds: 0 },
    });
  });
}

export function clearAllScores(tournamentId) {
  return transaction(() => {
    db.prepare(
      "DELETE FROM events WHERE match_id IN (SELECT id FROM matches WHERE tournament_id = ?)",
    ).run(tournamentId);
    db.prepare(
      `UPDATE matches
          SET home_score = NULL, away_score = NULL, status = 'scheduled',
              clock_json = '{"period":"pre","running":false,"startedAt":null,"elapsed":0,"addedSeconds":0}'
        WHERE tournament_id = ?`,
    ).run(tournamentId);
  });
}

/* ----------------------------------------------------------------- events */

export function addEvent(matchId, event) {
  const info = db
    .prepare(
      `INSERT INTO events (match_id, type, team_id, player_id, assist_id, zone,
                           penalty, critical, own_goal, clock_label, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      matchId,
      event.type,
      event.teamId ?? null,
      event.playerId ?? null,
      event.assistId ?? null,
      event.zone ?? null,
      event.penalty ? 1 : 0,
      event.critical ? 1 : 0,
      event.ownGoal ? 1 : 0,
      event.clockLabel ?? null,
      event.note ?? null,
      Date.now(),
    );
  return String(info.lastInsertRowid);
}

export function getEvent(eventId) {
  return db.prepare("SELECT * FROM events WHERE id = ?").get(Number(eventId)) ?? null;
}

const EVENT_COLUMNS = {
  playerId: "player_id",
  assistId: "assist_id",
  zone: "zone",
  note: "note",
  teamId: "team_id",
};

export function updateEvent(eventId, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(EVENT_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  for (const flag of ["penalty", "critical", "ownGoal"]) {
    if (patch[flag] !== undefined) {
      sets.push(`${flag === "ownGoal" ? "own_goal" : flag} = ?`);
      args.push(patch[flag] ? 1 : 0);
    }
  }
  if (!sets.length) return false;

  args.push(Number(eventId));
  return db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes > 0;
}

export function deleteEvent(eventId) {
  return db.prepare("DELETE FROM events WHERE id = ?").run(Number(eventId)).changes > 0;
}
