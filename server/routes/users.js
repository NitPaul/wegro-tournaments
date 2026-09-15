/**
 * Accounts — super admin only.
 *
 * The super admin creates every account, with a User ID and a password, and
 * hands them over. There is no sign-up form and no approval queue.
 *
 * An admin or referee account belongs to exactly ONE tournament, chosen when it
 * is created. That is a safety rule, not a convenience: a tournament admin can
 * rename their tournament and run its auction, but cannot see or touch any
 * other. Running a second tournament means a second account. The database backs
 * this up with a unique index on tournament_staff(user_id).
 */

import express from "express";

import { audit } from "../audit.js";
import { db, newId, transaction } from "../db/index.js";
import { badRequest, conflict, forbidden, notFoundError, route } from "../http/errors.js";
import { hashPassword, validatePassword } from "../auth/password.js";
import { destroyAllSessions } from "../auth/session.js";
import { requireSuper } from "../auth/middleware.js";
import { cleanUsername } from "../auth/username.js";
import { assignmentOf } from "../db/repo/tournaments.js";

export const userRoutes = express.Router();

userRoutes.use(requireSuper);

const shape = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email ?? null,
  name: row.name,
  isSuper: row.is_super === 1,
  status: row.status,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  // At most one, by design. Null for a super admin, who needs no assignment.
  tournament: assignmentOf(row.id),
});

const findUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

function cleanEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw badRequest("That does not look like an email address. Leave it empty if there isn't one.");
  }
  return email;
}

userRoutes.get(
  "/",
  route(async (req, res) => {
    const rows = db.prepare("SELECT * FROM users ORDER BY is_super DESC, status, name COLLATE NOCASE").all();
    res.json({ users: rows.map(shape) });
  }),
);

/**
 * Create an account.
 *
 * `role` is 'admin' or 'referee' — which then REQUIRES `tournamentId` — or
 * 'super'. The account and its assignment are written in one transaction, so
 * there is never an account in limbo that exists but belongs nowhere.
 */
userRoutes.post(
  "/",
  route(async (req, res) => {
    const username = cleanUsername(req.body?.username);
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const password = String(req.body?.password ?? "");
    const email = cleanEmail(req.body?.email);
    const role = String(req.body?.role ?? "");

    if (!name) throw badRequest("Enter the person's name.");
    const problem = validatePassword(password);
    if (problem) throw badRequest(problem);
    if (!["admin", "referee", "super"].includes(role)) {
      throw badRequest("Choose a role: tournament admin, referee, or super admin.");
    }

    let tournament = null;
    if (role !== "super") {
      const tid = String(req.body?.tournamentId ?? "");
      if (!tid) throw badRequest("Choose the tournament this account is for. Every admin and referee belongs to one.");
      tournament = db.prepare("SELECT id, code, name FROM tournaments WHERE id = ?").get(tid);
      if (!tournament) throw notFoundError("That tournament does not exist.");
    }

    if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      throw conflict(`The User ID "${username}" is taken. Pick another.`);
    }
    if (email && db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
      throw conflict("Another account already uses that email.");
    }

    const id = newId("us");
    const hash = await hashPassword(password);

    transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, name, is_super, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(id, username, email, hash, name, role === "super" ? 1 : 0, Date.now());

      if (tournament) {
        db.prepare(
          `INSERT INTO tournament_staff (tournament_id, user_id, role, assigned_by, assigned_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(tournament.id, id, role, req.user.id, Date.now());
      }
    });

    audit(req, "user.create", { username, name, role, code: tournament?.code ?? null }, tournament?.id ?? null);
    res.status(201).json({ user: shape(findUser(id)) });
  }),
);

/** Set a new password for someone who has forgotten theirs. Signs them out everywhere. */
userRoutes.post(
  "/:id/password",
  route(async (req, res) => {
    const target = findUser(req.params.id);
    if (!target) throw notFoundError("No such account.");

    const password = String(req.body?.password ?? "");
    const problem = validatePassword(password);
    if (problem) throw badRequest(problem);

    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(password), target.id);
    destroyAllSessions(target.id);

    audit(req, "user.password_reset", { username: target.username });
    res.json({ user: shape(findUser(target.id)) });
  }),
);

userRoutes.post(
  "/:id/status",
  route(async (req, res) => {
    const status = String(req.body?.status ?? "");
    if (!["active", "disabled"].includes(status)) throw badRequest("Status must be active or disabled.");

    const target = findUser(req.params.id);
    if (!target) throw notFoundError("No such account.");

    // Guard against the system locking itself out of its own administration.
    if (target.is_super === 1 && status !== "active" && lastActiveSuper(target.id)) {
      throw forbidden("This is the only active super admin. Make somebody else super admin first.");
    }

    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, target.id);
    // Takes effect on their very next request, not whenever their session expires.
    if (status === "disabled") destroyAllSessions(target.id);

    audit(req, "user.status", { username: target.username, from: target.status, to: status });
    res.json({ user: shape(findUser(target.id)) });
  }),
);

userRoutes.post(
  "/:id/super",
  route(async (req, res) => {
    const makeSuper = Boolean(req.body?.isSuper);
    const target = findUser(req.params.id);
    if (!target) throw notFoundError("No such account.");

    if (!makeSuper && target.is_super === 1 && lastActiveSuper(target.id)) {
      throw forbidden("This is the only super admin. Make somebody else super admin before standing down.");
    }
    if (!makeSuper && !assignmentOf(target.id)) {
      throw badRequest(
        "An account that is not a super admin must belong to a tournament. Create a tournament account for them instead.",
      );
    }

    db.prepare("UPDATE users SET is_super = ?, status = CASE WHEN ? = 1 THEN 'active' ELSE status END WHERE id = ?").run(
      makeSuper ? 1 : 0,
      makeSuper ? 1 : 0,
      target.id,
    );

    audit(req, "user.super", { username: target.username, isSuper: makeSuper });
    res.json({ user: shape(findUser(target.id)) });
  }),
);

userRoutes.delete(
  "/:id",
  route(async (req, res) => {
    const target = findUser(req.params.id);
    if (!target) throw notFoundError("No such account.");
    if (target.id === req.user.id) throw forbidden("You cannot delete your own account.");
    if (target.is_super === 1 && lastActiveSuper(target.id)) {
      throw forbidden("This is the only super admin. Make somebody else super admin first.");
    }

    // Their staff row and sessions go with them (ON DELETE CASCADE). The audit
    // log keeps their User ID as text, so the history still reads correctly.
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);

    audit(req, "user.delete", { username: target.username });
    res.json({ ok: true });
  }),
);

/** Is this the last active super admin standing? */
function lastActiveSuper(userId) {
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE is_super = 1 AND status = 'active' AND id != ?")
    .get(userId);
  return n === 0;
}
