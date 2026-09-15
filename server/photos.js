/**
 * Player photos, stored as files in DATA_DIR/photos.
 *
 * Not in the database, and never in git: they are employee headshots, the
 * repository is public, and a photo is data somebody uploads, not code. They
 * live in the same Docker volume as the database, so a deploy never touches
 * them, and `npm run backup` copies them alongside it.
 *
 * The browser does the resizing (a 512px square, usually WebP around 40 KB)
 * before anything is sent, which is why this file needs no image library and
 * why uploads stay far below nginx's default 1 MB body limit. What arrives is
 * still checked: the bytes must actually be an image, whatever the request
 * claims, and nothing supplied by the client ever becomes part of a path.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { env } from "./env.js";

export const PHOTO_DIR = path.join(env.dataDir, "photos");
export const PHOTO_URL = "/media/photos";
export const MAX_PHOTO_BYTES = 600 * 1024;

/** Every stored photo name looks like this, so a name from the database is safe to join to a path. */
const NAME_RE = /^[a-z]{2}_[0-9a-z]{8}-[0-9a-f]{12}\.(webp|jpg|png)$/;

/** Identify an image by its first bytes. Returns an extension, or null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export function ensurePhotoDir() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

/**
 * Store an image for a person and return its file name.
 * Throws with `code: "not_an_image"` if the bytes are not a JPEG, PNG or WebP.
 */
export function savePhoto(personId, buf) {
  const ext = sniffImage(buf);
  if (!ext) {
    const err = new Error("That file is not a JPEG, PNG or WebP image.");
    err.code = "not_an_image";
    throw err;
  }
  ensurePhotoDir();
  const name = `${personId}-${randomBytes(6).toString("hex")}.${ext}`;
  if (!NAME_RE.test(name)) throw new Error(`Unexpected person id "${personId}".`);

  // Write beside it, then rename: a reader never sees half a file.
  const final = path.join(PHOTO_DIR, name);
  const temp = `${final}.part`;
  fs.writeFileSync(temp, buf);
  fs.renameSync(temp, final);
  return name;
}

/** Delete a stored photo. Quietly does nothing for a missing file or a name that is not ours. */
export function removePhoto(name) {
  if (!name || !NAME_RE.test(name)) return;
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, name));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[photos] could not delete ${name}: ${err.message}`);
  }
}

/** The public URL for a stored photo name, or null. */
export const photoUrl = (name) => (name && NAME_RE.test(name) ? `${PHOTO_URL}/${name}` : null);

export const isPhotoName = (name) => NAME_RE.test(String(name ?? ""));
