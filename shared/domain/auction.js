/**
 * The auction: budgets, squad shape, and the rules that stop a captain
 * ruining their own team.
 *
 * The important thing in this file is `validateSale`. The per-team rules alone
 * are not enough, because the pool barely covers the squads: a purchase that is
 * perfectly legal for the team making it can leave a *different* team unable to
 * field a legal squad. The guards below catch that before the money moves,
 * which is the difference between a smooth auction and one that has to be
 * unwound in front of everybody.
 *
 * This now runs on the server as well as in the browser. Previously it ran only
 * in the browser, which meant the rules were advice — anyone with devtools
 * could write whatever they liked straight past them.
 */

import { POSITIONS } from "./constants.js";
import {
  auctionPlayers,
  bdt,
  getSettings,
  isAuctionPlayer,
  isGuest,
  playerById,
  playersList,
  teamById,
  teamGuests,
  teamSquad,
  teamsList,
} from "./helpers.js";
import { playerEventCount } from "./events.js";

/**
 * How many players this team is meant to buy.
 *
 * Normally the tournament-wide `squadSize`, but a team may carry its own
 * number. That is for when one squad legitimately ends up a player over or
 * under standard: its counter then reads against its own size (7/7) instead of
 * showing a permanent mismatch (7/6), while `extraPlayers` still records that
 * it is off-standard so the UI can flag it.
 */
export function squadSizeOf(team, settings) {
  const own = Number(team?.squadSize);
  return Number.isFinite(own) && own > 0 ? own : Number(settings.squadSize);
}

/** Total places across all squads. Not `teams × squadSize` once a team differs. */
export function squadCapacity(data) {
  const s = getSettings(data);
  return teamsList(data).reduce((n, t) => n + squadSizeOf(t, s), 0);
}

export function auctionState(data) {
  const s = getSettings(data);
  const out = {};

  for (const t of teamsList(data)) {
    const squad = teamSquad(data, t.id);
    const guests = teamGuests(data, t.id);
    const spentOnPlayers = squad.reduce((n, p) => n + Number(p.price || 0), 0);
    const jerseyCost = Number(t.jerseyCost || 0);
    const spent = spentOnPlayers + jerseyCost;
    const remaining = Number(s.budget) - spent;
    const size = squadSizeOf(t, s);
    const slotsLeft = size - squad.length;

    const counts = {};
    for (const pos of POSITIONS) counts[pos] = squad.filter((p) => p.pos === pos).length;

    // How many buys are still mandatory to end up with a legal squad.
    const stillRequired = POSITIONS.reduce(
      (n, pos) => n + Math.max(0, Number(s.minPerCategory) - counts[pos]),
      0,
    );

    out[t.id] = {
      team: t,
      squad,
      /** Guests carried on top of the squad — free, and outside every rule. */
      guests,
      counts,
      max: {
        GK: Number(s.maxGK),
        DEF: Number(s.maxPerCategory),
        MID: Number(s.maxPerCategory),
        FWD: Number(s.maxPerCategory),
      },
      squadSize: size,
      /**
       * Players held above the standard squad size — what the UI flags in red.
       * Measured against players held, not against the team's own size, so
       * raising a team's size before it has signed anyone does not flag a squad
       * that is still under-filled.
       */
      extraPlayers: Math.max(0, squad.length - Number(s.squadSize)),
      spent,
      spentOnPlayers,
      jerseyCost,
      remaining,
      slotsLeft,
      stillRequired,
      /** The most this team can bid right now and still complete a legal squad. */
      maxBid: Math.max(0, remaining - Math.max(0, slotsLeft - 1) * Number(s.basePrice)),
      complete: slotsLeft === 0,
    };
  }
  return out;
}

/** Every squad as it WOULD look after a hypothetical sale. */
function simulate(data, playerId, teamId) {
  const s = getSettings(data);
  const teams = teamsList(data);
  const counts = {};
  const bought = {};
  const pool = Object.fromEntries(POSITIONS.map((p) => [p, 0]));

  for (const t of teams) {
    counts[t.id] = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
    bought[t.id] = 0;
  }

  for (const p of auctionPlayers(data)) {
    const owner = p.id === playerId ? teamId : p.teamId;
    if (owner && counts[owner]) {
      counts[owner][p.pos]++;
      bought[owner]++;
    } else {
      pool[p.pos]++;
    }
  }
  return { s, teams, counts, bought, pool };
}

/**
 * Is the pool exactly the size of the squads?
 *
 * Only then can EVERY player be sold, which is what the absorption guard below
 * assumes. With a spare player in the pool somebody must go unsold by simple
 * arithmetic, and the guard would fire on a perfectly legal sale.
 */
