#!/usr/bin/env bash
#
# One command to stand the backend up on a fresh Debian/Ubuntu VPS: installs the
# runtime and Caddy, clones the repo, writes .env, starts the server, binds the
# domain with automatic TLS, and verifies the result.
#
# It runs the server in Docker where Docker works, and natively under pm2 where
# it does not — many cheap "VPSes" are themselves containers. RUNTIME=docker or
# RUNTIME=node overrides that choice.
#
# Re-running it is the update path — it pulls, rebuilds, and restarts while
# leaving the existing .env and the data alone.
#
#   curl -fsSL https://raw.githubusercontent.com/IzzaSuni/meetutu-backend/main/deploy/bootstrap.sh -o bootstrap.sh
#   API_DOMAIN=api.example.com FRONTEND_ORIGIN=https://app.example.com bash bootstrap.sh
#
# Anything not passed in the environment is prompted for.

set -euo pipefail

REPO_URL="https://github.com/IzzaSuni/meetutu-backend.git"
APP_DIR="${APP_DIR:-$HOME/meetutu-backend}"
SERVICE_NAME="meetutu-backend"
# auto | docker | node. Plenty of cheap "VPSes" are themselves containers, where
# Docker cannot run; auto notices that and installs the server natively.
RUNTIME="${RUNTIME:-auto}"
CADDYFILE="/etc/caddy/Caddyfile"
SITE_DIR="/etc/caddy/conf.d"
SITE_IMPORT="import $SITE_DIR/*.caddy"
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

# Plenty of cheap VPSes are LXC/OpenVZ containers where systemd is installed but
# is not PID 1, and there `systemctl enable --now` refuses with "--now cannot be
# used when systemd is not running".
if [ -d /run/systemd/system ]; then
  HAS_SYSTEMD=1
else
  HAS_SYSTEMD=0
fi

# Enables a service at boot and starts it now, on either init system.
start_service() {
  local name="$1"

  if [ "$HAS_SYSTEMD" -eq 1 ]; then
    $SUDO systemctl enable --now "$name"
    return
  fi

  [ -x "/etc/init.d/$name" ] || return 1
  $SUDO update-rc.d "$name" defaults >/dev/null 2>&1 || true
  $SUDO service "$name" start || $SUDO "/etc/init.d/$name" start
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

# Names the containerization this host runs under, or "none" on real hardware
# or a full VM.
detect_container() {
  if [ -f /.dockerenv ]; then
    echo docker
    return
  fi
  if command -v systemd-detect-virt >/dev/null; then
    local virt
    virt="$(systemd-detect-virt --container 2>/dev/null || true)"
    if [ -n "$virt" ] && [ "$virt" != none ]; then
      echo "$virt"
      return
    fi
  fi
  if grep -qaE '(docker|lxc|containerd)' /proc/1/cgroup 2>/dev/null; then
    echo container
  else
    echo none
  fi
}

choose_runtime() {
  if [ "$RUNTIME" = auto ]; then
    local virt
    virt="$(detect_container)"
    if [ "$virt" != none ] && ! $SUDO docker info >/dev/null 2>&1; then
      warn "this host is itself a $virt container, where Docker generally cannot run — installing the server natively instead (set RUNTIME=docker to insist)"
      RUNTIME=node
    else
      RUNTIME=docker
    fi
  fi

  case "$RUNTIME" in
    # In Docker, 0.0.0.0 is the container's own network and compose publishes it
    # on 127.0.0.1 only. Natively there is no such wrapper, so binding 0.0.0.0
    # would expose the plain-HTTP API on :8787 to the internet, next to the TLS
    # one Caddy serves. Only the loopback interface should be listening.
    docker)
      DATA_DIR=/data
      BIND_HOST=0.0.0.0
      ;;
    node)
      DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
      BIND_HOST=127.0.0.1
      ;;
    *) die "RUNTIME must be auto, docker or node (got '$RUNTIME')" ;;
  esac

  log "Runtime: $RUNTIME"
}

DOCKERD_LOG="/var/log/dockerd.log"

