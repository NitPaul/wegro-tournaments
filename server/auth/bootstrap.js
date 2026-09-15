/**
 * First-run bootstrap: make sure somebody can administer the system.
 *
 * A brand new database has no accounts, and creating one needs a super admin —
 * a chicken and egg that has to be broken from outside the app. It is broken
 * here, once, from the environment.
 *
 * After a super admin exists this does nothing, so leaving the variables set is
 * harmless. It is still worth removing the password from `.env` afterwards: a
 * password in a file on the server is a password on the server.
 */

import { db, newId } from "../db/index.js";
import { env } from "../env.js";
import { hashPassword } from "./password.js";
import { USERNAME_RE } from "./username.js";

export async function ensureSuperAdmin() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_super = 1").get().n;

  if (existing > 0) {
    if (env.superAdminPassword) {
      console.log(
        "[bootstrap] A super admin already exists, so SUPER_ADMIN_PASSWORD is ignored. " +
          "Remove it from your environment.",
      );
    }
    return;
  }

  const email = env.superAdminEmail ? env.superAdminEmail.toLowerCase() : null;
  // The User ID to sign in with. Without one, the part of the email before the @.
  const username = (env.superAdminUsername || (email ? email.split("@")[0] : "")).toLowerCase();

  if (!username || !env.superAdminPassword) {
    console.warn(
      "\n[bootstrap] There is no super admin and none can be created.\n" +
        "            Nobody will be able to create a tournament or an account.\n" +
        "            Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD and restart.\n",
    );
    return;
  }
  if (!USERNAME_RE.test(username)) {
    console.warn(
      `\n[bootstrap] "${username}" cannot be used as a User ID. Use 3–32 letters, numbers, dots, ` +
        "dashes or underscores in SUPER_ADMIN_USERNAME and restart.\n",
    );
    return;
  }

  // If that account already exists as an ordinary one, promote it rather than
  // failing on the unique constraint.
  const already = db
    .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE OR (? IS NOT NULL AND email = ? COLLATE NOCASE)")
    .get(username, email, email);
  if (already) {
    db.prepare("UPDATE users SET is_super = 1, status = 'active' WHERE id = ?").run(already.id);
    db.prepare("DELETE FROM tournament_staff WHERE user_id = ?").run(already.id);
    console.log(`[bootstrap] Made the existing account ${already.username} the super admin.`);
    return;
  }

  const hash = await hashPassword(env.superAdminPassword);
  db.prepare(
    `INSERT INTO users (id, username, email, password_hash, name, is_super, status, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'active', ?)`,
  ).run(newId("us"), username, email, hash, env.superAdminName || "Super Admin", Date.now());

  console.log(`[bootstrap] Created super admin "${username}".`);
  console.log("[bootstrap] Sign in, then remove SUPER_ADMIN_PASSWORD from your environment.");
}
