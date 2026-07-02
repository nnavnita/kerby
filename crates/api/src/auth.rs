use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/signup", post(signup))
        .route("/auth/login", post(login))
}

#[derive(Deserialize)]
pub struct AuthRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    token: String,
    user_id: Uuid,
    expires_at: chrono::DateTime<Utc>,
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

fn make_token(state: &AppState, user_id: Uuid) -> ApiResult<AuthResponse> {
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
    Ok(AuthResponse {
        token,
        user_id,
        expires_at: exp,
    })
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
    Ok(Json(make_token(&state, user_id)?))
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
    Ok(Json(make_token(&state, id)?))
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
        decode_bearer(&parts.headers, &state.jwt_secret)
            .map(AuthUser)
            .ok_or((StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

/// Marker used to opt into optional auth. Endpoints that want the caller
/// identity when available (but tolerate anonymous requests) use `Option<AuthUser>`.
pub fn optional_auth_user() {}