# Waits for the daemon to accept connections. Starting it returns long before
# the socket is ready.
docker_ready() {
  local attempt
  for attempt in $(seq 1 "${1:-10}"); do
    $SUDO docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Last resort when the init script will not work: run the daemon directly.
# Containers commonly reject the `ulimit` the SysV script sets, and they just as
# commonly cannot use overlay2, so a vfs retry follows if the log says so.
start_dockerd_directly() {
  command -v dockerd >/dev/null || return 1

  warn "starting dockerd directly, logging to $DOCKERD_LOG"
  $SUDO sh -c "nohup dockerd >>'$DOCKERD_LOG' 2>&1 &"
  docker_ready 10 && return 0

  if $SUDO grep -qiE 'overlay|storage.driver|failed to mount' "$DOCKERD_LOG" 2>/dev/null; then
    warn "overlay2 is unavailable in this container — retrying with the vfs storage driver (slower, more disk)"
    $SUDO sh -c "nohup dockerd --storage-driver=vfs >>'$DOCKERD_LOG' 2>&1 &"
    docker_ready 10 && return 0
  fi

  return 1
}

ensure_docker_running() {
  $SUDO docker info >/dev/null 2>&1 && return

  [ "$HAS_SYSTEMD" -eq 1 ] || warn "systemd is not running on this host (a container VPS?) — using SysV init"

  if start_service docker && docker_ready 10; then
    return
  fi

  start_dockerd_directly && return

  $SUDO tail -n 15 "$DOCKERD_LOG" 2>/dev/null || true
  die "the Docker daemon would not start; the last lines of $DOCKERD_LOG are above"
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    echo "Docker with the compose plugin is already installed"
    ensure_docker_running
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
  ensure_docker_running
}

# Names the process already listening on :443, empty if nothing is. A VPS that
# already serves another site is the normal case, and quietly taking its port
# (or its config file) away from it would take that site down.
port443_owner() {
  $SUDO ss -tlnpH 2>/dev/null | awk '$4 ~ /:443$/' | grep -oE '"[^"]+"' | head -1 | tr -d '"'
}

install_caddy() {
  local owner
  owner="$(port443_owner)"

  if [ -n "$owner" ] && [ "$owner" != "caddy" ]; then
    die "port 443 is already served by '$owner'. Add a vhost for $API_DOMAIN to it
       pointing at 127.0.0.1:8787 (deploy/nginx.conf.example is a working
       template), or stop it first. The container is unaffected either way."
  fi

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
    if [ "$RUNTIME" = node ] && grep -q '^HOST=0\.0\.0\.0$' "$env_file"; then
      warn "HOST=0.0.0.0 in .env exposes the plain-HTTP API on :8787 to the internet — set HOST=127.0.0.1 so only Caddy can reach it"
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
HOST=$BIND_HOST
DATA_DIR=$DATA_DIR
CORS_ORIGINS=$FRONTEND_ORIGIN
EOF
  chmod 600 "$env_file"
}

# Reads .env into the environment without sourcing it, so a password containing
# spaces or shell metacharacters survives intact.
load_env() {
  local line key
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    export "$key=${line#*=}"
  done <"$APP_DIR/.env"
}

start_stack() {
  log "Building and starting the container"
  (cd "$APP_DIR" && $SUDO docker compose up -d --build)
}

install_node() {
  local major=0
  command -v node >/dev/null && major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 22 ]; then
    echo "Node $(node -v) is already installed"
  else
    log "Installing Node 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y -qq nodejs
  fi

  # pnpm-workspace.yaml grants better-sqlite3 permission to run its build script
  # with the `allowBuilds` key, which only pnpm 12 understands. An older pnpm
  # ignores it, skips the build, and the server then dies on a missing binding.
  local pnpm_major=0
  command -v pnpm >/dev/null && pnpm_major="$(pnpm --version 2>/dev/null | cut -d. -f1)"
  if [ "${pnpm_major:-0}" -lt 12 ]; then
    log "Installing pnpm 12"
    $SUDO npm install -g pnpm@12 >/dev/null
  fi

  command -v pm2 >/dev/null || $SUDO npm install -g pm2 >/dev/null
  # better-sqlite3 compiles from source whenever no prebuilt binary matches.
  $SUDO apt-get install -y -qq python3 make g++
}

start_native() {
  log "Building the server"
  (cd "$APP_DIR" && pnpm install --frozen-lockfile && pnpm build)

  mkdir -p "$DATA_DIR"
  load_env

  log "Starting it under pm2"
  # --update-env re-reads the environment we just loaded, so an .env edit takes
  # effect on the next run of this script rather than needing a manual delete.
  if pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
    (cd "$APP_DIR" && pm2 restart "$SERVICE_NAME" --update-env)
  else
    (cd "$APP_DIR" && pm2 start dist/server.js --name "$SERVICE_NAME" --update-env)
  fi
  pm2 save >/dev/null

  # pm2's own startup integration needs systemd; on a container host cron is
  # what is left to bring it back after a reboot.
  if [ "$HAS_SYSTEMD" -eq 1 ]; then
    $SUDO env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null || true
  elif ! crontab -l 2>/dev/null | grep -q 'pm2 resurrect'; then
    (
      crontab -l 2>/dev/null
      echo "@reboot $(command -v pm2) resurrect"
    ) | crontab -
    echo "Added an @reboot pm2 resurrect entry"
  fi
}

