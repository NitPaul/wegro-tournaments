/**
 * The hall of fame — public, no sign-in.
 *
 * Reads the cached archive rows rather than deriving every tournament's result
 * on each request. See server/db/repo/archive.js for why that trade is made
 * here and nowhere else.
 */

import express from "express";

import { listArchive } from "../db/repo/archive.js";
import { route } from "../http/errors.js";

export const archiveRoutes = express.Router();

archiveRoutes.get(
  "/",
  route(async (req, res) => {
    const entries = listArchive();

    res.json({
      entries,
      // Small enough to compute on the fly, and it saves the page doing the
      // same arithmetic in JavaScript on every load.
      summary: {
        tournaments: entries.filter((e) => e.format === "league").length,
        friendlies: entries.filter((e) => e.format === "friendly").length,
        titles: titlesByTeam(entries),
      },
    });
  }),
);

/** Who has won the most, by team name — names, because a team id is per-tournament. */
function titlesByTeam(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e.champion) continue;
    counts.set(e.champion, (counts.get(e.champion) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([team, wins]) => ({ team, wins }))
    .sort((a, b) => b.wins - a.wins || a.team.localeCompare(b.team));
}
