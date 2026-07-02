use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/share/bay/:id", get(bay_landing))
        .route("/.well-known/apple-app-site-association", get(apple_aasa))
        .route("/.well-known/assetlinks.json", get(android_assetlinks))
}

/// Landing page for shared bay links. If opened on a phone with the app
/// installed, universal-link config routes it into the app (kerby://bay/:id).
/// Otherwise we return a simple HTML page pointing to the store.
async fn bay_landing(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    let bay: Option<(String, f64, f64, Option<String>)> = sqlx::query_as(
        r#"
        SELECT id,
               ST_X(centroid::geometry) AS lng,
               ST_Y(centroid::geometry) AS lat,
               street_name
        FROM bays
        WHERE id = $1
        "#,
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;

    let (id, lng, lat, street) = bay.ok_or(ApiError::NotFound)?;
    let street_line = street.as_deref().unwrap_or("Melbourne CBD");

    let html = format!(
        r#"<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kerby · Bay {id}</title>
<meta property="og:title" content="Bay {id} · {street_line}">
<meta property="og:description" content="Open in Kerby to reserve or navigate.">
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px; text-align: center; background: #f7f7f8; }}
  .card {{ max-width: 400px; margin: 40px auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }}
  h1 {{ margin-top: 0; }}
  .btn {{ display: inline-block; margin: 8px 4px; padding: 12px 20px; background: #1E88E5; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }}
  .muted {{ color: #666; font-size: 14px; }}
</style>
</head><body>
<div class="card">
  <h1>Bay {id}</h1>
  <p>{street_line}</p>
  <p class="muted">{lat:.5}, {lng:.5}</p>
  <a class="btn" href="kerby://bay/{id}">Open in Kerby</a>
  <div style="margin-top: 16px">
    <a href="https://apps.apple.com/app/kerby">App Store</a> ·
    <a href="https://play.google.com/store/apps/details?id=app.kerby.mobile">Play Store</a>
  </div>
</div>
</body></html>
"#
    );

    Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
}

async fn apple_aasa() -> Json<serde_json::Value> {
    // Replace TEAMID.app.kerby.mobile with your real Apple Developer team id
    // + bundle id before deploying.
    Json(serde_json::json!({
        "applinks": {
            "apps": [],
            "details": [{
                "appIDs": ["TEAMID.app.kerby.mobile"],
                "paths": ["/share/bay/*", "/bay/*"]
            }]
        }
    }))
}

async fn android_assetlinks() -> Json<serde_json::Value> {
    // Replace <SHA256_FINGERPRINT> with the release-signing cert fingerprint.
    Json(serde_json::json!([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": "app.kerby.mobile",
            "sha256_cert_fingerprints": ["<SHA256_FINGERPRINT>"]
        }
    }]))
}
