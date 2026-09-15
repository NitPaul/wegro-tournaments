/**
 * Tournament routes.
 *
 * Two things to notice, because they are the point of the rebuild:
 *
 * 1. Every mutating route names the permission it needs, in the route
 *    definition, where it cannot be missed. `requireTournament("admin")` is a
 *    server-side check against a database row. A referee who POSTs here from
 *    devtools gets a 403 — not a hidden tab.
 *
 * 2. The rules are enforced with the SAME domain functions the browser uses to
 *    grey out the button. `validateSale` runs here, on the server, so an
 *    illegal bid is impossible rather than merely discouraged.
 */

import express from "express";

import * as D from "../../shared/domain/index.js";
import { audit, recentAudit } from "../audit.js";
import { requireSuper, requireTournament, permissionsFor } from "../auth/middleware.js";
import { badRequest, conflict, forbidden, notFoundError, route } from "../http/errors.js";
import { broadcast } from "../stream/sse.js";
import { getPerson, linkPlayer } from "../db/repo/people.js";
import { recomputeArchive, removeArchive } from "../db/repo/archive.js";
import {
  assignmentOf,
  assignStaff,
  createTournament,
  defaultTournament,
  deleteTournament,
  listStaff,
  listTournaments,
  loadTournament,
  patchMeta,
  patchSettings,
  removeStaff,
  tournamentOverview,
  updateTournament,
} from "../db/repo/tournaments.js";
import {
  createPlayer,
  createTeam,
  deletePlayer,
  deleteTeam,
  getPlayer,
  resetAuction,
  setPlayerTeam,
  updatePlayer,
  updateTeam,
} from "../db/repo/squads.js";
import {
  addEvent,
  clearAllScores,
  clearMatch,
  createMatch,
  deleteEvent,
  deleteMatch,
  getEvent,
  getMatch,
  nextMatchNumber,
  updateEvent,
  updateMatch,
} from "../db/repo/matches.js";
import { db, transaction } from "../db/index.js";

export const tournamentRoutes = express.Router();

/** Reload and push. Clients refetch on any event, so the payload is just a hint. */
function touched(req, res, reason, extra = {}) {
  const data = loadTournament(req.tournament.id);
  broadcast(req.tournament.id, "changed", { reason, ...extra });
  return res.json({ tournament: data });
}

/** The document plus what this viewer is allowed to do with it. */
const withPermissions = (req, data) => ({
  tournament: data,
  permissions: permissionsFor(req.user, data.id),
});

/* ------------------------------------------------------------------- list */

tournamentRoutes.get(
  "/",
  route(async (req, res) => {
    // Drafts are hidden from the public but visible to anyone who works on one.
    const all = listTournaments({ includeDrafts: true });
    const visible = req.user?.isSuper
      ? all
      : all.filter((t) => {
          if (t.status !== "draft") return true;
          if (!req.user) return false;
          return Boolean(
            db
              .prepare("SELECT 1 FROM tournament_staff WHERE tournament_id = ? AND user_id = ?")
              .get(t.id, req.user.id),
          );
        });

    const fallback = defaultTournament();
    res.json({ tournaments: visible, defaultSlug: fallback?.slug ?? null });
  }),
);

tournamentRoutes.post(
  "/",
  requireSuper,
  route(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw badRequest("Give the tournament a name.");
    if (name.length > 80) throw badRequest("That name is too long — 80 characters at most.");

    const format = req.body?.format === "friendly" ? "friendly" : "league";

    const row = createTournament({
      name,
      season: String(req.body?.season ?? "").trim(),
      format,
      startsOn: req.body?.startsOn || null,
      meta: { ...D.DEFAULT_META, ...(req.body?.meta ?? {}) },
      settings: { ...D.DEFAULT_SETTINGS, ...(req.body?.settings ?? {}) },
      userId: req.user.id,
    });

    audit(req, "tournament.create", { name, format }, row.id);
    res.status(201).json({ tournament: loadTournament(row.id) });
  }),
);

