/**
 * Reading and writing tournaments.
 *
 * The one job that matters here is `loadTournament`: it turns normalised rows
 * into the single nested document the domain layer and the browser both expect.
 * That translation is what lets a real relational schema sit underneath code
 * that was written against a document store, and it is why the entire domain
 * layer and every renderer ported across without being rewritten.
 *
 * If SQLite is ever swapped out, this directory is the layer to reimplement.
 * Nothing above it knows what a table is.
 */

import { db, newId, transaction, uniqueSlug } from "../index.js";

const parse = (json, fallback = {}) => {
  try {
    return JSON.parse(json ?? "");
  } catch {
    return fallback;
  }
};

/* ------------------------------------------------------------------ shape */

const teamOut = (r) => ({
  id: r.id,
  slot: r.slot,
  name: r.name,
  jerseyColor: r.jersey_color,
  jerseyLabel: r.jersey_label,
  jerseyCost: r.jersey_cost,
  squadSize: r.squad_size,
});

const playerOut = (r) => ({
  id: r.id,
  name: r.name,
  pos: r.pos,
  teamId: r.team_id,
  price: r.price,
  kind: r.kind,
  photo: r.photo,
});

const eventOut = (r) => ({
  id: String(r.id),
  type: r.type,
  teamId: r.team_id,
  playerId: r.player_id,
  assistId: r.assist_id,
  zone: r.zone,
  penalty: r.penalty === 1,
  critical: r.critical === 1,
  ownGoal: r.own_goal === 1,
  clockLabel: r.clock_label,
  note: r.note,
  at: r.created_at,
});

const matchOut = (r) => ({
  id: r.id,
  no: r.no,
  homeId: r.home_team_id,
  awayId: r.away_team_id,
  homeScore: r.home_score,
  awayScore: r.away_score,
  status: r.status,
  isFinal: r.is_final === 1,
  time: r.kickoff,
  clock: parse(r.clock_json, {}),
  events: {},
});

/* ------------------------------------------------------------------- read */

export function findTournament(key) {
  return db
    .prepare("SELECT * FROM tournaments WHERE id = ? OR slug = ? COLLATE NOCASE")
    .get(key, key);
}

/**
 * The full tournament document, in the shape shared/domain/ works on.
 *
 * Four queries regardless of size — teams, players, matches, events — rather
 * than a query per match. At this scale it would not matter either way, but a
 * per-match query is the kind of thing that quietly becomes a problem three
 * seasons later.
 */
export function loadTournament(key) {
  const row = typeof key === "object" ? key : findTournament(key);
  if (!row) return null;

  const teams = {};
  for (const r of db.prepare("SELECT * FROM teams WHERE tournament_id = ? ORDER BY sort_order, slot").all(row.id)) {
    teams[r.id] = teamOut(r);
  }

  const players = {};
  for (const r of db.prepare("SELECT * FROM players WHERE tournament_id = ? ORDER BY sort_order, name").all(row.id)) {
    players[r.id] = playerOut(r);
  }

  const matches = {};
  for (const r of db.prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY no").all(row.id)) {
    matches[r.id] = matchOut(r);
  }

  const events = db
    .prepare(
      `SELECT e.* FROM events e
         JOIN matches m ON m.id = e.match_id
        WHERE m.tournament_id = ?
        ORDER BY e.id`,
    )
    .all(row.id);
  for (const e of events) {
    const match = matches[e.match_id];
    if (match) match.events[String(e.id)] = eventOut(e);
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    season: row.season,
    format: row.format,
    status: row.status,
    startsOn: row.starts_on,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    meta: parse(row.venue_json),
    settings: parse(row.settings_json),
    teams,
    players,
    matches,
  };
}

/** Lightweight list for pickers and the hall of fame, without loading squads. */
export function listTournaments({ status = null, includeDrafts = true } = {}) {
  const where = [];
  const args = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  } else if (!includeDrafts) {
    where.push("status != 'draft'");
  }

  const sql = `SELECT t.*,
                      (SELECT COUNT(*) FROM teams   WHERE tournament_id = t.id) AS team_count,
                      (SELECT COUNT(*) FROM players WHERE tournament_id = t.id) AS player_count,
                      (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id) AS match_count
                 FROM tournaments t
                ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY COALESCE(t.starts_on, '') DESC, t.created_at DESC`;

  return db
    .prepare(sql)
    .all(...args)
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      season: r.season,
      format: r.format,
      status: r.status,
      startsOn: r.starts_on,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      meta: parse(r.venue_json),
      teamCount: r.team_count,
      playerCount: r.player_count,
      matchCount: r.match_count,
    }));
}

