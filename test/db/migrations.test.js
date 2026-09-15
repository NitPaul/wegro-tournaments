/**
 * Migrations, run against data in the shape it had before them.
 *
 * These are the changes that touch a live database on deploy, so each test
 * seeds rows exactly as the previous version wrote them and checks that nothing
 * a person relies on is lost: sessions, staff assignments, audit history, the
 * 2026 tournament.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let dbm;
let workDir;

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wgt-migrate-"));
  process.env.DATA_DIR = workDir;
  process.env.SESSION_SECRET = "test".repeat(12);
  process.env.NODE_ENV = "test";
  dbm = await import("../../server/db/index.js");
});

after(() => {
  dbm?.closeDatabase();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const quiet = () => {};

/** A fresh database at version 0 — the base schema, no migrations. */
function resetToBase() {
  const { db } = dbm;
  db.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    db.exec(`DROP TABLE "${name}"`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA user_version = 0");
  dbm.applySchema({ migrate: false });
}

/** Rows written the way the version before 001 wrote them. */
function seedLegacy() {
  const { db } = dbm;
  const t0 = 1_780_000_000_000;
  const user = db.prepare(
    `INSERT INTO users (id, email, password_hash, name, is_super, status, created_at)
     VALUES (?, ?, 'scrypt$x', ?, ?, ?, ?)`,
  );
  user.run("us_boss", "aonyendopaul@gmail.com", "Boss", 1, "active", t0);
  user.run("us_ref", "faquid@wegro.global", "Faquid", 0, "active", t0 + 1);
  user.run("us_twin", "faquid@example.com", "Other Faquid", 0, "active", t0 + 2);
  user.run("us_wait", "newbie@wegro.global", "Newbie", 0, "pending", t0 + 3);

  const tour = db.prepare(
    `INSERT INTO tournaments (id, slug, name, season, format, status, created_at)
     VALUES (?, ?, ?, '2026', 'league', ?, ?)`,
  );
  tour.run("tn_2026", "wegro-champions-league-2026", "WeGro Champions League", "completed", t0);
  tour.run("tn_friendly", "friendly", "Friendly", "active", t0 + 10);

  db.prepare("INSERT INTO teams (id, tournament_id, name) VALUES ('tm_1', 'tn_2026', 'SHOMOGRO')").run();
  db.prepare(
    `INSERT INTO players (id, tournament_id, team_id, name, pos, kind)
     VALUES ('pl_1', 'tn_2026', 'tm_1', 'Munna', 'FWD', 'auction')`,
  ).run();

  const staff = db.prepare(
    `INSERT INTO tournament_staff (tournament_id, user_id, role, assigned_by, assigned_at) VALUES (?, ?, ?, 'us_boss', ?)`,
  );
  // Faquid refereed 2026, then was made admin of the friendly later.
  staff.run("tn_2026", "us_ref", "referee", t0 + 100);
  staff.run("tn_friendly", "us_ref", "admin", t0 + 200);
  staff.run("tn_2026", "us_twin", "referee", t0 + 150);

  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('sess_boss', 'us_boss', ?, ?)`,
  ).run(t0, t0 + 10 ** 12);
  db.prepare(
    `INSERT INTO audit_log (user_id, user_email, tournament_id, action, at) VALUES ('us_ref', 'faquid@wegro.global', 'tn_2026', 'event.add', ?)`,
  ).run(t0 + 500);
}

describe("migration 001 — accounts and codes", () => {
  it("gives every existing account a User ID from its email", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });

    const names = Object.fromEntries(
      dbm.db.prepare("SELECT id, username FROM users").all().map((r) => [r.id, r.username]),
    );
    assert.equal(names.us_boss, "aonyendopaul");
    assert.equal(names.us_ref, "faquid");
    assert.equal(names.us_twin, "faquid-2", "a clash gets a suffix, and the older account keeps the plain one");
  });

  it("keeps emails, so an existing admin can still sign in with theirs", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    const row = dbm.db.prepare("SELECT email, password_hash, is_super FROM users WHERE id = 'us_boss'").get();
    assert.equal(row.email, "aonyendopaul@gmail.com");
    assert.equal(row.password_hash, "scrypt$x");
    assert.equal(row.is_super, 1);
  });

  it("turns an account still waiting for approval into a disabled one, never an active one", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    assert.equal(dbm.db.prepare("SELECT status FROM users WHERE id = 'us_wait'").get().status, "disabled");
  });

  it("lets a new account have no email at all", () => {
    resetToBase();
    dbm.applyMigrations({ log: quiet });
    dbm.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, name, created_at) VALUES ('us_a', 'ref-one', 'h', 'A', 1)`,
      )
      .run();
    dbm.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, name, created_at) VALUES ('us_b', 'ref-two', 'h', 'B', 1)`,
      )
      .run();
    assert.equal(dbm.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email IS NULL").get().n, 2);
  });

  it("does not lose a single session, staff row, player or audit entry to the table rebuild", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    const count = (t) => dbm.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.equal(count("sessions"), 1, "the super admin stays signed in");
    assert.equal(count("players"), 1);
    assert.equal(count("teams"), 1);
    assert.ok(count("audit_log") >= 1);
    assert.equal(dbm.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  });

  it("leaves foreign keys switched on afterwards", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    assert.equal(dbm.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    // And they bite: a session for nobody is refused.
    assert.throws(() =>
      dbm.db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('x', 'nobody', 1, 2)").run(),
    );
  });

  it("gives every tournament a unique permanent code", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    const codes = dbm.db.prepare("SELECT code FROM tournaments").all().map((r) => r.code);
    assert.equal(codes.length, 2);
    for (const c of codes) assert.match(c, /^WGT-[0-9A-F]{6}$/);
    assert.notEqual(codes[0], codes[1]);
  });

  it("keeps only the most recent tournament for an account that had two, and records the removal", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });

    const faquid = dbm.db
      .prepare("SELECT tournament_id, role FROM tournament_staff WHERE user_id = 'us_ref'")
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(faquid, [{ tournament_id: "tn_friendly", role: "admin" }]);

    const trail = dbm.db
      .prepare("SELECT * FROM audit_log WHERE action = 'staff.remove' AND user_id = 'us_ref'")
      .all();
    assert.equal(trail.length, 1, "the removed assignment is written down, not silently dropped");
    assert.equal(trail[0].tournament_id, "tn_2026");
    assert.equal(trail[0].username, "faquid");
    assert.match(JSON.parse(trail[0].detail_json).reason, /one tournament/);

    // Someone with a single assignment is untouched.
    assert.equal(
      dbm.db.prepare("SELECT COUNT(*) AS n FROM tournament_staff WHERE user_id = 'us_twin'").get().n,
      1,
    );
  });

  it("refuses a second assignment for the same account from now on", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    assert.throws(
      () =>
        dbm.db
          .prepare(
            "INSERT INTO tournament_staff (tournament_id, user_id, role, assigned_at) VALUES ('tn_2026', 'us_ref', 'referee', 1)",
          )
          .run(),
      /UNIQUE/,
    );
  });

  it("records version 1 only once it has succeeded", () => {
    resetToBase();
    seedLegacy();
    dbm.applyMigrations({ log: quiet });
    assert.equal(dbm.db.prepare("PRAGMA user_version").get().user_version, 1);
    // Running again is a no-op rather than a second rebuild.
    dbm.applyMigrations({ log: quiet });
    assert.equal(dbm.db.prepare("PRAGMA user_version").get().user_version, 1);
  });
});

describe("the migration runner", () => {
  it("rolls a failing migration back completely and names it", () => {
    resetToBase();
    const dir = fs.mkdtempSync(path.join(workDir, "bad-"));
    fs.writeFileSync(
      path.join(dir, "001-half-done.sql"),
      "CREATE TABLE should_not_exist (id INTEGER);\nINSERT INTO no_such_table VALUES (1);\n",
    );

    assert.throws(() => dbm.applyMigrations({ dir, log: quiet }), /001-half-done\.sql failed and nothing was changed/);
    assert.equal(
      dbm.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'should_not_exist'").get().n,
      0,
    );
    assert.equal(dbm.db.prepare("PRAGMA user_version").get().user_version, 0);
  });

  it("refuses a foreign-keys-off migration that would leave broken references", () => {
    resetToBase();
    seedLegacy();
    const dir = fs.mkdtempSync(path.join(workDir, "fk-"));
    fs.writeFileSync(path.join(dir, "001-orphan.sql"), "-- foreign_keys: off\nDELETE FROM users WHERE id = 'us_boss';\n");

    assert.throws(() => dbm.applyMigrations({ dir, log: quiet }), /broken reference/);
    assert.equal(dbm.db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'us_boss'").get().n, 1, "rolled back");
    assert.equal(dbm.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "and foreign keys are back on");
  });
});
