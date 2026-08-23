/**
 * The captain bug, pinned.
 *
 * The reported symptom was "the team captain data is not showing in player
 * point stats". The cause was that a captain had no player record at all — they
 * were two strings on the team row — so a captain's goal could only be stored
 * as a name and every statistics table, all of which key off a player id,
 * dropped it. The match log still showed it, because the renderers had a name
 * fallback the stat functions did not.
 *
 * These tests exist so that can never come back quietly. If somebody ever
 * "optimises" captains back out of the players list, this file goes red.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { addEvent, captainOf, makeTournament, playMatch, scoreGoal, squadOf } from "../helpers/fixture.js";

describe("captains are real players", () => {
  it("appears in the players list", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    assert.ok(captain, "team should have a captain");
    assert.ok(
      D.playersList(data).some((p) => p.id === captain.id),
      "captain must be in playersList — every stat table iterates it",
    );
    assert.equal(D.playerById(data, captain.id).name, captain.name);
  });

  it("is excluded from the auction pool and squad limits", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    assert.ok(!D.auctionPlayers(data).some((p) => p.id === captain.id), "captain is not biddable");
    assert.ok(!D.teamSquad(data, "t1").some((p) => p.id === captain.id), "captain does not use a squad slot");
    assert.ok(D.teamPlayers(data, "t1").some((p) => p.id === captain.id), "captain is on the team");
    assert.ok(D.teamRoster(data, "t1").some((p) => p.id === captain.id), "captain is part of the roster");
  });

  it("counts a captain goal in the points ledger — the reported bug", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    scoreGoal(data, "m1", "t1", captain.id);
    playMatch(data, "m1", 1, 0);

    const row = D.playerStats(data).find((r) => r.playerId === captain.id);
    assert.ok(row, "captain must have a row in the ledger");
    assert.equal(row.goals, 1, "the captain's goal must be counted");
    assert.ok(row.points > 0, "and must be worth points");
    assert.ok(D.hasRecord(row), "and must show in the ledger, which filters on hasRecord");
  });

  it("counts a captain goal in the top scorers table", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    scoreGoal(data, "m1", "t1", captain.id);
    playMatch(data, "m1", 1, 0);

    const scorers = D.topScorers(data);
    assert.equal(scorers.length, 1);
    assert.equal(scorers[0].playerId, captain.id);
    assert.equal(scorers[0].value, 1);
    assert.equal(scorers[0].team.id, "t1", "and knows which team they play for");
  });

  it("counts a captain assist", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");
    const striker = squadOf(data, "t1").find((p) => p.pos === "FWD");

    scoreGoal(data, "m1", "t1", striker.id, { assistId: captain.id });
    playMatch(data, "m1", 1, 0);

    assert.equal(D.topAssists(data)[0].playerId, captain.id);
    assert.equal(D.playerStats(data).find((r) => r.playerId === captain.id).assists, 1);
  });

  it("can win a medal", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    for (let i = 0; i < 4; i++) scoreGoal(data, "m1", "t1", captain.id);
    playMatch(data, "m1", 4, 0);

    const medals = D.awards(data);
    assert.equal(medals.goldenBoot[0].playerId, captain.id, "captain should be able to win the Golden Boot");
    assert.equal(medals.goldenBall.playerId, captain.id, "and the Golden Ball");
  });

  it("gets a clean sheet when the captain keeps goal", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t2");

    // Make the captain the keeper, and remove the bought one so there is no
    // ambiguity about who the sheet belongs to.
    captain.pos = "GK";
    const boughtKeeper = squadOf(data, "t2").find((p) => p.pos === "GK");
    delete data.players[boughtKeeper.id];

    playMatch(data, "m1", 0, 2); // t2 away, keeps a clean sheet

    assert.equal(D.teamKeeper(data, "t2").id, captain.id, "captain should be found as the keeper");
    const sheets = D.cleanSheets(data).find((r) => r.playerId === captain.id);
    assert.ok(sheets, "captain keeper must appear in the clean sheet table");
    assert.equal(sheets.value, 1);

    const row = D.playerStats(data).find((r) => r.playerId === captain.id);
    assert.equal(row.cleanSheets, 1, "and be paid for it in the ledger");
  });

  it("prefers a bought keeper over a captain who also keeps goal", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t2");
    captain.pos = "GK";

    const bought = squadOf(data, "t2").find((p) => p.pos === "GK");
    assert.equal(D.teamKeeper(data, "t2").id, bought.id);
  });

  it("counts a captain's card", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");

    addEvent(data, "m1", { type: "yellow", teamId: "t1", playerId: captain.id });
    playMatch(data, "m1", 0, 0);

    const row = D.playerStats(data).find((r) => r.playerId === captain.id);
    assert.equal(row.yellows, 1);
    assert.ok(row.points < 0, "a booking and nothing else should leave a negative total");
  });

  it("refuses a second captain for the same team", () => {
    const data = makeTournament();
    const res = D.validateNewPlayer(data, { name: "Someone Else", pos: "MID", teamId: "t1", kind: "captain" });
    assert.equal(res.ok, false);
    assert.match(res.error, /already has a captain/i);
  });

  it("refuses a captain with no team", () => {
    const data = makeTournament();
    const res = D.validateNewPlayer(data, { name: "Nobody", pos: "MID", teamId: null, kind: "captain" });
    assert.equal(res.ok, false);
    assert.match(res.error, /needs a team/i);
  });

  it("refuses a duplicate name, whatever the kind", () => {
    const data = makeTournament();
    const existing = captainOf(data, "t1");
    const res = D.validateNewPlayer(data, { name: existing.name.toUpperCase(), pos: "FWD", teamId: "t2" });
    assert.equal(res.ok, false);
    assert.match(res.error, /already a player called/i);
  });

  it("cannot be sold at the auction", () => {
    const data = makeTournament();
    const captain = captainOf(data, "t1");
    const res = D.validateSale(data, captain.id, "t2", 10);
    assert.equal(res.ok, false);
    assert.match(res.error, /captain/i);
  });
});
