# kerby

Find available on-street parking in Melbourne CBD, using City of Melbourne open data. Mobile app (React Native/Expo) backed by a Rust API + ETL worker.

## Stack

- Rust (Axum API + tokio workers), workspace in `crates/`
- Postgres 16 + PostGIS 3.4 (spatial queries on bay geometry)
- Redis 7 (sensor cache + pubsub for live status)
- React Native + Expo (`mobile/`)
- sqlx for migrations/queries

## Setup

```sh
rustup show                                    # picks up rust-toolchain.toml
cargo install sqlx-cli --no-default-features --features postgres
cp .env.example .env
docker compose up -d                           # Postgres+PostGIS, Redis
sqlx migrate run
cargo build --workspace
```

Also needs Docker + Docker Compose installed.

## Run

```sh
cargo run -p kerby-api       # HTTP API
cargo run -p kerby-worker    # ETL + sensor poller (separate long-running binary)
curl localhost:8080/health   # -> ok
```

Mobile:
```sh
cd mobile
npm install
npx expo start                # scan QR with Expo Go, or --ios for simulator
```
Set `apiBase` in `mobile/app.json` (`extra`) to your machine's LAN IP when testing on a physical phone — not `localhost`.

## Layout

```
crates/domain/   shared types (Bay, Restriction, Lock, ...)
crates/api/      HTTP API (Axum)
crates/worker/   ETL + sensor poller
migrations/      sqlx migrations
mobile/          React Native + Expo app
deploy/          production configs (see deploy/README.md)
docs/            design notes
```

## Deploy

API + worker → Fly.io (two apps, one Dockerfile, `BIN` build-arg). Postgres+PostGIS → Supabase (Fly Postgres has no PostGIS). Redis → Upstash. Mobile beta → Expo Go / EAS Update OTA (no Apple dev account, so no TestFlight yet). Details in `deploy/README.md`.

## Roadmap

**`bullseye.yaml` is the source of truth for what to build next** — managed by the bullseye MCP server, safe to hand-edit. Use `bullseye_frontier` (cwd = this repo) to get the unblocked target to work on next; don't infer roadmap state from this file or README.

Rough shape as of last write: Phase 1 (MVP: find/filter/save a bay) done. Phase 2 (lock bay, live reroute, push notifications) and Phase 3 (saved destinations, paid lots, share links) near done. In-app turn-by-turn nav done (Expo managed workflow, no eject). CarPlay/Android Auto set aside pending Expo bare-workflow eject — revisit at >50 weekly active users. Next up: auth hardening, observability, reliability, compliance polish.

## Data source

City of Melbourne Open Data (Opendatasoft). Dataset IDs and API base URL documented in project memory / `docs/`.