/**
 * Every tournament with its code, staff, previous names and last activity — the
 * super admin's monitoring view. Declared before `/:tid` so the word "overview"
 * is never taken for a tournament id.
 */
tournamentRoutes.get(
  "/overview",
  requireSuper,
  route(async (req, res) => {
    res.json({ tournaments: tournamentOverview() });
  }),
);

/* -------------------------------------------------------------- read one */

tournamentRoutes.get(
  "/:tid",
  requireTournament(),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    if (req.tournament.status === "draft" && !req.tournamentRole) {
      throw notFoundError("No such tournament.");
    }
    res.json(withPermissions(req, data));
  }),
);

tournamentRoutes.patch(
  "/:tid",
  requireTournament("admin"),
  route(async (req, res) => {
    const patch = {};
    for (const key of ["name", "season", "startsOn"]) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    if (patch.name !== undefined) {
      patch.name = String(patch.name).trim();
      if (!patch.name) throw badRequest("A tournament needs a name.");
      if (patch.name.length > 80) throw badRequest("That name is too long — 80 characters at most.");
    }
    if (patch.season !== undefined) patch.season = String(patch.season ?? "").trim().slice(0, 20);
    if (patch.startsOn !== undefined) {
      patch.startsOn = patch.startsOn || null;
      if (patch.startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(patch.startsOn)) {
        throw badRequest("The start date should look like 2027-03-14, or be left empty.");
      }
    }

    // Status and format change what a tournament IS, so they are the super
    // admin's call, not a tournament admin's.
    for (const key of ["status", "format"]) {
      if (req.body?.[key] !== undefined) {
        if (!req.user.isSuper) throw forbidden(`Only the super admin can change the ${key}.`);
        patch[key] = req.body[key];
      }
    }

    if (patch.status === "completed") {
      patch.completedAt = Date.now();
    } else if (patch.status && req.tournament.status === "completed") {
      // Re-opening a finished tournament drops it out of the hall of fame until
      // it is finished again, rather than leaving a stale entry behind.
      patch.completedAt = null;
      removeArchive(req.tournament.id);
    }

    updateTournament(req.tournament.id, patch);
    if (patch.status === "completed") recomputeArchive(req.tournament.id);

    const renamedFrom =
      patch.name !== undefined && patch.name !== req.tournament.name ? req.tournament.name : undefined;
    audit(req, "tournament.update", { ...patch, code: req.tournament.code, renamedFrom });
    touched(req, res, "tournament");
  }),
);

tournamentRoutes.delete(
  "/:tid",
  requireTournament("super"),
  route(async (req, res) => {
    audit(req, "tournament.delete", { name: req.tournament.name });
    deleteTournament(req.tournament.id);
    broadcast(req.tournament.id, "deleted", {});
    res.json({ ok: true });
  }),
);

tournamentRoutes.post(
  "/:tid/settings",
  requireTournament("admin"),
  route(async (req, res) => {
    patchSettings(req.tournament.id, req.body ?? {});
    audit(req, "tournament.settings", req.body ?? {});
    touched(req, res, "settings");
  }),
);

tournamentRoutes.post(
  "/:tid/meta",
  requireTournament("admin"),
  route(async (req, res) => {
    patchMeta(req.tournament.id, req.body ?? {});
    audit(req, "tournament.meta", req.body ?? {});
    touched(req, res, "meta");
  }),
);

/* ------------------------------------------------------------------ staff */

tournamentRoutes.get(
  "/:tid/staff",
  requireTournament("admin"),
  route(async (req, res) => {
    res.json({ staff: listStaff(req.tournament.id) });
  }),
);

