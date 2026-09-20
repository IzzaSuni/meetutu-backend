#!/usr/bin/env bash
#
# One command to stand the backend up on a fresh Debian/Ubuntu VPS: installs
# Docker and Caddy, clones the repo, writes .env, starts the container, binds
# the domain with automatic TLS, and verifies the result.
#
# Re-running it is the update path — it pulls, rebuilds, and restarts while
# leaving the existing .env and the data volume alone.
#
#   curl -fsSL https://raw.githubusercontent.com/IzzaSuni/meetutu-backend/main/deploy/bootstrap.sh -o bootstrap.sh
#   API_DOMAIN=api.example.com FRONTEND_ORIGIN=https://app.example.com bash bootstrap.sh
#
# Anything not passed in the environment is prompted for.

set -euo pipefail

REPO_URL="https://github.com/IzzaSuni/meetutu-backend.git"
APP_DIR="${APP_DIR:-$HOME/meetutu-backend}"
CADDYFILE="/etc/caddy/Caddyfile"
# An audio part is uploaded as a single body, well past Caddy's 10 MB default.
MAX_UPLOAD="512MB"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[1;31merror: %s\033[0m\n' "$*" >&2
  exit 1
}

# Everything that touches /etc or the Docker socket goes through this, so the
# script works both as root and as a sudo-capable user.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null || die "this needs root or sudo"
  SUDO="sudo"
fi

require_debian() {
  command -v apt-get >/dev/null || die "this script expects Debian or Ubuntu (no apt-get found)"
}

# Prompts for a value only when the environment did not supply one. The second
# argument hides the input, for anything that should not land in the scrollback
# or the shell history.
ask() {
  local name="$1"
  local prompt="$2"
  local secret="${3:-}"
  # Declared on its own line: bash creates every name in a single `local`
  # before assigning any of them, so `${!name}` on that line reads an empty
  # `name` and fails with "invalid indirect expansion".
  local value="${!name:-}"
  if [ -n "$value" ]; then
    return
  fi
  if [ ! -t 0 ]; then
    die "$name is not set and there is no terminal to ask on"
  fi
  if [ -n "$secret" ]; then
    read -rsp "$prompt: " value
    echo
  else
    read -rp "$prompt: " value
  fi
  [ -n "$value" ] || die "$name cannot be empty"
  printf -v "$name" '%s' "$value"
}

collect_settings() {
  ask API_DOMAIN "Domain for this API (e.g. api.meetutu.dev)"
  ask FRONTEND_ORIGIN "Frontend origin allowed by CORS (e.g. https://meetutu.example.workers.dev)"
  AUTH_USERNAME="${AUTH_USERNAME:-admin}"
  FRONTEND_ORIGIN="${FRONTEND_ORIGIN%/}"

  case "$FRONTEND_ORIGIN" in
    http://* | https://*) ;;
    *) die "FRONTEND_ORIGIN must include the scheme, e.g. https://$FRONTEND_ORIGIN" ;;
  esac
}

check_dns() {
  log "Checking that $API_DOMAIN points here"
  local resolved public
  resolved="$(getent ahostsv4 "$API_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
  public="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"

  if [ -z "$resolved" ]; then
    warn "$API_DOMAIN does not resolve yet — Caddy cannot get a certificate until it does"
  elif [ -n "$public" ] && [ "$resolved" != "$public" ]; then
    warn "$API_DOMAIN resolves to $resolved but this host is $public (fine behind a proxy, otherwise fix the A record)"
  else
    echo "$API_DOMAIN -> $resolved"
  fi
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    echo "Docker with the compose plugin is already installed"
    return
  fi

  log "Installing Docker from Docker's own apt repository"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" |
    $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
    $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
}

install_caddy() {
  if command -v caddy >/dev/null; then
    echo "Caddy is already installed"
    return
  fi

  log "Installing Caddy (it obtains and renews the TLS certificate itself)"
  $SUDO apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt |
    $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq caddy
}