function poolIsExact(data) {
  return auctionPlayers(data).length === squadCapacity(data);
}

/**
 * Tournament-wide feasibility for a hypothetical sale.
 *
 * Example of what this catches: six defenders exist and every team needs at
 * least one. The moment three teams own two defenders each, the fourth can
 * never field a legal squad — and nothing about that fourth team's own budget
 * or slots would have told you.
 */
function validateGlobalShape(data, playerId, teamId) {
  const { s, teams, counts, bought, pool } = simulate(data, playerId, teamId);
  const min = Number(s.minPerCategory);
  const caps = {
    GK: Number(s.maxGK),
    DEF: Number(s.maxPerCategory),
    MID: Number(s.maxPerCategory),
    FWD: Number(s.maxPerCategory),
  };
  const everyoneMustSell = poolIsExact(data);

  for (const pos of POSITIONS) {
    const slotsOf = (t) => squadSizeOf(t, s) - bought[t.id];

    // Scarcity: enough of this position left for every team that still needs one.
    const needing = teams.filter((t) => counts[t.id][pos] < min && slotsOf(t) > 0);
    if (pool[pos] < needing.length) {
      const names = needing.map((t) => t.name).join(", ");
      return {
        ok: false,
        error: `Only ${pool[pos]} ${pos} would be left but ${needing.length} ${
          needing.length === 1 ? "team still needs" : "teams still need"
        } one (${names}). Every squad must have at least ${min} ${pos}.`,
      };
    }

    // Absorption: enough room for every remaining player of this position to
    // find a home. Only meaningful when the pool and the squads are the same
    // size — see poolIsExact.
    if (!everyoneMustSell) continue;
    const room = teams.reduce(
      (n, t) => n + Math.min(Math.max(0, caps[pos] - counts[t.id][pos]), Math.max(0, slotsOf(t))),
      0,
    );
    if (room < pool[pos]) {
      return {
        ok: false,
        error: `${pool[pos]} ${pos} would still need buyers but only ${room} ${pos} slot${
          room === 1 ? "" : "s"
        } remain across all teams. Some players would go unsold.`,
      };
    }
  }
  return { ok: true, error: null };
}

/**
 * Which position mixes are still possible, given what has been bought so far.
 * Drives the "shapes still available" hint in the auction console.
 */
export function shapeAdvice(data) {
  const { s, teams, counts, bought, pool } = simulate(data, null, null);
  const min = Number(s.minPerCategory);
  const out = {};
  for (const pos of POSITIONS) {
    const needing = teams.filter(
      (t) => counts[t.id][pos] < min && squadSizeOf(t, s) - bought[t.id] > 0,
    );
    out[pos] = { left: pool[pos], teamsNeeding: needing.length, tight: pool[pos] <= needing.length };
  }
  return out;
}

/** Can this team buy this player at this price? Returns `{ ok, error }`. */
export function validateSale(data, playerId, teamId, price) {
  const s = getSettings(data);
  const player = playerById(data, playerId);
  const team = teamById(data, teamId);
  const st = auctionState(data)[teamId];

  if (!player) return { ok: false, error: "Unknown player." };
  if (!isAuctionPlayer(player)) {
    return {
      ok: false,
      error: isGuest(player)
        ? `${player.name} is a guest — place them from the Guest players panel, not through bidding.`
        : `${player.name} is a captain and is not in the auction.`,
    };
  }
  if (!team || !st) return { ok: false, error: "Pick a team." };
  if (player.teamId) {
    return {
      ok: false,
      error: `${player.name} is already sold to ${teamById(data, player.teamId)?.name || "a team"}.`,
    };
  }
  if (s.auctionOpen === false) return { ok: false, error: "The auction is closed." };

  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return { ok: false, error: "Enter a valid price." };
  if (p < Number(s.basePrice)) {
    return { ok: false, error: `Below base price — minimum is ${bdt(s.basePrice)}.` };
  }

  if (st.slotsLeft <= 0) {
    return { ok: false, error: `${team.name} already has a full squad of ${st.squadSize}.` };
  }

  const cap = st.max[player.pos];
  if (st.counts[player.pos] >= cap) {
    return {
      ok: false,
      error: `${team.name} already has ${st.counts[player.pos]} ${player.pos} — the limit is ${cap}.`,
    };
  }

  if (p > st.remaining) {
    return { ok: false, error: `${team.name} only has ${bdt(st.remaining)} left.` };
  }

  // Money guard: enough left to fill every remaining slot at base price.
  const after = st.remaining - p;
  const slotsAfter = st.slotsLeft - 1;
  const floor = slotsAfter * Number(s.basePrice);
  if (after < floor) {
    return {
      ok: false,
      error: `Too expensive — ${team.name} still needs ${slotsAfter} more player${
        slotsAfter === 1 ? "" : "s"
      } (${bdt(floor)} minimum). Max bid is ${bdt(st.maxBid)}.`,
    };
  }

  // Squad-shape guard: enough slots left for every category still required.
  const countsAfter = { ...st.counts, [player.pos]: st.counts[player.pos] + 1 };
  const requiredAfter = POSITIONS.reduce(
    (n, pos) => n + Math.max(0, Number(s.minPerCategory) - countsAfter[pos]),
    0,
  );
  if (requiredAfter > slotsAfter) {
    const missing = POSITIONS.filter((pos) => countsAfter[pos] < Number(s.minPerCategory));
    return {
      ok: false,
      error: `${team.name} would have no slot left for ${missing.join(", ")} — every team needs at least ${s.minPerCategory} per position.`,
    };
  }

  return validateGlobalShape(data, playerId, teamId);
}

