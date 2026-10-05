# Architecture

The document the old project never had. Read this first if you are taking the
codebase over.

## Shape

```
browser  ──fetch/POST──▶  Express  ──▶  SQLite (one file)
   ▲                         │
   └────Server-Sent Events───┘
```

No build step. The browser loads plain ES modules; the server serves them as
static files. There is nothing to compile, bundle or transpile, in either
direction.

## The layer that matters: `shared/domain/`

Pure functions describing the rules of a tournament — no DOM, no network, no
database. Imported by the Node server *and* by the browser, from the same files:

```js
import * as D from "./shared/domain/index.js";   // server
import * as D from "/shared/domain/index.js";    // browser
```

Consequences worth understanding:

- `validateSale` greys out the Sell button in the browser and rejects the POST
  on the server, from one definition. They cannot drift apart.
- There is exactly one description of how a league table sorts.
- The layer is trivially testable — plain data in, plain values out.

| Module | Holds |
|---|---|
| `constants.js` | Positions, event types, point weights, medals, defaults |
| `helpers.js` | Accessors over the tournament document, player-kind predicates |
| `clock.js` | Match clock arithmetic |
| `standings.js` | Table, tiebreaks, group tables, final seeding, champion, round-robin generation |
| `knockout.js` | Stages, who went through, penalty shoot-outs, seeding a bracket |
| `events.js` | Match log, discipline, sendings off, suspensions |
| `stats.js` | The points engine and every statistics table |
| `awards.js` | The five medals and the archive summary |
| `auction.js` | Budgets, squad shape, and every validation guard |
| `career.js` | Careers across tournaments — the pitch record and the FC 26 one |
| `rating.js` | The "from stats" ratings, football and gaming |
| `format.js` | Human-readable formatting |

### The tournament document

Everything above works on one nested object, which is also what the API returns:

```js
{
  id, slug, name, season, format, status,
  mode, game,                       // 'field' | 'esports', and what is played
  meta:     { venueName, kickoffISO, ... },
  settings: { budget, basePrice, points: {...}, ... },
  teams:    { [teamId]:   { id, slot, name, group, jerseyColor, ... } },
  players:  { [playerId]: { id, name, pos, teamId, price, kind, gamerTag } },
  matches:  { [matchId]:  { id, no, stage, homeId, awayId, homeScore, awayScore,
                            homePens, awayPens, status, isFinal, clock,
                            events: { [id]: {...} } } }
}
```

### Gaming tournaments

A tournament with `mode: 'esports'` is the same document, read differently. A
team is a pair sharing one controller rather than a squad; `teams.group` puts it
in Group A or B; `matches.stage` is `group`, `semi` or `final`; and a knockout
that finishes level is settled by `home_pens` / `away_pens`.

`matches.is_final` stays authoritative for *the* final, so `champion()` and the
Hall of Fame did not have to learn anything new. Nothing per-player is logged —
in FC 26 the goals are scored by players inside the game — so the auction, the
positions and the match log are simply not shown.

A person therefore has two independent records: the pitch career described
below, and a gaming one built from their pair's results (`career.js`), each with
its own rating. They are never added together.

Keyed objects, not arrays. `server/db/repo/tournaments.js#loadTournament`
assembles it from normalised tables in four queries. That translation is what
lets a relational schema sit under code written against a document shape, and it
is why the entire UI ported across without being rewritten.

## Database

Normalised tables — see `server/db/schema.sql`, which is commented.

Two things to know:

**`players.kind` is `auction` | `captain` | `guest`.** Captains being real
players is the fix for the reported "captain data missing from stats" bug. Every
statistics function keys off a player id; when a captain had no record, their
events could only carry a name string and were silently dropped. Do not undo
this.

**Nothing aggregate is stored.** No `points` column on teams, no `goals` column
on players. It is all derived by `shared/domain/`. The single exception is the
`archive` table, and the reason is written above it in the schema: the Hall of
Fame lists every tournament ever played, and deriving each row would mean
loading every tournament's full match log on every page view.

`settings_json` and `venue_json` stay JSON on purpose — they are bags of
tunables that gain a field whenever a feature is added, and nothing ever filters
on them.

### Swapping SQLite out

Every SQL statement lives in `server/db/repo/`. Nothing above that layer knows
what a table is. To move to Postgres, reimplement that directory and change the
connection in `server/db/index.js`. Do not scatter queries into routes.

