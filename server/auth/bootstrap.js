/**
 * First-run bootstrap: make sure somebody can administer the system.
 *
 * A brand new database has no accounts, and every route that could create one
 * with real power requires a super admin — a chicken and egg that has to be
 * broken from outside the app. It is broken here, once, from the environment.
 *
 * After a super admin exists this does nothing, so leaving the variables set in
 * the environment is harmless. It is still worth removing them from `.env`
 * afterwards: a password in a file on the server is a password on the server.
 */

import { db, newId } from "../db/index.js";
import { env } from "../env.js";
import { hashPassword } from "./password.js";

export async function ensureSuperAdmin() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_super = 1").get().n;

  if (existing > 0) {
    if (env.superAdminEmail) {
      console.log(
        "[bootstrap] A super admin already exists — SUPER_ADMIN_EMAIL/PASSWORD ignored. " +
          "You can remove them from your environment.",
      );
    }
    return;
  }

  if (!env.superAdminEmail || !env.superAdminPassword) {
    console.warn(
      "\n[bootstrap] There is no super admin and none can be created.\n" +
        "            Nobody will be able to create a tournament or approve anyone.\n" +
        "            Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD and restart.\n",
    );
    return;
  }

  const email = env.superAdminEmail.toLowerCase();

  // If that address already registered itself and is sitting in the pending
  // queue, promote it rather than failing on the unique constraint. This is the
  // common case: somebody signs up, then realises they need to be the admin.
  const already = db.prepare("SELECT id, email FROM users WHERE email = ? COLLATE NOCASE").get(email);
  if (already) {
    db.prepare("UPDATE users SET is_super = 1, status = 'active' WHERE id = ?").run(already.id);
    console.log(`[bootstrap] Promoted the existing account ${already.email} to super admin.`);
    return;
  }

  const hash = await hashPassword(env.superAdminPassword);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, is_super, status, created_at)
     VALUES (?, ?, ?, ?, 1, 'active', ?)`,
  ).run(newId("us"), email, hash, env.superAdminName || "Super Admin", Date.now());

  console.log(`[bootstrap] Created super admin ${email}.`);
  console.log("[bootstrap] Sign in, then remove SUPER_ADMIN_PASSWORD from your environment.");
}
