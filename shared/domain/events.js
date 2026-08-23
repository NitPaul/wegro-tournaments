/**
 * The match log — goals, actions, fouls and cards.
 *
 * One field-naming decision worth knowing about: every event credits exactly
 * one player through `playerId`, whether that is a scorer, a keeper who made a
 * save or a player who was booked. The previous version used `scorerId` for
 * goals and `playerId` for everything else, which meant two code paths for the
 * same question and was half the reason captain goals went missing. Goals also
 * carry `assistId`.
 */

import { DISCIPLINE_TYPES, isGoalEvent } from "./constants.js";
import { getSettings, matchesList, playerById, toArray } from "./helpers.js";
import { matchSides } from "./standings.js";

/** Every event across the tournament, flattened and tagged with its match. */
export function allEvents(data) {
  const out = [];
  for (const m of matchesList(data)) {
    for (const e of toArray(m.events)) out.push({ ...e, matchId: m.id, matchNo: m.no });
  }
  return out;
}

export const matchEvents = (m) => toArray(m?.events);

/** Just the goals from a match log, in the order they were scored. */
export const goalEvents = (m) => matchEvents(m).filter(isGoalEvent);

/**
 * Goals logged for each side of a match.
 *
 * Only goal events count. The log also carries saves, clearances and cards, and
 * counting those here would make every match look as though the scoreline were
 * wrong.
 */
export function loggedGoals(data, match) {
  const { home, away } = matchSides(data, match);
  const evs = matchEvents(match).filter(isGoalEvent);
  const count = (teamId) => (teamId ? evs.filter((e) => e.teamId === teamId).length : 0);
  return { home: count(home?.id), away: count(away?.id) };
}

/** Does the logged scorer list add up to the scoreline? */
export function eventTally(data, match) {
  if (!match || (match.status !== "ft" && match.status !== "live")) return null;
  const logged = loggedGoals(data, match);
  const hs = Number(match.homeScore || 0);
  const as = Number(match.awayScore || 0);
  return {
    ...logged,
    homeScore: hs,
    awayScore: as,
    matches: logged.home === hs && logged.away === as,
  };
}

/** How many logged events name this player, in any role. */
export const playerEventCount = (data, playerId) =>
  playerId
    ? allEvents(data).filter((ev) => ev.playerId === playerId || ev.assistId === playerId).length
    : 0;

/* ------------------------------------------------------------- discipline */

/** Fouls, yellows and reds for one team in one match. */
export function disciplineTally(data, match, teamId) {
  const out = { foul: 0, yellow: 0, red: 0 };
  if (!teamId) return out;
  for (const ev of matchEvents(match)) {
    if (ev.teamId === teamId && DISCIPLINE_TYPES.includes(ev.type)) out[ev.type]++;
  }
  return out;
}

/** Every card a player has picked up in one match. */
export function cardsInMatch(match, playerId) {
  const out = { yellow: 0, red: 0 };
  if (!playerId) return out;
  for (const ev of matchEvents(match)) {
    if (ev.playerId !== playerId) continue;
    if (ev.type === "yellow") out.yellow++;
    if (ev.type === "red") out.red++;
  }
  return out;
}

/**
 * Is this player already off in this match?
 *
 * Either a straight red, or a second yellow — which in football is a sending
 * off, and is treated as one here even though nothing creates the red card
 * automatically. The console warns; the referee decides. Automatically
 * inventing an event the referee did not log would put a card in the record
 * that nobody on the pitch actually showed.
 */
export function isSentOff(match, playerId) {
  const cards = cardsInMatch(match, playerId);
  if (cards.red > 0) return { off: true, reason: "red" };
  if (cards.yellow >= 2) return { off: true, reason: "two-yellows" };
  return { off: false, reason: null };
}

/**
 * Would this card send the player off?
 *
 * Used to warn the referee at the moment they tap a second yellow, which is the
 * only moment the warning is any use.
 */
export function cardWouldSendOff(match, playerId, type) {
  if (type === "red") return true;
  if (type !== "yellow") return false;
  return cardsInMatch(match, playerId).yellow >= 1;
}

/** Every sending off in the tournament, in match order. */
export function sendingsOff(data) {
  const out = [];
  for (const m of matchesList(data)) {
    const seen = new Set();
    for (const ev of matchEvents(m)) {
      if (!ev.playerId || seen.has(ev.playerId)) continue;
      const { off, reason } = isSentOff(m, ev.playerId);
      if (!off) continue;
      seen.add(ev.playerId);
      out.push({ playerId: ev.playerId, player: playerById(data, ev.playerId), matchId: m.id, matchNo: m.no, reason });
    }
  }
  return out.sort((a, b) => a.matchNo - b.matchNo);
}

/**
 * Who is suspended for a given match, and why.
 *
 * A sending off costs the player the next `redCardSuspensionMatches` matches
 * their team plays. Counted in their own team's fixtures rather than in
 * tournament match numbers, so a player is not quietly let off because their
 * team happened not to be playing next.
 *
 * This is advisory everywhere it is used. It never blocks a selection.
 */
export function suspendedFor(data, matchId) {
  const settings = getSettings(data);
  const ban = Math.max(0, Number(settings.redCardSuspensionMatches) || 0);
  const out = new Map();
  if (!ban || !matchId) return out;

  const matches = matchesList(data);
  const target = matches.find((m) => m.id === matchId);
  if (!target) return out;

  for (const sending of sendingsOff(data)) {
    const player = sending.player;
    if (!player?.teamId) continue;

    // The matches this player's team plays after the sending off, in order.
    const teamFixtures = matches.filter(
      (m) => (m.homeId === player.teamId || m.awayId === player.teamId) && m.no > sending.matchNo,
    );
    const banned = teamFixtures.slice(0, ban);
    if (banned.some((m) => m.id === matchId)) {
      out.set(sending.playerId, {
        player,
        reason: sending.reason,
        fromMatchNo: sending.matchNo,
        matchesRemaining: banned.length - banned.findIndex((m) => m.id === matchId),
      });
    }
  }
  return out;
}
