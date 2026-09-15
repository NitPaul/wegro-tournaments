-- foreign_keys: off
--
-- 001 — ID + password accounts, one tournament per account, tournament codes.
--
-- Runs with foreign keys switched off because it rebuilds `users`, and SQLite
-- cannot change a column from NOT NULL any other way. With foreign keys on,
-- dropping the old table would cascade-delete every session and every staff
-- assignment. The runner checks `PRAGMA foreign_key_check` before committing,
-- so a mistake here rolls back instead of leaving broken references.

-- ---------------------------------------------------------------------------
-- Tournament codes
-- ---------------------------------------------------------------------------

-- A permanent handle for each tournament. The name can be changed by the
-- tournament's admin and the slug was derived from the original name, so after
-- a rename neither tells the super admin which tournament is which. The code
-- never changes; no route accepts it in an update.
ALTER TABLE tournaments ADD COLUMN code TEXT;
UPDATE tournaments SET code = 'WGT-' || upper(hex(randomblob(3))) WHERE code IS NULL;
CREATE UNIQUE INDEX idx_tournaments_code ON tournaments(code);

-- ---------------------------------------------------------------------------
-- Accounts: a User ID to sign in with, email optional, no pending state
-- ---------------------------------------------------------------------------

-- Accounts are now created by the super admin and handed over, so there is no
-- self-registration and nothing waiting for approval.
CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  -- What people sign in with. Letters, digits, dots, dashes, underscores.
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- Optional now. Existing accounts keep theirs and can still sign in with it.
  email         TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  is_super      INTEGER NOT NULL DEFAULT 0 CHECK (is_super IN (0, 1)),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- Each existing account's User ID is the part of its email before the @, made
-- unique with a numeric suffix if two addresses share it. A self-registered
-- account that was still waiting for approval becomes disabled: it never had
-- access, and it must not gain any by the approval queue disappearing.
INSERT INTO users_new (id, username, email, password_hash, name, is_super, status, created_at, last_seen_at)
SELECT u.id,
       CASE WHEN b.n = 1 THEN b.base ELSE b.base || '-' || b.n END,
       u.email,
       u.password_hash,
       u.name,
       u.is_super,
       CASE WHEN u.status = 'pending' THEN 'disabled' ELSE u.status END,
       u.created_at,
       u.last_seen_at
  FROM users u
  JOIN (
        SELECT id,
               base,
               ROW_NUMBER() OVER (PARTITION BY base ORDER BY created_at, id) AS n
          FROM (
                SELECT id,
                       created_at,
                       lower(CASE WHEN instr(email, '@') > 1
                                  THEN substr(email, 1, instr(email, '@') - 1)
                                  ELSE email END) AS base
                  FROM users
               )
       ) b ON b.id = u.id;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- ---------------------------------------------------------------------------
-- One tournament per account
-- ---------------------------------------------------------------------------

-- An admin or referee belongs to exactly one tournament. Where an account held
-- more than one assignment, it keeps its most recent and loses the others —
-- access only ever shrinks here — and every removal is written to the audit log
-- so nothing disappears without a trace.
ALTER TABLE audit_log ADD COLUMN username TEXT;

INSERT INTO audit_log (user_id, user_email, username, tournament_id, action, detail_json, ip, at)
SELECT s.user_id,
       COALESCE(u.email, ''),
       u.username,
       s.tournament_id,
       'staff.remove',
       json_object(
         'role', s.role,
         'reason', 'An account can belong to one tournament only. It kept its most recent assignment.',
         'by', 'migration 001'
       ),
       NULL,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tournament_staff s
  JOIN users u ON u.id = s.user_id
 WHERE EXISTS (
        SELECT 1 FROM tournament_staff newer
         WHERE newer.user_id = s.user_id
           AND (newer.assigned_at > s.assigned_at
                OR (newer.assigned_at = s.assigned_at AND newer.tournament_id > s.tournament_id))
       );

DELETE FROM tournament_staff
 WHERE EXISTS (
        SELECT 1 FROM tournament_staff newer
         WHERE newer.user_id = tournament_staff.user_id
           AND (newer.assigned_at > tournament_staff.assigned_at
                OR (newer.assigned_at = tournament_staff.assigned_at
                    AND newer.tournament_id > tournament_staff.tournament_id))
       );

CREATE UNIQUE INDEX idx_staff_one_tournament ON tournament_staff(user_id);
