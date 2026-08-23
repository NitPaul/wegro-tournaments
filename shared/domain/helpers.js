/**
 * Accessors over a tournament document.
 *
 * The document the API hands out looks like this, and both the server and the
 * browser work on exactly this shape:
 *
 *   {
 *     id, slug, name, season, format, status,
 *     meta:     { venueName, kickoffISO, ... },
 *     settings: { budget, basePrice, points: {...}, ... },
 *     teams:    { [teamId]:   { id, slot, name, jerseyColor, ... } },
 *     players:  { [playerId]: { id, name, pos, teamId, price, kind } },
 *     matches:  { [matchId]:  { id, no, homeId, awayId, homeScore, awayScore,
 *                               status, isFinal, clock, events: { [id]: {...} } } }
 *   }
 *
 * Keyed objects rather than arrays, which is what the previous version used and
 * what every renderer already expects — so the UI ported across with almost no
 * changes. The server assembles this from normalised tables.
 */

import { DEFAULT_META, DEFAULT_POINTS, DEFAULT_SETTINGS, POSITIONS } from "./constants.js";

/** Escape before any innerHTML. Team and player names are user-supplied text. */
export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Normalise a keyed object (or an array) to an array carrying its key as `id`. */
export function toArray(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.filter(Boolean);
  return Object.entries(obj).map(([id, v]) => ({ ...v, id: v?.id ?? id }));
}

export const bdt = (n) => `${Number(n || 0)} BDT`;

/* --------------------------------------------------------------- settings */

export const getSettings = (data) => ({ ...DEFAULT_SETTINGS, ...(data?.settings || {}) });
export const getMeta = (data) => ({ ...DEFAULT_META, ...(data?.meta || {}) });
export const getPoints = (data) => ({ ...DEFAULT_POINTS, ...(data?.settings?.points || {}) });

export const isFriendly = (data) => data?.format === "friendly";

/* -------------------------------------------------------------- accessors */

export const teamsList = (data) =>
  toArray(data?.teams).sort(
    (a, b) => String(a.slot ?? "").localeCompare(String(b.slot ?? "")) || String(a.name).localeCompare(String(b.name)),
  );

export const playersList = (data) =>
  toArray(data?.players).sort(
    (a, b) =>
      POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos) ||
      String(a.name).localeCompare(String(b.name)),
  );

export const matchesList = (data) => toArray(data?.matches).sort((a, b) => a.no - b.no);

export const groupMatches = (data) => matchesList(data).filter((m) => !m.isFinal);
export const finalMatch = (data) => matchesList(data).find((m) => m.isFinal) || null;

export const teamById = (data, id) => (id ? data?.teams?.[id] || null : null);
export const playerById = (data, id) => (id ? data?.players?.[id] || null : null);
export const matchById = (data, id) => (id ? data?.matches?.[id] || null : null);

export const isPlayed = (m) => m?.status === "ft" && m?.homeScore != null && m?.awayScore != null;

/* ----------------------------------------------------------- player kinds */

export const isCaptain = (p) => p?.kind === "captain";
export const isGuest = (p) => p?.kind === "guest";
export const isAuctionPlayer = (p) => !p?.kind || p.kind === "auction";

/** Everyone attached to a team: bought players, the captain, and any guests. */
export const teamPlayers = (data, teamId) =>
  teamId ? playersList(data).filter((p) => p.teamId === teamId) : [];

/** The players the captain actually bid for. What the auction rules apply to. */
export const teamSquad = (data, teamId) => teamPlayers(data, teamId).filter(isAuctionPlayer);

export const teamGuests = (data, teamId) => teamPlayers(data, teamId).filter(isGuest);

/**
 * The team's permanent players — bought plus the captain, excluding guests.
 *
 * This is the group a clean sheet or a defensive record belongs to. A guest who
 * turned up for one match is not part of the squad's season, but a captain
 * absolutely is.
 */
export const teamRoster = (data, teamId) => teamPlayers(data, teamId).filter((p) => !isGuest(p));

export const teamCaptain = (data, teamId) =>
  teamPlayers(data, teamId).find(isCaptain) || null;

/** Display name for a team's captain, for the places that only need the text. */
export const captainName = (data, teamId) => teamCaptain(data, teamId)?.name || "";

/** The auction pool — everyone the captains bid on, sold or not. */
export const auctionPlayers = (data) => playersList(data).filter(isAuctionPlayer);

export const captains = (data) => playersList(data).filter(isCaptain);
export const guestPlayers = (data) => playersList(data).filter(isGuest);

/** Unsold pool players. */
export const unsoldPlayers = (data) => auctionPlayers(data).filter((p) => !p.teamId);

/**
 * The goalkeeper a clean sheet is credited to.
 *
 * Prefers a bought keeper, then the captain if they keep goal. Guests are never
 * credited — they are not part of the squad's record.
 */
export const teamKeeper = (data, teamId) => {
  const roster = teamRoster(data, teamId).filter((p) => p.pos === "GK");
  return roster.find(isAuctionPlayer) || roster.find(isCaptain) || null;
};
