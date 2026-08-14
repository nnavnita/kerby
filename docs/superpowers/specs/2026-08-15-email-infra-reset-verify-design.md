# T6.1 + T6.2 — Email infra, password reset, email verification

## Problem

Kerby has no way to send email. Two T6 subtargets need it:

- **T6.1** Password reset via email token — currently no recovery path if a
  user forgets their password.
- **T6.2** Email verification on signup — currently no way to confirm the
  email address on an account is real/owned by the signer-upper.

Account deletion (`crates/api/src/legal.rs`) is *also* currently a manual
"email us" flow, but that's T6.3 (separate spec) — not addressed here.

## Provider

**Resend**, called via a thin `reqwest` HTTP client — same shape as the
existing external API clients (`crates/api/src/directions.rs` for Google
Directions, `crates/worker/src/com.rs` for the CoM feed). No new dependency:
`reqwest` is already in `crates/api/Cargo.toml`.

New env vars: `RESEND_API_KEY`, `EMAIL_FROM` (added to `AppState`, same
pattern as `jwt_secret`/`jwt_ttl_secs`).

`crates/api/src/email.rs`:

```rust
pub struct EmailClient {
    http: reqwest::Client,
    api_key: String,
    from: String,
}

impl EmailClient {
    pub fn new(api_key: String, from: String) -> Self { ... }

    /// Fire-and-log. Callers never propagate a send failure to the HTTP
    /// caller — see "Error handling" below.
    pub async fn send(&self, to: &str, subject: &str, html_body: &str) {
        if let Err(e) = self.try_send(to, subject, html_body).await {
            tracing::error!(error=?e, to, "email send failed");
        }
    }

    async fn try_send(&self, to: &str, subject: &str, html_body: &str)
        -> Result<(), reqwest::Error> { ... }
}
```

## Schema

New migration, shared `email_tokens` table (mirrors the shape of
`refresh_tokens`, minus the rotation-family complexity — these are one-shot):

```sql
CREATE TYPE email_token_purpose AS ENUM ('reset', 'verify');

CREATE TABLE email_tokens (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    purpose      email_token_purpose NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_tokens_user_purpose ON email_tokens (user_id, purpose)
    WHERE consumed_at IS NULL;

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
```

Reset tokens: 30-minute TTL. Verify tokens: 24-hour TTL.

## Shared token helpers

`generate_refresh_token()` / `hash_refresh_token()` in `auth.rs` get promoted
to a shared `crates/api/src/tokens.rs`:

```rust
pub fn generate_opaque_token() -> String; // two concat'd UUIDv4s, as today
pub fn hash_token(token: &str) -> String; // SHA-256 hex, as today
```

`auth.rs`'s refresh-token functions become thin wrappers calling these.
`email_tokens.rs` (new) provides `issue(purpose, user_id) -> raw_token` and
`consume(purpose, raw_token) -> Result<user_id, ApiError>`, used by both new
route modules below.

## Routes

New `crates/api/src/password_reset.rs`:

- `POST /auth/forgot-password { email }` — always `200 { "ok": true }`,
  regardless of whether the email exists (no account enumeration). If it
  exists: `email_tokens::issue("reset", user_id)`, email a
  `kerby://reset-password?token=...` deep link (existing `kerby` scheme /
  `applinks:kerby-api.fly.dev` universal domain from T3.3 share links).
- `POST /auth/reset-password { token, new_password }` — consumes the token,
  updates `password_hash`, and **revokes every `refresh_tokens` row for that
  user** (password reset kills all existing sessions, standard practice).
  Reuses `validate_credentials`'s password-length check from `auth.rs`.

New `crates/api/src/email_verify.rs`:

- Signup (`auth.rs::signup`) gains one line: after creating the user, issue a
  verify token and `email.send(...)` a `kerby://verify-email?token=...` link.
  **Signup succeeds even if the send fails** — logged, not fatal.
- `POST /auth/verify-email { token }` — consumes the token, sets
  `users.email_verified_at = now()`.
- `POST /auth/resend-verification` (requires `AuthUser`) — no-op if already
  verified; else invalidates prior unconsumed verify tokens for the user and
  issues+sends a new one. Layered with the existing `tower_governor`
  rate-limit middleware (`crates/api/src/lib.rs`), same tier as other
  authed-but-abusable endpoints.

## Mobile

- New screen: reset-password (enter new password, calls
  `POST /auth/reset-password`), reached via the `kerby://reset-password`
  deep link handler (extends the existing linking config from T3.3).
- `kerby://verify-email` deep link calls `POST /auth/verify-email` directly,
  no dedicated screen needed — just a toast/confirmation on the map screen.
- Non-blocking banner (dismissible) shown when the authenticated user's
  `email_verified_at` is null, with a "resend" action hitting
  `POST /auth/resend-verification`. **Enforcement is soft everywhere** — no
  app feature is gated on verification status.

## Error handling

- `forgot-password`, `verify-email`, `reset-password`: invalid, expired, or
  already-consumed token all return the same generic
  `400 "invalid or expired token"` — no distinguishing which, avoids leaking
  token state to a caller probing.
- Email send failures never surface to the HTTP client (see `EmailClient`
  above) — logged via `tracing::error!` only. This matches how
  `directions.rs`/`com.rs` external-call failures are already handled, and
  means CI (which has no `RESEND_API_KEY`) doesn't need a mock: send calls
  will fail there, get logged, and the endpoint still returns success.

## Testing

Integration tests added to `crates/api/tests/integration.rs`, following its
existing style:

- Forgot-password on an existing email → 200, row inserted with purpose
  `reset`.
- Forgot-password on a nonexistent email → 200, no row inserted
  (enumeration check).
- Reset-password happy path → password actually changes, can log in with new
  password.
- Reset-password revokes existing sessions → a refresh token issued before
  the reset fails to refresh afterward.
- Reset-password with expired/consumed/garbage token → 400.
- Signup inserts a `verify` purpose token.
- Verify-email happy path → `email_verified_at` set.
- Verify-email with expired/consumed/garbage token → 400.
- Resend-verification invalidates the prior token (old token no longer
  consumable) and issues a new one; no-ops when already verified.

Unit tests for `tokens.rs`: `generate_opaque_token` uniqueness/length,
`hash_token` determinism.