/** The tournament the public site opens by default. */
export function defaultTournament() {
  return (
    db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() ||
    db.prepare("SELECT * FROM tournaments WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1").get() ||
    db.prepare("SELECT * FROM tournaments ORDER BY created_at DESC LIMIT 1").get() ||
    null
  );
}

/* ------------------------------------------------------------------ write */

export function createTournament({ name, season, format, startsOn, meta, settings, userId }) {
  const id = newId("tn");
  db.prepare(
    `INSERT INTO tournaments (id, slug, name, season, format, status, starts_on,
                              venue_json, settings_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    uniqueSlug(`${name}${season ? ` ${season}` : ""}`),
    name,
    season ?? "",
    format,
    startsOn ?? null,
    JSON.stringify(meta ?? {}),
    JSON.stringify(settings ?? {}),
    userId ?? null,
    Date.now(),
  );
  return findTournament(id);
}

const TOURNAMENT_COLUMNS = {
  name: "name",
  season: "season",
  status: "status",
  format: "format",
  startsOn: "starts_on",
};

export function updateTournament(id, patch) {
  const sets = [];
  const args = [];

  for (const [key, column] of Object.entries(TOURNAMENT_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (patch.meta !== undefined) {
    sets.push("venue_json = ?");
    args.push(JSON.stringify(patch.meta));
  }
  if (patch.settings !== undefined) {
    sets.push("settings_json = ?");
    args.push(JSON.stringify(patch.settings));
  }
  if (patch.completedAt !== undefined) {
    sets.push("completed_at = ?");
    args.push(patch.completedAt);
  }
  if (!sets.length) return findTournament(id);

  args.push(id);
  db.prepare(`UPDATE tournaments SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return findTournament(id);
}

/**
 * Merge into the settings blob rather than replacing it.
 *
 * Settings arrive from several different screens — auction rules, award points,
 * medal overrides — and a screen that only knows about its own fields must not
 * wipe the others by sending a whole object back.
 */
export function patchSettings(id, patch) {
  const row = findTournament(id);
  if (!row) return null;
  const current = parse(row.settings_json);
  const next = { ...current, ...patch };
  if (patch.points) next.points = { ...(current.points ?? {}), ...patch.points };
  return updateTournament(id, { settings: next });
}

export function patchMeta(id, patch) {
  const row = findTournament(id);
  if (!row) return null;
  return updateTournament(id, { meta: { ...parse(row.venue_json), ...patch } });
}

export function deleteTournament(id) {
  // Teams, players, matches, events, staff and the archive row all cascade.
  return db.prepare("DELETE FROM tournaments WHERE id = ?").run(id).changes > 0;
}

/* ------------------------------------------------------------------ staff */

export function listStaff(tournamentId) {
  return db
    .prepare(
      `SELECT s.role, s.assigned_at, u.id, u.email, u.name, u.status, u.is_super
         FROM tournament_staff s
         JOIN users u ON u.id = s.user_id
        WHERE s.tournament_id = ?
        ORDER BY s.role, u.name`,
    )
    .all(tournamentId)
    .map((r) => ({
      userId: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      status: r.status,
      isSuper: r.is_super === 1,
      assignedAt: r.assigned_at,
    }));
}

export function assignStaff(tournamentId, userId, role, assignedBy) {
  return transaction(() => {
    db.prepare(
      `INSERT INTO tournament_staff (tournament_id, user_id, role, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tournament_id, user_id) DO UPDATE SET role = excluded.role,
                                                          assigned_by = excluded.assigned_by,
                                                          assigned_at = excluded.assigned_at`,
    ).run(tournamentId, userId, role, assignedBy ?? null, Date.now());

    // Being given a job is the approval. Otherwise an organiser has to approve
    // the person and then assign them, and forgetting the first step produces a
    // referee who can sign in and change nothing, with no clue why.
    db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'").run(userId);

    return listStaff(tournamentId);
  });
}

export function removeStaff(tournamentId, userId) {
  db.prepare("DELETE FROM tournament_staff WHERE tournament_id = ? AND user_id = ?").run(
    tournamentId,
    userId,
  );
  return listStaff(tournamentId);
}
