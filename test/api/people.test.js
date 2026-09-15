/**
 * The player roster over HTTP: who may change it, what counts as a photo, and
 * that a career follows a linked player.
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss, admin, referee, anon;
let T; // the tournament admin's tournament

/** The smallest valid WebP (a 1×1 lossless image). */
const TINY_WEBP = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);

async function upload(c, id, buf, type = "image/webp") {
  return c.call("PUT", `/api/people/${id}/photo`, undefined, { raw: buf, type });
}

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);

  T = (await boss.post("/api/tournaments", { name: "Cup", season: "2027" })).body.tournament;
  for (const [username, role] of [["cup-admin", "admin"], ["cup-ref", "referee"]]) {
    const res = await boss.post("/api/users", { username, name: username, password: "correct-horse-battery", role, tournamentId: T.id });
    assert.equal(res.status, 201);
  }
  admin = t.client();
  await admin.login("cup-admin", "correct-horse-battery");
  referee = t.client();
  await referee.login("cup-ref", "correct-horse-battery");
  anon = t.client();
});

after(() => t?.stop());

describe("the roster", () => {
  it("is public to read, but the rating note is the super admin's alone", async () => {
    const created = await boss.post("/api/people", { name: "Sadman Sabbir", pos: "GK", rating: 80, ratingNote: "Kept goal all tournament" });
    assert.equal(created.status, 201);

    const pub = (await anon.get("/api/people")).body.people.find((p) => p.name === "Sadman Sabbir");
    assert.equal(pub.rating, 80);
    assert.ok(!("ratingNote" in pub));
    assert.equal((await anon.get(`/api/people/${pub.id}`)).body.person.ratingNote, undefined);
    assert.equal((await boss.get(`/api/people/${pub.id}`)).body.person.ratingNote, "Kept goal all tournament");
  });

  it("lets a tournament admin add a newcomer, but not rate them", async () => {
    const res = await admin.post("/api/people", { name: "New Joiner", pos: "MID", rating: 99 });
    assert.equal(res.status, 201);
    assert.equal(res.body.person.rating, null);
  });

  it("does not let a tournament admin edit, rate or delete people", async () => {
    const { people } = (await anon.get("/api/people")).body;
    const someone = people[0];
    assert.equal((await admin.patch(`/api/people/${someone.id}`, { rating: 1 })).status, 403);
    assert.equal((await admin.patch(`/api/people/${someone.id}`, { name: "Renamed" })).status, 403);
    assert.equal((await admin.del(`/api/people/${someone.id}`)).status, 403);
  });

  it("is closed to referees and to anybody signed out", async () => {
    assert.equal((await referee.post("/api/people", { name: "X" })).status, 403);
    assert.equal((await anon.post("/api/people", { name: "X" })).status, 401);
  });

  it("closes to a tournament admin once their tournament is finished", async () => {
    const other = (await boss.post("/api/tournaments", { name: "Done Cup" })).body.tournament;
    await boss.post("/api/users", { username: "done-admin", name: "D", password: "correct-horse-battery", role: "admin", tournamentId: other.id });
    await boss.patch(`/api/tournaments/${other.id}`, { status: "completed" });
    const c = t.client();
    await c.login("done-admin", "correct-horse-battery");
    assert.equal((await c.post("/api/people", { name: "Late" })).status, 403);
  });

  it("checks a rating is 1–99", async () => {
    const { people } = (await anon.get("/api/people")).body;
    assert.equal((await boss.patch(`/api/people/${people[0].id}`, { rating: 0 })).status, 400);
    assert.equal((await boss.patch(`/api/people/${people[0].id}`, { rating: 100 })).status, 400);
    assert.equal((await boss.patch(`/api/people/${people[0].id}`, { rating: 7.5 })).status, 400);
    assert.equal((await boss.patch(`/api/people/${people[0].id}`, { rating: null })).status, 200, "clearing it is fine");
  });
});

