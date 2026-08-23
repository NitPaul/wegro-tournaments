# Deployment

For whoever is hosting this. It should take under an hour on a fresh server.

## What you are deploying

A single Node 24 container serving a static browser app and a small JSON API,
with a SQLite database in a Docker volume. No second service, no message broker,
no external database. One runtime dependency (Express); everything else is
Node's standard library, so the image compiles nothing.

Live updates go out over Server-Sent Events. **That is the only thing about
this deployment that is not completely ordinary** — see the proxy note below.

## What you need

- A Linux host with Docker and the Compose plugin. 1 vCPU and 1 GB RAM is
  ample; peak load is roughly 50 phones holding an open connection each.
- A DNS A record, e.g. `tournaments.wegro.global`, pointing at the host.
- Ports 80 and 443 open. Nothing else needs to be reachable.

## Deploy

```bash
git clone <repo> wegro-tournaments
cd wegro-tournaments
cp .env.example .env
```

Fill in `.env`:

```bash
NODE_ENV=production
PUBLIC_URL=https://tournaments.wegro.global   # must match the real origin
DOMAIN=tournaments.wegro.global               # used by Caddy
SESSION_SECRET=<64+ random hex chars>
SUPER_ADMIN_EMAIL=organiser@example.com    # the person who will run tournaments
SUPER_ADMIN_PASSWORD=<temporary, removed after first sign-in>
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then:

```bash
docker compose --profile tls up -d
```

Caddy obtains and renews the TLS certificate itself. That is why it is here
rather than nginx: certificate renewal is the part of self-hosting that quietly
breaks six months later, and this removes it.

Check it:

```bash
curl -s https://tournaments.wegro.global/healthz
docker compose logs -f app
```

Then have the organiser sign in, and **delete `SUPER_ADMIN_PASSWORD` from
`.env`**. It is ignored once the account exists, but a password in a file on a
server is a password on a server.

## If you already run nginx

Skip the `tls` profile and proxy to the app yourself. One rule matters:

```nginx
location /api/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;          # REQUIRED
    proxy_read_timeout 24h;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Without `proxy_buffering off` the live scores appear to work and then arrive
a minute late**, because nginx holds the event stream until its buffer fills.
It is the one failure mode that will not show up in testing and will show up
during a match.

The app also needs `X-Forwarded-Proto`, or it will not mark session cookies
Secure and sign-in will fail in a way that looks like a wrong password.

## Data and backups

Everything lives in the `wegro-data` volume as a single SQLite file. Rebuilding
or updating the image never touches it.

```bash
docker compose exec app npm run backup
```

Writes a consistent `.sqlite` copy (via `VACUUM INTO`, safe to run mid-match)
and a readable `.json` dump into the `wegro-backups` volume.

A daily cron, copied off the host:

```cron
0 2 * * * cd /srv/wegro-tournaments && docker compose exec -T app npm run backup
```

Restore is documented at the top of `tools/restore.js`. **Test it once before
you need it** — an untested restore is not a backup.

## Updating

```bash
cd /srv/wegro-tournaments
git pull
docker compose up -d --build
```

Roughly ten seconds of downtime. The database is in a volume, so it is
untouched. Schema changes apply themselves on boot: `schema.sql` is idempotent,
and anything it cannot express lives in `server/db/migrations/NNN-name.sql` and
runs once, in order, inside a transaction.

**Back up before updating.** It costs two seconds.

Rolling back is `git checkout <previous-tag> && docker compose up -d --build`.
A migration is not automatically reversed, so if one has run, restore the
backup as well.

## Operating notes

- **Health**: `GET /healthz` — dependency-free, suitable for a monitor.
  `GET /api/health` additionally reports open SSE connections.
- **Restart policy** is `unless-stopped`; the container also has a `HEALTHCHECK`.
- **Logs**: `docker compose logs -f app`. Every mutating request is also written
  to the `audit_log` table with who did it, which is how you answer "who cleared
  the scores".
- **Sessions** are rows in SQLite. Changing `SESSION_SECRET` signs everyone out
  — do not rotate it on a match day.
- **The app binds to `127.0.0.1`** in `docker-compose.yml` so it is only
  reachable through the proxy. Keep it that way.

## Security summary

- Passwords: scrypt (`node:crypto`), self-describing hashes, upgraded on login.
- Sessions: random token in an httpOnly cookie; the database stores only its
  SHA-256, so a leaked backup does not hand over live sessions.
- Roles are enforced server-side on every mutating request
  (`server/auth/middleware.js`), not in the browser.
- Registration is open by default but grants nothing until a super admin
  assigns the account to a tournament. Set `ALLOW_REGISTRATION=false` to close
  it entirely.
- CSP is strict: `script-src 'self'`, no inline scripts anywhere in the app.

## Before you hand it back

- [ ] `https://<domain>/healthz` returns `{"ok":true}`
- [ ] Sign in works, and the session survives a container restart
- [ ] Two browsers open on the public page; a score change in the console
      appears in both within about a second
- [ ] `npm run backup` produces files, and a restore into an empty volume works
- [ ] Certificate is valid and auto-renewal is configured (Caddy does this)
- [ ] `SUPER_ADMIN_PASSWORD` removed from `.env`
