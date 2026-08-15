use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::{hash_password, validate_password};
use crate::email;
use crate::email_tokens;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::WEB_BASE;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/forgot-password", post(forgot_password))
        .route("/auth/reset-password", post(reset_password))
        .route("/reset-password", get(reset_password_page))
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
        tracing::debug!(%user_id, "spawning password reset email task");
        let state = state.clone();
        tokio::spawn(async move {
            let raw_token = match email_tokens::issue_reset(&state, user_id).await {
                Ok(token) => token,
                Err(e) => {
                    tracing::error!(error = ?e, "failed to issue reset token");
                    return;
                }
            };
            let link = format!("{WEB_BASE}/reset-password?token={raw_token}");
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

/// Server-rendered fallback for the emailed reset link. Reads `token` from
/// the query string client-side (never interpolated into the HTML, so
/// there's nothing here for the token to inject into) and POSTs to the
/// existing `/auth/reset-password` JSON endpoint — same validation, same
/// rate limiting, same everything, just reached from a browser instead of
/// the app. See `WEB_BASE`'s doc comment for why this exists instead of a
/// `kerby://` link.
async fn reset_password_page() -> Response {
    let html = r#"<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kerby · Reset password</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px; text-align: center; background: #f7f7f8; }
  .card { max-width: 400px; margin: 40px auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  h1 { margin-top: 0; font-size: 22px; }
  input { width: 100%; box-sizing: border-box; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
  button { width: 100%; padding: 12px; background: #1E88E5; color: #fff; border: none; border-radius: 8px; font-weight: 600; font-size: 16px; cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .msg { margin-top: 16px; font-size: 14px; }
  .error { color: #d32f2f; }
  .success { color: #2e7d32; }
</style>
</head><body>
<div class="card">
  <h1>Reset your password</h1>
  <form id="f">
    <input type="password" id="pw" placeholder="New password" minlength="8" required>
    <button type="submit" id="btn">Update password</button>
  </form>
  <p class="msg" id="msg"></p>
</div>
<script>
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const form = document.getElementById('f');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    msg.textContent = '';
    msg.className = 'msg';
    try {
      const resp = await fetch('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: document.getElementById('pw').value }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || 'Something went wrong');
      }
      form.style.display = 'none';
      msg.textContent = 'Password updated. Open Kerby and sign in with your new password.';
      msg.className = 'msg success';
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg error';
      btn.disabled = false;
    }
  });
</script>
</body></html>
"#;
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}
