# T6.4 — Refresh tokens: 15-min access + 30-day refresh

## Problem

`crates/api/src/auth.rs` issues a single long-lived JWT on login/signup with no
revocation mechanism and no refresh flow. Signing out client-side just clears
local storage — the JWT stays valid server-side until it naturally expires.
There's no way to kill a stolen or leaked token short of rotating the shared
`jwt_secret` (which invalidates every user's session at once).

## Token model

- **Access token**: JWT, 15-minute TTL (replaces the current long-lived
  default). Shape unchanged (`Claims { sub, exp, iat }`), still verified
  statelessly — no DB lookup on every request.
- **Refresh token**: opaque random string (not a JWT), 30-day TTL. Stored
  **hashed** (SHA-256) server-side, same principle as password hashing — the
  raw token only ever exists on the client and in the HTTPS response body.

## Schema

New migration, `refresh_tokens` table:

```sql
CREATE TABLE refresh_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    family_id    UUID NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
```

Storage is Postgres, not Redis — refresh tokens must survive independent of
Redis uptime (motivated directly by today's Upstash free-tier quota outage
that took `kerby-api`'s health check down).

`family_id` is stable across all rotations of a single login session; a new
login (signup or login call) gets a fresh `family_id`. This is what makes
reuse detection possible: rotating a token keeps the family, replaying an
already-used token kills the whole family.

## Session model: multi-device

Each login creates its own `refresh_tokens` row (its own `family_id`). A user
can be signed in on multiple phones simultaneously; logging in on a new
device does not invalidate other devices. This is the normal expectation for
a consumer app and sets up cleanly for T6.5 (multi-device push tokens) later,
which is a related but separate concern (push token registration, not auth).

## Rotation + reuse detection

On every `/auth/refresh` call:

1. Hash the presented refresh token, look up the row by `token_hash`.
2. Not found, expired, or already `revoked_at` set → reject with 401.
   - If the row **was found but already revoked**: this is a replay of a
     token that was already rotated away — treat as a compromise signal and
     revoke every row sharing that `family_id`, not just the one presented.
3. Otherwise: mark the presented row `revoked_at = now()`, insert a new row
   with the same `family_id`, return a new access token + new refresh token.

This means a refresh token is single-use. The client must always store
whatever refresh token came back from the most recent call.

## Endpoints (`crates/api/src/auth.rs`)

- `POST /auth/signup`, `POST /auth/login` — response body changes from
  `{ token, user_id, expires_at }` to
  `{ access_token, refresh_token, user_id, expires_at }` (`expires_at` refers
  to the access token). Both create a new `refresh_tokens` row with a new
  `family_id`.
- `POST /auth/refresh { refresh_token }` — new endpoint. Implements the
  rotation/reuse-detection logic above. Returns the same shape as
  login/signup minus `user_id` (or include it — cheap, avoids a mobile-side
  branch).
- `POST /auth/logout { refresh_token }` — new endpoint. Sets `revoked_at` on
  the matching row only (not the whole family — other devices stay signed
  in). Mobile calls this before clearing local storage on sign-out.

## Mobile changes

- `mobile/src/storage.ts`: `kerby.token` key splits into
  `kerby.access_token` and `kerby.refresh_token`.
- `mobile/src/api.ts`: the shared `request()` helper gains 401-triggered
  refresh: on a 401, attempt `/auth/refresh` once and retry the original
  request. Concurrent 401s (e.g. MapScreen's 15s poll firing alongside a
  WS-triggered lock call) must share a single in-flight refresh call
  (singleflight), not each fire their own `/auth/refresh`.
- `mobile/App.tsx`: `signOut`/`onSignedOut` path calls `/auth/logout` with
  the stored refresh token before clearing storage, so sign-out actually
  revokes server-side instead of only forgetting locally.

## Compatibility

Existing beta installs hold only the old-format long-lived JWT under
`kerby.token`, no refresh token. After this ships, their first 401 triggers
a refresh attempt that has no refresh token to send — falls through to the
existing "clear storage, show LoginScreen" path. No migration needed; those
testers just log in again once.

## Out of scope

- T6.5 (multi-device push token registration) — separate target, this spec
  only makes multi-device *sessions* possible, doesn't touch push tokens.
- Rate-limiting `/auth/refresh` or `/auth/login` — not addressed here.
- Any change to `jwt_secret` handling or rotation.
