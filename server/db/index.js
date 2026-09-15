/**
 * Database connection.
 *
 * SQLite via Node's built-in `node:sqlite` — no native module to compile, no
 * dependency to audit, and the whole database is one file you can copy to back
 * it up. For the traffic this sees (a few dozen phones on a touchline, a
 * tournament that fits in a handful of kilobytes) it is not a compromise; it is
 * the right size of tool.
 *
 * If this ever outgrows SQLite, every query lives behind server/db/repo/*.js —
 * that is the layer to reimplement, and nothing above it needs to change.
 * docs/ARCHITECTURE.md has the details.
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(env.databaseFile), { recursive: true });

export const db = new DatabaseSync(env.databaseFile);

// WAL lets readers carry on while a write is in flight, which matters when
// forty phones are polling the same tournament the referee is updating.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");

/**
 * Apply the schema, then any migrations. Every schema statement is IF NOT
 * EXISTS, so this is safe on every boot. `migrate: false` stops at the base
 * schema — only the migration tests want that, to seed data in the old shape.
 */
export function applySchema({ migrate = true } = {}) {
  const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(sql);
  if (migrate) applyMigrations();
}

/**
 * Numbered migrations for changes the base schema cannot express idempotently
 * (rebuilding a table, backfilling data). Files are `server/db/migrations/007-thing.sql`
 * and run once, in order, tracked by SQLite's own user_version counter.
 *
 * `schema.sql` is the starting point and is not edited for existing tables —
 * every change to one of those lives in a migration, so a fresh database and a
 * five-season-old one arrive at exactly the same shape.
 */
export function applyMigrations({ dir = path.join(here, "migrations"), log = console.log } = {}) {
  if (!fs.existsSync(dir)) return;

  const current = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  const pending = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, version: Number.parseInt(f, 10) }))
    .filter((m) => Number.isFinite(m.version) && m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const m of pending) {
    const sql = fs.readFileSync(path.join(dir, m.file), "utf8");

    // A migration that rebuilds a table must run with foreign keys off: with
    // them on, dropping the old table cascade-deletes every row that points at
    // it. It says so on its first line. The pragma cannot be changed inside a
    // transaction, so it is set before BEGIN and restored afterwards whatever
    // happens.
    const foreignKeysOff = /^\s*--\s*foreign_keys:\s*off\b/i.test(sql);
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");

    // Broken references that already existed are not this migration's fault
    // and must not stop the server starting. Only new ones count.
    const brokenBefore = foreignKeysOff ? db.prepare("PRAGMA foreign_key_check").all().length : 0;

    // Each migration is one transaction: it lands whole or not at all.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      if (foreignKeysOff) {
        const broken = db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length > brokenBefore) {
          const first = broken[broken.length - 1];
          throw new Error(
            `it would leave ${broken.length - brokenBefore} broken reference(s), for example ${first.table} → ${first.parent}`,
          );
        }
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      log(`[db] applied migration ${m.file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.file} failed and nothing was changed: ${err.message}`);
    } finally {
      if (foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction rather
 * than trying to start a second one, which SQLite does not allow.
 */
let depth = 0;
export function transaction(fn) {
  if (depth > 0) return fn();
  db.exec("BEGIN");
  depth++;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

/**
 * Short, URL-safe, collision-resistant id.
 *
 * Prefixed by type so an id is self-describing in a log line or a bug report —
 * `pl_k3f9x2a1` is obviously a player, which saves a lookup when reading an
 * audit trail. 8 base32 characters is 40 bits; at the scale of a few thousand
 * rows the collision probability is negligible, and every id column is a
 * primary key so a collision would fail loudly rather than corrupt anything.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford-ish: no i, l, o, u
export function newId(prefix) {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

/** Turn a name into a URL slug, with a numeric suffix if it is already taken. */
export function uniqueSlug(base) {
  const root =
    String(base || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tournament";

  const taken = db.prepare("SELECT slug FROM tournaments WHERE slug LIKE ?").all(`${root}%`);
  if (!taken.some((r) => r.slug.toLowerCase() === root)) return root;

  for (let n = 2; n < 500; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.some((r) => r.slug.toLowerCase() === candidate)) return candidate;
  }
  return `${root}-${newId()}`;
}

export function closeDatabase() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
