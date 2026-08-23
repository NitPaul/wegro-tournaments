/**
 * Auction rules.
 *
 * The guards in here are the ones that keep an auction from having to be
 * unwound in front of a room full of people. The stranding guard in particular
 * — where a legal purchase by one team makes a *different* team's squad
 * impossible — is subtle enough that it needs pinning down by test rather than
 * by reading.
 *
 * These now run on the server as well as the browser, so they are enforcement
 * rather than advice.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { makeTournament } from "../helpers/fixture.js";

/** An empty tournament: teams and captains, but nothing bought yet. */
function freshAuction({ squadSize = 6, pool = null } = {}) {
  const data = makeTournament();
  data.settings.squadSize = squadSize;
  data.settings.basePrice = 8;
  data.settings.budget = 100;

  // Strip the pre-bought squads back to an unsold pool.
  for (const p of Object.values(data.players)) {
    if (p.kind === "auction") {
      p.teamId = null;
      p.price = null;
    }
  }
  if (pool) {
    for (const p of Object.values(data.players)) {
      if (p.kind === "auction") delete data.players[p.id];
    }
    pool.forEach(([name, pos], i) => {
      const id = `x${i}`;
      data.players[id] = { id, name, pos, teamId: null, price: null, kind: "auction" };
    });
  }
  return data;
}

const unsoldOf = (data, pos) => D.auctionPlayers(data).find((p) => !p.teamId && p.pos === pos);

const sell = (data, playerId, teamId, price) => {
  data.players[playerId].teamId = teamId;
  data.players[playerId].price = price;
};

describe("auction basics", () => {
  it("accepts a legal bid", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    assert.deepEqual(D.validateSale(data, player.id, "t1", 10), { ok: true, error: null });
  });

  it("refuses a bid below base price", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    const res = D.validateSale(data, player.id, "t1", 5);
    assert.equal(res.ok, false);
    assert.match(res.error, /below base price/i);
  });

  it("refuses a player who is already sold", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    sell(data, player.id, "t2", 10);

    const res = D.validateSale(data, player.id, "t1", 10);
    assert.equal(res.ok, false);
    assert.match(res.error, /already sold/i);
  });

  it("refuses a second goalkeeper", () => {
    const data = freshAuction();
    const first = unsoldOf(data, "GK");
    sell(data, first.id, "t1", 10);

    const second = unsoldOf(data, "GK");
    const res = D.validateSale(data, second.id, "t1", 10);
    assert.equal(res.ok, false);
    assert.match(res.error, /limit is 1/i);
  });

  it("refuses a third player in a capped position", () => {
    const data = freshAuction();
    const picks = D.auctionPlayers(data).filter((p) => p.pos === "MID").slice(0, 2);
    for (const p of picks) sell(data, p.id, "t1", 8);

    const third = unsoldOf(data, "MID");
    const res = D.validateSale(data, third.id, "t1", 8);
    assert.equal(res.ok, false);
    assert.match(res.error, /limit is 2/i);
  });

  it("refuses a bid the team cannot afford", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    const res = D.validateSale(data, player.id, "t1", 200);
    assert.equal(res.ok, false);
    assert.match(res.error, /only has 100 BDT left/i);
  });

  it("refuses a bid when the auction is closed", () => {
    const data = freshAuction();
    data.settings.auctionOpen = false;
    const player = unsoldOf(data, "MID");
    const res = D.validateSale(data, player.id, "t1", 10);
    assert.equal(res.ok, false);
    assert.match(res.error, /closed/i);
  });
});

describe("the money guard", () => {
  it("stops a bid that would leave no money for the remaining slots", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    // 6 slots, base price 8. Buying one leaves 5 slots needing 40 minimum, so
    // the most that can be spent here is 60.
    assert.equal(D.auctionState(data).t1.maxBid, 60);

    const res = D.validateSale(data, player.id, "t1", 61);
    assert.equal(res.ok, false);
    assert.match(res.error, /too expensive/i);
    assert.match(res.error, /max bid is 60 BDT/i);
  });

  it("allows a bid of exactly the maximum", () => {
    const data = freshAuction();
    const player = unsoldOf(data, "MID");
    assert.equal(D.validateSale(data, player.id, "t1", 60).ok, true);
  });

  it("recomputes the maximum as the squad fills", () => {
    const data = freshAuction();
    const first = unsoldOf(data, "GK");
    sell(data, first.id, "t1", 20);

    const state = D.auctionState(data).t1;
    assert.equal(state.remaining, 80);
    assert.equal(state.slotsLeft, 5);
    assert.equal(state.maxBid, 80 - 4 * 8);
  });

  it("counts the jersey against the same budget", () => {
    const data = freshAuction();
    data.teams.t1.jerseyCost = 10;

    const state = D.auctionState(data).t1;
    assert.equal(state.spent, 10);
    assert.equal(state.remaining, 90);
  });
});

describe("the squad-shape guard", () => {
  it("stops a buy that would leave no slot for a required position", () => {
    const data = freshAuction({ squadSize: 4 });
    data.settings.minPerCategory = 1;

    // Fill three of four slots with MID and FWD, leaving one slot but two
    // positions still unrepresented.
    const mids = D.auctionPlayers(data).filter((p) => p.pos === "MID").slice(0, 2);
    const fwd = D.auctionPlayers(data).find((p) => p.pos === "FWD");
    for (const p of [...mids, fwd]) sell(data, p.id, "t1", 8);

    const anotherFwd = D.auctionPlayers(data).filter((p) => p.pos === "FWD" && !p.teamId)[0];
    const res = D.validateSale(data, anotherFwd.id, "t1", 8);
    assert.equal(res.ok, false);
    assert.match(res.error, /no slot left for/i);
  });
});

