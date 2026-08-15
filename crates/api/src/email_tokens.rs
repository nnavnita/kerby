//! One-shot, hashed, purpose-scoped tokens for password reset and email
//! verification. Same storage principle as `refresh_tokens` (opaque,
//! hashed) minus rotation-family tracking — these are single-use.

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::tokens::{generate_opaque_token, hash_token};

const RESET_TTL_SECS: i64 = 30 * 60;
const VERIFY_TTL_SECS: i64 = 24 * 60 * 60;

async fn issue_token(
    state: &AppState,
    purpose: &'static str,
    ttl_secs: i64,
    user_id: Uuid,
) -> ApiResult<String> {
    // Invalidate any previously-issued, still-live token of this purpose —
    // only the most recently issued one should be usable.
    sqlx::query(
        "UPDATE email_tokens SET consumed_at = now() \
         WHERE user_id = $1 AND purpose = $2::email_token_purpose AND consumed_at IS NULL",
    )
    .bind(user_id)
    .bind(purpose)
    .execute(&state.db)
    .await?;

    let raw = generate_opaque_token();
    let hash = hash_token(&raw);
    let expires_at = Utc::now() + Duration::seconds(ttl_secs);
    sqlx::query(
        "INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) \
         VALUES ($1, $2, $3::email_token_purpose, $4)",
    )
    .bind(user_id)
    .bind(&hash)
    .bind(purpose)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    Ok(raw)
}

async fn consume_token(
    state: &AppState,
    purpose: &'static str,
    raw_token: &str,
) -> ApiResult<Uuid> {
    let hash = hash_token(raw_token);
    let row: Option<(Uuid, Uuid, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, user_id, expires_at, consumed_at FROM email_tokens \
         WHERE token_hash = $1 AND purpose = $2::email_token_purpose",
    )
    .bind(&hash)
    .bind(purpose)
    .fetch_optional(&state.db)
    .await?;

    let (id, user_id, expires_at, consumed_at) =
        row.ok_or_else(|| ApiError::BadRequest("invalid or expired token".into()))?;

    if consumed_at.is_some() || expires_at < Utc::now() {
        return Err(ApiError::BadRequest("invalid or expired token".into()));
    }

    sqlx::query("UPDATE email_tokens SET consumed_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    Ok(user_id)
}

pub async fn issue_reset(state: &AppState, user_id: Uuid) -> ApiResult<String> {
    issue_token(state, "reset", RESET_TTL_SECS, user_id).await
}

pub async fn consume_reset(state: &AppState, raw_token: &str) -> ApiResult<Uuid> {
    consume_token(state, "reset", raw_token).await
}

pub async fn issue_verify(state: &AppState, user_id: Uuid) -> ApiResult<String> {
    issue_token(state, "verify", VERIFY_TTL_SECS, user_id).await
}

pub async fn consume_verify(state: &AppState, raw_token: &str) -> ApiResult<Uuid> {
    consume_token(state, "verify", raw_token).await
}
