# TUNING-MOVIE Deployment Guide (Podman + Nginx)

Locally, `npm run dev` starts the backend and the frontend only
(`dev:stack:system`). `npm run dev:stack:agent` adds the tuning agent and
`npm run dev:stack:all` adds the agent monitor UI as well.

Production is not a one-to-one mapping of that. Three containers run in a single
podman pod:

| Container | What it is |
|---|---|
| `tuning-movie-backend` | Fastify + SQLite, **and** it serves the built frontend. It also spawns one tuning-agent child process per session, from `apps/tuning-agent/dist` inside the image. |
| `tuning-movie-agent` | A standalone single-session agent pinned to `AGENT_SESSION_ID=default`. It does **not** serve study or demo sessions, and as configured it cannot join the relay at all (see [Known caveats](#known-caveats)). |
| `tuning-movie-nginx` | Public routing, TLS, and the agent-monitor web bundle, which is built into this image rather than run as a service. |

`nginx` exposes the public URL and routes:

- `/` -> backend app
- `/agent/ws` -> backend relay websocket
- `/.well-known/acme-challenge/` -> certbot webroot
- `/agent-monitor/` -> monitor web UI (restricted; see [Known caveats](#known-caveats))
- `/monitor-api/*` -> agent monitor API in the `agent` container (same restriction)

**This repo is deployed from a working tree, not from a release checkout.** Both
deploy scripts derive `$APP_DIR` from their own location, so they work wherever
the checkout lives — on the booth host that is the deploy user's home directory,
not `/opt/tuning-movie`. Nothing requires a specific path; do not assume one when
troubleshooting, run `podman inspect tuning-movie-backend --format '{{range
.Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'` and look.

## 1) One-time server setup

Clone first — the setup script prepares directories inside the checkout, so it
cannot run before the checkout exists.

```bash
git clone https://github.com/wooogler/maestro-movie.git tuning-movie
cd tuning-movie
sudo bash deploy/scripts/setup-podman.sh
```

`setup-podman.sh` installs podman + podman-compose, configures rootless
UID/GID mappings, opens http/https in the firewall, sets the SELinux container
booleans, writes `/etc/sysctl.d/99-rootless-ports.conf`
(`net.ipv4.ip_unprivileged_port_start=80`, without which rootless nginx cannot
bind 80/443), and creates the runtime directories.

Then, still one-time:

```bash
cp .env.example .env          # required: the deploy script refuses to run without it
# put TLS cert files in place (see §5) — nginx will not start without them
```

A fresh clone cannot boot as-is: `deploy/ssl/*.pem` and `deploy/renew.env` are
gitignored and both are load-bearing.

## 2) Build and run

```bash
podman-compose build
podman-compose up -d
```

Then install reboot survival (§6) and TLS renewal (§5.1).

## 3) Verify

```bash
podman ps
curl -fsS http://127.0.0.1/health
```

Expected containers: `tuning-movie-backend`, `tuning-movie-agent`,
`tuning-movie-nginx`.

`curl https://127.0.0.1/monitor-api/health` returns **403**, and that is normal —
see [Known caveats](#known-caveats).

## 4) Access URLs

- Main app: `https://<server-host>/`
- Agent monitor: not reachable through nginx from the host. Probe it directly:
  ```bash
  podman exec tuning-movie-agent wget -qO- http://127.0.0.1:3500/health
  ```

## 5) TLS (required)

The shipped nginx config serves HTTPS on 443 unconditionally and 301-redirects
everything on port 80 except `/health` and the ACME challenge path. There is no
commented-out TLS block to enable — `deploy/ssl/fullchain.pem` and
`deploy/ssl/privkey.pem` must exist before the first `podman-compose up`, or
nginx will not start. They are gitignored, so a fresh clone has neither.

### 5.1) Automatic renewal

Copy `deploy/renew.env.example` to `deploy/renew.env` and list **every** hostname
the certificate must cover in `CERTBOT_DOMAINS` — including any CNAME alias
people still reach the site by, since a certificate only answers for names in its
SAN list. Both `renew-tls-cert.sh` and the cron installer read this file, so the
domain list can change without reinstalling cron.

```bash
./deploy/scripts/install-cert-renew-cron.sh
```

The installed job runs at `03:23` and `15:23` daily and logs to
`deploy/certbot/logs/renew-cron.log`. The domain list is deliberately not baked
into the cron entry; `deploy/renew.env` is the single source, which also makes
that gitignored file load-bearing.

The renewal flow:

1. `nginx` serves `/.well-known/acme-challenge/` from `deploy/certbot/www`
2. `renew-tls-cert.sh` asks Let's Encrypt for a renewed cert with `certbot --webroot`
3. It refuses to **narrow** the certificate: any name the deployed cert answers
   for today must still be in the requested list, so a stale or partial domain
   list fails loudly instead of quietly issuing a single-name cert that the
   public hostname is not on
4. It refuses to deploy a cert that misses a configured name or expires within 24h
5. If the cert changed, it replaces `deploy/ssl/*.pem` (keeping `.bak-<ts>` copies)
   and restarts `tuning-movie-nginx`
6. Each name is verified over real TLS (no `-k`), so a bad chain fails the run

Manual run (idempotent — "not yet due for renewal" is the normal outcome):

```bash
./deploy/scripts/renew-tls-cert.sh
```

## 6) Reboot survival

`restart: unless-stopped` in `docker-compose.yml` does **not** survive a host
reboot under rootless podman, and `podman-restart.service` is disabled. What
actually starts the stack at boot is a systemd **user** unit:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/pod-tuning-movie.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pod-tuning-movie
sudo loginctl enable-linger "$USER"   # or the unit dies at logout
```

The unit runs `podman pod start pod_tuning-movie`. That pod name comes from the
compose project name, which `docker-compose.yml` pins to `tuning-movie` so a
renamed checkout cannot silently break boot recovery.

⚠️ `podman-compose down` **removes the pod and the network**, not just the
containers. Between a `down` and the next `up -d`, the boot unit's `ExecStart`
fails (exit 125) and a reboot comes up with nothing running. To restart without
removing the pod:

```bash
systemctl --user restart pod-tuning-movie
```

Check the three things reboot survival depends on:

```bash
systemctl --user is-enabled pod-tuning-movie.service   # enabled
loginctl show-user "$USER" --property=Linger           # Linger=yes
cat /proc/sys/net/ipv4/ip_unprivileged_port_start      # 80
systemd-run --user --quiet --collect true && echo "user bus OK"   # must exit 0
```

That last one is not a formality — see *Every container start depends on a
working `systemd --user` session* under [Known caveats](#known-caveats).

## 7) Deploy updates (after code changes)

```bash
bash deploy/scripts/deploy-podman.sh
```

This script:

1. requires `.env` to exist
2. creates the runtime directories
3. resolves the source revision — **it pulls only when the tree is clean *and*
   the branch has an upstream.** Otherwise it deploys the working tree as-is and
   says so. `DEPLOY_PULL=0` skips the check entirely.
4. builds the images **while the old site is still serving**
5. stops the containers with `podman-compose down` (which also removes the pod
   and the network — see §6)
6. backs up `apps/backend/data` **and** `apps/backend/.runtime` to
   `backups/tuning-movie-backup-<ts>.tar.gz`, after the stop so the SQLite
   snapshots are consistent. A failed backup aborts the deploy.
7. starts the containers
8. runs `node dist/db/seed.js` and `node dist/db/seedScenarios.js`. **This is
   destructive:** it deletes every row from `booking_seats`, `bookings`, `seats`,
   `showings`, `movies` and `theaters` and rebuilds the scenario template DBs.
   Step 6 is the only thing between this and data loss. `seed.ts` used to end in
   `.catch(console.error)`, so a half-finished re-seed exited 0 and the deploy
   reported success over an empty catalogue — `/health` cannot catch that, it is
   a static literal that never touches the database. `seed.ts` now exits 1, and
   this step additionally asserts a non-zero movie count before continuing.
9. verifies `/health` (must be 200) and reports `/monitor-api/health` by status
   code

## 8) Persistence

SQLite file, in the container:

- `/app/apps/backend/data/tuning-movie.db`

Host bind mounts (relative to the checkout):

- `apps/backend/data` — the database
- `apps/backend/.runtime` — access codes and per-session state; without this a
  rebuild would invalidate every printed card mid-event
- `logs/interaction`, `logs/trace`, `logs/survey` — study corpus
- `logs/demo`, `logs/agent-runtime` — **consented demo recordings**
- `logs/nginx` — nginx access and error logs. Without this mount they live only
  in the nginx container's writable layer, so a recreate erases the record of
  whatever went wrong before it.

Anything written inside a container but not on this list lives in that
container's writable layer and is destroyed by the next `podman-compose down`.

## 9) Rollback

There is no rollback script, and the `localhost/tuning-movie_*:rollback` image
tags on the booth host are hand-made and stale — nothing in this repo creates,
refreshes or consumes them, so do not treat them as a rollback path. Today's
rollback is: restore a `backups/tuning-movie-backup-*.tar.gz` and rebuild from an
older revision.

The tarball covers `apps/backend/data` **and** `apps/backend/.runtime` (the
access-code database and the per-session study DBs). Older tarballs, written
before that widening, contain `apps/backend/data` only — check with `tar -tzf`
before relying on one. When copying a SQLite file by hand, always take
`.db`, `.db-wal` and `.db-shm` together, or use
`sqlite3 <src> ".backup '<dest>'"`: `demo-access-codes.db` routinely carries
a few hundred KB of uncheckpointed WAL, and copying the `.db` alone silently
drops the most recent redemptions.

## 10) Logs and troubleshooting

```bash
podman logs tuning-movie-backend
podman logs tuning-movie-agent
podman logs tuning-movie-nginx
find logs -maxdepth 2 -type f | sort
podman-compose ps
systemctl --user restart pod-tuning-movie   # restart, pod preserved
podman-compose down && podman-compose up -d # full recreate; see the §6 warning
```

If `podman-compose build` fails with
`potentially insufficient UIDs or GIDs available in user namespace`, run setup
again as root — it configures `/etc/subuid` and `/etc/subgid` for the deploy
user:

```bash
sudo bash deploy/scripts/setup-podman.sh
```

Apply an nginx config edit — `deploy/nginx/conf.d` is a read-only bind mount of
the working tree, so a reload is enough and a redeploy is not needed:

```bash
podman exec tuning-movie-nginx nginx -t && podman kill -s HUP tuning-movie-nginx
podman exec tuning-movie-nginx ps -eo pid,etime,args   # workers younger than the edit = reload took
```

Always `nginx -t` first: the container reads the file from the host, so a broken
edit sitting on disk becomes a crash loop the moment anything restarts nginx.

If the app 502s while `podman ps` says the backend is healthy, check this first:

```bash
podman exec tuning-movie-nginx wget -qO- http://backend:3000/health
```

If that succeeds while requests through nginx fail, nginx is holding a stale
address — see *Containers in the pod do not share a network namespace* below.

If you changed network settings and need to recreate the compose network:

```bash
podman network rm tuning-movie-network
podman-compose up -d
```

⚠️ If the change is the **subnet**, `deploy/nginx/conf.d/tuning-movie.conf` must
change in the same commit: its `resolver 10.1.24.1` line pins that subnet's
gateway, which is where aardvark-dns answers and what the containers'
`/etc/resolv.conf` points at. With a stale resolver address nginx starts, passes
`nginx -t`, and fails every proxied request.

(Recreating the network also means recreating the pod — reinstall/restart the
boot unit's target with `podman-compose up -d` before relying on a reboot.)

Security checklist:

- Use a non-172 podman subnet (this repo pins `10.1.24.0/24`, and the `resolver`
  line in `deploy/nginx/conf.d/tuning-movie.conf` pins that subnet's gateway —
  change the two together)
- Publish only 80/443 (this repo does)
- Keep `SPEECH_PREVIEW_ALLOW_ENV_KEY` and `ALLOW_OPERATOR_KEY_FALLBACK` off in
  production; `docker-compose.yml` pins both to `false` for the container
  regardless of `.env`

## Known caveats

These are properties of this deployment, not bugs to be surprised by twice.

**No real client address reaches the app.** Rootless podman's published-port
forwarder rewrites the source address and the backend sets no `trustProxy`, so
nginx logs — and `request.ip` sees — nginx's own container IP for every visitor.
Two consequences:

- `/agent-monitor/` and `/monitor-api/` are guarded by
  `allow 127.0.0.1; allow ::1; deny all`, which therefore matches nothing except
  a caller inside the **nginx container itself**. Containers in the pod do not
  share a network namespace, so a sibling is just another bridge IP to nginx: a
  request from `tuning-movie-agent` is logged as `client: 10.1.24.3` and denied.
  It fails closed, so nothing is exposed, but neither the host nor the other
  containers can reach the monitor through nginx. Probe it directly instead:

  ```bash
  podman exec tuning-movie-agent wget -qO- http://127.0.0.1:3500/health
  podman unshare --rootless-netns curl -s http://10.1.24.3:3500/health   # from the host
  ```

  A plain SSH tunnel does not help: 3500 is unpublished and the `10.1.24.0/24`
  bridge lives inside the rootless network namespace.
- The demo access-code limiter's "per-IP" bucket is one bucket for the whole
  internet, and because the per-IP tier trips at 10 while the global tier needs
  100, ten wrong codes from anyone lock out every visitor for the window length.
  Fixing this needs a source-preserving publish path (host networking, PROXY
  protocol, …) *before* `trustProxy`, since enabling `trustProxy` alone would
  trust a client-supplied `X-Forwarded-For`.

**`VITE_*` values cannot reach a container build.** `.dockerignore` excludes
`**/.env` and no Dockerfile declares a matching `ARG`, so the shipped bundles
always use their compiled-in fallbacks. Changing a `VITE_*` value in `.env`
affects `npm run dev` only.

**The standalone `agent` container cannot join the relay.** `relay.join` for role
`agent` requires a per-session `agentToken`, which only the backend's supervisor
mints for the children it spawns; `AGENT_RELAY_TOKEN` is set in no config file.
The container starts, logs one refusal, and passes its healthcheck anyway. It is
also a `depends_on` of nginx, so removing the service means removing that
dependency in the same change — and `/monitor-api/` lives in this container.

**Containers in the pod do not share a network namespace.** Each has its own
netns and its own bridge IP on `tuning-movie-network`, and that IP changes on
every restart or recreate. Cross-container traffic goes by DNS name, never
`localhost`: from the backend, `http://127.0.0.1:3500/health` is `ECONNREFUSED`
while `http://agent:3500/health` answers. `deploy/nginx/conf.d/tuning-movie.conf`
therefore resolves both peers at run time — `resolver 10.1.24.1 valid=10s
ipv6=off;` plus `proxy_pass http://$backend_upstream…` for the backend, and
`server agent:3500 resolve;` (with a `zone`, which nginx requires for that) for
the monitor upstream. **Do not turn either back into a plain name in an
`upstream` block:** nginx resolves those once at config load, so a backend-only
restart used to 502 every request — with the backend healthy the whole time —
until nginx was reloaded. `valid=10s` adds a small cache rather than bounding
one (aardvark answers with TTL 0), so allow up to 10s of 502s after a recreate.
`resolver_timeout 3s` keeps a dead resolver from parking requests for the 30s
default.

**Every container start depends on a working `systemd --user` session.** Rootless
podman runs each healthcheck as a transient systemd *user* timer. If the user
manager is alive but `/run/user/1000/systemd/private` refuses connections, podman
cannot register that timer and `podman start` **fails for any container that has
a healthcheck** — all three of ours do. The symptom is a 502 site with a backend
that will not start; `systemctl --user restart pod-tuning-movie` fails the same
way, and `podman-compose up -d` does not fail but **hangs** waiting on
`condition: service_healthy`. Escape hatch, no root needed — it rewrites the
healthcheck on the *existing* container, so image, mounts and env survive:

```bash
podman update --no-healthcheck tuning-movie-backend
podman start tuning-movie-backend
```

A container patched that way reports no health status, so nothing can satisfy
`service_healthy` for it. Repair the session (`sudo systemctl restart
user@1000.service`, or log the deploy user out and back in with linger enabled),
then let the next `podman-compose up -d` recreate the container to restore its
healthcheck. Note that a real certificate renewal ends in
`podman restart tuning-movie-nginx`, which is itself a healthchecked start: the
twice-daily cron runs are no-ops, but the ~60-day renewal is not.

**A deploy ships the working tree.** `deploy-podman.sh` prints
`Deploying: <short-sha>`, which names the last commit, not the tree. On a dirty
checkout the sha describes neither the source that gets built nor the image that
was running before.
