/**
 * Import and export, from the console rather than a terminal.
 *
 * The person running a tournament is an organiser, not a developer. Telling
 * them to open PowerShell and get an npm argument separator right is a way of
 * saying "this feature is not really for you". The command line tools still
 * exist for scripting and for the senior developer; these endpoints are how it
 * gets used on the day.
 */

import express from "express";

import { audit } from "../audit.js";
import { requireSuper } from "../auth/middleware.js";
import { badRequest, route } from "../http/errors.js";
import { importFirebaseData } from "../import/firebase-backup.js";
import { listTournaments, loadTournament } from "../db/repo/tournaments.js";
import { broadcast } from "../stream/sse.js";

export const transferRoutes = express.Router();

transferRoutes.use(requireSuper);

/**
 * Bring in a backup from the old Firebase site.
 *
 * Creates a NEW tournament every time rather than merging into an existing
 * one. Merging would need a rule for every collision — same player name,
 * different price; same match number, different score — and getting one of
 * those wrong quietly corrupts a season. A duplicate tournament is obvious and
 * takes one click to delete.
 */
transferRoutes.post(
  "/firebase",
  route(async (req, res) => {
    const backup = req.body?.backup;
    if (!backup || typeof backup !== "object") {
      throw badRequest("Choose a backup file first.");
    }

    const status = ["draft", "active", "completed"].includes(req.body?.status)
      ? req.body.status
      : "completed";

    let report;
    try {
      report = importFirebaseData(backup, {
        name: req.body?.name?.trim() || undefined,
        season: req.body?.season?.trim() || undefined,
        startsOn: req.body?.startsOn || undefined,
        status,
      });
    } catch (err) {
      // The importer's messages are already written for a person, so pass them
      // through rather than burying them in a generic 500.
      throw badRequest(err.message);
    }

    audit(req, "import.firebase", { counts: report.counts, status }, report.tournamentId);
    broadcast(report.tournamentId, "changed", { reason: "import" });

    res.status(201).json({ report, tournament: loadTournament(report.tournamentId) });
  }),
);

/**
 * Export one tournament as JSON.
 *
 * This is the "download a copy before kick-off" button. It is not a substitute
 * for `npm run backup`, which captures accounts and every tournament — that one
 * is the disaster-recovery backup and belongs on a schedule.
 */
transferRoutes.get(
  "/export/:tid",
  route(async (req, res) => {
    const data = loadTournament(req.params.tid);
    if (!data) throw badRequest("No such tournament.");

    const filename = `${data.slug || "tournament"}-${new Date().toISOString().slice(0, 10)}.json`;
    audit(req, "export.tournament", { name: data.name }, data.id);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(
      JSON.stringify(
        { _format: "wegro-tournaments-single", _version: 1, _exportedAt: new Date().toISOString(), tournament: data },
        null,
        2,
      ),
    );
  }),
);

/** What is already here — so the console can warn before importing a duplicate. */
transferRoutes.get(
  "/existing",
  route(async (req, res) => {
    res.json({ tournaments: listTournaments({ includeDrafts: true }) });
  }),
);
