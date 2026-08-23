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
| `standings.js` | Table, tiebreaks, final seeding, champion, round-robin generation |
| `events.js` | Match log, discipline, sendings off, suspensions |
| `stats.js` | The points engine and every statistics table |
| `awards.js` | The five medals and the archive summary |
| `auction.js` | Budgets, squad shape, and every validation guard |
| `format.js` | Human-readable formatting |

### The tournament document

Everything above works on one nested object, which is also what the API returns:

```js
{
  id, slug, name, season, format, status,
  meta:     { venueName, kickoffISO, ... },
  settings: { budget, basePrice, points: {...}, ... },
  teams:    { [teamId]:   { id, slot, name, jerseyColor, ... } },
  players:  { [playerId]: { id, name, pos, teamId, price, kind } },
  matches:  { [matchId]:  { id, no, homeId, awayId, homeScore, awayScore,
                            status, isFinal, clock, events: { [id]: {...} } } }
}
```

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
- Registration is open by default but grants nothing — a new account sits at
  `pending` until a super admin assigns it to a tournament.

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
