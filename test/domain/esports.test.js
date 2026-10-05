/**
 * Gaming tournaments: groups, knockout rounds decided on penalties, and the
 * separate record a person builds on the console.
 *
 * Shaped like the real one: WeGro FC 26, eight pairs, two groups of four,
 * semi-finals, a final.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { freshClock } from "../../shared/domain/clock.js";

/** Eight pairs across two groups, with fixtures inside each group. */
function fc26({ mode = "esports" } = {}) {
  const teams = {};
  const players = {};
  const matches = {};

  const pairs = [
    ["A", "Rocket Boys", ["Munna", "Anirban"]],
    ["A", "Night Owls", ["Sabbir", "Rabbe"]],
    ["A", "Desk Destroyers", ["Shanto", "Imran"]],
    ["A", "Last Minute", ["Faruk", "Mobin"]],
    ["B", "Code Red", ["Mehedi", "Afsar"]],
    ["B", "Pixel Pushers", ["Yousuf", "Ayon"]],
    ["B", "Overtime FC", ["Rafik", "Monir"]],
    ["B", "Coffee Breakers", ["Saad", "Uthsho"]],
  ];

  pairs.forEach(([group, name, members], i) => {
    const id = `tm${i + 1}`;
    teams[id] = { id, slot: String(i + 1), name, group, jerseyColor: "#fff", jerseyLabel: "", jerseyCost: 0 };
    members.forEach((member, n) => {
      const pid = `pl_${id}_${n}`;
      players[pid] = { id: pid, name: member, pos: "MID", teamId: id, kind: "auction", price: 0, personId: `pp_${member.toLowerCase()}` };
    });
  });

  // Round robin inside each group: 6 matches per group.
  let no = 1;
  for (const group of ["A", "B"]) {
    const ids = Object.values(teams).filter((t) => t.group === group).map((t) => t.id);
    for (const f of D.roundRobin(ids)) {
      const id = `m${no}`;
      matches[id] = {
        id, no, homeId: f.homeId, awayId: f.awayId, homeScore: null, awayScore: null,
        status: "scheduled", isFinal: false, stage: "group", clock: freshClock(), events: {},
      };
      no++;
    }
  }

  return {
    id: "tn_fc26",
    slug: "wegro-fc-26",
    name: "WeGro FC 26 Tournament",
    season: "October 2026",
    format: "league",
    mode,
    game: "EA SPORTS FC 26",
    status: "active",
    startsOn: "2026-10-09",
    meta: { venueName: "Meeting Room, WeGro HQ" },
    settings: { ...D.DEFAULT_SETTINGS, groups: 2, knockout: "semis" },
    teams,
    players,
    matches,
  };
}

const play = (data, id, home, away, extra = {}) => {
  Object.assign(data.matches[id], { homeScore: home, awayScore: away, status: "ft", ...extra });
  return data;
};

/** Finish every group match, so group A ends tm1, tm2, tm3, tm4 and group B tm5, tm6, tm7, tm8. */
function playGroups(data) {
  const rank = { tm1: 4, tm2: 3, tm3: 2, tm4: 1, tm5: 4, tm6: 3, tm7: 2, tm8: 1 };
  for (const m of Object.values(data.matches)) {
    if (D.stageOf(m) !== "group") continue;
    const h = rank[m.homeId];
    const a = rank[m.awayId];
    play(data, m.id, h > a ? 2 : 0, h > a ? 0 : 2);
  }
  return data;
}

describe("a gaming tournament", () => {
  it("knows it is one, and what is being played", () => {
    const data = fc26();
    assert.equal(D.isEsports(data), true);
    assert.equal(D.gameName(data), "EA SPORTS FC 26");
    assert.equal(D.isEsports(fc26({ mode: "field" })), false);
    assert.equal(D.gameName(fc26({ mode: "field" })), "");
  });

  it("keeps a pair together under one team name", () => {
    const data = fc26();
    const members = D.teamMembers(data, "tm1");
    assert.deepEqual(members.map((m) => m.name).sort(), ["Anirban", "Munna"]);
    assert.equal(data.teams.tm1.name, "Rocket Boys");
  });
});

