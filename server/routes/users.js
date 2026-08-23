/**
 * People management — super admin only.
 *
 * This is the screen that replaces the old workflow of editing a JavaScript
 * array, regenerating a rules file, pasting it into a console and redeploying,
 * every time somebody needed access.
 */

import express from "express";

import { audit } from "../audit.js";
import { db, newId } from "../db/index.js";
import { badRequest, conflict, forbidden, notFoundError, route } from "../http/errors.js";
import { hashPassword, validatePassword } from "../auth/password.js";
import { destroyAllSessions } from "../auth/session.js";
import { requireSuper } from "../auth/middleware.js";

export const userRoutes = express.Router();

userRoutes.use(requireSuper);

const shape = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  isSuper: row.is_super === 1,
  status: row.status,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  assignments: db
    .prepare(
      `SELECT s.role, t.id AS tournamentId, t.name, t.slug, t.status AS tournamentStatus
         FROM tournament_staff s
         JOIN tournaments t ON t.id = s.tournament_id
        WHERE s.user_id = ?
        ORDER BY t.created_at DESC`,
    )
    .all(row.id),
});

userRoutes.get(
  "/",
  route(async (req, res) => {
    const status = req.query.status;
    const rows = status
      ? db.prepare("SELECT * FROM users WHERE status = ? ORDER BY created_at DESC").all(String(status))
      : db.prepare("SELECT * FROM users ORDER BY status = 'pending' DESC, created_at DESC").all();

    res.json({
      users: rows.map(shape),
      pendingCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get().n,
    });
  }),
);

/** Create an account directly, for someone who will not register themselves. */
userRoutes.post(
  "/",
  route(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const name = String(req.body?.name ?? "").trim().slice(0, 80);
    const password = String(req.body?.password ?? "");

    if (!email) throw badRequest("Enter an email address.");
    if (!name) throw badRequest("Enter a name.");
    const problem = validatePassword(password);
    if (problem) throw badRequest(problem);

    if (db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
      throw conflict("There is already an account with that email.");
    }

    const id = newId("us");
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, is_super, status, created_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?)`,
    ).run(id, email, await hashPassword(password), name, Date.now());

    audit(req, "user.create", { email, name });
    res.status(201).json({ user: shape(db.prepare("SELECT * FROM users WHERE id = ?").get(id)) });
  }),
);

userRoutes.post(
  "/:id/status",
  route(async (req, res) => {
    const status = String(req.body?.status ?? "");
    if (!["pending", "active", "disabled"].includes(status)) {
      throw badRequest("Status must be pending, active or disabled.");
    }

    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!target) throw notFoundError("No such person.");

    // Guard against the system locking itself out of its own administration.
    if (target.is_super === 1 && status !== "active" && lastActiveSuper(target.id)) {
      throw forbidden("This is the only active super admin. Promote somebody else first.");
    }

    db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, target.id);
    if (status === "disabled") destroyAllSessions(target.id);

    audit(req, "user.status", { email: target.email, from: target.status, to: status });
    res.json({ user: shape(db.prepare("SELECT * FROM users WHERE id = ?").get(target.id)) });
  }),
);

userRoutes.post(
  "/:id/super",
  route(async (req, res) => {
    const makeSuper = Boolean(req.body?.isSuper);
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!target) throw notFoundError("No such person.");

    if (!makeSuper && target.is_super === 1 && lastActiveSuper(target.id)) {
      throw forbidden("This is the only super admin. Promote somebody else before standing down.");
    }

    db.prepare("UPDATE users SET is_super = ?, status = CASE WHEN ? = 1 THEN 'active' ELSE status END WHERE id = ?")
      .run(makeSuper ? 1 : 0, makeSuper ? 1 : 0, target.id);

    audit(req, "user.super", { email: target.email, isSuper: makeSuper });
    res.json({ user: shape(db.prepare("SELECT * FROM users WHERE id = ?").get(target.id)) });
  }),
);

userRoutes.delete(
  "/:id",
  route(async (req, res) => {
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!target) throw notFoundError("No such person.");
    if (target.id === req.user.id) throw forbidden("You cannot delete your own account.");
    if (target.is_super === 1 && lastActiveSuper(target.id)) {
      throw forbidden("This is the only super admin. Promote somebody else first.");
    }

    // Their staff rows and sessions go with them (ON DELETE CASCADE), but the
    // audit log keeps their email as recorded text, so history stays readable.
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);

    audit(req, "user.delete", { email: target.email });
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
