/**
 * The match clock.
 *
 * The database stores a start timestamp plus banked seconds, never a ticking
 * number, so one button press is one write and every phone computes the same
 * running time locally. These tests pin that arithmetic down, because a clock
 * that is wrong by a few seconds on one device is the kind of thing nobody
 * notices until a referee is arguing about stoppage time.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as D from "../../shared/domain/index.js";
import { makeTournament } from "../helpers/fixture.js";

const at = (match, secondsAfterStart) => D.clockState(match, match.clock.startedAt + secondsAfterStart * 1000);

describe("clock state", () => {
  it("reads zero before kick-off", () => {
    const data = makeTournament();
    const state = D.clockState(data.matches.m1);
    assert.equal(state.period, "pre");
    assert.equal(state.elapsed, 0);
    assert.equal(state.running, false);
    assert.equal(state.isPlaying, false);
  });

  it("counts up from the moment it was started", () => {
    const match = makeTournament().matches.m1;
    match.clock = { period: "h1", running: true, startedAt: 1_000_000, elapsed: 0, addedSeconds: 0 };

    assert.equal(at(match, 0).elapsed, 0);
    assert.equal(at(match, 90).elapsed, 90);
    assert.equal(at(match, 90).isPlaying, true);
  });

  it("adds the banked seconds from before the pause", () => {
    const match = makeTournament().matches.m1;
    match.clock = { period: "h1", running: true, startedAt: 1_000_000, elapsed: 120, addedSeconds: 0 };
    assert.equal(at(match, 30).elapsed, 150);
  });

  it("freezes while paused", () => {
    const match = makeTournament().matches.m1;
    match.clock = { period: "h1", running: false, startedAt: 1_000_000, elapsed: 200, addedSeconds: 0 };
    assert.equal(D.clockState(match, 9_999_999).elapsed, 200);
  });

  it("does not run backwards if a device clock is behind the server", () => {
    const match = makeTournament().matches.m1;
    match.clock = { period: "h1", running: true, startedAt: 1_000_000, elapsed: 60, addedSeconds: 0 };
    // A phone whose clock is a minute slow than when the referee pressed start.
    assert.equal(D.clockState(match, 940_000).elapsed, 60, "elapsed must never go below what was banked");
  });
});

describe("clock formatting", () => {
  it("shows mm:ss", () => {
    assert.deepEqual(D.formatClock(0, 480), { main: "00:00", extra: null });
    assert.deepEqual(D.formatClock(65, 480), { main: "01:05", extra: null });
    assert.deepEqual(D.formatClock(480, 480), { main: "08:00", extra: null });
  });

  it("stops at the period length and shows stoppage separately", () => {
    const out = D.formatClock(563, 480);
    assert.equal(out.main, "08:00", "the clock must not run past the half");
    assert.equal(out.extra, "+01:23");
  });

  it("keeps counting when there is no fixed length", () => {
    assert.deepEqual(D.formatClock(125, 0), { main: "02:05", extra: null });
  });
});

describe("period sequence", () => {
  it("moves pre → h1 → ht → h2 → ft", () => {
    assert.equal(D.nextPeriod("pre"), "h1");
    assert.equal(D.nextPeriod("h1"), "ht");
    assert.equal(D.nextPeriod("ht"), "h2");
    assert.equal(D.nextPeriod("h2"), "ft");
  });

  it("ends after extra time", () => {
    assert.equal(D.nextPeriod("et"), "ft");
  });

  it("stays at full-time", () => {
    assert.equal(D.nextPeriod("ft"), "ft");
  });

  it("reads period lengths from settings", () => {
    const data = makeTournament();
    data.settings.halfSeconds = 600;
    data.settings.breakSeconds = 90;
    data.settings.extraSeconds = 240;

    assert.equal(D.periodLength(data, "h1"), 600);
    assert.equal(D.periodLength(data, "h2"), 600);
    assert.equal(D.periodLength(data, "ht"), 90);
    assert.equal(D.periodLength(data, "et"), 240);
    assert.equal(D.periodLength(data, "pre"), 0);
  });
});

describe("clock stamp for the match log", () => {
  it("labels an event with the period and time", () => {
    const data = makeTournament();
    const match = data.matches.m1;
    match.clock = { period: "h1", running: true, startedAt: 1_000_000, elapsed: 0, addedSeconds: 0 };

    assert.equal(D.clockStamp(data, match, 1_252_000), "First half 04:12");
  });

  it("says so before kick-off", () => {
    const data = makeTournament();
    assert.equal(D.clockStamp(data, data.matches.m1), "Before kick-off");
  });
});

describe("countdown", () => {
  it("breaks the remaining time down", () => {
    const now = Date.parse("2026-08-01T10:00:00Z");
    const out = D.countdown("2026-08-02T12:30:45Z", now);
    assert.deepEqual(out, { days: 1, hours: 2, minutes: 30, seconds: 45 });
  });

  it("returns nothing once the time has passed", () => {
    const now = Date.parse("2026-08-02T00:00:00Z");
    assert.equal(D.countdown("2026-08-01T00:00:00Z", now), null);
  });

  it("returns nothing for an unparseable date", () => {
    assert.equal(D.countdown("not a date"), null);
  });
});