tournamentRoutes.post(
  "/:tid/staff",
  requireTournament("super"),
  route(async (req, res) => {
    const userId = String(req.body?.userId ?? "");
    const role = String(req.body?.role ?? "");
    if (!["admin", "referee"].includes(role)) throw badRequest("Role must be admin or referee.");

    const user = db.prepare("SELECT id, username, is_super FROM users WHERE id = ?").get(userId);
    if (!user) throw notFoundError("No such account.");
    if (user.is_super === 1) {
      throw badRequest("A super admin already has every tournament. There is nothing to assign.");
    }

    // One tournament per account. Changing the role on the same tournament is
    // fine; moving the account to a second one is not.
    const current = assignmentOf(userId);
    if (current && current.id !== req.tournament.id) {
      throw conflict(
        `This account already belongs to ${current.code} (${current.name}). ` +
          "Each admin or referee account is for one tournament — create a separate account for this one.",
      );
    }

    const staff = assignStaff(req.tournament.id, userId, role, req.user.id);
    audit(req, "staff.assign", { username: user.username, role, code: req.tournament.code });
    res.json({ staff });
  }),
);

tournamentRoutes.delete(
  "/:tid/staff/:userId",
  requireTournament("super"),
  route(async (req, res) => {
    const user = db.prepare("SELECT username FROM users WHERE id = ?").get(req.params.userId);
    const staff = removeStaff(req.tournament.id, req.params.userId);
    audit(req, "staff.remove", { username: user?.username ?? req.params.userId, code: req.tournament.code });
    res.json({ staff });
  }),
);

/**
 * What has been done to this tournament, newest first. Its own admin can read
 * it; nobody else's can.
 */
tournamentRoutes.get(
  "/:tid/activity",
  requireTournament("admin"),
  route(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ activity: recentAudit({ tournamentId: req.tournament.id, limit }) });
  }),
);

/* ------------------------------------------------------------------ teams */

tournamentRoutes.post(
  "/:tid/teams",
  requireTournament("admin"),
  route(async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw badRequest("Give the team a name.");

    const id = createTeam(req.tournament.id, {
      name,
      slot: String(req.body?.slot ?? "").trim(),
      jerseyColor: req.body?.jerseyColor ?? null,
      jerseyLabel: String(req.body?.jerseyLabel ?? ""),
      jerseyCost: Number(req.body?.jerseyCost ?? 0),
    });

    // A captain can be named at the same moment, which is how teams are
    // actually created — nobody adds a team and then wonders who leads it.
    // Picked from the roster, they arrive already matched: photo and career.
    const captainPerson = req.body?.captainPersonId ? getPerson(String(req.body.captainPersonId)) : null;
    if (req.body?.captainPersonId && !captainPerson) throw notFoundError("That captain is not on the roster.");
    const captain = captainPerson?.name ?? String(req.body?.captainName ?? "").trim();
    if (captain) {
      createPlayer(req.tournament.id, {
        name: captain,
        pos: req.body?.captainPos ?? captainPerson?.pos ?? "MID",
        teamId: id,
        price: 0,
        kind: "captain",
        personId: captainPerson?.id ?? null,
      });
    }

    audit(req, "team.create", { name, captain });
    touched(req, res, "teams", { teamId: id });
  }),
);

tournamentRoutes.patch(
  "/:tid/teams/:teamId",
  requireTournament("admin"),
  route(async (req, res) => {
    if (!updateTeam(req.params.teamId, req.body ?? {})) throw notFoundError("No such team.");
    audit(req, "team.update", { teamId: req.params.teamId, ...req.body });
    touched(req, res, "teams");
  }),
);

tournamentRoutes.delete(
  "/:tid/teams/:teamId",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const team = data.teams[req.params.teamId];
    if (!team) throw notFoundError("No such team.");

    const played = D.matchesList(data).some(
      (m) => (m.homeId === team.id || m.awayId === team.id) && m.status !== "scheduled",
    );
    if (played) {
      throw badRequest(
        `${team.name} has already played. Deleting them would leave those results with no team — clear their matches first.`,
      );
    }

    deleteTeam(team.id);
    audit(req, "team.delete", { name: team.name });
    touched(req, res, "teams");
  }),
);

/* ---------------------------------------------------------------- players */

