#!/bin/bash
set -e

# TUNING-MOVIE Podman Deployment Script

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR=${APP_DIR:-"$REPO_ROOT"}
BACKUP_DIR=${BACKUP_DIR:-"$APP_DIR/backups"}

echo -e "${GREEN}=== TUNING-MOVIE Podman Deploy ===${NC}"
echo "Application Directory: $APP_DIR"
echo ""

if [ ! -d "$APP_DIR" ]; then
  echo -e "${RED}Error: $APP_DIR does not exist${NC}"
  exit 1
fi

cd "$APP_DIR"

echo -e "${YELLOW}[1/9] Checking required environment file...${NC}"
if [ ! -f ".env" ]; then
  echo -e "${RED}Error: .env file is required but was not found in $APP_DIR${NC}"
  if [ -f ".env.example" ]; then
    echo "Create it first: cp .env.example .env"
  fi
  exit 1
fi

echo -e "${YELLOW}[2/9] Ensuring runtime directories...${NC}"
mkdir -p apps/backend/data
mkdir -p logs/interaction
mkdir -p logs/trace
mkdir -p logs/survey/post-study
mkdir -p logs/survey/per-trial
# Consented demo recordings. These are bind mounts in docker-compose.yml; if the
# host directory is missing, podman creates it root-owned inside the container's
# namespace and the recordings are lost on the next `down`.
mkdir -p logs/demo/interaction
mkdir -p logs/demo/trace
mkdir -p logs/agent-runtime
# nginx's access/error logs are bind-mounted too, so a recreate does not erase
# the record of whatever went wrong before it.
mkdir -p logs/nginx
mkdir -p deploy/ssl

echo -e "${YELLOW}[3/9] Resolving source revision...${NC}"
# This repo is deployed from a working tree, not from a pristine release
# checkout, so pulling is opt-in rather than automatic:
#
#   - `git pull --ff-only || git pull` aborts the whole deploy on a branch with
#     no upstream (the second pull fails too, and `set -e` takes the script
#     down) — after the old containers were already stopped, in the previous
#     ordering.
#   - Pulling over a dirty tree either refuses or merges on top of local edits.
#     Neither belongs in an unattended production step.
#
# So: pull only when it is unambiguously safe, and otherwise say plainly what is
# being deployed. Set DEPLOY_PULL=0 to skip the check entirely.
if [ ! -d ".git" ]; then
  echo "Not a git repository — deploying the directory as-is."
elif [ "${DEPLOY_PULL:-1}" != "1" ]; then
  echo "DEPLOY_PULL=0 — skipping git pull."
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}Working tree has uncommitted changes — deploying them as-is, not pulling.${NC}"
    git status --short | sed 's/^/    /'
  elif ! git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    echo -e "${YELLOW}Branch '$BRANCH' tracks no upstream — deploying local commits as-is.${NC}"
  else
    echo "Pulling $BRANCH from $(git rev-parse --abbrev-ref '@{upstream}')..."
    git pull --ff-only
  fi
fi
echo "Deploying: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown') on $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

# Build before stopping anything. A build failure is the most likely way a
# deploy fails, and in the previous ordering it left the site down with the old
# images already torn down and no path back.
echo -e "${YELLOW}[4/9] Building images (site still serving)...${NC}"
podman-compose build

echo -e "${YELLOW}[5/9] Stopping old containers...${NC}"
podman-compose down || podman stop tuning-movie-backend tuning-movie-agent tuning-movie-nginx 2>/dev/null || true

# Backed up here rather than at the top: the containers are stopped, so the
# SQLite file is not being written and the snapshot is consistent. It is still
# before the destructive part — the seeds below drop and rebuild the catalogue.
echo -e "${YELLOW}[6/9] Creating backup...${NC}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
if [ -d "apps/backend/data" ]; then
  BACKUP_FILE="$BACKUP_DIR/tuning-movie-backup-$TIMESTAMP.tar.gz"
  # .runtime as well as data: it holds the redeemed-access-code database and the
  # per-session study DBs, which the re-seed below and a rollback both touch. It
  # is safe to tar here because the containers are already stopped, so the
  # SQLite files and their -wal companions are quiescent.
  BACKUP_PATHS="apps/backend/data"
  [ -d "apps/backend/.runtime" ] && BACKUP_PATHS="$BACKUP_PATHS apps/backend/.runtime"
  # No `|| true`: a failed backup immediately before a destructive re-seed is a
  # reason to stop, not something to report as success.
  # shellcheck disable=SC2086
  tar -czf "$BACKUP_FILE" $BACKUP_PATHS
  echo "Backup created: $BACKUP_FILE ($BACKUP_PATHS)"
