--
-- 003 — gaming (esports) tournaments, groups and knockout rounds.
--
-- WeGro plays FC 26 as well as football now. A gaming tournament is not a
-- separate kind of thing here: it is a tournament with `mode = 'esports'`.
-- Teams, fixtures, the table, the champion and the hall of fame all work
-- unchanged; what the site hides for a gaming tournament is the auction,
-- positions and the per-player match log, none of which mean anything when the
-- players on the pitch are not the people in the room.
--
-- Additive only — new columns, no table rebuilt — so this cannot touch an
-- existing row. (ALTER TABLE ADD COLUMN accepts CHECK, and NOT NULL with a
-- default; it does not accept UNIQUE.)

-- ---------------------------------------------------------------------------
-- Tournaments: which game, if any
-- ---------------------------------------------------------------------------

ALTER TABLE tournaments ADD COLUMN mode TEXT NOT NULL DEFAULT 'field'
  CHECK (mode IN ('field', 'esports'));

-- The game being played, free text, shown on the badge: "EA SPORTS FC 26".
ALTER TABLE tournaments ADD COLUMN game TEXT;

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------

-- 'A', 'B', … or NULL when everyone is in one table, which is how every
-- tournament before this one was run.
ALTER TABLE teams ADD COLUMN group_label TEXT;

-- ---------------------------------------------------------------------------
-- Knockout rounds
-- ---------------------------------------------------------------------------

-- NULL or 'group' is the group stage; 'semi' and 'final' are knockout rounds.
-- `is_final` stays, and stays the authority on which match is THE final, so
-- champion() and the hall of fame keep working exactly as before. This column
-- only adds the rounds before it.
ALTER TABLE matches ADD COLUMN stage TEXT
  CHECK (stage IS NULL OR stage IN ('group', 'semi', 'final'));

-- A knockout match cannot end level. These hold the shoot-out, and are only
-- read when the scores are equal.
ALTER TABLE matches ADD COLUMN home_pens INTEGER;
ALTER TABLE matches ADD COLUMN away_pens INTEGER;

-- ---------------------------------------------------------------------------
-- Gaming profiles
-- ---------------------------------------------------------------------------

-- A person has one record on the pitch and another on the console. These are
-- the console half: who they are in the game, and how good at it they are.
ALTER TABLE people ADD COLUMN gamer_tag TEXT;
ALTER TABLE people ADD COLUMN platform TEXT;
ALTER TABLE people ADD COLUMN fav_club TEXT;
ALTER TABLE people ADD COLUMN game_rating INTEGER
  CHECK (game_rating IS NULL OR (game_rating BETWEEN 1 AND 99));
ALTER TABLE people ADD COLUMN game_rating_note TEXT NOT NULL DEFAULT '';