sync_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    log "Updating $APP_DIR"
    git -C "$APP_DIR" pull --ff-only
  else
    log "Cloning into $APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
  fi
}

write_env() {
  local env_file="$APP_DIR/.env"

  if [ -f "$env_file" ]; then
    log "Keeping the existing .env (delete it to be asked again)"
    # CORS is the one value worth re-checking: pointing the frontend at a new
    # origin without updating it fails in the browser, not in the logs.
    if ! grep -q "^CORS_ORIGINS=$FRONTEND_ORIGIN$" "$env_file"; then
      warn "CORS_ORIGINS in .env does not match $FRONTEND_ORIGIN — update it if the frontend moved"
    fi
    return
  fi

  ask AUTH_PASSWORD "Password for the meetutu login (user: $AUTH_USERNAME)" secret
  ask OPENROUTER_API_KEY "OpenRouter API key (https://openrouter.ai/keys)" secret

  log "Writing $env_file"
  umask 077
  cat >"$env_file" <<EOF
# Written by deploy/bootstrap.sh. Keep this file out of git and off backups
# that are less protected than the server itself.
AUTH_USERNAME=$AUTH_USERNAME
AUTH_PASSWORD=$AUTH_PASSWORD
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
AI_PROVIDER=openrouter
OPENROUTER_MODEL=google/gemini-3.8-flash
PORT=8787
HOST=0.0.0.0
DATA_DIR=/data
CORS_ORIGINS=$FRONTEND_ORIGIN
EOF
  chmod 600 "$env_file"
}

start_stack() {
  log "Building and starting the container"
  (cd "$APP_DIR" && $SUDO docker compose up -d --build)
}

configure_caddy() {
  log "Binding $API_DOMAIN to the container"
  $SUDO tee "$CADDYFILE" >/dev/null <<EOF
$API_DOMAIN {
	request_body {
		max_size $MAX_UPLOAD
	}
	reverse_proxy 127.0.0.1:8787
}
EOF
  $SUDO systemctl enable --now caddy
  $SUDO systemctl reload caddy
}

verify() {
  log "Verifying"

  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 5 http://127.0.0.1:8787/api/health >/dev/null; then
      echo "container: healthy"
      break
    fi
    [ "$attempt" -eq 20 ] && die "the container never answered /api/health — check: $SUDO docker compose -f $APP_DIR/docker-compose.yml logs"
    sleep 3
  done

  # The first HTTPS request is also what triggers certificate issuance, so give
  # it a few tries before calling it a failure.
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 10 "https://$API_DOMAIN/api/health" >/dev/null; then
      echo "https://$API_DOMAIN: healthy"
      break
    fi
    [ "$attempt" -eq 20 ] && die "no answer over HTTPS — check DNS and: $SUDO journalctl -u caddy -n 50"
    sleep 5
  done

  local cors
  cors="$(curl -fsS -o /dev/null -D - --max-time 10 -X OPTIONS "https://$API_DOMAIN/api/sessions" \
    -H "Origin: $FRONTEND_ORIGIN" \
    -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: authorization' 2>/dev/null |
    tr -d '\r' | grep -i '^access-control-allow-origin:' || true)"

  if [ -n "$cors" ]; then
    echo "CORS preflight: ${cors#*: }"
  else
    warn "the CORS preflight did not return an allow-origin header — the browser will block the frontend"
  fi
}

main() {
  require_debian
  collect_settings
  check_dns
  install_docker
  install_caddy
  sync_repo
  write_env
  start_stack
  configure_caddy
  verify

  cat <<EOF

$(printf '\033[1;32mDone.\033[0m') The API is live at https://$API_DOMAIN

Point the frontend at it, in the meetutu (frontend) repo:

  echo 'VITE_API_BASE_URL=https://$API_DOMAIN' > .env.production
  pnpm build && npx wrangler deploy

Day to day, from $APP_DIR:

  $SUDO docker compose logs -f     # what the pipeline is doing
  $SUDO docker compose restart     # after editing .env
  bash deploy/bootstrap.sh         # pull, rebuild, restart

EOF
}

main "$@"
