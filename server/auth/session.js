/**
 * Sessions.
 *
 * Server-side sessions in SQLite rather than JWTs, for one reason that matters
 * operationally: revocation is instant. When somebody leaves the company or a
 * referee's phone is lost, deleting a row ends their access immediately. A JWT
 * stays valid until it expires no matter what you do, and the usual workaround
 * is a server-side blocklist — which is a session table with extra steps.
 *
 * The cookie holds a random token. The database stores only its SHA-256, so a
 * leaked database backup does not hand over live sessions.
 */

import { createHash, randomBytes } from "node:crypto";

import { db } from "../db/index.js";
import { env } from "../env.js";
import { setCookie, clearCookie } from "../http/cookies.js";

export const SESSION_COOKIE = "wgt_session";

const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const now = () => Date.now();

export function createSession(userId, { userAgent = "" } = {}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now() + env.sessionDays * 24 * 60 * 60 * 1000;

  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hashToken(token), userId, now(), expiresAt, String(userAgent).slice(0, 300));

  return { token, expiresAt };
}

/** Resolve a cookie token to its user, or null. Expired rows are cleaned up as found. */
export function readSession(token) {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at,
              u.id, u.email, u.name, u.is_super, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(hashToken(token));

  if (!row) return null;

  if (row.expires_at <= now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }

  // A disabled account keeps its session row but stops being usable, so
  // disabling somebody takes effect on their very next request.
  if (row.status === "disabled") return null;

  return {
    sessionId: row.session_id,
    id: row.id,
    email: row.email,
    name: row.name,
    isSuper: row.is_super === 1,
    status: row.status,
  };
}

export function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

/** End every session for a user — used when disabling an account or changing a password. */
export function destroyAllSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function attachSessionCookie(res, token, expiresAt) {
  setCookie(res, SESSION_COOKIE, token, {
    maxAge: Math.max(0, Math.floor((expiresAt - now()) / 1000)),
    httpOnly: true,
    sameSite: "Lax",
  });
}

export function removeSessionCookie(res) {
  clearCookie(res, SESSION_COOKIE);
}

/**
 * Delete expired rows. Called on an interval from the route layer rather than
 * on every request — this is housekeeping, not correctness, because
 * `readSession` already refuses anything past its expiry.
 */
export function pruneExpiredSessions() {
  const { changes } = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
  return changes;
}
