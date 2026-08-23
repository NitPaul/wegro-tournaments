/**
 * API surface.
 *
 * Everything lives under /api so the static file handler below it never has to
 * guess whether `/standings` is a page or an endpoint.
 *
 * Read routes are public — the scoreboard is meant to be watched by anyone with
 * the link, exactly as before. Every write route names the permission it needs.
 */

import express from "express";

import { env } from "../env.js";
import { archiveRoutes } from "./archive.js";
import { authRoutes } from "./auth.js";
import { streamRoutes } from "./stream.js";
import { tournamentRoutes } from "./tournaments.js";
import { transferRoutes } from "./transfer.js";
import { userRoutes } from "./users.js";
import { pruneExpiredSessions } from "../auth/session.js";
import { streamStats } from "../stream/sse.js";

export function mountRoutes(app) {
  const api = express.Router();

  api.get("/health", (req, res) => {
    res.json({ ok: true, streams: streamStats(), registration: env.allowRegistration });
  });

  api.use("/auth", authRoutes);
  api.use("/users", userRoutes);
  api.use("/tournaments", tournamentRoutes);
  api.use("/archive", archiveRoutes);
  api.use("/import", transferRoutes);
  api.use("/stream", streamRoutes);

  app.use("/api", api);

  // Housekeeping: expired session rows are already refused on read, so this is
  // tidiness rather than correctness. Hourly is plenty, and unref means it never
  // holds the process open during shutdown.
  const prune = setInterval(
    () => {
      const removed = pruneExpiredSessions();
      if (removed) console.log(`[sessions] pruned ${removed} expired`);
    },
    60 * 60 * 1000,
  );
  prune.unref();
}
