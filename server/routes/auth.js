/**
 * Sign up, sign in, sign out, and "who am I".
 *
 * Registration is open but grants nothing. A new account lands at `pending`,
 * which can sign in and see a "waiting for approval" screen and absolutely
 * nothing else. That is what makes open registration safe here: a super admin
 * still has to put the person on a tournament before they can change a single
 * score. It removes the old flow where a new referee had to read their own user
 * id off a screen and send it to the organiser to be pasted into a source file.
 */

import express from "express";

import { audit } from "../audit.js";
import { db, newId } from "../db/index.js";
import { env } from "../env.js";
import { badRequest, conflict, forbidden, route, unauthorized } from "../http/errors.js";
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) throw badRequest("Enter your email address.");
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest("That does not look like an email address.");
  return email;
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isSuper: row.is_super === 1,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------

authRoutes.post(
  "/register",
  rateLimit({ name: "register", max: 5, windowMs: 60 * 60 * 1000 }),
  route(async (req, res) => {
    if (!env.allowRegistration) {
      throw forbidden("Registration is closed. Ask an organiser to create your account.");
    }

    const email = cleanEmail(req.body?.email);
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const password = String(req.body?.password ?? "");

    const problem = validatePassword(password);
    if (problem) throw badRequest(problem);
    if (!name) throw badRequest("Enter your name so organisers know who you are.");

    const taken = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
    if (taken) throw conflict("There is already an account with that email. Try signing in instead.");

    const id = newId("us");
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, is_super, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'pending', ?)`,
    ).run(id, email, await hashPassword(password), name, Date.now());

    // Sign them in immediately. They see the waiting-for-approval screen, which
    // is more useful than a login form and confirms the account exists.
    const { token, expiresAt } = createSession(id, { userAgent: req.headers["user-agent"] });
    attachSessionCookie(res, token, expiresAt);

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    req.user = publicUser(row);
    audit(req, "user.register", { email });

    res.status(201).json({
      user: publicUser(row),
      message: "Account created. An organiser needs to approve you before you can make changes.",
    });
  }),
);

authRoutes.post(
  "/login",
  rateLimit({ name: "login-ip", max: 20, windowMs: 15 * 60 * 1000 }),
  rateLimit({
    name: "login-email",
    max: 8,
    windowMs: 15 * 60 * 1000,
    key: (req) => String(req.body?.email ?? "").trim().toLowerCase(),
  }),
  route(async (req, res) => {
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password ?? "");

    const row = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);

    // Same message and roughly the same work whether or not the account exists,
    // so the form cannot be used to find out who has an account here.
    const ok = row ? await verifyPassword(password, row.password_hash) : await burnTime(password);
    if (!row || !ok) {
      throw unauthorized("That email and password do not match.");
    }

    if (row.status === "disabled") {
      throw forbidden("That account has been switched off. Ask an organiser to turn it back on.");
    }

    // Quietly upgrade the stored hash if the cost parameters have been raised
    // since it was written. This is the only moment the plaintext is available.
    if (needsRehash(row.password_hash)) {
      try {
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
          await hashPassword(password),
          row.id,
        );
      } catch {
        /* an upgrade failing must never block a valid sign-in */
      }
    }

    const { token, expiresAt } = createSession(row.id, { userAgent: req.headers["user-agent"] });
    attachSessionCookie(res, token, expiresAt);

    clearLimit("login-email", email);
    req.user = publicUser(row);
    audit(req, "user.login", { email });

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
 * Who am I, and what may I do.
 *
 * The browser uses this to decide what to render. It is a convenience, not a
 * control: every one of those permissions is checked again on the server when
 * the request is actually made.
 */
authRoutes.get(
  "/me",
  route(async (req, res) => {
    if (!req.user) return res.json({ user: null, tournaments: [] });

    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!row) return res.json({ user: null, tournaments: [] });

    const tournaments = row.is_super
      ? db
          .prepare("SELECT id, slug, name, season, format, status FROM tournaments ORDER BY created_at DESC")
          .all()
          .map((t) => ({ ...t, role: "super" }))
      : db
          .prepare(
            `SELECT t.id, t.slug, t.name, t.season, t.format, t.status, s.role
               FROM tournament_staff s
               JOIN tournaments t ON t.id = s.tournament_id
              WHERE s.user_id = ?
              ORDER BY t.created_at DESC`,
          )
          .all(row.id);

    res.json({ user: publicUser(row), tournaments });
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
 * timing does not reveal which addresses are registered.
 */
async function burnTime(password) {
  const decoy = "scrypt$16384$8$1$00000000000000000000000000000000$" + "0".repeat(128);
  await verifyPassword(password || "x", decoy);
  return false;
}