describe("photos", () => {
  let person;
  before(async () => {
    person = (await boss.post("/api/people", { name: "Mahmud Hasan Munna", pos: "FWD" })).body.person;
  });

  it("are stored, served with a long cache, and replaced cleanly", async () => {
    const first = await upload(boss, person.id, TINY_WEBP);
    assert.equal(first.status, 200, first.body?.error?.message);
    const url1 = first.body.person.photoUrl;
    assert.match(url1, /^\/media\/photos\/pp_[0-9a-z]{8}-[0-9a-f]{12}\.webp$/);

    const res = await fetch(t.base + url1);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.match(res.headers.get("cache-control"), /immutable/);

    const second = await upload(boss, person.id, TINY_WEBP);
    const url2 = second.body.person.photoUrl;
    assert.notEqual(url2, url1, "a new name, so nobody is shown the old face from cache");
    assert.equal((await fetch(t.base + url1)).status, 404, "the old file is deleted");
  });

  it("must actually be an image, whatever the request says", async () => {
    const res = await upload(boss, person.id, Buffer.from("<html><script>alert(1)</script></html>"), "image/png");
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not a JPEG, PNG or WebP/);
  });

  it("are refused when far too large, with a sentence that says what to do", async () => {
    const res = await upload(boss, person.id, Buffer.alloc(700 * 1024, 1));
    assert.equal(res.status, 413);
    assert.match(res.body.error.message, /admin console/);
  });

  it("serve nothing that is not a stored photo", async () => {
    for (const probe of ["..%2F..%2Fwegro.sqlite", "wegro.sqlite", "..%5Cwegro.sqlite", "x.webp"]) {
      assert.equal((await fetch(`${t.base}/media/photos/${probe}`)).status, 404, probe);
    }
  });

  it("can be changed by a tournament admin only for their own players", async () => {
    assert.equal((await upload(admin, person.id, TINY_WEBP)).status, 403);

    const mine = (await admin.post("/api/people", { name: "Their Newcomer" })).body.person;
    assert.equal((await upload(admin, mine.id, TINY_WEBP)).status, 200, "someone they added");

    const team = (await admin.post(`/api/tournaments/${T.id}/teams`, { name: "Blue" })).body;
    assert.ok(team);
    const doc = (await admin.post(`/api/tournaments/${T.id}/players`, { name: "Munna", pos: "FWD", kind: "auction" })).body.tournament;
    const player = Object.values(doc.players).find((p) => p.name === "Munna");
    assert.equal((await admin.post(`/api/tournaments/${T.id}/players/${player.id}/person`, { personId: person.id })).status, 200);
    assert.equal((await upload(admin, person.id, TINY_WEBP)).status, 200, "someone in their tournament");
  });

  it("can be removed, which deletes the file", async () => {
    const url = (await anon.get(`/api/people/${person.id}`)).body.person.photoUrl;
    const res = await boss.del(`/api/people/${person.id}/photo`);
    assert.equal(res.status, 200);
    assert.equal(res.body.person.photoUrl, null);
    assert.equal((await fetch(t.base + url)).status, 404);
  });
});

describe("linking and careers", () => {
  it("shows a linked player's photo on the tournament, and their goals in their career", async () => {
    const person = (await boss.post("/api/people", { name: "Anirban Saha", pos: "DEF" })).body.person;
    await upload(boss, person.id, TINY_WEBP);

    const teams = await boss.post(`/api/tournaments/${T.id}/teams`, { name: "Red" });
    const red = Object.values(teams.body.tournament.teams).find((x) => x.name === "Red");
    const doc = (await boss.post(`/api/tournaments/${T.id}/players`, { name: "Anirban", pos: "DEF", kind: "guest", teamId: red.id })).body.tournament;
    const player = Object.values(doc.players).find((p) => p.name === "Anirban");

    const linked = await boss.post(`/api/tournaments/${T.id}/players/${player.id}/person`, { personId: person.id });
    assert.equal(linked.status, 200);
    const inDoc = linked.body.tournament.players[player.id];
    assert.equal(inDoc.personId, person.id);
    assert.match(inDoc.photo, /^\/media\/photos\//);

    // Published, a match and a goal: the career follows.
    await boss.patch(`/api/tournaments/${T.id}`, { status: "active" });
    const blue = Object.values(linked.body.tournament.teams).find((x) => x.name === "Blue");
    const m = (await boss.post(`/api/tournaments/${T.id}/matches`, { homeId: red.id, awayId: blue.id })).body.tournament;
    const match = Object.values(m.matches)[0];
    await boss.post(`/api/tournaments/${T.id}/matches/${match.id}/events`, { type: "goal", teamId: red.id, playerId: player.id });

    const career = (await anon.get(`/api/people/${person.id}`)).body.person;
    assert.equal(career.totals.goals, 1);
    assert.equal(career.tournaments[0].name, "Cup");
  });

  it("refuses to link a player from another tournament through this one", async () => {
    const other = (await boss.post("/api/tournaments", { name: "Elsewhere" })).body.tournament;
    const doc = (await boss.post(`/api/tournaments/${other.id}/players`, { name: "Stranger", pos: "MID" })).body.tournament;
    const stranger = Object.values(doc.players)[0];
    const person = (await anon.get("/api/people")).body.people[0];
    const res = await boss.post(`/api/tournaments/${T.id}/players/${stranger.id}/person`, { personId: person.id });
    assert.equal(res.status, 404);
  });
});

describe("backups", () => {
  it("include the photos and the roster", async () => {
    const { runBackup } = await import("../../tools/backup.js");
    const dir = path.join(path.dirname(t.dataDir ?? ""), `wgt-backup-${Date.now()}`);
    const result = runBackup({ dir });
    assert.ok(result.photos >= 1, "at least one photo copied");
    assert.equal(fs.readdirSync(result.photosPath).length, result.photos);
    assert.ok(result.counts.people >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
