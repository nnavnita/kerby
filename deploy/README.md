# Deploy

Fly.io deployment for the Kerby backend (API + worker).
Redis and Postgres+PostGIS provisioned as external managed services.

## Prerequisites

- `flyctl` installed and logged in (`brew install flyctl && fly auth login`)
- Payment method on file (Fly.io free tier no longer exists — expect ~$5-10/mo for MVP)

## 1. Provision Postgres + PostGIS

Fly Postgres does not ship PostGIS. Options:

- **Supabase free tier** (recommended for MVP) — includes PostGIS out of the box.
  Create a project, grab the `DATABASE_URL` from the dashboard.
- **Neon** — Postgres with PostGIS extension. Similar setup.
- **Fly Postgres + custom image** — more work; skip for MVP.

Whichever you choose, connect once and enable extensions:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

Migrations run automatically at API startup (`sqlx::migrate!`).

## 2. Provision Redis

- **Upstash Redis free tier** — 10 000 commands/day is enough for a beta.
- Grab the `REDIS_URL` (starts with `rediss://` — TLS).

## 3. Create the apps

From the repo root:

```sh
flyctl apps create kerby-api
flyctl apps create kerby-worker
```

## 4. Set secrets

```sh
JWT_SECRET=$(openssl rand -hex 32)

flyctl secrets set --app kerby-api \
  DATABASE_URL="<supabase url>" \
  REDIS_URL="<upstash url>" \
  JWT_SECRET="$JWT_SECRET"

flyctl secrets set --app kerby-worker \
  DATABASE_URL="<supabase url>" \
  REDIS_URL="<upstash url>" \
  COM_API_BASE="https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets"
```

## 5. Deploy

```sh
flyctl deploy --config deploy/fly.api.toml
flyctl deploy --config deploy/fly.worker.toml
```

## 6. Point the mobile app at the deployed API

Edit `mobile/app.json`:

```json
"extra": {
  "apiBase": "https://kerby-api.fly.dev"
}
```

## 7. Verify

```sh
curl https://kerby-api.fly.dev/health              # -> ok
flyctl logs --app kerby-worker | grep "sensor poll"   # should tick every 30s
```

## Beta distribution (mobile)

- **Fastest**: Expo Go + published dev build. Testers install Expo Go and scan a QR.
- **iOS TestFlight**: needs Apple Developer account ($99/yr). `eas build --platform ios --profile preview` then `eas submit`.
- **Android internal test track**: needs Google Play Console ($25 one-time). `eas build --platform android --profile preview`.

Configure `eas.json` when ready.