tournamentRoutes.post(
  "/:tid/players",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const kind = ["auction", "captain", "guest"].includes(req.body?.kind) ? req.body.kind : "guest";
    const name = String(req.body?.name ?? "").trim();
    const pos = String(req.body?.pos ?? "");
    const teamId = req.body?.teamId || null;

    const check = D.validateNewPlayer(data, { name, pos, teamId, kind });
    if (!check.ok) throw badRequest(check.error);

    const id = createPlayer(req.tournament.id, {
      name,
      pos,
      teamId,
      kind,
      price: kind === "auction" ? null : 0,
    });

    audit(req, "player.create", { name, pos, kind, teamId });
    touched(req, res, "players", { playerId: id });
  }),
);

/**
 * Add people from the roster to this tournament in one go — the normal way to
 * build an auction pool from the second tournament on. Each arrives matched to
 * their roster person, so their photo and record come with them. Anyone already
 * in the tournament is skipped and said so, not duplicated.
 */
tournamentRoutes.post(
  "/:tid/players/from-roster",
  requireTournament("admin"),
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.personIds) ? [...new Set(req.body.personIds.map(String))] : [];
    if (!ids.length) throw badRequest("Choose at least one player.");
    if (ids.length > 200) throw badRequest("That is more players than a tournament can hold.");
    const kind = req.body?.kind === "guest" ? "guest" : "auction";
    const teamId = kind === "guest" ? req.body?.teamId || null : null;

    const added = [];
    const skipped = [];
    transaction(() => {
      for (const personId of ids) {
        const person = getPerson(personId);
        if (!person) {
          skipped.push({ name: personId, reason: "not on the roster" });
          continue;
        }
        const data = loadTournament(req.tournament.id);
        if (Object.values(data.players).some((p) => p.personId === person.id)) {
          skipped.push({ name: person.name, reason: "already in this tournament" });
          continue;
        }
        if (!person.pos) {
          skipped.push({ name: person.name, reason: "has no position — set one on the Players screen" });
          continue;
        }
        const check = D.validateNewPlayer(data, { name: person.name, pos: person.pos, teamId, kind });
        if (!check.ok) {
          skipped.push({ name: person.name, reason: check.error });
          continue;
        }
        createPlayer(req.tournament.id, {
          name: person.name,
          pos: person.pos,
          teamId,
          kind,
          price: kind === "auction" ? null : 0,
          personId: person.id,
        });
        added.push(person.name);
      }
    });

    audit(req, "player.create_from_roster", { kind, added: added.length, skipped: skipped.length });
    const data = loadTournament(req.tournament.id);
    broadcast(req.tournament.id, "changed", { reason: "players" });
    res.json({ tournament: data, added, skipped });
  }),
);

tournamentRoutes.patch(
  "/:tid/players/:playerId",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const player = data.players[req.params.playerId];
    if (!player) throw notFoundError("No such player.");

    if (req.body?.name !== undefined || req.body?.kind !== undefined) {
      const check = D.validateNewPlayer(data, {
        name: req.body.name ?? player.name,
        pos: req.body.pos ?? player.pos,
        teamId: req.body.teamId !== undefined ? req.body.teamId : player.teamId,
        kind: req.body.kind ?? player.kind,
        ignoreId: player.id,
      });
      if (!check.ok) throw badRequest(check.error);
    }

    updatePlayer(player.id, req.body ?? {});
    audit(req, "player.update", { playerId: player.id, ...req.body });
    touched(req, res, "players");
  }),
);

tournamentRoutes.delete(
  "/:tid/players/:playerId",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const check = D.validateRemovePlayer(data, req.params.playerId);
    if (!check.ok) throw badRequest(check.error);

    audit(req, "player.delete", { name: data.players[req.params.playerId]?.name });
    deletePlayer(req.params.playerId);
    touched(req, res, "players");
  }),
);

/**
 * Say which roster person a tournament player is — or `personId: null` to
 * unlink. This is what puts a face on the player and carries their goals into
 * their career. Suggestions are made in the browser; a person only ever gets
 * linked by somebody choosing them.
 */
tournamentRoutes.post(
  "/:tid/players/:playerId/person",
  requireTournament("admin"),
  route(async (req, res) => {
    const player = getPlayer(req.params.playerId);
    if (!player || player.tournament_id !== req.tournament.id) throw notFoundError("No such player in this tournament.");

    const personId = req.body?.personId ? String(req.body.personId) : null;
    const person = personId ? getPerson(personId) : null;
    if (personId && !person) throw notFoundError("No such person on the roster.");

    linkPlayer(player.id, personId);
    audit(req, "player.link", { player: player.name, person: person?.name ?? null });
    touched(req, res, "players");
  }),
);

