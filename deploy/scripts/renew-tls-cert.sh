#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR=${APP_DIR:-"$REPO_ROOT"}

# Site settings live in a file so the domain list can change without rewriting
# the cron entry. Values already present in the environment win over the file.
RENEW_ENV=${CERTBOT_RENEW_ENV:-"$APP_DIR/deploy/renew.env"}
if [ -f "$RENEW_ENV" ]; then
  # shellcheck source=/dev/null
  . "$RENEW_ENV"
fi

# CERTBOT_DOMAINS lists every name the certificate must cover, space or comma
# separated; the first one names the lineage. CERTBOT_DOMAIN is the older
# single-name spelling and still works.
DOMAIN_LIST=${CERTBOT_DOMAINS:-${CERTBOT_DOMAIN:-}}
if [ -z "$DOMAIN_LIST" ]; then
  echo "Set CERTBOT_DOMAINS to your deployment domains (e.g. 'example.edu www.example.edu')." >&2
  exit 1
fi
read -r -a DOMAINS <<<"${DOMAIN_LIST//,/ }"

PRIMARY_DOMAIN=${DOMAINS[0]}
CERT_NAME=${CERTBOT_CERT_NAME:-$PRIMARY_DOMAIN}
NGINX_CONTAINER=${NGINX_CONTAINER:-tuning-movie-nginx}

CERTBOT_BASE=${CERTBOT_BASE:-"$APP_DIR/deploy/certbot/state"}
CERTBOT_CONFIG_DIR=${CERTBOT_CONFIG_DIR:-"$CERTBOT_BASE/config"}
CERTBOT_WORK_DIR=${CERTBOT_WORK_DIR:-"$CERTBOT_BASE/work"}
CERTBOT_LOGS_DIR=${CERTBOT_LOGS_DIR:-"$CERTBOT_BASE/logs"}
WEBROOT_DIR=${CERTBOT_WEBROOT_DIR:-"$APP_DIR/deploy/certbot/www"}
DEPLOY_SSL_DIR=${DEPLOY_SSL_DIR:-"$APP_DIR/deploy/ssl"}

mkdir -p "$CERTBOT_CONFIG_DIR" "$CERTBOT_WORK_DIR" "$CERTBOT_LOGS_DIR" "$WEBROOT_DIR" "$DEPLOY_SSL_DIR"

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot is required but was not found." >&2
  exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "podman is required but was not found." >&2
  exit 1
fi

if ! podman ps --format '{{.Names}}' | grep -qx "$NGINX_CONTAINER"; then
  echo "Container $NGINX_CONTAINER is not running. Start nginx before renewing." >&2
  exit 1
fi

# A certificate is only safe to serve if it covers every configured name and is
# not about to expire. Checking that explicitly is what keeps a stale lineage
# from being mistaken for an up-to-date one.
cert_san_names() {
  openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*DNS:\([^[:space:]]*\).*/\1/p' \
    | tr '\n' ' '
}

check_cert() {
  local cert=$1
  local names name

  names=" $(cert_san_names "$cert")"

  for name in "${DOMAINS[@]}"; do
    if [[ "$names" != *" $name "* ]]; then
      echo "Certificate does not cover $name (covers:$names)." >&2
      return 1
    fi
  done

  if ! openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null 2>&1; then
    echo "Certificate $(openssl x509 -in "$cert" -noout -enddate) is expired or expires within 24h." >&2
    return 1
  fi
}

CURRENT_FINGERPRINT=""
if [ -f "$DEPLOY_SSL_DIR/fullchain.pem" ]; then
  CURRENT_FINGERPRINT=$(openssl x509 -in "$DEPLOY_SSL_DIR/fullchain.pem" -noout -fingerprint -sha256 2>/dev/null || true)
fi

