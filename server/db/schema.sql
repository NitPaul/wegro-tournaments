-- WeGro Tournaments — schema
--
-- Design notes worth reading before changing anything here:
--
--  * Captains are PLAYERS. In the previous version a captain existed only as a
--    `captainName` string on the team, so a captain's goal could not be stored
--    against a player id and vanished from every statistics table while still
--    showing in the match log. `players.kind` fixes that at the schema level:
--    a captain is a player who happens to be flagged as one. Every stat query
--    then works on captains for free.
--
--  * Scores and tables are DERIVED, never stored. There is no `points` column
--    on teams and no `goals` column on players. Standings and player stats are
--    computed from matches and events by shared/domain/, which is the single
--    definition of those rules and is unit tested. The one deliberate exception
--    is the `archive` table — see its comment.
--
--  * `settings_json` and `venue_json` stay as JSON blobs on purpose. They are
--    bags of tunables (budget, base price, the eleven scoring weights, venue
--    labels) that gain a field whenever a feature is added. Normalising them
--    would mean a schema migration every time somebody wants a new scoring
--    weight, for no query benefit — nothing ever filters on them.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- People and access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  -- A super admin can do everything everywhere. Everyone else gets their
  -- permissions from tournament_staff, one tournament at a time.
  is_super      INTEGER NOT NULL DEFAULT 0 CHECK (is_super IN (0, 1)),
  -- 'pending' accounts can sign in and see "waiting for approval" and nothing
  -- else. This is what lets people register themselves without that being a
  -- security problem: registration grants no access at all until a super admin
  -- assigns them somewhere.
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'disabled')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Tournaments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tournaments (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  season        TEXT NOT NULL DEFAULT '',
  -- 'league'   = group stage plus an optional final, with an auction
  -- 'friendly' = a handful of matches, no auction, no table
  format        TEXT NOT NULL DEFAULT 'league'
                CHECK (format IN ('league', 'friendly')),
  -- 'draft'     = being set up, hidden from the public site
  -- 'active'    = the one the public site opens by default
  -- 'completed' = finished and archived into the hall of fame
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'completed')),
  starts_on     TEXT,
  venue_json    TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);

-- Who may touch which tournament. A person can be admin of one tournament and
-- referee of another, which is why the role lives here and not on users.
CREATE TABLE IF NOT EXISTS tournament_staff (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'admin'   = squads, captains, auction, settings, matches, match day
  -- 'referee' = match day only: clock, scores, goals, cards
  role          TEXT NOT NULL CHECK (role IN ('admin', 'referee')),
  assigned_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_user ON tournament_staff(user_id);

-- ---------------------------------------------------------------------------
-- Squads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  jersey_color  TEXT,
  jersey_label  TEXT NOT NULL DEFAULT '',
  jersey_cost   REAL NOT NULL DEFAULT 0,
  -- Per-team override of the tournament default. Used when one squad has to
  -- carry an extra player because the pool did not divide evenly.
  squad_size    INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_teams_tournament ON teams(tournament_id);

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  pos           TEXT NOT NULL CHECK (pos IN ('GK', 'DEF', 'MID', 'FWD')),
  -- 'auction' = in the pool, bought with budget, counts against squad limits
  -- 'captain' = leads a team, free, outside the limits, ALWAYS has a team
  -- 'guest'   = turned up on the day, free, outside the limits
  kind          TEXT NOT NULL DEFAULT 'auction'
                CHECK (kind IN ('auction', 'captain', 'guest')),
  price         REAL,
  photo         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_players_tournament ON players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);

-- ---------------------------------------------------------------------------
-- Matches and the match log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  no            INTEGER NOT NULL,
  -- Null on a final until the group stage decides who plays in it. The sides
  -- are resolved from the table at render time, not written here.
  home_team_id  TEXT REFERENCES teams(id) ON DELETE SET NULL,
  away_team_id  TEXT REFERENCES teams(id) ON DELETE SET NULL,
  home_score    INTEGER,
  away_score    INTEGER,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'live', 'ft')),
  is_final      INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  kickoff       TEXT,
  clock_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id, no);

CREATE TABLE IF NOT EXISTS events (
  -- Integer key so insertion order is the natural order of the match log and
  -- two events in the same millisecond cannot collide.
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN (
                'goal', 'penalty_goal', 'save', 'clearance', 'shot', 'chance',
                'foul', 'yellow', 'red')),
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  -- The player the event is credited to. A real foreign key, which is only
  -- possible because captains are players. Null means "not recorded", which
  -- the referee console allows so the scoreline is never held hostage to
  -- remembering who scored.
  player_id   TEXT REFERENCES players(id) ON DELETE SET NULL,
  assist_id   TEXT REFERENCES players(id) ON DELETE SET NULL,
  zone        TEXT,
  penalty     INTEGER NOT NULL DEFAULT 0 CHECK (penalty IN (0, 1)),
  critical    INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1)),
  own_goal    INTEGER NOT NULL DEFAULT 0 CHECK (own_goal IN (0, 1)),
  clock_label TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id, id);
CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id);

-- ---------------------------------------------------------------------------
-- Hall of fame
-- ---------------------------------------------------------------------------

-- The one place this schema stores something it could derive.
--
-- Everything else computes champions and medals from matches on demand, and
-- that property is worth keeping. But the hall of fame lists every tournament
-- ever played, and deriving each row would mean loading every tournament's
-- full match log on every page view. That does not scale past a few seasons.
--
-- So the row is written once, when a super admin marks a tournament completed,
-- and there is a Recompute action for when a result is corrected afterwards.
-- The derivation itself still lives in shared/domain/ — this table only caches
-- its answer.
CREATE TABLE IF NOT EXISTS archive (
  tournament_id     TEXT PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  champion_team_id  TEXT REFERENCES teams(id) ON DELETE SET NULL,
  runner_up_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  champion_name     TEXT NOT NULL DEFAULT '',
  runner_up_name    TEXT NOT NULL DEFAULT '',
  final_score       TEXT NOT NULL DEFAULT '',
  medals_json       TEXT NOT NULL DEFAULT '{}',
  summary_json      TEXT NOT NULL DEFAULT '{}',
  completed_on      TEXT,
  recomputed_at     INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- With three roles sharing one console, "who cleared the scores?" stops being
-- a hypothetical question. Every mutating request writes one row here.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_email    TEXT NOT NULL DEFAULT '',
  tournament_id TEXT,
  action        TEXT NOT NULL,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tournament ON audit_log(tournament_id, at DESC);
