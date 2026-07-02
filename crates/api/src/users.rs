use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::error::ApiResult;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/push-token", post(set_push_token))
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
