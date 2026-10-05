/**
 * The whole site, for the person who owns it.
 *
 * Two jobs. The first is a copy you can walk away with: the database, a
 * readable dump of it, and every photo, in one file, downloaded through the
 * browser. A backup that only exists on the server is not a backup — it is a
 * second copy of the thing that just caught fire.
 *
 * The second is telling the truth about how this instance is set up, because
 * the settings that break a site quietly (a wrong PUBLIC_URL, a data directory
 * that is not a volume) are invisible from every other screen.
 */

import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { audit } from "../audit.js";
import { requireSuper } from "../auth/middleware.js";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { route } from "../http/errors.js";
import { PHOTO_DIR } from "../photos.js";
import { siteTotals } from "../roster.js";
import { zip } from "../zip.js";
import { runBackup } from "../../tools/backup.js";

export const siteRoutes = express.Router();

/** Every table worth carrying out of here, in a sensible reading order. */
const TABLES = [
  "users",
  "tournaments",
  "tournament_staff",
  "teams",
  "people",
  "players",
  "matches",
  "events",
  "archive",
  "audit_log",
];

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** The landing page's headline numbers. Public, and cached with the roster. */
siteRoutes.get("/", (req, res) => {
  res.json({ totals: siteTotals() });
});

// Everything below is the owner's.
siteRoutes.use(requireSuper);

/**
 * A consistent copy of the database, as bytes.
 *
 * VACUUM INTO is what makes this safe to press mid-match: SQLite writes a
 * complete snapshot rather than whatever the file happened to look like
 * between two writes.
 */
function snapshot() {
  const file = path.join(os.tmpdir(), `wegro-${stamp()}-${process.pid}.sqlite`);
  try {
    fs.rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Every row, as plain JSON. Password hashes stay in the .sqlite copy only. */
function dump() {
  const tables = {};
  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    tables[table] = table === "users" ? rows.map(({ password_hash, ...rest }) => rest) : rows;
  }
  return { _format: "wegro-tournaments", _version: 1, _exportedAt: new Date().toISOString(), tables };
}

function photoFiles() {
  if (!fs.existsSync(PHOTO_DIR)) return [];
  return fs
    .readdirSync(PHOTO_DIR)
    .filter((name) => !name.endsWith(".part")) // an upload still being written
    .map((name) => ({ name, bytes: fs.statSync(path.join(PHOTO_DIR, name)).size }));
}

const bytesOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** What is here, how it is configured, and what might be wrong with it. */
siteRoutes.get(
  "/overview",
  route(async (req, res) => {
    const counts = Object.fromEntries(
      TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]),
    );
    const photos = photoFiles();

    // Known-wrong configurations, named plainly. A site served from a domain
    // with PUBLIC_URL still pointing at localhost signs people out and breaks
    // every link preview, and nothing else in the console would ever say so.
    const warnings = [];
    const publicUrl = env.publicUrl ?? "";
    if (/localhost|127\.0\.0\.1/.test(publicUrl)) {
      warnings.push({
        key: "public-url",
        text: `PUBLIC_URL is ${publicUrl}. On a real server it must be the address people type, or sign-in cookies and link previews are wrong. Change it in .env and restart.`,
      });
    }
    if (env.isProduction && publicUrl.startsWith("http://")) {
      warnings.push({
        key: "public-url-http",
        text: "PUBLIC_URL is plain http. Session cookies are only marked Secure over https.",
      });
    }
    if (!fs.existsSync(env.backupDir)) {
      warnings.push({ key: "backup-dir", text: `No backups have been made on the server yet (${env.backupDir}).` });
    }

    res.json({
      counts,
      totals: siteTotals(),
      database: {
        file: env.databaseFile,
        bytes: bytesOf(env.databaseFile) + bytesOf(`${env.databaseFile}-wal`),
        version: db.prepare("PRAGMA user_version").get().user_version,
      },
      photos: { count: photos.length, bytes: photos.reduce((n, p) => n + p.bytes, 0), dir: PHOTO_DIR },
      backups: listBackups(),
      config: {
        publicUrl,
        dataDir: env.dataDir,
        backupDir: env.backupDir,
        isProduction: env.isProduction,
        sessionDays: env.sessionDays,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
      },
      warnings,
    });
  }),
);

/** The copies already sitting on the server, newest first. */
function listBackups() {
  if (!fs.existsSync(env.backupDir)) return [];
  return fs
    .readdirSync(env.backupDir, { withFileTypes: true })
    .filter((d) => d.isFile() && (d.name.endsWith(".sqlite") || d.name.endsWith(".json")))
    .map((d) => {
      const s = fs.statSync(path.join(env.backupDir, d.name));
      return { name: d.name, bytes: s.size, at: s.mtimeMs };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);
}

/** Everything, in one file: the database, the readable dump and every photo. */
siteRoutes.get(
  "/backup.zip",
  route(async (req, res) => {
    const when = stamp();
    const entries = [
      { name: "wegro.sqlite", data: snapshot() },
      { name: "wegro.json", data: Buffer.from(JSON.stringify(dump(), null, 2), "utf8") },
      {
        name: "README.txt",
        data: Buffer.from(
          [
            "WeGro Tournaments — full backup",
            `Taken ${new Date().toISOString()} from ${env.publicUrl}`,
            "",
            "wegro.sqlite   the database. This is the one that restores the site:",
            "               put it in the data volume as wegro.sqlite and start the server.",
            "wegro.json     the same data as readable JSON, without password hashes.",
            "photos/        every player photo. These are files, not rows, so neither",
            "               of the two above contains them; copy them into DATA_DIR/photos.",
            "",
            "Keep this somewhere that is not the server it came from.",
            "",
          ].join("\n"),
          "utf8",
        ),
      },
    ];

    for (const photo of photoFiles()) {
      entries.push({ name: `photos/${photo.name}`, data: fs.readFileSync(path.join(PHOTO_DIR, photo.name)) });
    }

    const archive = zip(entries);
    audit(req, "backup.download", { kind: "zip", bytes: archive.length, files: entries.length });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="wegro-backup-${when}.zip"`);
    res.setHeader("Content-Length", String(archive.length));
    res.end(archive);
  }),
);

/** The database on its own, for a quick copy or a restore. */
siteRoutes.get(
  "/backup.sqlite",
  route(async (req, res) => {
    const bytes = snapshot();
    audit(req, "backup.download", { kind: "sqlite", bytes: bytes.length });

    res.setHeader("Content-Type", "application/vnd.sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="wegro-${stamp()}.sqlite"`);
    res.setHeader("Content-Length", String(bytes.length));
    res.end(bytes);
  }),
);

/** The readable dump, for reading the data without this software. */
siteRoutes.get(
  "/backup.json",
  route(async (req, res) => {
    const body = JSON.stringify(dump(), null, 2);
    audit(req, "backup.download", { kind: "json", bytes: body.length });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="wegro-${stamp()}.json"`);
    res.send(body);
  }),
);

/** The same backup `npm run backup` writes, made from the console. */
siteRoutes.post(
  "/backup",
  route(async (req, res) => {
    const result = runBackup();
    audit(req, "backup.server", { counts: result.counts, photos: result.photos });
    res.json({
      backup: {
        database: path.basename(result.sqlitePath),
        json: path.basename(result.jsonPath),
        photos: result.photos,
        dir: env.backupDir,
        counts: result.counts,
      },
      backups: listBackups(),
    });
  }),
);
