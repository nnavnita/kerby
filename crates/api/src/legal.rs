use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/legal/terms", get(terms))
        .route("/legal/privacy", get(privacy))
}

const CONTACT_EMAIL: &str = "hello@kerby.app";
const JURISDICTION: &str = "Victoria, Australia";
const ENTITY: &str = "Kerby (Melbourne, Australia)";

fn html(title: &str, body: &str) -> Response {
    let full = format!(
        r#"<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Kerby</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; line-height: 1.6; color: #222; }}
  h1 {{ font-size: 28px; }}
  h2 {{ font-size: 20px; margin-top: 32px; }}
  a {{ color: #1E88E5; }}
  code {{ background: #f0f0f0; padding: 2px 6px; border-radius: 4px; }}
</style>
</head><body>
<a href="/">← Kerby</a>
<h1>{title}</h1>
{body}
<hr>
<p><small>Last updated 2026-07-02. Contact: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></small></p>
</body></html>"#
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], full).into_response()
}

async fn terms() -> Response {
    let body = format!(
        r#"
<p>These Terms govern your use of the Kerby mobile app and API operated by {ENTITY}.</p>

<h2>1. Service description</h2>
<p>Kerby helps drivers find on-street parking bays in Melbourne CBD using City of Melbourne open data. Bay availability data is provided as-is and is subject to sensor freshness and coverage.</p>

<h2>2. No parking guarantee</h2>
<p>Sensor data may be stale, missing, or wrong. A bay marked as available may already be occupied by the time you arrive. Kerby is a navigation aid, not a parking reservation. Always obey signage on the street.</p>

<h2>3. Bay locks</h2>
<p>The "lock" feature holds a bay in our system for other Kerby users. It does not reserve the bay with the City of Melbourne. Anyone driving past can still take the spot. Locks expire after 15 minutes.</p>

<h2>4. Your account</h2>
<p>You are responsible for keeping your credentials safe. Notify us at <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> of unauthorised use.</p>

<h2>5. Acceptable use</h2>
<p>Do not scrape the API, share bay locks abusively, or use Kerby in a way that endangers other road users. We may rate-limit or ban accounts that misuse the service.</p>

<h2>6. Liability</h2>
<p>To the extent permitted by law, {ENTITY} is not liable for parking infringements, towing, delays, missed appointments, or any other loss arising from your use of Kerby. Use it at your own risk.</p>

<h2>7. Governing law</h2>
<p>These Terms are governed by the laws of {JURISDICTION}.</p>
"#
    );
    html("Terms of Service", &body)
}

async fn privacy() -> Response {
    let body = format!(
        r#"
<p>This Privacy Policy explains what information Kerby collects and how we use it.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account</strong>: email address + salted password hash.</li>
  <li><strong>Location</strong>: your current GPS while the app is in the foreground, so we can show nearby bays and guide you back to your car. We do not track location in the background.</li>
  <li><strong>Parked sessions</strong>: when you tap "I parked here", we save the timestamp, GPS point, optional note, and optional photo URL.</li>
  <li><strong>Bay locks</strong>: which bay you locked and when.</li>
  <li><strong>Push token</strong>: your Expo push token, only if you allow notifications.</li>
</ul>

<h2>What we do NOT collect</h2>
<ul>
  <li>Real name, phone number, or payment info.</li>
  <li>Contacts, photos, calendar, or other device data.</li>
  <li>Background location or continuous GPS trace.</li>
  <li>Advertising or analytics identifiers.</li>
</ul>

<h2>Third parties</h2>
<ul>
  <li><strong>Expo push relay</strong>: your push token is sent to Expo Application Services when we send a notification. See <a href="https://docs.expo.dev/versions/latest/sdk/notifications/">Expo Notifications</a>.</li>
  <li><strong>City of Melbourne open data</strong>: we consume public bay + sensor data from data.melbourne.vic.gov.au. We do not send them anything about you.</li>
</ul>

<h2>Retention</h2>
<p>Account data is retained until you delete your account. Bay locks are retained for 30 days after they expire. Parked-session history is retained for 90 days.</p>

<h2>Deleting your account</h2>
<p>Email <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> with "Delete my account" and the email address you registered with. We erase your data within 7 days.</p>

<h2>Contact</h2>
<p>Questions? <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>
"#
    );
    html("Privacy Policy", &body)
}
