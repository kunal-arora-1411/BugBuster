#!/usr/bin/env bash
# Removes what install.sh set up: the systemd service, its config, and (optionally) the source
# checkout and service user. Run as root.

set -euo pipefail

INSTALL_DIR="/opt/bugbuster/source"
SERVICE_USER="bugbuster"
PURGE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --purge) PURGE=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--install-dir <path>] [--user <name>] [--purge]"
      echo "  --purge  also delete the source checkout and the service user"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Must run as root" >&2; exit 1; }

systemctl disable --now bugbuster-agent 2>/dev/null || true
rm -f /etc/systemd/system/bugbuster-agent.service
systemctl daemon-reload
rm -f /etc/bugbuster/agent.env

if [ "$PURGE" = true ]; then
  rm -rf "$INSTALL_DIR"
  id -u "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" || true
fi

echo "BugBuster Agent uninstalled.$([ "$PURGE" = true ] && echo " Source checkout and service user removed.")"
