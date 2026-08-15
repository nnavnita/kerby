use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::email;
use crate::email_tokens;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::WEB_BASE;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/verify-email", post(verify_email))
        .route("/auth/resend-verification", post(resend_verification))
        .route("/verify-email", get(verify_email_page))
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
    let link = format!("{WEB_BASE}/verify-email?token={raw_token}");
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

/// Server-rendered fallback for the emailed verify link — auto-fires the
/// POST on page load, no user interaction needed beyond opening the link.
/// Same rationale as `password_reset::reset_password_page`: `kerby://`
/// links don't work under the current Expo Go beta distribution, a real
/// web page does, regardless of what's installed on the device.
async fn verify_email_page() -> Response {
    let html = r#"<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kerby · Verify email</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px; text-align: center; background: #f7f7f8; }
  .card { max-width: 400px; margin: 40px auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
  h1 { margin-top: 0; font-size: 22px; }
  .msg { margin-top: 8px; font-size: 14px; }
  .error { color: #d32f2f; }
  .success { color: #2e7d32; }
</style>
</head><body>
<div class="card">
  <h1 id="title">Verifying your email…</h1>
  <p class="msg" id="msg"></p>
</div>
<script>
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const title = document.getElementById('title');
  const msg = document.getElementById('msg');
  (async () => {
    try {
      const resp = await fetch('/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || 'Something went wrong');
      }
      title.textContent = 'Email verified';
      msg.textContent = 'You can close this page and return to Kerby.';
      msg.className = 'msg success';
    } catch (err) {
      title.textContent = 'Verification failed';
      msg.textContent = err.message;
      msg.className = 'msg error';
    }
  })();
</script>
</body></html>
"#;
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}
