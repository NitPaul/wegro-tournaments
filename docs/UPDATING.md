# Keeping it updated

For the person who owns the code — you, not the person who owns the server.

The split is worth stating plainly: **you change the code, your senior
developer owns the machine.** Neither of you needs to be in the other's way,
provided the update path is boring. This is how to keep it boring.

## The loop

```
edit on your laptop  →  npm test  →  git push  →  server pulls and rebuilds
```

That is the whole thing.

### 1. Change something

```powershell
cd E:\WeGro_FootBall\wegro-tournaments
npm start
```

Work against `http://localhost:3000`. Your local database is `data/wegro.sqlite`
and has nothing to do with the server's.

### 2. Check you did not break anything

```powershell
npm test
```

134 tests, about half a second. **Never push with a failing test.** They cover
the things that are expensive to get wrong: standings and tiebreaks, the points
engine, auction rules, cards and suspensions, and the captain fix.

If you changed anything about squads, scoring or medals, also open the site and
look at it. Tests catch arithmetic; they do not catch a layout that has
collapsed.

### 3. Push

```powershell
git add .
git commit -m "Short description of what changed"
git push
```

### 4. The server takes it

```bash
cd /srv/wegro-tournaments
docker compose exec app npm run backup    # first, always
git pull
docker compose up -d --build
```

About ten seconds of downtime. **Your data is in a Docker volume and is not
touched by a rebuild** — this is the thing people worry about, and it is the
thing you do not have to worry about.

Agree with your senior developer whether he runs those three lines or gives you
access to run them. Either is fine. What is not fine is nobody being sure.

## Database changes

`server/db/schema.sql` is applied on every boot, and every statement is
`CREATE TABLE IF NOT EXISTS`, so adding a new table there is safe and needs
nothing else.

For anything that cannot be expressed that way — a new column on an existing
table, backfilling data, dropping something — add a numbered file:

```
server/db/migrations/001-add-player-photo.sql
```

It runs once, in order, inside a transaction, tracked by SQLite's own
`user_version`. If it fails, nothing is applied and the server refuses to start
with the reason. Write them so they can only run once.

## Rules for not ruining a match day

- **Never deploy on the day of a tournament.** Not the morning of, not "just a
  small fix". Freeze the code the day before.
- **Do a practice run the day before**: create a throwaway tournament, add two
  teams, start the clock, log a goal and a card, delete it.
- **Take a backup before kick-off**, from Danger → Download a copy.
- **Do not change `SESSION_SECRET`** unless you intend to sign everybody out.
- **Do not touch the medal overrides mid-tournament** unless you mean it — an
  override wins over the computed winner and the card will say so.

## Where things live, when you come back in six months

| You want to change | Look in |
|---|---|
| A scoring rule, a tiebreak, an auction guard | `shared/domain/` |
| What an endpoint does, or who may call it | `server/routes/` |
| A SQL query | `server/db/repo/` |
| The public scoreboard | `public/js/public.js`, `public/index.html` |
| The admin console | `public/js/admin.js`, `public/admin.html` |
| The Hall of Fame | `public/js/halloffame.js` |
| Colours, spacing, anything visual | `public/css/theme.css` first — it is all tokens |

**`shared/domain/` is imported by both the server and the browser.** A change
there affects validation and display at once, which is the point — but it also
means a mistake there is a mistake in two places. That directory has the most
test coverage for exactly that reason.

## If something goes wrong on the server

```bash
docker compose logs --tail=100 app     # what happened
curl -s localhost:3000/healthz          # is it alive
docker compose restart app              # the usual fix
```

If a deploy made it worse:

```bash
git log --oneline -5
git checkout <the-commit-before>
docker compose up -d --build
```

If the data looks wrong, restore the backup rather than trying to repair it by
hand — see the top of `tools/restore.js`.

## The one thing to keep

Your old Netlify site is the fallback. **Do not delete it, and do not delete the
Firebase project, until this platform has run a full tournament end to end.**
Netlify → Stop builds and Lock the deploy, so it cannot drift or cost you
credits while it sits there.
