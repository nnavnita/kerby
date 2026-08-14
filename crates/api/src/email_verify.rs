use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::email;
use crate::email_tokens;
use crate::error::ApiResult;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/verify-email", post(verify_email))
        .route("/auth/resend-verification", post(resend_verification))
}

#[derive(Deserialize)]
struct VerifyEmailRequest {
    token: String,
}

/// Issue+send a verification email. Called from `auth::signup` right after
/// the user row is inserted, and from `resend_verification`. Never fails
/// its caller — a send failure here must not fail signup; see `email::send`.
pub(crate) async fn send_verification_email(state: &AppState, user_id: Uuid, to: &str) {
    let raw_token = match email_tokens::issue_verify(state, user_id).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = ?e, "failed to issue verification token");
            return;
        }
    };
    let link = format!("kerby://verify-email?token={raw_token}");
    email::send(
        state,
        to,
        "Verify your Kerby email",
        &format!(
            "<p>Tap the link below to verify your email address.</p><p><a href=\"{link}\">Verify email</a></p>"
        ),
    )
    .await;
}

async fn verify_email(
    State(state): State<AppState>,
    Json(req): Json<VerifyEmailRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let user_id = email_tokens::consume_verify(&state, &req.token).await?;
    sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn resend_verification(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    let row: Option<(String, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as("SELECT email, email_verified_at FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    if let Some((email_addr, None)) = row {
        send_verification_email(&state, user_id, &email_addr).await;
    }
    // Already verified, or (shouldn't happen) user vanished mid-request:
    // still a no-op success from the caller's point of view.
    Ok(Json(json!({ "ok": true })))
}
