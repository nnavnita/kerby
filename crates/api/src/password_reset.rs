use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::{hash_password, validate_password};
use crate::email;
use crate::email_tokens;
use crate::error::ApiResult;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/forgot-password", post(forgot_password))
        .route("/auth/reset-password", post(reset_password))
}

#[derive(Deserialize)]
struct ForgotPasswordRequest {
    email: String,
}

#[derive(Deserialize)]
struct ResetPasswordRequest {
    token: String,
    new_password: String,
}

async fn forgot_password(
    State(state): State<AppState>,
    Json(req): Json<ForgotPasswordRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let email_addr = req.email.trim().to_lowercase();
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
        .bind(&email_addr)
        .fetch_optional(&state.db)
        .await?;

    // Same response whether or not the account exists — no account
    // enumeration via this endpoint. To also avoid a *timing* side channel
    // (issuing a token + calling out to Resend takes measurably longer than
    // doing nothing), the known-account work is spawned as a detached
    // background task rather than awaited inline, so the handler returns
    // just as fast in both branches.
    if let Some((user_id,)) = row {
        let state = state.clone();
        tokio::spawn(async move {
            let raw_token = match email_tokens::issue_reset(&state, user_id).await {
                Ok(token) => token,
                Err(e) => {
                    tracing::error!(error = ?e, "failed to issue reset token");
                    return;
                }
            };
            let link = format!("kerby://reset-password?token={raw_token}");
            email::send(
                &state,
                &email_addr,
                "Reset your Kerby password",
                &format!(
                    "<p>Tap the link below to reset your password. This link expires in 30 minutes.</p><p><a href=\"{link}\">Reset password</a></p>"
                ),
            )
            .await;
        });
    }

    Ok(Json(json!({ "ok": true })))
}

async fn reset_password(
    State(state): State<AppState>,
    Json(req): Json<ResetPasswordRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    validate_password(&req.new_password)?;
    let user_id = email_tokens::consume_reset(&state, &req.token).await?;
    let hash = hash_password(&req.new_password)?;

    // Password update and session revocation must commit-or-fail together —
    // otherwise a crash or error between the two queries could leave the
    // password changed but old sessions still valid.
    let mut tx = state.db.begin().await?;

    sqlx::query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2")
        .bind(&hash)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    // Password reset kills every existing session — standard practice.
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({ "ok": true })))
}