configure_caddy() {
  log "Binding $API_DOMAIN to the API on 127.0.0.1:8787"

  # Our site goes in its own file under conf.d and the main Caddyfile only gains
  # an import line, so a Caddy that is already serving other sites keeps them.
  $SUDO mkdir -p "$SITE_DIR"
  $SUDO tee "$SITE_DIR/meetutu.caddy" >/dev/null <<EOF
$API_DOMAIN {
	request_body {
		max_size $MAX_UPLOAD
	}
	reverse_proxy 127.0.0.1:8787
}
EOF

  if [ -f "$CADDYFILE" ] && ! grep -qF "$SITE_IMPORT" "$CADDYFILE"; then
    $SUDO cp "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
    printf '\n%s\n' "$SITE_IMPORT" | $SUDO tee -a "$CADDYFILE" >/dev/null
    echo "Appended '$SITE_IMPORT' to $CADDYFILE (original backed up)"
  elif [ ! -f "$CADDYFILE" ]; then
    printf '%s\n' "$SITE_IMPORT" | $SUDO tee "$CADDYFILE" >/dev/null
  fi

  # Validate before (re)loading: a broken config would otherwise drop every site
  # on this host, not just ours.
  $SUDO caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null ||
    die "the Caddy config does not validate — nothing was reloaded, check $CADDYFILE"

  if [ "$HAS_SYSTEMD" -eq 1 ]; then
    $SUDO systemctl enable --now caddy
    $SUDO systemctl reload caddy
    return
  fi

  # The Debian package ships only a systemd unit, so without systemd we drive
  # Caddy's own background daemon instead.
  if $SUDO caddy reload --config "$CADDYFILE" --adapter caddyfile 2>/dev/null; then
    echo "Reloaded the running Caddy"
  else
    $SUDO caddy start --config "$CADDYFILE" --adapter caddyfile
  fi

  # The app itself is already handled: pm2 gets an @reboot entry, and the
  # container has restart: unless-stopped. Only the pieces below are left.
  if [ "$RUNTIME" = docker ]; then
    warn "no systemd here, so neither Caddy nor the Docker daemon survives a reboot. Persist both with:
       (crontab -l 2>/dev/null
        echo '@reboot dockerd >>$DOCKERD_LOG 2>&1 &'
        echo '@reboot caddy start --config $CADDYFILE --adapter caddyfile') | crontab -
       The container itself restarts on its own once dockerd is back."
  else
    warn "no systemd here, so Caddy does not survive a reboot. Persist it with:
       (crontab -l 2>/dev/null
        echo '@reboot caddy start --config $CADDYFILE --adapter caddyfile') | crontab -
       The API itself is already covered by the @reboot pm2 resurrect entry."
  fi
}

verify() {
  log "Verifying"

  local logs_hint
  if [ "$RUNTIME" = docker ]; then
    logs_hint="$SUDO docker compose -f $APP_DIR/docker-compose.yml logs"
  else
    logs_hint="pm2 logs $SERVICE_NAME --lines 50"
  fi

  local attempt
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 5 http://127.0.0.1:8787/api/health >/dev/null; then
      echo "local API: healthy"
      break
    fi
    [ "$attempt" -eq 20 ] && die "the API never answered /api/health — check: $logs_hint"
    sleep 3
  done

  # The first HTTPS request is also what triggers certificate issuance, so give
  # it a few tries before calling it a failure.
  for attempt in $(seq 1 20); do
    if curl -fsS --max-time 10 "https://$API_DOMAIN/api/health" >/dev/null; then
      echo "https://$API_DOMAIN: healthy"
      break
    fi
    local caddy_hint="$SUDO journalctl -u caddy -n 50"
    [ "$HAS_SYSTEMD" -eq 1 ] || caddy_hint="$SUDO tail -n 50 /var/log/caddy/*.log (or the terminal caddy start wrote to)"
    [ "$attempt" -eq 20 ] && die "no answer over HTTPS — check DNS and: $caddy_hint"
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
  choose_runtime

  if [ "$RUNTIME" = docker ]; then
    install_docker
  else
    install_node
  fi

  install_caddy
  sync_repo
  write_env

  if [ "$RUNTIME" = docker ]; then
    start_stack
  else
    start_native
  fi

  configure_caddy
  verify

  local day_to_day
  if [ "$RUNTIME" = docker ]; then
    day_to_day="  $SUDO docker compose logs -f     # what the pipeline is doing
  $SUDO docker compose restart     # after editing .env"
  else
    day_to_day="  pm2 logs $SERVICE_NAME           # what the pipeline is doing
  pm2 restart $SERVICE_NAME        # after editing .env
  pm2 status                       # uptime, restarts, memory"
  fi

  cat <<EOF

$(printf '\033[1;32mDone.\033[0m') The API is live at https://$API_DOMAIN (runtime: $RUNTIME, data in $DATA_DIR)

Point the frontend at it, in the meetutu (frontend) repo:

  echo 'VITE_API_BASE_URL=https://$API_DOMAIN' > .env.production
  pnpm build && npx wrangler deploy

Day to day, from $APP_DIR:

$day_to_day
  bash deploy/bootstrap.sh         # pull, rebuild, restart

EOF
}

main "$@"
