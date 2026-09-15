/**
 * The player roster — people, their photos and ratings.
 *
 * Reading is public: the player list is part of the public site, like the
 * scoreboard. The admin's note on a rating is only returned to the super admin.
 *
 * Writing follows the one-tournament rule:
 *
 *  - The super admin can do anything here.
 *  - A tournament admin (of a tournament that is not finished) can add a
 *    newcomer to the roster while building their squad, and give a photo to
 *    someone they added or someone in their own tournament. They cannot rate
 *    people, rename them or delete them — the roster is shared by every
 *    tournament, and those decisions belong to the super admin.
 *  - A referee cannot change the roster at all.
 */

import express from "express";

import { audit } from "../audit.js";
import { POSITIONS } from "../../shared/domain/constants.js";
import { requireAuth } from "../auth/middleware.js";
import { badRequest, forbidden, notFoundError, route, HttpError } from "../http/errors.js";
import { assignmentOf } from "../db/repo/tournaments.js";
import { createPerson, deletePerson, getPerson, personInTournament, updatePerson } from "../db/repo/people.js";
import { MAX_PHOTO_BYTES, removePhoto, savePhoto } from "../photos.js";
import { invalidateRoster, rosterList, rosterPerson } from "../roster.js";
import { broadcast } from "../stream/sse.js";

export const peopleRoutes = express.Router();

/** Tell every open page the roster moved, and drop the cached careers. */
function changed(reason, personId) {
  invalidateRoster();
  broadcast("people", "changed", { reason, personId });
}

/** The tournament a non-super account may add people for, or null. */
function manageableTournament(user) {
  if (!user || user.isSuper) return null;
  const t = assignmentOf(user.id);
  return t && t.role === "admin" && t.status !== "completed" ? t : null;
}

function cleanName(raw) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw badRequest("Enter the player's name.");
  if (name.length > 60) throw badRequest("That name is too long — 60 characters at most.");
  return name;
}

function cleanPos(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const pos = String(raw).toUpperCase();
  if (!POSITIONS.includes(pos)) throw badRequest(`Position must be one of ${POSITIONS.join(", ")}.`);
  return pos;
}

function cleanRating(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw badRequest("A rating is a whole number from 1 to 99.");
  return n;
}

/* ------------------------------------------------------------------- read */

peopleRoutes.get(
  "/",
  route(async (req, res) => {
    res.json({ people: rosterList({ isSuper: Boolean(req.user?.isSuper) }) });
  }),
);

peopleRoutes.get(
  "/:id",
  route(async (req, res) => {
    const person = rosterPerson(req.params.id, { isSuper: Boolean(req.user?.isSuper) });
    if (!person) throw notFoundError("No such player.");
    res.json({ person });
  }),
);

/* ------------------------------------------------------------------ write */

peopleRoutes.post(
  "/",
  requireAuth,
  route(async (req, res) => {
    const own = manageableTournament(req.user);
    if (!req.user.isSuper && !own) {
      throw forbidden("Only the super admin, or the admin of a tournament that is still running, can add players.");
    }

    const name = cleanName(req.body?.name);
    const pos = cleanPos(req.body?.pos) ?? null;
    // A tournament admin adds newcomers; rating them is the super admin's call.
    const rating = req.user.isSuper ? cleanRating(req.body?.rating) ?? null : null;
    const ratingNote = req.user.isSuper ? String(req.body?.ratingNote ?? "").slice(0, 280) : "";

    const person = createPerson({ name, pos, rating, ratingNote, createdBy: req.user.id });
    audit(req, "person.create", { name, pos }, own?.id ?? null);
    changed("person.create", person.id);
    res.status(201).json({ person: rosterPerson(person.id, { isSuper: req.user.isSuper }) });
  }),
);

peopleRoutes.patch(
  "/:id",
  requireAuth,
  route(async (req, res) => {
    if (!req.user.isSuper) throw forbidden("Only the super admin can edit or rate players on the roster.");
    const person = getPerson(req.params.id);
    if (!person) throw notFoundError("No such player.");

    const patch = {
      name: req.body?.name === undefined ? undefined : cleanName(req.body.name),
      pos: cleanPos(req.body?.pos),
      rating: cleanRating(req.body?.rating),
      ratingNote: req.body?.ratingNote === undefined ? undefined : String(req.body.ratingNote ?? "").slice(0, 280),
      active: req.body?.active === undefined ? undefined : Boolean(req.body.active),
    };
    updatePerson(person.id, patch);

    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    audit(req, "person.update", { name: person.name, ...changes });
    changed("person.update", person.id);
    res.json({ person: rosterPerson(person.id, { isSuper: true }) });
  }),
);

peopleRoutes.delete(
  "/:id",
  requireAuth,
  route(async (req, res) => {
    if (!req.user.isSuper) throw forbidden("Only the super admin can remove players from the roster.");
    const person = getPerson(req.params.id);
    if (!person) throw notFoundError("No such player.");

    deletePerson(person.id);
    removePhoto(person.photo);
    audit(req, "person.delete", { name: person.name });
    changed("person.delete", person.id);
    res.json({ ok: true });
  }),
);

/* ----------------------------------------------------------------- photos */

/** May this account change this person's photo? */
function canEditPhoto(user, person) {
  if (user.isSuper) return true;
  const own = manageableTournament(user);
  if (!own) return false;
  return person.createdBy === user.id || personInTournament(person.id, own.id);
}

/**
 * The raw body parser, with its errors turned into sentences. The browser
 * resizes photos to about 40 KB, so hitting the limit means something skipped
 * that step — say so rather than "request entity too large".
 */
const rawImage = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_PHOTO_BYTES })(req, res, (err) => {
    if (!err) return next();
    if (err.type === "entity.too.large") {
      return next(new HttpError(413, "too_large", "That photo is too large. Upload it through the admin console, which shrinks it first."));
    }
    next(badRequest("That upload could not be read."));
  });

peopleRoutes.put(
  "/:id/photo",
  requireAuth,
  rawImage,
  route(async (req, res) => {
    const person = getPerson(req.params.id);
    if (!person) throw notFoundError("No such player.");
    if (!canEditPhoto(req.user, person)) {
      throw forbidden("You can only change photos of players in your own tournament.");
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("No photo was sent.");

    let name;
    try {
      name = savePhoto(person.id, req.body);
    } catch (err) {
      if (err.code === "not_an_image") throw badRequest(err.message);
      throw err;
    }

    updatePerson(person.id, { photo: name });
    removePhoto(person.photo); // only after the new one is safely in place
    audit(req, "person.photo", { name: person.name, bytes: req.body.length });
    changed("person.photo", person.id);
    res.json({ person: rosterPerson(person.id, { isSuper: req.user.isSuper }) });
  }),
);

peopleRoutes.delete(
  "/:id/photo",
  requireAuth,
  route(async (req, res) => {
    const person = getPerson(req.params.id);
    if (!person) throw notFoundError("No such player.");
    if (!canEditPhoto(req.user, person)) {
      throw forbidden("You can only change photos of players in your own tournament.");
    }

    updatePerson(person.id, { photo: null });
    removePhoto(person.photo);
    audit(req, "person.photo_remove", { name: person.name });
    changed("person.photo", person.id);
    res.json({ person: rosterPerson(person.id, { isSuper: req.user.isSuper }) });
  }),
);