/* ---------------------------------------------------------------- auction */

tournamentRoutes.post(
  "/:tid/auction/sell",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const { playerId, teamId } = req.body ?? {};
    const price = Number(req.body?.price);

    // The same function the browser used to enable the button. Running it here
    // is what turns the auction rules from advice into enforcement.
    const check = D.validateSale(data, playerId, teamId, price);
    if (!check.ok) throw badRequest(check.error);

    setPlayerTeam(playerId, teamId, price);
    // Sold, so off the block.
    if (D.getSettings(data).auctionOnBlock === playerId) patchSettings(req.tournament.id, { auctionOnBlock: null });
    audit(req, "auction.sell", {
      player: data.players[playerId]?.name,
      team: data.teams[teamId]?.name,
      price,
    });
    touched(req, res, "auction", { playerId, teamId, price });
  }),
);

/**
 * Put a player "on the block" — the one being bid for now — or clear it with
 * `playerId: null`. The projector screen shows whoever is on the block, so the
 * room sees the face and the record while the bidding happens.
 */
tournamentRoutes.post(
  "/:tid/auction/block",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const playerId = req.body?.playerId ? String(req.body.playerId) : null;
    if (playerId) {
      const player = data.players[playerId];
      if (!player || !D.isAuctionPlayer(player)) throw notFoundError("No such player in the auction pool.");
      if (player.teamId) throw badRequest(`${player.name} has already been sold.`);
    }
    patchSettings(req.tournament.id, { auctionOnBlock: playerId, auctionOnBlockAt: playerId ? Date.now() : null });
    audit(req, "auction.block", { player: playerId ? data.players[playerId].name : null });
    touched(req, res, "auction", { onBlock: playerId });
  }),
);

tournamentRoutes.post(
  "/:tid/auction/unsell",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const player = data.players[req.body?.playerId];
    if (!player) throw notFoundError("No such player.");
    if (!D.isAuctionPlayer(player)) throw badRequest(`${player.name} was not bought at the auction.`);

    setPlayerTeam(player.id, null, null);
    audit(req, "auction.unsell", { player: player.name, refund: player.price });
    touched(req, res, "auction", { playerId: player.id });
  }),
);

/** Place or remove a guest. Free, and outside every squad rule. */
tournamentRoutes.post(
  "/:tid/auction/guest",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const { playerId } = req.body ?? {};
    const teamId = req.body?.teamId || null;

    const check = D.validateGuestPlacement(data, playerId, teamId);
    if (!check.ok) throw badRequest(check.error);

    setPlayerTeam(playerId, teamId, 0);
    audit(req, "auction.guest", { player: data.players[playerId]?.name, team: data.teams[teamId]?.name ?? null });
    touched(req, res, "players", { playerId });
  }),
);

tournamentRoutes.post(
  "/:tid/auction/reset",
  requireTournament("super"),
  route(async (req, res) => {
    resetAuction(req.tournament.id);
    audit(req, "auction.reset", {});
    touched(req, res, "auction");
  }),
);

/* ---------------------------------------------------------------- matches */

tournamentRoutes.post(
  "/:tid/matches",
  requireTournament("admin"),
  route(async (req, res) => {
    const id = createMatch(req.tournament.id, {
      no: Number(req.body?.no) || nextMatchNumber(req.tournament.id),
      homeId: req.body?.homeId || null,
      awayId: req.body?.awayId || null,
      isFinal: Boolean(req.body?.isFinal),
      kickoff: req.body?.kickoff || null,
    });
    audit(req, "match.create", { matchId: id });
    touched(req, res, "matches", { matchId: id });
  }),
);

/**
 * Generate the fixture list.
 *
 * Replaces a hardcoded seven-match array that only ever described one
 * tournament. Refuses once anything has been played, because regenerating
 * fixtures under a played match would orphan its result.
 */
