import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { makeTournament, playMatch } from "../helpers/fixture.js";

describe("standings", () => {
  it("is empty of results before anything is played", () => {
    const table = D.standings(makeTournament());
    assert.equal(table.length, 4);
    assert.ok(table.every((r) => r.played === 0 && r.points === 0));
  });

  it("awards 3 for a win and 1 each for a draw", () => {
    const data = makeTournament();
    playMatch(data, "m1", 3, 1); // t1 beats t2
    playMatch(data, "m2", 2, 2); // t3 draws t4

    const by = Object.fromEntries(D.standings(data).map((r) => [r.teamId, r]));
    assert.equal(by.t1.points, 3);
    assert.equal(by.t1.won, 1);
    assert.equal(by.t2.points, 0);
    assert.equal(by.t2.lost, 1);
    assert.equal(by.t3.points, 1);
    assert.equal(by.t4.points, 1);
    assert.deepEqual(by.t1.form, ["W"]);
    assert.deepEqual(by.t2.form, ["L"]);
  });

  it("counts goals for, against and difference", () => {
    const data = makeTournament();
    playMatch(data, "m1", 3, 1);
    playMatch(data, "m3", 0, 2); // t1 loses to t3

    const t1 = D.standings(data).find((r) => r.teamId === "t1");
    assert.equal(t1.goalsFor, 3);
    assert.equal(t1.goalsAgainst, 3);
    assert.equal(t1.goalDiff, 0);
    assert.equal(t1.played, 2);
  });

  it("breaks a points tie on goal difference", () => {
    const data = makeTournament();
    playMatch(data, "m1", 5, 0); // t1 +5
    playMatch(data, "m2", 1, 0); // t3 +1

    const table = D.standings(data);
    assert.equal(table[0].teamId, "t1", "bigger goal difference goes top");
    assert.equal(table[1].teamId, "t3");
  });

  it("breaks a goal-difference tie on goals scored", () => {
    const data = makeTournament();
    playMatch(data, "m1", 3, 1); // t1 +2, 3 scored
    playMatch(data, "m2", 2, 0); // t3 +2, 2 scored

    const table = D.standings(data);
    assert.equal(table[0].teamId, "t1");
  });

  it("uses head to head when points, difference and goals all match", () => {
    const data = makeTournament();
    // t1 and t3 both beat others identically, then t3 beats t1.
    playMatch(data, "m1", 2, 1); // t1 beats t2
    playMatch(data, "m2", 2, 1); // t3 beats t4
    playMatch(data, "m3", 0, 0); // t1 v t3 — draw keeps them level

    const table = D.standings(data);
    const t1 = table.find((r) => r.teamId === "t1");
    const t3 = table.find((r) => r.teamId === "t3");
    assert.equal(t1.points, t3.points);
    assert.equal(t1.goalDiff, t3.goalDiff);
    // Level on everything and a drawn head-to-head — name decides, so the order
    // is at least deterministic.
    assert.ok(table.findIndex((r) => r.teamId === "t1") < table.findIndex((r) => r.teamId === "t3"));
  });

  it("ignores matches that are not full-time", () => {
    const data = makeTournament();
    data.matches.m1.homeScore = 3;
    data.matches.m1.awayScore = 0;
    data.matches.m1.status = "live";

    assert.ok(D.standings(data).every((r) => r.played === 0), "a live match must not enter the table");
  });

  it("ignores the final", () => {
    const data = makeTournament();
    playMatch(data, "m7", 4, 0);
    assert.ok(D.standings(data).every((r) => r.played === 0), "the final is not a group match");
  });

  it("survives a deleted team without crashing", () => {
    const data = makeTournament();
    playMatch(data, "m1", 1, 0);
    delete data.teams.t2;

    const table = D.standings(data);
    assert.equal(table.length, 3);
    assert.ok(table.every((r) => r.played === 0), "the match referencing a missing team is skipped");
  });

  it("is deterministic across repeated calls", () => {
    const data = makeTournament();
    playMatch(data, "m1", 1, 1);
    playMatch(data, "m2", 1, 1);
    const a = D.standings(data).map((r) => r.teamId);
    const b = D.standings(data).map((r) => r.teamId);
    assert.deepEqual(a, b);
  });
});

