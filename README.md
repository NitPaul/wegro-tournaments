# WeGro Tournaments

A self-hosted platform for running company football tournaments: squads, a live
auction, a match-day console, player statistics, and a permanent Hall of Fame.

Built to replace `wegro-champions-league`, which ran the 2026 tournament on
Netlify and Firebase. **That site is untouched and still live.** This one runs on
your own server, supports as many tournaments as you like, and enforces who is
allowed to do what on the server instead of in the browser.

---

## Why this exists

The old site did its job, but it was built for exactly one tournament:

- The season lived in a hardcoded constant, and the four teams, 24 players and
  seven fixtures were hardcoded module arrays.
- **Roles were a JavaScript array shipped to every browser.** Adding a referee
  meant editing a source file, regenerating a rules file, pasting it into the
  Firebase console and redeploying. The "restricted" account had identical
  power to the organiser — the Danger tab was hidden with `hidden`, and the
  database rules behind it could only see a user id and had no idea what a
  referee was.
- **Captains were not players.** They were two strings on the team row, so a
  captain's goal could not be stored against a player id. It appeared in the
  match log and then vanished from every statistics table.

All three are fixed here, and the first two could not have been fixed in place.

---

## What is new

| | |
|---|---|
| **Many tournaments** | Create as many as you like. The public site opens the active one; `?t=<slug>` opens any other, so last season's scoreboard stays a working link. |
| **Real roles** | Super admin → tournament admin → referee, checked on the server on every request. |
| **Self-service sign-up** | People create their own account and land in a pending queue with no access. Assigning them to a tournament approves them. |
| **Friendly matches** | A tournament with `format: friendly` — matches and a score, no auction, no table. |
| **Fouls and cards** | Fouls, yellows and reds. They never move the scoreline. Second-yellow warning, red-card suspensions, a fair-play table. |
| **Hall of Fame** | Every finished tournament: date, champion, runners-up, final score and all five medals. |
| **Captains fixed** | Captains are players. Their goals, assists, cards and clean sheets count everywhere. |
| **Tests** | 141 of them. The old project had none. |
| **Docker** | One container, one SQLite file, one command. |

---

## Running it

### Locally

```bash
git clone https://github.com/NitPaul/wegro-tournaments.git
cd wegro-tournaments
npm install          # one dependency: express
cp .env.example .env # fill in SESSION_SECRET and the SUPER_ADMIN_* lines
npm start            # http://localhost:3000
```

Requires **Node 24 or newer** — it uses Node's built-in `node:sqlite`, which
means there is no native module to compile and `npm install` never needs a
build toolchain.

### With Docker

```bash
cp .env.example .env      # fill it in
docker compose up -d
```

With HTTPS (which you want in production — session cookies are marked Secure):

```bash
# set DOMAIN in .env and point its DNS at this server
docker compose --profile tls up -d
```

Caddy obtains and renews the certificate itself. That is the reason it is here
rather than nginx: certificate renewal is the part of self-hosting that quietly
breaks six months later.

### First run

Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in `.env`. The first boot
creates that account, and the path closes afterwards. Remove the password from
the file once you have signed in. If that address has already registered
itself, it is promoted rather than failing.

### On a real server

**[`docs/HOSTINGER.md`](docs/HOSTINGER.md)** is the step-by-step guide for a
Hostinger VPS, which is where this is being hosted — DNS, Docker, TLS, loading
the 2026 data, backups, and what each failure looks like.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers any other host, including
running behind an nginx you already have.

Note that Hostinger's **shared and cloud hosting plans cannot run this** — they
serve PHP from a directory, and this is a long-running Node process that holds
an open connection per viewer. It needs a VPS.

### This repository contains no secrets

`.env` and the database are gitignored and have never been committed. Every
deployment generates its own `SESSION_SECRET`; nothing here is shared between
environments, so a fork of this repo gets you the code and nothing else.

---

## How permissions work

| | Super admin | Tournament admin | Referee |
|---|---|---|---|
| Create / delete tournaments | ✅ | — | — |
| Assign staff, approve people | ✅ | — | — |
| Teams, captains, players, auction, settings | ✅ | ✅ own tournament | — |
| Match day: clock, scores, goals, cards | ✅ | ✅ own tournament | ✅ own tournament |
| Clear scores, reset auction, delete | ✅ | — | — |

Roles are per tournament, so the same person can run one and referee another.

**This is enforced in `server/auth/middleware.js`, on the server, on every
mutating request.** Hiding a tab in the console is only there to keep the screen
tidy. To satisfy yourself, sign in as the referee, open devtools and POST
directly to the auction endpoint — you get a 403.

---

## Bringing the 2026 data across

1. Open the old admin console → **Danger → Download backup**.
   Use a **fresh** backup. One taken before match day has every match still
   marked `scheduled` and no goals in it.
2. Sign in here as super admin → **Danger → Bring in data from the old site** →
   choose the file → **Import**.