# Never narrow the certificate. check_cert() above verifies that the *requested*
# names are covered, which passes trivially when the request itself has lost a
# name -- and the request is assembled from whatever resolves first: the
# environment, then deploy/renew.env. A cron entry written by an older version of
# the installer still exports the singular CERTBOT_DOMAIN=tuning.cs.vt.edu, so if
# deploy/renew.env (gitignored) ever goes missing, this script would ask for one
# name, get a brand-new single-name lineage, pass every check, restart nginx and
# exit 0 -- while https://maestro.cs.vt.edu serves a certificate that does not
# cover it. Nothing downstream would notice. So: whatever the live certificate
# answers for today must still be in the request.
if [ -f "$DEPLOY_SSL_DIR/fullchain.pem" ]; then
  # An unparseable certificate must not read as "no names to protect". Without
  # this, a truncated fullchain.pem (the `cp` below is not atomic, which is how
  # one gets created) yields an empty SAN list, the loop below runs zero times,
  # and the guard passes — after which a narrowed domain list would be deployed
  # and even the closing health check would not notice, because it only probes
  # the names that were requested.
  if ! openssl x509 -in "$DEPLOY_SSL_DIR/fullchain.pem" -noout >/dev/null 2>&1; then
    echo "Refusing to renew: $DEPLOY_SSL_DIR/fullchain.pem exists but openssl cannot parse it." >&2
    echo "Inspect it (and the .bak-* copies beside it) before running again." >&2
    exit 1
  fi
  for deployed_name in $(cert_san_names "$DEPLOY_SSL_DIR/fullchain.pem"); do
    if [[ " ${DOMAINS[*]} " != *" $deployed_name "* ]]; then
      echo "Refusing to renew: the deployed certificate covers $deployed_name, which is not in the requested list (${DOMAINS[*]})." >&2
      echo "Renewing would drop that name. Add it to CERTBOT_DOMAINS in $RENEW_ENV (or in the environment) and run again." >&2
      exit 1
    fi
  done
fi

CERTBOT_ARGS=(
  certonly
  --webroot
  -w "$WEBROOT_DIR"
  --non-interactive
  --agree-tos
  --key-type ecdsa
  --cert-name "$CERT_NAME"
  --keep-until-expiring
  --config-dir "$CERTBOT_CONFIG_DIR"
  --work-dir "$CERTBOT_WORK_DIR"
  --logs-dir "$CERTBOT_LOGS_DIR"
)

for domain in "${DOMAINS[@]}"; do
  CERTBOT_ARGS+=(-d "$domain")
done

if [ ! -d "$CERTBOT_CONFIG_DIR/accounts" ]; then
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

certbot "${CERTBOT_ARGS[@]}"

NEW_CERT="$CERTBOT_CONFIG_DIR/live/$CERT_NAME/fullchain.pem"
NEW_KEY="$CERTBOT_CONFIG_DIR/live/$CERT_NAME/privkey.pem"

if [ ! -f "$NEW_CERT" ] || [ ! -f "$NEW_KEY" ]; then
  echo "Expected renewed certificate files were not created." >&2
  exit 1
fi

# When certbot cannot reuse the lineage it was asked for it silently writes a
# "<name>-0001" one instead, leaving the path above pointing at an old
# certificate. Refuse to go any further in that case.
if ! check_cert "$NEW_CERT"; then
  echo "Lineage $CERT_NAME is stale. Look for suffixed copies in $CERTBOT_CONFIG_DIR/live and repair $CERTBOT_CONFIG_DIR/renewal/$CERT_NAME.conf." >&2
  exit 1
fi

NEW_FINGERPRINT=$(openssl x509 -in "$NEW_CERT" -noout -fingerprint -sha256)

if [ "$NEW_FINGERPRINT" != "$CURRENT_FINGERPRINT" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)

  if [ -f "$DEPLOY_SSL_DIR/fullchain.pem" ]; then
    cp "$DEPLOY_SSL_DIR/fullchain.pem" "$DEPLOY_SSL_DIR/fullchain.pem.bak-$TIMESTAMP"
  fi

  if [ -f "$DEPLOY_SSL_DIR/privkey.pem" ]; then
    cp "$DEPLOY_SSL_DIR/privkey.pem" "$DEPLOY_SSL_DIR/privkey.pem.bak-$TIMESTAMP"
  fi

  cp "$NEW_CERT" "$DEPLOY_SSL_DIR/fullchain.pem"
  cp "$NEW_KEY" "$DEPLOY_SSL_DIR/privkey.pem"
  chmod 644 "$DEPLOY_SSL_DIR/fullchain.pem"
  chmod 600 "$DEPLOY_SSL_DIR/privkey.pem"

  podman restart "$NGINX_CONTAINER" >/dev/null
  echo "Deployed a renewed certificate and restarted $NGINX_CONTAINER."
else
  echo "Certificate is still current; no deployment change was needed."
fi

# Validate for real -- no -k. An expired chain or a name nginx cannot answer for
# now fails the run instead of being reported as a success.
for domain in "${DOMAINS[@]}"; do
  curl -fsS --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null
  echo "HTTPS health check succeeded for $domain."
done
