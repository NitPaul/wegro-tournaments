/**
 * Careers, ratings and name suggestions — the rules behind the player list.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildCareers } from "../../shared/domain/career.js";
import { headlineRating, ratingBand, statsRating } from "../../shared/domain/rating.js";
import { nameFromFileName, nameScore, suggestPeople } from "../../shared/domain/names.js";
import { addEvent, captainOf, makeTournament, playMatch, scoreGoal, squadOf } from "../helpers/fixture.js";

/** Two tournaments in which the same people played, for different teams. */
function twoSeasons() {
  const s1 = makeTournament({ id: "tn_2026", name: "Cup", season: "2026", startsOn: "2026-08-01" });
  const s2 = makeTournament({ id: "tn_2027", name: "Cup", season: "2027", startsOn: "2027-08-01" });

  // Munna: a forward for LOSS MAKER in 2026, for LEGACY in 2027.
  const munna26 = squadOf(s1, "t1").find((p) => p.pos === "FWD");
  const munna27 = squadOf(s2, "t2").find((p) => p.pos === "FWD");
  munna26.personId = "pp_munna";
  munna27.personId = "pp_munna";

  // A captain with a person too — captains count in careers like anyone.
  captainOf(s1, "t4").personId = "pp_mehedi";

  return { s1, s2, munna26, munna27 };
}

describe("careers", () => {
  it("adds up a person's goals across tournaments and teams", () => {
    const { s1, s2, munna26, munna27 } = twoSeasons();
    scoreGoal(s1, "m1", "t1", munna26.id);
    scoreGoal(s1, "m1", "t1", munna26.id);
    playMatch(s1, "m1", 2, 0);
    scoreGoal(s2, "m1", "t2", munna27.id);
    playMatch(s2, "m1", 0, 1);

    const munna = buildCareers([s1, s2]).get("pp_munna");
    assert.equal(munna.totals.goals, 3);
    assert.equal(munna.tournaments.length, 2);
    assert.deepEqual(
      munna.tournaments.map((t) => [t.season, t.team.name, t.stats.goals]),
      [
        ["2027", "LEGACY", 1],
        ["2026", "LOSS MAKER", 2],
      ],
      "newest first, with the team they played for that year",
    );
  });

  it("counts a captain's goals — the captain fix carries into careers", () => {
    const { s1 } = twoSeasons();
    const mehedi = captainOf(s1, "t4");
    scoreGoal(s1, "m2", "t4", mehedi.id);
    playMatch(s1, "m2", 0, 1);
    assert.equal(buildCareers([s1]).get("pp_mehedi").totals.goals, 1);
  });

  it("credits a player with every finished match their team played", () => {
    const { s1 } = twoSeasons();
    playMatch(s1, "m1", 1, 0); // t1 v t2
    playMatch(s1, "m3", 0, 0); // t1 v t3
    playMatch(s1, "m2", 2, 2); // t3 v t4 — not LOSS MAKER's
    assert.equal(buildCareers([s1]).get("pp_munna").totals.matches, 2);
  });

  it("credits a guest only with matches something was logged against them", () => {
    const s = makeTournament();
    s.players.g1 = { id: "g1", name: "Chairman", pos: "MID", teamId: "t1", kind: "guest", personId: "pp_chair" };
    playMatch(s, "m1", 0, 0);
    playMatch(s, "m3", 0, 0);
    addEvent(s, "m3", { type: "shot", teamId: "t1", playerId: "g1" });
    assert.equal(buildCareers([s]).get("pp_chair").totals.matches, 1);
  });

  it("leaves out tournament players who are not linked to anyone", () => {
    const { s1 } = twoSeasons();
    const careers = buildCareers([s1]);
    assert.deepEqual([...careers.keys()].sort(), ["pp_mehedi", "pp_munna"]);
  });

  it("counts titles and medals from the hall of fame", () => {
    const { s1, munna26 } = twoSeasons();
    const archive = {
      tournamentId: s1.id,
      championTeamId: "t1",
      medals: { goldenBoot: { playerId: munna26.id, playerName: munna26.name } },
    };
    const munna = buildCareers([s1], [archive]).get("pp_munna");
    assert.equal(munna.titles, 1);
    assert.deepEqual(
      munna.medals.map((m) => [m.label, m.season]),
      [["Golden Boot", "2026"]],
    );
    assert.equal(munna.tournaments[0].champion, true);
  });
});

