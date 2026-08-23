/**
 * The live feed.
 *
 * `GET /api/stream` for every tournament, `GET /api/stream/:tid` for one.
 * Public, like the scoreboard it drives — anyone with the link can watch.
 */

import express from "express";

import { openStream } from "../stream/sse.js";
import { findTournament } from "../db/repo/tournaments.js";
import { notFoundError, route } from "../http/errors.js";

export const streamRoutes = express.Router();

streamRoutes.get("/", (req, res) => {
  openStream(req, res, "*");
});

streamRoutes.get(
  "/:tid",
  route(async (req, res) => {
    const tournament = findTournament(req.params.tid);
    if (!tournament) throw notFoundError("No such tournament.");
    openStream(req, res, tournament.id);
  }),
);
