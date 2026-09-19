# meetutu-backend

Standalone API server for meetutu: meeting sessions, recorded audio, and
Gemini-powered meeting intelligence (transcript, summary, action items, chat).

It is a drop-in replacement for the Cloudflare Worker backend — same routes,
same response shapes, same bearer-token scheme — built to run on a small VPS.

## Why it exists

On Workers, analysis could only run inside `ctx.waitUntil()`, which Cloudflare
cuts off **30 seconds after the response is sent**. A long meeting can take
several minutes to transcribe, so those jobs were killed halfway and the client
polled a job that would never finish.

Here the job is an ordinary in-process promise: it runs until it is done, its
state is written to SQLite so a restart or a second process still sees it, and
audio over 6 MiB is streamed to the Gemini Files API in 8 MiB chunks so the
server never holds a whole recording in memory.

## Stack

| Piece | Choice |
| --- | --- |
| HTTP | Hono on `@hono/node-server` |
| Metadata | SQLite (`better-sqlite3`), WAL mode |
| Audio | Plain files under `DATA_DIR/audio/recordings/<session>/part-N.mp3` |
| AI | Google Gemini (default), OpenRouter (optional) |
| Tests | vitest |

Requires **Node 22+**.

## Quick start

```bash
pnpm install
cp .env.example .env    # fill in AUTH_PASSWORD and GEMINI_API_KEY
pnpm dev                # http://localhost:8787
```

Production:

```bash
pnpm build
node dist/server.js
```

## Configuration

All configuration is environment variables; the server validates them at boot
and exits with the offending name rather than 500ing on the first request.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `AUTH_USERNAME` | yes | — | Single-user login |
| `AUTH_PASSWORD` | yes | — | Single-user login |
| `GEMINI_API_KEY` | yes | — | Never sent to the browser |
| `PORT` | no | `8787` | |
| `HOST` | no | `0.0.0.0` | |
| `DATA_DIR` | no | `./data` | SQLite file + audio parts |
| `GEMINI_API_URL` | no | Google v1beta | Can point at a Cloudflare AI Gateway |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | |
| `CF_AIG_TOKEN` | no | — | Only with an authenticated AI Gateway |
| `OPENROUTER_API_KEY` | no | — | For `X-AI-Provider: openrouter` |
| `OPENROUTER_MODEL` | no | `anthropic/claude-3.5-haiku` | |
| `CORS_ORIGINS` | no | `*` | Comma-separated; narrow this in production |

## Auth

`POST /api/auth/login` with the configured credentials returns a token, which
is `sha256("username:password")` in hex. Send it as `Authorization: Bearer
<token>` on every other `/api/*` route. `/api/health` and `/api/auth/login` are
the only public paths. The derivation matches the Worker's, so an already
signed-in frontend keeps working after the cutover.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness (public) |
| `POST` | `/api/auth/login` | Exchange credentials for a token (public) |
| `GET` | `/api/sessions` | List sessions, newest first |
| `GET` | `/api/sessions/:id` | One session |
| `PATCH` | `/api/sessions/:id` | Rename / set status / set duration |
| `DELETE` | `/api/sessions/:id` | Delete session, transcript, summary, audio |
| `POST` | `/api/session` | Create a session |
| `POST` | `/api/process` | Mark a recording complete |
| `POST` | `/api/presign-part` | Upload target for the audio engine |
| `PUT` | `/api/presign-part?id=&part=` | Upload a part (query form) |
| `PUT` | `/api/recordings/:id/parts/:n` | Upload a part (path form) |
| `GET` | `/api/recordings/:id/parts/:n` | Read one part |
| `POST` | `/api/add-part` | Record the part count |
| `GET`/`HEAD` | `/api/recordings/:id/audio` | Full concatenated MP3 |
| `GET` | `/api/recordings/:id/transcription` | Stored transcript |
| `GET` | `/api/recordings/:id/summary` | Stored summary |
| `POST` | `/api/recordings/:id/transcribe` | Start analysis → `202` |
| `GET` | `/api/recordings/:id/analysis-status` | `processing` / `done` / `error` / `not_found` |
| `PATCH` | `/api/recordings/:id/action-items/:actionId` | Toggle an action item |
| `POST` | `/api/recordings/:id/save-intelligence` | Store client-generated results |
| `POST` | `/api/recordings/:id/chat` | Ask about the meeting |
| `POST` | `/api/ai/gemini-test` | Gemini connectivity check |
| `POST` | `/api/ai/verify-key` | OpenRouter key check |

## Deploying to a VPS

1 GB RAM / 1 vCPU is enough: Node idles around 100 MB, streaming upload peaks
add tens of MB, and the work is I/O-bound (audio is already encoded to MP3 in
the browser, so there is no server-side transcoding).

### Docker

```bash
cp .env.example .env    # fill it in
docker compose up -d --build
```

The container binds to `127.0.0.1:8787`; put nginx or Caddy in front for TLS —
see `deploy/nginx.conf.example`. Recordings live in the `meetutu-data` volume.

### systemd

```bash
sudo useradd --system --home /opt/meetutu-backend meetutu
sudo rsync -a --exclude node_modules --exclude data ./ /opt/meetutu-backend/
cd /opt/meetutu-backend && sudo -u meetutu pnpm install --prod=false && sudo -u meetutu pnpm build
sudo install -m 0640 -o root -g meetutu .env.example /etc/meetutu-backend.env   # then edit it
sudo mkdir -p /var/lib/meetutu && sudo chown meetutu:meetutu /var/lib/meetutu   # DATA_DIR
sudo cp deploy/meetutu-backend.service /etc/systemd/system/
sudo systemctl enable --now meetutu-backend
```

Set `DATA_DIR=/var/lib/meetutu` in `/etc/meetutu-backend.env` — it is the only
path the hardened unit is allowed to write.

### Backups

Everything durable is in `DATA_DIR`: `meetutu.db` (plus its `-wal`/`-shm`
files) and `audio/`. Snapshot the directory, or `sqlite3 meetutu.db ".backup"`
for a consistent copy while running.

## Security notes

- `AUTH_PASSWORD` and `GEMINI_API_KEY` are environment-only. Keep `.env` out of
  git (it already is) and `chmod 0640` the systemd env file.
- The Gemini URL and key are never taken from request headers or the body — a
  client-supplied URL would let a caller redirect the billable key to an
  endpoint of their choosing.
- Set `CORS_ORIGINS` to the frontend origin in production instead of `*`.
- Put TLS in front of the server; the bearer token is sent on every request.

## Development

```bash
pnpm test           # vitest
pnpm test:coverage  # with thresholds
pnpm typecheck
pnpm build
```