## People, players and careers

A `player` row belongs to one tournament — the Munna who played for SHOMOGRO in
2026. A `person` row (`people`) is the human being, kept for good: photo, usual
position, the super admin's rating. `players.person_id` links the two.

Nothing about a career is stored. `shared/domain/career.js` runs the ordinary
per-tournament ledger (`playerStats`) over every published tournament and adds
up the rows that point at the same person, so a career can never disagree with
the tournaments it came from. `server/roster.js` caches the result in memory and
drops it on every broadcast. Appearances are not recorded, so `matches` counts
the finished matches the player's team played in.

`shared/domain/rating.js` turns a career into the "from stats" rating: points
per match, pulled towards 60 until there are enough matches to believe it.
`gameStatsRating` does the same for FC 26, from league points per match, and
the super admin's `game_rating` is its headline — the gaming profile (tag,
platform, favourite club) sits on the same `people` row.

Photos are files in `DATA_DIR/photos`, served from `/media/photos/` with a
year-long cache; each upload gets a new random file name, so a changed photo is
never served stale. The server checks the bytes are really a JPEG, PNG or WebP
and never builds a path from anything the client sent (`server/photos.js`).

## Backups

`server/routes/site.js` is the super admin's: a `VACUUM INTO` snapshot of the
database, a JSON dump of every table, and a ZIP of both plus every photo, all
downloaded through the browser. `server/zip.js` writes that archive — stored
entries, no compression, about a hundred lines, so the one-dependency rule
survives the feature. The same screen reports the configuration, because the
settings that break a site quietly (`PUBLIC_URL`, the data directory) are
invisible everywhere else.

A single tournament's export is `GET /api/tournaments/:tid/export`, on the
tournament router, so its own admin can take it and `test/api/isolation.test.js`
checks it against another tournament's staff like every other route there.

## Permissions

`server/auth/middleware.js`. `requireTournament(minRole)` loads the tournament,
works out the caller's role from `tournament_staff`, and refuses if it is below
what the route asked for. Ranked `referee < admin < super`.

Every mutating route names its permission in the route definition, where it
cannot be missed:

```js
tournamentRoutes.post("/:tid/auction/sell", requireTournament("admin"), ...)
```

The console hides controls people cannot use, but that is cosmetic. The lock is
here.

## Live updates

`server/stream/sse.js`. Clients subscribe per tournament and receive a small
`changed` event; they then refetch the whole tournament.

That sounds wasteful and is not — a tournament is a few kilobytes — and it buys
two things: one code path for "first load" and "something moved", and a client
that is always correct even if it missed an event while reconnecting.

Clients hold a connection open, so watch connection count, not request rate.
`GET /api/health` reports it.

**If you put a proxy in front, it must not buffer `/api/stream`.** The
`Caddyfile` sets `flush_interval -1`; nginx needs `proxy_buffering off`.

## Auth

- Passwords: scrypt from `node:crypto`, self-describing hashes, upgraded on
  login when the cost parameters change.
- Sessions: random token in an httpOnly cookie; the database stores only its
  SHA-256, so a leaked backup does not hand over live sessions.
- There is no self-registration. The super admin creates each account with a
  User ID; an admin or referee account belongs to one tournament, enforced by a
  unique index on `tournament_staff(user_id)` as well as in the routes.
- Tournaments carry a permanent `code`. No route accepts it in an update.
- A finished tournament refuses writes from anyone but the super admin
  (`requireTournament`, `server/auth/middleware.js`).
- Schema changes to existing tables live in `server/db/migrations/`. A migration
  whose first line is `-- foreign_keys: off` runs with foreign keys off (needed
  to rebuild a table without cascade-deleting its dependents) and is refused if
  it leaves any new broken reference.

## Where to be careful

- **`isGoalEvent` must stay limited to the two goal types.** If a card ever
  counted as a goal event, the tally-mismatch warning would fire on every
  booked match and people would learn to ignore it.
- **No name fallbacks in `stats.js`.** If a player cannot be identified, fix it
  where the event is written. A fallback there is what hid the captain bug for
  a whole tournament.
- **The final's sides are derived, never stored.** `matchSides` reads the
  table, so correcting a group result re-seeds the final automatically.
- **`schema.sql` is idempotent** and re-applied on every boot. Anything that
  cannot be expressed that way goes in `server/db/migrations/NNN-name.sql`.
