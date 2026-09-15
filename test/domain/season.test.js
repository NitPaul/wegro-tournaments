/**
 * Monthly seasons ("September 2026"), and dates that are not decided yet.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ANNOUNCED_SOON, parseSeason, seasonHeading, seasonLabel, seasonSortKey, seasonYear } from "../../shared/domain/season.js";

describe("seasons", () => {
  it("names a month and a year", () => {
    assert.equal(seasonLabel(9, 2026), "September 2026");
    assert.equal(seasonLabel("", "2026"), "2026", "a year on its own is still a season");
    assert.equal(seasonLabel(9, ""), "", "a month needs a year");
    assert.equal(seasonLabel(13, 2026), "2026");
  });

  it("reads a season back into its month and year", () => {
    assert.deepEqual(parseSeason("September 2026"), { month: 9, year: 2026 });
    assert.deepEqual(parseSeason("Sep 2026"), { month: 9, year: 2026 });
    assert.deepEqual(parseSeason("2026-09"), { month: 9, year: 2026 });
    assert.deepEqual(parseSeason("2026"), { month: null, year: 2026 });
    assert.deepEqual(parseSeason("Winter cup"), { month: null, year: null }, "old free text is left alone");
    assert.deepEqual(parseSeason(""), { month: null, year: null });
  });

  it("sorts September after March, and uses the start date when there is one", () => {
    const list = [
      { id: "sep", season: "September 2026" },
      { id: "mar", season: "March 2026" },
      { id: "y25", season: "2025" },
      { id: "dated", season: "March 2026", startsOn: "2026-12-01" },
    ];
    const order = [...list].sort((a, b) => seasonSortKey(a).localeCompare(seasonSortKey(b))).map((t) => t.id);
    assert.deepEqual(order, ["y25", "mar", "sep", "dated"]);
  });

  it("finds the year for grouping the Hall of Fame", () => {
    assert.equal(seasonYear("September 2026"), 2026);
    assert.equal(seasonYear("2027"), 2027);
    assert.equal(seasonYear("Winter cup"), null);
  });

  it("reads naturally after a tournament name", () => {
    assert.equal(seasonHeading("2026"), "Season 2026");
    assert.equal(seasonHeading("September 2026"), "September 2026", "not \"Season September 2026\"");
    assert.equal(seasonHeading(""), "");
  });

  it("says a missing date will be announced soon", () => {
    assert.equal(ANNOUNCED_SOON, "Will be announced soon");
  });
});
