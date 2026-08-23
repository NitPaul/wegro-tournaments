/**
 * Restore from a JSON backup — `npm run restore <file.json>`.
 *
 * This REPLACES everything. It refuses to run against a database that already
 * has tournaments in it unless you pass --force, because "restore" typed into
 * the wrong terminal is how a season disappears.
 *
 * To restore from the `.sqlite` copy instead — which is faster, exact, and the
 * right choice for disaster recovery — stop the container and put the file in
 * place of the live one:
 *
 *   docker compose down
 *   docker run --rm -v wegro-data:/data -v "$PWD/backups:/b" alpine \
 *     sh -c 'cp /b/wegro-<timestamp>.sqlite /data/wegro.sqlite'
 *   docker compose up -d
 *
 * Use this JSON path when the backup came from a different version, or when you
 * want to inspect or edit the data on the way in.
 */

import fs from "node:fs";
import process from "node:process";

import { applySchema, closeDatabase, db, transaction } from "../server/db/index.js";

// Children before parents on delete, parents before children on insert.
const ORDER = [
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

export function runRestore(file, { force = false } = {}) {
  if (!file) throw new Error("Give the path to a .json backup.");
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);

  const dump = JSON.parse(fs.readFileSync(file, "utf8"));
  if (dump._format !== "wegro-tournaments") {
    throw new Error(
      `That is not a WeGro Tournaments backup (found _format "${dump._format ?? "none"}"). ` +
        "To bring in data from the old Firebase site, use `npm run import:firebase` instead.",
    );
  }

  applySchema();

  const existing = db.prepare("SELECT COUNT(*) AS n FROM tournaments").get().n;
  if (existing > 0 && !force) {
    throw new Error(
      `This database already has ${existing} tournament${existing === 1 ? "" : "s"}. ` +
        "Restoring would delete them. Re-run with --force if that is what you want.",
    );
  }

  const counts = {};

  transaction(() => {
    // Foreign keys off for the duration: rows arrive parents-first, but a
    // half-restored database trips constraints that are perfectly satisfied
    // once every table is in. The transaction still makes it all-or-nothing.
    db.exec("PRAGMA foreign_keys = OFF");

    for (const table of [...ORDER].reverse()) db.exec(`DELETE FROM "${table}"`);

    for (const table of ORDER) {
      const rows = dump.tables?.[table] ?? [];
      counts[table] = rows.length;
      if (!rows.length) continue;

      const columns = Object.keys(rows[0]);
      const insert = db.prepare(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const row of rows) insert.run(...columns.map((c) => row[c] ?? null));
    }

    db.exec("PRAGMA foreign_keys = ON");

    // Prove the restored data is actually self-consistent before committing.
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length) {
      throw new Error(
        `Restored data has ${broken.length} broken reference(s), first in table "${broken[0].table}". Nothing was changed.`,
      );
    }
  });

  return counts;
}

if (process.argv[1]?.endsWith("restore.js")) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const file = args.find((a) => !a.startsWith("--"));

  try {
    const counts = runRestore(file, { force });
    console.log(`Restored from ${file}\n`);
    for (const [table, n] of Object.entries(counts)) {
      console.log(`  ${table.padEnd(18)} ${n} row${n === 1 ? "" : "s"}`);
    }
  } catch (err) {
    console.error(`\nRestore failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
