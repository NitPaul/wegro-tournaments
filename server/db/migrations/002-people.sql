--
-- 002 — the player roster.
--
-- A `player` belongs to one tournament. A `person` is the human being, kept for
-- good: their photo, their position, the rating the super admin gives them.
-- Tournament players point at a person, and a career is every tournament
-- player that points at the same one (shared/domain/career.js).
--
-- Additive only — a new table and a new nullable column — so this runs with
-- foreign keys on and cannot touch a single existing row.

CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- Where they usually play. A tournament player still has its own position,
  -- because someone may keep goal one season and play up front the next.
  pos         TEXT CHECK (pos IS NULL OR pos IN ('GK', 'DEF', 'MID', 'FWD')),
  -- A file name inside DATA_DIR/photos, never a path. Changes on every upload,
  -- so the photo can be cached for a year without ever showing a stale face.
  photo       TEXT,
  -- The super admin's judgement, 1–99. Null means "not rated yet"; the player
  -- list then falls back to the rating worked out from their stats.
  rating      INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 99)),
  -- Why that rating. Only ever shown to the super admin.
  rating_note TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_people_name ON people(name COLLATE NOCASE);

ALTER TABLE players ADD COLUMN person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX idx_players_person ON players(person_id);