describe("the stranding guard", () => {
  it("stops a buy that would strand another team's required position", () => {
    // Four forwards exist, one per team, and every squad needs at least one.
    // The moment a team takes a second, only two are left for the three teams
    // that still need one — and nothing about the buying team's own budget or
    // slots would have told you that.
    const data = freshAuction();
    const forwards = D.auctionPlayers(data).filter((p) => p.pos === "FWD");
    assert.equal(forwards.length, 4, "fixture should have exactly one forward per team");

    sell(data, forwards[0].id, "t1", 8);

    const res = D.validateSale(data, forwards[1].id, "t1", 8);
    assert.equal(res.ok, false, "a second forward strands the other three teams");
    assert.match(res.error, /2 FWD would be left but 3 teams still need one/i);
    assert.match(res.error, /LEGACY, SHARIAH, SHOMOGRO/, "and should name them");
  });

  it("allows a second forward once another team no longer needs one", () => {
    const data = freshAuction();
    const forwards = D.auctionPlayers(data).filter((p) => p.pos === "FWD");

    // Give three teams their forward. One is left, one team still needs it —
    // so t1 taking a second is now simply impossible for a different reason.
    sell(data, forwards[0].id, "t1", 8);
    sell(data, forwards[1].id, "t2", 8);
    sell(data, forwards[2].id, "t3", 8);

    const res = D.validateSale(data, forwards[3].id, "t4", 8);
    assert.equal(res.ok, true, "the last forward must still be sellable to the team that needs it");
  });

  it("allows a normal buy when the pool is deep enough", () => {
    const data = freshAuction();
    const gk = unsoldOf(data, "GK");
    assert.equal(D.validateSale(data, gk.id, "t1", 8).ok, true);
  });

});

describe("auction state", () => {
  it("reports spend, slots and position counts", () => {
    const data = freshAuction();
    const gk = unsoldOf(data, "GK");
    const def = unsoldOf(data, "DEF");
    sell(data, gk.id, "t1", 12);
    sell(data, def.id, "t1", 15);

    const st = D.auctionState(data).t1;
    assert.equal(st.spent, 27);
    assert.equal(st.remaining, 73);
    assert.equal(st.slotsLeft, 4);
    assert.equal(st.counts.GK, 1);
    assert.equal(st.counts.DEF, 1);
    assert.equal(st.counts.MID, 0);
    assert.equal(st.stillRequired, 2, "still needs a MID and a FWD");
  });

  it("does not count the captain against the squad", () => {
    const data = freshAuction();
    assert.equal(D.auctionState(data).t1.squad.length, 0, "captain is not a bought player");
    assert.equal(D.auctionState(data).t1.slotsLeft, 6);
  });

  it("honours a per-team squad size", () => {
    const data = freshAuction();
    data.teams.t1.squadSize = 7;
    assert.equal(D.auctionState(data).t1.squadSize, 7);
    assert.equal(D.auctionState(data).t1.slotsLeft, 7);
    assert.equal(D.auctionState(data).t2.squadSize, 6);
  });

  it("tracks progress across the pool", () => {
    const data = freshAuction();
    const p = unsoldOf(data, "MID");
    sell(data, p.id, "t1", 20);

    const progress = D.auctionProgress(data);
    assert.equal(progress.sold, 1);
    assert.equal(progress.total, 24);
    assert.equal(progress.spend, 20);
    assert.equal(progress.done, false);
  });
});

describe("guest players", () => {
  it("can be placed on any team without limits", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "A Guest", pos: "MID", teamId: null, price: 0, kind: "guest" };

    assert.equal(D.validateGuestPlacement(data, "g1", "t1").ok, true);
    data.players.g1.teamId = "t1";

    // The squad is already full at 6, and the guest goes on top of it.
    assert.equal(D.auctionState(data).t1.slotsLeft, 0);
    assert.equal(D.auctionState(data).t1.guests.length, 1);
    assert.equal(D.teamPlayers(data, "t1").length, 8, "6 bought + 1 captain + 1 guest");
  });

  it("cannot be sold at the auction", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "A Guest", pos: "MID", teamId: null, price: 0, kind: "guest" };

    const res = D.validateSale(data, "g1", "t1", 10);
    assert.equal(res.ok, false);
    assert.match(res.error, /guest/i);
  });

  it("can be deleted while unused", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "A Guest", pos: "MID", teamId: "t1", price: 0, kind: "guest" };
    assert.equal(D.validateRemovePlayer(data, "g1").ok, true);
  });

  it("cannot be deleted once they are in the match log", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "A Guest", pos: "MID", teamId: "t1", price: 0, kind: "guest" };
    data.matches.m1.events = { e1: { id: "e1", type: "goal", teamId: "t1", playerId: "g1" } };

    const res = D.validateRemovePlayer(data, "g1");
    assert.equal(res.ok, false);
    assert.match(res.error, /match log/i);
    assert.match(res.error, /take them off the team/i);
  });

  it("is excluded from the position medals", () => {
    const data = makeTournament();
    data.players.g1 = { id: "g1", name: "Guest Keeper", pos: "GK", teamId: "t1", price: 0, kind: "guest" };
    data.matches.m1.events = {
      e1: { id: "e1", type: "save", teamId: "t1", playerId: "g1" },
      e2: { id: "e2", type: "save", teamId: "t1", playerId: "g1" },
      e3: { id: "e3", type: "save", teamId: "t1", playerId: "g1" },
    };

    const glove = D.awards(data).goldenGlove;
    assert.notEqual(glove?.playerId, "g1", "a guest should not take a season medal");
  });
});
