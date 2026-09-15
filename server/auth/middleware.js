/**
 * Authentication and authorisation middleware.
 *
 * This file is the reason the platform was rebuilt.
 *
 * The previous version kept its roles in a JavaScript array that was shipped to
 * every browser, and hid the dangerous screen by setting `hidden` on a tab
 * button. That is a curtain, not a lock: anyone who opened devtools had exactly
 * the same power as the organiser, because the database rules behind it could
 * only see a user id and had no idea what a "referee" was.
 *
 * Here, permission is checked on the server, on every mutating request, against
 * a row in `tournament_staff`. Hiding a tab is now only a courtesy to keep the
 * screen tidy. The lock is `requireTournament`.
 */

import { db } from "../db/index.js";
import { forbidden, unauthorized, notFoundError } from "../http/errors.js";
import { readSession, SESSION_COOKIE } from "./session.js";

/** Ranked so a check can say "admin or better" in one comparison. */
const RANK = { referee: 1, admin: 2, super: 3 };

/**
 * Populate `req.user` from the session cookie. Never rejects — routes that need
 * a user say so themselves. Runs on every request, including the public site,
 * so the header can show who is signed in.
 */
export function attachUser(req, res, next) {
  req.user = readSession(req.cookies?.[SESSION_COOKIE]) ?? null;

  if (req.user) {
    // Cheap presence tracking, useful when working out who was on the console
    // during a match. Rounded to the minute so it is one write per user per
    // minute rather than one per request.
    const minute = Math.floor(Date.now() / 60000) * 60000;
    try {
      db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)")
        .run(minute, req.user.id, minute);
    } catch {
      /* presence is not worth failing a request over */
    }
  }
  next();
}

/** Signed in at all. */
export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuper(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.isSuper) {
    return next(forbidden("Only the super admin can do that."));
  }
  next();
}

/** Methods that change something. Everything else is a read. */
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Load the tournament named by `:tid` (its id or its slug) onto `req.tournament`,
 * and work out what this user may do with it.
 *
 * `minRole` is 'referee', 'admin' or 'super'. A super admin always passes.
 * Pass no `minRole` to load the tournament for a public read.
 *
 * Two rules live here and nowhere else:
 *
 *  - An admin or referee has a role on exactly one tournament. On any other,
 *    `role` is null and every protected route answers 403 — the account cannot
 *    read another tournament's staff or activity, and cannot change anything.
 *  - A FINISHED tournament is read-only to everybody but the super admin. The
 *    results are in the Hall of Fame by then; if one needs correcting, the super
 *    admin reopens the tournament, which is written to the audit log.
 */
export function requireTournament(minRole = null) {
  return function tournamentGuard(req, res, next) {
    const key = req.params.tid ?? req.params.tournamentId;
    if (!key) return next(notFoundError("No tournament given."));

    const tournament = db
      .prepare("SELECT * FROM tournaments WHERE id = ? OR slug = ? COLLATE NOCASE")
      .get(key, key);

    if (!tournament) return next(notFoundError("No such tournament."));
    req.tournament = tournament;
    req.tournamentRole = roleOn(req.user, tournament.id);

    if (!minRole) return next(); // public read

    const role = req.tournamentRole;
    if (!req.user) return next(unauthorized());
    if (!role) {
      return next(forbidden("Your account is not for this tournament."));
    }
    if (RANK[role] < RANK[minRole]) {
      return next(
        forbidden(
          minRole === "admin"
            ? "Referees can run match day, but only the tournament admin can change squads, the auction or settings."
            : "Only the super admin can do that.",
        ),
      );
    }
    if (tournament.status === "completed" && role !== "super" && WRITES.has(req.method)) {
      return next(forbidden("This tournament is finished, so it can no longer be changed. Ask the super admin to reopen it."));
    }
    next();
  };
}

/** This user's role on one tournament: 'super', 'admin', 'referee', or null. */
function roleOn(user, tournamentId) {
  if (!user) return null;
  if (user.isSuper) return "super";
  if (user.status !== "active") return null;
  return (
    db
      .prepare("SELECT role FROM tournament_staff WHERE tournament_id = ? AND user_id = ?")
      .get(tournamentId, user.id)?.role ?? null
  );
}

/** What a given user may do with a tournament — used to shape the UI honestly. */
export function permissionsFor(user, tournamentId) {
  const role = roleOn(user, tournamentId);
  const finished =
    db.prepare("SELECT status FROM tournaments WHERE id = ?").get(tournamentId)?.status === "completed";
  const locked = finished && role !== "super";

  return {
    role,
    canRead: true,
    canScore: !locked && (role === "super" || role === "admin" || role === "referee"),
    canManage: !locked && (role === "super" || role === "admin"),
    canAdminister: role === "super",
    readOnly: locked && Boolean(role),
  };
}