/**
 * Can this guest be placed with this team?
 *
 * Deliberately almost no rules: a guest is free and outside the squad limits,
 * so the only things that can go wrong are a bad id and a team that does not
 * exist. Passing `null` as the team means "take them back off the pitch".
 */
export function validateGuestPlacement(data, playerId, teamId) {
  const player = playerById(data, playerId);
  if (!player) return { ok: false, error: "Unknown player." };
  if (!isGuest(player)) {
    return {
      ok: false,
      error: `${player.name} is not a guest — ${isAuctionPlayer(player) ? "sell them instead" : "captains belong to their own team"}.`,
    };
  }
  if (teamId && !teamById(data, teamId)) return { ok: false, error: "Pick a team." };
  return { ok: true, error: null };
}

/**
 * Can a new player be added under this name?
 *
 * The duplicate-name check is the one that matters on the day: the referee
 * picks a scorer from a list of names, so two players called "Rahim" on the
 * same pitch means goals landing on whichever one happens to sort first.
 */
export function validateNewPlayer(data, { name, pos, teamId, kind = "guest", ignoreId = null }) {
  const nm = String(name || "").trim();
  if (!nm) return { ok: false, error: "A player needs a name." };
  if (nm.length > 40) return { ok: false, error: "That name is too long — 40 characters at most." };
  if (!POSITIONS.includes(pos)) return { ok: false, error: "Pick a position." };
  if (teamId && !teamById(data, teamId)) return { ok: false, error: "Pick a team." };
  if (kind === "captain" && !teamId) return { ok: false, error: "A captain needs a team." };

  const clash = playersList(data).find(
    (p) => p.id !== ignoreId && String(p.name || "").trim().toLowerCase() === nm.toLowerCase(),
  );
  if (clash) {
    return {
      ok: false,
      error: `There is already a player called ${clash.name}. Add a surname or an initial so the referee can tell them apart.`,
    };
  }

  if (kind === "captain" && teamId) {
    const existing = playersList(data).find(
      (p) => p.kind === "captain" && p.teamId === teamId && p.id !== ignoreId,
    );
    if (existing) {
      return {
        ok: false,
        error: `${teamById(data, teamId)?.name} already has a captain (${existing.name}). Remove them first.`,
      };
    }
  }

  return { ok: true, error: null };
}

/**
 * Can this player be deleted outright?
 *
 * Blocked once they appear in the match log, because deleting them would leave
 * those events pointing at nobody — a goal on the scoreboard with no scorer.
 * Take them off the team instead; that keeps the history intact.
 */
export function validateRemovePlayer(data, playerId) {
  const player = playerById(data, playerId);
  if (!player) return { ok: false, error: "Unknown player." };
  if (isAuctionPlayer(player) && player.teamId) {
    return { ok: false, error: `${player.name} is sold — unsell them first.` };
  }

  const n = playerEventCount(data, playerId);
  if (n) {
    return {
      ok: false,
      error: `${player.name} is in the match log (${n} event${
        n === 1 ? "" : "s"
      }). Take them off the team instead — deleting them would leave those events with no player.`,
    };
  }
  return { ok: true, error: null };
}

/** Auction progress across all teams. */
export function auctionProgress(data) {
  const players = auctionPlayers(data);
  const sold = players.filter((p) => p.teamId);
  return {
    sold: sold.length,
    total: players.length,
    spend: sold.reduce((n, p) => n + Number(p.price || 0), 0),
    done: players.length > 0 && sold.length === players.length,
  };
}
