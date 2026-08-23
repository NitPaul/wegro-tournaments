/**
 * Test fixtures — a small tournament document built by hand.
 *
 * Deliberately not loaded from the database: the domain layer is pure, and
 * testing it against plain objects keeps these tests fast and keeps a failure
 * pointing at the rule that broke rather than at the storage underneath it.
 */

import { DEFAULT_SETTINGS } from "../../shared/domain/constants.js";
import { freshClock } from "../../shared/domain/clock.js";

let seq = 0;
const uid = (prefix) => `${prefix}_${(seq++).toString(36).padStart(3, "0")}`;

/**
 * A four-team tournament with captains, a bought squad each, and a full
 * round-robin plus a final. Nothing is played until a test says so.
 */
export function makeTournament(overrides = {}) {
  seq = 0;

  const teams = {};
  const players = {};
  const matches = {};

  const squads = [
    ["A", "LOSS MAKER", "Robiullah"],
    ["B", "LEGACY", "Alvi"],
    ["C", "SHARIAH", "Mehrab"],
    ["D", "SHOMOGRO", "Mehedi"],
  ];

  const teamIds = [];
  squads.forEach(([slot, name, captain], i) => {
    const id = `t${i + 1}`;
    teamIds.push(id);
    teams[id] = { id, slot, name, jerseyColor: "#fff", jerseyLabel: "White", jerseyCost: 0, squadSize: null };

    // The captain is a real player. This is the whole point.
    const capId = `c${i + 1}`;
    players[capId] = { id: capId, name: captain, pos: "MID", teamId: id, price: 0, kind: "captain" };

    // Six bought players: 1 GK, 2 DEF, 2 MID, 1 FWD — a legal squad.
    const shape = [["GK", 1], ["DEF", 2], ["MID", 2], ["FWD", 1]];
    shape.forEach(([pos, count]) => {
      for (let n = 0; n < count; n++) {
        const pid = uid("p");
        players[pid] = {
          id: pid,
          name: `${name.split(" ")[0]}-${pos}${n + 1}`,
          pos,
          teamId: id,
          price: 10,
          kind: "auction",
        };
      }
    });
  });

  // Full round robin: 6 matches, then the final.
  const pairs = [
    [0, 1], [2, 3], [0, 2], [1, 2], [0, 3], [1, 3],
  ];
  pairs.forEach(([h, a], i) => {
    const id = `m${i + 1}`;
    matches[id] = {
      id,
      no: i + 1,
      homeId: teamIds[h],
      awayId: teamIds[a],
      homeScore: null,
      awayScore: null,
      status: "scheduled",
      isFinal: false,
      clock: freshClock(),
      events: {},
    };
  });
  matches.m7 = {
    id: "m7",
    no: 7,
    homeId: null,
    awayId: null,
    homeScore: null,
    awayScore: null,
    status: "scheduled",
    isFinal: true,
    clock: freshClock(),
    events: {},
  };

  return {
    id: "tn_test",
    slug: "test-cup",
    name: "Test Cup",
    season: "2026",
    format: "league",
    status: "active",
    meta: { venueName: "Test Turf" },
    settings: { ...DEFAULT_SETTINGS },
    teams,
    players,
    matches,
    ...overrides,
  };
}

/** Set a scoreline and mark the match full-time. */
export function playMatch(data, matchId, homeScore, awayScore) {
  const m = data.matches[matchId];
  m.homeScore = homeScore;
  m.awayScore = awayScore;
  m.status = "ft";
  return data;
}

/** Add an event to a match. Returns its id. */
export function addEvent(data, matchId, event) {
  const m = data.matches[matchId];
  const id = uid("e");
  m.events = m.events || {};
  m.events[id] = { id, createdAt: Date.now(), penalty: false, critical: false, ownGoal: false, ...event };
  return id;
}

/** Score a goal: bumps the scoreline and logs the event, as the console does. */
export function scoreGoal(data, matchId, teamId, playerId, extra = {}) {
  const m = data.matches[matchId];
  const home = m.homeId === teamId;
  m.homeScore = Number(m.homeScore || 0) + (home ? 1 : 0);
  m.awayScore = Number(m.awayScore || 0) + (home ? 0 : 1);
  if (m.status === "scheduled") m.status = "live";
  return addEvent(data, matchId, { type: "goal", teamId, playerId, ...extra });
}

/** Every player on a team, by name, for readable assertions. */
export function playerNamed(data, name) {
  return Object.values(data.players).find((p) => p.name === name) || null;
}

export function captainOf(data, teamId) {
  return Object.values(data.players).find((p) => p.kind === "captain" && p.teamId === teamId) || null;
}

export function squadOf(data, teamId) {
  return Object.values(data.players).filter((p) => p.kind === "auction" && p.teamId === teamId);
}
