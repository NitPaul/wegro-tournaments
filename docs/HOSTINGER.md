# Hosting on Hostinger

A start-to-finish guide for putting WeGro Tournaments on a Hostinger VPS. Budget
about an hour the first time, most of it waiting for DNS.

## Read this first: you need a VPS, not shared hosting

**Hostinger's shared and cloud hosting plans cannot run this.** They serve PHP
from a directory. This is a long-running Node process that holds an open
connection to every phone watching the scoreboard, and it needs Docker. Neither
is available on a shared plan.

What you need is **Hostinger VPS** — any Ubuntu plan. The smallest one is
plenty:

| | |
|---|---|
| Peak load | ~50 phones, one open connection each |
| Database | a single SQLite file; the entire 2026 tournament was 4.65 KB |
| RAM in use | well under 200 MB |

1 vCPU and 4 GB RAM is already generous. Do not pay for more on our account.

---

## 1. Create the VPS

In hPanel: **VPS → buy a plan → Ubuntu 24.04**.

If the plan list offers an application template with **Docker** preinstalled,
take it and skip step 2. Hostinger's template names move around, so if you
cannot find it, plain Ubuntu is completely fine — step 2 takes two minutes.

Set the root password when prompted, or add your SSH key, which is better. Note
the server's **IPv4 address**; you need it in the next step.

## 2. Point the domain at it

Wherever `wegro.global` DNS is managed — hPanel if the domain is with
Hostinger, otherwise your registrar:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `tournaments` | *the VPS IPv4 address* | 300 |

That gives `tournaments.wegro.global`.

**Do this before step 5.** Caddy asks Let's Encrypt for the certificate at
startup, and Let's Encrypt checks DNS. If the record has not propagated, the
first start fails and you have to wait out a retry.

Check it from your own machine:

```bash
nslookup tournaments.wegro.global
```

When that returns the VPS address, carry on.

## 3. Connect and install Docker

SSH in — from your terminal, or the browser terminal in hPanel:

```bash
ssh root@<the VPS IP>
```

If Docker was not preinstalled:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

Both commands must print a version. If `docker compose version` fails but
`docker --version` works, the Compose plugin is missing:

```bash
apt install -y docker-compose-plugin
```

## 4. Get the code and the configuration

```bash
mkdir -p /srv && cd /srv
git clone https://github.com/NitPaul/wegro-tournaments.git
cd wegro-tournaments
```

The repository is public and deliberately contains **no secrets**. The two
things it cannot contain arrive separately, in the zip you were sent:

| From the zip | Goes to | What it is |
|---|---|---|
| `.env` | `/srv/wegro-tournaments/.env` | passwords and keys for this server |
| `data/wegro.sqlite` | into the Docker volume, see below | the 2026 tournament |

Upload the zip with `scp` from your own machine:

```bash
scp wegro-handover.zip root@<the VPS IP>:/srv/wegro-tournaments/
```

Then on the server:

```bash
cd /srv/wegro-tournaments
apt install -y unzip
unzip wegro-handover.zip -d handover
cp handover/.env .env
chmod 600 .env          # only root can read it
```

### Check the two marked lines

```bash
nano .env
```

Find the two lines marked **CHECK THIS** and make sure the hostname is the one
you actually set up in step 2:

```
PUBLIC_URL=https://tournaments.wegro.global
DOMAIN=tournaments.wegro.global
```

`PUBLIC_URL` needs the `https://` and no trailing slash. `DOMAIN` is the bare
hostname. Getting `PUBLIC_URL` wrong is the single most common mistake here and
it does not look like a configuration error — **sign-in just fails as though the
password were wrong**, because the session cookie was issued for a different
origin. Check it twice now and save yourself an hour later.

Ctrl+O, Enter, Ctrl+X to save and quit nano.

## 5. Start it

```bash
docker compose --profile tls up -d
```

The first run builds the image and gets a TLS certificate; give it a minute or
two. Watch it happen:

```bash
docker compose logs -f
```

You want to see, roughly in this order:

```
[bootstrap] Created super admin ...
WeGro Tournaments listening on 3000
certificate obtained successfully
```

Ctrl+C stops following the logs. It does not stop the server.

If it refuses to start it will tell you exactly why and exit — that is
deliberate. A missing `SESSION_SECRET` prints:

```
✗ SESSION_SECRET is not set. Generate one with: ...
```

Fix what it names and run the command again.

## 6. Load the 2026 tournament

The database ships as a file. Copy it into the running container's volume and
restart:

```bash
docker compose stop app
docker compose cp handover/data/wegro.sqlite app:/data/wegro.sqlite
docker compose start app
```

If `docker compose cp` is not available on your Docker version, use the volume
directly:

```bash
docker compose stop app
docker run --rm -v wegro-tournaments_wegro-data:/data \
  -v /srv/wegro-tournaments/handover/data:/in \
  alpine cp /in/wegro.sqlite /data/wegro.sqlite
docker compose start app
```

> **Only do this on a fresh install.** It replaces the whole database. Once the
> system is live and people are using it, never copy a file in this way — use
> the restore procedure in `tools/restore.js` instead.

## 7. Check it worked

```bash
curl -s https://tournaments.wegro.global/healthz
```

`{"ok":true}` means the app is up and TLS is working.

