/** Teams and players. */

import { db, newId, transaction } from "../index.js";

/* ------------------------------------------------------------------ teams */

export function createTeam(
  tournamentId,
  { name, slot = "", jerseyColor = null, jerseyLabel = "", jerseyCost = 0, squadSize = null, group = null },
) {
  const id = newId("tm");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ?").get(tournamentId);
  db.prepare(
    `INSERT INTO teams (id, tournament_id, slot, name, jersey_color, jersey_label, jersey_cost, squad_size, sort_order, group_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tournamentId, slot || String.fromCharCode(65 + n), name, jerseyColor, jerseyLabel, jerseyCost, squadSize, n, group);
  return id;
}

const TEAM_COLUMNS = {
  name: "name",
  group: "group_label",
  slot: "slot",
  jerseyColor: "jersey_color",
  jerseyLabel: "jersey_label",
  jerseyCost: "jersey_cost",
  squadSize: "squad_size",
};

export function updateTeam(teamId, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(TEAM_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (!sets.length) return false;
  args.push(teamId);
  return db.prepare(`UPDATE teams SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes > 0;
}

/**
 * `releaseToPool` is what a bought player is owed and what a pair member is
 * not. In a football tournament a player belongs to the auction pool, not to
 * the team that happened to buy them, so removing the team puts them back up
 * for sale. A gaming tournament has no pool: the team *is* the pair, and a
 * member left behind would be a player on no team, invisible in a console that
 * only lists teams — and still counted as taken, so their name never came back
 * to the picker.
 */
export function deleteTeam(teamId, { releaseToPool = true } = {}) {
  return transaction(() => {
    if (releaseToPool) {
      db.prepare("UPDATE players SET team_id = NULL, price = NULL WHERE team_id = ? AND kind = 'auction'").run(teamId);
    } else {
      db.prepare("DELETE FROM players WHERE team_id = ? AND kind = 'auction'").run(teamId);
    }
    // A captain or guest exists only in relation to their team, so they go.
    db.prepare("DELETE FROM players WHERE team_id = ? AND kind IN ('captain', 'guest')").run(teamId);
    return db.prepare("DELETE FROM teams WHERE id = ?").run(teamId).changes > 0;
  });
}

/**
 * A row for this person with no team. One person is one player in a
 * tournament, so putting them in a team moves this row rather than adding a
 * second one — which is also how someone stranded by an earlier removal finds
 * their way back into a team.
 */
export function teamlessPlayerForPerson(tournamentId, personId) {
  const row = db
    .prepare("SELECT id FROM players WHERE tournament_id = ? AND person_id = ? AND team_id IS NULL ORDER BY sort_order LIMIT 1")
    .get(tournamentId, personId);
  return row?.id ?? null;
}

/* ---------------------------------------------------------------- players */

export function createPlayer(
  tournamentId,
  { name, pos, teamId = null, price = null, kind = "auction", photo = null, personId = null },
) {
  const id = newId("pl");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM players WHERE tournament_id = ?").get(tournamentId);
  db.prepare(
    `INSERT INTO players (id, tournament_id, team_id, name, pos, kind, price, photo, sort_order, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tournamentId, teamId, name, pos, kind, price, photo, n, personId);
  return id;
}

const PLAYER_COLUMNS = {
  name: "name",
  pos: "pos",
  teamId: "team_id",
  price: "price",
  kind: "kind",
  photo: "photo",
};

export function updatePlayer(playerId, patch) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(PLAYER_COLUMNS)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      args.push(patch[key]);
    }
  }
  if (!sets.length) return false;
  args.push(playerId);
  return db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ?`).run(...args).changes > 0;
}

export function deletePlayer(playerId) {
  return db.prepare("DELETE FROM players WHERE id = ?").run(playerId).changes > 0;
}

export function getPlayer(playerId) {
  return db.prepare("SELECT * FROM players WHERE id = ?").get(playerId) ?? null;
}

/** Sell a player, or unsell by passing a null team. One statement, so it is atomic. */
export function setPlayerTeam(playerId, teamId, price) {
  return (
    db.prepare("UPDATE players SET team_id = ?, price = ? WHERE id = ?").run(teamId, price, playerId)
      .changes > 0
  );
}

/** Return every bought player to the pool and refund the jerseys. */
export function resetAuction(tournamentId) {
  return transaction(() => {
    db.prepare(
      "UPDATE players SET team_id = NULL, price = NULL WHERE tournament_id = ? AND kind = 'auction'",
    ).run(tournamentId);
    db.prepare(
      "UPDATE teams SET jersey_color = NULL, jersey_label = '', jersey_cost = 0 WHERE tournament_id = ?",
    ).run(tournamentId);
  });
}
