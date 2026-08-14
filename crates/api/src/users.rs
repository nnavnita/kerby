use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::{verify_password, AuthUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Unrated endpoints — no password re-check, no brute-force surface.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/push-token", post(set_push_token))
        .route("/users/me", get(me))
}

/// Endpoints that re-verify a password and therefore belong on the same
/// tight rate-limit tier as `auth::routes()` — mounted separately in
/// `lib.rs` alongside `auth_gated`, not merged into the unrated tier above.
pub fn rate_limited_routes() -> Router<AppState> {
    Router::new().route("/users/delete-account", post(delete_account))
}

#[derive(Deserialize)]
pub struct PushTokenRequest {
    pub token: Option<String>,
}

async fn set_push_token(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<PushTokenRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    sqlx::query("UPDATE users SET push_token = $1, updated_at = now() WHERE id = $2")
        .bind(&req.token)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn me(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    let row: Option<(Option<chrono::DateTime<chrono::Utc>>,)> =
        sqlx::query_as("SELECT email_verified_at FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let email_verified = row.map(|(v,)| v.is_some()).unwrap_or(false);
    Ok(Json(
        serde_json::json!({ "email_verified": email_verified }),
    ))
}

#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    pub password: String,
}

async fn delete_account(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<DeleteAccountRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((hash,)) = row else {
        return Err(ApiError::Unauthorized);
    };
    if !verify_password(&hash, &req.password) {
        return Err(ApiError::Unauthorized);
    }
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
