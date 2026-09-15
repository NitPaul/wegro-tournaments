/**
 * Where a tournament is in its life, as the public sees it.
 *
 * Derived, not stored. The database keeps the three statuses an organiser
 * actually sets — hidden (draft), published (active), finished (completed) —
 * and everything a visitor needs to know follows from those plus the fixtures:
 *
 *   hidden     draft                                     not shown publicly
 *   upcoming   published, nothing played, not started   "Coming soon"
 *   live       published, a match is being played now    "Live now"
 *   ongoing    published, under way between matches      "In progress"
 *   finished   completed                                 "Finished"
 *
 * Keeping it derived means a tournament published with no date and no venue
 * shows up as coming soon, turns live the moment the referee starts the first
 * clock, and nobody has to remember to flip a switch in between.
 */

export const PHASES = ["live", "ongoing", "upcoming", "finished"];

export const PHASE_LABEL = {
  hidden: "Hidden",
  upcoming: "Coming soon",
  live: "Live now",
  ongoing: "In progress",
  finished: "Finished",
};

/** Today as YYYY-MM-DD in the viewer's local time — dates are entered as local days. */
export function todayISO(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {{status:string, startsOn?:string|null, liveMatches?:number, playedMatches?:number}} t
 *        a tournament summary (the public list carries these counts)
 * @param {number} [now]
 */
export function tournamentPhase(t, now = Date.now()) {
  if (!t || t.status === "draft") return "hidden";
  if (t.status === "completed") return "finished";
  if ((t.liveMatches ?? 0) > 0) return "live";
  if ((t.playedMatches ?? 0) > 0) return "ongoing";
  if (t.startsOn && t.startsOn <= todayISO(now)) return "ongoing";
  return "upcoming";
}

/** Order for the landing page: what is happening now, then what is coming, then history. */
export function sortByPhase(list, now = Date.now()) {
  const rank = { live: 0, ongoing: 1, upcoming: 2, finished: 3, hidden: 4 };
  return [...list].sort((a, b) => {
    const pa = tournamentPhase(a, now);
    const pb = tournamentPhase(b, now);
    if (pa !== pb) return rank[pa] - rank[pb];
    // Upcoming: soonest first, undated last. Everything else: most recent first.
    const da = a.startsOn ?? "";
    const db = b.startsOn ?? "";
    if (pa === "upcoming") return (da || "9999").localeCompare(db || "9999");
    return db.localeCompare(da) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}

/** "Saturday, 1 August 2027", or null when there is no date yet. */
export function formatDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
