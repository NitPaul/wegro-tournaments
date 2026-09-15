/**
 * Upcoming, live, in progress, finished — worked out, never set by hand.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatDay, sortByPhase, todayISO, tournamentPhase } from "../../shared/domain/phase.js";

const NOW = new Date(2027, 2, 10, 12, 0).getTime(); // 10 March 2027, local
const base = { status: "active", startsOn: null, liveMatches: 0, playedMatches: 0 };

describe("tournament phase", () => {
  it("hides a draft", () => {
    assert.equal(tournamentPhase({ ...base, status: "draft" }, NOW), "hidden");
  });

  it("shows a published tournament with no date, venue or matches as coming soon", () => {
    assert.equal(tournamentPhase(base, NOW), "upcoming");
  });

  it("stays coming soon until its start date", () => {
    assert.equal(tournamentPhase({ ...base, startsOn: "2027-03-11" }, NOW), "upcoming");
    assert.equal(tournamentPhase({ ...base, startsOn: "2027-03-10" }, NOW), "ongoing");
  });

  it("goes live the moment a match is being played, whatever the date says", () => {
    assert.equal(tournamentPhase({ ...base, startsOn: "2027-06-01", liveMatches: 1 }, NOW), "live");
  });

  it("is in progress between matches once any has been played", () => {
    assert.equal(tournamentPhase({ ...base, playedMatches: 2 }, NOW), "ongoing");
  });

  it("is finished once completed, even with a match left marked live", () => {
    assert.equal(tournamentPhase({ ...base, status: "completed", liveMatches: 1 }, NOW), "finished");
  });

  it("orders live, then in progress, then soonest coming, then most recent finished", () => {
    const list = [
      { id: "old", ...base, status: "completed", startsOn: "2025-08-01" },
      { id: "later", ...base, startsOn: "2027-09-01" },
      { id: "undated", ...base },
      { id: "recent", ...base, status: "completed", startsOn: "2026-08-01" },
      { id: "live", ...base, liveMatches: 1 },
      { id: "soon", ...base, startsOn: "2027-04-01" },
      { id: "going", ...base, playedMatches: 3 },
    ];
    assert.deepEqual(
      sortByPhase(list, NOW).map((t) => t.id),
      ["live", "going", "soon", "later", "undated", "recent", "old"],
    );
  });

  it("formats a day, and says nothing for no date", () => {
    assert.equal(formatDay("2027-08-01"), "Sunday, 1 August 2027");
    assert.equal(formatDay(null), null);
    assert.equal(formatDay("soon"), null);
  });

  it("uses the local calendar day", () => {
    assert.equal(todayISO(NOW), "2027-03-10");
  });
});