Then in a browser:

- `https://tournaments.wegro.global` — the scoreboard, showing WeGro Champions
  League 2026
- `https://tournaments.wegro.global/hall-of-fame` — SHOMOGRO beat LEGACY 2–0
- `https://tournaments.wegro.global/admin` — sign in with the
  `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` from the `.env`

## 8. Close up

Three things, in order, and none of them optional.

**Change the password.** Sign in, then change it in the console. The one in the
`.env` travelled by email and should be treated as already compromised.

**Delete the password from the file.**

```bash
nano .env      # delete the SUPER_ADMIN_PASSWORD line entirely
docker compose restart app
```

It is ignored once the account exists, but a password in a file on a server is a
password on a server.

**Delete the handover copies.**

```bash
rm -rf /srv/wegro-tournaments/handover /srv/wegro-tournaments/wegro-handover.zip
```

## 9. Firewall

Hostinger VPS usually ships with everything open, in which case there is nothing
to do. If you tighten it — and you should — open exactly these:

| Port | Why |
|---|---|
| 22 | SSH |
| 80 | HTTP; Caddy needs it to renew the certificate, and it redirects to 443 |
| 443 | the site |

Port 3000 must **not** be open. `docker-compose.yml` binds the app to
`127.0.0.1` so it is only reachable through Caddy. Leave that as it is.

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

Closing port 80 breaks certificate renewal about sixty days later, long after
you have forgotten you closed it. Leave it open.

## 10. Backups

```bash
docker compose exec app npm run backup
```

Writes a consistent `.sqlite` copy and a readable `.json` dump into the
`wegro-backups` volume. Safe to run mid-match — it uses `VACUUM INTO`.

Nightly, on the host:

```bash
crontab -e
```

```cron
0 2 * * * cd /srv/wegro-tournaments && docker compose exec -T app npm run backup
```

**A backup that has never been restored is not a backup.** Do it once now, on
purpose, while nothing depends on it: take a backup, restore it into an empty
volume, confirm the tournament comes back whole. The procedure is at the top of
`tools/restore.js`.

Also pull a copy off the server periodically, from your own machine:

```bash
scp -r root@<the VPS IP>:/var/lib/docker/volumes/wegro-tournaments_wegro-backups/_data ./wegro-backups
```

A backup that only exists on the machine it is backing up protects you from
nothing.

---

## Updating later

```bash
cd /srv/wegro-tournaments
docker compose exec app npm run backup     # first, always
git pull
docker compose up -d --build
```

About ten seconds of downtime. **The database is in a Docker volume, so a
rebuild does not touch it** — this has been tested by destroying the container
and the image and rebuilding both.

Rolling back:

```bash
git log --oneline -5
git checkout <the commit before>
docker compose up -d --build
```

## Never deploy on a match day

Not the morning of, not "just a small fix". Freeze the code the day before, and
do a practice run: create a throwaway tournament, add two teams, start the
clock, log a goal and a card, delete it.

---

## When something is wrong

```bash
docker compose ps                    # is it running
docker compose logs --tail=100 app   # what did it say
docker compose logs --tail=50 caddy  # certificate problems live here
docker compose restart app           # the usual fix
```

| What you see | What it is |
|---|---|
| Site does not resolve | DNS. `nslookup tournaments.wegro.global` |
| Browser warns about the certificate | `DOMAIN` in `.env` does not match the real hostname, or port 80 is closed. Check the Caddy logs. |
| Sign-in rejects a password you know is right | `PUBLIC_URL` does not match the address in the browser bar. This is almost always it. |
| **Scores update only after a refresh** | Something is buffering the event stream. If you put your own nginx in front of this, see below. |
| Container restarts in a loop | `docker compose logs app` — it prints the reason and exits deliberately rather than half-starting. |

### If you replace Caddy with your own nginx

One rule matters:

```nginx
location /api/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;          # REQUIRED
    proxy_read_timeout 24h;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

Without `proxy_buffering off`, live scores appear to work and then arrive a
minute late, because nginx holds the event stream until its buffer fills. It is
the one failure that will not show up in testing and will show up during a
match. The app also needs `X-Forwarded-Proto`, or session cookies will not be
marked Secure and sign-in fails.

---

## Handover checklist

- [ ] `https://tournaments.wegro.global/healthz` returns `{"ok":true}`
- [ ] The scoreboard shows WeGro Champions League 2026
- [ ] The Hall of Fame shows SHOMOGRO beating LEGACY 2–0
- [ ] Sign-in works, and survives `docker compose restart app`
- [ ] Two browsers on the public page; a score change in the console appears in
      both within about a second
- [ ] `npm run backup` produces files, and a restore has actually been tested
- [ ] The certificate is valid — Caddy renews it by itself
- [ ] `SUPER_ADMIN_PASSWORD` changed, then removed from `.env`
- [ ] The handover zip and its unpacked copy are deleted from the server
- [ ] `chmod 600 .env`

## One honest warning

On Firebase, keeping the site up was somebody else's job. It is now ours: **the
server has to be up at kick-off.** The container restarts on failure and has a
health check, but until this platform has run one full tournament end to end,
keep the old Netlify site alive as a fallback. Do not delete it and do not
delete the Firebase project.
