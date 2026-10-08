/**
 * Removing a team, and what happens to the people in it.
 *
 * The two modes owe their players different things. A bought footballer
 * belongs to the auction pool, so losing their team puts them back up for
 * sale. A gaming pair has no pool behind it — the team is the pair, so a
 * member left behind would be a player on no team, invisible in a console that
 * only lists teams, and still counted as taken when the organiser tried to put
 * them in a new one.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss;
const person = {};

const doc = (id) => boss.get(`/api/tournaments/${id}`).then((r) => r.body.tournament);
const playersOf = async (id) => Object.values((await doc(id)).players);

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);
  for (const name of ["Munna", "Anirban", "Sabbir"]) {
    person[name] = (await boss.post("/api/people", { name })).body.person;
  }
});

after(() => t?.stop());

describe("removing a team in a gaming tournament", () => {
  let T;
  let team;

  before(async () => {
    T = (await boss.post("/api/tournaments", { name: "Pair Cup", season: "2026", mode: "esports" })).body.tournament;
    await boss.post(`/api/tournaments/${T.id}/teams`, {
      name: "Rocket Boys",
      group: "A",
      memberIds: [person.Munna.id, person.Anirban.id],
    });
    team = Object.values((await doc(T.id)).teams).find((x) => x.name === "Rocket Boys");
  });

  it("takes its two members with it", async () => {
    assert.equal((await playersOf(T.id)).length, 2);

    const res = await boss.del(`/api/tournaments/${T.id}/teams/${team.id}`);
    assert.equal(res.status, 200, res.body?.error?.message);

    assert.deepEqual(await playersOf(T.id), [], "nobody is left stranded on no team");
  });

  it("frees them to be picked for a new pair", async () => {
    const res = await boss.post(`/api/tournaments/${T.id}/teams`, {
      name: "Night Owls",
      group: "B",
      memberIds: [person.Munna.id, person.Anirban.id],
    });
    assert.equal(res.status, 200, res.body?.error?.message);

    const players = await playersOf(T.id);
    assert.equal(players.length, 2, "two players, not four");
    assert.deepEqual(players.map((p) => p.name).sort(), ["Anirban", "Munna"]);
    assert.ok(players.every((p) => p.teamId), "both are in the new team");
  });

  it("moves a player who was stranded before rather than adding a second row", async () => {
    // Exactly the state an earlier removal left behind: a person with a player
    // row and no team.
    const [stray] = await playersOf(T.id);
    await boss.patch(`/api/tournaments/${T.id}/players/${stray.id}`, { teamId: null });
    assert.ok((await playersOf(T.id)).find((p) => p.id === stray.id && !p.teamId));

    await boss.post(`/api/tournaments/${T.id}/teams`, { name: "Late Entry", memberIds: [stray.personId] });

    const rows = (await playersOf(T.id)).filter((p) => p.personId === stray.personId);
    assert.equal(rows.length, 1, "one person is still one player");
    assert.equal(rows[0].id, stray.id, "and it is the row that was already there");
    assert.ok(rows[0].teamId);
  });

  it("refuses while the team has played, whatever the mode", async () => {
    await boss.post(`/api/tournaments/${T.id}/teams`, { name: "Code Red", memberIds: [person.Sabbir.id] });
    const teams = Object.values((await doc(T.id)).teams);
    const [a, b] = teams;
    const match = (await boss.post(`/api/tournaments/${T.id}/matches`, { homeId: a.id, awayId: b.id })).body.tournament;
    const m = Object.values(match.matches)[0];
    await boss.patch(`/api/tournaments/${T.id}/matches/${m.id}`, { homeScore: 2, awayScore: 1, status: "ft" });

    const res = await boss.del(`/api/tournaments/${T.id}/teams/${a.id}`);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already played/);
  });
});

describe("removing a team in a football tournament", () => {
  let T;

  before(async () => {
    T = (await boss.post("/api/tournaments", { name: "Field Cup", season: "2026" })).body.tournament;
  });

  it("puts the players it bought back in the auction pool", async () => {
    const team = (await boss.post(`/api/tournaments/${T.id}/teams`, { name: "Reds", captainName: "Skipper" })).body
      .tournament.teams;
    const id = Object.values(team).find((x) => x.name === "Reds").id;
    await boss.post(`/api/tournaments/${T.id}/players`, { name: "Bought", pos: "FWD", kind: "auction", teamId: id });

    assert.equal((await boss.del(`/api/tournaments/${T.id}/teams/${id}`)).status, 200);

    const players = await playersOf(T.id);
    assert.deepEqual(players.map((p) => p.name), ["Bought"], "the captain goes, the bought player stays");
    assert.equal(players[0].teamId, null, "back in the pool");
  });
});
