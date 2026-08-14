# Refresh Tokens (T6.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kerby's single long-lived JWT with a 15-minute access token + rotating 30-day refresh token, stored in Postgres, with reuse detection and multi-device sessions.

**Architecture:** Backend (`crates/api/src/auth.rs`) gains a `refresh_tokens` Postgres table and two new endpoints (`/auth/refresh`, `/auth/logout`); `/auth/signup` and `/auth/login` change their response shape. Mobile (`mobile/src/api.ts`) centralizes token handling inside its `request()` helper — screens stop threading a `token` string through props entirely; the API layer sources the current access token from storage and silently refreshes on a 401.

**Tech Stack:** Rust/Axum/sqlx/Postgres backend, React Native/Expo/TypeScript mobile, `sha2` crate (new dependency) for refresh-token hashing.

## Global Constraints

- Refresh tokens are opaque random strings, never JWTs, stored **hashed** (SHA-256) — never store the raw token server-side.
- Refresh tokens live in Postgres, not Redis (spec: `docs/superpowers/specs/2026-08-14-refresh-tokens-design.md`, motivated by the Upstash quota outage on 2026-08-14).
- Each login is its own session (`family_id`); multi-device sign-in must not invalidate other devices.
- Refresh is single-use: presenting an already-rotated-away token revokes the entire family (reuse detection).
- Follow existing migration convention: `UUID PRIMARY KEY DEFAULT uuid_generate_v4()` (the `uuid-ossp` extension, not `pgcrypto`/`gen_random_uuid()` — see `migrations/20260701000001_init.sql`).
- Backend integration tests require the local docker-compose stack running (`docker compose up -d`, ports 5433/6379) — see `crates/api/tests/integration.rs` header comment.
- Mobile has no test framework configured (no jest, no test script in `mobile/package.json`). Verification is `npx tsc --noEmit` plus `npx expo export` (matches the convention used in commit `bb5e5db`), not automated tests.

---

### Task 1: `refresh_tokens` migration

**Files:**
- Create: `migrations/20260814000001_refresh_tokens.sql`