The console shows you exactly what it did, including which events it recovered.

There is a command-line version too, for scripting or a bulk migration:

```bash
npm run import:firebase -- ./wegro-cl-backup-2026-08-01.json \
  --name="WeGro Champions League" --season=2026 --status=completed
```

It creates the tournament, gives every captain a real player record, and
**rewrites the `scorerName` / `assistName` / `playerName` strings the old
console wrote into proper player ids** — which is where the missing captain
goals come back. It then computes the Hall of Fame entry.

**Medals that were awarded by hand come across too.** On the old site a medal
could be assigned rather than computed — that is what "organisers' pick" meant
on the public card, and it is how the 2026 Golden Ball, Golden Boot and Golden
Glove were actually decided. The decision was stored as a player id belonging to
the old site, so the importer translates it; the report names each one, and says
so loudly if the chosen player is missing from the backup.

A medal that came out **tied** and was never assigned is reported as well —
Best Defender 2026 is one — because the old card said "tied on points" and
whoever was handed the trophy on the day was never written down. Name them under
**Settings → Medals** and the card will say the award was chosen.

It prints what it resolved and, separately, anything it could not match.
Nothing is ever discarded: an unrecognised name is added as a guest player and
reported, so you can rename it rather than lose the goal.

**Check the numbers against the old site before trusting it** — standings, top
scorers, medals and squads should agree exactly.

---

## Backups

```bash
npm run backup     # or: docker compose exec app npm run backup
```

Writes two files: an exact `.sqlite` copy (made with `VACUUM INTO`, so it is
consistent even mid-match) and a readable `.json` dump. Restore with
`npm run restore <file.json>`, or by putting the `.sqlite` file back — see the
comment at the top of `tools/restore.js`.

Take one after the auction and again before kick-off.

---

## Documentation

| Read this | If you are |
|---|---|
| This file | Anyone — what it is, how to run it, how to import the old data |
| `docs/HOSTINGER.md` | **Hosting it on a Hostinger VPS — start to finish** |
| `docs/DEPLOYMENT.md` | Hosting it on any other server, or behind your own nginx |
| `docs/UPDATING.md` | Changing the code and getting it live |
| `docs/ARCHITECTURE.md` | Taking the codebase over |

## The shape of the code

```
server/          Express, SQLite, auth, roles, SSE
  db/repo/       every SQL query lives here and nowhere else
  auth/          sessions, scrypt passwords, role middleware
  routes/        the API — each route names the permission it needs
  import/        the Firebase migration
shared/domain/   THE RULES — imported by both the server and the browser
public/          the browser app: no build step, plain ES modules
test/            node:test, no framework
```

**`shared/domain/` is the important one.** Standings, player points, medals,
auction validation and the clock live there as pure functions, and both sides
import the same files. So `validateSale` greys out the button in the browser
*and* rejects the request on the server, from one definition. There is no way
for them to disagree.

That is also why the whole thing is testable: pure functions, plain data in,
plain values out.

### Notable choices

- **SQLite, not Postgres.** Your entire 2026 tournament was 4.65 KB. Backup is
  copying one file. Every query is behind `server/db/repo/`, which is the layer
  to reimplement if that ever changes.
- **Server-Sent Events, not WebSockets.** Traffic is one-directional — the
  referee writes, phones read. `EventSource` reconnects by itself, so there is
  no reconnection code here to get wrong.
- **Sessions, not JWTs.** Revocation has to be instant when someone leaves.
- **scrypt from `node:crypto`, not argon2.** No native module, so the image
  builds anywhere.
- **One dependency.** Express. Everything else is Node's standard library.

---

## Tests

```bash
npm test
```

141 tests covering standings and every tiebreak, the points engine, medals,
auction rules including the stranding guard, the clock, cards and suspensions,
and the Firebase import.

`test/domain/captains.test.js` exists specifically so the captain bug cannot come
back quietly. If somebody ever "optimises" captains back out of the players
list, that file goes red.

---

## Things worth knowing before match day

- **Your server has to be up at kick-off.** This is the real cost of leaving
  Firebase. The container restarts on failure and has a health check, but keep
  the old Netlify site as a fallback until you have run one tournament on this.
- **The scoreline is typed directly, not derived from the log.** During a
  sixteen-minute match, getting the number right matters more than remembering
  who scored. A badge warns when the two disagree; it never blocks you.
- **Cards never move the scoreline.** If they did, the mismatch warning would
  fire on every match that had a booking, and everyone would learn to ignore
  the one warning that catches real mistakes.
- **A red card suspension is a warning, not a block.** The referee on the pitch
  decides who is playing.
- **"Not recorded" is always a valid answer** when logging an event. The goal
  goes on the board; you can attach the scorer afterwards.

---

## Who built this

- [NitPaul](https://github.com/NitPaul) — design and development
- [Munna](https://github.com/Munnamm27) — contributor

Run by the WeGro football organising team.
