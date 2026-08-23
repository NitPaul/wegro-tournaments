/**
 * The points engine, the medals, and the own-goal bug.
 *
 * The own-goal case is a real defect carried over from the previous version:
 * `topScorers` and `goalsByPosition` had no own-goal filter, while the points
 * ledger on the same page correctly booked it as an own goal. So a player could
 * appear top of the Golden Boot for a goal the ledger showed them being
 * penalised for.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { addEvent, captainOf, makeTournament, playMatch, scoreGoal, squadOf } from "../helpers/fixture.js";

describe("own goals", () => {
  it("does not count towards top scorers", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");

    // t2's defender puts it in their own net, so the goal is credited to t1.
    addEvent(data, "m1", { type: "goal", teamId: "t1", playerId: defender.id, ownGoal: true });
    playMatch(data, "m1", 1, 0);

    assert.equal(D.topScorers(data).length, 0, "an own goal must not win the Golden Boot");
  });

  it("does not count towards goals by position", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");
    addEvent(data, "m1", { type: "goal", teamId: "t1", playerId: defender.id, ownGoal: true });

    assert.equal(
      D.goalsByPosition(data).reduce((n, r) => n + r.value, 0),
      0,
    );
  });

  it("does not count towards the zone chart", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");
    addEvent(data, "m1", { type: "goal", teamId: "t1", playerId: defender.id, ownGoal: true, zone: "ib" });

    assert.equal(D.goalsByZone(data).total, 0);
  });

  it("still costs the player points", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");
    addEvent(data, "m1", { type: "goal", teamId: "t1", playerId: defender.id, ownGoal: true });
    playMatch(data, "m1", 1, 0);

    const row = D.playerStats(data).find((r) => r.playerId === defender.id);
    assert.equal(row.ownGoals, 1);
    assert.equal(row.goals, 0);
  });

  it("still moves the scoreline", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");
    addEvent(data, "m1", { type: "goal", teamId: "t1", playerId: defender.id, ownGoal: true });
    playMatch(data, "m1", 1, 0);

    assert.equal(D.eventTally(data, data.matches.m1).matches, true);
  });

  it("carries no assist", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t2").find((p) => p.pos === "DEF");
    const other = squadOf(data, "t1")[0];
    addEvent(data, "m1", {
      type: "goal",
      teamId: "t1",
      playerId: defender.id,
      assistId: other.id,
      ownGoal: true,
    });

    assert.equal(D.topAssists(data).length, 0, "nobody assists an own goal");
  });
});

describe("punctuality penalty goals", () => {
  it("moves the scoreline but credits nobody", () => {
    const data = makeTournament();
    addEvent(data, "m1", { type: "penalty_goal", teamId: "t1" });
    playMatch(data, "m1", 1, 0);

    assert.equal(D.eventTally(data, data.matches.m1).matches, true);
    assert.equal(D.topScorers(data).length, 0);
    assert.ok(D.playerStats(data).every((r) => r.goals === 0));
  });
});

describe("the points ledger", () => {
  it("pays a critical goal a bonus on top of the goal", () => {
    const data = makeTournament();
    const a = squadOf(data, "t1").find((p) => p.pos === "FWD");
    const b = squadOf(data, "t2").find((p) => p.pos === "FWD");

    scoreGoal(data, "m1", "t1", a.id, { critical: true });
    scoreGoal(data, "m1", "t2", b.id);
    playMatch(data, "m1", 1, 1);

    const rows = D.playerStats(data);
    const rowA = rows.find((r) => r.playerId === a.id);
    const rowB = rows.find((r) => r.playerId === b.id);

    assert.equal(rowA.criticalGoals, 1);
    assert.equal(rowB.criticalGoals, 0);
    assert.equal(rowA.points - rowB.points, D.DEFAULT_POINTS.criticalGoal);
  });

  it("keeps criticalGoals separate from goals", () => {
    const data = makeTournament();
    const p = squadOf(data, "t1").find((x) => x.pos === "FWD");
    scoreGoal(data, "m1", "t1", p.id, { critical: true });

    const row = D.playerStats(data).find((r) => r.playerId === p.id);
    assert.equal(row.goals, 1, "a critical goal is still one goal");
    assert.equal(row.criticalGoals, 1);
  });

  it("pays keepers for clean sheets and charges them for goals conceded", () => {
    const data = makeTournament();
    const keeper = squadOf(data, "t1").find((p) => p.pos === "GK");

    playMatch(data, "m1", 1, 0); // clean sheet
    playMatch(data, "m3", 0, 2); // concedes two

    const row = D.playerStats(data).find((r) => r.playerId === keeper.id);
    assert.equal(row.cleanSheets, 1);
    assert.equal(row.conceded, 2);
    assert.equal(
      row.points,
      D.DEFAULT_POINTS.cleanSheetGK + 2 * D.DEFAULT_POINTS.concededGK,
    );
  });

  it("pays defenders for clean sheets but does not charge them for goals", () => {
    const data = makeTournament();
    const defender = squadOf(data, "t1").find((p) => p.pos === "DEF");

    playMatch(data, "m1", 1, 0);
    playMatch(data, "m3", 0, 2);

    const row = D.playerStats(data).find((r) => r.playerId === defender.id);
    assert.equal(row.cleanSheets, 1);
    assert.equal(row.points, D.DEFAULT_POINTS.cleanSheetDEF);
  });

  it("leaves guests out of the defensive record", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "Guest Def", pos: "DEF", teamId: "t1", price: 0, kind: "guest" };
    playMatch(data, "m1", 1, 0);

    const row = D.playerStats(data).find((r) => r.playerId === "g1");
    assert.equal(row.cleanSheets, 0, "a guest did not keep the squad's season clean sheet");
  });

  it("is sorted highest first and is deterministic", () => {
    const data = makeTournament();
    const p = squadOf(data, "t1").find((x) => x.pos === "FWD");
    scoreGoal(data, "m1", "t1", p.id);
    playMatch(data, "m1", 1, 0);

    const first = D.playerStats(data).map((r) => r.playerId);
    const second = D.playerStats(data).map((r) => r.playerId);
    assert.deepEqual(first, second);

    const points = D.playerStats(data).map((r) => r.points);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  });

  it("reports no record before anything happens", () => {
    const data = makeTournament();
    assert.equal(D.hasMatchData(data), false);
    assert.ok(D.playerStats(data).every((r) => !D.hasRecord(r)));
  });
});

describe("medals", () => {
  it("shares the Golden Boot on a tie", () => {
    const data = makeTournament();
    const a = squadOf(data, "t1").find((p) => p.pos === "FWD");
    const b = squadOf(data, "t2").find((p) => p.pos === "FWD");
    scoreGoal(data, "m1", "t1", a.id);
    scoreGoal(data, "m1", "t2", b.id);
    playMatch(data, "m1", 1, 1);

    const boot = D.awards(data).goldenBoot;
    assert.equal(boot.length, 2, "a shared Boot should name both");
    assert.ok(boot.every((r) => r.goals === 1));
  });

  it("collapses a shared Boot when overridden", () => {
    const data = makeTournament();
    const a = squadOf(data, "t1").find((p) => p.pos === "FWD");
    const b = squadOf(data, "t2").find((p) => p.pos === "FWD");
    scoreGoal(data, "m1", "t1", a.id);
    scoreGoal(data, "m1", "t2", b.id);
    playMatch(data, "m1", 1, 1);
    data.settings.goldenBootPlayerId = a.id;

    const boot = D.awards(data).goldenBoot;
    assert.equal(boot.length, 1);
    assert.equal(boot[0].playerId, a.id);
    assert.equal(boot[0].picked, true, "the card must say it was assigned, not computed");
  });

  it("marks the tie on a computed Golden Ball", () => {
    const data = makeTournament();
    const a = squadOf(data, "t1").find((p) => p.pos === "FWD");
    const b = squadOf(data, "t2").find((p) => p.pos === "FWD");
    scoreGoal(data, "m1", "t1", a.id);
    scoreGoal(data, "m1", "t2", b.id);

    const ball = D.awards(data).goldenBall;
    assert.equal(ball.tied, true);
    assert.equal(ball.picked, false);
  });

  it("falls back safely when an override names a deleted player", () => {
    const data = makeTournament();
    const p = squadOf(data, "t1").find((x) => x.pos === "FWD");
    scoreGoal(data, "m1", "t1", p.id);
    data.settings.goldenBallPlayerId = "no-such-player";

    const ball = D.awards(data).goldenBall;
    assert.ok(ball, "a stale override must not blank the medal");
    assert.equal(ball.playerId, p.id);
    assert.equal(ball.picked, false);
  });

  it("gives no medal when nobody has done anything", () => {
    const data = makeTournament();
    const a = D.awards(data);
    assert.equal(a.goldenBall, null);
    assert.deepEqual(a.goldenBoot, []);
    assert.equal(a.goldenGlove, null);
  });

  it("summarises medals for the archive", () => {
    const data = makeTournament();
    const p = squadOf(data, "t1").find((x) => x.pos === "FWD");
    const cap = captainOf(data, "t2");
    scoreGoal(data, "m1", "t1", p.id);
    scoreGoal(data, "m1", "t1", p.id);
    scoreGoal(data, "m1", "t2", cap.id);
    playMatch(data, "m1", 2, 1);

    const summary = D.medalSummary(data);
    assert.equal(summary.goldenBoot.playerName, p.name);
    assert.equal(summary.goldenBoot.value, 2);
    assert.equal(summary.goldenBoot.teamName, "LOSS MAKER");
    assert.ok(summary.fairPlay, "fair play is a team medal and must be summarised too");
  });
});

describe("clean sheets table", () => {
  it("credits the team keeper and counts goals conceded", () => {
    const data = makeTournament();
    playMatch(data, "m1", 0, 0);
    playMatch(data, "m3", 3, 0);

    const row = D.cleanSheets(data).find((r) => r.team.id === "t1");
    assert.equal(row.value, 2);
    assert.equal(row.conceded, 0);
    assert.equal(row.player.pos, "GK");
  });

  it("omits a team with no keeper rather than mis-crediting one", () => {
    const data = makeTournament();
    const keeper = squadOf(data, "t1").find((p) => p.pos === "GK");
    delete data.players[keeper.id];
    playMatch(data, "m1", 1, 0);

    assert.ok(!D.cleanSheets(data).some((r) => r.team.id === "t1"));
  });
});

describe("event tally", () => {
  it("flags a scoreline the log does not support", () => {
    const data = makeTournament();
    const p = squadOf(data, "t1").find((x) => x.pos === "FWD");
    scoreGoal(data, "m1", "t1", p.id);
    playMatch(data, "m1", 3, 0); // typed straight in, only one goal logged

    const tally = D.eventTally(data, data.matches.m1);
    assert.equal(tally.matches, false);
    assert.equal(tally.home, 1);
    assert.equal(tally.homeScore, 3);
  });

  it("says nothing about a match that has not started", () => {
    const data = makeTournament();
    assert.equal(D.eventTally(data, data.matches.m1), null);
  });
});
