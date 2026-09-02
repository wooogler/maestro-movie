#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR=${APP_DIR:-"$REPO_ROOT"}

# Read the same settings file renew-tls-cert.sh reads, in the same way. Without
# this the documented flow -- put the domains in deploy/renew.env, then run this
# installer -- exited 1, because nothing here ever opened that file.
RENEW_ENV=${CERTBOT_RENEW_ENV:-"$APP_DIR/deploy/renew.env"}
if [ -f "$RENEW_ENV" ]; then
  # shellcheck source=/dev/null
  . "$RENEW_ENV"
fi

CERTBOT_DOMAINS=${CERTBOT_DOMAINS:-${CERTBOT_DOMAIN:-}}
if [ -z "$CERTBOT_DOMAINS" ]; then
  echo "Set CERTBOT_DOMAINS to your deployment domains (e.g. 'example.edu www.example.edu')," >&2
  echo "either in $RENEW_ENV or in the environment." >&2
  exit 1
fi

CERTBOT_BASE=${CERTBOT_BASE:-"$APP_DIR/deploy/certbot/state"}
CERTBOT_CONFIG_DIR=${CERTBOT_CONFIG_DIR:-"$CERTBOT_BASE/config"}
CERTBOT_WORK_DIR=${CERTBOT_WORK_DIR:-"$CERTBOT_BASE/work"}
CERTBOT_LOGS_DIR=${CERTBOT_LOGS_DIR:-"$CERTBOT_BASE/logs"}
WEBROOT_DIR=${CERTBOT_WEBROOT_DIR:-"$APP_DIR/deploy/certbot/www"}
CRON_LOG_DIR=${CRON_LOG_DIR:-"$APP_DIR/deploy/certbot/logs"}

mkdir -p "$CERTBOT_CONFIG_DIR" "$CERTBOT_WORK_DIR" "$CERTBOT_LOGS_DIR" "$WEBROOT_DIR" "$CRON_LOG_DIR"

# The domain list is deliberately NOT baked into the entry. renew-tls-cert.sh
# sources deploy/renew.env itself, and an exported value wins over that file's
# `:=` defaults -- so baking it in here is what used to invert the documented
# promise that renew.env is where domains are changed without reinstalling cron.
ENTRY="23 3,15 * * * cd $APP_DIR && $APP_DIR/deploy/scripts/renew-tls-cert.sh >> $CRON_LOG_DIR/renew-cron.log 2>&1 # tuning-movie-cert-renew"
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

if crontab -l >"$TMPFILE" 2>/dev/null; then
  grep -v 'tuning-movie-cert-renew' "$TMPFILE" >"$TMPFILE.filtered" || true
  mv "$TMPFILE.filtered" "$TMPFILE"
fi

printf '%s\n' "$ENTRY" >>"$TMPFILE"
crontab "$TMPFILE"

echo "Installed cron entry:"
echo "$ENTRY"
echo ""
echo "Domains come from $RENEW_ENV at run time: $CERTBOT_DOMAINS"
echo "That file is gitignored and load-bearing -- keep it, or the renewal refuses to run."
