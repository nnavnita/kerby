use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/push-token", post(set_push_token))
        .route("/users/me", get(me))
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
    Ok(Json(serde_json::json!({ "email_verified": email_verified })))
}