**Interfaces:**
- Produces: table `refresh_tokens(id, user_id, token_hash, family_id, expires_at, created_at, revoked_at)`, consumed by Task 2/3/4.

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE refresh_tokens (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    family_id    UUID NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX refresh_tokens_user_id_active_idx
    ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
```

- [ ] **Step 2: Apply it and verify**

Run: `docker compose up -d && cd crates/api && DATABASE_URL=postgres://kerby:kerby@localhost:5433/kerby cargo run --bin kerby-api &` then `Ctrl+C` once you see `kerby-api listening` in the log (the binary runs migrations on boot via `sqlx::migrate!`).

Expected: no migration error. Confirm the table exists:
`docker exec kerby-db psql -U kerby -d kerby -c '\d refresh_tokens'`
Expected: shows the 7 columns above and the two indexes.

- [ ] **Step 3: Commit**

```bash
git add migrations/20260814000001_refresh_tokens.sql
git commit -m "Add refresh_tokens table migration"
```

---

### Task 2: Backend — token helpers, `/auth/signup` + `/auth/login` issue token pairs

**Files:**
- Modify: `Cargo.toml` (workspace deps)
- Modify: `crates/api/Cargo.toml`
- Modify: `crates/api/src/lib.rs:65` (`DEFAULT_JWT_TTL_SECS` → `DEFAULT_ACCESS_TOKEN_TTL_SECS`, value → 15 min)
- Modify: `crates/api/src/main.rs:7,22-25,55` (constant rename)
- Modify: `crates/api/src/auth.rs` (full rewrite of token issuance)
- Modify: `crates/api/tests/integration.rs:77-93,105-121` (`signup()` helper + `signup_and_login_returns_token` now read `access_token`)

**Interfaces:**
- Consumes: `refresh_tokens` table (Task 1).
- Produces (consumed by Task 3):
  - `fn hash_refresh_token(token: &str) -> String`
  - `async fn issue_tokens_in_family(state: &AppState, user_id: Uuid, family_id: Uuid) -> ApiResult<AuthResponse>`
  - `struct AuthResponse { access_token: String, refresh_token: String, user_id: Uuid, expires_at: DateTime<Utc> }`

- [ ] **Step 1: Add the `sha2` dependency**

In `Cargo.toml`, add to `[workspace.dependencies]` (alphabetical, after `serde_json`):

```toml
sha2 = "0.10"
```

In `crates/api/Cargo.toml`, add to `[dependencies]` (after `jsonwebtoken.workspace = true`):

```toml
sha2.workspace = true
```

- [ ] **Step 2: Rename the TTL constant in `lib.rs`**

In `crates/api/src/lib.rs`, replace:

```rust
pub const DEFAULT_JWT_TTL_SECS: i64 = 30 * 24 * 60 * 60;
```

with:

```rust
/// Access token TTL. Short-lived by design — session continuity comes from
/// the refresh token (see `auth.rs`), not from a long-lived JWT.
pub const DEFAULT_ACCESS_TOKEN_TTL_SECS: i64 = 15 * 60;
```

- [ ] **Step 3: Update `main.rs` to use the renamed constant**

In `crates/api/src/main.rs`, line 7, replace:
```rust
use kerby_api::{build_router, live, DEFAULT_JWT_TTL_SECS};
```
with:
```rust
use kerby_api::{build_router, live, DEFAULT_ACCESS_TOKEN_TTL_SECS};
```

Lines 22-25, replace:
```rust
    let jwt_ttl_secs: i64 = std::env::var("JWT_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_JWT_TTL_SECS);
```
with:
```rust
    let jwt_ttl_secs: i64 = std::env::var("JWT_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_ACCESS_TOKEN_TTL_SECS);
```
(env var name `JWT_TTL_SECS` and the `jwt_ttl_secs` field on `AppState` are unchanged — only the constant's name and value change.)

- [ ] **Step 4: Rewrite `crates/api/src/auth.rs`**

Replace the entire file with:

```rust
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const REFRESH_TOKEN_TTL_SECS: i64 = 30 * 24 * 60 * 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/signup", post(signup))
        .route("/auth/login", post(login))
        .route("/auth/refresh", post(refresh))
        .route("/auth/logout", post(logout))
}

#[derive(Deserialize)]
pub struct AuthRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    access_token: String,
    refresh_token: String,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    refresh_token: String,
}

#[derive(Deserialize)]
pub struct LogoutRequest {
    refresh_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid, // user id
    pub exp: i64,  // unix seconds
    pub iat: i64,
}

fn hash_password(pw: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(format!("hash: {e}")))
}

fn verify_password(hash: &str, pw: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(pw.as_bytes(), &parsed)
        .is_ok()
}

/// Opaque, high-entropy refresh token. Two concatenated UUIDv4s (~244 bits
/// of CSPRNG randomness) — reuses the `uuid` crate already in the
/// dependency tree instead of adding one purely for random-byte generation.
fn generate_refresh_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// SHA-256 hex digest. Refresh tokens are high-entropy random strings, not
/// user-chosen secrets, so a fast cryptographic hash is the right tool here
/// — unlike passwords, they don't need Argon2's deliberate slowness.
fn hash_refresh_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn make_access_token(state: &AppState, user_id: Uuid) -> ApiResult<(String, DateTime<Utc>)> {
    let now = Utc::now();
    let exp = now + Duration::seconds(state.jwt_ttl_secs);
    let claims = Claims {
        sub: user_id,
        exp: exp.timestamp(),
        iat: now.timestamp(),
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("jwt: {e}")))?;
    Ok((token, exp))
}

/// Issue a fresh access+refresh pair inside an existing rotation family.
/// Used both by `refresh` (rotating a presented token) and by `issue_tokens`
/// (which mints a brand-new family for a fresh login).
async fn issue_tokens_in_family(
    state: &AppState,
    user_id: Uuid,
    family_id: Uuid,
) -> ApiResult<AuthResponse> {
    let (access_token, expires_at) = make_access_token(state, user_id)?;
    let refresh_token = generate_refresh_token();
    let refresh_hash = hash_refresh_token(&refresh_token);
    let refresh_expires_at = Utc::now() + Duration::seconds(REFRESH_TOKEN_TTL_SECS);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(&refresh_hash)
    .bind(family_id)
    .bind(refresh_expires_at)
    .execute(&state.db)
    .await?;

    Ok(AuthResponse {
        access_token,
        refresh_token,
        user_id,
        expires_at,
    })
}

/// Issue a fresh access+refresh pair starting a *new* session (new
/// `family_id`). Used by signup and login — each login is independent, so
/// signing in on a new device never invalidates other devices.
async fn issue_tokens(state: &AppState, user_id: Uuid) -> ApiResult<AuthResponse> {
    issue_tokens_in_family(state, user_id, Uuid::new_v4()).await
}

fn validate_credentials(req: &AuthRequest) -> Result<(), ApiError> {
    let email = req.email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::BadRequest("invalid email".into()));
    }
    if req.password.len() < 8 {
        return Err(ApiError::BadRequest(
            "password must be at least 8 chars".into(),
        ));
    }
    Ok(())
}

async fn signup(
    State(state): State<AppState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<AuthResponse>> {
    validate_credentials(&req)?;
    let hash = hash_password(&req.password)?;
    let email = req.email.trim().to_lowercase();
    let row: Result<(Uuid,), sqlx::Error> =
        sqlx::query_as("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id")
            .bind(&email)
            .bind(&hash)
            .fetch_one(&state.db)
            .await;
    let user_id = match row {
        Ok((id,)) => id,
        Err(sqlx::Error::Database(db)) if db.constraint() == Some("users_email_key") => {
            return Err(ApiError::Conflict("email already registered".into()));
        }
        Err(e) => return Err(e.into()),
    };
    Ok(Json(issue_tokens(&state, user_id).await?))
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<AuthRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = req.email.trim().to_lowercase();
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, password_hash FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    let (id, hash) = row.ok_or(ApiError::Unauthorized)?;
    if !verify_password(&hash, &req.password) {
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(issue_tokens(&state, id).await?))
}

async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let presented_hash = hash_refresh_token(&req.refresh_token);

    let row: Option<(Uuid, Uuid, Uuid, Option<DateTime<Utc>>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, user_id, family_id, revoked_at, expires_at \
         FROM refresh_tokens WHERE token_hash = $1",
    )
    .bind(&presented_hash)
    .fetch_optional(&state.db)
    .await?;

    let (row_id, user_id, family_id, revoked_at, expires_at) = row.ok_or(ApiError::Unauthorized)?;

    if expires_at < Utc::now() {
        return Err(ApiError::Unauthorized);
    }

    if revoked_at.is_some() {
        // This token was already rotated away and is being presented again —
        // either a client retried a stale token, or it leaked. Either way,
        // treat it as compromised and kill every token in the family.
        sqlx::query(
            "UPDATE refresh_tokens SET revoked_at = now() \
             WHERE family_id = $1 AND revoked_at IS NULL",
        )
        .bind(family_id)
        .execute(&state.db)
        .await?;
        return Err(ApiError::Unauthorized);
    }

    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1")
        .bind(row_id)
        .execute(&state.db)
        .await?;

    Ok(Json(issue_tokens_in_family(&state, user_id, family_id).await?))
}

async fn logout(
    State(state): State<AppState>,
    Json(req): Json<LogoutRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let presented_hash = hash_refresh_token(&req.refresh_token);
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&presented_hash)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Extractor that pulls a Bearer JWT and returns the authenticated user id.
#[derive(Clone, Copy)]
pub struct AuthUser(pub Uuid);

fn decode_bearer(headers: &axum::http::HeaderMap, secret: &str) -> Option<Uuid> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())?;
    let token = raw.strip_prefix("Bearer ")?;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .ok()?;
    Some(data.claims.sub)
}

#[async_trait::async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user_id = decode_bearer(&parts.headers, &state.jwt_secret)
            .ok_or((StatusCode::UNAUTHORIZED, "unauthorized"))?;
        tracing::Span::current().record("user_id", tracing::field::display(user_id));
        Ok(AuthUser(user_id))
    }
}

/// Marker used to opt into optional auth. Endpoints that want the caller
/// identity when available (but tolerate anonymous requests) use `Option<AuthUser>`.
pub fn optional_auth_user() {}
```

- [ ] **Step 5: Update the integration test helper for the new response shape**

In `crates/api/tests/integration.rs`, replace the `signup()` helper (lines 77-93):

```rust
async fn signup(base: &str, email: &str) -> String {
    let resp = reqwest::Client::new()
        .post(format!("{}/auth/signup", base))
        .json(&json!({ "email": email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    resp.json::<serde_json::Value>()
        .await
        .unwrap()
        .get("access_token")
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}
```

Replace `signup_and_login_returns_token` (lines 105-121) — rename to reflect the new field and assert both tokens come back:

```rust
#[tokio::test]
async fn signup_and_login_returns_tokens() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let token = signup(&base, &email).await;
    assert!(!token.is_empty());

    let login = reqwest::Client::new()
        .post(format!("{}/auth/login", base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let body: serde_json::Value = login.json().await.unwrap();
    assert!(body.get("access_token").and_then(|v| v.as_str()).is_some());
    assert!(body.get("refresh_token").and_then(|v| v.as_str()).is_some());
}
```

- [ ] **Step 6: Run the full integration suite**

Run: `docker compose up -d && cd crates/api && DATABASE_URL=postgres://kerby:kerby@localhost:5433/kerby REDIS_URL=redis://localhost:6379 cargo test`

Expected: all tests pass, including `signup_and_login_returns_tokens`. (Every other existing test that calls `signup()` — `login_rejects_wrong_password`, `signup_rejects_duplicate_email`, `session_create_current_return_round_trip`, `lock_create_release_flow`, `destination_crud` — keeps working unchanged since `signup()`'s return type didn't change, only which JSON field it reads.)

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml crates/api/Cargo.toml crates/api/src/lib.rs crates/api/src/main.rs crates/api/src/auth.rs crates/api/tests/integration.rs Cargo.lock
git commit -m "Issue access+refresh token pairs from signup/login"
```

---

### Task 3: Backend — `POST /auth/refresh` behavior tests

Task 2 already implements the `refresh` handler (needed there so `issue_tokens_in_family` had a caller to prove out the rotation logic against). This task adds the test coverage for rotation and reuse detection specifically.

**Files:**
- Modify: `crates/api/tests/integration.rs` (new tests, appended after `signup_and_login_returns_tokens`)

**Interfaces:**
- Consumes: `POST /auth/refresh` (Task 2), `AuthResponse` JSON shape `{ access_token, refresh_token, user_id, expires_at }`.

- [ ] **Step 1: Write the rotation test**

Add to `crates/api/tests/integration.rs`:

```rust
#[tokio::test]
async fn refresh_rotates_tokens_and_old_access_still_works_until_expiry() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let client = reqwest::Client::new();

    let signup_resp = client
        .post(format!("{}/auth/signup", base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    let signup_body: serde_json::Value = signup_resp.json().await.unwrap();
    let refresh_token = signup_body["refresh_token"].as_str().unwrap().to_string();

    let refresh_resp = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(refresh_resp.status(), StatusCode::OK);
    let refreshed: serde_json::Value = refresh_resp.json().await.unwrap();
    let new_refresh_token = refreshed["refresh_token"].as_str().unwrap();
    assert_ne!(new_refresh_token, refresh_token, "refresh token must rotate");
    assert!(refreshed["access_token"].as_str().is_some());
}
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd crates/api && cargo test refresh_rotates_tokens_and_old_access_still_works_until_expiry`
Expected: PASS.

- [ ] **Step 3: Write the reuse-detection test**

```rust
#[tokio::test]
async fn refresh_reuse_revokes_whole_family() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let client = reqwest::Client::new();

    let signup_resp = client
        .post(format!("{}/auth/signup", base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    let signup_body: serde_json::Value = signup_resp.json().await.unwrap();
    let original_refresh_token = signup_body["refresh_token"].as_str().unwrap().to_string();

    // First use: rotates successfully.
    let first = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &original_refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: serde_json::Value = first.json().await.unwrap();
    let rotated_refresh_token = first_body["refresh_token"].as_str().unwrap().to_string();

    // Reusing the original (now-rotated-away) token must be rejected...
    let replay = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &original_refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    // ...and must also kill the token that replay would have otherwise
    // rotated into, since the whole family is now revoked.
    let after_replay = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &rotated_refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_replay.status(), StatusCode::UNAUTHORIZED);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd crates/api && cargo test refresh_reuse_revokes_whole_family`
Expected: PASS.

- [ ] **Step 5: Write the unknown-token test**

```rust
#[tokio::test]
async fn refresh_rejects_unknown_token() {
    let base = spawn_test_server().await;
    let resp = reqwest::Client::new()
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": "not-a-real-token" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}
```

- [ ] **Step 6: Run the full suite**

Run: `cd crates/api && cargo test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/api/tests/integration.rs
git commit -m "Add refresh token rotation and reuse-detection tests"
```

---

### Task 4: Backend — `POST /auth/logout`

Task 2 already implements the `logout` handler. This task adds its test coverage and confirms multi-device isolation (logging out one session doesn't touch another).

**Files:**
- Modify: `crates/api/tests/integration.rs` (new tests, appended)

- [ ] **Step 1: Write the logout test**

```rust
#[tokio::test]
async fn logout_revokes_only_that_session() {
    let base = spawn_test_server().await;
    let email = unique_email();
    let client = reqwest::Client::new();

    // Two independent logins = two independent sessions (families).
    let signup_resp = client
        .post(format!("{}/auth/signup", base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    let session_a: serde_json::Value = signup_resp.json().await.unwrap();
    let refresh_a = session_a["refresh_token"].as_str().unwrap().to_string();

    let login_resp = client
        .post(format!("{}/auth/login", base))
        .json(&json!({ "email": &email, "password": "testtest123" }))
        .send()
        .await
        .unwrap();
    let session_b: serde_json::Value = login_resp.json().await.unwrap();
    let refresh_b = session_b["refresh_token"].as_str().unwrap().to_string();

    // Log out session A.
    let logout_resp = client
        .post(format!("{}/auth/logout", base))
        .json(&json!({ "refresh_token": &refresh_a }))
        .send()
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), StatusCode::OK);

    // Session A's refresh token no longer works.
    let refresh_after_logout = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &refresh_a }))
        .send()
        .await
        .unwrap();
    assert_eq!(refresh_after_logout.status(), StatusCode::UNAUTHORIZED);

    // Session B is untouched.
    let refresh_b_still_works = client
        .post(format!("{}/auth/refresh", base))
        .json(&json!({ "refresh_token": &refresh_b }))
        .send()
        .await
        .unwrap();
    assert_eq!(refresh_b_still_works.status(), StatusCode::OK);
}
```

- [ ] **Step 2: Run it to verify it passes**

Run: `cd crates/api && cargo test logout_revokes_only_that_session`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `cd crates/api && cargo test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/api/tests/integration.rs
git commit -m "Add logout endpoint test coverage"
```

---

### Task 5: Mobile — `storage.ts` splits into access/refresh token keys

**Files:**
- Modify: `mobile/src/storage.ts`

**Interfaces:**
- Produces (consumed by Task 6):
  - `storage.getAccessToken(): Promise<string | null>`
  - `storage.getRefreshToken(): Promise<string | null>`
  - `storage.setTokens(accessToken: string, refreshToken: string, userId: string): Promise<void>`
  - `storage.clear(): Promise<void>` (unchanged signature, now also drops both token keys)

- [ ] **Step 1: Rewrite `mobile/src/storage.ts`**

Replace the entire file with:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeMode } from './theme/tokens';

const ACCESS_TOKEN_KEY = 'kerby.access_token';
const REFRESH_TOKEN_KEY = 'kerby.refresh_token';
const USER_KEY = 'kerby.user_id';
const THEME_KEY = 'kerby.theme';

export const storage = {
  async getAccessToken(): Promise<string | null> {
    return AsyncStorage.getItem(ACCESS_TOKEN_KEY);
  },
  async getRefreshToken(): Promise<string | null> {
    return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
  },
  async setTokens(accessToken: string, refreshToken: string, userId: string): Promise<void> {
    await AsyncStorage.multiSet([
      [ACCESS_TOKEN_KEY, accessToken],
      [REFRESH_TOKEN_KEY, refreshToken],
      [USER_KEY, userId],
    ]);
  },
  async clear(): Promise<void> {
    await AsyncStorage.multiRemove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]);
  },
  async getThemeMode(): Promise<ThemeMode | null> {
    const v = await AsyncStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  },
  async setThemeMode(mode: ThemeMode): Promise<void> {
    await AsyncStorage.setItem(THEME_KEY, mode);
  },
};
```

- [ ] **Step 2: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: errors in `api.ts` and `App.tsx` and `LoginScreen.tsx` (they still call the old `storage.getToken`/`setToken` — fixed in Tasks 6-7). No errors should originate from `storage.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add mobile/src/storage.ts
git commit -m "Split mobile token storage into access/refresh keys"
```

---

### Task 6: Mobile — `api.ts` sources tokens internally, adds silent refresh

**Files:**
- Modify: `mobile/src/api.ts`

**Interfaces:**
- Consumes: `storage.getAccessToken/getRefreshToken/setTokens` (Task 5).
- Produces (consumed by Task 7):
  - Every `api.*` method drops its `token`/`token?` first parameter — auth is now automatic.
  - `api.logout(refreshToken: string): Promise<{ ok: true }>` (new)
  - `AuthResponse` type: `{ access_token: string; refresh_token: string; user_id: string; expires_at: string }`

- [ ] **Step 1: Replace the `request` machinery (lines 1-35) and `AuthResponse` type (lines 37-41)**

Replace:

```typescript
import Constants from 'expo-constants';

const API_BASE: string =
  (Constants.expoConfig?.extra as any)?.apiBase ?? 'http://localhost:8080';

type Json = Record<string, unknown> | Array<unknown> | null;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; token?: string | null; body?: Json } = {},
): Promise<T> {
  const { method = 'GET', token, body } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const msg = (parsed && (parsed as any).error) || resp.statusText;
    throw new ApiError(resp.status, msg);
  }
  return parsed as T;
}

export type AuthResponse = {
  token: string;
  user_id: string;
  expires_at: string;
};
```

with:

```typescript
import Constants from 'expo-constants';
import { storage } from './storage';

const API_BASE: string =
  (Constants.expoConfig?.extra as any)?.apiBase ?? 'http://localhost:8080';

type Json = Record<string, unknown> | Array<unknown> | null;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawRequest<T>(
  path: string,
  opts: { method?: string; body?: Json; accessToken?: string | null } = {},
): Promise<T> {
  const { method = 'GET', body, accessToken } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const msg = (parsed && (parsed as any).error) || resp.statusText;
    throw new ApiError(resp.status, msg);
  }
  return parsed as T;
}

// Concurrent 401s (e.g. MapScreen's 15s poll firing alongside a WS-triggered
// lock call) must share one in-flight refresh instead of each firing their
// own /auth/refresh — refresh tokens are single-use, so a second concurrent
// call would see the first call's already-rotated-away token and fail.
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await storage.getRefreshToken();
  if (!refreshToken) return null;
  try {
    const resp = await rawRequest<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    await storage.setTokens(resp.access_token, resp.refresh_token, resp.user_id);
    return resp.access_token;
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: Json; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  if (!auth) {
    return rawRequest<T>(path, { method, body });
  }
  const accessToken = await storage.getAccessToken();
  try {
    return await rawRequest<T>(path, { method, body, accessToken });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        return rawRequest<T>(path, { method, body, accessToken: newToken });
      }
    }
    throw e;
  }
}

export type AuthResponse = {
  access_token: string;
  refresh_token: string;
  user_id: string;
  expires_at: string;
};
```

- [ ] **Step 2: Update the `api` object (lines 131-218)**

Replace:

```typescript
export const api = {
  signup: (email: string, password: string) =>
    request<AuthResponse>('/auth/signup', { method: 'POST', body: { email, password } }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } }),
  baysNear: (
    opts: {
      lat: number;
      lng: number;
      radius_m: number;
      available_only: boolean;
    },
    token?: string,
  ) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      radius_m: String(opts.radius_m),
      available_only: String(opts.available_only),
    });
    return request<NearResponse>(`/bays/near?${qs.toString()}`, { token });
  },
  createSession: (
    token: string,
    body: { bay_id?: string | null; lat: number; lng: number; note?: string | null },
  ) => request<SessionDto>('/sessions', { method: 'POST', token, body }),
  currentSession: (token: string) =>
    request<SessionDto | null>('/sessions/current', { token }),
  returnSession: (token: string, id: string) =>
    request<SessionDto>(`/sessions/${id}/return`, { method: 'POST', token }),

  createLock: (token: string, bay_id: string) =>
    request<LockDto>('/locks', { method: 'POST', token, body: { bay_id } }),
  currentLock: (token: string) =>
    request<LockDto | null>('/locks/current', { token }),
  releaseLock: (token: string, id: string) =>
    request<LockDto>(`/locks/${id}`, { method: 'DELETE', token }),
  extendLock: (token: string, id: string, lat: number, lng: number) =>
    request<LockDto>(`/locks/${id}/extend`, {
      method: 'POST',
      token,
      body: { lat, lng },
    }),

  listDestinations: (token: string) =>
    request<Destination[]>('/destinations', { token }),
  saveDestination: (
    token: string,
    body: {
      name: string;
      lat: number;
      lng: number;
      walk_radius_m?: number;
      available_only?: boolean;
    },
  ) => request<Destination>('/destinations', { method: 'POST', token, body }),
  deleteDestination: (token: string, id: string) =>
    request<{ ok: true }>(`/destinations/${id}`, { method: 'DELETE', token }),

  lotsNear: (opts: { lat: number; lng: number; radius_m?: number }) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      ...(opts.radius_m ? { radius_m: String(opts.radius_m) } : {}),
    });
    return request<Lot[]>(`/lots/near?${qs.toString()}`);
  },

  setPushToken: (token: string, expoToken: string | null) =>
    request<{ ok: true }>('/users/push-token', {
      method: 'POST',
      token,
      body: { token: expoToken },
    }),

  getDirections: (opts: {
    origin: { lat: number; lng: number };
    destination: { lat: number; lng: number };
    mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
  }) => {
    const qs = new URLSearchParams({
      origin: `${opts.origin.lat},${opts.origin.lng}`,
      destination: `${opts.destination.lat},${opts.destination.lng}`,
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    return request<DirectionsResponse>(`/directions?${qs}`);
  },
};
```

with:

```typescript
export const api = {
  signup: (email: string, password: string) =>
    request<AuthResponse>('/auth/signup', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  logout: (refreshToken: string) =>
    request<{ ok: true }>('/auth/logout', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      auth: false,
    }),
  baysNear: (opts: {
    lat: number;
    lng: number;
    radius_m: number;
    available_only: boolean;
  }) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      radius_m: String(opts.radius_m),
      available_only: String(opts.available_only),
    });
    return request<NearResponse>(`/bays/near?${qs.toString()}`);
  },
  createSession: (body: {
    bay_id?: string | null;
    lat: number;
    lng: number;
    note?: string | null;
  }) => request<SessionDto>('/sessions', { method: 'POST', body }),
  currentSession: () => request<SessionDto | null>('/sessions/current'),
  returnSession: (id: string) =>
    request<SessionDto>(`/sessions/${id}/return`, { method: 'POST' }),

  createLock: (bay_id: string) =>
    request<LockDto>('/locks', { method: 'POST', body: { bay_id } }),
  currentLock: () => request<LockDto | null>('/locks/current'),
  releaseLock: (id: string) =>
    request<LockDto>(`/locks/${id}`, { method: 'DELETE' }),
  extendLock: (id: string, lat: number, lng: number) =>
    request<LockDto>(`/locks/${id}/extend`, {
      method: 'POST',
      body: { lat, lng },
    }),

  listDestinations: () => request<Destination[]>('/destinations'),
  saveDestination: (body: {
    name: string;
    lat: number;
    lng: number;
    walk_radius_m?: number;
    available_only?: boolean;
  }) => request<Destination>('/destinations', { method: 'POST', body }),
  deleteDestination: (id: string) =>
    request<{ ok: true }>(`/destinations/${id}`, { method: 'DELETE' }),

  lotsNear: (opts: { lat: number; lng: number; radius_m?: number }) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      ...(opts.radius_m ? { radius_m: String(opts.radius_m) } : {}),
    });
    return request<Lot[]>(`/lots/near?${qs.toString()}`);
  },

  setPushToken: (expoToken: string | null) =>
    request<{ ok: true }>('/users/push-token', {
      method: 'POST',
      body: { token: expoToken },
    }),

  getDirections: (opts: {
    origin: { lat: number; lng: number };
    destination: { lat: number; lng: number };
    mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
  }) => {
    const qs = new URLSearchParams({
      origin: `${opts.origin.lat},${opts.origin.lng}`,
      destination: `${opts.destination.lat},${opts.destination.lng}`,
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    return request<DirectionsResponse>(`/directions?${qs}`);
  },
};
```

- [ ] **Step 3: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: remaining errors are only in `App.tsx`, `LoginScreen.tsx`, `MapScreen.tsx`, `NavigationScreen.tsx`, `WalkBackScreen.tsx` (call sites still passing the now-removed `token` argument — fixed in Task 7). No errors in `api.ts` itself.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/api.ts
git commit -m "Move token handling into api.ts request layer with silent refresh"
```

---

### Task 7: Mobile — wire screens to the tokenless API

**Files:**
- Modify: `mobile/src/screens/LoginScreen.tsx`
- Modify: `mobile/src/push.ts`
- Modify: `mobile/App.tsx`
- Modify: `mobile/src/screens/MapScreen.tsx`
- Modify: `mobile/src/screens/NavigationScreen.tsx`
- Modify: `mobile/src/screens/WalkBackScreen.tsx`

**Interfaces:**
- Consumes: `api.*` (Task 6, no `token` params), `storage.*` (Task 5).

- [ ] **Step 1: `LoginScreen.tsx` — drop the token from `onSignedIn`**

Replace line 18:
```typescript
type Props = { onSignedIn: (token: string) => void };
```
with:
```typescript
type Props = { onSignedIn: () => void };
```

Replace lines 28-40 (the `submit` function):
```typescript
  const submit = async () => {
    setBusy(true);
    try {
      const resp =
        mode === 'login' ? await api.login(email, password) : await api.signup(email, password);
      await storage.setToken(resp.token, resp.user_id);
      onSignedIn(resp.token);
    } catch (e: any) {
      Alert.alert('Sign-in failed', e?.message ?? 'unknown error');
    } finally {
      setBusy(false);
    }
  };
```
with:
```typescript
  const submit = async () => {
    setBusy(true);
    try {
      const resp =
        mode === 'login' ? await api.login(email, password) : await api.signup(email, password);
      await storage.setTokens(resp.access_token, resp.refresh_token, resp.user_id);
      onSignedIn();
    } catch (e: any) {
      Alert.alert('Sign-in failed', e?.message ?? 'unknown error');
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 2: `WalkBackScreen.tsx` — drop `token` prop**

Replace lines 8-14:
```typescript
type Props = {
  token: string;
  session: SessionDto;
  onReturned: () => void;
};

export function WalkBackScreen({ token, session, onReturned }: Props) {
```
with:
```typescript
type Props = {
  session: SessionDto;
  onReturned: () => void;
};

export function WalkBackScreen({ session, onReturned }: Props) {
```

Replace line 44:
```typescript
      await api.returnSession(token, session.id);
```
with:
```typescript
      await api.returnSession(session.id);
```

- [ ] **Step 3: `push.ts` — drop the `authToken` parameter**

`registerForPush` currently takes an `authToken: string` purely to forward into `api.setPushToken`, which Task 6 made tokenless.

Replace lines 18-49:
```typescript
export async function registerForPush(authToken: string): Promise<void> {
  if (!Constants.isDevice) return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }

  const perm = await Notifications.getPermissionsAsync();
  let status = perm.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return;

  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ??
    (Constants.easConfig as any)?.projectId;
  const push = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  try {
    await api.setPushToken(authToken, push.data);
  } catch (e) {
    // Non-fatal — user can still use the app.
    console.warn('push token upload failed', e);
  }
}
```
with:
```typescript
export async function registerForPush(): Promise<void> {
  if (!Constants.isDevice) return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }

  const perm = await Notifications.getPermissionsAsync();
  let status = perm.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return;

  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ??
    (Constants.easConfig as any)?.projectId;
  const push = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  try {
    await api.setPushToken(push.data);
  } catch (e) {
    // Non-fatal — user can still use the app.
    console.warn('push token upload failed', e);
  }
}
```

- [ ] **Step 4: `NavigationScreen.tsx` — drop unused `token` prop**

Replace lines 32-41:
```typescript
type Props = {
  token: string;
  target: {
    bay: Bay;
  };
  onCancel: () => void;
  onArrived: () => void;
};

export function NavigationScreen({ token, target, onCancel, onArrived }: Props) {
```
with:
```typescript
type Props = {
  target: {
    bay: Bay;
  };
  onCancel: () => void;
  onArrived: () => void;
};

export function NavigationScreen({ target, onCancel, onArrived }: Props) {
```

(`token` was already unused inside this component's body — it never called an authenticated `api.*` method — so no other lines in this file change.)

- [ ] **Step 5: `MapScreen.tsx` — drop `token` prop and all its call-site usages**

Replace lines 56-61 (`Props` type):
```typescript
type Props = {
  token: string;
  onSignedOut: () => void;
  onSessionSaved: () => void;
  onStartNav: (bay: Bay) => void;
};
```
with:
```typescript
type Props = {
  onSignedOut: () => void;
  onSessionSaved: () => void;
  onStartNav: (bay: Bay) => void;
};
```

Replace lines 69-74 (component signature):
```typescript
export function MapScreen({
  token,
  onSignedOut,
  onSessionSaved,
  onStartNav,
}: Props) {
```
with:
```typescript
export function MapScreen({
  onSignedOut,
  onSessionSaved,
  onStartNav,
}: Props) {
```

Replace lines 112-135 (`fetchBays` — drop `token` from the call and the dep array):
```typescript
  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear(
        {
          lat: searchCentre.lat,
          lng: searchCentre.lng,
          radius_m: Math.max(filters.maxWalkM, 150),
          available_only: filters.availableOnly,
        },
        token,
      );
      // Apply the client-side "hide no-sensor bays" filter — the backend already
      // enforces available_only and radius.
      const filtered = filters.includeNoSensor
        ? resp.bays
        : resp.bays.filter((b) => b.sensor != null);
      setBays(filtered);
    } catch (e: any) {
      console.warn('bays fetch failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, [searchCentre.lat, searchCentre.lng, filters, token]);
```
with:
```typescript
  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear({
        lat: searchCentre.lat,
        lng: searchCentre.lng,
        radius_m: Math.max(filters.maxWalkM, 150),
        available_only: filters.availableOnly,
      });
      // Apply the client-side "hide no-sensor bays" filter — the backend already
      // enforces available_only and radius.
      const filtered = filters.includeNoSensor
        ? resp.bays
        : resp.bays.filter((b) => b.sensor != null);
      setBays(filtered);
    } catch (e: any) {
      console.warn('bays fetch failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, [searchCentre.lat, searchCentre.lng, filters]);
```

Replace lines 154-160 (`refreshDestinations`):
```typescript
  const refreshDestinations = useCallback(async () => {
    try {
      setDestinations(await api.listDestinations(token));
    } catch {
      // silent
    }
  }, [token]);
```
with:
```typescript
  const refreshDestinations = useCallback(async () => {
    try {
      setDestinations(await api.listDestinations());
    } catch {
      // silent
    }
  }, []);
```

Line 228, replace:
```typescript
                        await api.createLock(token, nextBay.id);
```
with:
```typescript
                        await api.createLock(nextBay.id);
```

Line 244, replace the WS effect's dep array:
```typescript
  }, [activeLockBayId, bays, token, fetchBays, filters]);
```
with:
```typescript
  }, [activeLockBayId, bays, fetchBays, filters]);
```

Lines 288-302 (`parkHere`), replace:
```typescript
  const parkHere = async (bay: Bay) => {
    try {
      const loc = await Location.getCurrentPositionAsync({});
      await api.createSession(token, {
        bay_id: bay.id,
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        note: bay.street ?? undefined,
      });
      setSelected(null);
      onSessionSaved();
    } catch (e: any) {
      Alert.alert('Could not save session', e?.message ?? 'unknown');
    }
  };
```
with:
```typescript
  const parkHere = async (bay: Bay) => {
    try {
      const loc = await Location.getCurrentPositionAsync({});
      await api.createSession({
        bay_id: bay.id,
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        note: bay.street ?? undefined,
      });
      setSelected(null);
      onSessionSaved();
    } catch (e: any) {
      Alert.alert('Could not save session', e?.message ?? 'unknown');
    }
  };
```

Lines 304-312 (`lockBay`), replace:
```typescript
  const lockBay = async (bay: Bay) => {
    try {
      await api.createLock(token, bay.id);
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not lock', e?.message ?? 'unknown');
    }
  };
```
with:
```typescript
  const lockBay = async (bay: Bay) => {
    try {
      await api.createLock(bay.id);
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not lock', e?.message ?? 'unknown');
    }
  };
```

Lines 314-325 (`releaseLock`), replace:
```typescript
  const releaseLock = async (bay: Bay) => {
    try {
      const cur = await api.currentLock(token);
      if (cur && cur.bay_id === bay.id) {
        await api.releaseLock(token, cur.id);
      }
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not release', e?.message ?? 'unknown');
    }
  };
```
with:
```typescript
  const releaseLock = async (bay: Bay) => {
    try {
      const cur = await api.currentLock();
      if (cur && cur.bay_id === bay.id) {
        await api.releaseLock(cur.id);
      }
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not release', e?.message ?? 'unknown');
    }
  };
```

Lines 345-362 (`saveCurrentAsDestination`), replace:
```typescript
  const saveCurrentAsDestination = async () => {
    if (!newDestName.trim()) {
      Alert.alert('Name required', 'Give this location a name.');
      return;
    }
    const centre = target ?? { lat: region.latitude, lng: region.longitude };
    try {
      await api.saveDestination(token, {
        name: newDestName.trim(),
        lat: centre.lat,
        lng: centre.lng,
      });
      setNewDestName('');
      refreshDestinations();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'unknown');
    }
  };
```
with:
```typescript
  const saveCurrentAsDestination = async () => {
    if (!newDestName.trim()) {
      Alert.alert('Name required', 'Give this location a name.');
      return;
    }
    const centre = target ?? { lat: region.latitude, lng: region.longitude };
    try {
      await api.saveDestination({
        name: newDestName.trim(),
        lat: centre.lat,
        lng: centre.lng,
      });
      setNewDestName('');
      refreshDestinations();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'unknown');
    }
  };
```

Line 737, replace:
```typescript
                        await api.deleteDestination(token, item.id);
```
with:
```typescript
                        await api.deleteDestination(item.id);
```

- [ ] **Step 6: `App.tsx` — replace the `token` string with a `signedIn` boolean, wire `logout`**

Replace the full file:

```typescript
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { LoginScreen } from './src/screens/LoginScreen';
import { MapScreen } from './src/screens/MapScreen';
import { NavigationScreen } from './src/screens/NavigationScreen';
import { WalkBackScreen } from './src/screens/WalkBackScreen';
import { Bay, SessionDto, api } from './src/api';
import { registerForPush } from './src/push';
import { storage } from './src/storage';
import { loadVoicePrefs } from './src/voice';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function AppInner() {
  const { colors, scheme } = useTheme();
  const [signedIn, setSignedIn] = useState(false);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [navTarget, setNavTarget] = useState<{ bay: Bay } | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const refreshSession = useCallback(async () => {
    try {
      const s = await api.currentSession();
      setSession(s ?? null);
    } catch (e) {
      await storage.clear();
      setSignedIn(false);
      setSession(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadVoicePrefs();
      const stored = await storage.getAccessToken();
      if (stored) {
        setSignedIn(true);
        await refreshSession();
        registerForPush().catch(() => {});
      }
      setBootstrapped(true);
    })();
  }, [refreshSession]);

  const signOut = async () => {
    const refreshToken = await storage.getRefreshToken();
    if (refreshToken) {
      await api.logout(refreshToken).catch(() => {});
    }
    await storage.clear();
    setSignedIn(false);
    setSession(null);
    setNavTarget(null);
  };

  if (!bootstrapped) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.surface.background }]}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface.background }} edges={['top']}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {!signedIn ? (
          <LoginScreen
            onSignedIn={async () => {
              setSignedIn(true);
              await refreshSession();
              registerForPush().catch(() => {});
            }}
          />
        ) : session ? (
          <WalkBackScreen
            session={session}
            onReturned={() => setSession(null)}
          />
        ) : navTarget ? (
          <NavigationScreen
            target={navTarget}
            onCancel={() => setNavTarget(null)}
            onArrived={async () => {
              // Auto-open the "I parked here" flow: create a session at the
              // bay's coordinates, then close the nav screen. WalkBackScreen
              // takes over via the session state.
              try {
                await api.createSession({
                  bay_id: navTarget.bay.id,
                  lat: navTarget.bay.lat,
                  lng: navTarget.bay.lng,
                  note: navTarget.bay.street ?? undefined,
                });
                await refreshSession();
              } finally {
                setNavTarget(null);
              }
            }}
          />
        ) : (
          <MapScreen
            onSignedOut={signOut}
            onSessionSaved={() => refreshSession()}
            onStartNav={(bay) => setNavTarget({ bay })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
```

Note: `signOut` moved from an inline `MapScreen` prop closure into `App.tsx` itself (it now needs `await storage.getRefreshToken()` before clearing, and `MapScreen`'s `onSignedOut` prop type is already a plain `() => void`, unchanged). `registerForPush()` is called with no arguments, matching the signature `push.ts` was given in Step 3 above.

- [ ] **Step 7: Type-check**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Bundle export sanity check**

Run: `cd mobile && npx expo export`
Expected: exports cleanly (matches the verification approach used for the T17 dark mode change in commit `bb5e5db`).

- [ ] **Step 9: Manual on-device smoke test**

Ship via EAS Update (`npx eas-cli update --branch preview ...`, per the project's existing beta workflow) and manually verify on a real device:
1. Fresh install (or clear app data) → sign up → lands on map.
2. Force-quit and reopen → still signed in (access token from storage still valid or silently refreshed).
3. Lock a bay, wait >15 minutes (or temporarily lower `DEFAULT_ACCESS_TOKEN_TTL_SECS` for this one manual test), perform an action → confirm it silently refreshes rather than bouncing to the login screen.
4. Sign out → sign back in → confirm no errors.

- [ ] **Step 10: Commit**

```bash
git add mobile/App.tsx mobile/src/push.ts mobile/src/screens/LoginScreen.tsx mobile/src/screens/MapScreen.tsx mobile/src/screens/NavigationScreen.tsx mobile/src/screens/WalkBackScreen.tsx
git commit -m "Wire mobile screens to tokenless api.ts, drop token prop threading"
```

---

## Deployment order

Tasks 1-4 change `kerby-api`'s `/auth/signup` and `/auth/login` response shape
(`token` → `access_token`/`refresh_token`). Testers on an old mobile build
read `resp.token`, which will be `undefined` against the new backend —
login/signup would silently fail for anyone who hasn't picked up the mobile
update yet. Deploy backend (`fly deploy`, `deploy/fly.api.toml`) and ship the
mobile update (`eas update --branch preview`, per
`mobile_eas_update_workflow` memory) in the same sitting, mobile first or
immediately after — don't let the backend deploy sit alone for testers to
hit in the gap. This is a small closed beta, so this is a timing note, not a
reason to build response-shape backward compatibility.

## Post-plan: bullseye

Once all 7 tasks are committed and Task 7 Step 8's on-device smoke test passes, retire T6.4:

```
bullseye_retire(id: "T6.4")
```
