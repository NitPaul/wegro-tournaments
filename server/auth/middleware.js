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

/** Signed in at all. A pending account passes this — it is "who are you", not "may you". */
export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * Signed in and approved.
 *
 * A self-registered account sits at `pending` and can see nothing but the
 * public site and its own "waiting for approval" screen. That is what makes
 * open registration safe: creating an account grants no access whatsoever until
 * a super admin assigns it somewhere.
 */
export function requireActive(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.status !== "active") {
    return next(
      forbidden(
        "Your account is waiting for approval. An organiser needs to assign you to a tournament before you can make changes.",
      ),
    );
  }
  next();
}

export function requireSuper(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.isSuper) {
    return next(forbidden("Only the super admin can do that."));
  }
  next();
}

/**
 * Load the tournament named by `:tid` (its id or its slug) onto `req.tournament`,
 * and work out what this user may do with it.
 *
 * `minRole` is 'referee', 'admin' or 'super'. A super admin always passes.
 * Pass no `minRole` to load the tournament for a public read.
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

    // Work out this user's rank for this specific tournament. Roles are scoped
    // per tournament, so the same person can run one and referee another.
    let role = null;
    if (req.user?.isSuper) {
      role = "super";
    } else if (req.user && req.user.status === "active") {
      const staff = db
        .prepare("SELECT role FROM tournament_staff WHERE tournament_id = ? AND user_id = ?")
        .get(tournament.id, req.user.id);
      role = staff?.role ?? null;
    }
    req.tournamentRole = role;

    if (!minRole) return next(); // public read

    if (!req.user) return next(unauthorized());
    if (req.user.status !== "active" && !req.user.isSuper) {
      return next(
        forbidden(
          "Your account is waiting for approval. An organiser needs to assign you to a tournament before you can make changes.",
        ),
      );
    }
    if (!role) {
      return next(forbidden("You are not on the staff for this tournament."));
    }
    if (RANK[role] < RANK[minRole]) {
      return next(
        forbidden(
          minRole === "admin"
            ? "Referees can run match day, but only a tournament admin can change squads, the auction or settings."
            : "You do not have permission to do that.",
        ),
      );
    }
    next();
  };
}

/** What a given user may do with a tournament — used to shape the UI honestly. */
export function permissionsFor(user, tournamentId) {
  if (!user) return { role: null, canRead: true, canScore: false, canManage: false, canAdminister: false };

  if (user.isSuper) {
    return { role: "super", canRead: true, canScore: true, canManage: true, canAdminister: true };
  }
  if (user.status !== "active") {
    return { role: null, canRead: true, canScore: false, canManage: false, canAdminister: false };
  }

  const staff = db
    .prepare("SELECT role FROM tournament_staff WHERE tournament_id = ? AND user_id = ?")
    .get(tournamentId, user.id);

  const role = staff?.role ?? null;
  return {
    role,
    canRead: true,
    canScore: role === "admin" || role === "referee",
    canManage: role === "admin",
    canAdminister: false,
  };
}
