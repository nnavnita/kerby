# Kerby

Find available on-street parking in Melbourne CBD using City of Melbourne open data.

## Stack

- Rust (Axum API + tokio workers)
- Postgres 16 + PostGIS 3.4
- Redis 7 (sensor cache + pubsub)
- React Native + Expo mobile app (added later)

## Prerequisites

- Rust stable (via `rustup`)
- Docker + Docker Compose
- `sqlx-cli` — install with:
  ```sh
  cargo install sqlx-cli --no-default-features --features postgres
  ```

## Bootstrap

```sh
cp .env.example .env
docker compose up -d
sqlx migrate run
cargo build --workspace
```

## Run

Two long-running binaries:

```sh
# API
cargo run -p kerby-api

# ETL + sensor poller
cargo run -p kerby-worker
```

Health check: `curl localhost:8080/health` -> `ok`.

## Deploy

Production configs live in `deploy/`. See `deploy/README.md`. TL;DR:

- API + worker → Fly.io (two apps, one Dockerfile via `BIN` build-arg)
- Postgres+PostGIS → Supabase (Fly Postgres doesn't ship PostGIS)
- Redis → Upstash
- Mobile beta → Expo Go (fastest) or EAS build → TestFlight/Play internal

## Mobile

```sh
cd mobile
npm install
npx expo start
```

Scan the QR code with the Expo Go app (iOS/Android) to test on-device. For iOS simulator run `npx expo start --ios`. Set `apiBase` in `mobile/app.json` under `extra` to your API base URL — use your machine's LAN IP (not `localhost`) when testing on a physical phone.

## Layout

```
crates/
  domain/   shared types (Bay, Restriction, Lock, ...)
  api/      HTTP API (Axum)
  worker/   ETL + sensor poller
migrations/ sqlx migrations
mobile/     React Native + Expo mobile app
```

## Roadmap

Targets tracked in `bullseye.yaml` (managed by the bullseye MCP server).
Frontier target = the thing to work on next.

- **Phase 1 (MVP)**: find nearby bay + filter + external nav + save spot + walk back
- **Phase 2**: lock bay + live reroute + push notifications
- **Phase 3**: saved destinations, paid lots, share links, CarPlay
