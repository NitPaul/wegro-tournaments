/**
 * Back up everything — `npm run backup`.
 *
 * Writes two files, because they answer different questions:
 *
 *   wegro-<timestamp>.sqlite   an exact copy of the database, for restoring
 *                              this system quickly and completely
 *   wegro-<timestamp>.json     a readable dump, for reading the data without
 *                              this software, moving it somewhere else, or
 *                              checking what was in it two seasons later
 *
 * The `.sqlite` copy uses VACUUM INTO, which SQLite guarantees is a consistent
 * snapshot even while the server is running and the referee is mid-match. That
 * matters: copying the file with `cp` while a write is in flight can produce a
 * backup that will not open.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { db, closeDatabase, applySchema } from "../server/db/index.js";
import { env } from "../server/env.js";

const TABLES = [
  "users",
  "tournaments",
  "tournament_staff",
  "teams",
  "players",
  "matches",
  "events",
  "archive",
  "audit_log",
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function runBackup({ dir = env.backupDir, includeUsers = true } = {}) {
  applySchema();
  fs.mkdirSync(dir, { recursive: true });

  const when = stamp();
  const sqlitePath = path.join(dir, `wegro-${when}.sqlite`);
  const jsonPath = path.join(dir, `wegro-${when}.json`);

  // VACUUM INTO refuses to overwrite, which is the behaviour we want.
  db.exec(`VACUUM INTO '${sqlitePath.replace(/'/g, "''")}'`);

  const dump = {
    _format: "wegro-tournaments",
    _version: 1,
    _exportedAt: new Date().toISOString(),
    tables: {},
  };

  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    // Password hashes are useless to an attacker but pointless to hand around.
    // The .sqlite copy still has them, so a full restore is unaffected.
    dump.tables[table] =
      table === "users" && !includeUsers
        ? rows.map(({ password_hash, ...rest }) => rest)
        : rows;
  }

  fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2));

  const counts = Object.fromEntries(Object.entries(dump.tables).map(([t, rows]) => [t, rows.length]));
  return { sqlitePath, jsonPath, counts };
}

// Run directly rather than imported.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("backup.js")) {
  const result = runBackup();

  console.log("Backup complete.\n");
  console.log(`  database : ${result.sqlitePath}`);
  console.log(`  json     : ${result.jsonPath}\n`);
  for (const [table, n] of Object.entries(result.counts)) {
    console.log(`  ${table.padEnd(18)} ${n} row${n === 1 ? "" : "s"}`);
  }
  console.log("\nKeep these somewhere that is not this server.");

  closeDatabase();
}
