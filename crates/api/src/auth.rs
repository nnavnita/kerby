use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
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

    Ok(Json(
        issue_tokens_in_family(&state, user_id, family_id).await?,
    ))
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
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user_id =
            decode_bearer(&parts.headers, &state.jwt_secret).ok_or(ApiError::Unauthorized)?;
        tracing::Span::current().record("user_id", tracing::field::display(user_id));
        Ok(AuthUser(user_id))
    }
}

/// Marker used to opt into optional auth. Endpoints that want the caller
/// identity when available (but tolerate anonymous requests) use `Option<AuthUser>`.
pub fn optional_auth_user() {}
