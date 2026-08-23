/**
 * Standalone migration runner — `npm run migrate`.
 *
 * The server applies the schema on boot anyway, so this exists for the cases
 * where you want to prepare or inspect a database without starting anything:
 * before a restore, inside a deploy step, or when checking what a fresh
 * database looks like.
 */

import { applySchema, db, closeDatabase } from "./index.js";
import { env } from "../env.js";

applySchema();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const version = db.prepare("PRAGMA user_version").get().user_version ?? 0;

console.log(`Database : ${env.databaseFile}`);
console.log(`Version  : ${version}`);
console.log(`Tables   : ${tables.join(", ")}`);

for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
  console.log(`  ${t.padEnd(18)} ${n} row${n === 1 ? "" : "s"}`);
}

closeDatabase();
