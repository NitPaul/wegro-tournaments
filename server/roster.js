/**
 * The roster with careers and ratings attached — what the player list shows.
 *
 * Worked out from every published tournament each time something changes, and
 * kept in memory until the next change. That is cheap at this size (the whole
 * 2026 tournament is a few kilobytes) and it means a goal logged on match day
 * shows up in that player's career without anything being stored twice.
 * Hidden (draft) tournaments are left out, as they are everywhere public.
 */

import { buildCareers, CAREER_FIELDS, GAME_FIELDS } from "../shared/domain/career.js";
import { gameHeadlineRating, gameStatsRating, headlineRating, ratingBand, statsRating } from "../shared/domain/rating.js";
import { listArchive } from "./db/repo/archive.js";
import { listPeople } from "./db/repo/people.js";
import { listTournaments, loadTournament } from "./db/repo/tournaments.js";
import { photoUrl } from "./photos.js";
import { onBroadcast } from "./stream/sse.js";

let cache = null;

/** Forget the cached roster. Called on every change anywhere. */
export function invalidateRoster() {
  cache = null;
}
onBroadcast(invalidateRoster);

function compute() {
  const tournaments = listTournaments()
    .filter((t) => t.status !== "draft")
    .map((t) => loadTournament(t.id));
  const careers = buildCareers(tournaments, listArchive());

  const emptyGame = { totals: Object.fromEntries(GAME_FIELDS.map((f) => [f, 0])), tournaments: [], titles: 0, finals: 0 };
  const empty = {
    totals: Object.fromEntries([["matches", 0], ...CAREER_FIELDS.map((f) => [f, 0])]),
    tournaments: [],
    medals: [],
    titles: 0,
    game: emptyGame,
  };

  const people = listPeople().map((p) => {
    const career = careers.get(p.id) ?? empty;
    const headline = headlineRating(p, career.totals);
    const game = career.game ?? emptyGame;
    const gameHeadline = gameHeadlineRating(p, game.totals);
    return {
      id: p.id,
      name: p.name,
      pos: p.pos ?? career.tournaments[0]?.pos ?? null,
      photoUrl: photoUrl(p.photo),
      active: p.active,
      rating: p.rating,
      ratingNote: p.ratingNote,
      statsRating: statsRating(career.totals),
      headline: { ...headline, band: ratingBand(headline.value) },
      totals: career.totals,
      titles: career.titles,
      medals: career.medals,
      tournaments: career.tournaments,
      createdBy: p.createdBy,
      // The console half of a person: who they are in the game, how they have
      // done there, and a rating of their own. Kept apart from the pitch record
      // on purpose — they measure different things.
      game: {
        gamerTag: p.gamerTag,
        platform: p.platform,
        favClub: p.favClub,
        rating: p.gameRating,
        ratingNote: p.gameRatingNote,
        statsRating: gameStatsRating(game.totals),
        headline: { ...gameHeadline, band: ratingBand(gameHeadline.value) },
        totals: game.totals,
        titles: game.titles,
        finals: game.finals,
        tournaments: game.tournaments,
      },
    };
  });

  // The headline numbers on the landing page, from the same pass.
  const totals = {
    tournaments: tournaments.length,
    matches: tournaments.reduce((n, d) => n + Object.values(d.matches).filter((m) => m.status === "ft").length, 0),
    goals: tournaments.reduce(
      (n, d) => n + Object.values(d.matches).reduce((g, m) => g + Number(m.homeScore ?? 0) + Number(m.awayScore ?? 0), 0),
      0,
    ),
    players: people.length,
  };

  return { people, byId: new Map(people.map((p) => [p.id, p])), totals };
}

function roster() {
  if (!cache) cache = compute();
  return cache;
}

/**
 * The public shape. The admin's note on a rating is private to the super
 * admin; `createdBy` is internal.
 */
function publicPerson(p, { withNote, withTournaments }) {
  const { ratingNote, createdBy, tournaments, game, ...rest } = p;
  const { ratingNote: gameNote, tournaments: gameTournaments, ...gameRest } = game;
  return {
    ...rest,
    ...(withNote ? { ratingNote } : {}),
    tournamentCount: tournaments.length,
    lastTournament: tournaments[0] ? { name: tournaments[0].name, season: tournaments[0].season, team: tournaments[0].team } : null,
    ...(withTournaments ? { tournaments } : {}),
    game: {
      ...gameRest,
      ...(withNote ? { ratingNote: gameNote } : {}),
      tournamentCount: gameTournaments.length,
      ...(withTournaments ? { tournaments: gameTournaments } : {}),
    },
  };
}

/** Tournaments, matches played, goals and players, for the landing page. */
export function siteTotals() {
  return roster().totals;
}

export function rosterList({ isSuper = false } = {}) {
  return roster().people.map((p) => publicPerson(p, { withNote: isSuper, withTournaments: false }));
}

export function rosterPerson(id, { isSuper = false } = {}) {
  const p = roster().byId.get(id);
  return p ? publicPerson(p, { withNote: isSuper, withTournaments: true }) : null;
}
