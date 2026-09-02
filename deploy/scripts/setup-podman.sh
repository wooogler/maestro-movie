#!/bin/bash
set -e

# TUNING-MOVIE Podman Setup Script for Rocky Linux

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DEPLOY_USER=${DEPLOY_USER:-"$USER"}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR=${APP_DIR:-"$REPO_ROOT"}

echo -e "${GREEN}=== TUNING-MOVIE Podman Setup ===${NC}"
echo -e "${YELLOW}Deploy User:${NC} $DEPLOY_USER"
echo -e "${YELLOW}App Directory:${NC} $APP_DIR"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)."
  exit 1
fi

echo -e "${GREEN}[1/8] Updating system packages...${NC}"
dnf update -y

echo -e "${GREEN}[2/8] Installing base packages...${NC}"
dnf install -y epel-release
dnf install -y git curl wget vim htop

echo -e "${GREEN}[3/8] Installing Podman stack...${NC}"
dnf install -y podman podman-compose
podman --version
podman-compose --version || true

echo -e "${GREEN}[4/8] Configuring rootless UID/GID mappings...${NC}"
if ! grep -q "^${DEPLOY_USER}:" /etc/subuid 2>/dev/null; then
  usermod --add-subuids 100000-165535 "$DEPLOY_USER"
fi
if ! grep -q "^${DEPLOY_USER}:" /etc/subgid 2>/dev/null; then
  usermod --add-subgids 100000-165535 "$DEPLOY_USER"
fi

echo -e "${GREEN}[5/8] Configuring firewall...${NC}"
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi

echo -e "${GREEN}[6/8] Configuring SELinux for containers...${NC}"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != "Disabled" ]; then
  setsebool -P container_manage_cgroup on
  setsebool -P httpd_can_network_connect on
fi

# Without this, rootless nginx cannot bind 80/443 and the whole stack comes up
# with the web tier dead. The live host has it in /etc/sysctl.d/99-rootless-ports.conf
# and this script never set it -- so following this guide on a fresh host left
# nginx unable to start, with nothing in the docs to explain why.
echo -e "${GREEN}[7/8] Allowing rootless binds to 80/443...${NC}"
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/99-rootless-ports.conf
sysctl --system >/dev/null
cat /proc/sys/net/ipv4/ip_unprivileged_port_start

echo -e "${GREEN}[8/8] Preparing app directories...${NC}"
mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/apps/backend/data"
mkdir -p "$APP_DIR/deploy/ssl"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

echo ""
echo -e "${GREEN}Setup complete.${NC}"
echo "Next:"
echo "1) Copy repository to $APP_DIR"
echo "2) Put TLS cert files in $APP_DIR/deploy/ssl/{fullchain.pem,privkey.pem} -- nginx will not start without them"
echo "3) cd $APP_DIR && podman-compose build"
echo "4) podman-compose up -d"
echo "5) Install the boot unit so the stack survives a reboot:"
echo "     mkdir -p ~/.config/systemd/user"
echo "     cp $APP_DIR/deploy/systemd/pod-tuning-movie.service ~/.config/systemd/user/"
echo "     systemctl --user daemon-reload && systemctl --user enable --now pod-tuning-movie"
echo "     sudo loginctl enable-linger $DEPLOY_USER"
echo "6) Install TLS renewal: $APP_DIR/deploy/scripts/install-cert-renew-cron.sh"
