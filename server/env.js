/**
 * Configuration, validated once at boot.
 *
 * The rule here is: fail loudly and immediately, never silently degrade. The
 * previous version of this project derived its whole operating mode from
 * whether a config value happened to be blank, so a missing setting booted a
 * working-looking site backed by nothing. Finding that out at 4pm on a match
 * day is not a debugging session anybody wants. If something required is
 * missing we print what it is, how to fix it, and exit non-zero so the
 * container restart loop makes the problem impossible to ignore.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";

// Node can read a .env file itself since 21.7, so there is no dotenv dependency
// here. Absent file is the normal case in Docker, where the values are injected
// as real environment variables.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — expected in a container */
}

const isProduction = process.env.NODE_ENV === "production";
const problems = [];

function required(name, hint) {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  problems.push(`${name} is not set. ${hint}`);
  return "";
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    problems.push(`${name} must be a positive whole number, got "${raw}".`);
    return fallback;
  }
  return n;
}

/**
 * The session secret signs cookies, so changing it logs everybody out. In
 * production it must be supplied and persistent. In development we generate a
 * throwaway one rather than blocking work, but we say so — an unexplained
 * logout after every restart is exactly the kind of thing that gets
 * misdiagnosed as a bug in the auth code.
 */
function sessionSecret() {
  const supplied = process.env.SESSION_SECRET?.trim();
  if (supplied && supplied.length >= 32) return supplied;

  if (supplied && supplied.length < 32) {
    problems.push(
      `SESSION_SECRET is only ${supplied.length} characters. Use at least 32. ` +
        `Generate one with:  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
    );
    return supplied;
  }

  if (isProduction) {
    problems.push(
      'SESSION_SECRET is not set. Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
    return "";
  }

  console.warn(
    "[env] SESSION_SECRET is not set. Using a throwaway secret for this run — " +
      "everyone will be signed out when the server restarts. Set one in .env to stop that.",
  );
  return randomBytes(48).toString("hex");
}

const dataDir = path.resolve(optional("DATA_DIR", "./data"));

export const env = {
  isProduction,
  port: int("PORT", 3000),
  host: optional("HOST", "0.0.0.0"),

  dataDir,
  databaseFile: path.join(dataDir, optional("DATABASE_FILE", "wegro.sqlite")),
  backupDir: path.resolve(optional("BACKUP_DIR", "./backups")),

  sessionSecret: sessionSecret(),
  sessionDays: int("SESSION_DAYS", 30),

  /**
   * Public origin, e.g. https://tournaments.wegro.global. Used for absolute
   * URLs in link previews and to decide whether cookies get the Secure flag.
   * Required in production because a wrong value here breaks sign-in in a way
   * that looks like a password problem.
   */
  publicUrl: isProduction
    ? required("PUBLIC_URL", "Set it to the full origin the site is served from, e.g. https://tournaments.wegro.global")
    : optional("PUBLIC_URL", `http://localhost:${int("PORT", 3000)}`),

  /**
   * First-run bootstrap only. Once a super admin exists in the database these
   * are ignored, so leaving them in the environment is harmless but pointless.
   */
  superAdminEmail: optional("SUPER_ADMIN_EMAIL", ""),
  superAdminPassword: optional("SUPER_ADMIN_PASSWORD", ""),
  superAdminName: optional("SUPER_ADMIN_NAME", "Super Admin"),

  /** Allow public self-registration into the pending queue. */
  allowRegistration: optional("ALLOW_REGISTRATION", "true") !== "false",

  logLevel: optional("LOG_LEVEL", isProduction ? "info" : "debug"),
};

if (env.superAdminPassword && env.superAdminPassword.length < 10) {
  problems.push("SUPER_ADMIN_PASSWORD must be at least 10 characters.");
}

if (problems.length) {
  console.error("\nThis server cannot start. Fix the following and try again:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\nSee .env.example for every supported setting.\n");
  process.exit(1);
}

if (env.publicUrl.startsWith("http://") && env.isProduction) {
  console.warn(
    `[env] PUBLIC_URL is ${env.publicUrl} — plain HTTP. Session cookies will not be marked Secure, ` +
      "and browsers block some features outside a secure context. Put TLS in front of this before match day.",
  );
}