describe("the final", () => {
  it("is not seeded until every group match is done", () => {
    const data = makeTournament();
    playMatch(data, "m1", 1, 0);
    assert.equal(D.groupStageComplete(data), false);

    const sides = D.matchSides(data, data.matches.m7);
    assert.equal(sides.home, null);
    assert.equal(sides.homeLabel, "Leaderboard 1");
  });

  it("seeds the top two once the group stage finishes", () => {
    const data = makeTournament();
    playMatch(data, "m1", 5, 0);
    playMatch(data, "m2", 1, 0);
    playMatch(data, "m3", 3, 0);
    playMatch(data, "m4", 0, 1);
    playMatch(data, "m5", 2, 0);
    playMatch(data, "m6", 0, 1);

    assert.equal(D.groupStageComplete(data), true);
    const table = D.standings(data);
    const sides = D.matchSides(data, data.matches.m7);
    assert.equal(sides.home.id, table[0].teamId);
    assert.equal(sides.away.id, table[1].teamId);
    assert.equal(sides.derived, true);
  });

  it("re-seeds itself when a group result is corrected", () => {
    const data = makeTournament();
    // t1 wins all three of its matches and tops the table.
    playMatch(data, "m1", 5, 0); // t1 beats t2
    playMatch(data, "m3", 3, 0); // t1 beats t3
    playMatch(data, "m5", 2, 0); // t1 beats t4
    playMatch(data, "m2", 1, 0); // t3 beats t4
    playMatch(data, "m4", 0, 1); // t3 beats t2
    playMatch(data, "m6", 0, 1); // t4 beats t2

    assert.equal(D.matchSides(data, data.matches.m7).home.id, "t1");

    // Now correct all three of t1's results to defeats. It should drop out of
    // the final entirely — the pairing is derived, never stored.
    playMatch(data, "m1", 0, 5);
    playMatch(data, "m3", 0, 3);
    playMatch(data, "m5", 0, 2);

    const sides = D.matchSides(data, data.matches.m7);
    const finalists = [sides.home.id, sides.away.id];
    assert.ok(!finalists.includes("t1"), `t1 finished bottom but is still in the final: ${finalists}`);
    assert.equal(D.standings(data).at(-1).teamId, "t1");
  });

  it("names a champion once the final is decided", () => {
    const data = makeTournament();
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) playMatch(data, id, 1, 0);
    playMatch(data, "m7", 2, 1);

    const result = D.champion(data);
    assert.ok(result);
    assert.equal(result.finalScore, "2–1");
    assert.equal(result.decidedBy, "final");
    assert.notEqual(result.winner.id, result.runnerUp.id);
  });

  it("returns nothing for a drawn final", () => {
    const data = makeTournament();
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) playMatch(data, id, 1, 0);
    playMatch(data, "m7", 1, 1);
    assert.equal(D.champion(data), null, "a knockout cannot be drawn");
  });
});

describe("friendly format", () => {
  it("takes its winner from the table, since there is no final", () => {
    const data = makeTournament({ format: "friendly" });
    delete data.matches.m7;
    playMatch(data, "m1", 4, 0);

    const result = D.champion(data);
    assert.ok(result);
    assert.equal(result.decidedBy, "table");
    assert.equal(result.winner.id, "t1");
  });

  it("has no winner before anything is played", () => {
    const data = makeTournament({ format: "friendly" });
    assert.equal(D.champion(data), null);
  });
});

describe("round robin generation", () => {
  it("pairs every team exactly once", () => {
    const fixtures = D.roundRobin(["a", "b", "c", "d"]);
    assert.equal(fixtures.length, 6);

    const seen = new Set(fixtures.map((f) => [f.homeId, f.awayId].sort().join("-")));
    assert.equal(seen.size, 6, "no pairing should repeat");
    assert.ok(fixtures.every((f) => f.homeId !== f.awayId));
  });

  it("handles an odd number of teams with a bye", () => {
    const fixtures = D.roundRobin(["a", "b", "c", "d", "e"]);
    assert.equal(fixtures.length, 10, "5 teams play 10 fixtures");
    assert.ok(fixtures.every((f) => f.homeId !== "__bye__" && f.awayId !== "__bye__"));
  });

  it("numbers fixtures from one, without gaps", () => {
    const fixtures = D.roundRobin(["a", "b", "c", "d"]);
    assert.deepEqual(
      fixtures.map((f) => f.no),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it("returns nothing for fewer than two teams", () => {
    assert.deepEqual(D.roundRobin(["a"]), []);
    assert.deepEqual(D.roundRobin([]), []);
  });
});
