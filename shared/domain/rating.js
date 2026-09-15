/**
 * Ratings.
 *
 * Two numbers, deliberately kept apart:
 *
 *  - The ADMIN rating (1–99) is somebody's judgement, entered by the super
 *    admin. It is the headline on a player's card, because at this scale a
 *    judgement is worth more than arithmetic: most people have played a
 *    handful of matches.
 *
 *  - The STATS rating is arithmetic, shown underneath as "from stats". It is
 *    the player's points per match — the same points the tournament awards,
 *    which already value a keeper's saves and a defender's clean sheets — and
 *    it is pulled towards an average rating of 60 until there are enough
 *    matches to believe it. One lucky afternoon does not make anyone a 95.
 */

export const RATING_MIN_MATCHES = 2;

const BASELINE = 60;
/** Rating points per point-per-match. 4 points a match is a very good day. */
const SCALE = 8;
/** Matches' worth of doubt: at 6 matches the record counts for half. */
const PRIOR_MATCHES = 6;
const FLOOR = 40;
const CEILING = 95;

/**
 * @param {{ matches: number, points: number }} totals  a career's totals
 * @returns {number|null} 40–95, or null with too few matches to say anything
 */
export function statsRating(totals) {
  const matches = Number(totals?.matches ?? 0);
  if (matches < RATING_MIN_MATCHES) return null;

  const perMatch = Number(totals.points ?? 0) / matches;
  const raw = 55 + perMatch * SCALE;
  const confidence = matches / (matches + PRIOR_MATCHES);
  const shrunk = BASELINE + (raw - BASELINE) * confidence;

  return Math.round(Math.min(CEILING, Math.max(FLOOR, shrunk)));
}

/** The number to put on a card: the admin's if there is one, otherwise the stats one. */
export function headlineRating(person, totals) {
  if (Number.isInteger(person?.rating)) return { value: person.rating, source: "admin" };
  const fromStats = statsRating(totals);
  return fromStats === null ? { value: null, source: null } : { value: fromStats, source: "stats" };
}

/** A word for a rating, for the badge colour and for screen readers. */
export function ratingBand(value) {
  if (value === null || value === undefined) return "none";
  if (value >= 85) return "elite";
  if (value >= 75) return "strong";
  if (value >= 65) return "good";
  return "developing";
}
