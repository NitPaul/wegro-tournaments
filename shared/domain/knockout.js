/**
 * Knockout rounds: the semi-finals and the final.
 *
 * Two rules live here.
 *
 * A knockout match cannot end level, so when the scores are equal the penalty
 * shoot-out decides it. Until that shoot-out is recorded the match has no
 * winner — the site says the result is not settled rather than inventing one.
 *
 * Who plays whom is the organiser's decision, never the site's. `seedKnockout`
 * works out the usual pairing from the group tables — A1 v B2, B1 v A2 — but it
 * only ever suggests: nothing is saved until somebody chooses it.
 */

import { groupLabels, groupMatches, isPlayed, matchesList, teamById } from "./helpers.js";
import { groupTables, matchSides } from "./standings.js";

/** 'group', 'semi' or 'final'. Matches saved before stages existed say so with `isFinal`. */
export function stageOf(match) {
  if (!match) return "group";
  if (match.stage) return match.stage;
  return match.isFinal ? "final" : "group";
}

export const isKnockout = (match) => stageOf(match) !== "group";

/** The knockout matches in the order they are played: semi-finals, then the final. */
export const knockoutMatches = (data) =>
  matchesList(data)
    .filter(isKnockout)
    .sort((a, b) => (stageOf(a) === stageOf(b) ? a.no - b.no : stageOf(a) === "semi" ? -1 : 1));

/**
 * Who won, and how.
 *
 * @returns {{ winnerId: string|null, loserId: string|null, onPenalties: boolean, level: boolean }}
 *          `winnerId` is null for a draw that still counts as a draw (a group
 *          match), and for a knockout still waiting on its shoot-out.
 */
export function matchWinner(data, match) {
  const none = { winnerId: null, loserId: null, onPenalties: false, level: false };
  if (!isPlayed(match)) return none;

  // A football final stores no teams — its two sides come from the table. Ask
  // for them when they are not on the match itself.
  const sides = !match.homeId && data ? matchSides(data, match) : null;
  const home = match.homeId ?? sides?.home?.id ?? null;
  const away = match.awayId ?? sides?.away?.id ?? null;
  const hs = Number(match.homeScore);
  const as = Number(match.awayScore);

  if (hs !== as) {
    return { winnerId: hs > as ? home : away, loserId: hs > as ? away : home, onPenalties: false, level: false };
  }
  if (!isKnockout(match)) return { ...none, level: true };

  const hp = Number(match.homePens);
  const ap = Number(match.awayPens);
  if (!Number.isFinite(hp) || !Number.isFinite(ap) || hp === ap) return { ...none, level: true };

  return { winnerId: hp > ap ? home : away, loserId: hp > ap ? away : home, onPenalties: true, level: true };
}

/** "3–1", or "2–2 (4–3 on pens)". Empty until the match has been played. */
export function scoreLine(match) {
  if (!isPlayed(match)) return "";
  const line = `${match.homeScore}–${match.awayScore}`;
  const { onPenalties } = matchWinner(null, match);
  return onPenalties ? `${line} (${match.homePens}–${match.awayPens} on pens)` : line;
}

/** A knockout match that was drawn and has no shoot-out recorded yet. */
export const needsPenalties = (match) => {
  const { level, winnerId } = matchWinner(null, match);
  return isKnockout(match) && isPlayed(match) && level && !winnerId;
};

/**
 * The usual pairing for the semi-finals, from the group tables: the winner of
 * each group against the runner-up of the other. With one group it pairs the
 * top four: 1 v 4 and 2 v 3.
 *
 * Returns `[{ homeId, awayId, homeLabel, awayLabel }]` — a suggestion to show,
 * never a saved fixture.
 */
export function seedKnockout(data) {
  const tables = groupTables(data);
  const labels = groupLabels(data);

  if (labels.length >= 2) {
    const [a, b] = tables;
    return [
      pair(a.table[0], b.table[1], `${a.group}1`, `${b.group}2`),
      pair(b.table[0], a.table[1], `${b.group}1`, `${a.group}2`),
    ].filter(Boolean);
  }

  const table = tables[0]?.table ?? [];
  if (table.length < 4) return [];
  return [pair(table[0], table[3], "1st", "4th"), pair(table[1], table[2], "2nd", "3rd")].filter(Boolean);
}

/** The two teams for the final, once both semi-finals have been settled. */
export function finalists(data) {
  const semis = knockoutMatches(data).filter((m) => stageOf(m) === "semi");
  if (semis.length !== 2) return null;
  const winners = semis.map((m) => matchWinner(data, m).winnerId);
  if (winners.some((id) => !id)) return null;
  return { homeId: winners[0], awayId: winners[1] };
}

function pair(home, away, homeLabel, awayLabel) {
  if (!home?.team || !away?.team) return null;
  return { homeId: home.team.id, awayId: away.team.id, homeLabel, awayLabel };
}

/** The label for a knockout side that is not known yet: "Winner of Semi-final 1". */
export function placeholderFor(data, match, side) {
  const stage = stageOf(match);
  if (stage === "semi") return side === "home" ? "Group winner" : "Runner-up";
  const semis = knockoutMatches(data).filter((m) => stageOf(m) === "semi");
  if (!semis.length) return side === "home" ? "Leaderboard 1" : "Leaderboard 2";
  const semi = side === "home" ? semis[0] : semis[1];
  return semi ? `Winner of semi-final ${semis.indexOf(semi) + 1}` : "To be decided";
}

/**
 * What can be done next in the knockout stage.
 *
 * Returned shape:
 *   {
 *     groupsDone:    boolean,   — every group match is full-time
 *     hasSemis:      boolean,   — semi-final fixtures exist
 *     semisDone:     boolean,   — every semi-final is played AND has a winner
 *     hasFinal:      boolean,   — a final fixture exists
 *     finalDone:     boolean,   — the final is played AND has a winner
 *     canGenerateSemis: boolean, — group stage done, no semis yet
 *     canGenerateFinal: boolean, — semis done, no final yet
 *     action:        'generate_semis' | 'generate_final' | 'complete' | null
 *   }
 */
export function knockoutReadiness(data) {
  const allGroup = groupMatches(data);
  const groupsDone = allGroup.length > 0 && allGroup.every(isPlayed);

  const ko = knockoutMatches(data);
  const semis = ko.filter((m) => stageOf(m) === "semi");
  const finals = ko.filter((m) => stageOf(m) === "final");

  const hasSemis = semis.length > 0;
  const semisDone = hasSemis && semis.every((m) => {
    const { winnerId } = matchWinner(data, m);
    return isPlayed(m) && Boolean(winnerId);
  });

  const hasFinal = finals.length > 0;
  const finalDone = hasFinal && finals.every((m) => {
    const { winnerId } = matchWinner(data, m);
    return isPlayed(m) && Boolean(winnerId);
  });

  const canGenerateSemis = groupsDone && !hasSemis && !hasFinal;
  const canGenerateFinal = (semisDone || (groupsDone && !hasSemis)) && !hasFinal;

  let action = null;
  if (finalDone) action = "complete";
  else if (canGenerateSemis) action = "generate_semis";
  else if (canGenerateFinal) action = "generate_final";

  return {
    groupsDone,
    hasSemis,
    semisDone,
    hasFinal,
    finalDone,
    canGenerateSemis,
    canGenerateFinal,
    action,
  };
}

/** Convenience for renderers: the team on one side of a match, or null. */
export const sideTeam = (data, match, side) =>
  teamById(data, side === "home" ? match?.homeId : match?.awayId);
