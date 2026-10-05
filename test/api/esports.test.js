/**
 * A gaming tournament end to end over HTTP: created as one, built from pairs in
 * groups, decided by a knockout, and settled on penalties.
 *
 * Shaped like the real one — WeGro FC 26, eight pairs, two groups of four.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { startTestServer } from "../helpers/app.js";

let t;
let boss, admin, referee, anon;
let T;
const people = {};
const teams = {};

const PAIRS = [
  ["A", "Rocket Boys", ["Munna", "Anirban"]],
  ["A", "Night Owls", ["Sabbir", "Rabbe"]],
  ["A", "Desk Destroyers", ["Shanto", "Imran"]],
  ["A", "Last Minute", ["Faruk", "Mobin"]],
  ["B", "Code Red", ["Mehedi", "Afsar"]],
  ["B", "Pixel Pushers", ["Yousuf", "Ayon"]],
  ["B", "Overtime FC", ["Rafik", "Monir"]],
  ["B", "Coffee Breakers", ["Saad", "Uthsho"]],
];

before(async () => {
  t = await startTestServer();
  const superUser = await t.makeUser({ username: "boss", isSuper: true });
  boss = t.client();
  await boss.login(superUser.username, superUser.password);
  anon = t.client();

  for (const [, , members] of PAIRS) {
    for (const name of members) {
      people[name] = (await boss.post("/api/people", { name })).body.person;
    }
  }

  T = (
    await boss.post("/api/tournaments", {
      name: "WeGro FC 26 Tournament",
      season: "October 2026",
      mode: "esports",
      game: "EA SPORTS FC 26",
    })
  ).body.tournament;

  for (const [username, role] of [["fc-admin", "admin"], ["fc-ref", "referee"]]) {
    await boss.post("/api/users", { username, name: username, password: "correct-horse-battery", role, tournamentId: T.id });
  }
  admin = t.client();
  await admin.login("fc-admin", "correct-horse-battery");
  referee = t.client();
  await referee.login("fc-ref", "correct-horse-battery");
});

after(() => t?.stop());

describe("creating a gaming tournament", () => {
  it("is marked as one, and says which game", () => {
    assert.equal(T.mode, "esports");
    assert.equal(T.game, "EA SPORTS FC 26");
  });

  it("defaults to football, and refuses anything else", async () => {
    const football = (await boss.post("/api/tournaments", { name: "Football Cup" })).body.tournament;
    assert.equal(football.mode, "field");
    assert.equal(football.game, null);
    assert.equal((await boss.patch(`/api/tournaments/${football.id}`, { mode: "chess" })).status, 400);
  });

  it("lets its own admin rename the game but not change the mode", async () => {
    assert.equal((await admin.patch(`/api/tournaments/${T.id}`, { game: "FC 26" })).status, 200);
    assert.equal((await admin.patch(`/api/tournaments/${T.id}`, { mode: "field" })).status, 403);
    await boss.patch(`/api/tournaments/${T.id}`, { game: "EA SPORTS FC 26" });
  });
});

describe("pairs in groups", () => {
  it("creates a team with its own name, a group and two members from the roster", async () => {
    for (const [group, name, members] of PAIRS) {
      const res = await admin.post(`/api/tournaments/${T.id}/teams`, {
        name,
        group,
        memberIds: members.map((m) => people[m].id),
      });
      assert.equal(res.status, 200, res.body?.error?.message);
      teams[name] = Object.values(res.body.tournament.teams).find((x) => x.name === name);
    }

    const doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
    assert.equal(Object.keys(doc.teams).length, 8);
    assert.equal(teams["Rocket Boys"].group, "A");

    const members = Object.values(doc.players).filter((p) => p.teamId === teams["Rocket Boys"].id);
    assert.deepEqual(members.map((m) => m.name).sort(), ["Anirban", "Munna"]);
    assert.ok(members.every((m) => m.personId), "each member is linked to their roster person");
  });

  it("refuses a member who is not on the roster", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/teams`, { name: "Ghosts", memberIds: ["pp_nobody"] });
    assert.equal(res.status, 404);
  });
});

describe("fixtures", () => {
  it("plays each group as its own round robin, then the semis and the final", async () => {
    const res = await admin.post(`/api/tournaments/${T.id}/matches/generate`, { knockout: "semis" });
    assert.equal(res.status, 200, res.body?.error?.message);

    const matches = Object.values(res.body.tournament.matches);
    const group = matches.filter((m) => m.stage === "group");
    assert.equal(group.length, 12, "six per group of four");
    assert.equal(matches.filter((m) => m.stage === "semi").length, 2);

    const final = matches.find((m) => m.stage === "final");
    assert.ok(final.isFinal, "the final is flagged both ways, so the hall of fame still finds it");

    const byId = res.body.tournament.teams;
    for (const m of group) {
      assert.equal(byId[m.homeId].group, byId[m.awayId].group, "no group match crosses the groups");
    }
    for (const m of matches.filter((x) => x.stage !== "group")) {
      assert.equal(m.homeId, null, "the organiser picks who plays the knockout rounds");
    }
  });

  it("is not something a referee can regenerate", async () => {
    assert.equal((await referee.post(`/api/tournaments/${T.id}/matches/generate`, { knockout: "semis" })).status, 403);
  });
});

describe("match day", () => {
  let doc;
  const matchesIn = (stage) => Object.values(doc.matches).filter((m) => m.stage === stage).sort((a, b) => a.no - b.no);

  before(async () => {
    doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
    // Group A finishes Rocket Boys, Night Owls, … and group B Code Red, Pixel Pushers, …
    const rank = { "Rocket Boys": 4, "Night Owls": 3, "Desk Destroyers": 2, "Last Minute": 1, "Code Red": 4, "Pixel Pushers": 3, "Overtime FC": 2, "Coffee Breakers": 1 };
    const nameOf = (id) => Object.values(doc.teams).find((x) => x.id === id).name;

    for (const m of matchesIn("group")) {
      const home = rank[nameOf(m.homeId)] > rank[nameOf(m.awayId)];
      const res = await referee.patch(`/api/tournaments/${T.id}/matches/${m.id}`, {
        homeScore: home ? 2 : 0,
        awayScore: home ? 0 : 2,
        status: "ft",
      });
      assert.equal(res.status, 200, res.body?.error?.message);
    }
    doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
  });

  it("gives each group its own table", async () => {
    const D = await import("../../shared/domain/index.js");
    const tables = D.groupTables(doc);
    assert.deepEqual(tables.map((x) => x.group), ["A", "B"]);
    assert.equal(tables[0].table[0].team.name, "Rocket Boys");
    assert.equal(tables[1].table[0].team.name, "Code Red");
    assert.equal(tables[0].table[0].played, 3);
  });

  it("lets the admin choose the knockout pairings", async () => {
    const [sf1, sf2] = matchesIn("semi");
    assert.equal(
      (await admin.patch(`/api/tournaments/${T.id}/matches/${sf1.id}`, {
        homeId: teams["Rocket Boys"].id,
        awayId: teams["Pixel Pushers"].id,
      })).status,
      200,
    );
    assert.equal(
      (await admin.patch(`/api/tournaments/${T.id}/matches/${sf2.id}`, {
        homeId: teams["Code Red"].id,
        awayId: teams["Night Owls"].id,
      })).status,
      200,
    );
    assert.equal(
      (await referee.patch(`/api/tournaments/${T.id}/matches/${sf1.id}`, { homeId: teams["Last Minute"].id })).status,
      403,
      "a referee records scores, not fixtures",
    );
  });

  it("settles a level knockout match on penalties, and a referee can record them", async () => {
    const [sf1, sf2] = matchesIn("semi");
    await referee.patch(`/api/tournaments/${T.id}/matches/${sf1.id}`, { homeScore: 3, awayScore: 1, status: "ft" });
    const res = await referee.patch(`/api/tournaments/${T.id}/matches/${sf2.id}`, {
      homeScore: 2,
      awayScore: 2,
      homePens: 5,
      awayPens: 4,
      status: "ft",
    });
    assert.equal(res.status, 200, res.body?.error?.message);

    const D = await import("../../shared/domain/index.js");
    doc = res.body.tournament;
    const played = Object.values(doc.matches).find((m) => m.id === sf2.id);
    assert.equal(D.matchWinner(doc, played).winnerId, teams["Code Red"].id);
    assert.equal(D.scoreLine(played), "2–2 (5–4 on pens)");
  });

  it("refuses a nonsense shoot-out", async () => {
    const [sf1] = matchesIn("semi");
    assert.equal((await referee.patch(`/api/tournaments/${T.id}/matches/${sf1.id}`, { homePens: -1 })).status, 400);
  });

  it("crowns the champion of a final won on penalties, and writes the Hall of Fame entry", async () => {
    doc = (await admin.get(`/api/tournaments/${T.id}`)).body.tournament;
    const final = Object.values(doc.matches).find((m) => m.stage === "final");
    await admin.patch(`/api/tournaments/${T.id}/matches/${final.id}`, {
      homeId: teams["Rocket Boys"].id,
      awayId: teams["Code Red"].id,
    });
    await referee.patch(`/api/tournaments/${T.id}/matches/${final.id}`, {
      homeScore: 1,
      awayScore: 1,
      homePens: 4,
      awayPens: 2,
      status: "ft",
    });

    assert.equal((await boss.patch(`/api/tournaments/${T.id}`, { status: "completed" })).status, 200);
    const { entries } = (await anon.get("/api/archive")).body;
    const entry = entries.find((x) => x.tournamentId === T.id);
    assert.equal(entry.champion, "Rocket Boys");
    assert.equal(entry.runnerUp, "Code Red");
    assert.equal(entry.finalScore, "1–1 (4–2 on pens)");
  });
});

describe("a person's gaming record", () => {
  it("counts their pair's results, and is kept apart from their football record", async () => {
    const munna = (await anon.get(`/api/people/${people.Munna.id}`)).body.person;
    assert.equal(munna.game.totals.matches, 5, "three group matches, a semi-final and the final");
    assert.equal(munna.game.titles, 1);
    assert.equal(munna.totals.matches, 0, "they have not played football here");
    assert.equal(munna.game.tournaments[0].team.name, "Rocket Boys");
    assert.deepEqual(munna.game.tournaments[0].partners.map((p) => p.name), ["Anirban"]);
  });

  it("gives both of a pair the same record", async () => {
    const munna = (await anon.get(`/api/people/${people.Munna.id}`)).body.person;
    const anirban = (await anon.get(`/api/people/${people.Anirban.id}`)).body.person;
    assert.deepEqual(munna.game.totals, anirban.game.totals);
  });
});

describe("gaming profiles", () => {
  it("lets the super admin set the tag, platform, club and a gaming rating", async () => {
    const res = await boss.patch(`/api/people/${people.Munna.id}`, {
      gamerTag: "munna_fc",
      platform: "playstation",
      favClub: "Real Madrid",
      gameRating: 88,
      gameRatingNote: "Won the first FC 26",
    });
    assert.equal(res.status, 200, res.body?.error?.message);
    assert.equal(res.body.person.game.gamerTag, "munna_fc");
    assert.equal(res.body.person.game.platform, "PlayStation", "tidied to the usual spelling");
    assert.equal(res.body.person.game.rating, 88);
    assert.equal(res.body.person.game.headline.source, "admin");
  });

  it("keeps the gaming rating apart from the football one", async () => {
    await boss.patch(`/api/people/${people.Munna.id}`, { rating: 70 });
    const munna = (await anon.get(`/api/people/${people.Munna.id}`)).body.person;
    assert.equal(munna.rating, 70);
    assert.equal(munna.game.rating, 88);
  });

  it("keeps the note for the super admin only", async () => {
    const pub = (await anon.get(`/api/people/${people.Munna.id}`)).body.person;
    assert.equal(pub.game.ratingNote, undefined);
    assert.equal((await boss.get(`/api/people/${people.Munna.id}`)).body.person.game.ratingNote, "Won the first FC 26");
  });

  it("lets the tournament admin fill in a tag for their own player, but not rate them", async () => {
    // A finished tournament is read-only to its admin, as another test proves.
    // Reopen it, because this is about what they may do while it is running.
    await boss.patch(`/api/tournaments/${T.id}`, { status: "active" });

    assert.equal((await admin.patch(`/api/people/${people.Anirban.id}`, { gamerTag: "anirban7" })).status, 200);
    assert.equal((await admin.patch(`/api/people/${people.Anirban.id}`, { gameRating: 99 })).status, 403);
    assert.equal((await admin.patch(`/api/people/${people.Anirban.id}`, { name: "Someone else" })).status, 403);
    assert.equal((await referee.patch(`/api/people/${people.Anirban.id}`, { gamerTag: "nope" })).status, 403);
  });
});