describe("groups", () => {
  it("lists the groups in play", () => {
    assert.deepEqual(D.groupLabels(fc26()), ["A", "B"]);
    assert.deepEqual(D.groupLabels({ teams: { x: { id: "x", name: "Solo" } } }), []);
  });

  it("builds six fixtures per group of four, and none across the groups", () => {
    const data = fc26();
    const group = D.groupMatches(data);
    assert.equal(group.length, 12);
    for (const m of group) {
      assert.equal(data.teams[m.homeId].group, data.teams[m.awayId].group, "no match crosses the groups");
    }
  });

  it("gives each group its own table, counting only that group's matches", () => {
    const data = playGroups(fc26());
    const tables = D.groupTables(data);
    assert.deepEqual(tables.map((t) => t.group), ["A", "B"]);
    for (const { table } of tables) {
      assert.equal(table.length, 4);
      assert.equal(table[0].played, 3, "three matches each, not six");
    }
    assert.deepEqual(tables[0].table.map((r) => r.teamId), ["tm1", "tm2", "tm3", "tm4"]);
    assert.deepEqual(tables[1].table.map((r) => r.teamId), ["tm5", "tm6", "tm7", "tm8"]);
  });

  it("still gives one table when nobody is in a group", () => {
    const data = fc26();
    for (const t of Object.values(data.teams)) t.group = null;
    const tables = D.groupTables(data);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].group, null);
    assert.equal(tables[0].table.length, 8);
  });
});

describe("the knockout rounds", () => {
  it("suggests group winner against the other group's runner-up, and saves nothing", () => {
    const data = playGroups(fc26());
    const seeds = D.seedKnockout(data);
    assert.deepEqual(seeds, [
      { homeId: "tm1", awayId: "tm6", homeLabel: "A1", awayLabel: "B2" },
      { homeId: "tm5", awayId: "tm2", homeLabel: "B1", awayLabel: "A2" },
    ]);
    assert.equal(D.knockoutMatches(data).length, 0, "a suggestion is not a fixture");
  });

  it("pairs the top four when there is only one group", () => {
    const data = playGroups(fc26());
    for (const t of Object.values(data.teams)) t.group = null;
    const seeds = D.seedKnockout(data);
    assert.deepEqual(seeds.map((s) => [s.homeLabel, s.awayLabel]), [["1st", "4th"], ["2nd", "3rd"]]);
  });

  it("is decided on penalties when the match is level", () => {
    const data = fc26();
    data.matches.sf1 = { id: "sf1", no: 13, homeId: "tm1", awayId: "tm6", stage: "semi", isFinal: false, status: "scheduled", events: {}, clock: freshClock() };
    play(data, "sf1", 2, 2);

    assert.equal(D.needsPenalties(data.matches.sf1), true, "level, and nobody has recorded the shoot-out");
    assert.equal(D.matchWinner(data, data.matches.sf1).winnerId, null);

    play(data, "sf1", 2, 2, { homePens: 4, awayPens: 3 });
    const result = D.matchWinner(data, data.matches.sf1);
    assert.equal(result.winnerId, "tm1");
    assert.equal(result.loserId, "tm6");
    assert.equal(result.onPenalties, true);
    assert.equal(D.needsPenalties(data.matches.sf1), false);
    assert.equal(D.scoreLine(data.matches.sf1), "2–2 (4–3 on pens)");
  });

  it("leaves a drawn group match a draw, penalties or not", () => {
    const data = play(fc26(), "m1", 1, 1);
    const result = D.matchWinner(data, data.matches.m1);
    assert.equal(result.winnerId, null);
    assert.equal(result.level, true);
    assert.equal(D.needsPenalties(data.matches.m1), false);
    assert.equal(D.scoreLine(data.matches.m1), "1–1");
  });

  it("names the finalists once both semi-finals are settled", () => {
    const data = playGroups(fc26());
    data.matches.sf1 = { id: "sf1", no: 13, homeId: "tm1", awayId: "tm6", stage: "semi", isFinal: false, status: "scheduled", events: {}, clock: freshClock() };
    data.matches.sf2 = { id: "sf2", no: 14, homeId: "tm5", awayId: "tm2", stage: "semi", isFinal: false, status: "scheduled", events: {}, clock: freshClock() };
    assert.equal(D.finalists(data), null);
    play(data, "sf1", 3, 1);
    assert.equal(D.finalists(data), null, "one is not enough");
    play(data, "sf2", 1, 1, { homePens: 2, awayPens: 4 });
    assert.deepEqual(D.finalists(data), { homeId: "tm1", awayId: "tm2" });
  });

  it("crowns the champion of a final won on penalties", () => {
    const data = playGroups(fc26());
    data.matches.f = { id: "f", no: 15, homeId: "tm1", awayId: "tm5", stage: "final", isFinal: true, status: "scheduled", events: {}, clock: freshClock() };
    play(data, "f", 2, 2);
    assert.equal(D.champion(data), null, "level, and the shoot-out is not in yet");

    play(data, "f", 2, 2, { homePens: 5, awayPens: 4 });
    const result = D.champion(data);
    assert.equal(result.winner.name, "Rocket Boys");
    assert.equal(result.runnerUp.name, "Code Red");
    assert.equal(result.decidedBy, "penalties");
    assert.equal(result.finalScore, "2–2 (5–4 on pens)");
  });
});

