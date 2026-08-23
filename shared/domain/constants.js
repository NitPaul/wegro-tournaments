/**
 * The vocabulary of a tournament.
 *
 * Everything here is a registry: add an entry and the tally pills, the match
 * log, the points editor and the public tables all pick it up. That is how
 * fouls and cards were added without touching nine render functions.
 *
 * This module is imported by both the server and the browser. It has no
 * dependencies and no side effects.
 */

export const POSITIONS = ["GK", "DEF", "MID", "FWD"];

export const POSITION_LABEL = {
  GK: "Goalkeeper",
  DEF: "Defence",
  MID: "Midfield",
  FWD: "Forward",
};

export const STATUS_LABEL = {
  scheduled: "Scheduled",
  live: "Live",
  ft: "Full-time",
};

export const TOURNAMENT_FORMATS = {
  league: "League",
  friendly: "Friendly",
};

export const TOURNAMENT_STATUS_LABEL = {
  draft: "Being set up",
  active: "Running",
  completed: "Finished",
};

/**
 * How a player came to be in the tournament.
 *
 *   auction — bid for at the auction. Costs budget, fills a squad slot, counts
 *             against the per-position limits.
 *   captain — leads a team. Free, always has a team, outside every squad limit.
 *   guest   — turned up on the day. Free, outside every limit.
 *
 * `captain` is the one that fixes a real bug. In the previous version a captain
 * was two strings on the team row and had no player record at all, so a
 * captain's goal could not be stored against a player id. It showed in the
 * match log — the renderers fell back to a name — and then vanished from every
 * statistics table, because all of those key off a player id. Making a captain
 * an ordinary player with a flag means every stat function counts them without
 * knowing anything special had to be done.
 */
export const PLAYER_KINDS = ["auction", "captain", "guest"];

/* ------------------------------------------------------------ match actions */

/**
 * Where a goal was struck from. Laid out as the attacking third seen from
 * behind the scorer: the top row is far from goal, the bottom row is the box.
 * The referee taps a cell on a pitch diagram, so these keys are grid positions,
 * not free text.
 */
export const ZONES = [
  ["lw", "Left wing"],
  ["lr", "Long range"],
  ["rw", "Right wing"],
  ["lb", "Left of box"],
  ["ib", "Inside the box"],
  ["rb", "Right of box"],
  ["pk", "Penalty spot"],
];
export const ZONE_LABEL = Object.fromEntries(ZONES);

/** Everything the referee can log. Goals move the scoreline; nothing else does. */
export const ACTION_LABEL = {
  goal: "Goal",
  penalty_goal: "Punctuality penalty",
  save: "Save",
  clearance: "Clearance",
  shot: "Shot on target",
  chance: "Chance created",
  foul: "Foul",
  yellow: "Yellow card",
  red: "Red card",
};

export const ACTION_ICON = {
  goal: "⚽",
  penalty_goal: "⏱",
  save: "🧤",
  clearance: "🛡",
  shot: "🎯",
  chance: "🔑",
  foul: "✋",
  yellow: "🟨",
  red: "🟥",
};

export const EVENT_TYPES = Object.keys(ACTION_LABEL);

/** The disciplinary events, in ascending severity. */
export const DISCIPLINE_TYPES = ["foul", "yellow", "red"];

/**
 * Does this event change the score?
 *
 * Only the two goal types. Everything else — saves, clearances, shots, chances,
 * fouls and cards — is a note against a player and must leave the scoreline
 * alone, or the tally-mismatch warning would fire on every match that had a
 * booking in it.
 */
export const isGoalEvent = (ev) => ev?.type === "goal" || ev?.type === "penalty_goal";

export const isDisciplineEvent = (ev) => DISCIPLINE_TYPES.includes(ev?.type);

/* ----------------------------------------------------------- award scoring */

/**
 * One points table drives all four medals — the same numbers, filtered
 * differently, so a player can check their own total from the match log.
 *
 * The weights are deliberately generous to the unglamorous jobs. A keeper who
 * makes eight saves behind a beaten defence out-scores a striker who taps in
 * three, which is the point: Golden Ball has to be winnable from any position,
 * or it is just the Golden Boot with a longer name.
 *
 * The near-misses are paid too, one step below the thing they nearly were: a
 * chance created is an assist the striker wasted (2 against 3), a shot on target
 * is a goal the keeper stopped (1). Both are cheap on purpose — they happen far
 * more often than goals, so a big number here would drown everything else out.
 *
 * `criticalGoal` is a BONUS added on top of `goal`, not a replacement, so a
 * decider is worth 5 + 3 = 8.
 *
 * The disciplinary weights are negative and deliberately steep at the top. A
 * foul is a shrug; a red card costs more than a goal is worth, because a player
 * sent off has left their team a man short for the rest of the match and that
 * should not be recoverable by scoring once. They are settings like everything
 * else here, so an organiser who disagrees can change them.
 */
