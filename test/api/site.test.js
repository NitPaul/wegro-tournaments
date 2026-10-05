/**
 * Site-wide administration: the backups that let the whole thing be rebuilt,
 * and the overview that says how this instance is set up.
 *
 * Who may do this matters as much as what it does — a full backup contains
 * every tournament and every account, so it belongs to the super admin alone,
 * while a tournament's own copy belongs to the people running it.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss, admin, referee, anon;
let T;

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);
  anon = t.client();

  T = (await boss.post("/api/tournaments", { name: "Site Cup", season: "2027" })).body.tournament;
  for (const [username, role] of [["cup-admin", "admin"], ["cup-ref", "referee"]]) {
    await boss.post("/api/users", { username, name: username, password: "correct-horse-battery", role, tournamentId: T.id });
  }
  admin = t.client();
  await admin.login("cup-admin", "correct-horse-battery");
  referee = t.client();
  await referee.login("cup-ref", "correct-horse-battery");
});

after(() => t?.stop());

describe("the site overview", () => {
  it("says what is here and how it is configured", async () => {
    const res = await boss.get("/api/site/overview");
    assert.equal(res.status, 200);

    const { counts, database, photos, config } = res.body;
    assert.equal(counts.tournaments, 1);
    assert.equal(counts.users, 3);
    assert.ok(database.bytes > 0, "the database file has a size");
    assert.ok(database.version >= 3, "the schema version is reported");
    assert.equal(photos.count, 0);
    assert.ok(config.dataDir);
    assert.ok(config.node.startsWith("v"));
  });

  it("names a configuration that would break the live site", async () => {
    // The test server runs on 127.0.0.1, which is exactly the mistake this is
    // meant to catch on a real one.
    const { warnings } = (await boss.get("/api/site/overview")).body;
    assert.ok(
      warnings.some((w) => w.key === "public-url"),
      "a localhost PUBLIC_URL is reported",
    );
  });

  it("is not something a tournament admin, a referee or a stranger can read", async () => {
    for (const client of [admin, referee, anon]) {
      const res = await client.get("/api/site/overview");
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    }
  });

  it("leaves the public headline numbers public", async () => {
    const res = await anon.get("/api/site");
    assert.equal(res.status, 200);
    assert.ok(res.body.totals);
  });
});

describe("the full backup", () => {
  it("downloads the database as a file that is really a database", async () => {
    const res = await boss.raw("GET", "/api/site/backup.sqlite");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="wegro-.*\.sqlite"/);

    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 15).toString("ascii"), "SQLite format 3", "the magic header");
    assert.ok(bytes.length > 1000);
  });

  it("downloads everything in one archive, photos included", async () => {
    const res = await boss.raw("GET", "/api/site/backup.zip");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");

    const zipped = Buffer.from(await res.arrayBuffer());
    assert.equal(zipped.subarray(0, 2).toString("ascii"), "PK");
    const names = zipped.toString("latin1");
    for (const name of ["wegro.sqlite", "wegro.json", "README.txt"]) {
      assert.ok(names.includes(name), `${name} is in the archive`);
    }
  });

  it("downloads a readable dump without password hashes in it", async () => {
    const res = await boss.get("/api/site/backup.json");
    assert.equal(res.status, 200);
    assert.equal(res.body._format, "wegro-tournaments");
    assert.equal(res.body.tables.tournaments.length, 1);
    assert.ok(res.body.tables.users.length > 0);
    assert.ok(
      res.body.tables.users.every((u) => u.password_hash === undefined),
      "hashes stay in the .sqlite copy only",
    );
  });

  it("writes a copy on the server too, and lists what is there", async () => {
    const res = await boss.post("/api/site/backup", {});
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.match(res.body.backup.database, /^wegro-.*\.sqlite$/);
    assert.equal(res.body.backup.counts.tournaments, 1);
    assert.ok(res.body.backups.some((b) => b.name === res.body.backup.database));

    const { backups } = (await boss.get("/api/site/overview")).body;
    assert.ok(backups.length >= 2, "the .sqlite and the .json both show up");
  });

  it("belongs to the super admin alone", async () => {
    for (const url of ["/api/site/backup.zip", "/api/site/backup.sqlite", "/api/site/backup.json"]) {
      for (const client of [admin, referee, anon]) {
        const res = await client.get(url);
        assert.ok(res.status === 401 || res.status === 403, `${url} as a non-super gave ${res.status}`);
      }
    }
    assert.ok([401, 403].includes((await admin.post("/api/site/backup", {})).status));
  });
});

describe("one tournament's own copy", () => {
  it("is downloaded by the people running it", async () => {
    const res = await admin.get(`/api/tournaments/${T.id}/export`);
    assert.equal(res.status, 200);
    assert.equal(res.body._format, "wegro-tournaments-single");
    assert.equal(res.body.tournament.name, "Site Cup");
  });

  it("names the file after the tournament and the day", async () => {
    const res = await admin.raw("GET", `/api/tournaments/${T.id}/export`);
    assert.match(res.headers.get("content-disposition") ?? "", /filename="site-cup-2027-\d{4}-\d{2}-\d{2}\.json"/);
  });

  it("holds that tournament and nothing else — no accounts, no other tournaments", async () => {
    const { tournament } = (await admin.get(`/api/tournaments/${T.id}/export`)).body;
    assert.deepEqual(Object.keys(tournament).sort().includes("users"), false);
    assert.equal(tournament.id, T.id);
  });

  it("is not for a referee, and not for a stranger", async () => {
    assert.equal((await referee.get(`/api/tournaments/${T.id}/export`)).status, 403);
    assert.ok([401, 403, 404].includes((await anon.get(`/api/tournaments/${T.id}/export`)).status));
  });
});
