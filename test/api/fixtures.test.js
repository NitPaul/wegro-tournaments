/**
 * Adding and removing fixtures by hand.
 *
 * "Clear" wipes a result; it is not how a fixture leaves the list, and the
 * console used to offer nothing else — so an empty knockout placeholder sat
 * there however often it was cleared. Removing one is its own thing, and it
 * belongs to the tournament's admin.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss, admin, referee, anon;
let T;

const matches = async (client = admin) => Object.values((await client.get(`/api/tournaments/${T.id}`)).body.tournament.matches);

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);
  anon = t.client();

  T = (await boss.post("/api/tournaments", { name: "Fixture Cup", season: "2027" })).body.tournament;
  for (const [username, role] of [["fx-admin", "admin"], ["fx-ref", "referee"]]) {
    await boss.post("/api/users", { username, name: username, password: "correct-horse-battery", role, tournamentId: T.id });
  }
  admin = t.client();
  await admin.login("fx-admin", "correct-horse-battery");
  referee = t.client();
  await referee.login("fx-ref", "correct-horse-battery");

  for (const name of ["Red", "Blue", "Green"]) {
    await admin.post(`/api/tournaments/${T.id}/teams`, { name });
  }
  await admin.post(`/api/tournaments/${T.id}/matches/generate`, { knockout: "final" });
});

after(() => t?.stop());

describe("removing a fixture", () => {
  it("takes it off the list for good", async () => {
    const before = await matches();
    const doomed = before.find((m) => !m.isFinal);

    const res = await admin.del(`/api/tournaments/${T.id}/matches/${doomed.id}`);
    assert.equal(res.status, 200, res.body?.error?.message);

    const after = await matches();
    assert.equal(after.length, before.length - 1);
    assert.ok(!after.some((m) => m.id === doomed.id), "and it does not come back on a reload");
  });

  it("takes the match log with it", async () => {
    const [match] = (await matches()).filter((m) => m.homeId && m.awayId);
    const players = Object.values((await admin.get(`/api/tournaments/${T.id}`)).body.tournament.players);
    await admin.post(`/api/tournaments/${T.id}/players`, { name: "Scorer", pos: "FWD", teamId: match.homeId });
    const scorer = Object.values((await admin.get(`/api/tournaments/${T.id}`)).body.tournament.players).find(
      (p) => !players.some((old) => old.id === p.id),
    );

    await referee.post(`/api/tournaments/${T.id}/matches/${match.id}/events`, {
      type: "goal",
      teamId: match.homeId,
      playerId: scorer.id,
    });
    assert.ok(Object.keys((await matches()).find((m) => m.id === match.id).events ?? {}).length > 0);

    assert.equal((await admin.del(`/api/tournaments/${T.id}/matches/${match.id}`)).status, 200);
    assert.ok(!(await matches()).some((m) => m.id === match.id));
  });

  it("is the admin's to do, not a referee's and not a stranger's", async () => {
    const [match] = await matches();
    assert.equal((await referee.del(`/api/tournaments/${T.id}/matches/${match.id}`)).status, 403);
    assert.ok([401, 403, 404].includes((await anon.del(`/api/tournaments/${T.id}/matches/${match.id}`)).status));
    assert.ok((await matches()).some((m) => m.id === match.id), "and the fixture is still there");
  });

  it("says so plainly when the match is not this tournament's", async () => {
    const other = (await boss.post("/api/tournaments", { name: "Other Cup", season: "2027" })).body.tournament;
    await boss.post(`/api/tournaments/${other.id}/teams`, { name: "Only" });
    await boss.post(`/api/tournaments/${other.id}/matches`, {});
    const theirs = Object.values((await boss.get(`/api/tournaments/${other.id}`)).body.tournament.matches)[0];

    assert.equal((await admin.del(`/api/tournaments/${T.id}/matches/${theirs.id}`)).status, 404);
    assert.ok(
      Object.values((await boss.get(`/api/tournaments/${other.id}`)).body.tournament.matches).some((m) => m.id === theirs.id),
      "the other tournament keeps its fixture",
    );
  });
});

describe("clearing a fixture", () => {
  it("wipes the result but keeps the fixture", async () => {
    const match = (await matches()).find((m) => m.homeId && m.awayId);
    await referee.patch(`/api/tournaments/${T.id}/matches/${match.id}`, { homeScore: 3, awayScore: 1, status: "ft" });

    assert.equal((await admin.post(`/api/tournaments/${T.id}/matches/${match.id}/clear`, {})).status, 200);
    const cleared = (await matches()).find((m) => m.id === match.id);
    assert.ok(cleared, "still on the list");
    assert.equal(cleared.homeScore, null);
    assert.equal(cleared.status, "scheduled");
  });
});