tournamentRoutes.post(
  "/:tid/matches/generate",
  requireTournament("admin"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const played = D.matchesList(data).filter((m) => m.status !== "scheduled");
    if (played.length) {
      throw badRequest(
        `${played.length} match${played.length === 1 ? " has" : "es have"} already started. Clear the scores before regenerating fixtures.`,
      );
    }

    const teamIds = D.teamsList(data).map((t) => t.id);
    if (teamIds.length < 2) throw badRequest("Add at least two teams first.");

    for (const m of D.matchesList(data)) deleteMatch(m.id);

    const fixtures = D.roundRobin(teamIds);
    for (const f of fixtures) {
      createMatch(req.tournament.id, { no: f.no, homeId: f.homeId, awayId: f.awayId });
    }

    // A league finishes with a final between the top two. A friendly does not.
    const wantsFinal = req.body?.withFinal ?? data.format === "league";
    if (wantsFinal) {
      createMatch(req.tournament.id, { no: fixtures.length + 1, isFinal: true });
    }

    audit(req, "match.generate", { fixtures: fixtures.length, withFinal: Boolean(wantsFinal) });
    touched(req, res, "matches");
  }),
);

/**
 * Score and status. A referee may do this — it is the match-day job.
 *
 * The scoreline is typed directly rather than derived from the log, because
 * during a sixteen-minute match getting the number right matters more than
 * remembering who scored. The mismatch warning catches the difference later.
 */
tournamentRoutes.patch(
  "/:tid/matches/:matchId",
  requireTournament("referee"),
  route(async (req, res) => {
    const match = getMatch(req.params.matchId);
    if (!match || match.tournament_id !== req.tournament.id) throw notFoundError("No such match.");

    const patch = {};
    for (const key of ["homeScore", "awayScore"]) {
      if (req.body?.[key] !== undefined) {
        const value = req.body[key];
        patch[key] = value === null ? null : Number(value);
        if (patch[key] !== null && (!Number.isInteger(patch[key]) || patch[key] < 0)) {
          throw badRequest("A score must be a whole number, zero or more.");
        }
      }
    }
    if (req.body?.status !== undefined) {
      if (!["scheduled", "live", "ft"].includes(req.body.status)) throw badRequest("Unknown status.");
      patch.status = req.body.status;
    }
    if (req.body?.clock !== undefined) patch.clock = req.body.clock;

    // Fixtures and kick-off times are setup, not match day.
    for (const key of ["homeId", "awayId", "kickoff", "no"]) {
      if (req.body?.[key] !== undefined) {
        if (req.tournamentRole === "referee") {
          throw forbidden("Referees can record scores. Changing the fixture itself is an admin job.");
        }
        patch[key] = req.body[key];
      }
    }

    updateMatch(match.id, patch);
    audit(req, "match.update", { matchId: match.id, ...patch });
    touched(req, res, "matches", { matchId: match.id });
  }),
);

tournamentRoutes.post(
  "/:tid/matches/:matchId/clear",
  requireTournament("admin"),
  route(async (req, res) => {
    const match = getMatch(req.params.matchId);
    if (!match || match.tournament_id !== req.tournament.id) throw notFoundError("No such match.");

    clearMatch(match.id);
    audit(req, "match.clear", { matchId: match.id });
    touched(req, res, "matches", { matchId: match.id });
  }),
);

tournamentRoutes.delete(
  "/:tid/matches/:matchId",
  requireTournament("admin"),
  route(async (req, res) => {
    const match = getMatch(req.params.matchId);
    if (!match || match.tournament_id !== req.tournament.id) throw notFoundError("No such match.");

    deleteMatch(match.id);
    audit(req, "match.delete", { matchId: match.id });
    touched(req, res, "matches");
  }),
);

tournamentRoutes.post(
  "/:tid/scores/clear",
  requireTournament("super"),
  route(async (req, res) => {
    clearAllScores(req.tournament.id);
    audit(req, "scores.clear_all", {});
    touched(req, res, "matches");
  }),
);