export const DEFAULT_POINTS = {
  goal: 5,
  criticalGoal: 3,
  assist: 3,
  chance: 2,
  shot: 1,
  save: 2,
  clearance: 1,
  cleanSheetGK: 5,
  cleanSheetDEF: 3,
  ownGoal: -3,
  concededGK: -1,
  foul: -1,
  yellow: -3,
  red: -8,
};

/** Order and labels for the points table wherever it is shown or edited. */
export const POINT_FIELDS = [
  ["goal", "Goal"],
  ["criticalGoal", "Critical goal — bonus on top"],
  ["assist", "Assist"],
  ["chance", "Chance created"],
  ["shot", "Shot on target"],
  ["save", "Save"],
  ["clearance", "Clearance"],
  ["cleanSheetGK", "Clean sheet — goalkeeper"],
  ["cleanSheetDEF", "Clean sheet — defender"],
  ["ownGoal", "Own goal"],
  ["concededGK", "Goal conceded — goalkeeper"],
  ["foul", "Foul"],
  ["yellow", "Yellow card"],
  ["red", "Red card"],
];

/**
 * The four medals, in the order they are presented.
 *
 * `[key, label, medal, overrideSetting, basis]`. Every medal computes a winner
 * from the points table AND can be overruled by name from Settings: the
 * referee's log is the default, not the verdict. Management may hand any of
 * these to someone else, and the public card then says the award was assigned
 * rather than quietly contradicting the numbers printed underneath it.
 */
export const MEDALS = [
  ["goldenBall", "Golden Ball", "🏅", "goldenBallPlayerId", "highest points total of anyone"],
  ["goldenBoot", "Golden Boot", "👟", "goldenBootPlayerId", "most goals scored"],
  ["goldenGlove", "Golden Glove", "🧤", "goldenGlovePlayerId", "highest points total among goalkeepers"],
  ["bestDefender", "Best Defender", "🛡", "bestDefenderPlayerId", "highest points total among defenders"],
];

/**
 * Medals awarded to a team rather than a player. Kept separate because the
 * override setting names a team id, so the admin picker and the public card
 * need a different list to read from — folding it into MEDALS would mean every
 * consumer checking which kind each entry was.
 */
export const TEAM_MEDALS = [
  ["fairPlay", "Fair Play", "🤝", "fairPlayTeamId", "fewest disciplinary points conceded"],
];

/* ------------------------------------------------------------- match clock */

/** The periods a match moves through, in order. Extra time is opt-in. */
export const PERIOD_ORDER = ["pre", "h1", "ht", "h2", "ft"];

export const PERIOD_LABEL = {
  pre: "Not started",
  h1: "First half",
  ht: "Half-time",
  h2: "Second half",
  et: "Extra time",
  ft: "Full-time",
};

/** Periods where the clock should actually be ticking. */
export const PLAYING_PERIODS = ["h1", "h2", "et"];

/* ---------------------------------------------------------------- defaults */

/**
 * A new tournament's settings. Previously these lived inside a `seed()`
 * function alongside four hardcoded team names and a fixed 24-player pool,
 * which is precisely why the old site could only ever run one tournament.
 */
export const DEFAULT_SETTINGS = {
  budget: 100,
  basePrice: 8,
  minRaise: 1,
  maxRaise: 5,
  squadSize: 6,
  minPerCategory: 1,
  maxPerCategory: 2,
  maxGK: 1,
  auctionOpen: true,

  goldenBallPlayerId: null,
  goldenBootPlayerId: null,
  goldenGlovePlayerId: null,
  bestDefenderPlayerId: null,
  fairPlayTeamId: null,

  halfSeconds: 480,
  breakSeconds: 120,
  extraSeconds: 300,

  /**
   * A red card suspends the player for their team's next match. Advisory: the
   * console warns when a suspended player is picked, it does not refuse. The
   * referee on the pitch decides who is playing, not the software.
   */
  redCardSuspensionMatches: 1,

  points: { ...DEFAULT_POINTS },
};

export const DEFAULT_META = {
  venueName: "",
  plusCode: "",
  mapUrl: "",
  mapEmbedUrl: "",
  dateLabel: "",
  timeLabel: "",
  kickoffISO: "",
  auctionLabel: "",
  updatedAt: null,
};
