#!/usr/bin/env bash
# BugBuster Agent installer — Linux, systemd. Run as root (or via sudo).
#
# Installs the Agent as a real system service, decoupled from any application's own process
# manager: one Agent per host, started once, surviving app deploys/restarts. This is the
# missing piece that made "install a library, install the agent" actually true — before this,
# every integration hand-wired the Agent into its own PM2/systemd config from scratch.
#
# Usage:
#   sudo ./install.sh --api-key <KEY> --backend-url <URL> [options]
#
# Required:
#   --api-key <KEY>          BugBuster API key for this org
#   --backend-url <URL>      e.g. https://backend-yourorg.vercel.app/ingest
#
# Optional:
#   --socket-path <PATH>     default: /var/run/bugbuster/agent.sock
#   --spool-dir <PATH>       default: /var/lib/bugbuster/spool (disk spool on backend outage)
#   --repo-url <URL>         default: https://github.com/kunal-arora-1411/BugBuster.git
#   --commit <SHA|BRANCH>    default: main — pin a specific commit for production stability
#   --install-dir <PATH>     default: /opt/bugbuster/source
#   --user <NAME>            default: bugbuster (created if it doesn't exist)
#
# Safe to re-run: rebuilds in place and restarts the service (upgrade path).

set -euo pipefail

API_KEY=""
BACKEND_URL=""
SOCKET_PATH="/var/run/bugbuster/agent.sock"
SPOOL_DIR="/var/lib/bugbuster/spool"
REPO_URL="https://github.com/kunal-arora-1411/BugBuster.git"
COMMIT="main"
INSTALL_DIR="/opt/bugbuster/source"
SERVICE_USER="bugbuster"

log() { printf '\033[0;34m[bugbuster-agent-install]\033[0m %s\n' "$1"; }
fail() { printf '\033[0;31m[bugbuster-agent-install] ERROR:\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --api-key) API_KEY="$2"; shift 2 ;;
    --backend-url) BACKEND_URL="$2"; shift 2 ;;
    --socket-path) SOCKET_PATH="$2"; shift 2 ;;
    --spool-dir) SPOOL_DIR="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^#//'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Must run as root (try: sudo $0 ...)"
[ -n "$API_KEY" ] || fail "--api-key is required"
[ -n "$BACKEND_URL" ] || fail "--backend-url is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required (>=20) and was not found on PATH"
command -v git >/dev/null 2>&1 || fail "git is required and was not found on PATH"

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >=20 required, found $(node -v)"

command -v pnpm >/dev/null 2>&1 || { log "pnpm not found — installing via corepack"; corepack enable && corepack prepare pnpm@latest --activate; }

log "Fetching BugBuster ($REPO_URL @ $COMMIT) into $INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
git -C "$INSTALL_DIR" checkout --detach "$COMMIT"

log "Installing and building the Agent (and its @bugbuster/types dependency)"
( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile && pnpm --filter @bugbuster/types run build && pnpm --filter @bugbuster/agent run build )

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '$SERVICE_USER'"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

log "Writing config to /etc/bugbuster/agent.env"
mkdir -p /etc/bugbuster
cat > /etc/bugbuster/agent.env <<EOF
BUGBUSTER_AGENT_SOCKET=$SOCKET_PATH
BUGBUSTER_BACKEND_URL=$BACKEND_URL
BUGBUSTER_API_KEY=$API_KEY
BUGBUSTER_AGENT_SPOOL_DIR=$SPOOL_DIR
EOF
chmod 600 /etc/bugbuster/agent.env
chown "$SERVICE_USER":"$SERVICE_USER" /etc/bugbuster/agent.env

mkdir -p "$(dirname "$SOCKET_PATH")" "$SPOOL_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$(dirname "$SOCKET_PATH")" "$SPOOL_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

log "Writing systemd unit to /etc/systemd/system/bugbuster-agent.service"
cat > /etc/systemd/system/bugbuster-agent.service <<EOF
[Unit]
Description=BugBuster Agent
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=/etc/bugbuster/agent.env
ExecStart=$(command -v node) $INSTALL_DIR/packages/agent/dist/index.js
Restart=always
RestartSec=5
# The Agent never holds anything the host can't afford to lose (§7.2 — bounded disk spool,
# no unbounded memory growth), so a hard restart on failure is the correct default.

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bugbuster-agent

log "Done. Verify with:"
echo "    systemctl status bugbuster-agent"
echo "    journalctl -u bugbuster-agent -f"
echo ""
log "Point your app's SDK at socket path: $SOCKET_PATH"
