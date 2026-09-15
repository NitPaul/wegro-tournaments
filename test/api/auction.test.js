/**
 * Building a tournament from the roster, and the auction's "on the block".
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss, admin, referee;
let T;
const roster = {};

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);

  T = (await boss.post("/api/tournaments", { name: "Auction Cup" })).body.tournament;
  await boss.post("/api/users", { username: "cup-admin", name: "A", password: "correct-horse-battery", role: "admin", tournamentId: T.id });
  await boss.post("/api/users", { username: "cup-ref", name: "R", password: "correct-horse-battery", role: "referee", tournamentId: T.id });
  admin = t.client();
  await admin.login("cup-admin", "correct-horse-battery");
  referee = t.client();
  await referee.login("cup-ref", "correct-horse-battery");

  for (const [name, pos] of [["Sadman Sabbir", "GK"], ["Anirban Saha", "DEF"], ["Mahmud Hasan Munna", "FWD"], ["Md Mehedi Hasan", "MID"], ["No Position Yet", null]]) {
    roster[name] = (await boss.post("/api/people", { name, pos })).body.person;
  }
});

after(() => t?.stop());

describe("adding players from the roster", () => {
  it("adds them matched to their roster person, with their position", async () => {
    const ids = ["Sadman Sabbir", "Anirban Saha", "Mahmud Hasan Munna"].map((n) => roster[n].id);
    const res = await admin.post(`/api/tournaments/${T.id}/players/from-roster`, { personIds: ids });
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.deepEqual(res.body.added.sort(), ["Anirban Saha", "Mahmud Hasan Munna", "Sadman Sabbir"]);

    const players = Object.values(res.body.tournament.players);
    const sabbir = players.find((p) => p.name === "Sadman Sabbir");
    assert.equal(sabbir.personId, roster["Sadman Sabbir"].id);
    assert.equal(sabbir.pos, "GK");
    assert.equal(sabbir.kind, "auction");
    assert.equal(sabbir.teamId, null, "into the pool, unsold");
  });

  it("skips anyone already in the tournament, and anyone without a position, and says why", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/players/from-roster`, {
      personIds: [roster["Sadman Sabbir"].id, roster["No Position Yet"].id],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added, []);
    assert.deepEqual(
      res.body.skipped.map((s) => [s.name, /already/.test(s.reason) ? "already" : /position/.test(s.reason) ? "position" : s.reason]),
      [["Sadman Sabbir", "already"], ["No Position Yet", "position"]],
    );
  });

  it("is not for referees", async () => {
    assert.equal((await referee.post(`/api/tournaments/${T.id}/players/from-roster`, { personIds: [roster["Md Mehedi Hasan"].id] })).status, 403);
  });

  it("can name a captain from the roster when a team is created", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/teams`, { name: "SHOMOGRO", captainPersonId: roster["Md Mehedi Hasan"].id });
    assert.equal(res.status, 200, res.body?.error?.message);
    const captain = Object.values(res.body.tournament.players).find((p) => p.kind === "captain");
    assert.equal(captain.name, "Md Mehedi Hasan");
    assert.equal(captain.personId, roster["Md Mehedi Hasan"].id);
    assert.equal(captain.pos, "MID");
  });
});

describe("on the block", () => {
  let doc;
  const byName = (name) => Object.values(doc.players).find((p) => p.name === name);

  before(async () => {
    // A three-player pool cannot satisfy "every squad needs one of each
    // position", and the auction rightly refuses sales that would strand a
    // squad. These tests are about the block, not squad shape.
    await admin.post(`/api/tournaments/${T.id}/settings`, { minPerCategory: 0 });
    doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
  });

  it("puts an unsold player up, visible to the signed-out projector screen", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/auction/block`, { playerId: byName("Mahmud Hasan Munna").id });
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.equal(res.body.tournament.settings.auctionOnBlock, byName("Mahmud Hasan Munna").id);

    await boss.patch(`/api/tournaments/${T.id}`, { status: "active" });
    const pub = (await t.client().get(`/api/tournaments/${T.id}`)).body.tournament;
    assert.equal(pub.settings.auctionOnBlock, byName("Mahmud Hasan Munna").id, "the projector, signed out, sees it too");
  });

  it("takes the player off the block when they are sold", async () => {
    const team = Object.values(doc.teams)[0];
    const munna = byName("Mahmud Hasan Munna");
    const res = await admin.post(`/api/tournaments/${T.id}/auction/sell`, { playerId: munna.id, teamId: team.id, price: 12 });
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.equal(res.body.tournament.settings.auctionOnBlock, null);
  });

  it("refuses to put up someone already sold", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/auction/block`, { playerId: byName("Mahmud Hasan Munna").id });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already been sold/);
  });

  it("refuses a captain, who is never auctioned", async () => {
    doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
    const res = await admin.post(`/api/tournaments/${T.id}/auction/block`, { playerId: byName("Md Mehedi Hasan").id });
    assert.equal(res.status, 404);
  });

  it("can be cleared", async () => {
    await admin.post(`/api/tournaments/${T.id}/auction/block`, { playerId: byName("Anirban Saha").id });
    const res = await admin.post(`/api/tournaments/${T.id}/auction/block`, { playerId: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.tournament.settings.auctionOnBlock, null);
  });

  it("is not for referees", async () => {
    assert.equal((await referee.post(`/api/tournaments/${T.id}/auction/block`, { playerId: byName("Anirban Saha").id })).status, 403);
  });
});
