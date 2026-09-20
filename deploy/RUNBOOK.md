# Deploy runbook: backend on a VPS, frontend on Cloudflare

End-to-end sequence for the split deployment: this server handles `/api/*` on
its own host, the Cloudflare Worker keeps serving the built SPA, and the browser
talks to the two origins directly over CORS.

Placeholders to substitute throughout:

| Placeholder | Example | What it is |
|---|---|---|
| `API_DOMAIN` | `api.meetutu.dev` | DNS name pointing at the VPS |
| `FRONTEND_ORIGIN` | `https://meetutu.example.workers.dev` | Exact origin serving the SPA, no trailing slash |
| `VPS_USER` | `ubuntu` | Login user on the VPS |

## Fast path: one script

`deploy/bootstrap.sh` does every step below — installs Docker and Caddy, clones
the repo, writes `.env`, starts the container, binds the domain with automatic
TLS, and verifies health and CORS. On a fresh Debian/Ubuntu VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/IzzaSuni/meetutu-backend/main/deploy/bootstrap.sh -o bootstrap.sh
API_DOMAIN=api.example.com FRONTEND_ORIGIN=https://app.example.com bash bootstrap.sh
```

It prompts for the login password and the OpenRouter key (hidden input, so
neither lands in the shell history). Re-running it is the update path: pull,
rebuild, restart, leaving `.env` and the data volume untouched.

Read on for what it does step by step, or to do it by hand.

## 0. Prerequisites

- A VPS with 1 GB RAM / 1 vCPU (enough — see README) and ports 80 and 443 open.
- A DNS **A record** for `API_DOMAIN` pointing at the VPS IP. TLS is not
  optional: the SPA is served over HTTPS, and a browser refuses to call a
  plain-HTTP backend from an HTTPS page.
- Either Docker, or Node 22 + pnpm, on the VPS.
- An OpenRouter API key with credit (https://openrouter.ai/keys).

## 1. Get the code onto the VPS

The repo is private, so authenticate the clone — `gh auth login` and
`gh repo clone`, or a deploy key:

```bash
ssh VPS_USER@API_DOMAIN
git clone https://github.com/IzzaSuni/meetutu-backend.git ~/meetutu-backend
cd ~/meetutu-backend
```

## 2. Configure the environment

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

Values that matter for this deployment:

```dotenv
AUTH_USERNAME=admin
AUTH_PASSWORD=<a new strong password, not the one from wrangler.jsonc>
OPENROUTER_API_KEY=sk-or-v1-...
AI_PROVIDER=openrouter
OPENROUTER_MODEL=google/gemini-3.8-flash
DATA_DIR=/data                      # inside the container; ./data for bare Node
CORS_ORIGINS=FRONTEND_ORIGIN        # exact origin, no trailing slash, not *
```

`CORS_ORIGINS=*` works but lets any page on the internet drive the API with a
stolen token; set the real origin.

## 3. Run the server

### Docker (recommended)

```bash
docker compose up -d --build
docker compose logs -f --tail=50     # Ctrl-C to stop following
```

It binds to `127.0.0.1:8787`, so it is not reachable from outside until the
reverse proxy in step 4 is up. Data lives in the `meetutu-data` volume.

### systemd (alternative)

See the "systemd" section of the README; the unit file is
`deploy/meetutu-backend.service` and it may only write to `DATA_DIR`.

## 4. TLS in front

### Caddy (fewest moving parts — certificates are automatic)

Install it from Caddy's own apt repo (the distro package is often ancient) —
https://caddyserver.com/docs/install#debian-ubuntu-raspbian — then:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
API_DOMAIN {
    # An audio part is uploaded as one body; the 10 MB default rejects it.
    request_body {
        max_size 512MB
    }
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
```

### nginx

Use `deploy/nginx.conf.example` and run `certbot --nginx -d API_DOMAIN`. Keep
its `client_max_body_size` and the long `proxy_read_timeout` — a transcription
request stays open for minutes.

## 5. Verify the backend before touching the frontend

```bash
# Health, no auth required
curl -sS https://API_DOMAIN/api/health

# Login returns a bearer token
curl -sS -X POST https://API_DOMAIN/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<AUTH_PASSWORD>"}'

# CORS preflight must answer with the frontend origin
curl -sS -i -X OPTIONS https://API_DOMAIN/api/sessions \
  -H 'Origin: FRONTEND_ORIGIN' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' | grep -i access-control
```

The preflight response must contain `access-control-allow-origin:
FRONTEND_ORIGIN` and `authorization` in the allowed headers. If it does not,
`CORS_ORIGINS` does not match the origin exactly.

## 6. Point the frontend at it

In the **meetutu** (frontend) repo, not this one:

```bash
echo 'VITE_API_BASE_URL=https://API_DOMAIN' > .env.production
pnpm build
npx wrangler deploy
```

Every `/api/*` call is rewritten onto that base by the fetch interceptor in
`src/lib/auth.ts`, so no call site changes. Leave the variable unset to go back
to the same-origin Worker backend.

Two consequences worth knowing before the switch:

- **Existing data does not migrate.** Sessions in D1 and audio in R2 stay there;
  the VPS starts with an empty SQLite database and an empty audio directory.
- The Worker's own `/api/*` routes stay deployed but go unused. The queue-based
  pipeline in `src/worker/analysis-queue.ts` needs the Workers Paid plan
  (`limits.cpu_ms`); it is kept for if that changes.

## 7. Operating it

```bash
docker compose logs -f              # what the pipeline is doing
docker compose restart              # after an .env change
docker compose pull && docker compose up -d --build   # after a git pull

# Backup: everything durable is DATA_DIR (meetutu.db + audio/)
docker run --rm -v meetutu-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/meetutu-$(date +%F).tar.gz -C /data .
```

A 90–120 minute recording is transcribed slice by slice, so expect several
minutes of work per job and a steady stream of log lines rather than one hang.