describe("the stats rating", () => {
  it("says nothing with fewer than two matches", () => {
    assert.equal(statsRating({ matches: 0, points: 0 }), null);
    assert.equal(statsRating({ matches: 1, points: 40 }), null);
  });

  it("does not let one great afternoon make anyone a 95", () => {
    const early = statsRating({ matches: 2, points: 16 }); // 8 a match
    const proven = statsRating({ matches: 20, points: 160 }); // 8 a match, for a season
    assert.ok(early <= 80, `two matches of an extraordinary 8 points each gave ${early}`);
    assert.ok(proven > early, "the same form over more matches is believed more");
  });

  it("drifts towards 60 when there is little to go on", () => {
    const r = statsRating({ matches: 2, points: 2 });
    assert.ok(r >= 55 && r <= 62, `got ${r}`);
  });

  it("goes down for cards and fouls, because points do", () => {
    const clean = statsRating({ matches: 6, points: 12 });
    const booked = statsRating({ matches: 6, points: 12 - 16 });
    assert.ok(booked < clean);
  });

  it("stays between 40 and 95", () => {
    assert.equal(statsRating({ matches: 500, points: 50_000 }), 95);
    assert.equal(statsRating({ matches: 500, points: -50_000 }), 40);
  });

  it("puts the 2026 Golden Ball ahead of an ordinary record", () => {
    // Iftiakh Siam: 14 points over 4 matches. A typical squad player: 3 over 4.
    assert.ok(statsRating({ matches: 4, points: 14 }) > statsRating({ matches: 4, points: 3 }));
  });

  it("gives the admin's number first, and says where the number came from", () => {
    assert.deepEqual(headlineRating({ rating: 81 }, { matches: 10, points: 5 }), { value: 81, source: "admin" });
    assert.equal(headlineRating({ rating: null }, { matches: 10, points: 30 }).source, "stats");
    assert.deepEqual(headlineRating({ rating: null }, { matches: 0, points: 0 }), { value: null, source: null });
  });

  it("bands ratings for display", () => {
    assert.equal(ratingBand(90), "elite");
    assert.equal(ratingBand(70), "good");
    assert.equal(ratingBand(null), "none");
  });
});

describe("name suggestions", () => {
  const roster = [
    { id: "a", name: "Mahmud Hasan Munna" },
    { id: "b", name: "Sadman Sabbir" },
    { id: "c", name: "Iftiak Hossain Khan" },
    { id: "d", name: "Siyam" },
    { id: "e", name: "MD. Mehedi Hasan" },
    { id: "f", name: "KBD MD. Robiullah" },
  ];

  it("finds a full name from the short one on the scoresheet", () => {
    assert.equal(suggestPeople("Munna", roster)[0].person.id, "a");
    assert.equal(suggestPeople("Sabbir", roster)[0].person.id, "b");
    assert.equal(suggestPeople("KBD MD. Robiullah", roster)[0].person.id, "f");
  });

  it("forgives a one-letter spelling difference in a longer name", () => {
    const ids = suggestPeople("Iftiakh Siam", roster).map((s) => s.person.id);
    // Both photos are plausible for "Iftiakh Siam". That is exactly why the
    // admin chooses: offering both is right, picking one would be a guess.
    assert.ok(ids.includes("c"), "Iftiak Hossain Khan");
    assert.ok(ids.includes("d"), "Siyam");
  });

  it("recognises a nickname that is the start of the full name", () => {
    const more = [...roster, { id: "g", name: "Md Rafikul Islam" }, { id: "h", name: "Md Moniruzzaman" }];
    assert.equal(suggestPeople("Rafik", more)[0].person.id, "g");
    assert.equal(suggestPeople("Monir", more)[0].person.id, "h");
    assert.deepEqual(suggestPeople("Ar", [{ id: "x", name: "Arif Rahman" }]), [], "too short to mean anything");
  });

  it("ignores honorifics and bracketed notes", () => {
    assert.equal(nameScore("Mehedi (ops)", "MD. Mehedi Hasan"), 1);
    assert.equal(nameScore("Md Mehedi", "Mehedi Hasan"), 1);
  });

  it("offers nothing rather than a guess when no word matches", () => {
    assert.deepEqual(suggestPeople("Papon Bhai", roster), []);
  });

  it("does not treat short names that merely look alike as the same", () => {
    assert.equal(nameScore("Saad", "Sajid"), 0);
  });

  it("turns a photo's file name into a name", () => {
    assert.equal(nameFromFileName("mahmud-hasan-munna.png"), "Mahmud Hasan Munna");
    assert.equal(nameFromFileName("Alvi_Vai.png"), "Alvi Vai");
    assert.equal(nameFromFileName("Iftiak Hossain Khan.png"), "Iftiak Hossain Khan");
    assert.equal(nameFromFileName("n-m-zarif-rahman.png"), "N M Zarif Rahman");
  });
});
