/**
 * Seasons and not-yet-decided dates.
 *
 * A season is whatever the organisers call the tournament's edition. That used
 * to be a year ("2026"). Tournaments now happen more than once a year, so a
 * season can be a month and a year ("September 2026"). It is stored as that
 * readable text, so every page can show it as it is; these helpers turn it into
 * form fields and back, and into something that sorts in date order.
 */

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** What the site says about anything not decided yet: a date, a venue, a time. */
export const ANNOUNCED_SOON = "Will be announced soon";

/** "September 2026" from a month number (1–12, or "" for none) and a year. */
export function seasonLabel(month, year) {
  const y = String(year ?? "").trim();
  const m = Number(month);
  if (!/^\d{4}$/.test(y)) return "";
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : y;
}

/**
 * The month (1–12, or null) and year in a season, when it has them.
 * Understands "September 2026", "Sep 2026", "2026-09" and "2026". Anything else
 * — an old free-text season — gives nulls, and is shown and kept as written.
 */
export function parseSeason(season) {
  const text = String(season ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})$/);
  if (iso) {
    const m = Number(iso[2]);
    return { month: m >= 1 && m <= 12 ? m : null, year: Number(iso[1]) };
  }
  const named = text.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (named) {
    const word = named[1].toLowerCase();
    const index = MONTHS.findIndex((name) => word.length >= 3 && name.toLowerCase().startsWith(word));
    return { month: index >= 0 ? index + 1 : null, year: index >= 0 ? Number(named[2]) : null };
  }
  if (/^\d{4}$/.test(text)) return { month: null, year: Number(text) };
  return { month: null, year: null };
}

/** The four-digit year a season belongs to, or null. */
export function seasonYear(season) {
  return parseSeason(season).year;
}

/**
 * A key that sorts tournaments oldest to newest: the start date when there is
 * one, otherwise the season as YYYY-MM (or YYYY). "September 2026" must come
 * after "March 2026", which comparing the words would get wrong.
 */
export function seasonSortKey({ startsOn, season } = {}) {
  if (startsOn) return String(startsOn);
  const { month, year } = parseSeason(season);
  if (!year) return "";
  return month ? `${year}-${String(month).padStart(2, "0")}` : String(year);
}

/** How a season reads after the tournament's name: "Season 2026", or just "September 2026". */
export function seasonHeading(season) {
  const { month, year } = parseSeason(season);
  if (!season) return "";
  return year && !month ? `Season ${season}` : String(season);
}
