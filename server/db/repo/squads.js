/** Teams and players. */

import { db, newId, transaction } from "../index.js";

/* ------------------------------------------------------------------ teams */

export function createTeam(tournamentId, { name, slot = "", jerseyColor = null, jerseyLabel = "", jerseyCost = 0, squadSize = null }) {
  const id = newId("tm");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ?").get(tournamentId);
  db.prepare(
    `INSERT INTO teams (id, tournament_id, slot, name, jersey_color, jersey_label, jersey_cost, squad_size, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tournamentId, slot || String.fromCharCode(65 + n), name, jerseyColor, jerseyLabel, jerseyCost, squadSize, n);
  return id;
}

const TEAM_COLUMNS = {
  name: "name",
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

export function deleteTeam(teamId) {
  return transaction(() => {
    // Players are released rather than deleted: a bought player belongs to the
    // pool, not to the team that happened to buy them, and deleting them would
    // take their match history with them.
    db.prepare("UPDATE players SET team_id = NULL, price = NULL WHERE team_id = ? AND kind = 'auction'").run(teamId);
    // A captain or guest exists only in relation to their team, so they go.
    db.prepare("DELETE FROM players WHERE team_id = ? AND kind IN ('captain', 'guest')").run(teamId);
    return db.prepare("DELETE FROM teams WHERE id = ?").run(teamId).changes > 0;
  });
}

/* ---------------------------------------------------------------- players */

export function createPlayer(tournamentId, { name, pos, teamId = null, price = null, kind = "auction", photo = null }) {
  const id = newId("pl");
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM players WHERE tournament_id = ?").get(tournamentId);
  db.prepare(
    `INSERT INTO players (id, tournament_id, team_id, name, pos, kind, price, photo, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, tournamentId, teamId, name, pos, kind, price, photo, n);
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
