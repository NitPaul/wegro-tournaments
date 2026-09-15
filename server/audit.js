/**
 * Audit trail.
 *
 * The moment three people share one console, "who cleared the scores?" stops
 * being hypothetical. Every mutating request writes one row here — cheap to
 * store, and the only way to answer that question after the fact.
 *
 * Who did it is copied into the row as text (User ID, and email where there is
 * one) on purpose: it must still read correctly after the account has been
 * deleted, which is exactly when someone goes looking.
 */

import { db } from "./db/index.js";

export function audit(req, action, detail = {}, tournamentId = null) {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, user_email, username, tournament_id, action, detail_json, ip, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.user?.id ?? null,
      req.user?.email ?? "",
      req.user?.username ?? (req.user ? null : "anonymous"),
      tournamentId ?? req.tournament?.id ?? null,
      action,
      JSON.stringify(detail ?? {}),
      (req.ip || "").slice(0, 64),
      Date.now(),
    );
  } catch (err) {
    // Never let bookkeeping break the request that was actually asked for.
    console.error(`[audit] could not record "${action}":`, err.message);
  }
}

export function recentAudit({ tournamentId = null, limit = 100 } = {}) {
  const rows = tournamentId
    ? db
        .prepare(
          `SELECT * FROM audit_log WHERE tournament_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(tournamentId, limit)
    : db.prepare(`SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`).all(limit);

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username ?? null,
    userEmail: r.user_email || null,
    tournamentId: r.tournament_id,
    action: r.action,
    detail: safeParse(r.detail_json),
    at: r.at,
  }));
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
