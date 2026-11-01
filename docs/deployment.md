# Deployment

How to run Kvitok in production from the published Docker image. For development, see [development.md](development.md).

## What runs

One image, `ghcr.io/rogue85/kvitok`, for every process. The command picks the mode:

| Command | What it does |
| --- | --- |
| `api` (default) | Applies migrations, then serves the API and the web interface on port 3001 |
| `worker` | The queue worker: sending replies and webhooks, receiving mail, the agent |
| `migrate` | Applies migrations and exits |
| `cli <args>` | The admin CLI, for example `cli user:create` |

The app needs PostgreSQL 15+ and Redis 7+. Attachments are stored on disk in `/data/storage`.

[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs the app and the worker. It can also run Postgres, Redis and Caddy with automatic HTTPS. Each of the three is optional: you can use your own database, Redis or reverse proxy instead.

Tags: `1.2.3` is a release, `1.2` is the latest patch of a release line, `latest` is the newest release, `edge` is the latest commit to `main`. In production, pin a release. What each release changed is in [CHANGELOG.md](../CHANGELOG.md); how versions are numbered, in [CONTRIBUTING.md](../CONTRIBUTING.md#versions).

## Quick start

You need a Linux host with Docker and Docker Compose 2.20 or newer, and at least 2 GB of memory.

```bash
mkdir kvitok && cd kvitok
```

```bash
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Rogue85/kvitok/main/deploy/docker-compose.yml
```

```bash
curl -fsSL -o .env https://raw.githubusercontent.com/Rogue85/kvitok/main/deploy/.env.example
```

Generate the secrets and put them into `.env`:

```bash
sed -i "s/^APP_SECRET=$/APP_SECRET=$(openssl rand -hex 32)/; s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
```

Choose how the app is reached (see below), then start it:

```bash
docker compose up -d
```

Open the app. A fresh installation shows the first-run page: it creates the first superadministrator and the first workspace. The page closes once the installation has a superadministrator.

The defaults run Postgres and Redis next to the app and listen on `127.0.0.1:3000`, which is reachable only from the host itself. To open it to users, pick one of the options below.

## Access

### HTTPS with the bundled Caddy

Point the domain's DNS record at the host and open ports 80 and 443. Then set in `.env`:

```env
COMPOSE_PROFILES=postgres,redis,caddy
DOMAIN=support.example.com
```

Caddy gets a Let's Encrypt certificate on the first request and renews it automatically. Its certificates are kept in the `caddy` volume.

### Your own reverse proxy

Leave `caddy` out of `COMPOSE_PROFILES`. The app listens on `127.0.0.1:3000`; proxy the whole domain to it. The proxy must pass `X-Forwarded-Proto`: the session cookie becomes `Secure` when the original request came over HTTPS. The event stream (`/api/workspaces/…/events`) is a long-lived SSE response, so response buffering must be off.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name support.example.com;
    # ssl_certificate …

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

If the proxy runs in Docker on the same host (Traefik, nginx-proxy), attach it to the `kvitok_default` network and point it at `kvitok:3001`.

### Without a proxy

Open the port to the network in `.env`:

```env
KVITOK_LISTEN=80
```

The app is then served over plain HTTP: passwords and session cookies travel unencrypted. Use this only inside a private network or behind a TLS-terminating load balancer that sets `X-Forwarded-Proto`. The bundled Caddy can also serve plain HTTP: `DOMAIN=:80` or `DOMAIN=http://10.0.0.5`.

Note that Docker opens published ports past host firewalls such as ufw.

## External Postgres and Redis

To use a managed database, remove `postgres` from `COMPOSE_PROFILES` and set the URL:

```env
COMPOSE_PROFILES=redis
DATABASE_URL=postgresql://kvitok:password@db.example.com:5432/kvitok?sslmode=require
```

The database must exist. The app creates its tables on start. Case-insensitive search in non-Latin scripts needs a database with an ICU or UTF-8 locale, not `C`:

```sql
CREATE DATABASE kvitok TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C';
```

The same works for Redis: remove `redis` from `COMPOSE_PROFILES` and set `REDIS_URL` (`rediss://` for TLS). Redis holds the queues, so it must keep its data and never evict keys: `maxmemory-policy noeviction`, with persistence on. Managed Redis services often default to an evicting policy, so check this setting.

## Without Compose

The same image runs under any orchestrator. Run two containers, `api` and `worker`, with the same environment and the same `/data/storage` volume:

```bash
docker run -d --name kvitok -p 3000:3001 -v kvitok-storage:/data/storage \
  -e DATABASE_URL=… -e REDIS_URL=… -e APP_SECRET=… ghcr.io/rogue85/kvitok:latest api
```

```bash
docker run -d --name kvitok-worker -v kvitok-storage:/data/storage \
  -e DATABASE_URL=… -e REDIS_URL=… -e APP_SECRET=… ghcr.io/rogue85/kvitok:latest worker
```

`GET /api/health` answers 200 when the database and Redis are reachable, and reports the running version (`kvitok healthcheck` inside the container checks it). With several API replicas, run `migrate` once per release and set `MIGRATE_ON_START=false`.

## Updating

Set the new version in `.env` (`KVITOK_VERSION=1.3.0`), then:

```bash
docker compose pull && docker compose up -d
```

The app applies new migrations on start; the worker starts after it is healthy. Before updating, read [CHANGELOG.md](../CHANGELOG.md) for every version in between: a change marked **Breaking** may need a step from you. While Kvitok is below 1.0.0 that can happen in a minor version (`0.2` → `0.3`), never in a patch.

The running version is in the profile page and in `GET /api/health`:

```bash
curl -s http://127.0.0.1:3000/api/health
```

## Backups

Back up the database and the attachments. With the bundled Postgres:

```bash
docker compose exec -T postgres pg_dump -U kvitok -Fc kvitok > kvitok-$(date +%F).dump
```

```bash
docker run --rm -v kvitok_storage:/data -v "$PWD":/backup alpine tar czf /backup/storage-$(date +%F).tar.gz -C /data .
```

Restoring into a fresh installation, before the app is started:

```bash
docker compose up -d postgres
```

```bash
docker compose exec -T postgres pg_restore -U kvitok -d kvitok --clean --if-exists < kvitok-2026-11-01.dump
```

Keep `APP_SECRET` together with the backups: integration secrets and mailbox passwords in the database are encrypted with it.

## Administration

Users, workspaces and access are managed in the interface (Administration → Users). If every superadministrator has lost access, create a new one from the command line:

```bash
docker compose exec kvitok kvitok cli user:create --email admin@example.com --password '…' --name Admin --superadmin
```

## Settings

All settings are environment variables in `.env`. The compose file passes all of them to the app.

| Variable | Default | |
| --- | --- | --- |
| `APP_SECRET` | | Required. At least 32 characters |
| `APP_LOCALE` | `en` | Interface language: `en`, `ru` |
| `POSTGRES_PASSWORD` | | Password of the bundled Postgres |
| `DATABASE_URL` | the bundled Postgres | |
| `REDIS_URL` | the bundled Redis | |
| `COMPOSE_PROFILES` | `postgres,redis` | Bundled services: `postgres`, `redis`, `caddy` |
| `KVITOK_VERSION` | `latest` | Image tag |
| `KVITOK_LISTEN` | `127.0.0.1:3000` | Published address of the app |
| `DOMAIN` | `localhost` | Domain for the bundled Caddy |
| `COOKIE_SECURE` | `auto` | `auto`: by the request protocol; `true`, `false` |
| `SESSION_TTL_DAYS` | `30` | |
| `LOGIN_RATE_LIMIT` | `10` | Sign-in attempts per minute from one IP |
| `MAIL_POLL_SECONDS` | `60` | Mailbox polling interval |
| `INTEGRATION_SYNC_MINUTES` | `15` | How often integration manifests are synced |
| `MIGRATE_ON_START` | `true` | Migrations on start of the `api` container |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated | Web push keys (base64url, `npx web-push generate-vapid-keys`). Without them the keys are generated on first use and stored encrypted with `APP_SECRET`; changing either invalidates every browser subscription |
| `VAPID_SUBJECT` | `WEB_ORIGIN` or the superadmin's email | A contact for push services: `mailto:you@example.com` or an https URL. Apple rejects notifications to iPhone and iPad (`403 BadJwtToken`) without a real one, so the default is `WEB_ORIGIN` when it is https on a public domain, else the email of the first superadmin; set it when neither is public |

## Building the image

From the repository root:

```bash
docker build -f docker/Dockerfile -t kvitok:local --build-arg APP_VERSION="$(git describe --tags --always)" .
```

Without `APP_VERSION` the app reports its version as `dev`.

To run it with the compose file, set `KVITOK_IMAGE=kvitok` and `KVITOK_VERSION=local` in `.env`. On a machine that also runs the development stack, give the installation another project name, for example `docker compose -p kvitok-local up -d`: both compose files are named `kvitok`, and their volumes would otherwise mix.
