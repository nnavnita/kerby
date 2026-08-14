//! Transactional email via Resend's HTTP API.

use crate::state::AppState;

const RESEND_URL: &str = "https://api.resend.com/emails";

/// Fire-and-log: callers never see a send failure. This matches how
/// `directions.rs`/`com.rs` already treat external-call failures, and here
/// it also avoids leaking account-existence/timing information through
/// error responses on the calling endpoints (`forgot-password` especially).
pub async fn send(state: &AppState, to: &str, subject: &str, html_body: &str) {
    let Some(api_key) = state.resend_api_key.as_ref() else {
        tracing::warn!("RESEND_API_KEY not set; skipping email send");
        return;
    };
    if let Err(e) = try_send(state, api_key, to, subject, html_body).await {
        tracing::error!(error = ?e, to, "email send failed");
    }
}

async fn try_send(
    state: &AppState,
    api_key: &str,
    to: &str,
    subject: &str,
    html_body: &str,
) -> Result<(), reqwest::Error> {
    state
        .http
        .post(RESEND_URL)
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "from": state.email_from.as_str(),
            "to": to,
            "subject": subject,
            "html": html_body,
        }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