/* ----------------------------------------------------------------- events */

tournamentRoutes.post(
  "/:tid/matches/:matchId/events",
  requireTournament("referee"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const match = data.matches[req.params.matchId];
    if (!match) throw notFoundError("No such match.");

    const type = String(req.body?.type ?? "");
    if (!D.EVENT_TYPES.includes(type)) throw badRequest(`Unknown event type "${type}".`);

    const teamId = req.body?.teamId || null;
    if (teamId && !data.teams[teamId]) throw badRequest("Unknown team.");

    const playerId = req.body?.playerId || null;
    if (playerId && !data.players[playerId]) throw badRequest("Unknown player.");

    const assistId = req.body?.assistId || null;
    if (assistId && !data.players[assistId]) throw badRequest("Unknown player for the assist.");
    if (assistId && assistId === playerId) throw badRequest("A player cannot assist their own goal.");

    const event = {
      type,
      teamId,
      playerId,
      assistId,
      zone: req.body?.zone ?? null,
      penalty: Boolean(req.body?.penalty) || req.body?.zone === "pk",
      critical: Boolean(req.body?.critical),
      ownGoal: Boolean(req.body?.ownGoal),
      clockLabel: req.body?.clockLabel ?? D.clockStamp(data, match),
      note: req.body?.note ?? null,
    };

    const id = addEvent(match.id, event);

    // A goal moves the scoreline with it, so the referee taps once rather than
    // logging a goal and then remembering to change the number.
    if (D.isGoalEvent(event) && req.body?.bumpScore !== false && teamId) {
      const home = match.homeId === teamId;
      updateMatch(match.id, {
        homeScore: Number(match.homeScore || 0) + (home ? 1 : 0),
        awayScore: Number(match.awayScore || 0) + (home ? 0 : 1),
        status: match.status === "scheduled" ? "live" : match.status,
      });
    }

    audit(req, "event.add", { matchId: match.id, type, player: data.players[playerId]?.name ?? null });

    const after = loadTournament(req.tournament.id);
    broadcast(req.tournament.id, "changed", { reason: "event", matchId: match.id, eventType: type });
    res.status(201).json({ tournament: after, eventId: id });
  }),
);

tournamentRoutes.patch(
  "/:tid/matches/:matchId/events/:eventId",
  requireTournament("referee"),
  route(async (req, res) => {
    const existing = getEvent(req.params.eventId);
    if (!existing || existing.match_id !== req.params.matchId) throw notFoundError("No such event.");

    updateEvent(req.params.eventId, req.body ?? {});
    audit(req, "event.update", { eventId: req.params.eventId, ...req.body });
    touched(req, res, "event", { matchId: req.params.matchId });
  }),
);

tournamentRoutes.delete(
  "/:tid/matches/:matchId/events/:eventId",
  requireTournament("referee"),
  route(async (req, res) => {
    const data = loadTournament(req.tournament.id);
    const match = data.matches[req.params.matchId];
    const event = match?.events?.[req.params.eventId];
    if (!event) throw notFoundError("No such event.");

    deleteEvent(req.params.eventId);

    // Removing a goal takes its point off the scoreline too, or the log and the
    // score immediately disagree and the mismatch warning fires on a correction.
    if (D.isGoalEvent(event) && event.teamId && req.body?.adjustScore !== false) {
      const home = match.homeId === event.teamId;
      updateMatch(match.id, {
        homeScore: Math.max(0, Number(match.homeScore || 0) - (home ? 1 : 0)),
        awayScore: Math.max(0, Number(match.awayScore || 0) - (home ? 0 : 1)),
      });
    }

    audit(req, "event.delete", { matchId: match.id, type: event.type });
    touched(req, res, "event", { matchId: match.id });
  }),
);

/* ---------------------------------------------------------------- archive */

tournamentRoutes.post(
  "/:tid/archive/recompute",
  requireTournament("super"),
  route(async (req, res) => {
    const row = recomputeArchive(req.tournament.id);
    audit(req, "archive.recompute", {});
    res.json({ archive: row });
  }),
);
