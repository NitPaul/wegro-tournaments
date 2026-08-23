/**
 * Fouls and cards.
 *
 * The rule that matters most here: a card must never move the scoreline. The
 * admin console warns when the logged goals do not add up to the score, and if
 * a booking counted as a goal event that warning would fire on every match that
 * had one — training everybody to ignore the one warning that catches real
 * mistakes.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { addEvent, captainOf, makeTournament, playMatch, scoreGoal, squadOf } from "../helpers/fixture.js";

const book = (data, matchId, teamId, playerId, type) =>
  addEvent(data, matchId, { type, teamId, playerId });

describe("cards and the scoreline", () => {
  it("does not count as a goal", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];

    book(data, "m1", "t1", player.id, "yellow");
    book(data, "m1", "t1", player.id, "foul");
    book(data, "m1", "t1", player.id, "red");

    assert.equal(D.goalEvents(data.matches.m1).length, 0);
    assert.deepEqual(D.loggedGoals(data, data.matches.m1), { home: 0, away: 0 });
  });

  it("does not trip the tally-mismatch warning", () => {
    const data = makeTournament();
    const scorer = squadOf(data, "t1")[0];
    const fouler = squadOf(data, "t2")[0];

    scoreGoal(data, "m1", "t1", scorer.id);
    book(data, "m1", "t2", fouler.id, "yellow");
    book(data, "m1", "t2", fouler.id, "foul");
    playMatch(data, "m1", 1, 0);

    const tally = D.eventTally(data, data.matches.m1);
    assert.equal(tally.matches, true, "a booked match must not look like a scoring error");
  });
});

describe("discipline points", () => {
  it("costs the player points", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1").find((p) => p.pos === "FWD");

    book(data, "m1", "t1", player.id, "foul");
    book(data, "m1", "t1", player.id, "yellow");
    playMatch(data, "m1", 0, 0);

    const row = D.playerStats(data).find((r) => r.playerId === player.id);
    assert.equal(row.fouls, 1);
    assert.equal(row.yellows, 1);
    assert.equal(row.disciplinePoints, D.DEFAULT_POINTS.foul + D.DEFAULT_POINTS.yellow);
    assert.equal(row.points, row.disciplinePoints);
  });

  it("makes a red card cost more than a goal is worth", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1").find((p) => p.pos === "FWD");

    scoreGoal(data, "m1", "t1", player.id);
    book(data, "m1", "t1", player.id, "red");
    playMatch(data, "m1", 1, 0);

    const row = D.playerStats(data).find((r) => r.playerId === player.id);
    assert.equal(row.goals, 1);
    assert.equal(row.reds, 1);
    assert.ok(row.points < 0, "scoring then being sent off should still be a net loss");
  });

  it("respects an edited weight", () => {
    const data = makeTournament();
    data.settings.points = { ...data.settings.points, yellow: -50 };
    // A forward, so the total is the booking and nothing else. A keeper or a
    // defender would also collect clean-sheet points from the 0-0 below.
    const player = squadOf(data, "t1").find((p) => p.pos === "FWD");

    book(data, "m1", "t1", player.id, "yellow");
    playMatch(data, "m1", 0, 0);

    assert.equal(D.playerStats(data).find((r) => r.playerId === player.id).points, -50);
  });

  it("still pays a booked defender for the clean sheet", () => {
    const data = makeTournament();
    const keeper = squadOf(data, "t1").find((p) => p.pos === "GK");

    book(data, "m1", "t1", keeper.id, "yellow");
    playMatch(data, "m1", 0, 0);

    const row = D.playerStats(data).find((r) => r.playerId === keeper.id);
    assert.equal(row.cleanSheets, 1);
    assert.equal(
      row.points,
      D.DEFAULT_POINTS.cleanSheetGK + D.DEFAULT_POINTS.yellow,
      "a booking is deducted from what they earned, not instead of it",
    );
  });

  it("puts a booked-only player in the ledger", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "foul");

    const row = D.playerStats(data).find((r) => r.playerId === player.id);
    assert.ok(D.hasRecord(row), "a player who only committed a foul still has a record");
  });
});

describe("sending off", () => {
  it("treats a second yellow as a sending off", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];

    book(data, "m1", "t1", player.id, "yellow");
    assert.equal(D.isSentOff(data.matches.m1, player.id).off, false);

    book(data, "m1", "t1", player.id, "yellow");
    const off = D.isSentOff(data.matches.m1, player.id);
    assert.equal(off.off, true);
    assert.equal(off.reason, "two-yellows");
  });

  it("warns before a second yellow is logged, not after", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];

    assert.equal(D.cardWouldSendOff(data.matches.m1, player.id, "yellow"), false);
    book(data, "m1", "t1", player.id, "yellow");
    assert.equal(D.cardWouldSendOff(data.matches.m1, player.id, "yellow"), true);
    assert.equal(D.cardWouldSendOff(data.matches.m1, player.id, "red"), true);
    assert.equal(D.cardWouldSendOff(data.matches.m1, player.id, "foul"), false);
  });

  it("does not invent a red card for a second yellow", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "yellow");
    book(data, "m1", "t1", player.id, "yellow");

    const row = D.playerStats(data).find((r) => r.playerId === player.id);
    assert.equal(row.reds, 0, "the log must show what the referee actually gave");
    assert.equal(row.yellows, 2);
  });

  it("keeps two yellows in different matches separate", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "yellow");
    book(data, "m3", "t1", player.id, "yellow");

    assert.equal(D.isSentOff(data.matches.m1, player.id).off, false);
    assert.equal(D.isSentOff(data.matches.m3, player.id).off, false);
  });
});

describe("suspensions", () => {
  it("bans a sent-off player from their team's next match", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "red");

    // t1's fixtures are m1, m3, m5. The next one after m1 is m3.
    assert.equal(D.suspendedFor(data, "m3").has(player.id), true);
    assert.equal(D.suspendedFor(data, "m5").has(player.id), false, "one match, not two");
    assert.equal(D.suspendedFor(data, "m2").has(player.id), false, "a match their team is not in");
  });

  it("counts the ban in their own team's fixtures", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "red");

    // m2 falls between m1 and m3 but t1 is not playing in it, so it must not
    // quietly serve the suspension.
    const suspended = D.suspendedFor(data, "m3").get(player.id);
    assert.ok(suspended);
    assert.equal(suspended.reason, "red");
    assert.equal(suspended.fromMatchNo, 1);
  });

  it("honours a longer ban setting", () => {
    const data = makeTournament();
    data.settings.redCardSuspensionMatches = 2;
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "red");

    assert.equal(D.suspendedFor(data, "m3").has(player.id), true);
    assert.equal(D.suspendedFor(data, "m5").has(player.id), true);
  });

  it("can be switched off entirely", () => {
    const data = makeTournament();
    data.settings.redCardSuspensionMatches = 0;
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "red");

    assert.equal(D.suspendedFor(data, "m3").size, 0);
  });

  it("suspends for a second yellow too", () => {
    const data = makeTournament();
    const player = squadOf(data, "t1")[0];
    book(data, "m1", "t1", player.id, "yellow");
    book(data, "m1", "t1", player.id, "yellow");

    assert.equal(D.suspendedFor(data, "m3").get(player.id).reason, "two-yellows");
  });
});

describe("fair play table", () => {
  it("orders the cleanest team first", () => {
    const data = makeTournament();
    book(data, "m1", "t1", squadOf(data, "t1")[0].id, "red");
    book(data, "m1", "t2", squadOf(data, "t2")[0].id, "foul");

    const table = D.disciplineTable(data);
    assert.equal(table[0].points, 0, "teams with nothing against them come first");
    assert.equal(table.at(-1).teamId, "t1", "the sending off is the worst record");
  });

  it("reports the cost as a positive number", () => {
    const data = makeTournament();
    book(data, "m1", "t1", squadOf(data, "t1")[0].id, "yellow");

    const row = D.disciplineTable(data).find((r) => r.teamId === "t1");
    assert.equal(row.yellows, 1);
    assert.equal(row.points, Math.abs(D.DEFAULT_POINTS.yellow));
  });

  it("counts a captain's card against the team", () => {
    const data = makeTournament();
    book(data, "m1", "t1", captainOf(data, "t1").id, "red");

    assert.equal(D.disciplineTable(data).find((r) => r.teamId === "t1").reds, 1);
  });

  it("awards fair play to the cleanest team", () => {
    const data = makeTournament();
    book(data, "m1", "t1", squadOf(data, "t1")[0].id, "red");
    playMatch(data, "m1", 0, 0);

    const fair = D.awards(data).fairPlay;
    assert.ok(fair);
    assert.notEqual(fair.teamId, "t1");
    assert.equal(fair.picked, false);
  });

  it("respects a fair play override", () => {
    const data = makeTournament();
    book(data, "m1", "t1", squadOf(data, "t1")[0].id, "red");
    data.settings.fairPlayTeamId = "t1";

    const fair = D.awards(data).fairPlay;
    assert.equal(fair.teamId, "t1");
    assert.equal(fair.picked, true);
  });
});

describe("per-match discipline tally", () => {
  it("counts each team separately", () => {
    const data = makeTournament();
    book(data, "m1", "t1", squadOf(data, "t1")[0].id, "foul");
    book(data, "m1", "t1", squadOf(data, "t1")[1].id, "foul");
    book(data, "m1", "t2", squadOf(data, "t2")[0].id, "yellow");

    assert.deepEqual(D.disciplineTally(data, data.matches.m1, "t1"), { foul: 2, yellow: 0, red: 0 });
    assert.deepEqual(D.disciplineTally(data, data.matches.m1, "t2"), { foul: 0, yellow: 1, red: 0 });
  });
});
