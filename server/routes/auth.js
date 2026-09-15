/**
 * Sign in, sign out, change password, and "who am I".
 *
 * There is no self-registration. The super admin creates each account with a
 * User ID and a password and hands it over (server/routes/users.js). That
 * replaced a sign-up form feeding an approval queue, which people found
 * confusing and which gave a stranger a way to put an account on the system.
 *
 * People sign in with their User ID. An account that has an email address can
 * also sign in with that — which is how every account that existed before User
 * IDs keeps working without anybody being told anything.
 */

import express from "express";

import { audit } from "../audit.js";
import { db } from "../db/index.js";
import { badRequest, forbidden, route, unauthorized } from "../http/errors.js";
import { clearLimit, rateLimit } from "../http/ratelimit.js";
import { hashPassword, needsRehash, validatePassword, verifyPassword } from "../auth/password.js";
import {
  attachSessionCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  removeSessionCookie,
  SESSION_COOKIE,
} from "../auth/session.js";
import { requireAuth } from "../auth/middleware.js";

export const authRoutes = express.Router();

/** The User ID or email typed into the sign-in box, tidied. */
const loginOf = (body) => String(body?.login ?? body?.username ?? body?.email ?? "").trim().toLowerCase();

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    name: row.name,
    isSuper: row.is_super === 1,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------

authRoutes.post(
  "/login",
  rateLimit({ name: "login-ip", max: 20, windowMs: 15 * 60 * 1000 }),
  rateLimit({ name: "login-account", max: 8, windowMs: 15 * 60 * 1000, key: (req) => loginOf(req.body) }),
  route(async (req, res) => {
    const login = loginOf(req.body);
    const password = String(req.body?.password ?? "");
    if (!login) throw badRequest("Enter your User ID.");

    const row = db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE")
      .get(login, login);

    // Same message and roughly the same work whether or not the account exists,
    // so the form cannot be used to find out which User IDs are real.
    const ok = row ? await verifyPassword(password, row.password_hash) : await burnTime(password);
    if (!row || !ok) {
      throw unauthorized("That User ID and password do not match.");
    }

    if (row.status === "disabled") {
      throw forbidden("That account has been switched off. Ask the super admin to turn it back on.");
    }

    // Quietly upgrade the stored hash if the cost parameters have been raised
    // since it was written. This is the only moment the plaintext is available.
    if (needsRehash(row.password_hash)) {
      try {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), row.id);
      } catch {
        /* an upgrade failing must never block a valid sign-in */
      }
    }

    const { token, expiresAt } = createSession(row.id, { userAgent: req.headers["user-agent"] });
    attachSessionCookie(res, token, expiresAt);

    clearLimit("login-account", login);
    req.user = publicUser(row);
    audit(req, "user.login", {});

    res.json({ user: publicUser(row) });
  }),
);

authRoutes.post(
  "/logout",
  route(async (req, res) => {
    if (req.user) audit(req, "user.logout", {});
    destroySession(req.cookies?.[SESSION_COOKIE]);
    removeSessionCookie(res);
    res.json({ ok: true });
  }),
);

/**
 * Who am I, and which tournament is mine.
 *
 * A super admin gets every tournament. Anybody else gets exactly one — the one
 * their account was created for — so the console of a tournament admin never
 * learns that other tournaments exist. The browser decides what to draw from
 * this; every permission is still checked again on each request.
 */
authRoutes.get(
  "/me",
  route(async (req, res) => {
    if (!req.user) return res.json({ user: null, tournaments: [] });

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!row) return res.json({ user: null, tournaments: [] });

    const columns = "t.id, t.code, t.slug, t.name, t.season, t.format, t.status";
    const tournaments = row.is_super
      ? db
          .prepare(`SELECT ${columns}, 'super' AS role FROM tournaments t ORDER BY t.created_at DESC`)
          .all()
      : db
          .prepare(
            `SELECT ${columns}, s.role
               FROM tournament_staff s
               JOIN tournaments t ON t.id = s.tournament_id
              WHERE s.user_id = ?`,
          )
          .all(row.id);

    res.json({ user: publicUser(row), tournaments: tournaments.map((t) => ({ ...t })) });
  }),
);

authRoutes.post(
  "/password",
  requireAuth,
  rateLimit({ name: "password", max: 5, windowMs: 15 * 60 * 1000 }),
  route(async (req, res) => {
    const current = String(req.body?.currentPassword ?? "");
    const next = String(req.body?.newPassword ?? "");

    const problem = validatePassword(next);
    if (problem) throw badRequest(problem);

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      throw unauthorized("Your current password is not right.");
    }

    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(next), row.id);

    // Every other session ends — that is the point of changing a password.
    destroyAllSessions(row.id);
    const { token, expiresAt } = createSession(row.id, { userAgent: req.headers["user-agent"] });
    attachSessionCookie(res, token, expiresAt);

    audit(req, "user.password_change", {});
    res.json({ ok: true, message: "Password changed. You have been signed out everywhere else." });
  }),
);

/**
 * Spend roughly the same time on a missing account as on a real one, so response
 * timing does not reveal which User IDs exist.
 */
async function burnTime(password) {
  const decoy = "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);
  await verifyPassword(password || "x", decoy);
  return false;
}