fi

echo -e "${YELLOW}[7/9] Starting containers...${NC}"
podman-compose up -d

echo -e "${YELLOW}[8/9] Running database seeds...${NC}"
# The production image is installed with --omit=dev (no tsx), so run the
# compiled seeds instead of the npm scripts.
podman exec -w /app/apps/backend tuning-movie-backend node dist/db/seed.js
podman exec -w /app/apps/backend tuning-movie-backend node dist/db/seedScenarios.js
# seed.js deletes the whole catalogue before rebuilding it, and it used to end in
# `.catch(console.error)` — a partial run exited 0 and the deploy reported
# success over an empty catalogue. That is fixed in seed.ts, but /health is a
# static literal that never touches the DB, so assert the rows exist here too.
MOVIE_COUNT=$(podman exec -w /app/apps/backend tuning-movie-backend node -e "
  const db = require('better-sqlite3')(process.env.DATABASE_URL);
  process.stdout.write(String(db.prepare('select count(*) c from movies').get().c));
" 2>/dev/null || echo 0)
if [ "${MOVIE_COUNT:-0}" -lt 1 ]; then
  echo -e "${RED}Seeding left the movie catalogue empty (count=$MOVIE_COUNT). Restore $BACKUP_FILE.${NC}"
  exit 1
fi
echo -e "${GREEN}Database seeding complete ($MOVIE_COUNT movies).${NC}"

echo -e "${YELLOW}[9/9] Verifying deployment...${NC}"
sleep 5

if podman ps --format '{{.Names}}' | grep -q '^tuning-movie-backend$' && \
   podman ps --format '{{.Names}}' | grep -q '^tuning-movie-agent$' && \
   podman ps --format '{{.Names}}' | grep -q '^tuning-movie-nginx$'; then
  echo -e "${GREEN}Containers are running.${NC}"
else
  echo -e "${RED}Deployment failed: container not running.${NC}"
  echo "Check logs:"
  echo "  podman logs tuning-movie-backend"
  echo "  podman logs tuning-movie-agent"
  echo "  podman logs tuning-movie-nginx"
  exit 1
fi

# Checked by status code, not by `curl -f`: -f does not fail on a 3xx, and port
# 80 redirects everything except /health and the ACME path. The old
# `-fsSk https:// || -fsS http://` form therefore reported "passed" for a bare
# 301 that never reached the app.
http_code() {
  curl -s -o /dev/null -w '%{http_code}' -k --max-time 10 "$1" 2>/dev/null || echo 000
}

if command -v curl >/dev/null 2>&1; then
  HEALTH_CODE=$(http_code https://127.0.0.1/health)
  if [ "$HEALTH_CODE" != "200" ]; then
    HEALTH_CODE=$(http_code http://127.0.0.1/health)
  fi
  if [ "$HEALTH_CODE" = "200" ]; then
    echo -e "${GREEN}Health check passed.${NC}"
  else
    echo -e "${RED}Health check failed (/health returned HTTP $HEALTH_CODE).${NC}"
    exit 1
  fi

  MONITOR_CODE=$(http_code https://127.0.0.1/monitor-api/health)
  if [ "$MONITOR_CODE" = "200" ]; then
    echo -e "${GREEN}Monitor API check passed.${NC}"
  elif [ "$MONITOR_CODE" = "403" ]; then
    # Not a monitor fault, and not "the monitor is disabled": nginx guards
    # /monitor-api/ with `allow 127.0.0.1; deny all`, and under rootless podman
    # the published-port forwarder rewrites the source address, so nginx sees
    # its own container IP for every caller — including this loopback request.
    # The allow-list matches only a caller inside the nginx container itself;
    # pod siblings have their own network namespaces and are denied too.
    # Probe the monitor directly instead:
    #   podman exec tuning-movie-agent wget -qO- http://127.0.0.1:3500/health
    echo -e "${YELLOW}Monitor API returned 403 — nginx's localhost allow-list, not a monitor fault (expected under rootless podman).${NC}"
  else
    echo -e "${YELLOW}Monitor API not reachable (/monitor-api/health returned HTTP $MONITOR_CODE) — the monitor may be off or crashed.${NC}"
  fi
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo "Useful commands:"
echo "  podman logs -f tuning-movie-backend"
echo "  podman logs -f tuning-movie-agent"
echo "  podman logs -f tuning-movie-nginx"
echo "  systemctl --user restart pod-tuning-movie   # restart without removing the pod"
echo "  podman-compose down   # removes the pod AND the network — run 'podman-compose up -d' before the next reboot, or the boot unit fails"
