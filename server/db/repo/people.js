/**
 * The roster: people, independent of any one tournament.
 *
 * Plain reads and writes. Careers and ratings are worked out from tournaments
 * in server/roster.js, using shared/domain/career.js — nothing about a career
 * is stored.
 */

import { db, newId } from "../index.js";

const personOut = (r) => ({
  id: r.id,
  name: r.name,
  pos: r.pos ?? null,
  photo: r.photo ?? null,
  rating: Number.isInteger(r.rating) ? r.rating : null,
  ratingNote: r.rating_note ?? "",
  active: r.active === 1,
  createdBy: r.created_by ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listPeople({ includeInactive = true } = {}) {
  return db
    .prepare(`SELECT * FROM people ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`)
    .all()
    .map(personOut);
}

export function getPerson(id) {
  const r = db.prepare("SELECT * FROM people WHERE id = ?").get(id);
  return r ? personOut(r) : null;
}

export function createPerson({ name, pos = null, rating = null, ratingNote = "", createdBy = null }) {
  const id = newId("pp");
  const now = Date.now();
  db.prepare(
    `INSERT INTO people (id, name, pos, rating, rating_note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, pos, rating, ratingNote, createdBy, now, now);
  return getPerson(id);
}

const COLUMNS = { name: "name", pos: "pos", rating: "rating", ratingNote: "rating_note", active: "active", photo: "photo" };

export function updatePerson(id, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(key === "active" ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!sets.length) return getPerson(id);
  sets.push("updated_at = ?");
  args.push(Date.now(), id);
  db.prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return getPerson(id);
}

/** Delete a person. Their tournament players stay, unlinked (ON DELETE SET NULL). */
export function deletePerson(id) {
  return db.prepare("DELETE FROM people WHERE id = ?").run(id).changes > 0;
}

/** Point a tournament player at a person, or at nobody. */
export function linkPlayer(playerId, personId) {
  db.prepare("UPDATE players SET person_id = ? WHERE id = ?").run(personId ?? null, playerId);
}

/** Is this person linked to any player in this tournament? */
export function personInTournament(personId, tournamentId) {
  return Boolean(
    db.prepare("SELECT 1 FROM players WHERE person_id = ? AND tournament_id = ? LIMIT 1").get(personId, tournamentId),
  );
}
