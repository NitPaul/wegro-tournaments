/**
 * The match clock.
 *
 * The database never stores a ticking number. It stores when the clock was last
 * started plus the seconds banked before that, so one press of a button is one
 * write, and every phone on the touchline computes the same running time
 * locally between writes.
 *
 * `nowMs` should come from the server-corrected clock, not `Date.now()`, so a
 * viewer whose phone is four minutes fast still sees the right time.
 */

import { PERIOD_LABEL, PERIOD_ORDER, PLAYING_PERIODS } from "./constants.js";
import { getSettings } from "./helpers.js";

export function periodLength(data, period) {
  const s = getSettings(data);
  if (period === "h1" || period === "h2") return Number(s.halfSeconds);
  if (period === "ht") return Number(s.breakSeconds);
  if (period === "et") return Number(s.extraSeconds);
  return 0;
}

export function clockState(match, nowMs = Date.now()) {
  const c = match?.clock || {};
  const period = c.period || "pre";
  const banked = Number(c.elapsed || 0);
  const running = Boolean(c.running) && Number(c.startedAt) > 0;
  const elapsed = running ? banked + Math.max(0, (nowMs - Number(c.startedAt)) / 1000) : banked;

  return {
    period,
    running,
    elapsed,
    added: Number(c.addedSeconds || 0),
    label: PERIOD_LABEL[period] || period,
    isPlaying: PLAYING_PERIODS.includes(period),
  };
}

const mmss = (secs) => {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Football-style clock: counts up, stops at the period length, then shows
 * stoppage separately (`08:00 +1:23`) rather than running past it.
 */
export function formatClock(elapsed, length) {
  if (!length) return { main: mmss(elapsed), extra: null };
  if (elapsed <= length) return { main: mmss(elapsed), extra: null };
  return { main: mmss(length), extra: `+${mmss(elapsed - length)}` };
}

/** The next period in the sequence, honouring an extra-time detour. */
export function nextPeriod(current) {
  if (current === "et") return "ft";
  const i = PERIOD_ORDER.indexOf(current);
  if (i < 0 || i >= PERIOD_ORDER.length - 1) return "ft";
  return PERIOD_ORDER[i + 1];
}

/** A fresh, stopped clock for a given period. */
export const freshClock = (period = "pre") => ({
  period,
  running: false,
  startedAt: null,
  elapsed: 0,
  addedSeconds: 0,
});

/** A short stamp for the match log, e.g. "First half 04:12". */
export function clockStamp(data, match, nowMs = Date.now()) {
  const state = clockState(match, nowMs);
  if (state.period === "pre") return "Before kick-off";
  const { main, extra } = formatClock(state.elapsed, periodLength(data, state.period));
  return `${state.label} ${main}${extra ? ` ${extra}` : ""}`;
}