describe("a person's two records", () => {
  it("builds a gaming record from their pair's results, not from goal events", () => {
    const data = playGroups(fc26());
    const careers = D.buildCareers([data]);
    const munna = careers.get("pp_munna");

    assert.equal(munna.game.totals.matches, 3);
    assert.equal(munna.game.totals.won, 3);
    assert.equal(munna.game.totals.points, 9);
    assert.equal(munna.game.totals.goalsFor, 6);
    assert.equal(munna.totals.matches, 0, "nothing lands on their football record");
    assert.equal(munna.totals.goals, 0);

    const entry = munna.game.tournaments[0];
    assert.equal(entry.team.name, "Rocket Boys");
    assert.equal(entry.team.group, "A");
    assert.deepEqual(entry.partners.map((p) => p.name), ["Anirban"]);
  });

  it("gives both of a pair the same record", () => {
    const careers = D.buildCareers([playGroups(fc26())]);
    assert.deepEqual(careers.get("pp_munna").game.totals, careers.get("pp_anirban").game.totals);
  });

  it("counts a gaming title without touching the football one", () => {
    const data = playGroups(fc26());
    data.matches.f = { id: "f", no: 15, homeId: "tm1", awayId: "tm5", stage: "final", isFinal: true, status: "ft", homeScore: 3, awayScore: 1, events: {}, clock: freshClock() };
    const archive = { tournamentId: data.id, championTeamId: "tm1", runnerUpTeamId: "tm5", medals: {} };

    const careers = D.buildCareers([data], [archive]);
    assert.equal(careers.get("pp_munna").game.titles, 1);
    assert.equal(careers.get("pp_munna").titles, 0, "a football title is a different thing");
    assert.equal(careers.get("pp_mehedi").game.finals, 1, "the runners-up reached the final");
    assert.equal(careers.get("pp_mehedi").game.titles, 0);
  });

  it("keeps the two apart for somebody who plays both", () => {
    const game = playGroups(fc26());
    const football = {
      id: "tn_f", slug: "cl", name: "Champions League", season: "2026", format: "league", mode: "field",
      status: "completed", settings: { ...D.DEFAULT_SETTINGS },
      teams: { t1: { id: "t1", name: "SHOMOGRO" } },
      players: { p1: { id: "p1", name: "Munna", pos: "FWD", teamId: "t1", kind: "auction", personId: "pp_munna" } },
      matches: {
        fm1: {
          id: "fm1", no: 1, homeId: "t1", awayId: null, homeScore: 2, awayScore: 0, status: "ft", isFinal: false,
          clock: freshClock(),
          events: { e1: { id: "e1", type: "goal", teamId: "t1", playerId: "p1" } },
        },
      },
    };

    const munna = D.buildCareers([game, football]).get("pp_munna");
    assert.equal(munna.totals.goals, 1, "the football goal");
    assert.equal(munna.game.totals.won, 3, "the FC 26 wins");
    assert.equal(munna.game.totals.goalsFor, 6);
    assert.equal(munna.totals.matches, 1);
  });
});

describe("the gaming rating", () => {
  it("says nothing before two matches", () => {
    assert.equal(D.gameStatsRating({ matches: 1, points: 3 }), null);
  });

  it("rates winning everything above drawing everything above losing everything", () => {
    const perfect = D.gameStatsRating({ matches: 6, points: 18 });
    const drawer = D.gameStatsRating({ matches: 6, points: 6 });
    const loser = D.gameStatsRating({ matches: 6, points: 0 });
    assert.ok(perfect > drawer && drawer > loser, `${perfect} / ${drawer} / ${loser}`);
    assert.ok(perfect <= 95 && loser >= 40);
  });

  it("does not make a 95 out of three matches", () => {
    assert.ok(D.gameStatsRating({ matches: 3, points: 9 }) < 85);
  });

  it("prefers the rating the super admin gave", () => {
    assert.deepEqual(D.gameHeadlineRating({ gameRating: 91 }, { matches: 6, points: 0 }), { value: 91, source: "admin" });
    assert.equal(D.gameHeadlineRating({ gameRating: null }, { matches: 6, points: 18 }).source, "stats");
    assert.deepEqual(D.gameHeadlineRating({}, { matches: 0, points: 0 }), { value: null, source: null });
  });
});
